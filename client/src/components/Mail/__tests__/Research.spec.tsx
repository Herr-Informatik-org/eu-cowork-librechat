import { fireEvent, render, screen, within } from '@testing-library/react';
import type {
  MailResearchJob,
  MailResearchSettings,
  MailWorkspaceResult,
} from 'librechat-data-provider';
import mockTranslations from '~/locales/en/translation.json';
import { MailResearch, MailResearchProgress } from '../Research';

const mockRun = jest.fn();
const mockSave = jest.fn();
const mockCancel = jest.fn();
let mockSettings: MailResearchSettings;
let mockJobs: MailResearchJob[];
let mockLoading = false;
const mockCustomers = jest.fn();
jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: keyof typeof mockTranslations, options: Record<string, string | number> = {}) =>
      Object.entries(options).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        mockTranslations[key] || key,
      ),
}));
jest.mock('../Followup', () => ({
  mailActionError: (_error: unknown, fallback: string) => fallback,
}));
jest.mock('~/data-provider/Mail/research', () => ({
  useMailResearchSettings: () => ({ data: mockSettings }),
  useMailResearchJobs: () => ({ data: mockJobs }),
  useMailResearchCustomers: (...args: unknown[]) => mockCustomers(...args),
  useMailResearchActions: () => ({
    save: { mutate: mockSave },
    run: { mutate: mockRun, isLoading: mockLoading },
    cancel: { mutate: mockCancel },
  }),
}));
const result = {
  id: 'original',
  revision: 'revision-one',
  draftStatus: 'none',
} as MailWorkspaceResult;
const skill = {
  id: 'licenses',
  revision: 'skill-one',
  name: 'Lizenzen prüfen',
  instructions: 'Vergleiche Vertrag und Rechnungen.',
  topic: 'Veeam',
  lookbackMonths: 12,
  sources: ['odoo', 'ops'] as ('odoo' | 'ops')[],
};
const job: MailResearchJob = {
  id: 'job-one',
  resultId: result.id,
  revision: result.revision,
  status: 'completed',
  createdAt: '2026-10-29T08:00:00Z',
  completedAt: '2026-10-29T08:01:00Z',
  skill: { id: skill.id, revision: skill.revision, name: skill.name },
  sources: [
    {
      profileId: 'granted-odoo',
      kind: 'odoo',
      status: 'complete',
      customer: { id: 'odoo-customer', name: 'Customer' },
    },
  ],
  evidence: [
    {
      id: 'evidence',
      source: 'odoo',
      profileId: 'granted-odoo',
      customerId: 'odoo-customer',
      kind: 'invoice',
      title: 'Invoice <script>',
      fields: [{ label: 'Product', value: 'Veeam' }],
      url: 'javascript:alert(1)',
    },
  ],
  answer: '<img src=x onerror=alert(1)> Missing Microsoft 365 evidence',
  warnings: ['ERP evidence incomplete'],
};
beforeEach(() => {
  jest.clearAllMocks();
  mockLoading = false;
  mockJobs = [];
  mockSettings = {
    available: true,
    consentVersion: '2026-10-29',
    modelLabel: 'Configured Model',
    profiles: [
      { id: 'granted-odoo', label: 'Odoo Team', kind: 'odoo' },
      { id: 'granted-ops', label: 'OPS Team', kind: 'ops' },
    ],
    skills: [skill],
  };
  mockCustomers.mockImplementation((profile: string, search: string) => ({
    data: search ? [{ id: `${profile}-customer`, name: `Customer ${profile}` }] : undefined,
  }));
  Object.defineProperty(global.crypto, 'randomUUID', {
    value: () => '00000000-0000-4000-8000-000000000001',
    configurable: true,
  });
});
function mount() {
  const onUse = jest.fn();
  const view = render(
    <MailResearch result={result} disabled={false} onUse={onUse} openRequest={1} />,
  );
  return { ...view, onUse };
}
function selectCustomers() {
  fireEvent.change(screen.getByRole('combobox', { name: 'Persönlicher Skill' }), {
    target: { value: skill.id },
  });
  for (const [index, profile] of ['granted-odoo', 'granted-ops'].entries()) {
    fireEvent.change(screen.getAllByRole('combobox', { name: 'Freigegebenes Profil' })[index], {
      target: { value: profile },
    });
    const fieldset = screen
      .getAllByRole('textbox', { name: 'Kunden suchen' })
      [index].closest('fieldset')!;
    fireEvent.change(within(fieldset).getByRole('textbox', { name: 'Kunden suchen' }), {
      target: { value: 'Customer' },
    });
    fireEvent.click(within(fieldset).getByRole('button', { name: mockTranslations.com_ui_search }));
    fireEvent.click(
      within(fieldset).getByRole('button', { name: new RegExp(`Customer ${profile}`) }),
    );
  }
}

test('requires explicit customer selections and cross-source confirmation before CtrlEnter starts one job', () => {
  mount();
  expect(mockRun).not.toHaveBeenCalled();
  selectCustomers();
  expect(screen.getByRole('button', { name: 'Recherche starten' })).toBeDisabled();
  const reference = screen.getByRole('textbox', { name: /Referenz/ });
  fireEvent.keyDown(reference, { key: 'Enter', ctrlKey: true });
  expect(mockRun).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: /gleichen Kunden/ }));
  fireEvent.change(reference, { target: { value: 'S01230' } });
  fireEvent.keyDown(reference, { key: 'Enter', ctrlKey: true });
  fireEvent.keyDown(reference, { key: 'Enter', ctrlKey: true });
  expect(mockRun).toHaveBeenCalledTimes(1);
  expect(mockRun.mock.calls[0][0]).toEqual({
    id: result.id,
    input: {
      requestId: expect.any(String),
      revision: result.revision,
      skillId: skill.id,
      skillRevision: skill.revision,
      selections: [
        { profileId: 'granted-odoo', customerId: 'granted-odoo-customer' },
        { profileId: 'granted-ops', customerId: 'granted-ops-customer' },
      ],
      customersConfirmed: true,
      reference: 'S01230',
    },
  });
  expect(mockSave).not.toHaveBeenCalled();
});

