import { once } from 'node:events';
import { createServer } from 'node:http';
import { Providers } from '@librechat/agents';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { BrainLearningMetadata } from './learning';
import { containsBrainCredential, learnBrainTurn, shouldLearnBrain } from './learning';
import { createBrainSession } from './session';

describe('Brain learning using the active provider', () => {
  let server: Server;
  let baseUrl: string;
  const captured: object[] = [];
  const quote = 'Projekt Atlas nutzt PostgreSQL.';

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
      }
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/ingest') {
        captured.push(JSON.parse(body) as object);
        res.end(JSON.stringify({ nodes: [], skipped: 0 }));
        return;
      }
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1789398000,
          model: 'test-brain-model',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'capture-1',
                    type: 'function',
                    function: {
                      name: 'brain_capture',
                      arguments: JSON.stringify({
                        facts: [
                          {
                            quote,
                            kind: 'project',
                            tags: ['Atlas'],
                            scope: 'Atlas',
                            relatedIds: [],
                          },
                        ],
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.BRAIN_API_URL = baseUrl;
    process.env.BRAIN_SHARED_SECRET = 'synthetic-learning-key';
  });
  afterAll(async () => {
    server.close();
    await once(server, 'close');
    delete process.env.BRAIN_API_URL;
    delete process.env.BRAIN_SHARED_SECRET;
  });

  it('captures a grounded fact through a real SDK model/tool round and accounts usage', async () => {
    const session = createBrainSession({
      userId: 'owner',
      conversationId: 'conversation',
      messageId: 'response',
      source: { id: 'user-message', text: quote, createdAt: new Date().toISOString() },
      contextBudgetTokens: 4000,
      canWrite: true,
      canUpdate: true,
    });
    const onUsage = jest.fn(async (_metadata: BrainLearningMetadata) => {});
    await learnBrainTurn({
      session,
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'test-brain-model',
        apiKey: 'synthetic-provider-key',
        configuration: { baseURL: `${baseUrl}/openai` },
      },
      onUsage,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      conversationId: 'conversation',
      sourceMessages: [{ id: 'user-message', text: quote }],
      facts: [{ text: quote, kind: 'project', scope: 'Atlas' }],
    });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0].length).toBeGreaterThan(0);
  });

  it('does not call the provider when source persistence or permission has expired', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const session = createBrainSession({
      userId: 'owner',
      conversationId: 'conversation',
      messageId: 'response',
      source: { id: 'user-message', text: quote, createdAt: new Date().toISOString() },
      contextBudgetTokens: 4000,
      canWrite: true,
      canUpdate: true,
      canPersist: async () => false,
    });
    try {
      await learnBrainTurn({
        session,
        llmConfig: { provider: Providers.OPENAI, model: 'test-brain-model' },
        onUsage: async () => {},
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rechecks source and permissions after the provider round before ingestion', async () => {
    const before = captured.length;
    const canPersist = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const session = createBrainSession({
      userId: 'owner',
      conversationId: 'conversation',
      messageId: 'response-late-optout',
      source: { id: 'user-message', text: quote, createdAt: new Date().toISOString() },
      contextBudgetTokens: 4000,
      canWrite: true,
      canUpdate: true,
      canPersist,
    });
    const onUsage = jest.fn(async (_metadata: BrainLearningMetadata) => {});
    await learnBrainTurn({
      session,
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'test-brain-model',
        apiKey: 'synthetic-provider-key',
        configuration: { baseURL: `${baseUrl}/openai` },
      },
      onUsage,
    });
    expect(canPersist).toHaveBeenCalledTimes(2);
    expect(captured).toHaveLength(before);
    expect(onUsage.mock.calls[0][0].length).toBeGreaterThan(0);
  });

  it('skips greetings but retains short durable preferences', () => {
    expect(shouldLearnBrain('Danke!')).toBe(false);
    expect(shouldLearnBrain('Ich heisse Jo.')).toBe(true);
  });
  it('blocks obvious credentials without rejecting security conventions', () => {
    expect(containsBrainCredential('password: temporary-secret-value')).toBe(true);
    expect(containsBrainCredential('API_KEY=abcdefghijklmnop123456')).toBe(true);
    expect(containsBrainCredential('-----BEGIN PRIVATE KEY-----')).toBe(true);
    expect(containsBrainCredential('API keys werden monatlich rotiert.')).toBe(false);
  });
});
