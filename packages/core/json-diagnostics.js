function extractInteger(message, pattern) {
  const match = String(message || '').match(pattern);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function classifyJsonParseError(error) {
  const message = error instanceof Error ? error.message : String(error || 'invalid JSON');
  const normalized = message.toLowerCase();
  let category = 'invalid_json';

  if (normalized.includes('unterminated string')) category = 'unterminated_string';
  else if (normalized.includes('unexpected end')) category = 'unexpected_end';
  else if (normalized.includes('bad control character')) category = 'invalid_control_character';
  else if (normalized.includes('escape')) category = 'invalid_escape';
  else if (normalized.includes('non-whitespace character after json')) category = 'trailing_data';
  else if (normalized.includes('expected property name')) category = 'expected_property_name';
  else if (normalized.includes("expected ',' or '}'") || normalized.includes("expected ',' or ']'") || normalized.includes('expected double-quoted property name')) category = 'missing_delimiter';
  else if (normalized.includes('unexpected token') || normalized.includes('unexpected character')) category = 'unexpected_token';

  return {
    parseErrorCategory: category,
    parseErrorOffset: extractInteger(message, /position\s+(\d+)/i),
    parseErrorLine: extractInteger(message, /line\s+(\d+)/i),
    parseErrorColumn: extractInteger(message, /column\s+(\d+)/i),
  };
}
