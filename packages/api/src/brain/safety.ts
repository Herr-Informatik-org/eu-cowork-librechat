export function containsBrainCredential(text: string): boolean {
  return /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{16,}|Bearer\s+[a-zA-Z0-9._~+/-]{16,})|\b(?:password|passwort)\s*(?:[:=]|is\b|ist\b|lautet\b)\s*\S{3,}|\b(?:api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*[a-zA-Z0-9_+/-]{12,}/i.test(
    text,
  );
}

export function brainLearningTimeoutMs(): number {
  const configured = Number(process.env.BRAIN_LEARNING_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 30000
    ? Math.min(Math.round(configured), 300000)
    : 120000;
}
