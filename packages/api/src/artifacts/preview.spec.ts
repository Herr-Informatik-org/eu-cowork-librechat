import express from 'express';
import request from 'supertest';
import { artifactPreviewHandler, ARTIFACT_PREVIEW_SHELL } from './preview';

it('serves a constant data-free shell with mandatory HTTP sandbox policy', async () => {
  const app = express();
  app.get('/preview', artifactPreviewHandler);
  const response = await request(app).get('/preview?html=private-content').expect(200);
  expect(response.text).toBe(ARTIFACT_PREVIEW_SHELL);
  expect(response.text).not.toContain('private-content');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
  expect(response.headers['content-security-policy']).toContain('sandbox allow-scripts');
  expect(response.headers['set-cookie']).toBeUndefined();
  await request(app).post('/preview').send({ html: 'private-content' }).expect(404);
});
