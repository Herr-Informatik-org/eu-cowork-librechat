import { createHmac } from 'node:crypto';
import type { CostScope } from './costs';

interface TextBlock {
  type: string;
  text?: string;
  prompt_cache_breakpoint?: { ttl?: string };
  cache_control?: unknown;
}
interface CacheMessage {
  role?: string;
  content?: string | TextBlock[] | null;
}
interface CacheRequest {
  model?: string;
  messages?: CacheMessage[];
  session_id?: string;
  prompt_cache_key?: string;
  prompt_cache_options?: { mode?: string; ttl?: string };
}
/** Mark reusable tool-loop tails while preserving automatic caching and all provider/privacy controls. */
export function applyWorkCache(body: string, scope: CostScope, secret: string): string {
  const request = JSON.parse(body) as CacheRequest;
  if (!/^openai\/gpt-(?:5\.6|6)/.test(request.model ?? '') || !Array.isArray(request.messages))
    return body;
  if (request.prompt_cache_options?.mode != null) return body;
  const session = createHmac('sha256', secret)
    .update(JSON.stringify([scope.tenantId, scope.userId, scope.conversationId, request.model]))
    .digest('hex');
  request.session_id ??= session;
  request.prompt_cache_key ??= session;
  request.prompt_cache_options = {
    ...request.prompt_cache_options,
    ttl: request.prompt_cache_options?.ttl ?? '30m',
  };
  let marked = 0;
  for (let index = request.messages.length - 1; index >= 0 && marked < 4; index--) {
    const message = request.messages[index];
    if (!['user', 'assistant', 'tool', 'system', 'developer'].includes(message.role ?? ''))
      continue;
    if (typeof message.content === 'string' && message.content.trim()) {
      message.content = [{ type: 'text', text: message.content, prompt_cache_breakpoint: {} }];
      marked++;
    } else if (Array.isArray(message.content)) {
      for (let block = message.content.length - 1; block >= 0; block--) {
        const content = message.content[block];
        if (content.type !== 'text' || !content.text?.trim() || content.cache_control) continue;
        message.content[block] = { ...content, prompt_cache_breakpoint: {} };
        marked++;
        break;
      }
    }
  }
  return JSON.stringify(request);
}

/** The optional 12-hour cache lifetime doubles the default cache-write price. */
export function workCacheWriteMultiplier(body: string): number {
  const request = JSON.parse(body) as CacheRequest;
  if (request.prompt_cache_options?.ttl === '12h') return 2;
  for (const message of request.messages ?? []) {
    if (
      Array.isArray(message.content) &&
      message.content.some((block) => block.prompt_cache_breakpoint?.ttl === '12h')
    )
      return 2;
  }
  return 1;
}
