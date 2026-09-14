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

  it('keeps independent bootstrap, ongoing inheritance and explicit organisation context', () => {
    const memory = {
      agent: { inherit: true, enabled: false },
      bootstrapAgent: { provider: 'Strong', model: 'analysis-model' },
      organizationContext: { text: 'Handelsunternehmen', version: 'context-1' },
      useMcpContext: false,
    };
    expect(memorySchema.parse(memory)).toMatchObject(memory);
    expect(memorySchema.parse({ organizationContext: { text: '', version: 'cleared' } }))
      .toHaveProperty('organizationContext.text', '');
    expect(memorySchema.parse({ bootstrapAgent: { inherit: true } }).bootstrapAgent)
      .toEqual({ inherit: true });
  });

  it('rejects an incomplete bootstrap target and unversioned or oversized organisation context', () => {
    expect(memorySchema.safeParse({ bootstrapAgent: { provider: 'Missing' } }).success).toBe(false);
    expect(memorySchema.safeParse({ bootstrapAgent: { inherit: true, model: 'Incomplete' } }).success).toBe(false);
    expect(memorySchema.safeParse({ organizationContext: { text: 'Context' } }).success).toBe(false);
    expect(memorySchema.safeParse({ organizationContext: { text: 'x'.repeat(20001), version: '1' } }).success).toBe(false);
  });
});
