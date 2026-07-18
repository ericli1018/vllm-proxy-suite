import { randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';

import { BufferBudget } from '../core/buffer-budget.js';
import { performBufferedAttempt } from '../core/attempt-runner.js';
import { buildUpstreamHeaders, copyResponseHeaders, jsonResponse, readRequestBody, writeNodeResponseBody } from '../core/http.js';
import { createLogger } from '../core/logger.js';

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




function summarizeToolResults(body) {
  const summaries = [];
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role === 'tool') {
      summaries.push({ id: message.tool_call_id || null, name: message.name || null });
      continue;
    }
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type === 'tool_result') summaries.push({ id: block.tool_use_id || null, isError: Boolean(block.is_error) });
    }
  }
  return summaries;
}

function recoverable(attempt) {
  if (attempt.kind === 'loop' || attempt.kind === 'invalid' || attempt.kind === 'interrupted') return true;
  return attempt.kind === 'http_error' && attempt.status >= 500;
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

async function sendBufferedSuccess(response, attempt) {
  if (!response.headersSent) {
    response.writeHead(attempt.status || 200, copyResponseHeaders(attempt.headers, { bodyLength: attempt.rawBody.length }));
  }
  response.end(attempt.rawBody);
}

async function sendGuardedFailure({ response, route, streaming, status, type, message, requestId, formatJsonError }) {
  const error = { message, type, param: null, code: type, request_id: requestId };
  if (streaming) {
    if (!response.headersSent) {
      response.writeHead(status, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
    }
    response.end(route.adapter.streamError(error));
    return;
  }
  jsonResponse(response, status, formatJsonError(type, message, requestId));
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
    const requestStartedAt = Date.now();
    const requestLogger = rootLogger.child({ service: name, requestId, protocol: metricPrefix, path, method: request.method });
    requestLogger.info('request_started', { guarded: guardedRoutes.has(path) });
    metrics.requestsTotal += 1;
    metrics.activeRequests += 1;
    const clientController = new AbortController();
    const onAbort = () => {
      if (!clientController.signal.aborted) {
        requestLogger.warn('client_cancelled', { elapsedMs: Date.now() - requestStartedAt });
        metrics.clientCancellationsTotal += 1;
        clientController.abort('client_cancelled');
      }
    };
    request.once('aborted', onAbort);
    response.once('close', () => { if (!response.writableEnded) onAbort(); });

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
        response.end();
        requestLogger.info('request_completed', { mode: 'passthrough', status: upstream.status, elapsedMs: Date.now() - requestStartedAt });
        return;
      }

      if (request.method !== 'POST') return jsonResponse(response, 405, formatJsonError('method_not_allowed', 'guarded endpoint requires POST', requestId), { allow: 'POST' });
      const route = guardedRoutes.get(path);
      let rawRequest;
      try {
        rawRequest = await readRequestBody(request, config.maxRequestBodyBytes);
      } catch (error) {
        return jsonResponse(response, 413, formatJsonError(error.code || 'request_body_limit', error.message, requestId));
      }
      let originalBody;
      try {
        originalBody = JSON.parse(rawRequest.toString('utf8'));
      } catch {
        return jsonResponse(response, 400, formatJsonError('invalid_request_json', 'request body must be valid JSON', requestId));
      }
      const toolResults = summarizeToolResults(originalBody);
      if (toolResults.length > 0) requestLogger.info('tool_results_received', { count: toolResults.length, results: toolResults });
      let firstBody;
      try {
        firstBody = route.prepareRequest(originalBody, { recovery: false, config });
      } catch (error) {
        return jsonResponse(response, 400, formatJsonError('invalid_request', error instanceof Error ? error.message : String(error), requestId));
      }
      const streaming = Boolean(firstBody.stream);
      const heartbeat = streaming ? startHeartbeat(response, config.heartbeatIntervalMs) : null;
      let lastTransportWarningAt = 0;
      let lastSemanticWarningAt = 0;
      const makeObserver = (attemptNumber, phase) => ({
        onChunk(snapshot) { requestLogger.trace('upstream_chunk', { ...snapshot, phase }); },
        onProgress(snapshot) {
          const progress = { ...snapshot, phase, state: snapshot.state };
          requestLogger.debug('request_progress', progress);
          const now = Date.now();
          if (snapshot.lastUpstreamActivityMs >= config.progressStallWarningMs && now - lastTransportWarningAt >= config.progressStallWarningMs) {
            lastTransportWarningAt = now;
            requestLogger.warn('transport_stall', progress);
          }
          if (snapshot.lastSemanticActivityMs >= config.progressStallWarningMs && now - lastSemanticWarningAt >= config.progressStallWarningMs) {
            lastSemanticWarningAt = now;
            requestLogger.warn('semantic_stall', progress);
          }
        },
      });
      const attemptArgs = {
        fetchImpl,
        url: `${config.vllmBaseUrl}${parsedUrl.pathname}${parsedUrl.search}`,
        headers: buildUpstreamHeaders(request, config, requestId),
        streaming,
        adapter: route.adapter,
        config,
        requestId,
        bufferBudget: budget,
        clientSignal: clientController.signal,
      };

      let attempt = await performBufferedAttempt({
        ...attemptArgs,
        requestBody: JSON.stringify(firstBody),
        timeoutMs: config.totalGenerationTimeoutMs,
        observer: makeObserver(1, 'initial'),
        attemptNumber: 1,
      });
      if (attempt.kind === 'success' && route.validateAttempt) {
        const semanticValidation = route.validateAttempt(attempt, {
          originalBody,
          firstBody,
          config,
        });
        if (!semanticValidation.ok) {
          attempt = {
            ...attempt,
            kind: 'invalid',
            reason: semanticValidation.reason || 'semantic_validation_failed',
            detail: semanticValidation.detail,
            context: semanticValidation.context,
            validation: semanticValidation,
          };
        }
      }
      if (attempt.kind === 'loop') {
        metrics.loopsDetectedTotal += 1;
        requestLogger.warn('loop_detected', { reason: attempt.loopInfo.reason, attempt: 1 });
      }
      if (attempt.kind === 'interrupted') metrics.upstreamInterruptionsTotal += 1;
      if (attempt.kind === 'cancelled') return;

      if (attempt.kind !== 'success' && config.maxRecoveryAttempts > 0 && recoverable(attempt)) {
        metrics.recoveriesTotal += 1;
        requestLogger.info('recovery_started', { fromKind: attempt.kind, reason: attempt.loopInfo?.reason || attempt.reason || 'attempt_failed' });
        budget.release(requestId);
        const reason = {
          ok: false,
          kind: attempt.kind,
          reason: attempt.loopInfo?.reason || attempt.reason || 'attempt_failed',
          detail: attempt.detail,
          context: attempt.context,
        };
        let recovery;
        try {
          recovery = route.buildRecovery({ originalBody, firstBody, reason, config });
        } catch (error) {
          heartbeat?.stop();
          return sendGuardedFailure({ response, route, streaming, status: 502, type: 'recovery_build_failed', message: error instanceof Error ? error.message : String(error), requestId, formatJsonError });
        }
        attempt = await performBufferedAttempt({
          ...attemptArgs,
          requestBody: JSON.stringify(recovery.body),
          timeoutMs: config.recoveryTimeoutMs,
          observer: makeObserver(2, 'recovery'),
          attemptNumber: 2,
        });
        if (attempt.kind === 'success' && route.validateAttempt) {
          const semanticValidation = route.validateAttempt(attempt, {
            originalBody,
            firstBody: recovery.body,
            config,
            recovery: true,
          });
          if (!semanticValidation.ok) {
            attempt = {
              ...attempt,
              kind: 'invalid',
              reason: semanticValidation.reason || 'semantic_validation_failed',
              detail: semanticValidation.detail,
              context: semanticValidation.context,
              validation: semanticValidation,
            };
          }
        }
        if (attempt.kind === 'success' && route.validateRecovery) {
          const recoveryValidation = route.validateRecovery(attempt, recovery);
          if (!recoveryValidation.ok) attempt = { kind: 'invalid', ...recoveryValidation, result: attempt.result };
        }
        if (attempt.kind === 'success') {
          metrics.recoverySuccessTotal += 1;
          requestLogger.info('recovery_completed', { elapsedMs: Date.now() - requestStartedAt });
        }
      }

      heartbeat?.stop();
      if (attempt.kind === 'success') {
        const output = route.adapter.extractOutput?.(attempt.result) || { toolCalls: [], finalText: '' };
        const toolCalls = Array.isArray(output.toolCalls) ? output.toolCalls : [];
        if (toolCalls.length > 0) {
          requestLogger.info('tool_calls_generated', {
            count: toolCalls.length,
            tools: toolCalls.map((tool) => ({ name: tool.name || tool.function?.name || 'unknown', id: tool.id || null })),
          });
        }
        await sendBufferedSuccess(response, attempt);
        requestLogger.info('request_completed', {
          mode: 'guarded',
          status: attempt.status || 200,
          elapsedMs: Date.now() - requestStartedAt,
          upstreamBytes: attempt.rawBody?.length || 0,
          toolCallCount: toolCalls.length,
          finalTextChars: typeof output.finalText === 'string' ? output.finalText.length : 0,
        });
        return;
      }
      if (attempt.kind === 'cancelled') return;
      metrics.validationFailuresTotal += 1;
      requestLogger.error('request_failed', { kind: attempt.kind, reason: attempt.reason || attempt.loopInfo?.reason || 'unknown', elapsedMs: Date.now() - requestStartedAt });
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
      });
    } catch (error) {
      requestLogger.error('proxy_error', { message: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - requestStartedAt });
      if (!clientController.signal.aborted) {
        jsonResponse(response, 502, formatJsonError('proxy_error', error instanceof Error ? error.message : String(error), requestId));
      }
    } finally {
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
