import type { ExtendedJsonSchema } from './schema';

/** Keep model definitions and runtime validation consistent for unfiltered web searches. */
export function withNullableSearchDate(schema: ExtendedJsonSchema): ExtendedJsonSchema {
  const date = schema.properties?.date;
  if (!date) {
    return schema;
  }
  return {
    ...schema,
    properties: {
      ...schema.properties,
      date: {
        anyOf: [date, { type: 'null' }],
        description:
          'Optional time filter. Use null for all time, including when the user asks for no ' +
          'date filter. Only select a time range when the user explicitly requests one; ' +
          'current documentation does not require a publication-date filter.',
      },
    },
  };
}
