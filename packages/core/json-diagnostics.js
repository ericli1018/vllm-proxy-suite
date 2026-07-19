function extractInteger(message, pattern) {
  const match = String(message || '').match(pattern);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function classifyJsonParseError(error, sourceText = null) {
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

  const parseErrorOffset = extractInteger(message, /position\s+(\d+)/i);
  const diagnostics = {
    parseErrorCategory: category,
    parseErrorOffset,
    parseErrorLine: extractInteger(message, /line\s+(\d+)/i),
    parseErrorColumn: extractInteger(message, /column\s+(\d+)/i),
    parseErrorOffsetUnit: parseErrorOffset === null ? null : 'utf16_code_unit',
  };

  if (sourceText === null || sourceText === undefined) return diagnostics;
  const text = String(sourceText);
  const utf16Length = text.length;
  return {
    ...diagnostics,
    toolArgumentUtf8Bytes: Buffer.byteLength(text, 'utf8'),
    toolArgumentUtf16Length: utf16Length,
    toolArgumentCodePoints: Array.from(text).length,
    parseErrorAtEnd: parseErrorOffset === null ? null : parseErrorOffset >= Math.max(0, utf16Length - 1),
  };
}
