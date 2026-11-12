jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn(() => false),
  checkEmailConfig: jest.fn(() => true),
  comparePassword: jest.fn(),
  isSupportServiceIdentity: jest.fn(() => false),
}));
jest.mock('~/models', () => ({ findUser: jest.fn(), updateUser: jest.fn() }));
jest.mock('./validators', () => ({
  loginSchema: { safeParse: jest.fn(() => ({ success: true })) },
}));

const { findUser, updateUser } = require('~/models');
const { comparePassword, isSupportServiceIdentity } = require('@librechat/api');
const strategy = require('./localStrategy');

const invoke = async () => {
  const done = jest.fn();
  await strategy()._verify(
    { body: { email: 'person@example.invalid', password: 'candidate-password' }, ip: '127.0.0.1' },
    'person@example.invalid',
    'candidate-password',
    done,
  );
  return done;
};

beforeEach(() => {
  jest.clearAllMocks();
  isSupportServiceIdentity.mockReturnValue(false);
  comparePassword.mockResolvedValue(false);
});

it.each([
  ['unknown account', null, false],
  ['incorrect password', { password: 'stored-hash' }, false],
  ['SSO-only account', { provider: 'openid' }, false],
  ['service account', { password: 'stored-hash' }, true],
])(
  'returns the same failure and performs hash verification for %s',
  async (_label, user, service) => {
    findUser.mockResolvedValue(user);
    isSupportServiceIdentity.mockReturnValue(service);

    const done = await invoke();

    expect(done).toHaveBeenCalledWith(null, false, {
      message: 'E-Mail oder Passwort stimmt nicht.',
    });
    expect(comparePassword).toHaveBeenCalledTimes(1);
    expect(comparePassword).toHaveBeenCalledWith(service ? null : user, 'candidate-password', {
      compare: expect.any(Function),
    });
    expect(updateUser).not.toHaveBeenCalled();
  },
);

it('continues a valid password login unchanged so MFA can begin', async () => {
  const user = { _id: 'person-id', password: 'stored-hash', emailVerified: true };
  findUser.mockResolvedValue(user);
  comparePassword.mockResolvedValue(true);

  expect(await invoke()).toHaveBeenCalledWith(null, user);
});

it('requires email verification only after the password is proven', async () => {
  const user = { _id: 'person-id', password: 'stored-hash', emailVerified: false };
  findUser.mockResolvedValue(user);
  comparePassword.mockResolvedValue(true);

  expect(await invoke()).toHaveBeenCalledWith(null, user, { message: 'Email not verified.' });
});
