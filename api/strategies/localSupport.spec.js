jest.mock('@librechat/data-schemas', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));
jest.mock('librechat-data-provider', () => ({ errorsToString: jest.fn() }));
jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn(),
  checkEmailConfig: jest.fn(),
  comparePassword: jest.fn(),
  isSupportServiceIdentity: jest.fn(),
}));
jest.mock('~/models', () => ({ findUser: jest.fn(), updateUser: jest.fn() }));
jest.mock('./validators', () => ({
  loginSchema: { safeParse: jest.fn(() => ({ success: true })) },
}));

const { findUser } = require('~/models');
const { isSupportServiceIdentity, comparePassword } = require('@librechat/api');
const strategy = require('./localStrategy');

test('refuses a service identity even if somebody added a password', async () => {
  findUser.mockResolvedValue({
    email: 'support-runtime@kisuno.invalid',
    password: 'unexpected-hash',
  });
  isSupportServiceIdentity.mockReturnValue(true);
  const done = jest.fn();
  await strategy()._verify(
    { body: {}, ip: '127.0.0.1' },
    'support-runtime@kisuno.invalid',
    'candidate',
    done,
  );
  expect(done).toHaveBeenCalledWith(null, false, expect.any(Object));
  expect(comparePassword).not.toHaveBeenCalled();
});
