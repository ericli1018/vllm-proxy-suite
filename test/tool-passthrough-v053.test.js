import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { performBufferedAttempt } from '../packages/core/attempt-runner.js';
import { BufferBudget } from '../packages/core/buffer-budget.js';
import { loadCommonConfig } from '../packages/core/config.js';
import { fingerprintRequest, RequestFingerprintRegistry } from '../packages/core/request-fingerprint.js';
import { chatCompletionsAdapter } from '../packages/openai/chat-completions.js';
import { responsesAdapter } from '../packages/openai/responses.js';
import { createOpenAiProxyRuntime } from '../apps/vllm-openai-proxy/server.js';

const encoder = new TextEncoder();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function config(overrides = {}) {
  return Object.freeze({
    ...loadCommonConfig({
      PROXY_API_KEY: 'client-secret',
      VLLM_API_KEY: 'vllm-secret',
      VLLM_BASE_URL: 'http://upstream.invalid',
      HEARTBEAT_INTERVAL_MS: '60000',
      UPSTREAM_IDLE_TIMEOUT_MS: '5000',
      SEMANTIC_STALL_TIMEOUT_MS: '5000',
      TOTAL_GENERATION_TIMEOUT_MS: '5000',
      RECOVERY_TIMEOUT_MS: '5000',
      MAX_TOTAL_BUFFERED_BYTES: '1048576',
      MAX_RESPONSE_BUFFER_BYTES: '1048576',
      LOOP_MIN_PATTERN_SIZE: '8',
      LOOP_MIN_COUNT: '2',
    }),
    ...overrides,
  });
}

function controlledFetch() {
  let controller;
  const responseReady = deferred();
  const stream = new ReadableStream({
    start(value) {
      controller = value;
      responseReady.resolve();
    },
  });
  return {
    fetchImpl: async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    async enqueue(text) {
      await responseReady.promise;
      controller.enqueue(encoder.encode(text));
    },
    async close() {
      await responseReady.promise;
      controller.close();
    },
  };
}

function createCollectingPassthrough(adapter, delivered, lifecycle) {
  return {
    shouldCommit(snapshot) {
      return (adapter.semanticMetrics(snapshot).toolCallCount || 0) > 0;
    },
    async start({ bufferedBody }) {
      lifecycle.push('start');
      delivered.push(Buffer.from(bufferedBody));
    },
    async write(chunk) {
      lifecycle.push('write');
      delivered.push(Buffer.from(chunk));
    },
    async end() {
      lifecycle.push('end');
    },
    async abort() {
      lifecycle.push('abort');
    },
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.close();
  await once(server, 'close').catch(() => {});
}

async function readUntil(reader, pattern, timeoutMs = 1000) {
  const chunks = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      delay(Math.max(1, deadline - Date.now())).then(() => ({ timeout: true })),
    ]);
    if (result.timeout) break;
    if (result.done) break;
    chunks.push(Buffer.from(result.value));
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.includes(pattern)) return { text, chunks };
  }
  throw new Error(`did not receive ${pattern}`);
}

test('attempt runner commits buffered bytes at the first Chat tool delta and bypasses malformed arguments', async () => {
  const upstream = controlledFetch();
  const delivered = [];
  const lifecycle = [];
  const budget = new BufferBudget(1024 * 1024);
  const attemptPromise = performBufferedAttempt({
    fetchImpl: upstream.fetchImpl,
    url: 'http://upstream.invalid/v1/chat/completions',
    headers: new Headers(),
    requestBody: '{}',
    streaming: true,
    adapter: chatCompletionsAdapter,
    config: config(),
    requestId: 'tool-pass-chat',
    bufferBudget: budget,
    timeoutMs: 5000,
    toolPassthrough: createCollectingPassthrough(chatCompletionsAdapter, delivered, lifecycle),
  });

  const reasoning = 'data: {"choices":[{"index":0,"delta":{"reasoning":"inspect first"}}]}\n\n';
  const tool = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"x\\",\\"content\\":\\"abc"}}]}}]}\n\n';
  await upstream.enqueue(reasoning);
  await delay(20);
  assert.equal(delivered.length, 0);

  await upstream.enqueue(tool);
  await delay(20);
  assert.equal(lifecycle[0], 'start');
  assert.equal(Buffer.concat(delivered).toString('utf8'), reasoning + tool);
  assert.equal(budget.total, 0);

  await upstream.enqueue('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":8192,"total_tokens":8202}}\n\ndata: [DONE]\n\n');
  await upstream.close();
  const attempt = await attemptPromise;

  assert.equal(attempt.kind, 'tool_passthrough');
  assert.equal(attempt.deliveryCommitted, true);
  assert.equal(attempt.result.semanticMetrics.toolCallCount, 1);
  assert.equal(attempt.result.choices.get(0).toolCalls.get(0).argumentErrorDiagnostics.parseErrorCategory, 'unterminated_string');
  assert.equal(lifecycle.at(-1), 'end');
});

