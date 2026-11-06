import { MCPConnection } from '~/mcp/connection';
import { getToolHints, clearToolHints } from './hints';
import { createToolRiskClassifier } from './policy';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('~/auth', () => ({
  createSSRFSafeUndiciConnect: jest.fn(() => undefined),
  isOAuthUrlAllowed: jest.fn(() => false),
  isSSRFTarget: jest.fn(() => false),
  resolveHostnameSSRF: jest.fn(async () => false),
}));

function connectionWith(listTools: jest.Mock, userId?: string): MCPConnection {
  const connection = new MCPConnection({
    serverName: 'odoo-admin',
    serverConfig: { type: 'streamable-http', url: 'http://localhost/mcp' },
    useSSRFProtection: false,
    ...(userId != null && { userId }),
  });
  connection.client = { listTools } as unknown as MCPConnection['client'];
  return connection;
}

afterEach(() => clearToolHints());

describe('MCP annotations reach the work-mode classifier', () => {
  test('tools/list annotations are recorded per server and used for risk', async () => {
    const listTools = jest.fn().mockResolvedValue({
      tools: [
        {
          name: 'partner_feed',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'archive_lead',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      ],
    });
    await connectionWith(listTools).fetchTools();

    expect(getToolHints('partner_feed_mcp_odoo-admin')).toEqual({ readOnlyHint: true });
    const classify = createToolRiskClassifier();
    expect(classify('partner_feed_mcp_odoo-admin')).toBe('read');
    expect(classify('archive_lead_mcp_odoo-admin')).toBe('critical');
  });

  test('a failed listing records nothing and does not throw', async () => {
    const listTools = jest.fn().mockRejectedValue(new Error('down'));
    const connection = connectionWith(listTools, 'u1');
    connection.on('error', () => undefined);
    await expect(connection.fetchTools()).resolves.toEqual([]);
    expect(getToolHints('partner_feed_mcp_odoo-admin', 'u1')).toBeUndefined();
  });
});
