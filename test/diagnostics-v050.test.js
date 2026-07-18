import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createLogger } from '../packages/core/logger.js';
import { performBufferedAttempt } from '../packages/core/attempt-runner.js';
import { BufferBudget } from '../packages/core/buffer-budget.js';
import { loadCommonConfig } from '../packages/core/config.js';
import { chatCompletionsAdapter } from '../packages/openai/chat-completions.js';
import { responsesAdapter } from '../packages/openai/responses.js';
import { anthropicMessagesAdapter } from '../packages/anthropic/messages.js';
import { createProtocolProxyServer } from '../packages/server/create-proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function streamResponse(parts, delayMs = 5) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('semantic metrics exclude protocol events and include fragmented tool arguments', () => {
  const config = loadCommonConfig({});
  const chat = chatCompletionsAdapter.createStreamParser(config);
  chat.push('data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n');
  const metadataOnly = chatCompletionsAdapter.semanticMetrics(chat.snapshot());
  assert.equal(metadataOnly.semanticBytes, 0);
  assert.equal(metadataOnly.sseEvents, 1);
  chat.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"Read","arguments":"{\\"file_path\\":"}}]}}]}\n\n');
  const withTool = chatCompletionsAdapter.semanticMetrics(chat.snapshot());
  assert.ok(withTool.toolNameBytes > 0);
  assert.ok(withTool.toolArgumentBytes > 0);
  assert.equal(withTool.semanticBytes, withTool.toolNameBytes + withTool.toolArgumentBytes);

  const responses = responsesAdapter.createStreamParser(config);
  responses.push('event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n');
  assert.equal(responsesAdapter.semanticMetrics(responses.snapshot()).semanticBytes, 0);
  responses.push('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"f1","delta":"{\\"q\\":1}"}\n\n');
  assert.ok(responsesAdapter.semanticMetrics(responses.snapshot()).toolArgumentBytes > 0);

  const anthropic = anthropicMessagesAdapter.createStreamParser(config);
  anthropic.push('event: ping\ndata: {"type":"ping"}\n\n');
  assert.equal(anthropicMessagesAdapter.semanticMetrics(anthropic.snapshot()).semanticBytes, 0);
});

test('attempt progress separates upstream chunks, SSE events, and semantic byte counters', async () => {
  const progress = [];
  const response = streamResponse([
    'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"reasoning":"abc"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"Read","arguments":"{\\"file_path\\":\\"/tmp/a\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
  ]);
  const budget = new BufferBudget(1024 * 1024);
  const result = await performBufferedAttempt({
    fetchImpl: async () => response,
    url: 'http://upstream/v1/chat/completions',
    headers: {},
    requestBody: '{}',
    streaming: true,
    adapter: chatCompletionsAdapter,
    config: { ...loadCommonConfig({}), progressLogIntervalMs: 2 },
    requestId: 'diag-1',
    bufferBudget: budget,
    timeoutMs: 1000,
    observer: { onProgress: (snapshot) => progress.push(snapshot) },
  });
  assert.equal(result.kind, 'success');
  const final = progress.at(-1);
  assert.equal(final.upstreamChunks, 2);
  assert.equal(final.sseEvents, 4);
  assert.equal(final.reasoningBytes, 3);
  assert.ok(final.toolArgumentBytes > 0);
  assert.equal(final.semanticBytes, final.reasoningBytes + final.contentBytes + final.toolNameBytes + final.toolArgumentBytes);
  assert.equal(final.rawBufferedBytes, final.upstreamBytes);
  assert.equal(final.globalBufferedBytes, budget.total);
  assert.ok(final.timeToHeadersMs >= 0);
  assert.ok(final.timeToFirstByteMs >= final.timeToHeadersMs);
  assert.ok(final.timeToFirstSemanticMs >= final.timeToHeadersMs);
  assert.equal(final.state, 'attempt_validating');
});

test('text logger escapes control characters and protects reserved record fields', () => {
  const rows = [];
  const logger = createLogger({ logLevel: 'debug', logFormat: 'text' }, (line) => rows.push(line), { service: 'svc' });
  logger.info('safe_event', { event: 'forged', level: 'error', timestamp: 'bad', message: 'line1\nline2\tend' });
  assert.equal(rows.length, 1);
  assert.match(rows[0], /event=safe_event/);
  assert.doesNotMatch(rows[0], /event=forged/);
  assert.doesNotMatch(rows[0], /level=error/);
  assert.match(rows[0], /line1\\nline2\\tend/);
  assert.equal(rows[0].split('\n').length, 1);
});