test('attempt runner does not apply reasoning-loop recovery after the Tool commit boundary', async () => {
  const upstream = controlledFetch();
  const delivered = [];
  const lifecycle = [];
  const attemptPromise = performBufferedAttempt({
    fetchImpl: upstream.fetchImpl,
    url: 'http://upstream.invalid/v1/chat/completions',
    headers: new Headers(),
    requestBody: '{}',
    streaming: true,
    adapter: chatCompletionsAdapter,
    config: config(),
    requestId: 'tool-pass-loop-boundary',
    bufferBudget: new BufferBudget(1024 * 1024),
    timeoutMs: 5000,
    toolPassthrough: createCollectingPassthrough(chatCompletionsAdapter, delivered, lifecycle),
  });

  await upstream.enqueue('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"write_file","arguments":"{}"}}]}}]}\n\n');
  await upstream.enqueue('data: {"choices":[{"index":0,"delta":{"reasoning":"repeat loop repeat loop repeat loop repeat loop"},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  await upstream.close();

  const attempt = await attemptPromise;
  assert.equal(attempt.kind, 'tool_passthrough');
  assert.equal(attempt.deliveryCommitted, true);
  assert.equal(lifecycle.at(-1), 'end');
});

test('attempt runner commits Responses function calls without final Tool JSON validation', async () => {
  const upstream = controlledFetch();
  const delivered = [];
  const lifecycle = [];
  const attemptPromise = performBufferedAttempt({
    fetchImpl: upstream.fetchImpl,
    url: 'http://upstream.invalid/v1/responses',
    headers: new Headers(),
    requestBody: '{}',
    streaming: true,
    adapter: responsesAdapter,
    config: config(),
    requestId: 'tool-pass-responses',
    bufferBudget: new BufferBudget(1024 * 1024),
    timeoutMs: 5000,
    toolPassthrough: createCollectingPassthrough(responsesAdapter, delivered, lifecycle),
  });

  const added = 'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc1","type":"function_call","name":"write_file","arguments":""}}\n\n';
  await upstream.enqueue(added);
  await delay(20);
  assert.equal(lifecycle[0], 'start');
  assert.equal(Buffer.concat(delivered).toString('utf8'), added);

  await upstream.enqueue('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc1","output_index":0,"delta":"{\\"path\\":\\"x"}\n\n');
  await upstream.enqueue('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":10,"output_tokens":8192,"total_tokens":8202}}}\n\n');
  await upstream.close();

  const attempt = await attemptPromise;
  assert.equal(attempt.kind, 'tool_passthrough');
  assert.equal(attempt.result.functionCalls.get('fc1').argumentErrorDiagnostics.parseErrorCategory, 'unterminated_string');
});

test('OpenAI Chat runtime exposes Tool bytes before upstream completion and never converts malformed arguments to a proxy error', async (t) => {
  const releaseFinal = deferred();
  const toolSent = deferred();
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"reasoning":"prepare"}}]}\n\n');
    await delay(20);
    res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"x\\",\\"content\\":\\"abc"}}]}}]}\n\n');
    toolSent.resolve();
    await releaseFinal.promise;
    res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":8192,"total_tokens":8202}}\n\ndata: [DONE]\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({
    config: config({ vllmBaseUrl: upstreamUrl, port: 0 }),
    exposeControlRoutes: false,
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const responsePromise = fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'write' }] }),
  });

  await toolSent.promise;
  const early = await Promise.race([responsePromise.then(() => 'response'), delay(300).then(() => 'timeout')]);
  assert.equal(early, 'response');
  const response = await responsePromise;
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await readUntil(reader, 'write_file');
  assert.match(first.text, /prepare/);
  releaseFinal.resolve();
  const rest = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    rest.push(Buffer.from(value));
  }
  const full = first.text + Buffer.concat(rest).toString('utf8');
  assert.match(full, /completion_tokens\\?"?:8192|completion_tokens":8192/);
  assert.match(full, /\[DONE\]/);
  assert.equal(runtime.metrics.recoveriesTotal, 0);
  assert.equal(runtime.metrics.validationFailuresTotal, 0);
  assert.equal(runtime.metrics.toolPassthroughStartedTotal, 1);
  assert.equal(runtime.metrics.toolPassthroughCompletedTotal, 1);
  assert.equal(runtime.metrics.toolPassthroughValidationWarningsTotal, 1);
});

