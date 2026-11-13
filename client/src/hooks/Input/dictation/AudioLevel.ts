/** Map microphone RMS to a readable meter without changing the recorded audio. */
export function microphoneLevel(samples: Float32Array): number {
  if (!samples.length) return 0;
  const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  if (!Number.isFinite(rms) || rms < 0.0005) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 42));
}
