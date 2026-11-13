import { comparePassword } from './password';

describe('local password verification', () => {
  it.each([null, undefined, {}])(
    'performs bcrypt work for missing credentials %p',
    async (user) => {
      const compare = jest.fn().mockResolvedValue(false);

      expect(await comparePassword(user, 'candidate-password', { compare })).toBe(false);

      expect(compare).toHaveBeenCalledTimes(1);
      expect(compare).toHaveBeenCalledWith(
        'candidate-password',
        expect.stringMatching(/^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/),
      );
    },
  );

  it('never authenticates a missing password even if the dummy hash matches', async () => {
    const compare = jest.fn().mockResolvedValue(true);
    expect(await comparePassword(null, 'kisuno-synthetic-login-timing', { compare })).toBe(false);
    expect(await comparePassword({}, 'kisuno-synthetic-login-timing', { compare })).toBe(false);
  });

  it('uses the stored hash for both correct and incorrect existing passwords', async () => {
    const compare = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const user = { password: 'stored-bcrypt-hash' };

    expect(await comparePassword(user, 'correct-password', { compare })).toBe(true);
    expect(await comparePassword(user, 'incorrect-password', { compare })).toBe(false);
    expect(compare).toHaveBeenNthCalledWith(1, 'correct-password', 'stored-bcrypt-hash');
    expect(compare).toHaveBeenNthCalledWith(2, 'incorrect-password', 'stored-bcrypt-hash');
  });
});