test('OpenAI non-stream Tool response bypasses malformed function arguments unchanged', async (t) => {
  const payload = {
    id: 'cmpl1',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"x","content":"abc' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 8192, total_tokens: 8202 },
  };
  const raw = JSON.stringify(payload);
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(raw);
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({ config: config({ vllmBaseUrl: upstreamUrl, port: 0 }), exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: 'write' }] }),
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), raw);
  assert.equal(runtime.metrics.validationFailuresTotal, 0);
});


test('OpenAI Responses runtime commits a function call before response.completed', async (t) => {
  const releaseFinal = deferred();
  const toolSent = deferred();
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"prepare"}\n\n');
    await delay(20);
    res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc1","type":"function_call","name":"write_file","arguments":""}}\n\n');
    toolSent.resolve();
    await releaseFinal.promise;
    res.end('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc1","output_index":0,"delta":"{\\"path\\":\\"x"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":10,"output_tokens":8192,"total_tokens":8202}}}\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({ config: config({ vllmBaseUrl: upstreamUrl, port: 0 }), exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const responsePromise = fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, input: 'write' }),
  });

  await toolSent.promise;
  const early = await Promise.race([responsePromise.then(() => 'response'), delay(300).then(() => 'timeout')]);
  assert.equal(early, 'response');
  const response = await responsePromise;
  const reader = response.body.getReader();
  const first = await readUntil(reader, 'write_file');
  assert.match(first.text, /prepare/);
  releaseFinal.resolve();
  while (!(await reader.read()).done) { /* drain */ }
  assert.equal(runtime.metrics.recoveriesTotal, 0);
  assert.equal(runtime.metrics.toolPassthroughCompletedTotal, 1);
});

test('request fingerprint retry delay is measured after the prior terminal event', () => {
  const registry = new RequestFingerprintRegistry({ ttlMs: 1000, maxEntries: 10 });
  const fingerprint = fingerprintRequest('/v1/chat/completions', Buffer.from('{"x":1}'));
  assert.equal(registry.observe(fingerprint, 'r1', 0), null);
  registry.complete(fingerprint, 'r1', 'request_failed', { reason: 'malformed_tool_arguments', retryable: false }, 100);
  const retry = registry.observe(fingerprint, 'r2', 125);
  assert.equal(retry.retryDelayMs, 25);
  assert.equal(retry.retryDelayAfterTerminalMs, 25);
  assert.equal(retry.previousRequestDurationMs, 100);
  assert.equal(retry.requestStartIntervalMs, 125);
});

