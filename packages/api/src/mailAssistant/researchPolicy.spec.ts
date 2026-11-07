import { researchPolicyAllows, researchProfileCandidate } from './researchPolicy';
describe('fresh research profile policy', () => {
  test('missing policies and missing defaults deny', () => {
    expect(researchPolicyAllows(null, 'u', 'USER', [])).toBe(false);
    expect(researchPolicyAllows({ _id: 'p' }, 'u', 'USER', [])).toBe(false);
  });
  test('user > role > conflicting groups > explicit default, tool denial cannot widen server denial', () => {
    const p = {
      _id: 'p',
      defaultAllow: false,
      groups: { a: true, b: false },
      roles: { USER: true },
      users: { u: false },
      tools: { search_records: { allow: true } },
    };
    expect(researchPolicyAllows(p, 'u', 'USER', ['a'], 'search_records')).toBe(false);
    expect(researchPolicyAllows(p, 'other', 'USER', ['a', 'b'])).toBe(true);
    expect(researchPolicyAllows(p, 'other', 'OTHER', ['a', 'b'])).toBe(false);
    expect(researchPolicyAllows(p, 'other', 'OTHER', ['a'])).toBe(true);
    expect(
      researchPolicyAllows(
        {
          _id: 'p',
          defaultAllow: true,
          tools: { search_records: { allow: false, users: { u: true } } },
        },
        'u',
        'USER',
        [],
        'search_records',
      ),
    ).toBe(true);
    expect(
      researchPolicyAllows(
        { _id: 'p', defaultAllow: true, tools: { search_records: { allow: false } } },
        'u',
        'USER',
        [],
        'search_records',
      ),
    ).toBe(false);
  });
  test.each([
    'https://mcp-gateway:3020/odoo-user',
    'http://external:3020/odoo-user',
    'http://mcp-gateway:3020/odoo-admin',
    'http://mcp-gateway:3020/odoo-user?other=true',
    'http://mcp-gateway:3020/odoo-user/',
  ])('rejects widened gateway config %s', (url) => {
    expect(researchProfileCandidate('odoo-user', { type: 'streamable-http', url })).toBeUndefined();
  });
  test('candidate names discover kinds without authorizing them', () => {
    expect(
      researchProfileCandidate('ops-manager', {
        type: 'streamable-http',
        url: 'http://mcp-gateway:3020/ops-manager',
      }),
    ).toEqual({ id: 'ops-manager', label: 'ops-manager', kind: 'ops' });
    expect(
      researchProfileCandidate('ordinary', {
        type: 'streamable-http',
        url: 'http://mcp-gateway:3020/ordinary',
      }),
    ).toBeUndefined();
  });
});
