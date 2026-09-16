import type { ParsedServerConfig } from '~/mcp/types';
import { canAccessMCPServer, filterAccessibleMCPServers } from '../access';

const gateway: ParsedServerConfig = {
  type: 'streamable-http',
  url: 'http://mcp-gateway:3020/odoo-admin',
  source: 'yaml',
};
const direct: ParsedServerConfig = {
  type: 'streamable-http',
  url: 'https://sharepoint.example/mcp',
  requiresOAuth: true,
  source: 'yaml',
};

describe('MCP gateway visibility', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ allowed: true }));
  });

  it('retains direct OAuth, stdio and startup inspection without a gateway request', async () => {
    expect(await canAccessMCPServer(direct, 'user-a')).toBe(true);
    expect(await canAccessMCPServer({ type: 'stdio', command: 'node', args: [] }, 'user-a')).toBe(
      true,
    );
    expect(await canAccessMCPServer(gateway)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the gateway route rather than the display key and sends only trusted identity', async () => {
    const configs = {
      payroll: {
        ...gateway,
        url: 'http://mcp-gateway:3020/odoo-admin/mcp?private=value',
        headers: { Authorization: 'Bearer placeholder', 'X-EUCowork-User-Role': 'ADMIN' },
      },
      sharepoint: direct,
    };
    expect(await filterAccessibleMCPServers(configs, 'user-a')).toEqual(configs);
    expect(fetchSpy).toHaveBeenCalledWith(
      new URL('http://mcp-gateway:3020/odoo-admin/_eucowork/access'),
      expect.objectContaining({
        headers: { 'X-EUCowork-User-Id': 'user-a', Accept: 'application/json' },
        signal: expect.any(AbortSignal),
        redirect: 'error',
        cache: 'no-store',
      }),
    );
  });

  it('supports an admin-configured gateway hostname through its identity template', async () => {
    expect(
      await canAccessMCPServer(
        {
          ...gateway,
          url: 'https://gateway.example/odoo-admin',
          headers: { 'x-eucowork-user-id': '{{LIBRECHAT_USER_ID}}' },
        },
        'user-a',
      ),
    ).toBe(true);
    expect(fetchSpy.mock.calls[0][0].hostname).toBe('gateway.example');
  });

  it('does not let user-created header templates opt arbitrary hosts into identity requests', async () => {
    expect(
      await canAccessMCPServer(
        {
          ...direct,
          source: 'user',
          headers: { 'X-EUCowork-User-Id': '{{LIBRECHAT_USER_ID}}' },
        },
        'user-a',
      ),
    ).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([false, undefined, 'true', 1])('denies non-boolean grants: %s', async (allowed) => {
    fetchSpy.mockResolvedValue(Response.json({ allowed }));
    expect(
      await filterAccessibleMCPServers({ payroll: gateway, sharepoint: direct }, 'user-a'),
    ).toEqual({ sharepoint: direct });
  });

  it.each([401, 403, 404, 503])('fails closed for HTTP %i', async (status) => {
    fetchSpy.mockResolvedValue(Response.json({ allowed: true }, { status }));
    expect(await canAccessMCPServer(gateway, 'user-a')).toBe(false);
  });

  it('fails closed on timeout, invalid JSON and missing gateway route', async () => {
    fetchSpy.mockRejectedValueOnce(new DOMException('Timeout', 'TimeoutError'));
    expect(await canAccessMCPServer(gateway, 'user-a')).toBe(false);
    fetchSpy.mockResolvedValueOnce(new Response('not json'));
    expect(await canAccessMCPServer(gateway, 'user-a')).toBe(false);
    expect(await canAccessMCPServer({ ...gateway, url: 'http://mcp-gateway:3020' }, 'user-a')).toBe(
      false,
    );
  });

  it('evaluates each user independently and never caches a grant across revocation', async () => {
    fetchSpy.mockResolvedValueOnce(Response.json({ allowed: true }));
    fetchSpy.mockResolvedValueOnce(Response.json({ allowed: false }));
    fetchSpy.mockResolvedValueOnce(Response.json({ allowed: false }));
    const configs = { payroll: gateway };
    expect(await filterAccessibleMCPServers(configs, 'user-a')).toEqual(configs);
    expect(await filterAccessibleMCPServers(configs, 'user-b')).toEqual({});
    expect(await filterAccessibleMCPServers(configs, 'user-a')).toEqual({});
    expect(configs.payroll).toBe(gateway);
  });
});
