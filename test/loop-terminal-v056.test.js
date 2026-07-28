import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { performBufferedAttempt } from '../packages/core/attempt-runner.js';
import { BufferBudget } from '../packages/core/buffer-budget.js';
import { loadCommonConfig } from '../packages/core/config.js';
import { detectReasoningLoop } from '../packages/core/loop-detector.js';
import { responsesAdapter } from '../packages/openai/responses.js';
import { createOpenAiProxyRuntime } from '../apps/vllm-openai-proxy/server.js';

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
      MAX_RECOVERY_ATTEMPTS: '1',
      MAX_TOTAL_BUFFERED_BYTES: '1048576',
      MAX_RESPONSE_BUFFER_BYTES: '1048576',
      LOOP_MIN_PATTERN_SIZE: '8',
      LOOP_MAX_PATTERN_SIZE: '256',
      LOOP_MIN_COUNT: '2',
    }),
    ...overrides,
  });
}

function streamResponse(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
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

test('exact suffix repeat honors LOOP_MIN_COUNT=3', () => {
  const cfg = config({ loopMinCount: 3 });
  const pattern = 'Need evidence then act. ';
  assert.equal(detectReasoningLoop(pattern.repeat(2), cfg), null);
  const detected = detectReasoningLoop(pattern.repeat(3), cfg);
  assert.equal(detected?.reason, 'repeated_reasoning_segment');
  assert.equal(detected?.repeatCount, 3);
});

test('ABAB line repeat honors LOOP_MIN_COUNT=3', () => {
  const cfg = config({ loopMinCount: 3, loopMinPatternSize: 4 });
  const pair = '分析假設 A\n檢查假設 B\n';
  assert.equal(detectReasoningLoop(pair.repeat(2), cfg), null);
  const detected = detectReasoningLoop(pair.repeat(3), cfg);
  assert.equal(detected?.reason, 'abab_reasoning_lines');
  assert.equal(detected?.repeatCount, 3);
});

test('Responses completed output is not overridden by repeated reasoning in the same upstream chunk', async () => {
  const raw = [
    'event: response.reasoning_text.done\ndata: {"type":"response.reasoning_text.done","item_id":"rs1","output_index":0,"content_index":0,"text":"Need evidence then act. Need evidence then act. "}\n\n',
    'event: response.output_text.done\ndata: {"type":"response.output_text.done","item_id":"m1","output_index":1,"content_index":0,"text":"OK"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}\n\n',
  ].join('');
  const result = await performBufferedAttempt({
    fetchImpl: async () => streamResponse([raw]),
    url: 'http://upstream/v1/responses',
    headers: {},
    requestBody: '{}',
    streaming: true,
    adapter: responsesAdapter,
    config: config(),
    requestId: 'responses-terminal-success',
    bufferBudget: new BufferBudget(1048576),
    timeoutMs: 5000,
  });

  assert.equal(result.kind, 'success');
  assert.equal(result.result.terminal, true);
  assert.equal(result.result.outputText, 'OK');
  assert.equal(result.rawBody.toString(), raw);
});

test('Responses loop guard remains disabled after visible output appears', async () => {
  const chunks = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"m1","output_index":1,"content_index":0,"delta":"OK"}\n\n',
    'event: response.reasoning_text.done\ndata: {"type":"response.reasoning_text.done","item_id":"rs1","output_index":0,"content_index":0,"text":"Need evidence then act. Need evidence then act. "}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n',
  ];
  const result = await performBufferedAttempt({
    fetchImpl: async () => streamResponse(chunks),
    url: 'http://upstream/v1/responses',
    headers: {},
    requestBody: '{}',
    streaming: true,
    adapter: responsesAdapter,
    config: config(),
    requestId: 'responses-action-boundary',
    bufferBudget: new BufferBudget(1048576),
    timeoutMs: 5000,
  });

  assert.equal(result.kind, 'success');
  assert.equal(result.result.outputText, 'OK');
});


test('Responses still detects a three-repeat reasoning loop before any action or terminal event', async () => {
  const pattern = 'Need evidence then act. ';
  const result = await performBufferedAttempt({
    fetchImpl: async () => streamResponse([
      `event: response.reasoning_text.delta\ndata: ${JSON.stringify({ type: 'response.reasoning_text.delta', item_id: 'rs1', output_index: 0, content_index: 0, delta: pattern.repeat(3) })}\n\n`,
    ]),
    url: 'http://upstream/v1/responses',
    headers: {},
    requestBody: '{}',
    streaming: true,
    adapter: responsesAdapter,
    config: config({ loopMinCount: 3 }),
    requestId: 'responses-pre-action-loop',
    bufferBudget: new BufferBudget(1048576),
    timeoutMs: 5000,
  });

  assert.equal(result.kind, 'loop');
  assert.equal(result.loopInfo.reason, 'repeated_reasoning_segment');
  assert.equal(result.loopInfo.repeatCount, 3);
});

test('OpenAI Responses runtime replays completed SSE instead of starting loop recovery', async (t) => {
  const raw = [
    'event: response.reasoning_text.done\ndata: {"type":"response.reasoning_text.done","item_id":"rs1","output_index":0,"content_index":0,"text":"Need evidence then act. Need evidence then act. "}\n\n',
    'event: response.output_text.done\ndata: {"type":"response.output_text.done","item_id":"m1","output_index":1,"content_index":0,"text":"OK"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":13558,"output_tokens":49,"total_tokens":13607}}}\n\n',
  ].join('');
  let upstreamRequests = 0;
  const upstream = http.createServer(async (req, res) => {
    upstreamRequests += 1;
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(raw);
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({ config: config({ vllmBaseUrl: upstreamUrl }), exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', input: 'Reply OK', stream: true }),
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(body, raw);
  assert.match(body, /event: response\.completed/);
  assert.equal(upstreamRequests, 1);
  assert.equal(runtime.metrics.recoveriesTotal, 0);
  assert.equal(runtime.metrics.loopsDetectedTotal, 0);
});
