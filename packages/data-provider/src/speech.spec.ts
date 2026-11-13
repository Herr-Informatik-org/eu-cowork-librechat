import { readSpeechResponse } from './speech';

function streamed(text: string, size = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let index = 0; index < bytes.length; index += size)
          controller.enqueue(bytes.slice(index, index + size));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  );
}

describe('speech response protocol', () => {
  it('retains Unicode, punctuation and numerals across split UTF-8 frames', async () => {
    const value = 'Grüezi. CHF 1’234.50, stimmt das?';
    const response = streamed(
      ': keepalive\r\n\r\nevent: transcription\r\ndata: ' +
        JSON.stringify({ text: value }) +
        '\r\n\r\n',
    );
    expect(await readSpeechResponse(response)).toEqual({ text: value });
  });
  it('retains the detected language and excludes unrelated or invalid metadata', async () => {
    expect(
      await readSpeechResponse(
        streamed(
          'event: transcription\ndata: {"text":"Guten Tag.","language":"de","key":"private"}\n\n',
        ),
      ),
    ).toEqual({ text: 'Guten Tag.', language: 'de' });
    expect(
      await readSpeechResponse(
        streamed('event: transcription\ndata: {"text":"Hello.","language":"invalid-language"}\n\n'),
      ),
    ).toEqual({ text: 'Hello.' });
  });
  it('accepts empty speech and older JSON responses', async () => {
    expect(
      await readSpeechResponse(streamed('event: transcription\ndata: {"text":""}\n\n')),
    ).toEqual({ text: '' });
    expect(
      await readSpeechResponse(
        new Response('{"text":"Fertig."}', { headers: { 'Content-Type': 'application/json' } }),
      ),
    ).toEqual({ text: 'Fertig.' });
  });
  it.each([200, 403])('rejects an HTML WAF page with HTTP %s', async (status) => {
    await expect(
      readSpeechResponse(
        new Response('<html>Sperrseite</html>', {
          status,
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
    ).rejects.toThrow();
  });
  it.each([
    ': keepalive\n\n',
    'event: error\ndata: {"code":"stt_busy"}\n\n',
    'event: transcription\ndata: {"other":"wrong"}\n\n',
    'event: transcription\ndata: {"text":"eins"}\n\nevent: transcription\ndata: {"text":"zwei"}\n\n',
  ])('rejects incomplete or ambiguous streams', async (text) => {
    await expect(readSpeechResponse(streamed(text, 12))).rejects.toThrow();
  });
  it('caps unexpected oversized streams', async () => {
    await expect(readSpeechResponse(streamed('x'.repeat(131073), 65536))).rejects.toThrow();
  });
});
