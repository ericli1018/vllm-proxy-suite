import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  createAnthropicProxyRuntime,
  loadAnthropicConfig,
} from '../apps/vllm-cc-proxy/server.js';

const tools = [
  {
    name: 'TaskCreate',
    description: 'Create a task',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['subject', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'TaskUpdate',
    description: 'Update a task',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'TaskList',
    description: 'List tasks',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

function requestBody() {
  return {
    model: 'm',
    stream: true,
    max_tokens: 8192,
    messages: [{ role: 'user', content: '開始階段 2，先建立階段 2 任務。' }],
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

function toolSse(name, input, id = `tool-${name.toLowerCase()}`) {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":20}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
}

function textSse(text) {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":20}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
}


test('targeted schema correction is enabled by default and can be disabled', () => {
  assert.equal(loadAnthropicConfig({}).claudeCodeTargetedSchemaCorrectionEnabled, true);
  assert.equal(loadAnthropicConfig({ CLAUDE_CODE_TARGETED_SCHEMA_CORRECTION_ENABLED: 'false' }).claudeCodeTargetedSchemaCorrectionEnabled, false);
});

test('single additional property uses forced targeted schema correction', async (t) => {
  let attempts = 0;
  const received = [];
  const logs = [];
  const originalArguments = {
    subject: '階段 2：TLS Server 實作',
    description: '實作 libuv 與 OpenSSL TLS server。',
    status: 'pending',
  };
  const correctedArguments = {
    subject: originalArguments.subject,
    description: originalArguments.description,
  };

  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(attempts === 1
      ? toolSse('TaskCreate', originalArguments, 'bad-create')
      : toolSse('TaskCreate', correctedArguments, 'corrected-create'));
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
  assert.match(text, /"name":"TaskCreate"/);
  assert.deepEqual(received[1].tools.map((tool) => tool.name), ['TaskCreate']);
  assert.deepEqual(received[1].tool_choice, {
    type: 'tool',
    name: 'TaskCreate',
    disable_parallel_tool_use: true,
  });
  assert.equal(received[1].messages.length, 1);
  assert.match(String(received[1].system), /schema correction/i);
  assert.match(String(received[1].system), /\$\.status/);
  assert.match(String(received[1].system), /preserve all other argument values exactly/i);
  assert.ok(logs.some((row) => row.event === 'tool_input_schema_correction_started'
    && row.rejectedToolName === 'TaskCreate'
    && row.removedInputPath === '$.status'));
  assert.ok(logs.some((row) => row.event === 'recovery_request_built'
    && row.recoveryMode === 'schema_correction'
    && row.recoveryContextMode === 'scoped'
    && row.recoveryToolChoice === 'TaskCreate'
    && row.forcedToolChoice === true));
  assert.ok(logs.some((row) => row.event === 'tool_input_schema_correction_completed'));
  assert.equal(runtime.metrics.toolInputSchemaCorrectionsStartedTotal, 1);
  assert.equal(runtime.metrics.toolInputSchemaCorrectionsSucceededTotal, 1);
  assert.equal(runtime.metrics.toolInputSchemaCorrectionsFusedTotal, 0);
});

test('targeted correction rejects text-only recovery instead of abandoning the Tool Call', async (t) => {
  let attempts = 0;
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(attempts === 1
      ? toolSse('TaskCreate', { subject: 'Stage 2', description: 'Implement it', status: 'pending' }, 'bad-create')
      : textSse('任務清單已準備完成。'));
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
  assert.equal(response.status, 502);
  assert.match(text, /invalid_tool_input_schema/);
  assert.match(text, /"retryable":false/);
  assert.ok(logs.some((row) => row.event === 'tool_input_schema_correction_fused'));
  assert.equal(runtime.metrics.toolInputSchemaCorrectionsStartedTotal, 1);
  assert.equal(runtime.metrics.toolInputSchemaCorrectionsSucceededTotal, 0);
  assert.equal(runtime.metrics.toolInputSchemaCorrectionsFusedTotal, 1);
});

test('missing required identifier remains generic auto recovery', async (t) => {
  let attempts = 0;
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(attempts === 1
      ? toolSse('TaskUpdate', { status: 'completed' }, 'bad-update')
      : toolSse('TaskList', {}, 'list-tasks'));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createAnthropicProxyRuntime({ config: configFor(upstreamUrl), exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify(requestBody()),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(received[1].tool_choice, { type: 'auto' });
  assert.deepEqual(received[1].tools.map((tool) => tool.name), ['TaskCreate', 'TaskUpdate', 'TaskList']);
});


test('multiple unsupported properties remain generic auto recovery', async (t) => {
  let attempts = 0;
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(attempts === 1
      ? toolSse('TaskCreate', {
        subject: 'Stage 2',
        description: 'Implement it',
        status: 'pending',
        priority: 'high',
      }, 'bad-create')
      : toolSse('TaskList', {}, 'list-tasks'));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createAnthropicProxyRuntime({ config: configFor(upstreamUrl), exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify(requestBody()),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(received[1].tool_choice, { type: 'auto' });
  assert.deepEqual(received[1].tools.map((tool) => tool.name), ['TaskCreate', 'TaskUpdate', 'TaskList']);
});

test('disabled targeted correction falls back to generic auto recovery', async (t) => {
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
      ? toolSse('TaskCreate', { subject: 'Stage 2', description: 'Implement it', status: 'pending' }, 'bad-create')
      : toolSse('TaskList', {}, 'list-tasks'));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createAnthropicProxyRuntime({
    config: configFor(upstreamUrl, { claudeCodeTargetedSchemaCorrectionEnabled: false }),
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

  assert.equal(response.status, 200);
  assert.deepEqual(received[1].tool_choice, { type: 'auto' });
  assert.deepEqual(received[1].tools.map((tool) => tool.name), ['TaskCreate', 'TaskUpdate', 'TaskList']);
  assert.ok(logs.some((row) => row.event === 'tool_input_schema_recovery_started'));
  assert.ok(!logs.some((row) => row.event === 'tool_input_schema_correction_started'));
});
