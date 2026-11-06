/** True for a wheel gesture that moves the view towards earlier messages. */
export function isUpwardWheel(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    'deltaY' in event &&
    typeof event.deltaY === 'number' &&
    event.deltaY < 0
  );
}
