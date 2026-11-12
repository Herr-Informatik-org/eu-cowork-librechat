jest.mock('passport', () => ({ authenticate: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn() },
}));

const passport = require('passport');
const requireLocalAuth = require('./requireLocalAuth');

const response = () => ({ status: jest.fn().mockReturnThis(), send: jest.fn() });

it.each(['Email does not exist.', 'Incorrect password.', undefined])(
  'does not expose a strategy-specific failure %p',
  (message) => {
    passport.authenticate.mockImplementation(
      (_name, callback) => () => callback(null, false, { message }),
    );
    const res = response();
    const next = jest.fn();

    requireLocalAuth({}, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ message: 'E-Mail oder Passwort stimmt nicht.' });
    expect(next).not.toHaveBeenCalled();
  },
);

it('continues an authenticated user without changing their MFA path', () => {
  const user = { id: 'synthetic-user' };
  passport.authenticate.mockImplementation((_name, callback) => () => callback(null, user));
  const req = {};
  const res = response();
  const next = jest.fn();

  requireLocalAuth(req, res, next);

  expect(req.user).toEqual(user);
  expect(next).toHaveBeenCalledWith();
  expect(res.status).not.toHaveBeenCalled();
});
