import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Providers, Run } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { createWorkCostFetch, readWorkCost, WORK_COST_DAYS, WORK_COST_CALLS } from './costs';
import type { CostDependencies, WorkFetch } from './costs';

it('enforces the cost gate through the installed SDK and accounts its real wire usage once', async () => {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: 'sdk_cost_test' });
  try {
    const scope = {
      userId: 'synthetic-user',
      tenantId: 'cw01',
      conversationId: 'synthetic-chat',
      taskId: 'synthetic-task',
    };
    const deps: CostDependencies = {
      db: mongoose.connection.db!,
      secret: randomBytes(32).toString('hex'),
      requestLimit: 10,
      dayLimit: 50,
    };
    let calls = 0;
    const provider: WorkFetch = async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      expect(request.max_completion_tokens ?? request.max_tokens).toBe(50);
      return Response.json({
        id: 'synthetic-generation',
        object: 'chat.completion',
        created: 0,
        model: 'openai/gpt-5.6-sol',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Geprüfte synthetische Antwort.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 5, cost: 0.0123 },
      });
    };
    const makeRun = () =>
      Run.create({
        runId: 'synthetic-cost-run',
        returnContent: true,
        graphConfig: {
          type: 'standard',
          agents: [
            {
              agentId: 'cost-agent',
              provider: Providers.OPENAI,
              clientOptions: {
                apiKey: 'synthetic-only',
                model: 'openai/gpt-5.6-sol',
                streaming: false,
                disableStreaming: true,
                maxTokens: 50,
                maxRetries: 0,
                configuration: {
                  baseURL: 'https://synthetic.invalid/v1',
                  fetch: createWorkCostFetch(provider, scope, deps),
                },
              },
            },
          ],
        },
      });
    const run = await makeRun();
    await run.processStream(
      { messages: [new HumanMessage('Prüfe nur synthetische Daten.')] },
      { recursionLimit: 10, version: 'v2' },
    );
    expect(calls).toBe(1);
    expect((await readWorkCost(scope, deps))?.requestUsd).toBeCloseTo(0.0123);
    expect(await deps.db.collection(WORK_COST_CALLS).countDocuments({ state: 'completed' })).toBe(
      1,
    );
    const row = await deps.db.collection(WORK_COST_DAYS).findOne({});
    await deps.db
      .collection(WORK_COST_DAYS)
      .updateOne(
        { _id: row!._id },
        { $set: { [`days.${Object.keys(row!.days)[0]}.spent`]: 50_000_000 } },
      );
    const blocked = await makeRun();
    await expect(
      blocked.processStream(
        { messages: [new HumanMessage('Keine echte Anfrage starten.')] },
        { recursionLimit: 10, version: 'v2' },
      ),
    ).rejects.toMatchObject({ code: 'KISUNO_COST_LIMIT' });
    expect(calls).toBe(1);
  } finally {
    await mongoose.disconnect();
    await server.stop();
  }
}, 60000);
