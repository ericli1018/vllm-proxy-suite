import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  buildAnthropicActionRequiredRecovery,
  detectAnthropicActionIntentWithoutToolCall,
  summarizeAnthropicExecutionContext,
  summarizeAnthropicToolContext,
  validateAnthropicActionRequiredRecovery,
} from '../packages/anthropic/action-intent.js';
import {
  createAnthropicProxyRuntime,
  loadAnthropicConfig,
} from '../apps/vllm-cc-proxy/server.js';

const tools = [
  {
    name: 'Bash',
    description: 'Execute a shell command',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read a file',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
];

function completion(stopReason = 'end_turn') {
  return {
    messageStopped: true,
    stopReason,
  };
}

function output(finalText, toolCalls = []) {
  return { finalText, toolCalls };
}

function baseRequest() {
  return {
    model: 'm',
    stream: true,
    max_tokens: 8192,
    messages: [{ role: 'user', content: '開始執行階段 1' }],
    tools,
    tool_choice: { type: 'auto' },
  };
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

function textSse(text, { thinking = 'Need to inspect the workspace.', stopReason = 'end_turn' } = {}) {
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

function toolSse(name = 'Bash', input = { command: 'pwd' }) {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m2","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name, input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":20}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
}

test('Anthropic tool context reports incoming tool availability and choice', () => {
  assert.deepEqual(summarizeAnthropicToolContext(baseRequest()), {
    requestToolCount: 2,
    requestToolNames: ['Bash', 'Read'],
    requestToolChoice: 'auto',
    requestToolsEnabled: true,
    parallelToolCallsDisabled: false,
  });
});



test('Anthropic execution context detects only an explicit latest user continuation', () => {
  assert.deepEqual(summarizeAnthropicExecutionContext({
    messages: [{ role: 'user', content: '繼續' }],
  }), {
    latestInputKind: 'user',
    latestInputTextChars: 2,
    explicitContinueDetected: true,
  });

  assert.deepEqual(summarizeAnthropicExecutionContext({
    messages: [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
    }],
  }), {
    latestInputKind: 'tool_result',
    latestInputTextChars: 0,
    explicitContinueDetected: false,
  });
});

test('Anthropic action-intent guard detects immediate narration with end_turn', () => {
  const validation = detectAnthropicActionIntentWithoutToolCall({
    requestBody: baseRequest(),
    output: output('好的，我開始執行階段 1。先查看當前目錄結構。'),
    completion: completion('end_turn'),
    recovery: false,
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'action_intent_without_tool_call');
  assert.equal(validation.retryable, true);
  assert.equal(validation.diagnostics.requestToolCount, 2);
  assert.equal(validation.diagnostics.actionIntentDetected, true);
});

test('Anthropic action-intent guard detects immediate server test narration without matching status reports or plans', () => {
  for (const finalText of [
    '憑證已存在。讓我測試 server。',
    'Let me test the TLS server now.',
    '讓我驗證 TLS handshake。',
  ]) {
    const validation = detectAnthropicActionIntentWithoutToolCall({
      requestBody: baseRequest(),
      output: output(finalText),
      completion: completion('end_turn'),
      recovery: false,
    });
    assert.equal(validation.ok, false, finalText);
    assert.equal(validation.reason, 'action_intent_without_tool_call');
    assert.equal(validation.retryable, true);
  }

  for (const finalText of [
    'TLS server 測試已完成。',
    '階段 2 的下一步是測試 server。',
    '確認後再測試 server。',
  ]) {
    assert.deepEqual(detectAnthropicActionIntentWithoutToolCall({
      requestBody: baseRequest(),
      output: output(finalText),
      completion: completion('end_turn'),
    }), { ok: true }, finalText);
  }
});

test('Anthropic action-intent guard ignores plans, final answers, tool responses, and disabled tools', () => {
  assert.deepEqual(detectAnthropicActionIntentWithoutToolCall({
    requestBody: baseRequest(),
    output: output('階段 1 的規劃如下：先檢查目錄，再建立 Makefile。'),
    completion: completion('end_turn'),
  }), { ok: true });

  assert.deepEqual(detectAnthropicActionIntentWithoutToolCall({
    requestBody: baseRequest(),
    output: output('規劃已完成，等待你的確認。'),
    completion: completion('end_turn'),
  }), { ok: true });

  assert.deepEqual(detectAnthropicActionIntentWithoutToolCall({
    requestBody: baseRequest(),
    output: output('', [{ name: 'Bash', parsedArguments: { command: 'pwd' }, id: 't1' }]),
    completion: completion('tool_use'),
  }), { ok: true });

  assert.deepEqual(detectAnthropicActionIntentWithoutToolCall({
    requestBody: { ...baseRequest(), tool_choice: { type: 'none' } },
    output: output('好的，我開始執行。'),
    completion: completion('end_turn'),
  }), { ok: true });
});

test('Anthropic action-required recovery preserves tools and forces one immediate tool path', () => {
  const original = baseRequest();
  const issue = detectAnthropicActionIntentWithoutToolCall({
    requestBody: original,
    output: output('好的，我開始執行。'),
    completion: completion(),
  });
  const recovery = buildAnthropicActionRequiredRecovery({
    original,
    prepared: original,
    issue,
    config: configFor('http://127.0.0.1:1'),
  });

  assert.equal(recovery.plan.mode, 'action_required');
  assert.deepEqual(recovery.body.tools, tools);
  assert.deepEqual(recovery.body.tool_choice, { type: 'any', disable_parallel_tool_use: true });
  assert.match(recovery.body.system, /described an immediate action but ended without a tool call/i);
  assert.match(recovery.body.system, /Produce at least one tool call now/i);
  assert.equal(recovery.diagnostics.recoveryMode, 'action_required');
  assert.equal(recovery.diagnostics.recoveryToolCount, 2);
});

test('Anthropic action-required recovery validation fails closed without a Tool Call', () => {
  const plan = { mode: 'action_required', candidateNames: ['Bash', 'Read'] };
  assert.deepEqual(validateAnthropicActionRequiredRecovery(output('', [{ name: 'Bash' }]), plan), { ok: true });
  const validation = validateAnthropicActionRequiredRecovery(output('我現在開始執行。'), plan);
  assert.equal(validation.reason, 'action_intent_without_tool_call');
  assert.equal(validation.retryable, false);
  assert.equal(validation.diagnostics.actionIntentRecoveryAttempted, true);
});

test('Claude Code runtime discards narration and replays only the recovered Tool Call', async (t) => {
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
      ? textSse('好的，我開始執行階段 1。先查看當前目錄結構。')
      : toolSse());
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
    body: JSON.stringify(baseRequest()),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.doesNotMatch(text, /我開始執行階段/);
  assert.match(text, /"name":"Bash"/);
  assert.deepEqual(received[1].tools, tools);
  assert.deepEqual(received[1].tool_choice, { type: 'any', disable_parallel_tool_use: true });
  assert.ok(logs.some((row) => row.event === 'request_tool_context'
    && row.incomingToolCount === 2
    && row.upstreamToolCount === 2));
  assert.ok(logs.some((row) => row.event === 'action_intent_without_tool_call_detected'));
  assert.ok(logs.some((row) => row.event === 'recovery_request_built'
    && row.recoveryMode === 'action_required'));
  assert.equal(runtime.metrics.actionIntentWithoutToolCallDetectedTotal, 1);
  assert.equal(runtime.metrics.actionIntentRecoveriesFusedTotal, 0);
});

test('Claude Code server-test narration performs exactly one Recovery and suppresses client retry after a second narration-only result', async (t) => {
  let attempts = 0;
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(attempts === 1
      ? textSse('憑證已存在。讓我測試 server。')
      : textSse('讓我驗證 TLS handshake。'));
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
    body: JSON.stringify(baseRequest()),
  });
  const text = await response.text();

  assert.equal(attempts, 2);
  assert.equal(response.status, 422);
  assert.match(text, /action_intent_without_tool_call/);
  assert.match(text, /"retryable":false/);
  assert.ok(logs.some((row) => row.event === 'action_intent_without_tool_call_detected'));
  assert.ok(logs.some((row) => row.event === 'action_intent_without_tool_call_fused'));
  assert.equal(runtime.metrics.recoveriesTotal, 1);
  assert.equal(runtime.metrics.actionIntentRecoveriesFusedTotal, 1);
});

