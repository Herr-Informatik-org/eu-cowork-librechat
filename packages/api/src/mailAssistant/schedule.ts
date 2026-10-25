import { z } from 'zod';
import { MAIL_CONSENT_VERSION } from './types';
import type { MailSettings } from './types';

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const mailSettingsSchema: z.ZodType<MailSettings> = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(['manual', 'scheduled']),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    startTime: time,
    endTime: time,
    timeZone: z
      .string()
      .min(1)
      .max(80)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value }).format();
          return true;
        } catch {
          return false;
        }
      }),
    intervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
    consentVersion: z.literal(MAIL_CONSENT_VERSION).optional(),
  })
  .strict()
  .refine((value) => value.startTime < value.endTime, 'Die Endzeit muss nach der Startzeit liegen.')
  .refine(
    (value) => !value.enabled || value.consentVersion === MAIL_CONSENT_VERSION,
    'Bitte bestätige die persönliche Freigabe.',
  );

export function defaultMailSettings(): MailSettings {
  return {
    enabled: false,
    mode: 'manual',
    weekdays: [1, 2, 3, 4, 5],
    startTime: '08:00',
    endTime: '17:00',
    timeZone: 'Europe/Zurich',
    intervalMinutes: 30,
  };
}

/** Convert the instant in the configured zone; never infer working hours from server time. */
export function insideMailWindow(settings: MailSettings, now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (key: string) => parts.find((item) => item.type === key)?.value ?? '';
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(part('weekday')) + 1;
  const clock = `${part('hour')}:${part('minute')}`;
  return settings.weekdays.includes(day) && clock >= settings.startTime && clock < settings.endTime;
}

export function nextMailRun(settings: MailSettings, after: Date): string | undefined {
  if (!settings.enabled || settings.mode !== 'scheduled') return undefined;
  const first = Math.ceil(after.getTime() / 60_000) * 60_000;
  for (let i = 0; i <= 8 * 24 * 60; i++) {
    const candidate = new Date(first + i * 60_000);
    if (insideMailWindow(settings, candidate)) return candidate.toISOString();
  }
  return undefined;
}
