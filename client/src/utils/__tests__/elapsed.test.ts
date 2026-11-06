import { formatElapsed } from '../elapsed';

describe('formatElapsed', () => {
  it('counts seconds below a minute', () => {
    expect(formatElapsed(0)).toBe('0 s');
    expect(formatElapsed(12_900)).toBe('12 s');
    expect(formatElapsed(59_999)).toBe('59 s');
  });

  it('switches to minutes and hours', () => {
    expect(formatElapsed(65_000)).toBe('1 min 5 s');
    expect(formatElapsed(3_725_000)).toBe('1 h 2 min');
  });

  it('never shows negative or invalid durations', () => {
    expect(formatElapsed(-500)).toBe('0 s');
    expect(formatElapsed(Number.NaN)).toBe('0 s');
  });
});
