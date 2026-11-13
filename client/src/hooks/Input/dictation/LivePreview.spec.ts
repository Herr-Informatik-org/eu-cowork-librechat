import LivePreview, { mergePreview } from './LivePreview';

class Recorder {
  static all: Recorder[] = [];
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['complete-segment']) });
    this.onstop?.();
  }
  constructor() {
    Recorder.all.push(this);
  }
}
const trackStop = jest.fn();
const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  jest.useFakeTimers();
  Recorder.all = [];
  trackStop.mockClear();
  Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: Recorder });
});
afterEach(() => {
  jest.useRealTimers();
});

it('joins overlapping words without losing Swiss names or numerical punctuation', () => {
  expect(mergePreview('Treffen in Zürich.', 'Zürich, um 15:30 Uhr.')).toBe(
    'Treffen in Zürich. um 15:30 Uhr.',
  );
  expect(mergePreview('Betrag 1’234.50', 'Neue Rechnung 2’345.60')).toBe(
    'Betrag 1’234.50 Neue Rechnung 2’345.60',
  );
});
it('produces complete overlapping segments while leaving the shared microphone running', async () => {
  const transcribe = jest.fn().mockResolvedValue('Guten Tag.');
  const onText = jest.fn();
  const preview = new LivePreview({ stream, transcribe, onText, onDelayed: jest.fn() });
  preview.start();
  jest.advanceTimersByTime(5500);
  expect(Recorder.all.filter((value) => value.state === 'recording')).toHaveLength(2);
  jest.advanceTimersByTime(500);
  await flush();
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(onText).toHaveBeenCalledWith('Guten Tag.');
  expect(trackStop).not.toHaveBeenCalled();
  preview.cancel();
});
it('bounds preview requests and discards queued or stale results after cancellation', async () => {
  let resolve!: (text: string) => void;
  const transcribe = jest.fn(
    (_audio: Blob, _signal: AbortSignal) =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const onText = jest.fn();
  const preview = new LivePreview({ stream, transcribe, onText, onDelayed: jest.fn() });
  preview.start();
  jest.advanceTimersByTime(24000);
  await flush();
  expect(transcribe).toHaveBeenCalledTimes(1);
  const signal = transcribe.mock.calls[0][1] as AbortSignal;
  preview.cancel();
  expect(signal.aborted).toBe(true);
  resolve('Ein verspätetes Ergebnis.');
  await flush();
  expect(onText).not.toHaveBeenCalled();
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(Recorder.all.every((value) => value.state === 'inactive')).toBe(true);
});
it('degrades a failed preview without ending microphone capture', async () => {
  const onDelayed = jest.fn();
  const preview = new LivePreview({
    stream,
    transcribe: jest.fn().mockRejectedValue(new Error('busy')),
    onText: jest.fn(),
    onDelayed,
  });
  preview.start();
  jest.advanceTimersByTime(6000);
  await flush();
  expect(onDelayed).toHaveBeenCalledWith(true);
  expect(trackStop).not.toHaveBeenCalled();
  expect(Recorder.all.some((value) => value.state === 'recording')).toBe(true);
  preview.cancel();
});
