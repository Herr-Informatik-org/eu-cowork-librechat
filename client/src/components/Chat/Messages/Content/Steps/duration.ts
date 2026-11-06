/**
 * Step durations measured in this browser: from the first render of a running
 * step to the render where it finished. A step that was already finished when
 * first seen (reload, shared view) has no duration, so nothing is claimed.
 */
const MAX_TRACKED = 500;
const startedAt = new Map<string, number>();
const durations = new Map<string, number>();

function remember(map: Map<string, number>, id: string, value: number): void {
  map.set(id, value);
  if (map.size > MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest != null) {
      map.delete(oldest);
    }
  }
}

/** Idempotent per render; returns milliseconds once a tracked step has finished. */
export function trackStepDuration(
  id: string | undefined,
  done: boolean,
  now: () => number = Date.now,
): number | undefined {
  if (id == null || id === '') {
    return undefined;
  }
  const known = durations.get(id);
  if (known != null) {
    return known;
  }
  if (!done) {
    if (!startedAt.has(id)) {
      remember(startedAt, id, now());
    }
    return undefined;
  }
  const start = startedAt.get(id);
  if (start == null) {
    return undefined;
  }
  startedAt.delete(id);
  const elapsed = Math.max(0, now() - start);
  remember(durations, id, elapsed);
  return elapsed;
}

/** Test helper. */
export function resetStepDurations(): void {
  startedAt.clear();
  durations.clear();
}
