import { configSchema } from './config';

describe('speech recorder configuration', () => {
  it.each(['browser', 'external', 'openai', 'azureOpenAI'])(
    'accepts the %s recorder setting',
    (engineSTT) => {
      const config = configSchema.parse({
        version: '1.3.1',
        speech: { speechTab: { speechToText: { engineSTT } } },
      });
      expect(config.speech?.speechTab?.speechToText).toEqual({ engineSTT });
    },
  );

  it('rejects an unknown recorder rather than silently discarding the default', () => {
    expect(
      configSchema.safeParse({
        version: '1.3.1',
        speech: { speechTab: { speechToText: { engineSTT: 'unknown' } } },
      }).success,
    ).toBe(false);
  });
});
