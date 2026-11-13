import type { Request, Response } from 'express';
import type { TCustomConfig, SpeechToTextResponse } from 'librechat-data-provider';

export function managedWhisperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WHISPER_STT_ENABLED === 'true';
}

export function whisperRecordingLimit(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = Number(env.WHISPER_STT_MAX_SECONDS || 120);
  if (!Number.isInteger(seconds) || seconds < 15 || seconds > 600) {
    throw new Error('Die erlaubte Diktierdauer ist ungültig.');
  }
  return seconds;
}

export function getSpeechConfiguration(
  speech: TCustomConfig['speech'],
  env: NodeJS.ProcessEnv = process.env,
): TCustomConfig['speech'] {
  if (!managedWhisperEnabled(env)) return speech;
  if (!env.WHISPER_STT_API_KEY || env.WHISPER_STT_API_KEY.length < 32) {
    throw new Error('Der interne Schlüssel für die Spracherkennung fehlt.');
  }
  whisperRecordingLimit(env);
  const url = new URL(env.WHISPER_STT_URL || 'http://kisuno-whisper:9000/v1/audio/transcriptions');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Die Adresse der Spracherkennung ist ungültig.');
  }
  if (
    url.protocol === 'http:' &&
    !/^(kisuno-whisper|localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
      url.hostname,
    )
  ) {
    throw new Error('Die entfernte Spracherkennung benötigt HTTPS.');
  }
  return {
    ...speech,
    stt: {
      openai: {
        url: url.toString(),
        apiKey: '${WHISPER_STT_API_KEY}',
        model: 'whisper-large-v3-turbo',
      },
    },
    speechTab: {
      ...speech?.speechTab,
      speechToText: { engineSTT: 'external', autoTranscribeAudio: false, autoSendText: -1 },
    },
  };
}

function errorStatus(error: object) {
  if (
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'status' in error.response
  ) {
    if (error.response.status === 429 || error.response.status === 503) return 503;
    if (error.response.status === 413) return 413;
  }
  return 502;
}

/** Keeps the native authenticated request open and counted by release draining. */
export async function respondToSpeech(
  req: Request,
  res: Response,
  operation: (signal: AbortSignal) => Promise<string | SpeechToTextResponse>,
  cleanup: () => Promise<void>,
  options: { heartbeatMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const stream = req.headers.accept
    ?.split(',')
    .some((part) => part.split(';')[0].trim() === 'text/event-stream');
  const controller = new AbortController();
  const disconnected = () => controller.abort();
  res.once('close', disconnected);
  const deadline = setTimeout(disconnected, options.timeoutMs ?? 720000);
  deadline.unref();
  let heartbeat: NodeJS.Timeout | undefined;
  const write = (
    event: string,
    value: SpeechToTextResponse | { code: string; message: string },
  ) => {
    if (!res.destroyed && !res.writableEnded)
      res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      const ping = () => {
        if (res.destroyed || res.writableEnded) return;
        res.write(': keepalive\n\n');
        if ('flush' in res && typeof res.flush === 'function') res.flush();
      };
      ping();
      heartbeat = setInterval(ping, options.heartbeatMs ?? 5000);
      heartbeat.unref();
    } else res.setHeader('Cache-Control', 'no-store');
    if (req.file && req.file.size > 24 * 1024 * 1024) {
      throw Object.assign(new Error('Die Aufnahme ist zu gross.'), { response: { status: 413 } });
    }
    const result = await operation(controller.signal);
    if (controller.signal.aborted) return;
    const transcript = typeof result === 'string' ? { text: result } : result;
    if (!transcript || typeof transcript.text !== 'string')
      throw new Error('Die Sprachantwort ist ungültig.');
    const value: SpeechToTextResponse = { text: transcript.text };
    if (typeof transcript.language === 'string' && /^[a-z]{2,3}$/.test(transcript.language))
      value.language = transcript.language;
    if (stream) write('transcription', value);
    else res.json(value);
  } catch (error) {
    if (res.destroyed || res.writableEnded) return;
    const status = errorStatus(error instanceof Error ? error : new Error());
    let code = 'stt_failed';
    let message = 'Das Diktat konnte nicht transkribiert werden.';
    if (status === 503) {
      code = 'stt_busy';
      message = 'Die Spracherkennung ist ausgelastet. Bitte kurz warten.';
    } else if (status === 413) {
      code = 'stt_limit';
      message = 'Die Aufnahme überschreitet die erlaubte Grenze.';
    }
    if (stream) write('error', { code, message });
    else res.status(status).json({ code, message });
  } finally {
    clearTimeout(deadline);
    if (heartbeat) clearInterval(heartbeat);
    res.off('close', disconnected);
    if (!res.destroyed && !res.writableEnded) res.end();
    await cleanup().catch(() => undefined);
  }
}
