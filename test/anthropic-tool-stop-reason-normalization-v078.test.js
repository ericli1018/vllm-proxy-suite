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
    name: 'Read',
    description: 'Read a file',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
  {
    name: 'Edit',
    description: 'Edit a file',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
];

function requestBody() {
  return {
    model: 'm',
    stream: true,
    max_tokens: 8192,
    messages: [{ role: 'user', content: 'Inspect and update the file.' }],
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

function toolSse({ id, name, input, stopReason = 'tool_use' }) {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 10 } })}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
}

async function invokeProxy({ upstreamHandler, overrides = {} }) {
  const logs = [];
  const upstream = http.createServer(upstreamHandler);
  const upstreamUrl = await listen(upstream);
  const runtime = createAnthropicProxyRuntime({
    config: configFor(upstreamUrl, overrides),
    exposeControlRoutes: false,
    logSink(line) { logs.push(JSON.parse(line)); },
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify(requestBody()),
  });
  const text = await response.text();
  await close(proxy);
  await close(upstream);
  return { response, text, logs };
}

test('Recovery normalizes a validated Read Tool Call from end_turn to tool_use before replay', async () => {
  let attempts = 0;
  const result = await invokeProxy({
    upstreamHandler: async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      attempts += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(attempts === 1
        ? toolSse({
          id: 'bad-edit',
          name: 'Edit',
          input: { file_path: '/work/a.js', old_string: 'same', new_string: 'same' },
        })
        : toolSse({
          id: 'read-current',
          name: 'Read',
          input: { file_path: '/work/a.js' },
          stopReason: 'end_turn',
        }));
    },
  });

  assert.equal(attempts, 2);
  assert.equal(result.response.status, 200);
  assert.match(result.text, /"name":"Read"/);
  assert.match(result.text, /"stop_reason":"tool_use"/);
  assert.doesNotMatch(result.text, /"stop_reason":"end_turn"/);
  assert.ok(result.logs.some((row) => row.event === 'tool_stop_reason_normalized'
    && row.phase === 'recovery'
    && row.fromStopReason === 'end_turn'
    && row.toStopReason === 'tool_use'
    && row.toolCallCount === 1));
});

test('Initial validated Tool Call also normalizes end_turn to tool_use', async () => {
  const result = await invokeProxy({
    upstreamHandler: async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(toolSse({
        id: 'read-initial',
        name: 'Read',
        input: { file_path: '/work/a.js' },
        stopReason: 'end_turn',
      }));
    },
  });

  assert.equal(result.response.status, 200);
  assert.match(result.text, /"stop_reason":"tool_use"/);
  assert.ok(result.logs.some((row) => row.event === 'tool_stop_reason_normalized'
    && row.phase === 'initial'));
});

test('invalid Tool input is rejected by the universal schema guard before stop-reason normalization', async () => {
  const result = await invokeProxy({
    upstreamHandler: async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(toolSse({
        id: 'invalid-read',
        name: 'Read',
        input: {},
        stopReason: 'end_turn',
      }));
    },
  });

  assert.equal(result.response.status, 502);
  assert.match(result.text, /invalid_tool_input_schema/);
  assert.ok(!result.logs.some((row) => row.event === 'tool_stop_reason_normalized'));
});


test('normalization can be disabled and preserves strict mismatch rejection', async () => {
  const result = await invokeProxy({
    overrides: { claudeCodeToolStopReasonNormalizationEnabled: false },
    upstreamHandler: async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(toolSse({
        id: 'read-disabled',
        name: 'Read',
        input: { file_path: '/work/a.js' },
        stopReason: 'end_turn',
      }));
    },
  });

  assert.equal(result.response.status, 502);
  assert.match(result.text, /tool_stop_reason_mismatch/);
  assert.ok(!result.logs.some((row) => row.event === 'tool_stop_reason_normalized'));
});
