/** Only the external model boundary is simulated; extraction and persistence run normally. */
const http = require('node:http');
const { captureResult } = require('./fake-brain-fixtures');
let captures = 0;
const learningRequests = [];
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET') {
    return res.end(JSON.stringify({ ok: true, captures, learningRequests }));
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Ungültige lokale Testanfrage.' }));
  }
  const capture = body.tools?.some((entry) => entry.function?.name === 'brain_capture');
  let result;
  if (capture) {
    captures++;
    learningRequests.push({
      model: body.model,
      usedSeparateProviderKey: req.headers.authorization === 'Bearer e2e-mock-key-b',
    });
    try {
      result = captureResult(body);
    } catch {
      res.statusCode = 400;
      return res.end(
        JSON.stringify({ error: 'Unbekanntes Format der lokalen Brain-Testanfrage.' }),
      );
    }
  }
  const message = capture
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `capture_${captures}`,
            type: 'function',
            function: { name: 'brain_capture', arguments: JSON.stringify(result) },
          },
        ],
      }
    : { role: 'assistant', content: 'Testaufgabe' };
  const base = {
    id: `brain-e2e-${captures}`,
    object: 'chat.completion',
    created: 0,
    model: body.model,
  };
  const usage = { prompt_tokens: 80, completion_tokens: 25, total_tokens: 105 };
  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    const delta = {
      ...message,
      tool_calls: message.tool_calls?.map((tool, index) => ({ ...tool, index })),
    };
    res.write(
      `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: capture ? 'tool_calls' : 'stop' }], usage })}\n\n`,
    );
    return res.end('data: [DONE]\n\n');
  }
  res.end(
    JSON.stringify({
      ...base,
      choices: [{ index: 0, message, finish_reason: capture ? 'tool_calls' : 'stop' }],
      usage,
    }),
  );
});
server.listen(Number(process.env.E2E_LABEL_PORT || 8889), '127.0.0.1');
