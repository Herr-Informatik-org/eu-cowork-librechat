type MailHandoff = { owner: string; token: string; text: string; expires: number };
let pending: MailHandoff | null = null;

export function prepareMailChat(owner: string, text: string): string {
  const token = crypto.randomUUID();
  pending = { owner, token, text, expires: Date.now() + 60_000 };
  return token;
}

export function consumeMailChat(owner: string, token: string): string | null {
  const entry = pending;
  pending = null;
  if (!entry || entry.owner !== owner || entry.token !== token || entry.expires < Date.now())
    return null;
  return entry.text;
}
