/** Join consecutive windows while allowing each window to revise its own provisional text. */
export function mergePreview(previous: string, next: string): string {
  const before = previous.trim().split(/\s+/).filter(Boolean);
  const after = next.trim().split(/\s+/).filter(Boolean);
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  for (let count = Math.min(32, before.length, after.length); count > 0; count--) {
    if (
      before
        .slice(-count)
        .every((value, index) => normalize(value) && normalize(value) === normalize(after[index]))
    )
      return [...before, ...after.slice(count)].join(' ');
  }
  return [...before, ...after].join(' ');
}

type Options = {
  stream: MediaStream;
  mimeType?: string;
  transcribe: (audio: Blob, signal: AbortSignal) => Promise<string>;
  onText: (text: string) => void;
  onDelayed: (delayed: boolean) => void;
  firstUpdateMs?: number;
  intervalMs?: number;
  windowMs?: number;
  overlapMs?: number;
};
type Snapshot = { window: number; audio: Blob };

export default class LivePreview {
  private cancelled = false;
  private nextWindow = 0;
  private recorders = new Set<MediaRecorder>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private request?: AbortController;
  private pending = new Map<number, Snapshot>();
  private results = new Map<number, string>();
  private prefix = '';
  private oldestWindow = 0;

  constructor(private options: Options) {}

  start() {
    this.record();
  }

  cancel() {
    this.cancelled = true;
    this.request?.abort();
    this.pending.clear();
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    for (const recorder of this.recorders) {
      if (recorder.state !== 'inactive') recorder.stop();
    }
    this.recorders.clear();
    // The caller owns the microphone and the uninterrupted final recorder.
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
      const window = this.nextWindow++;
      const recorder = new MediaRecorder(
        this.options.stream,
        this.options.mimeType ? { mimeType: this.options.mimeType } : undefined,
      );
      const chunks: Blob[] = [];
      let bytes = 0;
      let active = true;
      this.recorders.add(recorder);
      const publish = () => {
        if (this.cancelled || bytes > 2 * 1024 * 1024 || !chunks.length) return;
        this.enqueue({
          window,
          audio: new Blob(chunks, {
            type: recorder.mimeType || this.options.mimeType || 'audio/webm',
          }),
        });
      };
      recorder.ondataavailable = ({ data }) => {
        if (this.cancelled || !data.size) return;
        bytes += data.size;
        if (bytes <= 2 * 1024 * 1024) chunks.push(data);
      };
      recorder.onerror = () => this.options.onDelayed(true);
      recorder.onstop = () => {
        active = false;
        this.recorders.delete(recorder);
        publish();
      };
      recorder.start(100);
      const update = () => {
        if (!active) return;
        publish();
        this.later(update, this.options.intervalMs ?? 1500);
      };
      const progressive = !/mp4|m4a/.test(recorder.mimeType);
      if (progressive) this.later(update, this.options.firstUpdateMs ?? 1200);
      const length = this.options.windowMs ?? (progressive ? 10000 : 2500);
      const overlap = this.options.overlapMs ?? (progressive ? 2000 : 500);
      this.later(() => this.record(), length - overlap);
      this.later(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, length);
    } catch {
      this.options.onDelayed(true);
    }
  }

  private enqueue(snapshot: Snapshot) {
    if (snapshot.window < this.oldestWindow) return;
    if (this.request) {
      this.pending.set(snapshot.window, snapshot);
      // Retain the newest version of each of at most two overlapping windows.
      if (this.pending.size > 2) {
        this.pending.delete(this.pending.keys().next().value as number);
        this.options.onDelayed(true);
      }
      return;
    }
    void this.send(snapshot);
  }

  private async send(snapshot: Snapshot) {
    const request = new AbortController();
    this.request = request;
    try {
      const text = await this.options.transcribe(snapshot.audio, request.signal);
      if (!this.cancelled && !request.signal.aborted) {
        this.results.set(snapshot.window, text);
        while (this.results.size > 3) {
          const oldest = Math.min(...this.results.keys());
          this.prefix = mergePreview(this.prefix, this.results.get(oldest) || '');
          this.results.delete(oldest);
          this.oldestWindow = oldest + 1;
        }
        let preview = this.prefix;
        for (const window of [...this.results.keys()].sort((a, b) => a - b))
          preview = mergePreview(preview, this.results.get(window) || '');
        this.options.onText(preview);
        this.options.onDelayed(false);
      }
    } catch {
      if (!this.cancelled) this.options.onDelayed(true);
    } finally {
      this.request = undefined;
      const latestWindow = Math.max(...this.pending.keys());
      const next = this.pending.get(latestWindow);
      this.pending.clear();
      if (next && !this.cancelled) this.enqueue(next);
    }
  }
}
