import { waitFor } from '@testing-library/react';
import type { Agents, LocalFolderResult } from 'librechat-data-provider';
import { submitToolApproval } from '~/data-provider/SSE/mutations';
import {
  handleLocalFolderAction,
  getLocalFolderAction,
  retryLocalFolderAction,
  cancelLocalFolderGeneration,
} from './bridge';
import type { LocalFolderActionOptions } from './bridge';
import {
  addLocalFolder,
  clearLocalFolders,
  getLocalFolders,
  removeLocalFolder,
  setLocalFolderUser,
} from './store';

jest.mock('~/data-provider/SSE/mutations', () => ({ submitToolApproval: jest.fn() }));
const submit = jest.mocked(submitToolApproval);
const result: LocalFolderResult = {
  status: 'ok',
  text: 'requested excerpt',
  coverage: { complete: true, filesVisited: 1, filesRead: 1, bytesRead: 17, skipped: 0 },
};
const execute = jest.fn<Promise<LocalFolderResult>, []>();
function options(): LocalFolderActionOptions {
  return {
    userId: 'user',
    verifyCurrent: async () => true,
    isCurrent: () => true,
    fields: {
      conversationId: 'chat',
      generationCreatedAt: 1000,
      ephemeralAgent: { localFolders: [{ id: 'folder', label: 'Reports' }] },
    },
    pendingAction: {
      actionId: 'action',
      streamId: 'chat',
      conversationId: 'chat',
      createdAt: 1001,
      payload: {
        type: 'tool_approval',
        action_requests: [
          {
            name: 'local_folder',
            tool_call_id: 'call',
            arguments: {
              folderId: 'folder',
              operation: 'read',
              path: 'report.txt',
              maxChars: 16000,
            },
          },
        ],
        review_configs: [
          {
            action_name: 'local_folder',
            tool_call_id: 'call',
            allowed_decisions: ['respond', 'reject'],
          },
        ],
      },
    },
  };
}

beforeEach(() => {
  clearLocalFolders();
  setLocalFolderUser('user');
  execute.mockReset().mockResolvedValue(result);
  submit
    .mockReset()
    .mockResolvedValue({ conversationId: 'chat', streamId: 'chat', status: 'resuming' });
  addLocalFolder(
    'user',
    'chat',
    { id: 'folder', label: 'Reports' },
    { execute, dispose: jest.fn() },
  );
});
afterEach(() => setLocalFolderUser(null));

it('executes only once across duplicate pending events and sends fenced metadata', async () => {
  const input = options();
  handleLocalFolderAction(input);
  handleLocalFolderAction(input);
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  handleLocalFolderAction(input);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      conversationId: 'chat',
      generationCreatedAt: 1000,
      actionId: 'action',
      decisions: [
        { tool_call_id: 'call', decision: 'respond', responseText: JSON.stringify(result) },
      ],
    }),
  );
});

it('retries a lost acknowledgement without reading again', async () => {
  submit.mockRejectedValueOnce(new Error('connection lost'));
  handleLocalFolderAction(options());
  await waitFor(() => expect(getLocalFolderAction('action')).toBe('retry'));
  retryLocalFolderAction('action');
  retryLocalFolderAction('action');
  await waitFor(() => expect(getLocalFolderAction('action')).toBe('sent'));
  expect(submit).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0][0]).toEqual(submit.mock.calls[1][0]);
});

