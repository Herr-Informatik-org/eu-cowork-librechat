const { withNullableSearchDate } = require('@librechat/api');

const EMPTY_SEARCH_RESULT =
  'Die Websuche hat keine verwertbaren Ergebnisse geliefert. ' +
  'Das kann an den Suchfiltern oder einer vorübergehend nicht erreichbaren Suche liegen und ' +
  'belegt nicht, dass keine Quellen existieren. Versuche eine kürzere Suchanfrage und ' +
  'lasse einen nicht ausdrücklich verlangten Zeitfilter weg (date: null). ' +
  'Melde die Einschränkung, wenn auch eine weitere Suche keine Ergebnisse liefert.';

/** Add an explicit unfiltered choice without changing the provider or executing extra searches. */
function prepareWebSearchTool(tool) {
  if (tool.schema) {
    tool.schema = withNullableSearchDate(tool.schema);
  }

  const original = tool.func.bind(tool);
  tool.func = async (...args) => {
    const result = await original(...args);
    if (
      tool.responseFormat === 'content_and_artifact' &&
      Array.isArray(result) &&
      result.length === 2 &&
      (result[0] == null || (typeof result[0] === 'string' && result[0].trim() === ''))
    ) {
      return [EMPTY_SEARCH_RESULT, result[1]];
    }
    if (result == null || (typeof result === 'string' && result.trim() === '')) {
      return EMPTY_SEARCH_RESULT;
    }
    return result;
  };
  return tool;
}

module.exports = { prepareWebSearchTool };
