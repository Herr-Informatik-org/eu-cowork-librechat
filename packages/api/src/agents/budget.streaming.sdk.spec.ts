import { hasAgentWorkBudgetExhausted } from './budget';
import { fixture } from './budget.helper';

describe('streaming work budget with the real SDK and a local synthetic transport', () => {
  const previous = process.env.KISUNO_CWV01_SAFE_WORK;
  beforeAll(() => {
    process.env.KISUNO_CWV01_SAFE_WORK = 'true';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.KISUNO_CWV01_SAFE_WORK;
    else process.env.KISUNO_CWV01_SAFE_WORK = previous;
  });
  it('keeps streamed effects behind hooks and closes cleanly on budget denial', async () => {
    const f = await fixture({ streaming: true, limit: 20, obey: 'denial' });
    await expect(f.start()).resolves.toBeDefined();
    expect(f.effects.every((effect) => effect.guarded && !effect.duringStream)).toBe(true);
    expect(
      f.effects.filter((effect) => effect.guarded).every((effect) => !effect.duringStream),
    ).toBe(true);
    expect(f.effects.every((effect) => effect.call < 8)).toBe(true);
    expect(hasAgentWorkBudgetExhausted(f.run)).toBe(true);
  });
});