it('automatically retries a not-yet-published pause before accessing files', async () => {
  const verifyCurrent = jest
    .fn()
    .mockRejectedValueOnce({ response: { status: 503 } })
    .mockResolvedValue(true);
  handleLocalFolderAction({ ...options(), verifyCurrent });
  await waitFor(() => expect(getLocalFolderAction('action')).toBe('retry'));
  expect(execute).not.toHaveBeenCalled();
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each(['owner', 'conversation', 'stale', 'expired'])(
  'refuses a mismatched %s before file access',
  (mismatch) => {
    const input = options();
    if (mismatch === 'owner') input.userId = 'other';
    if (mismatch === 'conversation') input.pendingAction.conversationId = 'other';
    if (mismatch === 'stale') input.isCurrent = () => false;
    if (mismatch === 'expired') input.pendingAction.expiresAt = Date.now() - 1;
    handleLocalFolderAction(input);
    expect(execute).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  },
);

it('never executes or decides other tools in a mixed batch', () => {
  const input = options();
  const payload = input.pendingAction.payload as Agents.ToolApprovalInterruptPayload;
  payload.action_requests.push({ name: 'delete_record', tool_call_id: 'remote', arguments: {} });
  handleLocalFolderAction(input);
  expect(getLocalFolderAction('action')).toBe('mixed');
  expect(execute).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

it('rejects missing handles after reload without pretending the folder is empty', async () => {
  removeLocalFolder('user', 'chat', 'folder');
  handleLocalFolderAction(options());
  await waitFor(() => expect(submit).toHaveBeenCalled());
  expect(execute).not.toHaveBeenCalled();
  expect(submit.mock.calls[0][0].decisions[0].decision).toBe('reject');
});

it('does not send data when navigation invalidates an ongoing read', async () => {
  let resolve: (value: LocalFolderResult) => void = () => undefined;
  execute.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let current = true;
  handleLocalFolderAction({ ...options(), isCurrent: () => current });
  current = false;
  resolve(result);
  await new Promise((done) => setTimeout(done, 0));
  expect(submit).not.toHaveBeenCalled();
});

it('clears a cached result on revocation before retrying its acknowledgement', async () => {
  submit.mockRejectedValueOnce(new Error('lost'));
  handleLocalFolderAction(options());
  await waitFor(() => expect(getLocalFolderAction('action')).toBe('retry'));
  removeLocalFolder('user', 'chat', 'folder');
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submit.mock.calls[1][0].decisions[0]).toMatchObject({ decision: 'reject' });
  expect(JSON.stringify(submit.mock.calls[1][0])).not.toContain('requested excerpt');
  expect(execute).toHaveBeenCalledTimes(1);
});

it('rejects oversized responses instead of leaking a truncated invalid JSON result', async () => {
  execute.mockResolvedValue({ ...result, text: 'x'.repeat(16000) });
  handleLocalFolderAction(options());
  await waitFor(() => expect(submit).toHaveBeenCalled());
  expect(submit.mock.calls[0][0].decisions[0].decision).toBe('reject');
});

it('rechecks revocation after awaiting the last authoritative status check', async () => {
  let resolve: (value: boolean) => void = () => undefined;
  const verifyCurrent = jest
    .fn()
    .mockResolvedValueOnce(true)
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
  handleLocalFolderAction({ ...options(), verifyCurrent });
  await waitFor(() => expect(verifyCurrent).toHaveBeenCalledTimes(2));
  removeLocalFolder('user', 'chat', 'folder');
  resolve(true);
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0][0].decisions[0].decision).toBe('reject');
  expect(JSON.stringify(submit.mock.calls[0][0])).not.toContain('requested excerpt');
});

it('does not read files for a replay that is no longer the current server pause', async () => {
  handleLocalFolderAction({ ...options(), verifyCurrent: async () => false });
  await waitFor(() => expect(getLocalFolderAction('action')).toBe('unavailable'));
  expect(execute).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

it('aborts a stopped generation immediately and rejects replay while retaining the grant', async () => {
  let resolveRead: (value: LocalFolderResult) => void = () => undefined;
  execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  handleLocalFolderAction({ ...options(), originConversationId: 'new' });
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  const signal = (execute.mock.calls[0] as unknown as [unknown, AbortSignal])[1];
  cancelLocalFolderGeneration('new', 1000);
  expect(signal.aborted).toBe(true);
  expect(getLocalFolders('user', 'chat')).toHaveLength(1);
  resolveRead(result);
  await waitFor(() => expect(getLocalFolderAction('action')).toBe('cancelled'));
  handleLocalFolderAction({ ...options(), originConversationId: 'new' });
  retryLocalFolderAction('action');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();

  const next = options();
  next.fields.generationCreatedAt = 2000;
  next.pendingAction.actionId = 'next-action';
  handleLocalFolderAction(next);
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0][0].generationCreatedAt).toBe(2000);
});

it('drops an already-read excerpt when Stop occurs during the final status request', async () => {
  let resolveStatus: (value: boolean) => void = () => undefined;
  const verifyCurrent = jest
    .fn()
    .mockResolvedValueOnce(true)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
  handleLocalFolderAction({ ...options(), verifyCurrent });
  await waitFor(() => expect(verifyCurrent).toHaveBeenCalledTimes(2));
  cancelLocalFolderGeneration('chat', 1000);
  resolveStatus(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  retryLocalFolderAction('action');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
});

it('forwards bounded direct byte and page positions to the reader', async () => {
  const input = options();
  const payload = input.pendingAction.payload as Agents.ToolApprovalInterruptPayload;
  payload.action_requests[0].arguments = {
    folderId: 'folder',
    operation: 'read',
    maxChars: 4000,
    startByte: 1048576,
    page: 20,
  };
  handleLocalFolderAction(input);
  await waitFor(() => expect(submit).toHaveBeenCalled());
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ startByte: 1048576, page: 20 }),
    expect.any(AbortSignal),
  );
});

it.each([
  { startByte: -1 },
  { startByte: 1.5 },
  { page: 0 },
  { page: Number.MAX_SAFE_INTEGER + 1 },
])('rejects invalid direct positions %j', async (position) => {
  const input = options();
  const payload = input.pendingAction.payload as Agents.ToolApprovalInterruptPayload;
  payload.action_requests[0].arguments = {
    folderId: 'folder',
    operation: 'read',
    maxChars: 4000,
    ...position,
  };
  handleLocalFolderAction(input);
  await waitFor(() => expect(submit).toHaveBeenCalled());
  expect(execute).not.toHaveBeenCalled();
  expect(submit.mock.calls[0][0].decisions[0].decision).toBe('reject');
});
