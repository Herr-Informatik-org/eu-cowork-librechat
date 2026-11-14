import { applyWorkCache, workCacheWriteMultiplier } from './cache';
const scope = { userId: 'a', tenantId: 'cw01', conversationId: 'chat', taskId: 'turn' };
it('keeps cache identity stable across turns and isolates user, tenant and conversation', () => {
  const body = JSON.stringify({
    model: 'openai/gpt-5.6-sol',
    messages: [{ role: 'user', content: 'Prüfe jeden Datensatz.' }],
  });
  const first = JSON.parse(applyWorkCache(body, scope, 'synthetic'));
  expect(first.prompt_cache_key).toBe(
    JSON.parse(applyWorkCache(body, { ...scope, taskId: 'next' }, 'synthetic')).prompt_cache_key,
  );
  for (const other of [
    { ...scope, userId: 'b' },
    { ...scope, tenantId: 'b' },
    { ...scope, conversationId: 'b' },
  ])
    expect(JSON.parse(applyWorkCache(body, other, 'synthetic')).prompt_cache_key).not.toBe(
      first.prompt_cache_key,
    );
  expect(first.messages[0].content[0].text).toBe('Prüfe jeden Datensatz.');
});
it('preserves privacy/routing options, multimodal content and explicit operator cache controls', () => {
  const request = {
    model: 'openai/gpt-5.6-sol',
    provider: { zdr: true, allow_fallbacks: false },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://example.invalid/image' } },
          { type: 'text', text: 'Bild', cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
  };
  const next = JSON.parse(applyWorkCache(JSON.stringify(request), scope, 'synthetic'));
  expect(next.provider).toEqual(request.provider);
  expect(next.messages).toEqual(request.messages);
  const explicit = JSON.stringify({ ...request, prompt_cache_options: { mode: 'explicit' } });
  expect(applyWorkCache(explicit, scope, 'synthetic')).toBe(explicit);
  const other = JSON.stringify({ ...request, model: 'another-provider/model' });
  expect(applyWorkCache(other, scope, 'synthetic')).toBe(other);
});

it('preserves disabled caching and accounts for expensive operator-selected cache lifetimes', () => {
  const body = JSON.stringify({
    model: 'openai/gpt-5.6-sol',
    messages: [{ role: 'user', content: 'Text' }],
    prompt_cache_options: { mode: 'disabled' },
  });
  expect(applyWorkCache(body, scope, 'synthetic')).toBe(body);
  expect(workCacheWriteMultiplier(body)).toBe(1);
  expect(workCacheWriteMultiplier(JSON.stringify({ prompt_cache_options: { ttl: '12h' } }))).toBe(
    2,
  );
  expect(
    workCacheWriteMultiplier(
      JSON.stringify({
        messages: [
          { content: [{ type: 'text', text: 'Text', prompt_cache_breakpoint: { ttl: '12h' } }] },
        ],
      }),
    ),
  ).toBe(2);
});
