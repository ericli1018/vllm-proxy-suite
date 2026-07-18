const LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 100, off: 100 });

function normalizeLevel(value) {
  const level = String(value || 'info').trim().toLowerCase();
  return Object.hasOwn(LEVELS, level) ? level : 'info';
}

function formatText(record) {
  const base = `[${record.level}] event=${record.event}`;
  const fields = Object.entries(record)
    .filter(([key]) => !['timestamp', 'level', 'event'].includes(key))
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return `${record.timestamp} ${base}${fields ? ` ${fields}` : ''}`;
}

export function createLogger(config = {}, sink = (line) => process.stdout.write(`${line}\n`), context = {}) {
  const threshold = LEVELS[normalizeLevel(config.logLevel)];
  const format = String(config.logFormat || 'json').trim().toLowerCase() === 'text' ? 'text' : 'json';

  const emit = (level, event, fields = {}) => {
    if (LEVELS[level] < threshold) return;
    const record = { timestamp: new Date().toISOString(), level, ...context, event, ...fields };
    sink(format === 'text' ? formatText(record) : JSON.stringify(record));
  };

  return Object.freeze({
    trace: (event, fields) => emit('trace', event, fields),
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child(extra = {}) { return createLogger(config, sink, { ...context, ...extra }); },
    isEnabled(level) { return LEVELS[normalizeLevel(level)] >= threshold; },
  });
}