test('Claude Code server-test narration recovers once into a Tool Call', async (t) => {
  let attempts = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(attempts === 1
      ? textSse('憑證已存在。讓我測試 server。')
      : toolSse('Bash', { command: './tls-server --test' }));
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
    body: JSON.stringify(baseRequest()),
  });
  const text = await response.text();

  assert.equal(attempts, 2);
  assert.equal(response.status, 200);
  assert.match(text, /"name":"Bash"/);
  assert.doesNotMatch(text, /讓我測試 server/);
});

test('Claude Code action-required Recovery converts thinking-only end_turn into non-retryable fused failure', async (t) => {
  let attempts = 0;
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(attempts === 1
      ? textSse('好的，我開始執行階段 1。先查看當前目錄結構。')
      : textSse(null, { thinking: 'I should inspect the directory now.' }));
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
    body: JSON.stringify(baseRequest()),
  });
  const text = await response.text();

  assert.equal(attempts, 2);
  assert.equal(response.status, 422);
  assert.match(text, /action_intent_without_tool_call/);
  assert.match(text, /"retryable":false/);
  assert.ok(logs.some((row) => row.event === 'action_intent_without_tool_call_fused'
    && row.recoveryFailureReason === 'thinking_without_output'));
  assert.equal(runtime.metrics.actionIntentWithoutToolCallDetectedTotal, 2);
  assert.equal(runtime.metrics.actionIntentRecoveriesFusedTotal, 1);
});


