import { tModelSpecSchema } from './models';

const card = {
  name: 'regional-model',
  label: 'Modell',
  preset: { endpoint: 'custom', model: 'model' },
};

describe('model processing region', () => {
  it.each(['switzerland', 'europe', 'worldwide', 'variable', 'unknown'])(
    'preserves the declared region %s alongside existing insights',
    (processingRegion) => {
      const insight = { intelligence: 3, tokenCost: 2, inputs: ['text'], processingRegion };
      expect(tModelSpecSchema.parse({ ...card, insight }).insight).toEqual(insight);
    },
  );

  it('keeps legacy cards without inventing a region from the endpoint or name', () => {
    const legacy = {
      ...card,
      name: 'eu-swiss-model',
      preset: { endpoint: 'EU-Cowork Router', model: 'eu-auto' },
    };
    expect(tModelSpecSchema.parse(legacy).insight).toBeUndefined();
    expect(tModelSpecSchema.parse({ ...legacy, insight: { intelligence: 4 } }).insight).toEqual({
      intelligence: 4,
    });
  });

  it.each(['eu-central-1', 'EU', '', null, 3, { region: 'europe' }])(
    'rejects invalid processing metadata %p',
    (processingRegion) => {
      expect(tModelSpecSchema.safeParse({ ...card, insight: { processingRegion } }).success).toBe(
        false,
      );
    },
  );
});
