import { consumeMailChat, prepareMailChat } from '../handoff';

describe('mail chat handoff', () => {
  beforeEach(() => {
    Object.defineProperty(global.crypto, 'randomUUID', {
      value: () => '00000000-0000-4000-8000-000000000001',
      configurable: true,
    });
  });
  it('carries content once in memory for the same authenticated owner', () => {
    const token = prepareMailChat('owner', 'Private mail content');
    expect(token).not.toContain('Private');
    expect(consumeMailChat('owner', token)).toBe('Private mail content');
    expect(consumeMailChat('owner', token)).toBeNull();
  });
  it('drops a handoff after an account switch', () => {
    const token = prepareMailChat('owner', 'Private mail content');
    expect(consumeMailChat('other', token)).toBeNull();
    expect(consumeMailChat('owner', token)).toBeNull();
  });
  it('does not accept an unrecognized URL token', () => {
    prepareMailChat('owner', 'Private mail content');
    expect(consumeMailChat('owner', 'untrusted')).toBeNull();
  });
  it('expires without writing mail content to browser storage', () => {
    const storage = jest.spyOn(Storage.prototype, 'setItem');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const token = prepareMailChat('owner', 'Private mail content');
    clock.mockReturnValue(62_000);
    expect(consumeMailChat('owner', token)).toBeNull();
    expect(storage).not.toHaveBeenCalled();
    clock.mockRestore();
  });
});
