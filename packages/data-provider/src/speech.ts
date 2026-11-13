import type { SpeechToTextResponse } from './types/files';

function parseTranscript(value: string): SpeechToTextResponse {
  const parsed: SpeechToTextResponse = JSON.parse(value);
  if (!parsed || typeof parsed.text !== 'string')
    throw new Error('Die Sprachantwort ist ungültig.');
  return {
    text: parsed.text,
    ...(typeof parsed.language === 'string' && /^[a-z]{2,3}$/.test(parsed.language)
      ? { language: parsed.language }
      : {}),
  };
}

export async function readSpeechResponse(response: Response): Promise<SpeechToTextResponse> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Der Sprachdienst ist nicht verfügbar.');
  }
  const type = response.headers.get('content-type')?.split(';')[0].trim();
  if (!['application/json', 'text/event-stream'].includes(type || '') || !response.body) {
    await response.body?.cancel();
    throw new Error('Die Sprachantwort wurde durch einen Proxy oder die WAF ersetzt.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let received = 0;
  let result: SpeechToTextResponse | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      received += value?.byteLength ?? 0;
      if (received > 131072) throw new Error('Die Sprachantwort ist zu gross.');
      pending += decoder.decode(value, { stream: !done });
      if (type === 'application/json') {
        if (done) return parseTranscript(pending);
        continue;
      }
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() || '';
      for (const frame of frames) {
        const rows = frame.split(/\r?\n/);
        const event = rows
          .find((row) => row.startsWith('event:'))
          ?.slice(6)
          .trim();
        const data = rows
          .filter((row) => row.startsWith('data:'))
          .map((row) => row.slice(5).trimStart())
          .join('\n');
        if (event === 'error')
          throw new Error('Der Sprachdienst konnte das Diktat nicht verarbeiten.');
        if (event === 'transcription') {
          if (result) throw new Error('Die Sprachantwort ist mehrdeutig.');
          result = parseTranscript(data);
        }
      }
      if (done) break;
    }
    if (!result) throw new Error('Die Sprachantwort wurde unterbrochen. Bitte erneut versuchen.');
    return result;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
