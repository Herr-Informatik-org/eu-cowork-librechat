/** Complete short recordings share the microphone with the untouched final recording. */
export function mergePreview(previous: string, next: string): string {
  const before = previous.trim().split(/\s+/).filter(Boolean);
  const after = next.trim().split(/\s+/).filter(Boolean);
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  for (let count = Math.min(16, before.length, after.length); count > 0; count--) {
    if (
      before
        .slice(-count)
        .every((value, index) => normalize(value) && normalize(value) === normalize(after[index]))
    ) {
      return [...before, ...after.slice(count)].join(' ');
    }
  }
  return [...before, ...after].join(' ');
}

type Options = {
  stream: MediaStream;
  mimeType?: string;
  transcribe: (audio: Blob, signal: AbortSignal) => Promise<string>;
  onText: (text: string) => void;
  onDelayed: (delayed: boolean) => void;
  intervalMs?: number;
  overlapMs?: number;
};

export default class LivePreview {
  private cancelled = false;
  private text = '';
  private recorders = new Set<MediaRecorder>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private request?: AbortController;
  private pending?: Blob;

  constructor(private options: Options) {}

  start() {
    this.record();
  }

  cancel() {
    this.cancelled = true;
    this.request?.abort();
    this.pending = undefined;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    for (const recorder of this.recorders) {
      if (recorder.state !== 'inactive') recorder.stop();
    }
    this.recorders.clear();
    // The caller owns the shared microphone and the uninterrupted final recorder.
  }

  private later(callback: () => void, milliseconds: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.cancelled) callback();
    }, milliseconds);
    this.timers.add(timer);
  }

  private record() {
    if (this.cancelled) return;
    try {
      const recorder = new MediaRecorder(
        this.options.stream,
        this.options.mimeType ? { mimeType: this.options.mimeType } : undefined,
      );
      const chunks: Blob[] = [];
      let bytes = 0;
      this.recorders.add(recorder);
      recorder.ondataavailable = ({ data }) => {
        if (this.cancelled || !data.size) return;
        bytes += data.size;
        if (bytes <= 2 * 1024 * 1024) chunks.push(data);
      };
      recorder.onerror = () => {
        this.options.onDelayed(true);
      };
      recorder.onstop = () => {
        this.recorders.delete(recorder);
        if (this.cancelled || bytes > 2 * 1024 * 1024 || !chunks.length) return;
        this.enqueue(
          new Blob(chunks, { type: recorder.mimeType || this.options.mimeType || 'audio/webm' }),
        );
      };
      recorder.start(250);
      const interval = this.options.intervalMs ?? 6000;
      this.later(() => this.record(), interval - (this.options.overlapMs ?? 500));
      this.later(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, interval);
    } catch {
      this.options.onDelayed(true);
    }
  }

  private enqueue(audio: Blob) {
    if (this.request) {
      if (this.pending) this.options.onDelayed(true);
      this.pending = audio;
      return;
    }
    void this.send(audio);
  }

  private async send(audio: Blob) {
    const request = new AbortController();
    this.request = request;
    try {
      const next = await this.options.transcribe(audio, request.signal);
      if (!this.cancelled && !request.signal.aborted) {
        this.text = mergePreview(this.text, next);
        this.options.onText(this.text);
        this.options.onDelayed(false);
      }
    } catch {
      if (!this.cancelled) this.options.onDelayed(true);
    } finally {
      this.request = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (pending && !this.cancelled) this.enqueue(pending);
    }
  }
}
