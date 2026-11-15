jest.mock('./client', () => ({
  ...jest.requireActual('./client'),
  notebookRequest: jest.fn(),
}));
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import type { IUser } from '@librechat/data-schemas';
import type { NotebookDependencies } from './router';
import { createNotebooksRouter } from './router';
import { notebookRequest } from './client';

const rpc = jest.mocked(notebookRequest);
const userId = 'a'.repeat(24);
const roomId = 'b'.repeat(24);
const sourceId = '11111111-1111-4111-8111-111111111111';
const TestUser = mongoose.model<IUser>('NotebookFixtureUser', new mongoose.Schema({ role: String, email: String, provider: String, emailVerified: Boolean }));
const fixture = (role = 'USER'): IUser => new TestUser({ _id: new mongoose.Types.ObjectId(userId), role, email: 'pilot@example.test', provider: 'local', emailVerified: true }).toObject<IUser>({ virtuals: true });
function setup(role='USER', permissions=1) {
  process.env.NOTEBOOKS_ENABLED='true';
  process.env.NOTEBOOKS_MODEL_ZONE='global';
  process.env.DOMAIN_CLIENT='https://kisuno.example.test';
  const native: NotebookDependencies = {
    canUse: jest.fn(async () => true),
    getUserById: jest.fn(async () => fixture(role)),
    permissions: jest.fn(async () => permissions),
    list: jest.fn(async () => [roomId]),
    grant: jest.fn(async () => ({ granted: true })),
    remove: jest.fn(async () => undefined),
    answer: jest.fn(async () => '25 Tage [q1]'),
  };
  const app=express();
  app.use(express.json());
  app.use((req,_res,next) => { Object.assign(req,{ user: fixture(role) }); next(); });
  app.use('/api/notebooks',createNotebooksRouter(native));
  return { app, native };
}
beforeEach(() => rpc.mockReset());
afterEach(() => jest.restoreAllMocks());
test('feature disabled is unavailable after native authentication',async () => {
  const {app}=setup(); process.env.NOTEBOOKS_ENABLED='false';
  expect((await request(app).get('/api/notebooks/status')).status).toBe(404);
  expect(rpc).not.toHaveBeenCalled();
});
test('status middleware continues without hanging',async () => {
  const {app}=setup();
  const result=await request(app).get('/api/notebooks/status');
  expect(result.status).toBe(200); expect(result.body.available).toBe(true);
});
test('source administration is denied to normal accounts',async () => {
  const {app}=setup();
  expect((await request(app).post('/api/notebooks/admin/sources').send({})).status).toBe(403);
  expect(rpc).not.toHaveBeenCalled();
});
test('source discovery cannot smuggle arbitrary operations',async () => {
  const {app}=setup('ADMIN');
  expect((await request(app).post(`/api/notebooks/admin/sources/${sourceId}/delete-site`).send({})).status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
});
test('cross-origin mutation rejected before RPC',async () => {
  const {app}=setup();
  expect((await request(app).post('/api/notebooks/rooms').set('Origin','https://evil.example').send({name:'Test',zone:'global'})).status).toBe(403);
  expect(rpc).not.toHaveBeenCalled();
});
test('native ACL permissions are signed by the core, never client input',async () => {
  const {app}=setup('USER',1); rpc.mockResolvedValue({documents:[]});
  await request(app).get(`/api/notebooks/rooms/${roomId}/documents?permissions=15`);
  expect(rpc.mock.calls[0][0]).toEqual({id:userId,role:'USER',room:roomId,permissions:1});
});
test('source-free result never reaches the answer model',async () => {
  const {app,native}=setup();
  rpc.mockResolvedValue({ticket:sourceId,evidence:[],sources:[],partial:true,checkedAt:new Date().toISOString(),notice:'Keine Grundlage'});
  expect((await request(app).post(`/api/notebooks/rooms/${roomId}/query`).send({query:'Ferien',answer:true})).status).toBe(200);
  expect(native.answer).not.toHaveBeenCalled();
});
test('model zone supplied by caller is rejected',async () => {
  const {app}=setup();
  expect((await request(app).post(`/api/notebooks/rooms/${roomId}/query`).send({query:'Ferien',answer:false,zone:'lokal'})).status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
});
test('public sharing is rejected even for a room owner',async () => {
  const {app}=setup('USER',15);
  expect((await request(app).post(`/api/notebooks/rooms/${roomId}/share`).send({principalType:'public',principalId:userId,editor:false})).status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
});
test('no caller can submit a fabricated model answer',async () => {
  const {app}=setup();
  expect((await request(app).post(`/api/notebooks/rooms/${roomId}/complete`).send({answer:'fake'})).status).toBe(404);
});
test('personal Microsoft link keeps the browser binding out of the response body',async () => {
  const {app}=setup('USER',1); const binding='c'.repeat(43), source='11111111-1111-4111-8111-111111111111';
  rpc.mockResolvedValue({url:'https://kisuno.example.test/api/notebooks/microsoft/start?code='+'d'.repeat(43),cookie:binding});
  const response=await request(app).post(`/api/notebooks/rooms/${roomId}/sources/${source}/microsoft`).send({});
  expect(response.status).toBe(200);
  expect(response.body).toEqual({url:'https://kisuno.example.test/api/notebooks/microsoft/start?code='+'d'.repeat(43)});
  const cookie=String(response.headers['set-cookie']);
  expect(cookie).toContain('__Host-kisuno-notebook-microsoft='+binding);
  expect(cookie).toMatch(/HttpOnly/i);expect(cookie).toMatch(/Secure/i);expect(cookie).toMatch(/SameSite=Lax/i);expect(cookie).toContain('Path=/');
});
test('folder rules are an administrator operation with a strict body',async () => {
  const source='11111111-1111-4111-8111-111111111111';
  const user=setup('USER',1); rpc.mockResolvedValue({saved:true});
  expect((await request(user.app).post(`/api/notebooks/admin/sources/${source}/folders`).send({path:'Administration'})).status).toBe(403);
  const admin=setup('ADMIN',1);
  expect((await request(admin.app).post(`/api/notebooks/admin/sources/${source}/folders`).send({path:'Administration',dataClass:'geheim'})).status).toBe(400);
  expect((await request(admin.app).post(`/api/notebooks/admin/sources/${source}/folders`).send({path:'Administration',dataClass:'offen',extra:true})).status).toBe(400);
  const saved=await request(admin.app).post(`/api/notebooks/admin/sources/${source}/folders`).send({path:' Administration ',dataClass:'offen'});
  expect(saved.status).toBe(200);
  expect(rpc.mock.calls.at(-1)?.slice(1,2)).toEqual([`/admin/sources/${source}/folders`]);
  expect(rpc.mock.calls.at(-1)?.[4]).toEqual({path:'Administration',dataClass:'offen',excluded:false});
  expect((await request(admin.app).get(`/api/notebooks/admin/sources/${source}/folders`)).status).toBe(200);
});