test('runtime logs response replay completion before request completion and correlates tool results', async (t) => {
  const logs = [];
  let upstreamRequests = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    upstreamRequests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (upstreamRequests === 1) {
      res.end('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"Read","arguments":"{\\"file_path\\":\\"/tmp/a\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    } else {
      res.end('data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
  });
  const upstreamUrl = await listen(upstream);
  const config = { ...loadCommonConfig({
    LOG_LEVEL: 'debug', LOG_FORMAT: 'json', PROXY_API_KEY: 'client', VLLM_BASE_URL: upstreamUrl,
    HEARTBEAT_INTERVAL_MS: '60000', UPSTREAM_IDLE_TIMEOUT_MS: '5000',
  }), port: 0 };
  const suite = createProtocolProxyServer({
    name: 'test-openai', metricPrefix: 'test_openai', config,
    guardedRoutes: new Map([['/v1/chat/completions', {
      adapter: chatCompletionsAdapter,
      prepareRequest: (body) => structuredClone(body),
      buildRecovery: () => { throw new Error('not expected'); },
    }]]),
    allowPassthrough: () => false,
    formatJsonError: (type, message, requestId) => ({ error: { type, message, request_id: requestId } }),
    logSink: (line) => logs.push(JSON.parse(line)),
  });
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const first = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'read' }] }),
  });
  await first.text();
  const firstId = logs.find((row) => row.event === 'request_started')?.requestId;
  const replayStarted = logs.findIndex((row) => row.requestId === firstId && row.event === 'response_replay_started');
  const replayCompleted = logs.findIndex((row) => row.requestId === firstId && row.event === 'response_replay_completed');
  const toolDelivered = logs.findIndex((row) => row.requestId === firstId && row.event === 'tool_calls_delivered');
  const completed = logs.findIndex((row) => row.requestId === firstId && row.event === 'request_completed');
  assert.ok(replayStarted >= 0 && replayCompleted > replayStarted && toolDelivered > replayCompleted && completed > toolDelivered);

  const second = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true,
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/tmp/a"}' } }] },
        { role: 'tool', tool_call_id: 'call_123', content: 'file data' },
      ],
    }),
  });
  await second.text();
  const resultLog = logs.find((row) => row.event === 'tool_results_received' && row.parentRequestIds?.includes(firstId));
  assert.ok(resultLog);
  assert.deepEqual(resultLog.toolCallIds, ['call_123']);
  assert.ok(resultLog.toolRoundTripMs >= 0);
});

test('Responses function_call_output is summarized as a tool result', async (t) => {
  const logs = [];
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] }));
  });
  const upstreamUrl = await listen(upstream);
  const config = { ...loadCommonConfig({ LOG_LEVEL: 'info', LOG_FORMAT: 'json', PROXY_API_KEY: 'client', VLLM_BASE_URL: upstreamUrl }), port: 0 };
  const suite = createProtocolProxyServer({
    name: 'test-openai', metricPrefix: 'test_openai', config,
    guardedRoutes: new Map([['/v1/responses', {
      adapter: responsesAdapter,
      prepareRequest: (body) => structuredClone(body),
      buildRecovery: () => { throw new Error('not expected'); },
    }]]),
    allowPassthrough: () => false,
    formatJsonError: (type, message, requestId) => ({ error: { type, message, request_id: requestId } }),
    logSink: (line) => logs.push(JSON.parse(line)),
  });
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });
  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, input: [{ type: 'function_call_output', call_id: 'fc_1', output: 'ok' }] }),
  });
  assert.equal(response.status, 200);
  await response.text();
  const row = logs.find((item) => item.event === 'tool_results_received');
  assert.ok(row);
  assert.deepEqual(row.toolCallIds, ['fc_1']);
});

