const { SystemRoles } = require('librechat-data-provider');

let capturedVerifyCallback;
jest.mock('passport-jwt', () => ({
  Strategy: jest.fn((opts, verifyCallback) => {
    capturedVerifyCallback = verifyCallback;
    return { name: 'jwt' };
  }),
  ExtractJwt: {
    fromAuthHeaderAsBearerToken: jest.fn(() => 'mock-extractor'),
  },
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('~/models', () => ({
  getUserById: jest.fn(),
  updateUser: jest.fn(),
}));

const jwtLogin = require('./jwtStrategy');
const { getUserById, updateUser } = require('~/models');

function invokeVerify(payload) {
  return new Promise((resolve, reject) => {
    capturedVerifyCallback(
      { originalUrl: '/api/user', method: 'GET' },
      payload,
      (err, user, info) => {
        if (err) {
          return reject(err);
        }
        resolve({ user, info });
      },
    );
  });
}

describe('jwtStrategy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateUser.mockResolvedValue({});
    jwtLogin();
  });

  it('coerces missing idOnTheSource to null for local users', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-1' },
      role: SystemRoles.USER,
    });

    const { user } = await invokeVerify({ id: 'user-1' });

    expect(user.id).toBe('user-1');
    expect(user.idOnTheSource).toBeNull();
  });

  it('preserves a stored idOnTheSource for federated users', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-2' },
      role: SystemRoles.USER,
      idOnTheSource: 'entra-oid-123',
    });

    const { user } = await invokeVerify({ id: 'user-2' });

    expect(user.idOnTheSource).toBe('entra-oid-123');
  });

  it('returns false when no user is found', async () => {
    getUserById.mockResolvedValue(null);

    const { user } = await invokeVerify({ id: 'missing' });

    expect(user).toBe(false);
  });

  it('rejects access assurance from before a password change while accepting the current version', async () => {
    const previousPolicy = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    try {
      getUserById.mockResolvedValue({
        _id: { toString: () => 'reset-user' },
        role: SystemRoles.USER,
        securityVersion: 5,
      });
      const proof = { method: 'totp', verifiedAt: Date.now(), version: 4 };

      expect((await invokeVerify({ id: 'reset-user', mfa: proof })).user).toBe(false);
      expect(
        (await invokeVerify({ id: 'reset-user', mfa: { ...proof, version: 5 } })).user.id,
      ).toBe('reset-user');
    } finally {
      if (previousPolicy === undefined) delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
      else process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = previousPolicy;
    }
  });
});