test.each([
  { key: 'Enter' },
  { key: 'Enter', ctrlKey: true, isComposing: true },
  { key: 'Enter', ctrlKey: true, repeat: true },
])('ignores non-submit or composing/repeated keys %j', (event) => {
  mount();
  selectCustomers();
  fireEvent.click(screen.getByRole('checkbox', { name: /gleichen Kunden/ }));
  fireEvent.keyDown(screen.getByRole('textbox', { name: /Referenz/ }), event);
  expect(mockRun).not.toHaveBeenCalled();
});

test('new skills require explicit save and ERP consent, and never start research during editing', () => {
  mockSettings = { ...mockSettings, skills: [], consentVersion: undefined };
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Neuen Skill anlegen' }));
  expect(mockSave).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Name des persönlichen Skills' }), {
    target: { value: 'Kunden prüfen' },
  });
  const instructions = screen.getByRole('textbox', { name: 'Deine Prüfanleitung' });
  fireEvent.change(instructions, { target: { value: 'Vergleiche nur Quellen.' } });
  fireEvent.change(screen.getByRole('textbox', { name: /Thema oder Produkt/ }), {
    target: { value: 'Veeam' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Odoo' }));
  fireEvent.keyDown(instructions, { key: 'Enter', ctrlKey: true });
  expect(mockSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: /Ich erlaube/ }));
  fireEvent.keyDown(instructions, { key: 'Enter', ctrlKey: true });
  expect(mockSave).toHaveBeenCalledTimes(1);
  expect(mockSave.mock.calls[0][0]).toMatchObject({
    input: { expectedRevision: '', consentVersion: '2026-10-29', sources: ['odoo'] },
  });
  expect(mockRun).not.toHaveBeenCalled();
});

test('foreign/stale jobs never render or enter draft instructions, matching reports stay plaintext', () => {
  mockJobs = [
    { ...job, id: 'foreign', resultId: 'other', answer: 'Foreign private answer' },
    { ...job, id: 'old', revision: 'old', answer: 'Old private answer' },
    job,
  ];
  const { onUse, container } = mount();
  expect(screen.queryByText(/Foreign private answer|Old private answer/)).not.toBeInTheDocument();
  expect(screen.getByText(job.answer!)).toBeInTheDocument();
  expect(container.querySelector('img,script,a')).toBeNull();
  expect(onUse).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Als Hinweise ins Antwortformular übernehmen' }),
  );
  expect(onUse).toHaveBeenCalledWith(expect.stringContaining(job.answer!));
  expect(mockRun).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
});

test('disabled instance and unavailable skills cannot execute research even by shortcut', () => {
  mockSettings = { ...mockSettings, available: false, reason: 'Not enabled' };
  const { container } = mount();
  expect(screen.getByText('Not enabled')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Recherche starten' })).not.toBeInTheDocument();
  fireEvent.keyDown(container.querySelector('.mail-card')!, { key: 'Enter', ctrlKey: true });
  expect(mockRun).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
});

test('changing profiles clears customer confirmation and Escape returns focus without starting a job', () => {
  mount();
  selectCustomers();
  fireEvent.click(screen.getByRole('checkbox', { name: /gleichen Kunden/ }));
  fireEvent.change(screen.getAllByRole('combobox', { name: 'Freigegebenes Profil' })[0], {
    target: { value: '' },
  });
  expect(screen.getByRole('checkbox', { name: /gleichen Kunden/ })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Recherche starten' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('textbox', { name: /Referenz/ }), { key: 'Escape' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Kundendaten prüfen' }));
  expect(mockRun).not.toHaveBeenCalled();
});

test('background progress offers explicit cancellation without blocking other controls', () => {
  mockJobs = [{ ...job, status: 'running' }, job];
  render(
    <>
      <button>{mockTranslations.com_ui_mail_mark_done}</button>
      <MailResearchProgress />
    </>,
  );
  expect(
    screen.getByRole('button', { name: mockTranslations.com_ui_mail_mark_done }),
  ).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Recherche abbrechen' }));
  expect(mockCancel).toHaveBeenCalledWith(job.id);
});

test('the editable example changes only the unsaved form and still requires personal consent', () => {
  mockSettings = { ...mockSettings, skills: [], consentVersion: undefined };
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Neuen Skill anlegen' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Beispiel für Offerten und Lizenzen einfügen' }),
  );
  expect(screen.getByRole('textbox', { name: 'Name des persönlichen Skills' })).toHaveValue(
    'Offerten und Lizenzen prüfen',
  );
  expect(
    (screen.getByRole('textbox', { name: 'Deine Prüfanleitung' }) as HTMLTextAreaElement).value,
  ).toContain('Microsoft-365');
  expect(screen.getByRole('button', { name: 'Skill und Zustimmung speichern' })).toBeDisabled();
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockRun).not.toHaveBeenCalled();
});

test('customer lookup is unavailable until current personal consent has been saved', () => {
  mockSettings = { ...mockSettings, consentVersion: undefined };
  mount();
  fireEvent.change(screen.getByRole('combobox', { name: 'Persönlicher Skill' }), {
    target: { value: skill.id },
  });
  expect(screen.queryByRole('textbox', { name: 'Kunden suchen' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Recherche starten' })).not.toBeInTheDocument();
  expect(mockRun).not.toHaveBeenCalled();
});
