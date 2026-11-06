import { buildProposalView, humanizeKey, MAX_FIELDS, MAX_VALUE_CHARS } from '../values';
import {
  resolveOutcome,
  rememberDecision,
  outcomeFromOutput,
  resetDecisionCache,
} from '../decisions';

describe('buildProposalView', () => {
  test('reads target and flattens the Odoo values wrapper', () => {
    const view = buildProposalView({
      intent: 'Ändert die Adresse',
      model: 'res.partner',
      record_id: 42,
      values: { street: 'Bahnhofstrasse 1', partner_id: 9, active: true, note: null },
    });
    expect(view.intent).toBe('Ändert die Adresse');
    expect(view.target).toEqual({ model: 'res.partner', ids: '42' });
    expect(view.fields.map((field) => [field.label, field.value, field.kind])).toEqual([
      ['Street', 'Bahnhofstrasse 1', 'text'],
      ['Partner', '9', 'text'],
      ['Active', '', 'yes'],
      ['Note', '', 'empty'],
    ]);
  });

  test('parses string args, shortens long values and caps the list', () => {
    const long = 'x'.repeat(MAX_VALUE_CHARS + 40);
    const many = Object.fromEntries(Array.from({ length: MAX_FIELDS + 3 }, (_, i) => [`f${i}`, i]));
    const view = buildProposalView(JSON.stringify({ to: ['a@b.ch'], body: long, ...many }));
    expect(view.target.recipient).toBe('a@b.ch');
    expect(view.fields[0].value.endsWith('…')).toBe(true);
    expect(view.fields[0].full).toBe(long);
    expect(view.fields).toHaveLength(MAX_FIELDS);
    expect(view.moreCount).toBe(4);
  });

  test('keeps nested non-wrapper objects readable and ids compact', () => {
    const view = buildProposalView({ ids: [1, 2, 3, 4, 5, 6, 7], address: { city: 'Bern' } });
    expect(view.target.ids).toBe('1, 2, 3, 4, 5 +2');
    expect(view.fields[0]).toMatchObject({ label: 'Address city', value: 'Bern' });
  });

  test('non-JSON input becomes one field', () => {
    const view = buildProposalView('rm -rf /tmp/x');
    expect(view.fields).toEqual([
      expect.objectContaining({ key: 'input', value: 'rm -rf /tmp/x' }),
    ]);
  });

  test('humanizes keys', () => {
    expect(humanizeKey('email_from')).toBe('Email from');
    expect(humanizeKey('partnerIds')).toBe('Partner');
  });
});

describe('proposal outcomes', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetDecisionCache();
  });

  test('recognizes plan-mode blocks and rejections from the tool output', () => {
    expect(outcomeFromOutput('Blocked: Arbeitsmodus Planen: Diese Änderung …')).toBe('planned');
    expect(outcomeFromOutput('Blocked: Die Person hat diesen Vorschlag verworfen.')).toBe(
      'rejected',
    );
    expect(outcomeFromOutput('Blocked: anything else')).toBeUndefined();
    expect(outcomeFromOutput('{"ok":true}')).toBeUndefined();
  });

  test('approvals are remembered in this browser across a reload', () => {
    expect(resolveOutcome('c1', '{"ok":true}')).toBeUndefined();
    rememberDecision('c1', 'approved');
    resetDecisionCache();
    expect(resolveOutcome('c1', '{"ok":true}')).toBe('approved');
  });
});
