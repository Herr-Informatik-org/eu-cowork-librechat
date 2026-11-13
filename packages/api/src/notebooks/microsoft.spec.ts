jest.mock('./client',()=>({...jest.requireActual('./client'),notebookRequest:jest.fn()}));
import express from 'express';
import request from 'supertest';
import { notebookRequest } from './client';
import { createNotebookMicrosoftRouter } from './microsoft';
const rpc=jest.mocked(notebookRequest);
const opaque='a'.repeat(43);
function app(role='ADMIN') {
  process.env.NOTEBOOKS_ENABLED='true';process.env.NOTEBOOKS_ADMIN_URL='https://admin.kisuno.example.test';
  const app=express();app.use((req,_res,next)=>{Object.assign(req,{cookies:{'__Host-kisuno-notebook-microsoft':opaque}});next();});app.use('/microsoft',createNotebookMicrosoftRouter({getUserById:async()=>({role})}));return app;
}
beforeEach(()=>rpc.mockReset());
test('OAuth start refuses a redirect outside Microsoft',async()=>{
  rpc.mockResolvedValue({url:'https://evil.example/',cookie:opaque});
  const response=await request(app()).get('/microsoft/start?code='+opaque);
  expect(response.status).toBe(400);expect(response.headers['set-cookie']).toBeUndefined();
});
test('a revoked administrator cannot finish Microsoft app provisioning',async()=>{
  rpc.mockResolvedValue({userId:'a'.repeat(24),purpose:'setup'});
  const response=await request(app('USER')).get('/microsoft/callback?state='+opaque+'&code=synthetic').set('Cookie','__Host-kisuno-notebook-microsoft='+opaque);
  expect(response.status).toBe(400);expect(rpc).toHaveBeenCalledTimes(1);
});
test('callback uses the fresh initiator and redirects only to the configured admin portal',async()=>{
  const uid='b'.repeat(24),source='11111111-1111-4111-8111-111111111111';
  rpc.mockResolvedValueOnce({userId:uid,purpose:'setup'}).mockResolvedValueOnce({connected:true,setup:true,sourceId:source});
  const response=await request(app()).get('/microsoft/callback?state='+opaque+'&code=synthetic').set('Cookie','__Host-kisuno-notebook-microsoft='+opaque);
  expect(response.status).toBe(303);expect(response.headers.location).toBe('https://admin.kisuno.example.test/wissensquellen?source='+source);
  expect(rpc.mock.calls[1][0]).toMatchObject({id:uid,role:'ADMIN',permissions:0});
});
