import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Connect from './Connect';
import Settings from './Settings';
import { useOpsPersonal } from '~/data-provider/OpsPersonal';
import mockTranslations from '~/locales/en/translation.json';

jest.mock('~/routes/useAuthRedirect', () => ({
  __esModule: true,
  default: () => ({ isAuthenticated: true }),
}));
jest.mock('~/data-provider/OpsPersonal', () => ({ useOpsPersonal: jest.fn() }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: keyof typeof mockTranslations) => mockTranslations[key],
}));
const info = {
  response_type: 'code',
  scope: 'mail:compose skills:use brain:read mail:background',
  client_id: 'ops',
  redirect_uri: 'https://ops.rzcloud.ch/functions/v1/kisuno-personal/callback',
  state: 's'.repeat(43),
  code_challenge: 'c'.repeat(43),
  code_challenge_method: 'S256',
  ops_user_id: 'a8d2034d-75e6-48b3-9746-07474975e229',
};
const approve = jest.fn();
const revoke = jest.fn();
function setup(consent = true, redirect = info.redirect_uri) {
  jest.mocked(useOpsPersonal).mockReturnValue({
    consent: {
      data: consent
        ? {
            account: 'Synthetic Owner',
            authorization: info,
            optional_scopes: ['brain:read', 'mail:background'],
          }
        : undefined,
    },
    grants: {
      data: {
        grants: [
          {
            id: 'synthetic-grant',
            expires_at: '2030-01-01',
            scopes: ['mail:compose', 'skills:use'],
          },
        ],
      },
    },
    approve: { mutateAsync: approve },
    revoke: { mutate: revoke },
  } as ReturnType<typeof useOpsPersonal>);
  return render(
    <MemoryRouter
      initialEntries={[
        consent
          ? `/ops-connect?${new URLSearchParams({ ...info, redirect_uri: redirect })}`
          : '/ops-connect',
      ]}
    >
      <Connect />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  approve.mockReset().mockResolvedValue({ redirect_uri: 'https://ops.rzcloud.ch/?code=blocked' });
  revoke.mockReset();
});
it('requires explicit optional consent and preserves the fixed redirect', async () => {
  setup();
  expect(useOpsPersonal).toHaveBeenLastCalledWith(info);
  const checkboxes = screen.getAllByRole('checkbox');
  expect(checkboxes.every((box) => !(box as HTMLInputElement).checked)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: mockTranslations.com_ui_ops_personal_allow }));
  await waitFor(() => expect(approve).toHaveBeenCalledWith(['mail:compose', 'skills:use']));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    mockTranslations.com_ui_ops_personal_error,
  );
  fireEvent.click(checkboxes[0]);
  fireEvent.click(checkboxes[1]);
  fireEvent.click(screen.getByRole('button', { name: mockTranslations.com_ui_ops_personal_allow }));
  await waitFor(() =>
    expect(approve).toHaveBeenLastCalledWith([
      'mail:compose',
      'skills:use',
      'brain:read',
      'mail:background',
    ]),
  );
});
it('rejects the former root callback before requesting consent', () => {
  setup(true, 'https://ops.rzcloud.ch/');
  expect(useOpsPersonal).toHaveBeenLastCalledWith(null);
  expect(screen.getByRole('alert')).toHaveTextContent(mockTranslations.com_ui_ops_personal_error);
});
it('allows revocation without starting a new connection', () => {
  setup(false);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: mockTranslations.com_ui_ops_personal_revoke }),
  );
  expect(revoke).toHaveBeenCalledWith('synthetic-grant');
});
it('offers a settings entry to manage the personal connection', () => {
  render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link')).toHaveAttribute('href', '/ops-connect');
});
