/**
 * Compact elapsed-time label for live activity rows: `0 s` … `59 s`, then `1 min 5 s`,
 * then `1 h 2 min`. Seconds are information rather than motion, so the label keeps
 * counting even when reduced motion is requested.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ${seconds % 60} s`;
  }
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
