import { memorySchema } from './config';

describe('memory model configuration precedence', () => {
  it('retains an explicit model override when an inherited legacy agent id is present', () => {
    const selected = memorySchema.parse({
      agent: {
        id: 'inherited-agent',
        provider: 'Target',
        model: 'learning-model',
        enabled: true,
        model_parameters: { temperature: 0.1 },
      },
    }).agent;
    expect(selected).toEqual({
      provider: 'Target',
      model: 'learning-model',
      enabled: true,
      model_parameters: { temperature: 0.1 },
    });
  });
  it('preserves a legacy agent id when no explicit model is selected', () => {
    expect(memorySchema.parse({ agent: { id: 'existing-agent', enabled: false } }).agent).toEqual({
      id: 'existing-agent',
      enabled: false,
    });
  });
  it('rejects incomplete new model selections', () => {
    expect(memorySchema.safeParse({ agent: { provider: 'Target' } }).success).toBe(false);
    expect(memorySchema.safeParse({ agent: { model: 'learning-model' } }).success).toBe(false);
  });
});
