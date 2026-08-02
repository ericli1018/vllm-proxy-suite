import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  buildAnthropicOutputRequiredRecovery,
  detectAnthropicPlaceholderCompletionWithoutProgress,
  isAnthropicPlaceholderCompletionText,
  validateAnthropicOutputRequiredRecovery,
} from '../packages/anthropic/action-intent.js';
import {
  createAnthropicProxyRuntime,
  loadAnthropicConfig,
} from '../apps/vllm-cc-proxy/server.js';

const tools = [{
  name: 'Bash',
  description: 'Execute a shell command',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
}];

function toolResultRequest() {
  return {
    model: 'm',
    stream: true,
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'archive extracted' }],
    }],
    tools,
    tool_choice: { type: 'auto' },
  };
}

function userRequest() {
  return {
    ...toolResultRequest(),
    messages: [{ role: 'user', content: 'What does “No response” mean?' }],
  };
}

function completion(stopReason = 'end_turn') {
  return { messageStopped: true, stopReason };
}

function output(finalText, toolCalls = []) {
  return { finalText, toolCalls };
}

function configFor(upstream, overrides = {}) {
  return Object.freeze({
    ...loadAnthropicConfig({
      VLLM_BASE_URL: upstream,
      VLLM_CC_PROXY_API_KEY: 'client-secret',
      VLLM_API_KEY: 'vllm-secret',
      HEARTBEAT_INTERVAL_MS: '60000',
      UPSTREAM_IDLE_TIMEOUT_MS: '5000',
      SEMANTIC_STALL_TIMEOUT_MS: '5000',
      TOTAL_GENERATION_TIMEOUT_MS: '5000',
      RECOVERY_TIMEOUT_MS: '5000',
      MAX_TOTAL_BUFFERED_BYTES: '1048576',
      MAX_RESPONSE_BUFFER_BYTES: '1048576',
      LOG_LEVEL: 'debug',
    }),
    port: 0,
    ...overrides,
  });
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

function textSse(text, { thinking = 'Continue from the tool result.', stopReason = 'end_turn' } = {}) {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
  ];
  let index = 0;
  if (thinking) {
    frames.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })}\n\n`);
    frames.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })}\n\n`);
    frames.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
    index += 1;
  }
  if (text !== null) {
    frames.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}\n\n`);
    frames.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })}\n\n`);
    frames.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
  }
  frames.push(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } })}\n\n`);
  frames.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  return frames.join('');
}

test('placeholder classifier matches only explicit no-response markers', () => {
  for (const text of ['No response', 'No response.', 'NO OUTPUT', '無回應', '沒有輸出。']) {
    assert.equal(isAnthropicPlaceholderCompletionText(text), true, text);
  }
  for (const text of ['完成。', 'No response was received from the server.', 'Nothing else is required.', 'N/A']) {
    assert.equal(isAnthropicPlaceholderCompletionText(text), false, text);
  }
});

test('placeholder completion guard defaults on and can be disabled explicitly', () => {
  assert.equal(loadAnthropicConfig({}).claudeCodePlaceholderCompletionGuardEnabled, true);
  assert.equal(loadAnthropicConfig({ CLAUDE_CODE_PLACEHOLDER_COMPLETION_GUARD_ENABLED: 'false' }).claudeCodePlaceholderCompletionGuardEnabled, false);
});

test('placeholder completion guard requires a latest Tool Result turn', () => {
  const detected = detectAnthropicPlaceholderCompletionWithoutProgress({
    requestBody: toolResultRequest(),
    output: output('No response'),
    completion: completion(),
  });
  assert.equal(detected.ok, false);
  assert.equal(detected.reason, 'placeholder_completion_without_progress');
  assert.equal(detected.retryable, true);
  assert.equal(detected.diagnostics.latestInputKind, 'tool_result');
  assert.equal(detected.diagnostics.placeholderText, 'no response');

  assert.deepEqual(detectAnthropicPlaceholderCompletionWithoutProgress({
    requestBody: userRequest(),
    output: output('No response'),
    completion: completion(),
  }), { ok: true });

  assert.deepEqual(detectAnthropicPlaceholderCompletionWithoutProgress({
    requestBody: toolResultRequest(),
    output: output('No response was received from the server.'),
    completion: completion(),
  }), { ok: true });
});

test('placeholder recovery preserves auto Tool choice and rejects the same placeholder again', () => {
  const original = toolResultRequest();
  const issue = detectAnthropicPlaceholderCompletionWithoutProgress({
    requestBody: original,
    output: output('No response'),
    completion: completion(),
  });
  const recovery = buildAnthropicOutputRequiredRecovery({
    original,
    prepared: original,
    issue,
    config: configFor('http://127.0.0.1:1'),
  });

  assert.equal(recovery.plan.mode, 'output_required');
  assert.equal(recovery.plan.originReason, 'placeholder_completion_without_progress');
  assert.deepEqual(recovery.body.tool_choice, { type: 'auto' });
  assert.match(recovery.body.system, /contained only a placeholder/i);
  assert.match(recovery.body.system, /Do not answer with “No response”/i);
  assert.deepEqual(validateAnthropicOutputRequiredRecovery(output('編譯已完成。'), recovery.plan), { ok: true });

  const validation = validateAnthropicOutputRequiredRecovery(output('No response'), recovery.plan);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'placeholder_completion_without_progress');
  assert.equal(validation.retryable, false);
});

test('Claude Code runtime discards No response after Tool Result and delivers substantive Recovery text', async (t) => {
  let attempts = 0;
  const received = [];
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(attempts === 1
      ? textSse('No response', { thinking: 'Response continued below' })
      : textSse('OpenSSL 已解壓完成，下一步將執行 Configure 與 make。'));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createAnthropicProxyRuntime({
    config: configFor(upstreamUrl),
    exposeControlRoutes: false,
    logSink(line) { logs.push(JSON.parse(line)); },
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify(toolResultRequest()),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.doesNotMatch(text, /No response/);
  assert.match(text, /OpenSSL 已解壓完成/);
  assert.deepEqual(received[1].tool_choice, { type: 'auto' });
  assert.ok(logs.some((row) => row.event === 'placeholder_completion_without_progress_detected'));
  assert.ok(logs.some((row) => row.event === 'recovery_request_built'
    && row.recoveryMode === 'output_required'
    && row.recoveryOriginReason === 'placeholder_completion_without_progress'
    && row.forcedToolChoice === false));
  assert.equal(runtime.metrics.placeholderCompletionsDetectedTotal, 1);
  assert.equal(runtime.metrics.placeholderRecoveriesFusedTotal, 0);
});

test('Claude Code runtime fuses repeated No response Recovery as non-retryable', async (t) => {
  let attempts = 0;
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(textSse('No response'));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createAnthropicProxyRuntime({
    config: configFor(upstreamUrl),
    exposeControlRoutes: false,
    logSink(line) { logs.push(JSON.parse(line)); },
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify(toolResultRequest()),
  });
  const text = await response.text();

  assert.equal(attempts, 2);
  assert.equal(response.status, 422);
  assert.match(text, /placeholder_completion_without_progress/);
  assert.match(text, /"retryable":false/);
  assert.ok(logs.some((row) => row.event === 'placeholder_completion_without_progress_fused'));
  assert.equal(runtime.metrics.placeholderCompletionsDetectedTotal, 2);
  assert.equal(runtime.metrics.placeholderRecoveriesFusedTotal, 1);
});

test('Claude Code runtime fuses thinking-only placeholder Recovery under the original reason', async (t) => {
  let attempts = 0;
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(attempts === 1
      ? textSse('No response')
      : textSse(null, { thinking: 'I still need to decide what to do.' }));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createAnthropicProxyRuntime({
    config: configFor(upstreamUrl),
    exposeControlRoutes: false,
    logSink(line) { logs.push(JSON.parse(line)); },
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify(toolResultRequest()),
  });
  const text = await response.text();

  assert.equal(attempts, 2);
  assert.equal(response.status, 422);
  assert.match(text, /placeholder_completion_without_progress/);
  assert.match(text, /"retryable":false/);
  assert.ok(logs.some((row) => row.event === 'placeholder_completion_without_progress_fused'
    && row.recoveryFailureReason === 'thinking_without_output'));
  assert.equal(runtime.metrics.placeholderCompletionsDetectedTotal, 2);
  assert.equal(runtime.metrics.placeholderRecoveriesFusedTotal, 1);
});

test('Claude Code runtime can disable the placeholder guard for a Tool Result turn', async (t) => {
  let attempts = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(textSse('No response'));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createAnthropicProxyRuntime({
    config: configFor(upstreamUrl, { claudeCodePlaceholderCompletionGuardEnabled: false }),
    exposeControlRoutes: false,
    logSink() {},
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify(toolResultRequest()),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(attempts, 1);
  assert.match(text, /No response/);
});

test('Claude Code runtime leaves No response untouched outside a Tool Result turn', async (t) => {
  let attempts = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(textSse('No response'));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createAnthropicProxyRuntime({
    config: configFor(upstreamUrl),
    exposeControlRoutes: false,
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify(userRequest()),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(attempts, 1);
  assert.match(text, /No response/);
});
