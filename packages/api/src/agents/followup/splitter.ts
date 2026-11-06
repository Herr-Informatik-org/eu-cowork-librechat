export const NEXT_STEPS_START = '<naechste_schritte>';
export const NEXT_STEPS_END = '</naechste_schritte>';

/** Upper bound of retained block text; the rest is dropped (the block holds at most a few lines). */
const MAX_BLOCK_CHARS = 2000;

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/** Length of the longest suffix of `text` that is a proper prefix of `marker`. */
export function partialMarkerAtEnd(text: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, text.length); n > 0; n--) {
    if (marker.startsWith(text.slice(text.length - n))) {
      return n;
    }
  }
  return 0;
}

interface LineState {
  /** Inside a fenced code block (``` or ~~~): markers there are content, not a block. */
  inFence: boolean;
  /** Fence characters that opened the current code block. */
  fence: string;
  /** Text of the current, not yet terminated line (only its start matters). */
  line: string;
  /** Last released character; a backtick right before a marker means inline code. */
  prev: string;
}

const LINE_HEAD_CHARS = 16;

function advance(state: LineState, text: string): LineState {
  let { inFence, fence, line } = state;
  let start = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', start)) {
    const full = (line + text.slice(start, i)).slice(0, LINE_HEAD_CHARS);
    const match = FENCE_LINE.exec(full);
    if (match && !inFence) {
      inFence = true;
      fence = match[1];
    } else if (match && inFence && match[1][0] === fence[0] && match[1].length >= fence.length) {
      inFence = false;
      fence = '';
    }
    line = '';
    start = i + 1;
  }
  line = (line + text.slice(start)).slice(0, LINE_HEAD_CHARS);
  const prev = text.length > 0 ? text[text.length - 1] : state.prev;
  return { inFence, fence, line, prev };
}

/** Index of the first start marker outside code (fenced blocks, inline backticks), or -1. */
function findStart(state: LineState, text: string): number {
  let scan = state;
  let from = 0;
  for (let i = text.indexOf(NEXT_STEPS_START); i >= 0; i = text.indexOf(NEXT_STEPS_START, i + 1)) {
    scan = advance(scan, text.slice(from, i));
    from = i;
    if (!scan.inFence && scan.prev !== '`') {
      return i;
    }
  }
  return -1;
}

/**
 * Cuts the `<naechste_schritte>` block out of a streamed answer.
 *
 * Only what can still become the start marker (a `<…` tail) and trailing
 * whitespace is held back; everything else is released immediately, so no part
 * of a block ever reaches the reader, and whitespace before a block disappears
 * with it. Markers inside fenced code or inline code stay visible text.
 */
export class BlockSplitter {
  private held = '';
  private inside = false;
  private content = '';
  private complete = false;
  private found = false;
  private state: LineState = { inFence: false, fence: '', line: '', prev: '\n' };

  /** Takes one chunk and returns its visible part (possibly empty). */
  push(chunk: string): string {
    let rest = this.held + chunk;
    this.held = '';
    let out = '';
    for (;;) {
      if (this.inside) {
        const end = rest.indexOf(NEXT_STEPS_END);
        if (end >= 0) {
          this.keep(rest.slice(0, end));
          this.inside = false;
          this.complete = true;
          this.found = true;
          rest = rest.slice(end + NEXT_STEPS_END.length);
          this.state = { inFence: false, fence: '', line: '', prev: '>' };
          continue;
        }
        const cut = partialMarkerAtEnd(rest, NEXT_STEPS_END);
        this.keep(rest.slice(0, rest.length - cut));
        this.held = rest.slice(rest.length - cut);
        return out;
      }
      const start = findStart(this.state, rest);
      if (start >= 0) {
        const before = rest.slice(0, start);
        this.state = advance(this.state, before);
        out += before.trimEnd();
        this.inside = true;
        this.complete = false;
        this.content = '';
        rest = rest.slice(start + NEXT_STEPS_START.length);
        continue;
      }
      const tail = advance(this.state, rest);
      const cut = tail.inFence ? 0 : partialMarkerAtEnd(rest, NEXT_STEPS_START);
      const text = rest.slice(0, rest.length - cut);
      const visible = text.trimEnd();
      this.held = text.slice(visible.length) + rest.slice(rest.length - cut);
      this.state = advance(this.state, visible);
      return out + visible;
    }
  }

  /**
   * Text held back so far that will not become a block: a marker-like tail
   * without its trailing whitespace. Releasing it is safe when the step ends.
   */
  release(): string {
    if (this.inside) {
      return '';
    }
    const visible = this.held.trimEnd();
    this.held = '';
    this.state = advance(this.state, visible);
    return visible;
  }

  /** End of the answer: an unterminated block stays hidden but counts as incomplete. */
  finish(): string {
    if (this.inside) {
      this.inside = false;
      this.complete = false;
      this.found = true;
      this.content = '';
      this.held = '';
      return '';
    }
    return this.release();
  }

  /** Content of the last complete block, or null when none was closed. */
  block(): string | null {
    return this.complete ? this.content : null;
  }

  /** Whether a block started at all (complete or not). */
  sawBlock(): boolean {
    return this.found || this.inside;
  }

  private keep(text: string): void {
    const room = MAX_BLOCK_CHARS - this.content.length;
    if (room > 0) {
      this.content += text.slice(0, room);
    }
  }
}
