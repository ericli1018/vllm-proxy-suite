import test from 'node:test';
import assert from 'node:assert/strict';

import { createLogger } from '../packages/core/logger.js';
import { performBufferedAttempt } from '../packages/core/attempt-runner.js';
import { BufferBudget } from '../packages/core/buffer-budget.js';
import { loadCommonConfig } from '../packages/core/config.js';
import { SseFrameDecoder } from '../packages/core/sse.js';

function adapter() {
  return {
    createStreamParser() {
      const decoder = new SseFrameDecoder();
      const values = [];
      return {
        push(chunk) {
          for (const frame of decoder.push(chunk)) {
            if (frame.data !== '[DONE]') values.push(JSON.parse(frame.data));
          }
        },
        snapshot() { return { values: [...values] }; },
        finish() { decoder.finish(); return { values }; },
      };
    },
    getReasoning(result) { return result.values.map((value) => value.reasoning || '').filter(Boolean); },
    semanticProgress(result) { return result.values.length; },
    validateStream(result) { return result.values.length ? { ok: true } : { ok: false, reason: 'empty' }; },
    extractOutput(result) {
      return {
        finalText: result.values.map((value) => value.content || '').join(''),
        toolCalls: result.values.flatMap((value) => value.toolCalls || []),
      };
    },
  };
}

test('logger filters events below configured level and preserves context', () => {
  const rows = [];
  const logger = createLogger({ logLevel: 'info', logFormat: 'json' }, (line) => rows.push(JSON.parse(line)));
  const requestLogger = logger.child({ service: 'openai', requestId: 'req-1' });

  requestLogger.debug('request_progress', { bytes: 10 });
  requestLogger.info('request_started', { path: '/v1/chat/completions' });
  requestLogger.warn('semantic_stall', { idleMs: 30000 });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.level), ['info', 'warn']);
  assert.equal(rows[0].service, 'openai');
  assert.equal(rows[0].requestId, 'req-1');
  assert.equal(rows[0].event, 'request_started');
});

test('debug progress reports average and recent throughput while streaming', async () => {
  const progress = [];
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode('data: {"reasoning":"one"}\n\n'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.enqueue(encoder.encode('data: {"reasoning":"two"}\n\n'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });

  const result = await performBufferedAttempt({
    fetchImpl: async () => response,
    url: 'http://upstream/v1/chat/completions',
    headers: {},
    requestBody: '{}',
    streaming: true,
    adapter: adapter(),
    config: { ...loadCommonConfig({}), progressLogIntervalMs: 10 },
    requestId: 'progress-1',
    bufferBudget: new BufferBudget(4096),
    timeoutMs: 1000,
    observer: { onProgress: (snapshot) => progress.push(snapshot) },
  });

  assert.equal(result.kind, 'success');
  assert.ok(progress.length >= 2);
  assert.ok(progress.some((item) => item.upstreamBytes > 0));
  assert.ok(progress.some((item) => item.averageBytesPerSec > 0));
  assert.ok(progress.some((item) => item.recentBytesPerSec >= 0));
  assert.ok(progress.every((item) => item.requestId === 'progress-1'));
  assert.ok(progress.some((item) => item.semanticProgress >= 1));
});

test('loadCommonConfig exposes logging and progress controls', () => {
  const config = loadCommonConfig({
    LOG_LEVEL: 'debug',
    LOG_FORMAT: 'text',
    PROGRESS_LOG_INTERVAL_MS: '10000',
    PROGRESS_STALL_WARNING_MS: '30000',
    LOG_TOOL_PAYLOADS: 'true',
    LOG_TOOL_PAYLOAD_MAX_BYTES: '2048',
  });
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.logFormat, 'text');
  assert.equal(config.progressLogIntervalMs, 10000);
  assert.equal(config.progressStallWarningMs, 30000);
  assert.equal(config.logToolPayloads, true);
  assert.equal(config.logToolPayloadMaxBytes, 2048);
});

import http from 'node:http';
import { once } from 'node:events';
import { createProtocolProxyServer } from '../packages/server/create-proxy-server.js';
import { chatCompletionsAdapter } from '../packages/openai/chat-completions.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('protocol runtime emits info lifecycle and debug progress without payload contents', async (t) => {
  const logs = [];
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"reasoning":"secret reasoning"}}]}\n\n');
    setTimeout(() => res.end('data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), 30);
  });
  const upstreamUrl = await listen(upstream);
  const config = { ...loadCommonConfig({
    LOG_LEVEL: 'debug', LOG_FORMAT: 'json', PROXY_API_KEY: 'client', VLLM_BASE_URL: upstreamUrl,
    PROGRESS_LOG_INTERVAL_MS: '1000', HEARTBEAT_INTERVAL_MS: '60000', UPSTREAM_IDLE_TIMEOUT_MS: '5000',
  }), port: 0, progressLogIntervalMs: 10 };
  const suite = createProtocolProxyServer({
    name: 'test-openai', metricPrefix: 'test_openai', config,
    guardedRoutes: new Map([['/v1/chat/completions', {
      adapter: chatCompletionsAdapter,
      prepareRequest: (body) => structuredClone(body),
      buildRecovery: () => { throw new Error('not expected'); },
    }]]),
    allowPassthrough: () => false,
    formatJsonError: (type, message, requestId) => ({ error: { type, message, requestId } }),
    logSink: (line) => logs.push(JSON.parse(line)),
  });
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  });
  await response.text();

  assert.ok(logs.some((row) => row.level === 'info' && row.event === 'request_started'));
  assert.ok(logs.some((row) => row.level === 'debug' && row.event === 'request_progress' && row.upstreamBytes > 0));
  assert.ok(logs.some((row) => row.level === 'info' && row.event === 'request_completed'));
  assert.ok(logs.every((row) => !JSON.stringify(row).includes('secret reasoning')));
});
