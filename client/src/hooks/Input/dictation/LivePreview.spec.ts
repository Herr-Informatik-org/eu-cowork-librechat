import LivePreview, { mergePreview } from './LivePreview';

class Recorder {
  static all: Recorder[] = [];
  static format = 'audio/webm';
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  timer?: ReturnType<typeof setInterval>;
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  start() {
    this.state = 'recording';
    this.timer = setInterval(
      () => this.ondataavailable?.({ data: new Blob(['audio-packet']) }),
      100,
    );
  }
  stop() {
    this.state = 'inactive';
    clearInterval(this.timer);
    this.ondataavailable?.({ data: new Blob(['last-packet']) });
    this.onstop?.();
  }
  constructor() {
    this.mimeType = Recorder.format + ';window=' + Recorder.all.length;
    Recorder.all.push(this);
  }
}
const trackStop = jest.fn();
const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
const advance = async (milliseconds: number) => {
  await jest.advanceTimersByTimeAsync(milliseconds);
};

beforeEach(() => {
  jest.useFakeTimers();
  Recorder.all = [];
  Recorder.format = 'audio/webm';
  trackStop.mockClear();
  Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: Recorder });
});
afterEach(() => {
  jest.useRealTimers();
});

it('joins overlapping windows without changing numerical punctuation', () => {
  expect(mergePreview('Treffen in Zürich.', 'Zürich, um 15:30 Uhr.')).toBe(
    'Treffen in Zürich. um 15:30 Uhr.',
  );
  expect(mergePreview('Betrag 1’234.50', 'Neue Rechnung 2’345.60')).toBe(
    'Betrag 1’234.50 Neue Rechnung 2’345.60',
  );
});
it('sends an early cumulative snapshot while the recorder is still running', async () => {
  const transcribe = jest.fn().mockResolvedValue('Guten Tag.');
  const onText = jest.fn();
  const preview = new LivePreview({ stream, transcribe, onText, onDelayed: jest.fn() });
  preview.start();
  await advance(1300);
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(onText).toHaveBeenCalledWith('Guten Tag.');
  expect(Recorder.all[0].state).toBe('recording');
  expect(trackStop).not.toHaveBeenCalled();
  preview.cancel();
});
it('revises the same window instead of duplicating its earlier partial text', async () => {
  const transcribe = jest
    .fn()
    .mockResolvedValueOnce('Heute ist')
    .mockResolvedValueOnce('Heute ist Freitag.');
  const onText = jest.fn();
  const preview = new LivePreview({ stream, transcribe, onText, onDelayed: jest.fn() });
  preview.start();
  await advance(2800);
  expect(onText).toHaveBeenLastCalledWith('Heute ist Freitag.');
  expect((transcribe.mock.calls[1][0] as Blob).size).toBeGreaterThan(
    (transcribe.mock.calls[0][0] as Blob).size,
  );
  preview.cancel();
});
it('bounds requests and discards queued or stale results after cancellation', async () => {
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
  await advance(24000);
  expect(transcribe).toHaveBeenCalledTimes(1);
  const signal = transcribe.mock.calls[0][1] as AbortSignal;
  preview.cancel();
  expect(signal.aborted).toBe(true);
  resolve('Ein verspätetes Ergebnis.');
  await advance(0);
  expect(onText).not.toHaveBeenCalled();
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(Recorder.all.every((value) => value.state === 'inactive')).toBe(true);
});
it('keeps the microphone running when recognition fails', async () => {
  const onDelayed = jest.fn();
  const preview = new LivePreview({
    stream,
    transcribe: jest.fn().mockRejectedValue(new Error('busy')),
    onText: jest.fn(),
    onDelayed,
  });
  preview.start();
  await advance(1400);
  expect(onDelayed).toHaveBeenCalledWith(true);
  expect(trackStop).not.toHaveBeenCalled();
  expect(Recorder.all[0].state).toBe('recording');
  preview.cancel();
});

it('prioritizes current audio over a completed older window when CPU recognition is slow', async () => {
  const finish: ((text: string) => void)[] = [];
  const transcribe = jest.fn(
    (_audio: Blob, _signal: AbortSignal) => new Promise<string>((resolve) => finish.push(resolve)),
  );
  const preview = new LivePreview({ stream, transcribe, onText: jest.fn(), onDelayed: jest.fn() });
  preview.start();
  await advance(13200);
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect((transcribe.mock.calls[0][0] as Blob).type).toContain('window=0');
  finish[0]('Vorheriger Text.');
  await advance(0);
  expect(transcribe).toHaveBeenCalledTimes(2);
  expect((transcribe.mock.calls[1][0] as Blob).type).toContain('window=1');
  preview.cancel();
  finish[1]('Aktueller Text.');
  await advance(0);
});

it('waits for complete short MP4 containers instead of sending undecodable intermediate data', async () => {
  Recorder.format = 'audio/mp4';
  const transcribe = jest.fn().mockResolvedValue('Guten Tag.');
  const preview = new LivePreview({ stream, transcribe, onText: jest.fn(), onDelayed: jest.fn() });
  preview.start();
  await advance(1400);
  expect(transcribe).not.toHaveBeenCalled();
  await advance(1200);
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect((transcribe.mock.calls[0][0] as Blob).type).toContain('mp4');
  preview.cancel();
});
