import { classifyToolName, classifyToolRisk, tokenizeToolName, getToolBaseName } from './risk';
import { workModeSchema, toolApprovalPolicySchema } from './config';

describe('tool risk', () => {
  test('splits MCP keys and tokenizes snake, kebab and camel case', () => {
    expect(getToolBaseName('search_records_mcp_odoo-admin')).toBe('search_records');
    expect(tokenizeToolName('deleteRecord_mcp_crm')).toEqual(['delete', 'record']);
    expect(tokenizeToolName('list-models')).toEqual(['list', 'models']);
  });

  test('classifies the Odoo bridge tools by name', () => {
    const suffix = '_mcp_odoo-admin';
    expect(classifyToolName(`search_records${suffix}`)).toBe('read');
    expect(classifyToolName(`get_record${suffix}`)).toBe('read');
    expect(classifyToolName(`list_models${suffix}`)).toBe('read');
    expect(classifyToolName(`list_resource_templates${suffix}`)).toBe('read');
    expect(classifyToolName(`create_record${suffix}`)).toBe('write');
    expect(classifyToolName(`update_record${suffix}`)).toBe('write');
    expect(classifyToolName(`delete_record${suffix}`)).toBe('critical');
    expect(classifyToolName(`execute_method${suffix}`)).toBe('critical');
  });

  test('critical verbs win over write and read verbs', () => {
    expect(classifyToolName('send_mail')).toBe('critical');
    expect(classifyToolName('get_and_delete')).toBe('critical');
    expect(classifyToolName('post_invoice')).toBe('critical');
    expect(classifyToolName('move_file')).toBe('write');
    expect(classifyToolName('search_and_update')).toBe('write');
  });

  test('dry runs stay read only in their narrow shapes', () => {
    expect(classifyToolName('validate_write')).toBe('read');
    expect(classifyToolName('preview_write')).toBe('read');
    expect(classifyToolName('preview_invoice')).toBe('read');
    expect(classifyToolName('dry_run_delete_partner')).toBe('read');
    expect(classifyToolName('preview_and_send')).toBe('critical');
  });

  test('side effects are never read, wherever the verb stands', () => {
    expect(classifyToolName('validate_invoice')).toBe('critical');
    expect(classifyToolName('check_and_delete_x')).toBe('critical');
    expect(classifyToolName('format_drive')).toBe('critical');
    expect(classifyToolName('check_out_file')).toBe('write');
    expect(classifyToolName('scan_device')).toBe('write');
    expect(classifyToolName('report_incident')).toBe('write');
    expect(classifyToolName('crm_create_lead')).toBe('write');
  });

  test('read tools of the internal Odoo bridge stay read', () => {
    const reads = [
      'search_records',
      'read_record',
      'get_model_fields',
      'list_models',
      'schema_catalog',
      'fit_gap_report',
      'upgrade_risk_report',
      'business_pack_report',
      'diagnose_access',
      'diagnose_odoo_call',
      'preview_write',
      'validate_write',
      'generate_json2_payload',
      'build_domain',
      'health_check',
      'get_email',
    ];
    for (const name of reads) {
      expect([name, classifyToolName(`${name}_mcp_odoo-twojo`)]).toEqual([name, 'read']);
    }
    expect(classifyToolName('execute_approved_write_mcp_odoo-twojo')).toBe('critical');
    expect(classifyToolName('execute_method_mcp_odoo-twojo')).toBe('critical');
  });

  test('batch bridges are critical', () => {
    expect(classifyToolName('run_tools_with_code')).toBe('critical');
    expect(classifyToolName('run_tools_with_bash')).toBe('critical');
  });

  test('unknown names are treated as writes', () => {
    expect(classifyToolName('weather_mcp_tools')).toBe('write');
  });

  test('native tools use their fixed class', () => {
    expect(classifyToolName('web_search')).toBe('read');
    expect(classifyToolName('ask_user_question')).toBe('read');
    expect(classifyToolName('plan_aktualisieren')).toBe('read');
    expect(classifyToolName('brain_forget')).toBe('read');
    expect(classifyToolName('execute_code')).toBe('write');
    expect(classifyToolName('create_file')).toBe('write');
  });

  test('MCP annotations only raise the class or rescue an unmatched name', () => {
    expect(classifyToolRisk('delete_cache_mcp_x', { readOnlyHint: true })).toBe('critical');
    expect(classifyToolRisk('sync_partners_mcp_x', { readOnlyHint: true })).toBe('write');
    expect(classifyToolRisk('partner_feed_mcp_x', { readOnlyHint: true })).toBe('read');
    expect(classifyToolRisk('search_records_mcp_x', { readOnlyHint: false })).toBe('write');
    expect(classifyToolRisk('get_token_mcp_x', { destructiveHint: true })).toBe('critical');
    expect(classifyToolRisk('weather_mcp_x', { readOnlyHint: false, destructiveHint: false })).toBe(
      'write',
    );
    expect(
      classifyToolRisk('send_note_mcp_x', { readOnlyHint: false, destructiveHint: false }),
    ).toBe('critical');
    expect(classifyToolRisk('execute_code', { readOnlyHint: true })).toBe('write');
  });

  test('work mode config parses', () => {
    expect(workModeSchema.safeParse('plan').success).toBe(true);
    expect(workModeSchema.safeParse('yolo').success).toBe(false);
    const parsed = toolApprovalPolicySchema.parse({
      enabled: true,
      mode: 'bypass',
      workModes: { enabled: true, default: 'auto' },
    });
    expect(parsed?.workModes).toEqual({ enabled: true, default: 'auto' });
  });
});
