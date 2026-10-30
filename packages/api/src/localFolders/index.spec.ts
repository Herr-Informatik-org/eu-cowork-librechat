import { HookRegistry, createToolPolicyHook, executeHooks } from '@librechat/agents';
import { AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import type { Agents, LocalFolderResult } from 'librechat-data-provider';
import type { LocalFolderHookOptions } from './index';
import {
  createLocalFolderHook,
  createLocalFolderTool,
  hasLocalFolderAccess,
  isLocalFoldersEnabled,
  parseLocalFolderGrants,
  parseLocalFolderInput,
  recordLocalFolderCalls,
  validateLocalFolderResolutions,
} from './index';

const folderId = '80445861-54cb-4d9b-9c0a-803d7f9b88ed';
const grants = [{ id: folderId, label: 'Projekt' }];
const args = { folderId, operation: 'read' as const, path: 'docs/report.txt' };
const result: LocalFolderResult = {
  status: 'ok',
  coverage: { complete: true, filesVisited: 1, filesRead: 1, bytesRead: 20, skipped: 0 },
  text: 'External file, not a user assertion.',
  source: { path: 'docs/report.txt', byteStart: 0, byteEnd: 20 },
};
const payload: Agents.ToolApprovalInterruptPayload = {
  type: 'tool_approval',
  action_requests: [
    { name: 'local_folder', tool_call_id: 'call-1', arguments: { ...args, maxChars: 3000 } },
  ],
  review_configs: [
    {
      action_name: 'local_folder',
      tool_call_id: 'call-1',
      allowed_decisions: ['respond', 'reject'],
    },
  ],
};
const decision = (responseText = JSON.stringify(result)): Agents.ToolApprovalResolution[] => [
  { tool_call_id: 'call-1', decision: 'respond', responseText },
];
const hookInput = {
  hook_event_name: 'PreToolUse' as const,
  runId: 'run',
  threadId: 'chat',
  toolName: 'local_folder',
  toolUseId: 'call-1',
  toolInput: args,
};
function options(extra: Partial<LocalFolderHookOptions> = {}): LocalFolderHookOptions {
  return {
    grants,
    userId: 'owner',
    conversationId: 'chat',
    hitlCapable: true,
    signal: new AbortController().signal,
    getMessages: () => [],
    getRemainingTokens: () => 64_000,
    ...extra,
  };
}
const priorCall = (id: string, callArgs = args) =>
  new AIMessage({ content: '', tool_calls: [{ id, name: 'local_folder', args: callArgs }] });

describe('browser-local folder capabilities', () => {
  const oldFlag = process.env.EUCOWORK_LOCAL_FOLDERS;
  beforeEach(() => {
    process.env.EUCOWORK_LOCAL_FOLDERS = 'true';
  });
  afterAll(() => {
    if (oldFlag === undefined) delete process.env.EUCOWORK_LOCAL_FOLDERS;
    else process.env.EUCOWORK_LOCAL_FOLDERS = oldFlag;
  });

  test('requires an explicit enabled server feature and valid bounded UUID grants', () => {
    delete process.env.EUCOWORK_LOCAL_FOLDERS;
    expect(isLocalFoldersEnabled()).toBe(false);
    expect(hasLocalFolderAccess(grants)).toBe(false);
    process.env.EUCOWORK_LOCAL_FOLDERS = 'TRUE';
    expect(hasLocalFolderAccess(grants)).toBe(false);
    expect(parseLocalFolderGrants([...grants, ...grants])).toEqual([]);
    expect(parseLocalFolderGrants([{ id: '/server/home', label: 'host' }])).toEqual([]);
    expect(parseLocalFolderGrants([{ ...grants[0], label: 'x'.repeat(121) }])).toEqual([]);
    expect(parseLocalFolderGrants(grants)).toEqual(grants);
  });

  test.each([
    '/etc/passwd',
    '../secret',
    'a/../secret',
    'C:/Windows',
    'a\\secret',
    'bad\u0000path',
  ])('rejects non-relative path %j', (path) =>
    expect(parseLocalFolderInput({ ...args, path })).toBeUndefined(),
  );

  test('accepts direct byte/page reads while rejecting invalid offsets and query overflows', () => {
    expect(parseLocalFolderInput({ ...args, startByte: 1_000_000_000, page: 1000 })).toEqual({
      ...args,
      startByte: 1_000_000_000,
      page: 1000,
    });
    for (const extra of [
      { startByte: -1 },
      { page: 0 },
      { page: 1.5 },
      { startByte: Number.MAX_SAFE_INTEGER + 1 },
      { query: 'x'.repeat(201) },
    ]) {
      expect(parseLocalFolderInput({ ...args, ...extra })).toBeUndefined();
    }
    expect(parseLocalFolderInput({ ...args, operation: 'list', startByte: 1 })).toBeUndefined();
  });

  test('persists only call identities and hashes in the existing private resume state', () => {
    const history = recordLocalFolderCalls(undefined, payload);
    expect(history).toEqual([
      { id: 'call-1', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    expect(JSON.stringify(history)).not.toContain(args.path);
    expect(recordLocalFolderCalls(history, payload)).toEqual(history);
  });

  test('forces respond/reject even if the administrator policy says bypass and allow all', async () => {
    const registry = new HookRegistry();
    registry.register('PreToolUse', {
      hooks: [createToolPolicyHook({ mode: 'bypass', allow: ['*'] })],
    });
    registry.register('PreToolUse', { hooks: [createLocalFolderHook(options())] });
    const output = await executeHooks({ registry, input: hookInput });
    expect(output.decision).toBe('ask');
    expect(output.allowedDecisions).toEqual(['respond', 'reject']);
    expect(output.updatedInput).toEqual({ ...args, maxChars: 16000 });
  });

  test.each([
    { hitlCapable: false },
    { userId: undefined },
    { conversationId: undefined },
    { grants: [] },
  ])('fails closed without authenticated resumable capability %j', async (extra) => {
    const output = await createLocalFolderHook(options(extra))(
      hookInput,
      new AbortController().signal,
    );
    expect(output?.decision).toBe('deny');
  });

  test('denies subagents, another chat, unknown folders and an aborted turn', async () => {
    const hook = createLocalFolderHook(options());
    for (const extra of [
      { agentId: 'child' },
      { threadId: 'other' },
      { toolInput: { ...args, folderId: '00' } },
    ]) {
      expect((await hook({ ...hookInput, ...extra }, new AbortController().signal))?.decision).toBe(
        'deny',
      );
    }
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await createLocalFolderHook(options({ signal: controller.signal }))(
          hookInput,
          controller.signal,
        )
      )?.decision,
    ).toBe('deny');
  });

  test('reduces result budget with remaining context and declines insufficient space', async () => {
    const hook = createLocalFolderHook(options({ getRemainingTokens: () => 10_000 }));
    expect((await hook(hookInput, new AbortController().signal))?.updatedInput).toEqual({
      ...args,
      maxChars: 2500,
    });
    for (const remaining of [0, 8191, undefined, NaN]) {
      expect(
        (
          await createLocalFolderHook(options({ getRemainingTokens: () => remaining }))(
            hookInput,
            new AbortController().signal,
          )
        )?.decision,
      ).toBe('deny');
    }
  });

  test('reconstructs repeated-call limit after a resume without counting replay twice', async () => {
    const messages = [new HumanMessage('Read'), priorCall('old-1'), priorCall('old-2')];
    expect(
      (
        await createLocalFolderHook(options({ getMessages: () => messages }))(
          hookInput,
          new AbortController().signal,
        )
      )?.decision,
    ).toBe('deny');
    const replayMessages = [new HumanMessage('Read'), priorCall('old-1'), priorCall('call-1')];
    const hook = createLocalFolderHook(options({ getMessages: () => replayMessages }));
    for (let i = 0; i < 2; i++)
      expect((await hook(hookInput, new AbortController().signal))?.decision).toBe('ask');
  });

  test('caps different calls across resume and starts a fresh budget after the next user turn', async () => {
    const messages = [
      new HumanMessage('Read'),
      ...Array.from({ length: 24 }, (_, n) =>
        priorCall(`old-${n}`, { ...args, path: `file-${n}` }),
      ),
    ];
    expect(
      (
        await createLocalFolderHook(options({ getMessages: () => messages }))(
          hookInput,
          new AbortController().signal,
        )
      )?.decision,
    ).toBe('deny');
    messages.push(new HumanMessage('New task'));
    expect(
      (
        await createLocalFolderHook(options({ getMessages: () => messages }))(
          hookInput,
          new AbortController().signal,
        )
      )?.decision,
    ).toBe('ask');
  });

  test('tool implementation cannot read a server file even when called directly', async () => {
    const localTool = createLocalFolderTool(grants);
    expect(localTool.description).toContain('untrusted external document data');
    await expect(localTool.invoke(args)).rejects.toThrow('ausschliesslich im verbundenen Browser');
  });

  test('accepts attributed JSON only for the pinned grant', () => {
    expect(validateLocalFolderResolutions(payload, decision(), grants)).toBeUndefined();
    expect(validateLocalFolderResolutions(payload, decision(), [])).toMatch(/Ordnerfreigabe/);
    expect(
      validateLocalFolderResolutions(
        payload,
        decision(JSON.stringify({ ...result, source: undefined })),
        grants,
      ),
    ).toMatch(/Quellenpfad/);
    expect(
      validateLocalFolderResolutions(
        payload,
        decision(JSON.stringify({ ...result, coverage: {} })),
        grants,
      ),
    ).toMatch(/gültiges/);
  });

  test.each(['[not-json', JSON.stringify({ instruction: 'run host command' }), 'x'.repeat(3001)])(
    'rejects invalid and oversized resume result',
    (text) => {
      expect(validateLocalFolderResolutions(payload, decision(text), grants)).toBeDefined();
    },
  );

  test('cannot approve, edit, duplicate, add or substitute a stale tool call', () => {
    for (const decisions of [
      [{ tool_call_id: 'call-1', decision: 'approve' as const }],
      [{ tool_call_id: 'call-1', decision: 'edit' as const, editedArguments: args }],
      [...decision(), ...decision()],
      decision().map((entry) => ({ ...entry, tool_call_id: 'stale' })),
    ])
      expect(validateLocalFolderResolutions(payload, decisions, grants)).toBeDefined();
  });

  test('server disable revokes responses while rejection can still clear the pending action', () => {
    process.env.EUCOWORK_LOCAL_FOLDERS = 'false';
    expect(validateLocalFolderResolutions(payload, decision(), grants)).toMatch(/deaktiviert/);
    expect(
      validateLocalFolderResolutions(payload, [{ tool_call_id: 'call-1', decision: 'reject' }], []),
    ).toBeUndefined();
  });

  test('declines parallel batches instead of opening several unbudgeted browser reads', async () => {
    const message = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call-1', name: 'local_folder', args },
        { id: 'call-2', name: 'local_folder', args: { ...args, path: 'other.txt' } },
      ],
    });
    expect(
      (
        await createLocalFolderHook(options({ getMessages: () => [message] }))(
          hookInput,
          new AbortController().signal,
        )
      )?.decision,
    ).toBe('deny');
  });
});
