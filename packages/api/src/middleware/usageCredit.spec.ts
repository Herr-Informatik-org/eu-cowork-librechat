import mongoose from 'mongoose';
import {
  assertUsageCredit,
  creditExhausted,
  usageCreditMiddleware,
  usageCreditHook,
} from './usageCredit';

jest.mock('mongoose', () => ({ __esModule: true, default: { connection: { db: undefined } } }));
const policy = {
  plan: 'trial' as const,
  trialCreditChf: 50,
  usdChfRate: 0.8,
  trialStartedAt: new Date('2026-08-01'),
};
const lookup = jest.fn();
const savedFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  (mongoose.connection as any).db = { collection: () => ({ findOne: lookup }) };
  lookup.mockResolvedValue(policy);
  process.env.JWT_SECRET = 'unit-test-purpose-only';
  delete process.env.HOSTED_USAGE_REQUIRED;
  global.fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ usdMicros: 62_500_000 }) });
});
afterEach(() => {
  global.fetch = savedFetch;
  delete process.env.JWT_SECRET;
  delete process.env.HOSTED_USAGE_REQUIRED;
});

test('the one-time CHF credit stops at the boundary and does not reset with the month', async () => {
  expect(creditExhausted(policy, 62_499_999)).toBe(false);
  expect(creditExhausted(policy, 62_500_000)).toBe(true);
  await expect(assertUsageCredit()).rejects.toThrow('aufgebraucht');
  expect(lookup).toHaveBeenCalledWith({ _id: 'subscription' });
});
test('paid conversion removes the trial gate, while self-hosted absence is permitted', async () => {
  lookup.mockResolvedValue({ ...policy, plan: 'paid' });
  await assertUsageCredit();
  lookup.mockResolvedValue(null);
  await assertUsageCredit();
  expect(global.fetch).not.toHaveBeenCalled();
});
test('managed setup and unavailable metering fail closed', async () => {
  lookup.mockResolvedValue(null);
  process.env.HOSTED_USAGE_REQUIRED = 'true';
  await expect(assertUsageCredit()).rejects.toThrow('eingerichtet');
  lookup.mockResolvedValue(policy);
  (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));
  await expect(assertUsageCredit()).rejects.toThrow('offline');
  expect(await usageCreditHook()).toMatchObject({ preventContinuation: true, decision: 'deny' });
});
test.each([
  '/api/ask/agents',
  '/api/ask/custom',
  '/api/agents/chat',
  '/api/agents/v1/responses',
  '/api/agents/v1/chat/completions',
  '/api/assistants/chat',
])('all inference admissions reject exhausted credit: %s', async (originalUrl) => {
  const next = jest.fn();
  const json = jest.fn();
  const res = { status: jest.fn().mockReturnValue({ json }) };
  await usageCreditMiddleware({ method: 'POST', originalUrl } as any, res as any, next);
  expect(res.status).toHaveBeenCalledWith(402);
  expect(next).not.toHaveBeenCalled();
});
test.each(['/api/ask/abort', '/api/files', '/api/convos'])(
  'files, history and cancellation remain accessible: %s',
  async (originalUrl) => {
    const next = jest.fn();
    await usageCreditMiddleware({ method: 'POST', originalUrl } as any, {} as any, next);
    expect(next).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  },
);
test('invalid prices and usage cannot silently reopen a trial', () => {
  expect(() => creditExhausted({ ...policy, usdChfRate: NaN }, 0)).toThrow();
  expect(() => creditExhausted(policy, -1)).toThrow();
  expect(() => creditExhausted(policy, NaN)).toThrow();
});
test('tenant admin cannot alter hosted metering configuration through the native API', async () => {
  const json = jest.fn();
  const next = jest.fn();
  const res = { status: jest.fn().mockReturnValue({ json }) };
  await usageCreditMiddleware(
    {
      method: 'PATCH',
      originalUrl: '/api/admin/config/role/__base__/fields',
      get: () => '',
    } as any,
    res as any,
    next,
  );
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});
