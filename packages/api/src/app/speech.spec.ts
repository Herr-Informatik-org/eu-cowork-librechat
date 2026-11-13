import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { getSpeechConfiguration, respondToSpeech, whisperRecordingLimit } from './speech';

const key = crypto.randomBytes(32).toString('hex');
const env = { WHISPER_STT_ENABLED: 'true', WHISPER_STT_API_KEY: key };

describe('managed Whisper routing', () => {
  it('preserves existing speech settings when the feature is disabled', () => {
    const speech = { stt: { openai: { apiKey: '${EXISTING}', model: 'existing' } } };
    expect(getSpeechConfiguration(speech, {})).toBe(speech);
  });
  it('selects exactly the private Whisper endpoint and preserves TTS', () => {
    const speech = getSpeechConfiguration({ speechTab: { textToSpeech: false } }, env);
    expect(speech?.stt).toEqual({
      openai: {
        url: 'http://kisuno-whisper:9000/v1/audio/transcriptions',
        apiKey: '${WHISPER_STT_API_KEY}',
        model: 'whisper-large-v3-turbo',
      },
    });
    expect(speech?.speechTab?.textToSpeech).toBe(false);
    expect(JSON.stringify(speech)).not.toContain(key);
  });
  it('refuses missing keys and unencrypted public endpoints', () => {
    expect(() => getSpeechConfiguration(undefined, { WHISPER_STT_ENABLED: 'true' })).toThrow();
    expect(() =>
      getSpeechConfiguration(undefined, {
        ...env,
        WHISPER_STT_URL: 'http://example.com/transcribe',
      }),
    ).toThrow();
    expect(() =>
      getSpeechConfiguration(undefined, {
        ...env,
        WHISPER_STT_URL: 'https://user:pass@example.com',
      }),
    ).toThrow();
    expect(() =>
      getSpeechConfiguration(undefined, {
        ...env,
        WHISPER_STT_URL: 'https://speech.example.com/v1/audio/transcriptions',
      }),
    ).not.toThrow();
  });
  it.each(['0', '601', 'NaN', '1.5'])('rejects unsafe recording limit %s', (value) => {
    expect(() => whisperRecordingLimit({ WHISPER_STT_MAX_SECONDS: value })).toThrow();
  });
});

describe('native speech streaming', () => {
  let server: http.Server;
  let url: string;
  let cleanup: jest.Mock;
  let operation: (signal: AbortSignal) => Promise<string>;
  beforeEach(async () => {
    cleanup = jest.fn(async () => undefined);
    operation = async () => 'Grüezi. Der Betrag ist 1’234.50 Franken.';
    const app = express();
    app.post('/speech', (req, res) => {
      void respondToSpeech(req, res, (signal) => operation(signal), cleanup, { heartbeatMs: 10 });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Testserver fehlt.');
    url = `http://127.0.0.1:${address.port}/speech`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('returns legacy JSON unchanged, including empty speech', async () => {
    operation = async () => '';
    const response = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
    expect(await response.json()).toEqual({ text: '' });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it('sends headers and heartbeats before the transcription completes', async () => {
    let finish!: (text: string) => void;
    operation = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const response = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'text/event-stream, application/json' },
    });
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('keepalive');
    finish('Fertig.');
    let text = '';
    while (true) {
      const chunk = await reader.read();
      text += new TextDecoder().decode(chunk.value);
      if (chunk.done) break;
    }
    expect(text).toContain('event: transcription');
    expect(text).toContain('Fertig.');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it('does not expose provider errors or secrets and always cleans uploads', async () => {
    operation = async () => {
      throw Object.assign(new Error(key), { response: { status: 503 } });
    };
    const response = await fetch(url, { method: 'POST', headers: { Accept: 'text/event-stream' } });
    const text = await response.text();
    expect(text).toContain('stt_busy');
    expect(text).not.toContain(key);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it('aborts the provider request when the browser disconnects', async () => {
    let aborted!: () => void;
    const ended = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    operation = (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted();
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    const response = await fetch(url, { method: 'POST', headers: { Accept: 'text/event-stream' } });
    await response.body!.cancel();
    await ended;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