test('guarded request rejection always emits a terminal lifecycle record', async (t) => {
  const logs = [];
  const config = { ...loadCommonConfig({ LOG_LEVEL: 'info', LOG_FORMAT: 'json', PROXY_API_KEY: 'client', VLLM_BASE_URL: 'http://127.0.0.1:1' }), port: 0 };
  const suite = createProtocolProxyServer({
    name: 'test-openai', metricPrefix: 'test_openai', config,
    guardedRoutes: new Map([['/v1/chat/completions', { adapter: chatCompletionsAdapter, prepareRequest: (body) => body }]]),
    allowPassthrough: () => false,
    formatJsonError: (type, message, requestId) => ({ error: { type, message, request_id: requestId } }),
    logSink: (line) => logs.push(JSON.parse(line)),
  });
  const proxyUrl = await suite.start();
  t.after(async () => suite.stop());
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' }, body: '{bad',
  });
  assert.equal(response.status, 400);
  const requestId = logs.find((row) => row.event === 'request_started')?.requestId;
  const terminal = logs.filter((row) => row.requestId === requestId && ['request_completed', 'request_rejected', 'request_failed', 'request_cancelled'].includes(row.event));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].event, 'request_rejected');
});

test('metadata-only SSE traffic does not reset semantic stall detection', async () => {
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    async start(controller) {
      for (let index = 0; index < 8; index += 1) {
        controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n'));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const result = await performBufferedAttempt({
    fetchImpl: async () => response,
    url: 'http://upstream/v1/chat/completions',
    headers: {}, requestBody: '{}', streaming: true,
    adapter: chatCompletionsAdapter,
    config: { ...loadCommonConfig({}), semanticStallTimeoutMs: 25, upstreamIdleTimeoutMs: 1000 },
    requestId: 'metadata-stall', bufferBudget: new BufferBudget(1024 * 1024), timeoutMs: 1000,
  });
  assert.equal(result.kind, 'invalid');
  assert.equal(result.reason, 'semantic_stall_timeout');
});

test('fragmented tool arguments count as semantic activity and prevent false stall', async () => {
  const response = streamResponse([
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"Read","arguments":"{\\"file"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"_path\\":\\"/tmp"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"/a\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
  ], 15);
  const result = await performBufferedAttempt({
    fetchImpl: async () => response,
    url: 'http://upstream/v1/chat/completions',
    headers: {}, requestBody: '{}', streaming: true,
    adapter: chatCompletionsAdapter,
    config: { ...loadCommonConfig({}), semanticStallTimeoutMs: 25, upstreamIdleTimeoutMs: 1000 },
    requestId: 'tool-progress', bufferBudget: new BufferBudget(1024 * 1024), timeoutMs: 1000,
  });
  assert.equal(result.kind, 'success');
  assert.deepEqual(result.result.choices.get(0).toolCalls.get(0).parsedArguments, { file_path: '/tmp/a' });
});

test('trace tool payload previews are opt-in, redacted, and absent from info tool records', async (t) => {
  const logs = [];
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"secret_call","type":"function","function":{"name":"remote","arguments":"{\\"api_key\\":\\"super-secret\\",\\"query\\":\\"docs\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const config = { ...loadCommonConfig({
    LOG_LEVEL: 'trace', LOG_FORMAT: 'json', LOG_TOOL_PAYLOADS: 'true', LOG_TOOL_PAYLOAD_MAX_BYTES: '512',
    PROXY_API_KEY: 'client', VLLM_BASE_URL: upstreamUrl, HEARTBEAT_INTERVAL_MS: '60000',
  }), port: 0 };
  const suite = createProtocolProxyServer({
    name: 'test-openai', metricPrefix: 'test_openai', config,
    guardedRoutes: new Map([['/v1/chat/completions', {
      adapter: chatCompletionsAdapter,
      prepareRequest: (body) => structuredClone(body),
      buildRecovery: () => { throw new Error('not expected'); },
    }]]),
    allowPassthrough: () => false,
    formatJsonError: (type, message, requestId) => ({ error: { type, message, request_id: requestId } }),
    logSink: (line) => logs.push(JSON.parse(line)),
  });
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'run' }] }),
  });
  await response.text();
  const info = logs.find((row) => row.event === 'tool_calls_ready');
  const trace = logs.find((row) => row.event === 'tool_calls_payload');
  assert.ok(info);
  assert.ok(trace);
  assert.doesNotMatch(JSON.stringify(info), /super-secret/);
  assert.doesNotMatch(JSON.stringify(trace), /super-secret/);
  assert.match(JSON.stringify(trace), /REDACTED/);
});