test('Claude Code thinking-only Recovery keeps auto tool choice and may answer the user with text', async (t) => {
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
      ? textSse(null, { thinking: 'I should decide whether a tool is necessary.' })
      : textSse('階段 1 的規劃已完成，請確認後我再開始實作。', { thinking: 'A user-facing planning response is sufficient.' }));
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

  const request = baseRequest();
  request.messages = [{ role: 'user', content: '繼續' }];
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const text = await response.text();

  assert.equal(attempts, 2);
  assert.equal(response.status, 200);
  assert.deepEqual(received[1].tools, tools);
  assert.deepEqual(received[1].tool_choice, { type: 'auto' });
  assert.match(text, /規劃已完成/);
  assert.ok(logs.some((row) => row.event === 'recovery_request_built'
    && row.recoveryMode === 'output_required'
    && row.recoveryOriginReason === 'thinking_without_output'
    && row.forcedToolChoice === false));
  assert.equal(runtime.metrics.thinkingWithoutOutputRecoveriesFusedTotal, 0);
});

test('Claude Code thinking-only Recovery fuses a second empty output without forcing a tool', async (t) => {
  let attempts = 0;
  const received = [];
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(textSse(null, { thinking: attempts === 1
      ? 'I should continue and decide the next response.'
      : 'I still have not produced a visible response.' }));
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

  const request = baseRequest();
  request.messages = [{ role: 'user', content: '繼續' }];
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const text = await response.text();

  assert.equal(attempts, 2);
  assert.equal(response.status, 422);
  assert.deepEqual(received[1].tools, tools);
  assert.deepEqual(received[1].tool_choice, { type: 'auto' });
  assert.match(text, /thinking_without_output/);
  assert.match(text, /"retryable":false/);
  assert.ok(logs.some((row) => row.event === 'recovery_request_built'
    && row.recoveryMode === 'output_required'
    && row.recoveryOriginReason === 'thinking_without_output'
    && row.forcedToolChoice === false));
  assert.ok(logs.some((row) => row.event === 'thinking_without_output_fused'));
  assert.equal(runtime.metrics.thinkingWithoutOutputRecoveriesFusedTotal, 1);
});
