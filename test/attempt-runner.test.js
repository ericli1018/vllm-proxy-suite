import test from 'node:test';
import assert from 'node:assert/strict';

import { SseFrameDecoder } from '../packages/core/sse.js';
import { performBufferedAttempt } from '../packages/core/attempt-runner.js';
import { BufferBudget } from '../packages/core/buffer-budget.js';
import { loadCommonConfig } from '../packages/core/config.js';

function streamResponse(chunks, { status = 200, contentType = 'text/event-stream' } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { status, headers: { 'content-type': contentType, 'x-upstream': 'kept' } });
}

function createAdapter() {
  return {
    createStreamParser() {
      const decoder = new SseFrameDecoder();
      const values = [];
      return {
        push(chunk) {
          for (const frame of decoder.push(chunk)) {
            if (frame.data === '[DONE]') continue;
            values.push(JSON.parse(frame.data));
          }
        },
        finish() {
          const tail = decoder.finish();
          assert.equal(tail.length, 0);
          return { values };
        },
        snapshot() { return { values: [...values] }; },
      };
    },
    getReasoning(result) { return result.values.map((value) => value.reasoning || '').filter(Boolean); },
    semanticProgress(result) { return result.values.length; },
    validateStream(result) { return result.values.length ? { ok: true } : { ok: false, reason: 'empty' }; },
    parseJson(buffer) { return JSON.parse(buffer.toString('utf8')); },
    validateJson() { return { ok: true }; },
    getJsonReasoning(result) { return result.reasoning ? [result.reasoning] : []; },
  };
}

test('SseFrameDecoder handles fragmented CRLF and multi-line data', () => {
  const decoder = new SseFrameDecoder();
  assert.deepEqual(decoder.push('event: x\r\ndata: {"a":'), []);
  const frames = decoder.push('1}\r\ndata: second\r\n\r\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'x');
  assert.equal(frames[0].data, '{"a":1}\nsecond');
  assert.deepEqual(decoder.finish(), []);
});

test('performBufferedAttempt preserves exact streaming bytes', async () => {
  const chunks = ['data: {"reasoning":"check"}\n\n', 'data: [DONE]\n\n'];
  const budget = new BufferBudget(1024);
  const result = await performBufferedAttempt({
    fetchImpl: async () => streamResponse(chunks),
    url: 'http://upstream/v1/test',
    headers: {},
    requestBody: '{}',
    streaming: true,
    adapter: createAdapter(),
    config: loadCommonConfig({ LOOP_MIN_PATTERN_SIZE: '8', MAX_RESPONSE_BUFFER_BYTES: '1024', MAX_TOTAL_BUFFERED_BYTES: '1024' }),
    requestId: 'r1',
    bufferBudget: budget,
    timeoutMs: 5000,
  });
  assert.equal(result.kind, 'success');
  assert.equal(result.rawBody.toString(), chunks.join(''));
  assert.equal(result.headers.get('x-upstream'), 'kept');
  assert.equal(budget.usedBy('r1'), Buffer.byteLength(chunks.join('')));
});

test('performBufferedAttempt aborts and marks a reasoning loop', async () => {
  const repeated = 'Need evidence then act. Need evidence then act.';
  const result = await performBufferedAttempt({
    fetchImpl: async () => streamResponse([`data: ${JSON.stringify({ reasoning: repeated })}\n\n`]),
    url: 'http://upstream/v1/test',
    headers: {},
    requestBody: '{}',
    streaming: true,
    adapter: createAdapter(),
    config: loadCommonConfig({ LOOP_MIN_PATTERN_SIZE: '8', LOOP_MAX_PATTERN_SIZE: '128' }),
    requestId: 'loop',
    bufferBudget: new BufferBudget(4096),
    timeoutMs: 5000,
  });
  assert.equal(result.kind, 'loop');
  assert.equal(result.loopInfo.reason, 'repeated_reasoning_segment');
});

test('performBufferedAttempt rejects per-request response overflow', async () => {
  const result = await performBufferedAttempt({
    fetchImpl: async () => streamResponse(['data: {"reasoning":"', 'x'.repeat(2000), '"}\n\n']),
    url: 'http://upstream/v1/test',
    headers: {},
    requestBody: '{}',
    streaming: true,
    adapter: createAdapter(),
    config: loadCommonConfig({ MAX_RESPONSE_BUFFER_BYTES: '1024' }),
    requestId: 'large',
    bufferBudget: new BufferBudget(8192),
    timeoutMs: 5000,
  });
  assert.equal(result.kind, 'invalid');
  assert.equal(result.reason, 'response_buffer_limit');
});

test('performBufferedAttempt parses and validates non-stream JSON', async () => {
  const raw = JSON.stringify({ output: 'ok', reasoning: 'checked' });
  const result = await performBufferedAttempt({
    fetchImpl: async () => new Response(raw, { headers: { 'content-type': 'application/json' } }),
    url: 'http://upstream/v1/test',
    headers: {},
    requestBody: '{}',
    streaming: false,
    adapter: createAdapter(),
    config: loadCommonConfig({}),
    requestId: 'json',
    bufferBudget: new BufferBudget(4096),
    timeoutMs: 5000,
  });
  assert.equal(result.kind, 'success');
  assert.equal(result.rawBody.toString(), raw);
  assert.equal(result.result.output, 'ok');
});

import { responsesAdapter } from '../packages/openai/responses.js';

test('performBufferedAttempt accepts fragmented Responses function arguments before completion', async () => {
  const chunks = [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","name":"remote_read","arguments":""}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"url\\":"}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"\\"https://example.com\\"}"}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","name":"remote_read","arguments":"{\\"url\\":\\"https://example.com\\"}"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n',
  ];
  const result = await performBufferedAttempt({
    fetchImpl: async () => streamResponse(chunks),
    url: 'http://upstream/v1/responses',
    headers: {},
    requestBody: '{}',
    streaming: true,
    adapter: responsesAdapter,
    config: loadCommonConfig({ MAX_TOOL_ARGUMENT_BYTES: '4096', MAX_RESPONSE_BUFFER_BYTES: '8192', MAX_TOTAL_BUFFERED_BYTES: '8192' }),
    requestId: 'responses-fragmented',
    bufferBudget: new BufferBudget(8192),
    timeoutMs: 5000,
  });
  assert.equal(result.kind, 'success');
  assert.deepEqual(result.result.functionCalls.get('fc_1').parsedArguments, { url: 'https://example.com' });
  assert.equal(result.rawBody.toString(), chunks.join(''));
});

