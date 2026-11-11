import type { Request, Response } from 'express';
import { hashToken, logger } from '@librechat/data-schemas';

interface InvitationDependencies {
  findToken: (query: { token: string }) => Promise<unknown>;
  findUser: (query: { email: string }) => Promise<unknown>;
}

interface InvitationRecord {
  email?: unknown;
  name?: unknown;
  type?: unknown;
  identifier?: unknown;
  expiresAt?: unknown;
}

export function isRegistrationInvitation(
  record: unknown,
  now: number = Date.now(),
): record is InvitationRecord & { email: string } {
  if (!record || typeof record !== 'object') return false;
  const invitation = record as InvitationRecord;
  if (
    (invitation.type != null && invitation.type !== 'invite') ||
    invitation.identifier != null ||
    typeof invitation.email !== 'string' ||
    invitation.email.length > 120 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invitation.email)
  )
    return false;
  const expiresAt = new Date(invitation.expiresAt as string | number | Date).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/** Resolve only unexpired invitations without consuming their one-time token. */
export async function invitationDetails(
  token: unknown,
  dependencies: InvitationDependencies,
  now: number = Date.now(),
): Promise<{ email: string; name?: string } | null> {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    return null;
  }
  const record = (await dependencies.findToken({
    token: await hashToken(decoded),
  })) as InvitationRecord | null;
  if (!isRegistrationInvitation(record, now)) return null;
  const email = record.email.trim().toLowerCase();
  if (await dependencies.findUser({ email })) return null;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  return { email, ...(name.length >= 3 && name.length <= 80 ? { name } : {}) };
}

export async function invitationDetailsController(
  req: Request,
  res: Response,
  dependencies: InvitationDependencies,
): Promise<Response> {
  res.set('Cache-Control', 'no-store');
  try {
    const details = await invitationDetails(req.body?.token, dependencies);
    if (!details) {
      return res.status(400).json({ message: 'Diese Einladung ist ungültig oder abgelaufen.' });
    }
    return res.json(details);
  } catch {
    // Do not log invitation tokens, email addresses or database error contents.
    logger.error('[invitationDetails] Die Einladung konnte nicht geprüft werden.');
    return res.status(503).json({
      message: 'Die Einladung konnte nicht geladen werden. Bitte versuchen Sie es erneut.',
    });
  }
}
