import { recordToolHints, getToolHints, clearToolHints } from './hints';

afterEach(() => clearToolHints());

describe('MCP tool hints', () => {
  test('records annotations under the model-facing name with the normalized server', () => {
    recordToolHints('Odoo Admin', [
      { name: 'search_records', annotations: { readOnlyHint: true, destructiveHint: false } },
      { name: 'update_record', annotations: { readOnlyHint: false } },
      { name: 'plain' },
    ]);
    expect(getToolHints('search_records_mcp_Odoo_Admin')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(getToolHints('update_record_mcp_Odoo_Admin')).toEqual({ readOnlyHint: false });
    expect(getToolHints('plain_mcp_Odoo_Admin')).toBeUndefined();
  });

  test('user connections shadow the app connection for that user only', () => {
    recordToolHints('crm', [{ name: 'wipe', annotations: { destructiveHint: true } }]);
    recordToolHints('crm', [{ name: 'wipe', annotations: { readOnlyHint: true } }], 'u1');
    expect(getToolHints('wipe_mcp_crm', 'u1')).toEqual({ readOnlyHint: true });
    expect(getToolHints('wipe_mcp_crm', 'u2')).toEqual({ destructiveHint: true });
    expect(getToolHints('wipe_mcp_crm')).toEqual({ destructiveHint: true });
  });

  test('a later listing without annotations clears stale hints', () => {
    recordToolHints('crm', [{ name: 'sync', annotations: { readOnlyHint: true } }]);
    recordToolHints('crm', [{ name: 'sync' }]);
    expect(getToolHints('sync_mcp_crm')).toBeUndefined();
  });

  test('ignores malformed entries', () => {
    expect(() =>
      recordToolHints('crm', [{ name: '' }, null as unknown as { name: string }]),
    ).not.toThrow();
  });
});
