import type { FollowupIdentity } from './followupMcp';
import type { MailFetch } from './types';
import { createFollowupMcp } from './followupMcp';

function fixture() {
  const state = {
    identity: {
      id: 'owner',
      role: 'USER',
      email: 'person@example.test',
      profiles: ['odoo-technik'],
    } as FollowupIdentity,
    allowed: true,
    yolo: false,
    tools: [
      'search_records',
      'get_record',
      'list_models',
      'create_record',
      'post_message',
      'eucowork_mail_followup_capabilities',
      'eucowork_mail_followup_create',
      'eucowork_mail_followup_append',
    ],
    safe: true,
  };
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const headers: Headers[] = [];
  const request = jest.fn(async (input, init) => {
    const url = input.toString();
    headers.push(new Headers(init?.headers));
    expect(init?.redirect).toBe('error');
    if (url.endsWith('/_eucowork/access')) return Response.json({ allowed: state.allowed });
    expect(url).toBe('http://mcp-gateway:3020/odoo-technik');
    if (init?.method === 'GET' || init?.method === 'DELETE')
      return new Response(null, { status: 405 });
    const rpc = JSON.parse(String(init?.body));
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      };
    else if (rpc.method === 'tools/list')
      result = { tools: state.tools.map((name) => ({ name, inputSchema: { type: 'object' } })) };
    else {
      calls.push(rpc.params);
      const name = rpc.params.name;
      let payload: unknown;
      if (name === 'list_models')
        payload = {
          yolo_mode: state.yolo,
          models: ['project.task', 'res.users', 'res.partner', 'project.project'].map((model) => ({
            model,
            operations: { read: true, write: true, create: true },
          })),
        };
      else if (name === 'eucowork_mail_followup_capabilities')
        payload = {
          protocol: 'cw01-mail-followup/v1',
          externalMailBlocked: state.safe,
          automationGuard: true,
          profileAclPreserved: true,
          atomicIdempotency: true,
        };
      else if (name === 'eucowork_mail_followup_append') payload = { success: true, message_id: 7 };
      else if (name === 'eucowork_mail_followup_create')
        payload = { success: true, record: { id: 8 } };
      else if (name === 'get_record') payload = { record: { id: rpc.params.arguments.record_id } };
      else payload = { records: [] };
      result = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  }) as jest.MockedFunction<MailFetch>;
  const refresh = jest.fn(async () => state.identity);
  const mcp = createFollowupMcp(request, refresh);
  return { state, calls, headers, request, refresh, mcp };
}

describe('fixed Odoo profile transport', () => {
  it('lists only effective configured profiles with explicit gateway access', async () => {
    const f = fixture();
    expect(await f.mcp.profiles(f.state.identity)).toEqual([
      { id: 'odoo-technik', label: 'odoo-technik' },
    ]);
    expect(f.request).toHaveBeenCalledTimes(1);
    f.state.allowed = false;
    expect(await f.mcp.profiles(f.state.identity)).toEqual([]);
  });
  it('rejects arbitrary profiles and profiles absent from effective user config before connecting', async () => {
    const f = fixture();
    await expect(f.mcp.open(f.state.identity, 'https://attacker.test')).rejects.toThrow();
    await expect(f.mcp.open(f.state.identity, 'odoo-administrator')).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('uses only typed safe tools with immutable operation keys and no arbitrary recipients or models', async () => {
    const f = fixture();
    const connection = await f.mcp.open(f.state.identity, 'odoo-technik');
    await connection.note(7, '<img src=x>', 'operation:1');
    await connection.create({
      name: 'Aufgabe',
      body: 'Text',
      assigneeId: 7,
      operationKey: 'operation:2',
    });
    expect(
      f.calls.find((call) => call.name === 'eucowork_mail_followup_append')?.arguments,
    ).toEqual({ task_id: 7, body_text: '<img src=x>', operation_key: 'operation:1' });
    expect(
      f.calls.find((call) => call.name === 'eucowork_mail_followup_create')?.arguments,
    ).toEqual({
      name: 'Aufgabe',
      body_text: 'Text',
      project_id: false,
      assignee_user_id: 7,
      customer_id: false,
      operation_key: 'operation:2',
    });
    expect(
      f.calls.some((call) =>
        ['call_model_method', 'create_record', 'post_message'].includes(call.name),
      ),
    ).toBe(false);
    await connection.close();
  });
  it('keeps metadata reads available but refuses generic write fallbacks for existing bridges', async () => {
    const f = fixture();
    f.state.tools = f.state.tools.filter((name) => !name.startsWith('eucowork_'));
    const connection = await f.mcp.open(f.state.identity, 'odoo-technik');
    await connection.search('project.task', [], ['id'], 1);
    expect(await connection.writeCapability()).toMatchObject({ available: false });
    await expect(connection.note(7, 'Notiz', 'operation:1')).rejects.toThrow('Kundenmails');
    await expect(
      connection.create({ name: 'Task', body: 'Text', assigneeId: 7, operationKey: 'operation:1' }),
    ).rejects.toThrow('Kundenmails');
    expect(f.calls.some((call) => ['create_record', 'post_message'].includes(call.name))).toBe(
      false,
    );
    await connection.close();
  });
  it('requires every no-send guarantee even if the future tool names exist', async () => {
    const f = fixture();
    f.state.safe = false;
    const connection = await f.mcp.open(f.state.identity, 'odoo-technik');
    expect(await connection.writeCapability()).toMatchObject({ available: false });
    await expect(connection.note(7, 'Notiz', 'operation:1')).rejects.toThrow('Kundenmails');
    expect(f.calls.some((call) => call.name === 'eucowork_mail_followup_append')).toBe(false);
    await connection.close();
  });
  it('refreshes user identity and denies a revoked profile before a tool call', async () => {
    const f = fixture();
    const initial = f.state.identity;
    const connection = await f.mcp.open(initial, 'odoo-technik');
    f.state.identity = { ...initial, role: 'NEW_ROLE' };
    await connection.search('project.task', [], ['id'], 1);
    expect(f.headers[f.headers.length - 1]?.get('X-EUCowork-User-Role')).toBe('NEW_ROLE');
    const count = f.calls.length;
    f.state.identity = { ...initial, profiles: [] };
    await expect(connection.note(7, 'Notiz', 'operation:1')).rejects.toThrow();
    expect(f.calls).toHaveLength(count);
    await connection.close();
  });
  it('refuses unrestricted YOLO capabilities and missing required typed tools', async () => {
    const f = fixture();
    f.state.yolo = true;
    await expect(f.mcp.open(f.state.identity, 'odoo-technik')).rejects.toThrow();
    f.state.yolo = false;
    f.state.tools = f.state.tools.filter((name) => name !== 'search_records');
    await expect(f.mcp.open(f.state.identity, 'odoo-technik')).rejects.toThrow();
    expect(f.calls.some((call) => call.name === 'post_message')).toBe(false);
  });
});
