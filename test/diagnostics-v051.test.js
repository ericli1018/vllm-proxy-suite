import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { loadCommonConfig } from '../packages/core/config.js';
import { performBufferedAttempt } from '../packages/core/attempt-runner.js';
import { BufferBudget } from '../packages/core/buffer-budget.js';
import { chatCompletionsAdapter } from '../packages/openai/chat-completions.js';
import { responsesAdapter } from '../packages/openai/responses.js';
import { anthropicMessagesAdapter } from '../packages/anthropic/messages.js';
import { createProtocolProxyServer } from '../packages/server/create-proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('Chat tool fragments without repeated index continue the existing tool call', () => {
  const config = loadCommonConfig({});
  const parser = chatCompletionsAdapter.createStreamParser(config);
  parser.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":"}}]}}]}\n\n');
  parser.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"\\"/tmp/a\\",\\"content\\":\\"ok\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  const result = parser.finish();
  const validation = chatCompletionsAdapter.validateStream(result, config);

  assert.equal(validation.ok, true);
  assert.equal(result.choices.get(0).toolCalls.size, 1);
  assert.deepEqual(result.choices.get(0).toolCalls.get(0).parsedArguments, { path: '/tmp/a', content: 'ok' });
});



test('Chat fragment with a new Tool Call id but no index creates a distinct call', () => {
  const config = loadCommonConfig({});
  const parser = chatCompletionsAdapter.createStreamParser(config);
  parser.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_0","type":"function","function":{"name":"web_search","arguments":"{\\"query\\":\\"a\\"}"}}]}}]}\n\n');
  parser.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"web_search","arguments":"{\\"query\\":\\"b\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  const result = parser.finish();
  const metrics = chatCompletionsAdapter.semanticMetrics(result);

  assert.equal(metrics.toolCallCount, 2);
  assert.deepEqual(metrics.toolCallIds, ['call_0', 'call_1']);
  assert.deepEqual([...result.choices.get(0).toolCalls.values()].map((tool) => tool.parsedArguments), [
    { query: 'a' },
    { query: 'b' },
  ]);
});

test('Chat debug metrics expose exact tool call count and per-call fragment statistics', () => {
  const config = loadCommonConfig({});
  const parser = chatCompletionsAdapter.createStreamParser(config);
  parser.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_0","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":"}},{"index":1,"id":"call_1","type":"function","function":{"name":"web_search","arguments":"{\\"query\\":\\"x\\"}"}}]}}]}\n\n');
  parser.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/tmp/a\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
  const metrics = chatCompletionsAdapter.semanticMetrics(parser.snapshot());

  assert.equal(metrics.toolCallCount, 2);
  assert.deepEqual(metrics.toolCallIndexes, [0, 1]);
  assert.deepEqual(metrics.toolNames, ['write_file', 'web_search']);
  assert.equal(metrics.parallelToolCallsDetected, true);
  assert.deepEqual(metrics.toolArgumentFragmentsByCall, {
    'choice:0/tool:0': 2,
    'choice:0/tool:1': 1,
  });
  assert.deepEqual(metrics.toolArgumentBytesByCall, {
    'choice:0/tool:0': Buffer.byteLength('{"path":"/tmp/a"}', 'utf8'),
    'choice:0/tool:1': Buffer.byteLength('{"query":"x"}', 'utf8'),
  });
});



test('Attempt progress includes exact active tool call diagnostics', async () => {
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c0","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"/a\\"}"}},{"index":1,"id":"c1","type":"function","function":{"name":"web_search","arguments":"{\\"query\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const progress = [];
  const result = await performBufferedAttempt({
    fetchImpl: async () => response,
    url: 'http://upstream/v1/chat/completions', headers: {}, requestBody: '{}', streaming: true,
    adapter: chatCompletionsAdapter, config: loadCommonConfig({}), requestId: 'tool-count-progress',
    bufferBudget: new BufferBudget(1024 * 1024), timeoutMs: 1000,
    observer: { onProgress: (snapshot) => progress.push(snapshot) },
  });

  assert.equal(result.kind, 'success');
  const final = progress.at(-1);
  assert.equal(final.toolCallCount, 2);
  assert.deepEqual(final.toolCallIndexes, [0, 1]);
  assert.equal(final.parallelToolCallsDetected, true);
  assert.deepEqual(final.toolArgumentFragmentsByCall, {
    'choice:0/tool:0': 1,
    'choice:0/tool:1': 1,
  });
});



