import { randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

import { BufferBudget } from '../core/buffer-budget.js';
import { performBufferedAttempt } from '../core/attempt-runner.js';
import { buildUpstreamHeaders, copyResponseHeaders, jsonResponse, readRequestBody, writeNodeResponseBody } from '../core/http.js';
import { createLogger } from '../core/logger.js';
import { fingerprintRequest, RequestFingerprintRegistry } from '../core/request-fingerprint.js';
import { ToolCallCorrelationRegistry } from '../core/tool-correlation.js';

function secureEqual(actual, expected) {
  if (!expected) return true;
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

function extractApiKey(request) {
  const authorization = request.headers.authorization || '';
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '');
  return request.headers['x-api-key'] || '';
}

function createMetrics() {
  return {
    requestsTotal: 0,
    activeRequests: 0,
    passthroughTotal: 0,
    recoveriesTotal: 0,
    recoverySuccessTotal: 0,
    loopsDetectedTotal: 0,
    upstreamInterruptionsTotal: 0,
    validationFailuresTotal: 0,
    clientCancellationsTotal: 0,
    responseReplayInterruptionsTotal: 0,
    clientRetriesDetectedTotal: 0,
    toolArgumentWarningsTotal: 0,
    toolArgumentCriticalTotal: 0,
    toolPassthroughStartedTotal: 0,
    toolPassthroughCompletedTotal: 0,
    toolPassthroughInterruptionsTotal: 0,
    toolPassthroughValidationWarningsTotal: 0,
    actionlessCompletionsDetectedTotal: 0,
    actionlessRecoveriesFusedTotal: 0,
    hostedToolsFilteredTotal: 0,
    requiredHostedToolsRejectedTotal: 0,
    malformedToolRetriesTotal: 0,
    malformedToolRetryFailuresTotal: 0,
  };
}

export function renderProtocolMetrics(metrics, prefix) {
  const rows = [];
  for (const [key, value] of Object.entries(metrics)) {
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    const type = key === 'activeRequests' ? 'gauge' : 'counter';
    rows.push(`# TYPE ${prefix}_${snake} ${type}`, `${prefix}_${snake} ${value}`);
  }
  return `${rows.join('\n')}\n`;
}

function toolResultsFromMessage(message) {
  const summaries = [];
  if (message?.role === 'tool') {
    summaries.push({ id: message.tool_call_id || null, name: message.name || null, isError: Boolean(message.error) });
    return summaries;
  }
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === 'tool_result') summaries.push({ id: block.tool_use_id || null, isError: Boolean(block.is_error) });
  }
  return summaries;
}

function isToolResultMessage(message) {
  if (message?.role === 'tool') return true;
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.length > 0 && content.every((block) => block?.type === 'tool_result');
}

export function summarizeToolResultContext(body) {
  const history = [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) history.push(...toolResultsFromMessage(message));

  const latestMessages = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isToolResultMessage(message)) break;
    latestMessages.unshift(...toolResultsFromMessage(message));
  }

  const responsesInput = Array.isArray(body?.input) ? body.input : [];
  for (const item of responsesInput) {
    if (item?.type === 'function_call_output') {
      history.push({ id: item.call_id || item.id || null, name: item.name || null, isError: Boolean(item.error) });
    }
  }
  const latestResponses = [];
  for (let index = responsesInput.length - 1; index >= 0; index -= 1) {
    const item = responsesInput[index];
    if (item?.type !== 'function_call_output') break;
    latestResponses.unshift({ id: item.call_id || item.id || null, name: item.name || null, isError: Boolean(item.error) });
  }

  return {
    history,
    latestTurn: [...latestMessages, ...latestResponses],
  };
}

function recoverable(attempt) {
  if (attempt?.retryable === false) return false;
  if (attempt.kind === 'loop' || attempt.kind === 'invalid' || attempt.kind === 'interrupted') return true;
  return attempt.kind === 'http_error' && attempt.status >= 500;
}

function attemptFailureFields(attempt) {
  const diagnostics = attempt?.diagnostics && typeof attempt.diagnostics === 'object'
    ? attempt.diagnostics
    : {};
  return { retryable: recoverable(attempt), ...diagnostics };
}

function errorMessage(attempt) {
  return attempt.message || attempt.detail || attempt.reason || attempt.loopInfo?.reason || 'upstream generation failed';
}

function startHeartbeat(response, intervalMs) {
  let sent = false;
  const timer = setInterval(() => {
    if (response.destroyed || response.writableEnded) return;
    if (!response.headersSent) {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
    }
    sent = true;
    response.write(': keep-alive\n\n');
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), wasSent: () => sent };
}

