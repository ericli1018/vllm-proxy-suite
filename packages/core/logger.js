const LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 100, off: 100 });
const RESERVED = new Set(['timestamp', 'level', 'event']);

function normalizeLevel(value) {
  const level = String(value || 'info').trim().toLowerCase();
  return Object.hasOwn(LEVELS, level) ? level : 'info';
}

function cleanFields(source = {}) {
  const output = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!RESERVED.has(key)) output[key] = value;
  }
  return output;
}

function formatTextValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

function formatText(record) {
  const fields = Object.entries(record)
    .filter(([key]) => !RESERVED.has(key))
    .map(([key, value]) => `${key}=${formatTextValue(value)}`)
    .join(' ');
  return `${record.timestamp} [${record.level}] event=${record.event}${fields ? ` ${fields}` : ''}`;
}

export function createLogger(config = {}, sink = (line) => process.stdout.write(`${line}\n`), context = {}) {
  const threshold = LEVELS[normalizeLevel(config.logLevel)];
  const format = String(config.logFormat || 'json').trim().toLowerCase() === 'text' ? 'text' : 'json';
  const safeContext = cleanFields(context);

  const isEnabled = (level) => LEVELS[normalizeLevel(level)] >= threshold;
  const emit = (level, event, fields = {}) => {
    if (!isEnabled(level)) return;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      ...safeContext,
      event: String(event || 'unknown_event'),
      ...cleanFields(fields),
    };
    sink(format === 'text' ? formatText(record) : JSON.stringify(record));
  };

  return Object.freeze({
    trace: (event, fields) => emit('trace', event, fields),
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child(extra = {}) { return createLogger(config, sink, { ...safeContext, ...cleanFields(extra) }); },
    isEnabled,
  });
}
