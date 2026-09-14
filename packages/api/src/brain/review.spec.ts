import { once } from 'node:events';
import { createServer } from 'node:http';
import { Providers } from '@librechat/agents';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { BrainCandidate } from './session';
import type { BrainReviewCheckpoint } from './review';
import { conversationMessages } from './conversation';
import {
  brainCandidateId,
  brainReviewParts,
  mergeBrainCandidates,
  reviewBrainConversation,
  validateContextualFacts,
} from './review';

const messages = conversationMessages([
  {
    messageId: 'u1',
    conversationId: 'atlas',
    isCreatedByUser: true,
    createdAt: new Date(1000),
    text: 'Bei Projekt Atlas ist ein Wiederherstellungstest erforderlich.',
  },
  {
    messageId: 'a1',
    parentMessageId: 'u1',
    conversationId: 'atlas',
    isCreatedByUser: false,
    createdAt: new Date(2000),
    text: 'Soll das für alle Änderungen gelten?',
  },
  {
    messageId: 'u2',
    parentMessageId: 'a1',
    conversationId: 'atlas',
    isCreatedByUser: true,
    createdAt: new Date(3000),
    text: 'Nein, nur für diese Umstellung. Das ist wichtig.',
  },
]);
const fact: BrainCandidate = {
  quote: 'Projekt Atlas benötigt für diese Umstellung einen Wiederherstellungstest.',
  text: 'Projekt Atlas benötigt für diese Umstellung einen Wiederherstellungstest.',
  title: 'Wiederherstellungstest bei Atlas',
  kind: 'decision',
  scope: 'Projekt Atlas',
  evidence: [
    { messageId: 'u1', quote: messages[0].text },
    { messageId: 'u2', quote: messages[2].text },
  ],
  basis: 'direct',
  claimState: 'agreed',
  tags: [],
  relatedIds: [],
};

describe('contextual evidence and bounded review', () => {
  it('supports a canonical scoped assertion across user clarification while rejecting invented or assistant-only evidence', () => {
    expect(validateContextualFacts([fact], messages)).toEqual([fact]);
    expect(
      validateContextualFacts(
        [{ ...fact, evidence: [{ messageId: 'a1', quote: messages[1].text }] }],
        messages,
      ),
    ).toEqual([]);
    expect(
      validateContextualFacts(
        [{ ...fact, evidence: [{ messageId: 'u2', quote: 'Invented endorsement' }] }],
        messages,
      ),
    ).toEqual([]);
    expect(
      validateContextualFacts([{ ...fact, supersedesId: 'foreign-memory' }], messages),
    ).toEqual([]);
  });

  it('preserves all long source text and candidate state across section boundaries', async () => {
    const long = {
      ...messages[0],
      text: 'Ein langer Gesprächsabschnitt mit Bedeutung. '.repeat(200),
    };
    const parts = await brainReviewParts([long], 500, async (text) => Math.ceil(text.length / 4));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((part) => part.text).join('')).toBe(long.text);
    expect(
      parts.every((part) => part.id === long.id && part.contentHash === long.contentHash),
    ).toBe(true);
    expect(mergeBrainCandidates([fact], [], [])).toEqual([fact]);
    expect(mergeBrainCandidates([fact], [], [brainCandidateId(fact)])).toEqual([]);
  });
});

describe('context review through the real model SDK with a local provider fixture', () => {
  let server: Server;
  let baseURL: string;
  let mode: 'normal' | 'reject' | 'fail-verification' = 'normal';
  const requests: { messages: { content: string }[] }[] = [];
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const request = JSON.parse(raw) as { messages: { content: string }[] };
      requests.push(request);
      const verification = JSON.stringify(request.messages).includes('FINAL VERIFICATION');
      if (verification && mode === 'fail-verification') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Synthetic provider outage' } }));
        return;
      }
      const { quote: _quote, ...candidate } = fact;
      const result = verification
        ? { acceptedIds: mode === 'reject' ? [] : [brainCandidateId(fact)] }
        : { facts: [candidate], removeIds: [] };
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'review-fixture',
          object: 'chat.completion',
          created: 1789398000,
          model: 'synthetic-review',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'capture',
                    type: 'function',
                    function: { name: 'brain_capture', arguments: JSON.stringify(result) },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 180, completion_tokens: 70, total_tokens: 250 },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    requests.length = 0;
    mode = 'normal';
  });
  afterAll(async () => {
    server.close();
    await once(server, 'close');
  });
  const options = () => ({
    userId: 'owner',
    conversationId: 'atlas',
    messages,
    llmConfig: {
      provider: Providers.OPENAI,
      model: 'synthetic-review',
      apiKey: 'synthetic-test',
      configuration: { baseURL },
    },
    countTokens: async (text: string) => Math.ceil(text.length / 4),
    inputBudget: 16000,
    canContinue: async () => true,
    onCheckpoint: async (_state: BrainReviewCheckpoint) => {},
    onUsage: jest.fn(async () => {}),
  });

  it('reads the whole exchange, independently verifies it, and preserves contextual canonical text', async () => {
    const input = options();
    const result = await reviewBrainConversation(input);
    expect(result).toEqual([fact]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const content = JSON.stringify(request.messages);
      for (const message of messages) expect(content).toContain(message.text);
    }
    expect(input.onUsage).toHaveBeenCalledTimes(2);
  });

  it('does not promote candidates rejected by the final review', async () => {
    mode = 'reject';
    expect(await reviewBrainConversation(options())).toEqual([]);
  });

  it('resumes a failed verification without paying for successful extraction again', async () => {
    let saved: BrainReviewCheckpoint | undefined;
    const input = {
      ...options(),
      onCheckpoint: async (state: BrainReviewCheckpoint) => {
        saved = structuredClone(state);
      },
    };
    mode = 'fail-verification';
    await expect(reviewBrainConversation(input)).rejects.toThrow();
    expect(saved?.phase).toBe('verify');
    mode = 'normal';
    requests.length = 0;
    expect(await reviewBrainConversation({ ...input, checkpoint: saved })).toEqual([fact]);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain('FINAL VERIFICATION');
  });

  it('does not disclose credential-bearing messages during either review phase', async () => {
    const secret = { ...messages[0], id: 'secret', text: 'passwort: synthetic-confidential-value' };
    await reviewBrainConversation({ ...options(), messages: [...messages, secret] });
    expect(JSON.stringify(requests)).not.toContain('synthetic-confidential-value');
  });

  it('starts no model call after source authorization is revoked', async () => {
    await expect(
      reviewBrainConversation({ ...options(), canContinue: async () => false }),
    ).rejects.toThrow(/Berechtigung/);
    expect(requests).toHaveLength(0);
  });
});
