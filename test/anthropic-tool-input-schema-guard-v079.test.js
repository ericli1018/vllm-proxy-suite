import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  createAnthropicGuardedRoute,
  createAnthropicProxyRuntime,
  loadAnthropicConfig,
} from '../apps/vllm-cc-proxy/server.js';
import { validateExposedClaudeCodeToolCalls } from '../packages/anthropic/claude-code-tools/recovery.js';

const tools = [
  {
    name: 'TaskUpdate',
    description: 'Update an existing task',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        metadata: {
          type: 'object',
          properties: {
            labels: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
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
    messages: [{ role: 'user', content: 'Update the completed task, checking the task list first if its id is unknown.' }],
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

test('Tool Input Schema Guard is enabled by default and can be disabled from the environment', () => {
  assert.equal(loadAnthropicConfig({}).claudeCodeToolInputSchemaGuardEnabled, true);
  assert.equal(loadAnthropicConfig({ CLAUDE_CODE_TOOL_INPUT_SCHEMA_GUARD_ENABLED: 'false' }).claudeCodeToolInputSchemaGuardEnabled, false);
});

test('normal Tool Calls are schema-validated before replay', () => {
  const config = configFor('http://127.0.0.1:1');
  const route = createAnthropicGuardedRoute(config);
  const originalBody = requestBody();
  const attempt = {
    result: {
      blocks: [{ type: 'tool_use', id: 'task-update-1', name: 'TaskUpdate', input: { status: 'completed' } }],
      messageStopped: true,
      stopReason: 'tool_use',
    },
  };

  const validation = route.validateAttempt(attempt, { originalBody, firstBody: originalBody });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'invalid_tool_input_schema');
  assert.equal(validation.context.toolName, 'TaskUpdate');
  assert.equal(validation.context.toolCallId, 'task-update-1');
  assert.equal(validation.diagnostics.schemaInputPath, '$');
  assert.equal(validation.diagnostics.schemaKeyword, 'required');
  assert.match(validation.detail, /taskId/);
});

test('recursive schema validation covers nested arrays and additionalProperties', () => {
  const valid = validateExposedClaudeCodeToolCalls({
    request: { tools },
    output: {
      toolCalls: [{
        id: 'valid',
        name: 'TaskUpdate',
        parsedArguments: { taskId: '7', status: 'completed', metadata: { labels: ['stage-1'] } },
      }],
    },
  });
  assert.equal(valid.ok, true);

  const invalidArray = validateExposedClaudeCodeToolCalls({
    request: { tools },
    output: {
      toolCalls: [{
        id: 'bad-array',
        name: 'TaskUpdate',
        parsedArguments: { taskId: '7', metadata: { labels: ['ok', 42] } },
      }],
    },
  });
  assert.equal(invalidArray.ok, false);
  assert.equal(invalidArray.reason, 'invalid_tool_input_schema');
  assert.equal(invalidArray.diagnostics.schemaInputPath, '$.metadata.labels[1]');
  assert.equal(invalidArray.diagnostics.schemaKeyword, 'type');

  const invalidExtra = validateExposedClaudeCodeToolCalls({
    request: { tools },
    output: {
      toolCalls: [{
        id: 'bad-extra',
        name: 'TaskUpdate',
        parsedArguments: { taskId: '7', metadata: { unknown: true } },
      }],
    },
  });
  assert.equal(invalidExtra.ok, false);
  assert.equal(invalidExtra.reason, 'invalid_tool_input_schema');
  assert.equal(invalidExtra.diagnostics.schemaInputPath, '$.metadata.unknown');
  assert.equal(invalidExtra.diagnostics.schemaKeyword, 'additionalProperties');
});

test('runtime recovers TaskUpdate without taskId using generic auto continuation', async (t) => {
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
      ? toolSse('TaskUpdate', { status: 'completed' }, 'bad-update')
      : toolSse('TaskList', {}, 'list-tasks'));
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
  assert.match(text, /"name":"TaskList"/);
  assert.deepEqual(received[1].tool_choice, { type: 'auto' });
  assert.deepEqual(received[1].tools.map((tool) => tool.name), ['TaskUpdate', 'TaskList']);
  assert.match(String(received[1].system), /required input fields were missing/i);
  assert.match(String(received[1].system), /do not invent missing identifiers/i);
  assert.ok(logs.some((row) => row.event === 'tool_input_schema_recovery_started'
    && row.rejectedToolName === 'TaskUpdate'
    && row.schemaKeyword === 'required'));
  assert.ok(logs.some((row) => row.event === 'recovery_request_built'
    && row.recoveryMode === 'output_required'
    && row.recoveryOriginReason === 'invalid_tool_input_schema'
    && row.recoveryToolChoice === 'auto'));
  assert.equal(runtime.metrics.toolInputSchemaRecoveriesDetectedTotal, 1);
  assert.equal(runtime.metrics.toolInputSchemaRecoveriesFusedTotal, 0);
});

test('runtime fuses repeated schema-invalid Tool input as non-retryable', async (t) => {
  let attempts = 0;
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(toolSse('TaskUpdate', { status: 'completed' }, `bad-update-${attempts}`));
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
  assert.ok(logs.some((row) => row.event === 'tool_input_schema_recovery_fused'));
  assert.equal(runtime.metrics.toolInputSchemaRecoveriesDetectedTotal, 2);
  assert.equal(runtime.metrics.toolInputSchemaRecoveriesFusedTotal, 1);
});

test('Tool Input Schema Guard can be disabled', async (t) => {
  let attempts = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(toolSse('TaskUpdate', { status: 'completed' }, 'unguarded-update'));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createAnthropicProxyRuntime({
    config: configFor(upstreamUrl, { claudeCodeToolInputSchemaGuardEnabled: false }),
    exposeControlRoutes: false,
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
  assert.equal(attempts, 1);
  assert.match(text, /"name":"TaskUpdate"/);
});
