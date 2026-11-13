import { microphoneLevel } from './AudioLevel';

it('keeps digital silence and low noise quiet', () => {
  expect(microphoneLevel(new Float32Array(512))).toBe(0);
  expect(microphoneLevel(new Float32Array(512).fill(0.0001))).toBe(0);
});
it('makes quiet microphone speech visible without amplifying the actual recording', () => {
  const samples = new Float32Array(512).fill(0.004);
  expect(microphoneLevel(samples)).toBeGreaterThan(0.25);
  expect(samples[0]).toBeCloseTo(0.004);
});
it('increases monotonically and bounds loud signals', () => {
  const levels = [0.002, 0.01, 0.05, 0.5].map((value) =>
    microphoneLevel(new Float32Array(512).fill(value)),
  );
  expect(levels).toEqual([...levels].sort((a, b) => a - b));
  expect(levels[3]).toBe(1);
  expect(microphoneLevel(new Float32Array([NaN]))).toBe(0);
});