test('Tool passthrough observation retains only the configured argument prefix while counters keep growing', async () => {
  const upstream = controlledFetch();
  const delivered = [];
  const lifecycle = [];
  const localConfig = config({ toolPassthroughObservationMaxBytes: 16 });
  const attemptPromise = performBufferedAttempt({
    fetchImpl: upstream.fetchImpl,
    url: 'http://upstream.invalid/v1/chat/completions',
    headers: new Headers(),
    requestBody: '{}',
    streaming: true,
    adapter: chatCompletionsAdapter,
    config: localConfig,
    requestId: 'bounded-tool-observation',
    bufferBudget: new BufferBudget(1024 * 1024),
    timeoutMs: 5000,
    toolPassthrough: createCollectingPassthrough(chatCompletionsAdapter, delivered, lifecycle),
  });

  await upstream.enqueue('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"write_file","arguments":"{\\"x\\":\\""}}]}}]}\n\n');
  await upstream.enqueue(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'y'.repeat(200) } }] } }] })}\n\n`);
  await upstream.enqueue('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  await upstream.close();

  const attempt = await attemptPromise;
  const tool = attempt.result.choices.get(0).toolCalls.get(0);
  assert.equal(attempt.kind, 'tool_passthrough');
  assert.ok(tool.argumentBytes > 200);
  assert.ok(Buffer.byteLength(tool.arguments, 'utf8') <= 16);
  assert.equal(tool.argumentsObservationTruncated, true);
});

test('Responses per-call retained argument byte diagnostics remain incremental before passthrough', () => {
  const config = loadCommonConfig({});
  const parser = responsesAdapter.createStreamParser(config);
  const originalByteLength = Buffer.byteLength;
  let measuredStringBytes = 0;
  Buffer.byteLength = function trackedByteLength(value, encoding) {
    if (typeof value === 'string') measuredStringBytes += originalByteLength(value, encoding);
    return originalByteLength(value, encoding);
  };
  try {
    parser.push(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc-linear', type: 'function_call', name: 'write_file', arguments: '' } })}\n\n`);
    for (let i = 0; i < 40; i += 1) {
      parser.push(`data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-linear', delta: 'x'.repeat(100) })}\n\n`);
      responsesAdapter.semanticMetrics(parser.snapshot());
    }
  } finally {
    Buffer.byteLength = originalByteLength;
  }

  assert.ok(measuredStringBytes < 30000, `expected incremental byte accounting, measured ${measuredStringBytes} bytes`);
});

test('Tool passthrough start failure is treated as an irreversible committed delivery', async () => {
  const upstream = controlledFetch();
  const lifecycle = [];
  const budget = new BufferBudget(1024 * 1024);
  const attemptPromise = performBufferedAttempt({
    fetchImpl: upstream.fetchImpl,
    url: 'http://upstream.invalid/v1/chat/completions',
    headers: new Headers(),
    requestBody: '{}',
    streaming: true,
    adapter: chatCompletionsAdapter,
    config: config(),
    requestId: 'tool-pass-start-failure',
    bufferBudget: budget,
    timeoutMs: 5000,
    toolPassthrough: {
      shouldCommit(snapshot) {
        return chatCompletionsAdapter.semanticMetrics(snapshot).toolCallCount > 0;
      },
      async start() {
        lifecycle.push('start');
        throw new Error('sink rejected after commit');
      },
      async abort() {
        lifecycle.push('abort');
      },
    },
  });

  await upstream.enqueue('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c-start","type":"function","function":{"name":"write_file","arguments":"{}"}}]}}]}\n\n');
  const attempt = await attemptPromise;

  assert.equal(attempt.kind, 'interrupted');
  assert.equal(attempt.reason, 'tool_passthrough_start_failed');
  assert.equal(attempt.deliveryCommitted, true);
  assert.deepEqual(lifecycle, ['start', 'abort']);
  assert.equal(budget.total, 0);
});

test('Chat observe-only validation does not misclassify a truncated diagnostic prefix as invalid Tool JSON', () => {
  const parser = chatCompletionsAdapter.createStreamParser(config({ toolPassthroughObservationMaxBytes: 8 }));
  parser.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c-prefix","type":"function","function":{"name":"write_file","arguments":"{\\"x\\":\\""}}]}}]}\n\n');
  parser.enableToolPassthroughObservation(8);
  parser.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"abcdefghijklmnopqrstuvwxyz\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  const result = parser.finish();
  const tool = result.choices.get(0).toolCalls.get(0);

  assert.equal(tool.argumentsObservationTruncated, true);
  assert.equal(chatCompletionsAdapter.validateStream(result, config()).ok, true);
});

