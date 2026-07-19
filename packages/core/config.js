function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function parseNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function parseCsv(value) {
  if (!value) return [];
  return [...new Set(String(value).split(',').map((entry) => entry.trim()).filter(Boolean))];
}

export function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

export function loadCommonConfig(env = process.env, defaults = {}) {
  const toolArgumentWarningBytes = parseInteger(env.TOOL_ARGUMENT_WARNING_BYTES, 8 * 1024, { min: 0 });
  const configuredCriticalBytes = parseInteger(env.TOOL_ARGUMENT_CRITICAL_BYTES, 16 * 1024, { min: 0 });
  const toolArgumentCriticalBytes = configuredCriticalBytes > 0 && toolArgumentWarningBytes > 0
    ? Math.max(configuredCriticalBytes, toolArgumentWarningBytes)
    : configuredCriticalBytes;
  return Object.freeze({
    host: env.PROXY_HOST || defaults.host || '0.0.0.0',
    port: parseInteger(env.PROXY_PORT, defaults.port || 3456, { min: 1, max: 65535 }),
    vllmBaseUrl: trimTrailingSlash(env.VLLM_BASE_URL || defaults.vllmBaseUrl || 'http://vllm:8001'),
    vllmApiKey: env.VLLM_API_KEY || defaults.vllmApiKey || 'vllm',
    proxyApiKey: env.PROXY_API_KEY || defaults.proxyApiKey || '',
    maxRecoveryAttempts: parseInteger(env.MAX_RECOVERY_ATTEMPTS, 1, { min: 0, max: 1 }),
    recoveryTemperatureMax: parseNumber(env.RECOVERY_TEMPERATURE_MAX, 0.45, { min: 0, max: 2 }),
    recoveryMaxTokens: parseInteger(env.RECOVERY_MAX_TOKENS, 4096, { min: 1 }),
    recoveryNetworkTemperatureMax: parseNumber(env.RECOVERY_NETWORK_TEMPERATURE_MAX, 0.30, { min: 0, max: 2 }),
    recoveryNetworkMaxTokens: parseInteger(env.RECOVERY_NETWORK_MAX_TOKENS, 1024, { min: 1 }),
    heartbeatIntervalMs: parseInteger(env.HEARTBEAT_INTERVAL_MS, 10000, { min: 1000 }),
    upstreamIdleTimeoutMs: parseInteger(env.UPSTREAM_IDLE_TIMEOUT_MS, 180000, { min: 1000 }),
    semanticStallTimeoutMs: parseInteger(env.SEMANTIC_STALL_TIMEOUT_MS, 300000, { min: 1000 }),
    totalGenerationTimeoutMs: parseInteger(env.TOTAL_GENERATION_TIMEOUT_MS, 1800000, { min: 1000 }),
    recoveryTimeoutMs: parseInteger(env.RECOVERY_TIMEOUT_MS, 900000, { min: 1000 }),
    shutdownGraceMs: parseInteger(env.SHUTDOWN_GRACE_MS, 300000, { min: 1000 }),
    maxActiveRequests: parseInteger(env.MAX_ACTIVE_REQUESTS, 256, { min: 1 }),
    maxRequestBodyBytes: parseInteger(env.MAX_REQUEST_BODY_BYTES, 8 * 1024 * 1024, { min: 1024 }),
    maxResponseBufferBytes: parseInteger(env.MAX_RESPONSE_BUFFER_BYTES, 32 * 1024 * 1024, { min: 1024 }),
    maxTotalBufferedBytes: parseInteger(env.MAX_TOTAL_BUFFERED_BYTES, 1024 * 1024 * 1024, { min: 1024 }),
    maxReasoningBytes: parseInteger(env.MAX_THINKING_BYTES ?? env.MAX_REASONING_BYTES, 4 * 1024 * 1024, { min: 1024 }),
    maxToolArgumentBytes: parseInteger(env.MAX_TOOL_ARGUMENT_BYTES, 8 * 1024 * 1024, { min: 1024 }),
    maxContentItems: parseInteger(env.MAX_CONTENT_BLOCKS ?? env.MAX_CONTENT_ITEMS, 256, { min: 1 }),
    maxToolCalls: parseInteger(env.MAX_TOOL_CALLS, 128, { min: 1 }),
    loopMinPatternSize: parseInteger(env.LOOP_MIN_PATTERN_SIZE, 24, { min: 4 }),
    loopMaxPatternSize: parseInteger(env.LOOP_MAX_PATTERN_SIZE, 2048, { min: 8 }),
    loopMinCount: parseInteger(env.LOOP_MIN_COUNT, 2, { min: 2 }),
    loopReasoningCharLimit: parseInteger(env.LOOP_REASONING_CHAR_LIMIT, 24000, { min: 128 }),
    loopScanIntervalChars: parseInteger(env.LOOP_SCAN_INTERVAL_CHARS, 64, { min: 8 }),
    logLevel: env.LOG_LEVEL || defaults.logLevel || 'info',
    logFormat: env.LOG_FORMAT || defaults.logFormat || 'json',
    progressLogIntervalMs: parseInteger(env.PROGRESS_LOG_INTERVAL_MS, 10000, { min: 1000 }),
    progressStallWarningMs: parseInteger(env.PROGRESS_STALL_WARNING_MS, 30000, { min: 1000 }),
    logToolPayloads: parseBoolean(env.LOG_TOOL_PAYLOADS, false),
    logToolPayloadMaxBytes: parseInteger(env.LOG_TOOL_PAYLOAD_MAX_BYTES, 1024, { min: 0 }),
    toolArgumentWarningBytes,
    toolArgumentCriticalBytes,
    toolCorrelationTtlMs: parseInteger(env.TOOL_CORRELATION_TTL_MS, 15 * 60 * 1000, { min: 1000 }),
    toolCorrelationMaxEntries: parseInteger(env.TOOL_CORRELATION_MAX_ENTRIES, 10000, { min: 1 }),
    clientRetryFingerprintTtlMs: parseInteger(env.CLIENT_RETRY_FINGERPRINT_TTL_MS, 15 * 60 * 1000, { min: 1000 }),
    clientRetryFingerprintMaxEntries: parseInteger(env.CLIENT_RETRY_FINGERPRINT_MAX_ENTRIES, 10000, { min: 1 }),
  });
}
