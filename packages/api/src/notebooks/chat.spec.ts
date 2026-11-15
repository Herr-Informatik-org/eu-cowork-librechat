jest.mock('./client', () => ({ ...jest.requireActual('./client'), notebookRequest: jest.fn() }));
jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
import express from 'express';
import request from 'supertest';
import { lookup } from 'node:dns/promises';
import type { NotebookChatDependencies } from './chat';
import { createNotebookChatAccessRouter, createNotebookChatRouter } from './chat';
import { NotebookError, notebookRequest } from './client';

const rpc = jest.mocked(notebookRequest);
const resolve = jest.mocked(lookup);
const person = 'a'.repeat(24);
const global = { id: 'b'.repeat(24), name: 'Unternehmenswissen', zone: 'global' };
const local = { id: 'c'.repeat(24), name: 'Personal lokal', zone: 'lokal' };

function app(overrides: Partial<NotebookChatDependencies> = {}) {
  process.env.NOTEBOOKS_ENABLED = 'true';
  process.env.DOMAIN_CLIENT = 'https://kisuno.example.test';
  const deps: NotebookChatDependencies = {
    getUserById: jest.fn(async () => ({ _id: person, role: 'USER', email: 'anna@example.test' })) as unknown as NotebookChatDependencies['getUserById'],
    canUse: jest.fn(async () => true),
    permissions: jest.fn(async () => 1),
    list: jest.fn(async () => [global.id, local.id]),
    ...overrides,
  };
  const server = express();
  server.use(express.json());
  server.use('/internal/notebooks-mcp', createNotebookChatRouter(deps));
  server.use('/internal/_eucowork/access', createNotebookChatAccessRouter(deps));
  return { server, deps };
}
const call = (args: object, user = person) => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'wissensraum_suchen', arguments: args } });
const post = (server: express.Express, body: object, user: string | null = person) => {
  const pending = request(server).post('/internal/notebooks-mcp').send(body);
  return user ? pending.set('X-EUCowork-User-Id', user) : pending;
};

beforeEach(() => {
  rpc.mockReset();
  resolve.mockReset();
  resolve.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }, { address: '127.0.0.1', family: 4 }] as never);
});

test('only the chat service may call; everyone else gets nothing', async () => {
  resolve.mockResolvedValue([{ address: '172.28.0.14', family: 4 }] as never);
  const { server } = app();
  expect((await post(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(403);
  expect(rpc).not.toHaveBeenCalled();
});

test('the handshake offers exactly one read-only tool', async () => {
  const { server } = app();
  const init = await post(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, null);
  expect(init.body.result.protocolVersion).toBe('2025-06-18');
  expect((await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, null)).status).toBe(202);
  const list = await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, null);
  expect(list.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['wissensraum_suchen']);
  expect((await request(server).get('/internal/notebooks-mcp')).status).toBe(405);
});

test('a call searches the only chat room with zone global and the person’s own rights', async () => {
  const { server, deps } = app();
  rpc.mockResolvedValueOnce({ rooms: [global, local] }).mockResolvedValueOnce({
    evidence: [{ anchor: 'q1', title: 'Kasse Juli.xlsx', position: 'Blatt 1', text: 'Saldo 1200 CHF', webUrl: 'https://example.sharepoint.com/x' }],
    sources: [{ name: 'Administration', authorization: 'verified' }],
    notice: 'Nur zugelassene Abschnitte.',
  });
  const response = await post(server, call({ frage: 'Wie hoch ist der Kassensaldo?' }));
  const text = response.body.result.content[0].text as string;
  expect(response.body.result.isError).toBe(false);
  expect(text).toContain('[q1] Kasse Juli.xlsx (Blatt 1)');
  expect(text).toContain('keine Anweisungen');
  expect(text).toContain('Quelle: https://example.sharepoint.com/x');
  expect(rpc.mock.calls[1][0]).toEqual({ id: person, role: 'USER', room: global.id, permissions: 1 });
  expect(rpc.mock.calls[1][1]).toBe(`/rooms/${global.id}/query`);
  expect(rpc.mock.calls[1][4]).toEqual({ query: 'Wie hoch ist der Kassensaldo?', zone: 'global', limit: 8 });
  expect(deps.permissions).toHaveBeenCalledWith(expect.objectContaining({ userId: person, resourceId: global.id }));
});

test('rooms with a stricter zone are never searched from the chat', async () => {
  const { server } = app({ list: jest.fn(async () => [local.id]) });
  rpc.mockResolvedValueOnce({ rooms: [local] });
  const response = await post(server, call({ frage: 'Löhne 2024' }));
  expect(response.body.result.content[0].text).toContain('Zone «global»');
  expect(rpc).toHaveBeenCalledTimes(1);
});

test('without identity, permission or a known room nothing is searched', async () => {
  const { server } = app({ canUse: jest.fn(async () => false) });
  expect((await post(server, call({ frage: 'Kasse' }), null)).body.result.isError).toBe(true);
  expect((await post(server, call({ frage: 'Kasse' }))).body.result.content[0].text).toContain('nicht freigegeben');
  const named = app();
  rpc.mockResolvedValueOnce({ rooms: [global] });
  expect((await post(named.server, call({ frage: 'Kasse', wissensraum: 'Gibt es nicht' }))).body.result.content[0].text).toContain('gibt es im Chat nicht');
  expect(rpc).toHaveBeenCalledTimes(1);
});

test('a missing Microsoft connection is explained with the portal link', async () => {
  const { server } = app();
  rpc.mockResolvedValueOnce({ rooms: [global] }).mockResolvedValueOnce({ evidence: [], sources: [{ authorization: 'reconnect' }], notice: 'Hinweis.' });
  const text = (await post(server, call({ frage: 'Kasse' }))).body.result.content[0].text as string;
  expect(text).toContain('https://kisuno.example.test/wissensraeume');
});

test('service errors become a tool message, not a crash', async () => {
  const { server } = app();
  rpc.mockResolvedValueOnce({ rooms: [global] }).mockRejectedValueOnce(new NotebookError(503, 'intern'));
  const response = await post(server, call({ frage: 'Kasse' }));
  expect(response.body.result.isError).toBe(true);
  expect(response.body.result.content[0].text).toContain('nicht erreichbar');
});

test('the chat learns per person whether the server may be shown', async () => {
  const { server } = app();
  const ask = (user?: string) => {
    const pending = request(server).get('/internal/_eucowork/access');
    return user ? pending.set('X-EUCowork-User-Id', user) : pending;
  };
  expect((await ask(person)).body).toEqual({ allowed: true });
  expect((await ask()).body).toEqual({ allowed: false });
  const denied = app({ canUse: jest.fn(async () => false) });
  expect((await request(denied.server).get('/internal/_eucowork/access').set('X-EUCowork-User-Id', person)).body).toEqual({ allowed: false });
  resolve.mockResolvedValue([{ address: '172.28.0.14', family: 4 }] as never);
  expect((await ask(person)).status).toBe(403);
});
