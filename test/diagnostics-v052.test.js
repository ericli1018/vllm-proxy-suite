import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { loadCommonConfig } from '../packages/core/config.js';
import { performBufferedAttempt } from '../packages/core/attempt-runner.js';
import { BufferBudget } from '../packages/core/buffer-budget.js';
import { fingerprintRequest, RequestFingerprintRegistry } from '../packages/core/request-fingerprint.js';
import { chatCompletionsAdapter } from '../packages/openai/chat-completions.js';
import { responsesAdapter } from '../packages/openai/responses.js';
import { anthropicMessagesAdapter } from '../packages/anthropic/messages.js';
import { createProtocolProxyServer, summarizeToolResultContext } from '../packages/server/create-proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function openAiRuntime({ upstreamUrl, logs, env = {} }) {
  const config = {
    ...loadCommonConfig({
      LOG_LEVEL: 'debug', LOG_FORMAT: 'json', PROXY_API_KEY: 'client', VLLM_BASE_URL: upstreamUrl,
      HEARTBEAT_INTERVAL_MS: '60000', MAX_RECOVERY_ATTEMPTS: '0',
      ...env,
    }),
    port: 0,
  };
  return createProtocolProxyServer({
    name: 'test-openai-v052', metricPrefix: 'test_openai_v052', config,
    guardedRoutes: new Map([['/v1/chat/completions', {
      adapter: chatCompletionsAdapter,
      prepareRequest: (body) => structuredClone(body),
      buildRecovery: () => { throw new Error('recovery not expected'); },
    }]]),
    allowPassthrough: () => false,
    formatJsonError: (type, message, requestId, extra = {}) => ({ error: { type, message, request_id: requestId, ...extra } }),
    logSink: (line) => logs.push(JSON.parse(line)),
  });
}

test('protocol adapters expose terminal and normalized usage diagnostics on malformed Tool Calls', () => {
  const config = loadCommonConfig({});

  const chat = chatCompletionsAdapter.createStreamParser(config);
  chat.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c0","type":"function","function":{"name":"write_file","arguments":"{\\"content\\":\\"壞掉"}}]},"finish_reason":"tool_calls"}]}\n\n');
  chat.push('data: {"choices":[],"usage":{"prompt_tokens":101,"completion_tokens":23,"total_tokens":124}}\n\ndata: [DONE]\n\n');
  const chatResult = chat.finish();
  const chatValidation = chatCompletionsAdapter.validateStream(chatResult, config);
  assert.equal(chatValidation.ok, false);
  assert.equal(chatValidation.diagnostics.doneReceived, true);
  assert.equal(chatValidation.diagnostics.finishReason, 'tool_calls');
  assert.deepEqual(chatValidation.diagnostics.finishReasonsByChoice, { 0: 'tool_calls' });
  assert.equal(chatValidation.diagnostics.usagePromptTokens, 101);
  assert.equal(chatValidation.diagnostics.usageCompletionTokens, 23);
  assert.equal(chatValidation.diagnostics.usageTotalTokens, 124);
  assert.equal(chatValidation.diagnostics.parseErrorOffsetUnit, 'utf16_code_unit');
  assert.equal(chatValidation.diagnostics.toolArgumentUtf8Bytes, Buffer.byteLength('{"content":"壞掉', 'utf8'));
  assert.equal(chatValidation.diagnostics.toolArgumentUtf16Length, '{"content":"壞掉'.length);
  assert.equal(chatValidation.diagnostics.toolArgumentCodePoints, Array.from('{"content":"壞掉').length);
  assert.equal(chatValidation.diagnostics.parseErrorAtEnd, true);

  const responses = responsesAdapter.createStreamParser(config);
  responses.push('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"f0","call_id":"f0","name":"write_file","arguments":"{\\"content\\":\\"壞掉"}}\n\n');
  responses.push('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":55,"output_tokens":13,"total_tokens":68}}}\n\n');
  const responsesResult = responses.finish();
  const responsesValidation = responsesAdapter.validateStream(responsesResult, config);
  assert.equal(responsesValidation.ok, false);
  assert.equal(responsesValidation.diagnostics.responseCompleted, true);
  assert.equal(responsesValidation.diagnostics.responseStatus, 'completed');
  assert.equal(responsesValidation.diagnostics.usagePromptTokens, 55);
  assert.equal(responsesValidation.diagnostics.usageCompletionTokens, 13);
  assert.equal(responsesValidation.diagnostics.usageTotalTokens, 68);
  assert.equal(responsesValidation.diagnostics.parseErrorOffsetUnit, 'utf16_code_unit');

  const anthropic = anthropicMessagesAdapter.createStreamParser(config);
  anthropic.push('event: message_start\ndata: {"type":"message_start","message":{"id":"m0","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":77,"output_tokens":0}}}\n\n');
  anthropic.push('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t0","name":"write_file","input":{}}}\n\n');
  anthropic.push('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"content\\":\\"壞掉"}}\n\n');
  anthropic.push('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
  anthropic.push('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":19}}\n\n');
  anthropic.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  const anthropicResult = anthropic.finish();
  const anthropicValidation = anthropicMessagesAdapter.validateStream(anthropicResult, config);
  assert.equal(anthropicValidation.ok, false);
  assert.equal(anthropicValidation.diagnostics.messageStopped, true);
  assert.equal(anthropicValidation.diagnostics.stopReason, 'tool_use');
  assert.equal(anthropicValidation.diagnostics.usagePromptTokens, 77);
  assert.equal(anthropicValidation.diagnostics.usageCompletionTokens, 19);
  assert.equal(anthropicValidation.diagnostics.usageTotalTokens, 96);
  assert.equal(anthropicValidation.diagnostics.parseErrorOffsetUnit, 'utf16_code_unit');
});