test('Per-call Tool argument byte diagnostics remain incremental during long streaming', () => {
  const config = loadCommonConfig({});
  const parser = chatCompletionsAdapter.createStreamParser(config);
  const originalByteLength = Buffer.byteLength;
  let measuredStringBytes = 0;
  Buffer.byteLength = function trackedByteLength(value, encoding) {
    if (typeof value === 'string') measuredStringBytes += originalByteLength(value, encoding);
    return originalByteLength(value, encoding);
  };
  try {
    parser.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c0","type":"function","function":{"name":"write_file","arguments":""}}]}}]}\n\n');
    for (let i = 0; i < 40; i += 1) {
      const fragment = 'x'.repeat(100);
      parser.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] } }] })}\n\n`);
      chatCompletionsAdapter.semanticMetrics(parser.snapshot());
    }
  } finally {
    Buffer.byteLength = originalByteLength;
  }

  assert.ok(measuredStringBytes < 30000, `expected incremental byte accounting, measured ${measuredStringBytes} bytes`);
});

test('Malformed tool arguments return safe structured parse diagnostics and are non-retryable', () => {
  const config = loadCommonConfig({});
  const parser = chatCompletionsAdapter.createStreamParser(config);
  parser.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_bad","type":"function","function":{"name":"write_file","arguments":"{\\"content\\":\\"unterminated"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  const result = parser.finish();
  const validation = chatCompletionsAdapter.validateStream(result, config);

  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'malformed_tool_arguments');
  assert.equal(validation.retryable, false);
  assert.equal(validation.diagnostics.toolCallCount, 1);
  assert.equal(validation.diagnostics.toolCallKey, 'choice:0/tool:0');
  assert.equal(validation.diagnostics.toolCallIndex, 0);
  assert.equal(validation.diagnostics.toolCallId, 'call_bad');
  assert.equal(validation.diagnostics.toolName, 'write_file');
  assert.equal(validation.diagnostics.toolArgumentFragments, 1);
  assert.equal(validation.diagnostics.toolArgumentBytes, Buffer.byteLength('{"content":"unterminated', 'utf8'));
  assert.match(validation.diagnostics.parseErrorCategory, /unterminated|string|unexpected_end/);
  assert.equal(typeof validation.diagnostics.parseErrorOffset, 'number');
  assert.equal(typeof validation.diagnostics.parseErrorLine, 'number');
  assert.equal(typeof validation.diagnostics.parseErrorColumn, 'number');
});

test('Runtime logs malformed tool diagnostics, marks the error non-retryable, and skips generic recovery', async (t) => {
  const logs = [];
  let recoveryCalls = 0;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_bad","type":"function","function":{"name":"write_file","arguments":"{\\"content\\":\\"unterminated"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const config = {
    ...loadCommonConfig({
      LOG_LEVEL: 'debug', LOG_FORMAT: 'json', PROXY_API_KEY: 'client', VLLM_BASE_URL: upstreamUrl,
      HEARTBEAT_INTERVAL_MS: '60000', MAX_RECOVERY_ATTEMPTS: '1',
    }),
    port: 0,
  };
  const suite = createProtocolProxyServer({
    name: 'test-openai', metricPrefix: 'test_openai', config,
    guardedRoutes: new Map([['/v1/chat/completions', {
      adapter: chatCompletionsAdapter,
      prepareRequest: (body) => structuredClone(body),
      buildRecovery: () => { recoveryCalls += 1; throw new Error('must not recover malformed JSON'); },
    }]]),
    allowPassthrough: () => false,
    formatJsonError: (type, message, requestId, extra = {}) => ({ error: { type, message, request_id: requestId, ...extra } }),
    logSink: (line) => logs.push(JSON.parse(line)),
  });
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'write' }] }),
  });
  const body = await response.text();

  assert.equal(recoveryCalls, 0);
  assert.equal(logs.some((row) => row.event === 'recovery_started'), false);
  const failed = logs.find((row) => row.event === 'request_failed');
  assert.ok(failed);
  assert.equal(failed.reason, 'malformed_tool_arguments');
  assert.equal(failed.retryable, false);
  assert.equal(failed.toolCallCount, 1);
  assert.equal(failed.toolName, 'write_file');
  assert.match(failed.parseErrorCategory, /unterminated|string|unexpected_end/);
  assert.match(body, /"retryable":false/);
  assert.match(body, /"toolCallCount":1/);
});

test('Responses and Anthropic metrics expose tool call counts and malformed JSON diagnostics', () => {
  const config = loadCommonConfig({});

  const responses = responsesAdapter.createStreamParser(config);
  responses.push('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"f0","call_id":"c0","name":"write_file","arguments":""}}\n\n');
  responses.push('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"f0","delta":"{\\"content\\":\\"unterminated"}\n\n');
  responses.push('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n');
  const responsesResult = responses.finish();
  const responsesMetrics = responsesAdapter.semanticMetrics(responsesResult);
  const responsesValidation = responsesAdapter.validateStream(responsesResult, config);
  assert.equal(responsesMetrics.toolCallCount, 1);
  assert.deepEqual(responsesMetrics.toolCallIndexes, [0]);
  assert.equal(responsesMetrics.toolArgumentFragmentsByCall['output:0/call:f0'], 1);
  assert.equal(responsesValidation.retryable, false);
  assert.equal(responsesValidation.diagnostics.toolCallKey, 'output:0/call:f0');
  assert.match(responsesValidation.diagnostics.parseErrorCategory, /unterminated|string|unexpected_end/);

  const anthropic = anthropicMessagesAdapter.createStreamParser(config);
  anthropic.push('event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n');
  anthropic.push('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t0","name":"Write"}}\n\n');
  anthropic.push('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"content\\":\\"unterminated"}}\n\n');
  anthropic.push('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
  anthropic.push('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n');
  anthropic.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  const anthropicResult = anthropic.finish();
  const anthropicMetrics = anthropicMessagesAdapter.semanticMetrics(anthropicResult);
  const anthropicValidation = anthropicMessagesAdapter.validateStream(anthropicResult, config);
  assert.equal(anthropicMetrics.toolCallCount, 1);
  assert.deepEqual(anthropicMetrics.toolCallIndexes, [0]);
  assert.equal(anthropicMetrics.toolArgumentFragmentsByCall['block:0'], 1);
  assert.equal(anthropicValidation.retryable, false);
  assert.equal(anthropicValidation.diagnostics.toolCallKey, 'block:0');
  assert.match(anthropicValidation.diagnostics.parseErrorCategory, /unterminated|string|unexpected_end/);
});