function endResponseAndWait(response, body = null) {
  if (response.writableFinished) return Promise.resolve({ finished: true });
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      response.removeListener('finish', onFinish);
      response.removeListener('close', onClose);
      response.removeListener('error', onError);
    };
    const onFinish = () => {
      finished = true;
      cleanup();
      resolve({ finished: true });
    };
    const onClose = () => {
      cleanup();
      if (finished) resolve({ finished: true });
      else reject(new Error('response_closed_before_finish'));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    response.once('finish', onFinish);
    response.once('close', onClose);
    response.once('error', onError);
    response.end(body ?? undefined);
  });
}

async function writeResponseChunk(response, chunk) {
  if (response.destroyed || response.writableEnded) throw new Error('response_not_writable');
  if (!response.write(chunk)) await once(response, 'drain');
}

async function sendBufferedSuccess(response, attempt) {
  if (!response.headersSent) {
    response.writeHead(attempt.status || 200, copyResponseHeaders(attempt.headers, { bodyLength: attempt.rawBody.length }));
  }
  return endResponseAndWait(response, attempt.rawBody);
}

async function sendGuardedFailure({ response, route, streaming, status, type, message, requestId, formatJsonError, extra = {} }) {
  const error = { message, type, param: null, code: type, request_id: requestId, ...extra };
  if (streaming) {
    if (!response.headersSent) {
      response.writeHead(status, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
    }
    await endResponseAndWait(response, route.adapter.streamError(error)).catch(() => {});
    return;
  }
  jsonResponse(response, status, formatJsonError(type, message, requestId, extra));
}

function redactPayload(value, key = '') {
  if (/authorization|api[_-]?key|token|secret|password|cookie/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactPayload(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactPayload(childValue, childKey)]));
  }
  return value;
}

function payloadPreview(value, maxBytes) {
  let normalized = value;
  if (typeof value === 'string') {
    try {
      normalized = JSON.parse(value);
    } catch {
      normalized = value
        .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
        .replace(/((?:api[_-]?key|token|secret|password|cookie)\s*[=:]\s*)[^,\s]+/gi, '$1[REDACTED]');
    }
  }
  const serialized = JSON.stringify(redactPayload(normalized));
  const buffer = Buffer.from(serialized, 'utf8');
  if (buffer.length <= maxBytes) return serialized;
  return `${buffer.subarray(0, maxBytes).toString('utf8')}...[truncated:${buffer.length - maxBytes}B]`;
}

function toolLogEntries(toolCalls, config, includePayload) {
  return (toolCalls || []).map((tool) => {
    const name = tool.name || tool.function?.name || 'unknown';
    const id = tool.id || tool.call_id || null;
    const rawArguments = tool.arguments ?? tool.function?.arguments ?? tool.parsedArguments ?? null;
    const argumentBytes = Number.isFinite(Number(tool.argumentBytes))
      ? Number(tool.argumentBytes)
      : (typeof rawArguments === 'string'
        ? Buffer.byteLength(rawArguments, 'utf8')
        : Buffer.byteLength(JSON.stringify(rawArguments ?? {}), 'utf8'));
    return {
      name,
      id,
      argumentBytes,
      ...(includePayload ? { argumentPreview: payloadPreview(rawArguments, config.logToolPayloadMaxBytes) } : {}),
    };
  });
}

