import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  createAnthropicGuardedRoute,
  createAnthropicProxyRuntime,
  loadAnthropicConfig,
} from '../apps/vllm-cc-proxy/server.js';

const tools = [
  {
    name: 'Write',
    description: 'Write a file',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Bash',
    description: 'Execute a shell command',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
];

function requestBody() {
  return {
    model: 'm',
    stream: true,
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-web', content: 'research complete' }],
    }],
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

function toolSse(name, input) {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-invalid', name, input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":20}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
}

function textSse(text) {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m2","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":20}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
}

test('targetless invalid Write input selects generic output-required Recovery instead of exact-target Recovery', () => {
  const config = configFor('http://127.0.0.1:1');
  const route = createAnthropicGuardedRoute(config);
  const originalBody = requestBody();
  const attempt = {
    result: {
      blocks: [{ type: 'tool_use', id: 'w1', name: 'Write', input: {} }],
      finalText: '',
      completion: { messageStopped: true, stopReason: 'tool_use' },
    },
  };

  const validation = route.validateAttempt(attempt, { originalBody, firstBody: originalBody });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'invalid_claude_code_tool_input');
  assert.equal(validation.context.targetPath, null);

  const recovery = route.buildRecovery({
    originalBody,
    firstBody: route.prepareRequest(originalBody),
    reason: validation,
  });

  assert.equal(recovery.plan.mode, 'output_required');
  assert.equal(recovery.plan.originReason, 'invalid_claude_code_tool_input');
  assert.equal(recovery.plan.targetlessToolRecovery, true);
  assert.deepEqual(recovery.body.tools.map((tool) => tool.name), ['Write', 'Bash']);
  assert.deepEqual(recovery.body.tool_choice, { type: 'auto' });
  assert.match(recovery.body.system, /tool call had incomplete or invalid input/i);
  assert.match(recovery.body.system, /do not assume the rejected tool must be used/i);
});

test('runtime recovers Write({}) with generic continuation and preserves auto Tool choice', async (t) => {
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
      ? toolSse('Write', {})
      : textSse('階段 1 規劃已完成，等待你的確認。'));
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
    body: JSON.stringify(requestBody()),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.match(text, /階段 1 規劃已完成/);
  assert.deepEqual(received[1].tool_choice, { type: 'auto' });
  assert.deepEqual(received[1].tools.map((tool) => tool.name), ['Write', 'Bash']);
  assert.ok(logs.some((row) => row.event === 'targetless_tool_recovery_started'));
  assert.ok(logs.some((row) => row.event === 'recovery_request_built'
    && row.recoveryMode === 'output_required'
    && row.recoveryOriginReason === 'invalid_claude_code_tool_input'
    && row.targetlessToolRecovery === true));
  assert.ok(!logs.some((row) => row.event === 'recovery_request_rejected'));
});

test('runtime fuses repeated targetless invalid Tool input as non-retryable', async (t) => {
  let attempts = 0;
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(toolSse('Write', {}));
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
    body: JSON.stringify(requestBody()),
  });
  const text = await response.text();

  assert.equal(attempts, 2);
  assert.equal(response.status, 422);
  assert.match(text, /invalid_claude_code_tool_input/);
  assert.match(text, /"retryable":false/);
  assert.ok(logs.some((row) => row.event === 'targetless_tool_recovery_fused'));
});