test('attempt progress includes completion diagnostics and unambiguous global buffer utilization fields', async () => {
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const progress = [];
  const result = await performBufferedAttempt({
    fetchImpl: async () => response,
    url: 'http://upstream/v1/chat/completions', headers: {}, requestBody: '{}', streaming: true,
    adapter: chatCompletionsAdapter, config: loadCommonConfig({}), requestId: 'completion-progress',
    bufferBudget: new BufferBudget(1024 * 1024), timeoutMs: 1000,
    observer: { onProgress: (snapshot) => progress.push(snapshot) },
  });
  assert.equal(result.kind, 'success');
  const final = progress.at(-1);
  assert.equal(final.doneReceived, true);
  assert.equal(final.finishReason, 'stop');
  assert.deepEqual(final.finishReasonsByChoice, { 0: 'stop' });
  assert.equal(final.usagePromptTokens, 3);
  assert.equal(final.usageCompletionTokens, 2);
  assert.equal(final.usageTotalTokens, 5);
  assert.equal(final.globalBufferUtilizationRatio, final.globalBufferUtilization);
  assert.equal(final.globalBufferUtilizationPercent, Number((final.globalBufferUtilizationRatio * 100).toFixed(4)));
});

test('Tool Result context separates full history from the trailing latest Tool round-trip', () => {
  const chat = summarizeToolResultContext({
    messages: [
      { role: 'user', content: 'old' },
      { role: 'assistant', tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'old-call', content: 'old result' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'new' },
      { role: 'assistant', tool_calls: [{ id: 'new-a', type: 'function', function: { name: 'search', arguments: '{}' } }, { id: 'new-b', type: 'function', function: { name: 'fetch', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'new-a', content: 'a' },
      { role: 'tool', tool_call_id: 'new-b', content: 'b' },
    ],
  });
  assert.equal(chat.history.length, 3);
  assert.deepEqual(chat.latestTurn.map((item) => item.id), ['new-a', 'new-b']);

  const anthropic = summarizeToolResultContext({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't-old', name: 'search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-old', content: 'old' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't-new', name: 'fetch', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-new', content: 'new' }] },
    ],
  });
  assert.equal(anthropic.history.length, 2);
  assert.deepEqual(anthropic.latestTurn.map((item) => item.id), ['t-new']);

  const responses = summarizeToolResultContext({
    input: [
      { type: 'function_call', call_id: 'r-old', name: 'search', arguments: '{}' },
      { type: 'function_call_output', call_id: 'r-old', output: 'old' },
      { type: 'message', role: 'user', content: 'new' },
      { type: 'function_call', call_id: 'r-new', name: 'fetch', arguments: '{}' },
      { type: 'function_call_output', call_id: 'r-new', output: 'new' },
    ],
  });
  assert.equal(responses.history.length, 2);
  assert.deepEqual(responses.latestTurn.map((item) => item.id), ['r-new']);
});

test('runtime logs latest Tool Results separately from historical Tool Result context', async (t) => {
  const logs = [];
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const suite = openAiRuntime({ upstreamUrl, logs });
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const body = {
    model: 'm', stream: true,
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'old', content: 'old' },
      { role: 'assistant', content: 'done' },
      { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'new', content: 'new' },
    ],
  };
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await response.text();

  const context = logs.find((row) => row.event === 'tool_result_context');
  assert.equal(context.historyCount, 2);
  assert.equal(context.latestTurnCount, 1);
  const received = logs.find((row) => row.event === 'tool_results_received');
  assert.equal(received.count, 1);
  assert.equal(received.historyCount, 2);
  assert.deepEqual(received.toolCallIds, ['new']);
});