test('Responses observe-only validation does not misclassify a truncated diagnostic prefix as invalid Tool JSON', () => {
  const parser = responsesAdapter.createStreamParser(config({ toolPassthroughObservationMaxBytes: 8 }));
  parser.push(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc-prefix', type: 'function_call', name: 'write_file', arguments: '{"x":"' } })}\n\n`);
  parser.enableToolPassthroughObservation(8);
  parser.push(`data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-prefix', delta: 'abcdefghijklmnopqrstuvwxyz"}' })}\n\n`);
  parser.push(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`);
  const result = parser.finish();
  const call = result.functionCalls.get('fc-prefix');

  assert.equal(call.argumentsObservationTruncated, true);
  assert.equal(responsesAdapter.validateStream(result, config()).ok, true);
});

test('Tool passthrough progress distinguishes exact semantic bytes from retained parser bytes', async () => {
  const upstream = controlledFetch();
  const progress = [];
  const delivered = [];
  const lifecycle = [];
  const attemptPromise = performBufferedAttempt({
    fetchImpl: upstream.fetchImpl,
    url: 'http://upstream.invalid/v1/chat/completions',
    headers: new Headers(),
    requestBody: '{}',
    streaming: true,
    adapter: chatCompletionsAdapter,
    config: config({ toolPassthroughObservationMaxBytes: 16 }),
    requestId: 'tool-pass-retained-memory',
    bufferBudget: new BufferBudget(1024 * 1024),
    timeoutMs: 5000,
    observer: { onProgress: (snapshot) => progress.push(snapshot) },
    toolPassthrough: createCollectingPassthrough(chatCompletionsAdapter, delivered, lifecycle),
  });

  await upstream.enqueue('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c-memory","type":"function","function":{"name":"write_file","arguments":"{\\"x\\":\\""}}]}}]}\n\n');
  await upstream.enqueue(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: `${'x'.repeat(4096)}"}` } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  await upstream.close();
  const attempt = await attemptPromise;
  const final = progress.at(-1);

  assert.equal(attempt.kind, 'tool_passthrough');
  assert.ok(final.parsedSemanticBytes > 4000);
  assert.ok(final.parsedSemanticRetainedBytes <= 64, `retained bytes were ${final.parsedSemanticRetainedBytes}`);
  assert.ok(final.estimatedRequestMemoryBytes < final.parsedSemanticBytes);
});

test('OpenAI runtime rejects a late Chat system message before contacting vLLM', async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({ config: config({ vllmBaseUrl: upstreamUrl, port: 0 }), exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'late policy' },
      ],
    }),
  });

  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(upstreamRequests, 0);
  assert.equal(payload.error.code, 'system_message_not_first');
  assert.equal(payload.error.message_index, 1);
  assert.deepEqual(payload.error.system_message_indexes, [1]);
});

test('OpenAI runtime loop recovery keeps exactly one leading Chat system message', async (t) => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (received.length === 1) {
      res.end('data: {"choices":[{"index":0,"delta":{"reasoning":"Need evidence then act. Need evidence then act."}}]}\n\ndata: [DONE]\n\n');
    } else {
      res.end('data: {"choices":[{"index":0,"delta":{"content":"RECOVERED"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({ config: config({ vllmBaseUrl: upstreamUrl, port: 0 }), exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm',
      stream: true,
      messages: [
        { role: 'system', content: 'Original policy' },
        { role: 'user', content: 'answer' },
      ],
    }),
  });

  assert.equal(response.status, 200);
  assert.match(await response.text(), /RECOVERED/);
  assert.equal(received.length, 2);
  assert.equal(received[1].messages[0].role, 'system');
  assert.match(received[1].messages[0].content, /^Original policy\n\n/);
  assert.match(received[1].messages[0].content, /failed attempt is not task progress/i);
  assert.deepEqual(received[1].messages.slice(1), [{ role: 'user', content: 'answer' }]);
  assert.equal(received[1].messages.filter((message) => message.role === 'system').length, 1);
});