export function createProtocolProxyRuntime({
  name,
  metricPrefix,
  config,
  guardedRoutes,
  allowPassthrough,
  formatJsonError,
  fetchImpl = globalThis.fetch,
  exposeControlRoutes = true,
  logSink,
}) {
  const metrics = createMetrics();
  const rootLogger = createLogger(config, logSink);
  const budget = new BufferBudget(config.maxTotalBufferedBytes);
  const correlations = new ToolCallCorrelationRegistry({
    ttlMs: config.toolCorrelationTtlMs,
    maxEntries: config.toolCorrelationMaxEntries,
  });
  const requestFingerprints = new RequestFingerprintRegistry({
    ttlMs: config.clientRetryFingerprintTtlMs,
    maxEntries: config.clientRetryFingerprintMaxEntries,
  });
  let draining = false;

  const handle = async (request, response) => {
    request.socket.setKeepAlive(true, 15000);
    request.socket.setNoDelay(true);
    const parsedUrl = new URL(request.url || '/', 'http://proxy.local');
    const path = parsedUrl.pathname;

    if (exposeControlRoutes && request.method === 'GET' && path === '/health/live') return jsonResponse(response, 200, { status: 'ok', service: name });
    if (exposeControlRoutes && request.method === 'GET' && path === '/health/ready') return jsonResponse(response, draining ? 503 : 200, { status: draining ? 'draining' : 'ready', service: name });
    if (exposeControlRoutes && request.method === 'GET' && path === '/metrics') {
      const body = Buffer.from(renderProtocolMetrics(metrics, metricPrefix));
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'content-length': String(body.length) });
      return response.end(body);
    }

    if (!guardedRoutes.has(path) && !allowPassthrough(path, request.method)) return jsonResponse(response, 404, formatJsonError('not_found', 'unsupported proxy path', null));
    if (!secureEqual(extractApiKey(request), config.proxyApiKey)) return jsonResponse(response, 401, formatJsonError('authentication_error', 'invalid proxy API key', null));
    if (draining) return jsonResponse(response, 503, formatJsonError('service_draining', 'proxy is draining', null));
    if (metrics.activeRequests >= config.maxActiveRequests) return jsonResponse(response, 429, formatJsonError('too_many_requests', 'active request limit reached', null));

    const requestId = randomUUID();
    const requestStartedAtMono = performance.now();
    const elapsedMs = () => Math.max(0, Math.round(performance.now() - requestStartedAtMono));
    const requestLogger = rootLogger.child({ service: name, requestId, protocol: metricPrefix, path, method: request.method });
    let terminalEvent = null;
    let requestFingerprint = null;
    const terminal = (event, fields = {}, level = 'info') => {
      if (terminalEvent) return false;
      terminalEvent = event;
      requestLogger[level](event, { ...fields, elapsedMs: fields.elapsedMs ?? elapsedMs() });
      if (requestFingerprint) requestFingerprints.complete(requestFingerprint, requestId, event, fields);
      return true;
    };
    const rejectRequest = (status, type, message, extraHeaders = {}) => {
      terminal('request_rejected', { status, reason: type }, 'warn');
      return jsonResponse(response, status, formatJsonError(type, message, requestId), extraHeaders);
    };

    const selectedRoute = guardedRoutes.get(path);
    requestLogger.info('request_started', {
      guarded: guardedRoutes.has(path),
      ...(selectedRoute ? { behaviorGuardsEnabled: selectedRoute.behaviorGuardsEnabled !== false } : {}),
    });
    metrics.requestsTotal += 1;
    metrics.activeRequests += 1;
    const clientController = new AbortController();
    const onAbort = () => {
      if (!clientController.signal.aborted) {
        requestLogger.warn('client_disconnect_detected', { elapsedMs: elapsedMs() });
        metrics.clientCancellationsTotal += 1;
        clientController.abort('client_cancelled');
      }
    };
    request.once('aborted', onAbort);
    response.once('close', () => { if (!response.writableFinished) onAbort(); });

    try {
      if (!guardedRoutes.has(path)) {
        metrics.passthroughTotal += 1;
        requestLogger.debug('passthrough_started', { upstreamUrl: `${config.vllmBaseUrl}${parsedUrl.pathname}` });
        let body = null;
        if (!['GET', 'HEAD'].includes(request.method || 'GET')) body = await readRequestBody(request, config.maxRequestBodyBytes);
        const upstream = await fetchImpl(`${config.vllmBaseUrl}${parsedUrl.pathname}${parsedUrl.search}`, {
          method: request.method,
          headers: buildUpstreamHeaders(request, config, requestId),
          body,
          signal: clientController.signal,
        });
        response.writeHead(upstream.status, copyResponseHeaders(upstream.headers));
        await writeNodeResponseBody(response, upstream.body);
        await endResponseAndWait(response);
        terminal('request_completed', { mode: 'passthrough', status: upstream.status });
        return;
      }

      if (request.method !== 'POST') return rejectRequest(405, 'method_not_allowed', 'guarded endpoint requires POST', { allow: 'POST' });
      const route = guardedRoutes.get(path);
      let rawRequest;
      try {
        rawRequest = await readRequestBody(request, config.maxRequestBodyBytes);
      } catch (error) {
        return rejectRequest(413, error.code || 'request_body_limit', error.message);
      }
      requestFingerprint = fingerprintRequest(path, rawRequest);
      const retry = requestFingerprints.observe(requestFingerprint, requestId);
      const requestFingerprintShort = requestFingerprint.slice(0, 16);
      requestLogger.debug('request_fingerprint_registered', { requestFingerprint: requestFingerprintShort });
      if (retry) {
        const previousFields = retry.previousTerminalFields || {};
        const retryFields = {
          requestFingerprint: requestFingerprintShort,
          previousRequestId: retry.previousRequestId,
          previousTerminalEvent: retry.previousTerminalEvent,
          previousFailureReason: previousFields.reason || null,
          previousFailureKind: previousFields.kind || null,
          previousRetryable: previousFields.retryable ?? null,
          retryDelayMs: retry.retryDelayMs,
          retryDelayAfterTerminalMs: retry.retryDelayAfterTerminalMs,
          previousRequestDurationMs: retry.previousRequestDurationMs,
          requestStartIntervalMs: retry.requestStartIntervalMs,
          retryOrdinal: retry.retryOrdinal,
        };
        const retryLevel = !retry.previousTerminalEvent || ['request_failed', 'request_cancelled'].includes(retry.previousTerminalEvent) ? 'warn' : 'debug';
        metrics.clientRetriesDetectedTotal += 1;
        requestLogger[retryLevel]('client_retry_detected', retryFields);
      }

      let originalBody;
      try {
        originalBody = JSON.parse(rawRequest.toString('utf8'));
      } catch {
        return rejectRequest(400, 'invalid_request_json', 'request body must be valid JSON');
      }

      const toolResultContext = summarizeToolResultContext(originalBody);
      if (toolResultContext.history.length > 0) {
        const latestToolResults = toolResultContext.latestTurn;
        const matches = correlations.resolve(latestToolResults);
        const parentRequestIds = [...new Set(matches.map((match) => match.parentRequestId))];
        const latestToolCallIds = latestToolResults.map((result) => result.id).filter(Boolean);
        requestLogger.debug('tool_result_context', {
          historyCount: toolResultContext.history.length,
          latestTurnCount: latestToolResults.length,
          correlatedCount: matches.length,
          historyToolCallIds: toolResultContext.history.map((result) => result.id).filter(Boolean),
          latestTurnToolCallIds: latestToolCallIds,
          parentRequestIds,
        });
        if (latestToolResults.length > 0) {
          requestLogger.info('tool_results_received', {
            count: latestToolResults.length,
            historyCount: toolResultContext.history.length,
            toolCallIds: latestToolCallIds,
            parentRequestIds,
            toolRoundTripMs: matches.length > 0 ? Math.max(...matches.map((match) => match.roundTripMs)) : null,
            correlatedCount: matches.length,
          });
        }
        if (config.logToolPayloads && requestLogger.isEnabled('trace')) {
          requestLogger.trace('tool_results_payload', { preview: payloadPreview(latestToolResults, config.logToolPayloadMaxBytes) });
        }
      }

      let firstBody;
      try {
        firstBody = route.prepareRequest(originalBody, { recovery: false, config });
      } catch (error) {
        const type = error?.code || 'invalid_request';
        if (type === 'required_hosted_tool_unavailable') metrics.requiredHostedToolsRejectedTotal += 1;
        terminal('request_rejected', { status: 400, reason: type, ...(error?.details || {}) }, 'warn');
        return jsonResponse(response, 400, formatJsonError(
          type,
          error instanceof Error ? error.message : String(error),
          requestId,
          error?.details || {},
        ));
      }
      const preparedDiagnostics = route.requestDiagnostics
        ? (route.requestDiagnostics(firstBody, { originalBody, config }) || {})
        : {};
      if (route.requestDiagnostics) requestLogger.debug('request_tool_context', preparedDiagnostics);
      route.onPreparedRequest?.({
        body: firstBody,
        originalBody,
        diagnostics: preparedDiagnostics,
        metrics,
        logger: requestLogger,
        config,
      });
      const recordActionlessCompletion = (validation, attemptNumber, recovery) => {
        if (validation?.reason !== 'actionless_completion') return;
        metrics.actionlessCompletionsDetectedTotal += 1;
        if (recovery) metrics.actionlessRecoveriesFusedTotal += 1;
        requestLogger.warn(recovery ? 'actionless_completion_fused' : 'actionless_completion_detected', {
          attempt: attemptNumber,
          phase: recovery ? 'recovery' : 'initial',
          retryable: validation.retryable ?? !recovery,
          ...(validation.diagnostics || {}),
        });
      };
      const streaming = Boolean(firstBody.stream);
      const heartbeat = streaming ? startHeartbeat(response, config.heartbeatIntervalMs) : null;
      let toolPassthroughDelivery = null;
      const createToolPassthrough = (attemptNumber, phase) => {
        if (!route.transparentToolPassthrough) return null;
        return {
          shouldCommit(_snapshot, semanticMetrics) {
            return (semanticMetrics?.toolCallCount || 0) > 0;
          },
          async start({ status, headers, bufferedBody, semanticMetrics }) {
            heartbeat?.stop();
            metrics.toolPassthroughStartedTotal += 1;
            toolPassthroughDelivery = {
              attempt: attemptNumber,
              phase,
              startedAtMono: performance.now(),
              bufferedBytes: bufferedBody.length,
            };
            if (!response.headersSent) response.writeHead(status || 200, copyResponseHeaders(headers));
            requestLogger.info('tool_passthrough_started', {
              attempt: attemptNumber,
              phase,
              bufferedBytes: bufferedBody.length,
              toolCallCount: semanticMetrics?.toolCallCount || 0,
              toolCallIds: semanticMetrics?.toolCallIds || [],
              toolNames: semanticMetrics?.toolNames || [],
              validationMode: 'observe_only',
            });
            await writeResponseChunk(response, bufferedBody);
          },
          async write(chunk) {
            await writeResponseChunk(response, chunk);
          },
          async end() {
            await endResponseAndWait(response);
          },
          async abort({ error }) {
            if (!response.destroyed && !response.writableEnded) response.destroy(error instanceof Error ? error : undefined);
          },
        };
      };
      let lastTransportWarningAtMono = 0;
      let lastSemanticWarningAtMono = 0;
      const emittedToolGrowthWarnings = new Set();
      const debugEnabled = requestLogger.isEnabled('debug');
      const traceEnabled = requestLogger.isEnabled('trace');
      const warnEnabled = requestLogger.isEnabled('warn');
      const emitToolGrowthWarnings = (snapshot, attemptNumber, phase) => {
        if (!warnEnabled) return;
        for (const tool of snapshot.toolCalls || []) {
          const baseKey = `${attemptNumber}:${tool.key}`;
          const fields = {
            attempt: attemptNumber,
            phase,
            toolCallKey: tool.key,
            toolCallIndex: tool.index,
            toolCallId: tool.id || null,
            toolName: tool.name || 'unknown',
            toolArgumentBytes: tool.argumentBytes || 0,
            toolArgumentFragments: tool.argumentFragments || 0,
          };
          if (config.toolArgumentWarningBytes > 0 && tool.argumentBytes >= config.toolArgumentWarningBytes && !emittedToolGrowthWarnings.has(`${baseKey}:warning`)) {
            emittedToolGrowthWarnings.add(`${baseKey}:warning`);
            metrics.toolArgumentWarningsTotal += 1;
            requestLogger.warn('tool_argument_growth_warning', { ...fields, thresholdBytes: config.toolArgumentWarningBytes });
          }
          if (config.toolArgumentCriticalBytes > 0 && tool.argumentBytes >= config.toolArgumentCriticalBytes && !emittedToolGrowthWarnings.has(`${baseKey}:critical`)) {
            emittedToolGrowthWarnings.add(`${baseKey}:critical`);
            metrics.toolArgumentCriticalTotal += 1;
            requestLogger.warn('tool_argument_growth_critical', { ...fields, thresholdBytes: config.toolArgumentCriticalBytes });
          }
        }
      };
      const makeObserver = (attemptNumber, phase) => {
        if (!debugEnabled && !traceEnabled && !warnEnabled) return null;
        return {
          ...(traceEnabled ? { onChunk(snapshot) { requestLogger.trace('upstream_chunk', { ...snapshot, phase }); } } : {}),
          ...(debugEnabled ? { onState(snapshot) { requestLogger.debug('request_state_changed', { ...snapshot, phase }); } } : {}),
          ...((debugEnabled || warnEnabled) ? {
            onProgress(snapshot) {
              const progress = { ...snapshot, phase };
              emitToolGrowthWarnings(snapshot, attemptNumber, phase);
              if (debugEnabled) requestLogger.debug('request_progress', progress);
              if (!warnEnabled) return;
              const now = performance.now();
              if (snapshot.lastUpstreamActivityMs >= config.progressStallWarningMs && now - lastTransportWarningAtMono >= config.progressStallWarningMs) {
                lastTransportWarningAtMono = now;
                requestLogger.warn('transport_stall', progress);
              }
              if (snapshot.lastSemanticActivityMs >= config.progressStallWarningMs && now - lastSemanticWarningAtMono >= config.progressStallWarningMs) {
                lastSemanticWarningAtMono = now;
                requestLogger.warn('semantic_stall', progress);
              }
            },
          } : {}),
        };
      };
      const attemptArgs = {
        fetchImpl: route.fetchImpl || fetchImpl,
        url: `${config.vllmBaseUrl}${parsedUrl.pathname}${parsedUrl.search}`,
        headers: buildUpstreamHeaders(request, config, requestId),
        streaming,
        adapter: route.adapter,
        config,
        requestId,
        bufferBudget: budget,
        clientSignal: clientController.signal,
        behaviorGuardsEnabled: route.behaviorGuardsEnabled !== false,
      };

      const finalizeRouteAttempt = (attempt, attemptNumber, phase) => {
        const classified = route.classifyAttempt?.(attempt, {
          attemptNumber,
          phase,
          metrics,
          logger: requestLogger,
          config,
        }) || attempt;
        route.observeAttempt?.({
          attempt: classified,
          attemptNumber,
          phase,
          metrics,
          logger: requestLogger,
          config,
        });
        return classified;
      };

      let attempt = await performBufferedAttempt({
        ...attemptArgs,
        requestBody: JSON.stringify(firstBody),
        timeoutMs: config.totalGenerationTimeoutMs,
        observer: makeObserver(1, 'initial'),
        attemptNumber: 1,
        toolPassthrough: createToolPassthrough(1, 'initial'),
      });
      attempt = finalizeRouteAttempt(attempt, 1, 'initial');
      if (route.behaviorGuardsEnabled !== false && attempt.kind === 'success' && route.validateAttempt) {
        const semanticValidation = route.validateAttempt(attempt, { originalBody, firstBody, config });
        if (!semanticValidation.ok) {
          recordActionlessCompletion(semanticValidation, 1, false);
          attempt = {
            ...attempt,
            kind: 'invalid',
            reason: semanticValidation.reason || 'semantic_validation_failed',
            detail: semanticValidation.detail,
            context: semanticValidation.context,
            retryable: semanticValidation.retryable,
            diagnostics: semanticValidation.diagnostics,
            validation: semanticValidation,
          };
        }
      }
      if (attempt.kind === 'loop') {
        metrics.loopsDetectedTotal += 1;
        requestLogger.warn('loop_detected', { reason: attempt.loopInfo.reason, attempt: 1 });
      }
      if (attempt.kind === 'interrupted') metrics.upstreamInterruptionsTotal += 1;
      if (attempt.kind === 'cancelled') {
        terminal('request_cancelled', { reason: attempt.reason || 'client_cancelled' }, 'warn');
        return;
      }

      if (route.behaviorGuardsEnabled !== false && attempt.kind !== 'success' && attempt.kind !== 'tool_passthrough' && !attempt.deliveryCommitted && config.maxRecoveryAttempts > 0 && recoverable(attempt)) {
        metrics.recoveriesTotal += 1;
        requestLogger.info('recovery_started', {
          fromKind: attempt.kind,
          reason: attempt.loopInfo?.reason || attempt.reason || 'attempt_failed',
          ...attemptFailureFields(attempt),
        });
        budget.release(requestId);
        const reason = {
          ok: false,
          kind: attempt.kind,
          reason: attempt.loopInfo?.reason || attempt.reason || 'attempt_failed',
          detail: attempt.detail,
          context: attempt.context,
          retryable: attempt.retryable,
          diagnostics: attempt.diagnostics,
        };
        let recovery;
        try {
          recovery = route.buildRecovery({ originalBody, firstBody, reason, config });
          requestLogger.debug('recovery_request_built', recovery.diagnostics || {});
        } catch (error) {
          heartbeat?.stop();
          requestLogger.warn('recovery_request_rejected', {
            reason: error?.code || 'recovery_build_failed',
            ...(error?.details || {}),
          });
          terminal('request_failed', { kind: 'recovery_build_failed', reason: error instanceof Error ? error.message : String(error) }, 'error');
          return sendGuardedFailure({ response, route, streaming, status: 502, type: 'recovery_build_failed', message: error instanceof Error ? error.message : String(error), requestId, formatJsonError });
        }
        attempt = await performBufferedAttempt({
          ...attemptArgs,
          requestBody: JSON.stringify(recovery.body),
          timeoutMs: config.recoveryTimeoutMs,
          observer: makeObserver(2, 'recovery'),
          attemptNumber: 2,
          toolPassthrough: createToolPassthrough(2, 'recovery'),
        });
        attempt = finalizeRouteAttempt(attempt, 2, 'recovery');
        if (route.behaviorGuardsEnabled !== false && attempt.kind === 'success' && route.validateAttempt) {
          const semanticValidation = route.validateAttempt(attempt, { originalBody, firstBody: recovery.body, config, recovery: true });
          if (!semanticValidation.ok) {
            recordActionlessCompletion(semanticValidation, 2, true);
            attempt = {
              ...attempt,
              kind: 'invalid',
              reason: semanticValidation.reason || 'semantic_validation_failed',
              detail: semanticValidation.detail,
              context: semanticValidation.context,
              retryable: semanticValidation.retryable,
              diagnostics: semanticValidation.diagnostics,
              validation: semanticValidation,
            };
          }
        }
        if (route.behaviorGuardsEnabled !== false && attempt.kind === 'success' && route.validateRecovery) {
          const recoveryValidation = route.validateRecovery(attempt, recovery);
          if (!recoveryValidation.ok) {
            recordActionlessCompletion(recoveryValidation, 2, recovery.plan?.mode === 'action_required');
            attempt = { kind: 'invalid', ...recoveryValidation, result: attempt.result };
          }
        }
        if (attempt.kind === 'success' || attempt.kind === 'tool_passthrough') {
          metrics.recoverySuccessTotal += 1;
          requestLogger.info('recovery_completed', { elapsedMs: elapsedMs() });
        }
      }

      heartbeat?.stop();
      if (attempt.kind === 'tool_passthrough') {
        const output = route.adapter.extractOutput?.(attempt.result) || { toolCalls: [], finalText: '' };
        const toolCalls = Array.isArray(output.toolCalls) ? output.toolCalls : [];
        const validation = streaming
          ? route.adapter.validateStream?.(attempt.result, config)
          : route.adapter.validateJson?.(attempt.result, config);
        if (validation && !validation.ok) {
          metrics.toolPassthroughValidationWarningsTotal += 1;
          requestLogger.warn('tool_passthrough_validation_warning', {
            reason: validation.reason || 'semantic_validation_failed',
            detail: validation.detail || null,
            retryable: validation.retryable ?? false,
            action: 'observe_only',
            ...(validation.diagnostics || {}),
          });
        }

        if (!attempt.deliveryCommitted) {
          metrics.toolPassthroughStartedTotal += 1;
          toolPassthroughDelivery = {
            attempt: attempt.attemptNumber || 1,
            phase: (attempt.attemptNumber || 1) > 1 ? 'recovery' : 'initial',
            startedAtMono: performance.now(),
            bufferedBytes: attempt.rawBody?.length || 0,
          };
          requestLogger.info('tool_passthrough_started', {
            attempt: attempt.attemptNumber || 1,
            phase: (attempt.attemptNumber || 1) > 1 ? 'recovery' : 'initial',
            bufferedBytes: attempt.rawBody?.length || 0,
            toolCallCount: toolCalls.length,
            toolCallIds: toolCalls.map((tool) => tool.id || tool.call_id).filter(Boolean),
            toolNames: toolCalls.map((tool) => tool.name || tool.function?.name || 'unknown'),
            validationMode: 'observe_only',
            streaming: false,
          });
          try {
            await sendBufferedSuccess(response, attempt);
          } catch (error) {
            metrics.toolPassthroughInterruptionsTotal += 1;
            terminal('request_failed', { kind: 'tool_passthrough_delivery_failed', reason: error instanceof Error ? error.message : String(error), deliveryCommitted: false }, 'error');
            return;
          }
        }

        metrics.toolPassthroughCompletedTotal += 1;
        const deliveryDurationMs = toolPassthroughDelivery
          ? Math.max(0, Math.round(performance.now() - toolPassthroughDelivery.startedAtMono))
          : 0;
        requestLogger.info('tool_passthrough_completed', {
          attempt: toolPassthroughDelivery?.attempt || 1,
          phase: toolPassthroughDelivery?.phase || 'initial',
          upstreamBytes: attempt.upstreamBytes ?? attempt.rawBody?.length ?? 0,
          bufferedBytesAtCommit: attempt.bufferedBytesAtCommit ?? toolPassthroughDelivery?.bufferedBytes ?? 0,
          deliveryDurationMs,
          toolCallCount: toolCalls.length,
          validationMode: 'observe_only',
          observationError: attempt.observationError || null,
          ...(route.adapter.completionDiagnostics?.(attempt.result) || {}),
        });
        if (toolCalls.length > 0) {
          correlations.register(requestId, toolCalls);
          requestLogger.info('tool_calls_delivered', {
            count: toolCalls.length,
            tools: toolLogEntries(toolCalls, config, false),
            validationMode: 'observe_only',
          });
        }
        terminal('request_completed', {
          mode: 'tool_passthrough',
          status: attempt.status || 200,
          upstreamBytes: attempt.upstreamBytes ?? attempt.rawBody?.length ?? 0,
          toolCallCount: toolCalls.length,
          finalTextChars: typeof output.finalText === 'string' ? output.finalText.length : 0,
          deliveryCommitted: Boolean(attempt.deliveryCommitted),
          deliveryDurationMs,
          ...(route.adapter.completionDiagnostics?.(attempt.result) || {}),
        });
        return;
      }
      if (attempt.kind === 'success') {
        const output = route.adapter.extractOutput?.(attempt.result) || { toolCalls: [], finalText: '' };
        const toolCalls = Array.isArray(output.toolCalls) ? output.toolCalls : [];
        const includePayload = config.logToolPayloads && requestLogger.isEnabled('trace');
        if (toolCalls.length > 0) {
          const tools = toolLogEntries(toolCalls, config, false);
          requestLogger.info('tool_calls_ready', { count: toolCalls.length, tools });
          if (debugEnabled) requestLogger.debug('tool_calls_generated', { count: toolCalls.length, tools });
          if (includePayload) requestLogger.trace('tool_calls_payload', { tools: toolLogEntries(toolCalls, config, true) });
        }

        const replayStartedAtMono = performance.now();
        const replayLevel = toolCalls.length > 0 ? 'info' : 'debug';
        if (debugEnabled) requestLogger.debug('request_state_changed', { state: 'response_replaying', phase: 'delivery' });
        requestLogger[replayLevel]('response_replay_started', { bytes: attempt.rawBody?.length || 0, toolCallCount: toolCalls.length });
        try {
          await sendBufferedSuccess(response, attempt);
        } catch (error) {
          metrics.responseReplayInterruptionsTotal += 1;
          terminal('request_failed', { kind: 'response_replay_interrupted', reason: error instanceof Error ? error.message : String(error) }, 'error');
          return;
        }
        const replayDurationMs = Math.max(0, Math.round(performance.now() - replayStartedAtMono));
        requestLogger[replayLevel]('response_replay_completed', { bytes: attempt.rawBody?.length || 0, replayDurationMs });
        if (toolCalls.length > 0) {
          correlations.register(requestId, toolCalls);
          requestLogger.info('tool_calls_delivered', {
            count: toolCalls.length,
            tools: toolLogEntries(toolCalls, config, false),
          });
        }
        terminal('request_completed', {
          mode: route.behaviorGuardsEnabled === false ? 'protocol_proxy' : 'guarded',
          status: attempt.status || 200,
          upstreamBytes: attempt.rawBody?.length || 0,
          toolCallCount: toolCalls.length,
          finalTextChars: typeof output.finalText === 'string' ? output.finalText.length : 0,
          replayDurationMs,
          ...(route.adapter.completionDiagnostics?.(attempt.result) || {}),
        });
        return;
      }
      if (attempt.kind === 'cancelled') {
        terminal('request_cancelled', { reason: attempt.reason || 'client_cancelled' }, 'warn');
        return;
      }
      if (attempt.deliveryCommitted) {
        metrics.toolPassthroughInterruptionsTotal += 1;
        const failureFields = attemptFailureFields(attempt);
        terminal('request_failed', {
          kind: attempt.kind,
          reason: attempt.reason || attempt.loopInfo?.reason || 'tool_passthrough_interrupted',
          deliveryCommitted: true,
          ...failureFields,
        }, 'error');
        return;
      }
      metrics.validationFailuresTotal += 1;
      const failureFields = attemptFailureFields(attempt);
      terminal('request_failed', {
        kind: attempt.kind,
        reason: attempt.reason || attempt.loopInfo?.reason || 'unknown',
        ...failureFields,
      }, 'error');
      const status = attempt.kind === 'http_error' && attempt.status < 500 ? attempt.status : 502;
      return sendGuardedFailure({
        response,
        route,
        streaming,
        status,
        type: attempt.reason || attempt.kind || 'proxy_generation_failed',
        message: errorMessage(attempt),
        requestId,
        formatJsonError,
        extra: failureFields,
      });
    } catch (error) {
      terminal('request_failed', { kind: 'proxy_error', reason: error instanceof Error ? error.message : String(error) }, 'error');
      if (!clientController.signal.aborted) {
        jsonResponse(response, 502, formatJsonError('proxy_error', error instanceof Error ? error.message : String(error), requestId));
      }
    } finally {
      if (!terminalEvent) {
        if (clientController.signal.aborted) terminal('request_cancelled', { reason: clientController.signal.reason || 'client_cancelled' }, 'warn');
        else terminal('request_failed', { kind: 'non_terminal_exit', reason: 'request exited without terminal state' }, 'error');
      }
      budget.release(requestId);
      metrics.activeRequests = Math.max(0, metrics.activeRequests - 1);
      request.removeListener('aborted', onAbort);
    }
  };

  return {
    name,
    metricPrefix,
    config,
    handle,
    metrics,
    renderMetrics() { return renderProtocolMetrics(metrics, metricPrefix); },
    beginDrain() { draining = true; },
    isDraining() { return draining; },
  };
}

export function createManagedHttpServer({ handler, config }) {
  const sockets = new Set();
  let started = false;

  const server = http.createServer({
    keepAlive: true,
    keepAliveInitialDelay: 15000,
    noDelay: true,
    requestTimeout: 0,
  }, handler);

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  return {
    server,
    async start() {
      if (!started) {
        server.listen(config.port, config.host);
        await once(server, 'listening');
        started = true;
      }
      const address = server.address();
      const host = typeof address === 'object' && address?.address && !['0.0.0.0', '::'].includes(address.address) ? address.address : '127.0.0.1';
      return `http://${host}:${typeof address === 'object' ? address.port : config.port}`;
    },
    async stop() {
      if (!started) return;
      const deadline = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, config.shutdownGraceMs);
      deadline.unref?.();
      server.close();
      await once(server, 'close').catch(() => {});
      clearTimeout(deadline);
      started = false;
    },
  };
}

export function createProtocolProxyServer(options) {
  const runtime = createProtocolProxyRuntime(options);
  const managed = createManagedHttpServer({ handler: runtime.handle, config: options.config });
  return {
    ...runtime,
    ...managed,
    async stop() {
      runtime.beginDrain();
      await managed.stop();
    },
  };
}