test('performBufferedAttempt enforces the process-wide buffer budget', async () => {
  const result = await performBufferedAttempt({
    fetchImpl: async () => streamResponse(['data: {"reasoning":"enough data"}\n\n']),
    url: 'http://upstream/v1/test',
    headers: {},
    requestBody: '{}',
    streaming: true,
    adapter: createAdapter(),
    config: { ...loadCommonConfig({ MAX_RESPONSE_BUFFER_BYTES: '4096' }), upstreamIdleTimeoutMs: 1000 },
    requestId: 'global-large',
    bufferBudget: new BufferBudget(8),
    timeoutMs: 5000,
  });
  assert.equal(result.kind, 'invalid');
  assert.equal(result.reason, 'global_buffer_limit_exceeded');
});

test('performBufferedAttempt reports upstream idle timeout', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  const response = new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  const result = await performBufferedAttempt({
    fetchImpl: async () => response,
    url: 'http://upstream/v1/test',
    headers: {},
    requestBody: '{}',
    streaming: true,
    adapter: createAdapter(),
    config: { ...loadCommonConfig({}), upstreamIdleTimeoutMs: 20, semanticStallTimeoutMs: 1000 },
    requestId: 'idle',
    bufferBudget: new BufferBudget(4096),
    timeoutMs: 1000,
  });
  clearInterval(keepAlive);
  assert.equal(result.kind, 'interrupted');
  assert.equal(result.reason, 'upstream_idle_timeout');
});

test('performBufferedAttempt propagates client cancellation', async () => {
  const client = new AbortController();
  const fetchImpl = async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  setTimeout(() => client.abort('client_cancelled'), 10);
  const result = await performBufferedAttempt({
    fetchImpl,
    url: 'http://upstream/v1/test',
    headers: {},
    requestBody: '{}',
    streaming: true,
    adapter: createAdapter(),
    config: loadCommonConfig({}),
    requestId: 'cancelled',
    bufferBudget: new BufferBudget(4096),
    timeoutMs: 1000,
    clientSignal: client.signal,
  });
  assert.equal(result.kind, 'cancelled');
  assert.equal(result.reason, 'client_cancelled');
});
