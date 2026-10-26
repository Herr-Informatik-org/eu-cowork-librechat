import {
  defaultMailSettings,
  insideMailWindow,
  mailSettingsSchema,
  nextMailRun,
  mailHistoryStart,
} from './schedule';
import { createMailCodec } from './privateData';

describe('personal mail privacy and working windows', () => {
  const settings = {
    ...defaultMailSettings(),
    enabled: true,
    mode: 'scheduled' as const,
    consentVersion: '2026-10-25',
  };
  test('requires explicit consent and rejects target mailbox/user input', () => {
    expect(defaultMailSettings().enabled).toBe(false);
    expect(mailSettingsSchema.safeParse({ ...settings, consentVersion: undefined }).success).toBe(
      false,
    );
    expect(mailSettingsSchema.safeParse({ ...settings, ownerId: 'other' }).success).toBe(false);
    expect(
      mailSettingsSchema.safeParse({ ...settings, mailbox: 'other@example.com' }).success,
    ).toBe(false);
    expect(mailSettingsSchema.safeParse(settings).success).toBe(true);
  });
  test('history defaults off and accepts only explicit valid ranges', () => {
    expect(defaultMailSettings().history).toEqual({ mode: 'off' });
    expect(mailSettingsSchema.parse({ ...settings, history: undefined }).history).toEqual({
      mode: 'off',
    });
    for (const history of [
      { mode: 'since' },
      { mode: 'since', from: '2026-02-30' },
      { mode: 'since', from: '0000-01-01' },
      { mode: 'all', from: '2026-01-01' },
      { mode: 'all', mailbox: 'other' },
    ])
      expect(mailSettingsSchema.safeParse({ ...settings, history }).success).toBe(false);
    expect(mailSettingsSchema.safeParse({ ...settings, history: { mode: 'all' } }).success).toBe(
      true,
    );
  });
  test.each([
    ['2026-03-29', '2026-03-28T23:00:00.000Z'],
    ['2026-03-30', '2026-03-29T22:00:00.000Z'],
    ['2026-10-25', '2026-10-24T22:00:00.000Z'],
    ['2026-10-26', '2026-10-25T23:00:00.000Z'],
  ])('historical date %s starts at midnight in Zurich (%s)', (date, expected) => {
    expect(mailHistoryStart(date, 'Europe/Zurich')).toBe(expected);
  });
  test.each(['Bad/Zone', '', 'Europe/Zurich<script>'])('rejects invalid zone %s', (timeZone) => {
    expect(mailSettingsSchema.safeParse({ ...settings, timeZone }).success).toBe(false);
  });
  test('rejects overnight and zero working windows', () => {
    expect(
      mailSettingsSchema.safeParse({ ...settings, startTime: '18:00', endTime: '08:00' }).success,
    ).toBe(false);
    expect(
      mailSettingsSchema.safeParse({ ...settings, startTime: '08:00', endTime: '08:00' }).success,
    ).toBe(false);
  });
  test('uses Zurich DST, includes start and excludes end and weekend', () => {
    expect(insideMailWindow(settings, new Date('2026-10-23T06:00:00Z'))).toBe(true);
    expect(insideMailWindow(settings, new Date('2026-10-23T15:00:00Z'))).toBe(false);
    expect(insideMailWindow(settings, new Date('2026-10-25T09:00:00Z'))).toBe(false);
    expect(insideMailWindow(settings, new Date('2026-10-26T06:59:00Z'))).toBe(false);
    expect(insideMailWindow(settings, new Date('2026-10-26T07:00:00Z'))).toBe(true);
    expect(nextMailRun(settings, new Date('2026-10-23T15:00:00Z'))).toBe(
      '2026-10-26T07:00:00.000Z',
    );
  });
  test('does not schedule manual or disabled accounts', () => {
    expect(nextMailRun(defaultMailSettings(), new Date())).toBeUndefined();
    expect(nextMailRun({ ...settings, mode: 'manual' }, new Date())).toBeUndefined();
  });
  test('authenticated ciphertext cannot cross users, purposes or be modified', () => {
    const codec = createMailCodec('1'.repeat(64));
    const encrypted = codec.seal('alice', 'result', { secret: 'sensitive-content' });
    expect(encrypted).not.toContain('sensitive-content');
    expect(codec.open('alice', 'result', encrypted)).toEqual({ secret: 'sensitive-content' });
    expect(() => codec.open('bob', 'result', encrypted)).toThrow();
    expect(() => codec.open('alice', 'token', encrypted)).toThrow();
    const parts = encrypted.split('.');
    parts[2] = Buffer.alloc(20, 7).toString('base64');
    expect(() => codec.open('alice', 'result', parts.join('.'))).toThrow();
    expect(() => createMailCodec('bad')).toThrow();
  });
});
