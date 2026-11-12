import express from 'express';
import request from 'supertest';
import { hashToken } from '@librechat/data-schemas';
import { invitationDetails, invitationDetailsController } from './invitation';
import { getInvite } from './invite';

jest.mock('@librechat/data-schemas', () => ({
  hashToken: jest.fn(async () => 'synthetic-digest'),
  logger: { error: jest.fn() },
}));

const token = 'synthetic-invitation-'.repeat(3);
const now = Date.now();
const valid = {
  email: 'person@example.com',
  name: 'Example Person',
  expiresAt: new Date(now + 60_000),
};
const dependencies = (record: unknown = valid, user: unknown = null) => ({
  findToken: jest.fn(async () => record),
  findUser: jest.fn(async () => user),
});

it('rejects expired tokens during registration even before MongoDB TTL cleanup', async () => {
  const deps = {
    ...dependencies({ ...valid, expiresAt: new Date(now - 1) }),
    createToken: jest.fn(),
  };
  expect(await getInvite(token, valid.email, deps)).toEqual(
    expect.objectContaining({ error: true }),
  );
});

it('returns only known form fields without consuming the invitation', async () => {
  const deps = dependencies({
    ...valid,
    role: 'ADMIN',
    token: 'private-hash',
    userId: 'private-id',
  });
  expect(await invitationDetails(token, deps, now)).toEqual({
    email: valid.email,
    name: valid.name,
  });
  expect(hashToken).toHaveBeenCalledWith(token);
  expect(deps.findToken).toHaveBeenCalledWith({ token: 'synthetic-digest' });
  expect(await invitationDetails(token, deps, now)).toEqual({
    email: valid.email,
    name: valid.name,
  });
});

it.each([
  null,
  { ...valid, expiresAt: new Date(now - 1) },
  { ...valid, expiresAt: 'invalid' },
  { ...valid, expiresAt: undefined },
  { ...valid, type: 'password_reset' },
  { ...valid, identifier: 'verification' },
  { ...valid, email: undefined },
])('rejects missing, expired and unrelated tokens: %s', async (record) => {
  expect(await invitationDetails(token, dependencies(record), now)).toBeNull();
});

it('does not disclose details for an already registered address', async () => {
  expect(await invitationDetails(token, dependencies(valid, { _id: 'existing' }), now)).toBeNull();
});

it.each([undefined, {}, '', 'short', '%'.repeat(64), 'a'.repeat(257)])(
  'rejects malformed input: %s',
  async (value) => {
    const deps = dependencies();
    expect(await invitationDetails(value, deps, now)).toBeNull();
    expect(deps.findToken).not.toHaveBeenCalled();
  },
);

it('keeps old email-only invitations usable and ignores invalid names', async () => {
  expect(await invitationDetails(token, dependencies({ ...valid, name: undefined }), now)).toEqual({
    email: valid.email,
  });
  expect(
    await invitationDetails(token, dependencies({ ...valid, name: 'x'.repeat(81) }), now),
  ).toEqual({ email: valid.email });
});

it('serves no-store responses and returns a generic failure for database errors', async () => {
  const deps = dependencies();
  const app = express();
  app.use(express.json());
  app.post('/details', async (req, res) => {
    await invitationDetailsController(req, res, deps);
  });
  const good = await request(app).post('/details').send({ token }).expect(200);
  expect(good.headers['cache-control']).toBe('no-store');
  expect(good.body).toEqual({ email: valid.email, name: valid.name });
  deps.findToken.mockRejectedValueOnce(new Error('Private data must remain private') as never);
  const bad = await request(app).post('/details').send({ token }).expect(503);
  expect(bad.headers['cache-control']).toBe('no-store');
  expect(JSON.stringify(bad.body)).not.toContain('Private data');
  await request(app).post('/details').send({ token: 'bad' }).expect(400);
});