test('runtime detects identical client retries and carries the previous terminal failure', async (t) => {
  const logs = [];
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"bad","type":"function","function":{"name":"write_file","arguments":"{\\"content\\":\\"broken"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const suite = openAiRuntime({ upstreamUrl, logs, env: { CLIENT_RETRY_FINGERPRINT_TTL_MS: '60000' } });
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });
  const requestBody = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'write' }] });

  for (let i = 0; i < 2; i += 1) {
    const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' }, body: requestBody,
    });
    await response.text();
  }

  const retry = logs.find((row) => row.event === 'client_retry_detected');
  assert.ok(retry);
  assert.equal(retry.previousTerminalEvent, 'request_failed');
  assert.equal(retry.previousFailureReason, 'malformed_tool_arguments');
  assert.equal(retry.retryOrdinal, 1);
  assert.equal(typeof retry.retryDelayMs, 'number');
  assert.match(retry.requestFingerprint, /^[a-f0-9]{16}$/);
  assert.notEqual(retry.previousRequestId, retry.requestId);
  assert.equal(suite.metrics.clientRetriesDetectedTotal, 1);
});

test('Tool argument warning and critical thresholds emit once per attempt and Tool Call', async (t) => {
  const logs = [];
  const largeValue = 'x'.repeat(80);
  const argumentsJson = JSON.stringify({ path: '/tmp/a', content: largeValue });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'large', type: 'function', function: { name: 'write_file', arguments: argumentsJson } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  const upstreamUrl = await listen(upstream);
  const suite = openAiRuntime({ upstreamUrl, logs, env: { TOOL_ARGUMENT_WARNING_BYTES: '32', TOOL_ARGUMENT_CRITICAL_BYTES: '64' } });
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'write' }] }),
  });
  await response.text();

  const warnings = logs.filter((row) => row.event === 'tool_argument_growth_warning');
  const critical = logs.filter((row) => row.event === 'tool_argument_growth_critical');
  assert.equal(warnings.length, 1);
  assert.equal(critical.length, 1);
  assert.equal(warnings[0].toolCallKey, 'choice:0/tool:0');
  assert.equal(warnings[0].toolName, 'write_file');
  assert.equal(warnings[0].attempt, 1);
  assert.equal(critical[0].thresholdBytes, 64);
  assert.ok(critical[0].toolArgumentBytes >= 64);
  assert.equal(suite.metrics.toolArgumentWarningsTotal, 1);
  assert.equal(suite.metrics.toolArgumentCriticalTotal, 1);
});

test('config exposes Tool growth and client retry fingerprint controls', () => {
  const config = loadCommonConfig({
    TOOL_ARGUMENT_WARNING_BYTES: '8192', TOOL_ARGUMENT_CRITICAL_BYTES: '16384',
    CLIENT_RETRY_FINGERPRINT_TTL_MS: '120000', CLIENT_RETRY_FINGERPRINT_MAX_ENTRIES: '1234',
  });
  assert.equal(config.toolArgumentWarningBytes, 8192);
  assert.equal(config.toolArgumentCriticalBytes, 16384);
  assert.equal(config.clientRetryFingerprintTtlMs, 120000);
  assert.equal(config.clientRetryFingerprintMaxEntries, 1234);
  const normalized = loadCommonConfig({ TOOL_ARGUMENT_WARNING_BYTES: '8192', TOOL_ARGUMENT_CRITICAL_BYTES: '4096' });
  assert.equal(normalized.toolArgumentCriticalBytes, 8192);
});


test('request fingerprint registry expires old entries and preserves retry ordinals within TTL', () => {
  const registry = new RequestFingerprintRegistry({ ttlMs: 100, maxEntries: 2 });
  const fingerprint = fingerprintRequest('/v1/chat/completions', Buffer.from('{"x":1}'));
  assert.equal(registry.observe(fingerprint, 'r1', 0), null);
  registry.complete(fingerprint, 'r1', 'request_failed', { reason: 'malformed_tool_arguments', retryable: false }, 10);
  const retry = registry.observe(fingerprint, 'r2', 20);
  assert.equal(retry.previousRequestId, 'r1');
  assert.equal(retry.retryOrdinal, 1);
  assert.equal(retry.previousTerminalFields.reason, 'malformed_tool_arguments');
  assert.equal(registry.observe(fingerprint, 'r3', 121), null);
});
