import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createProtocolProxyServer } from '../packages/server/create-proxy-server.js';
import { loadCommonConfig } from '../packages/core/config.js';
import {
  anthropicMessagesAdapter,
  applyAnthropicRequestPolicy,
  buildAnthropicRecoveryRequest,
} from '../packages/anthropic/messages.js';
import {
  analyzeClaudeCodeToolAttempt,
  buildClaudeCodeToolRecovery,
  validateClaudeCodeToolRecovery,
} from '../packages/anthropic/claude-code-tools/recovery.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function configFor(upstream) {
  return Object.freeze({
    ...loadCommonConfig({
      PROXY_API_KEY: 'client-secret',
      VLLM_API_KEY: 'vllm-secret',
      VLLM_BASE_URL: upstream,
      HEARTBEAT_INTERVAL_MS: '60000',
      UPSTREAM_IDLE_TIMEOUT_MS: '5000',
      SEMANTIC_STALL_TIMEOUT_MS: '5000',
      TOTAL_GENERATION_TIMEOUT_MS: '5000',
      RECOVERY_TIMEOUT_MS: '5000',
      MAX_TOTAL_BUFFERED_BYTES: '1048576',
      MAX_RESPONSE_BUFFER_BYTES: '1048576',
    }),
    port: 0,
    defaultEnableThinking: true,
    defaultMaxTokens: 8192,
    claudeCodeToolRecoveryEnabled: true,
    claudeCodeEditRecoveryEnabled: true,
    claudeCodeWriteRecoveryEnabled: true,
    claudeCodeNotebookEditRecoveryEnabled: true,
    claudeCodeBashInvalidatesReads: true,
  });
}

function toolSse({ id, name, input }) {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
}

function createRoute(config) {
  return {
    adapter: anthropicMessagesAdapter,
    prepareRequest(body) { return applyAnthropicRequestPolicy(body, config); },
    validateAttempt(attempt, { originalBody, recovery = false }) {
      const validation = analyzeClaudeCodeToolAttempt({
        request: originalBody,
        output: anthropicMessagesAdapter.extractOutput(attempt.result),
        config,
      });
      return validation.ok ? validation : { ...validation, retryable: !recovery };
    },
    buildRecovery({ originalBody, reason }) {
      if (reason.context) return buildClaudeCodeToolRecovery({ original: originalBody, issue: reason, config });
      return { body: buildAnthropicRecoveryRequest(originalBody, reason.reason, config), plan: null };
    },
    validateRecovery(attempt, recovery) {
      if (!recovery.plan) return { ok: true };
      return validateClaudeCodeToolRecovery(anthropicMessagesAdapter.extractOutput(attempt.result), recovery.plan);
    },
  };
}

test('semantic no-op Edit is discarded and only exact Read recovery reaches Claude Code', async (t) => {
  let attempts = 0;
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push(body);
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempts === 1) {
      res.end(toolSse({
        id: 'bad-edit',
        name: 'Edit',
        input: { file_path: '/work/a.js', old_string: 'same', new_string: 'same' },
      }));
    } else {
      res.end(toolSse({ id: 'read-current', name: 'Read', input: { file_path: '/work/a.js' } }));
    }
  });
  const upstreamUrl = await listen(upstream);
  const config = configFor(upstreamUrl);
  const suite = createProtocolProxyServer({
    name: 'test-cc',
    metricPrefix: 'test_cc',
    config,
    guardedRoutes: new Map([['/v1/messages', createRoute(config)]]),
    allowPassthrough: () => false,
    formatJsonError: (type, message, requestId) => ({ type: 'error', error: { type, message }, request_id: requestId }),
  });
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const tools = [
    {
      name: 'Read',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    },
    {
      name: 'Edit',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  ];
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, max_tokens: 8192, messages: [{ role: 'user', content: 'edit it' }], tools }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.match(text, /"name":"Read"/);
  assert.doesNotMatch(text, /"name":"Edit"/);
  assert.deepEqual(received[1].tools.map((tool) => tool.name), ['Read']);
  assert.deepEqual(received[1].tool_choice, { type: 'tool', name: 'Read' });
  assert.match(received[1].system, /recovery is expected/i);
});

test('successful Read after unread-file Write failure allows the exact Write without recovery', async (t) => {
  let attempts = 0;
  const input = { file_path: '/work/config.json', content: '{\n  \"ok\": true\n}' };
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(toolSse({ id: 'write-after-read', name: 'Write', input }));
  });
  const upstreamUrl = await listen(upstream);
  const config = configFor(upstreamUrl);
  const suite = createProtocolProxyServer({
    name: 'test-cc',
    metricPrefix: 'test_cc',
    config,
    guardedRoutes: new Map([['/v1/messages', createRoute(config)]]),
    allowPassthrough: () => false,
    formatJsonError: (type, message, requestId) => ({ type: 'error', error: { type, message }, request_id: requestId }),
  });
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm',
      stream: true,
      max_tokens: 8192,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'w0', name: 'Write', input }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w0', is_error: true, content: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'r0', name: 'Read', input: { file_path: '/work/config.json' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r0', is_error: false, content: '1\t{}' }] },
      ],
      tools: [
        { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
        { name: 'Write', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
      ],
    }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(attempts, 1);
  assert.match(text, /"name":"Write"/);
  assert.doesNotMatch(text, /repeated_failed_write_tool_call/);
  assert.doesNotMatch(text, /tool_use_error/);
});

test('terminal repeated Write failure returns 422 without exposing tool_result markup', async (t) => {
  let attempts = 0;
  const input = { file_path: '/work/config.json', content: '{}' };
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(toolSse({ id: `write-${attempts}`, name: 'Write', input }));
  });
  const upstreamUrl = await listen(upstream);
  const config = configFor(upstreamUrl);
  const suite = createProtocolProxyServer({
    name: 'test-cc',
    metricPrefix: 'test_cc',
    config,
    guardedRoutes: new Map([['/v1/messages', createRoute(config)]]),
    allowPassthrough: () => false,
    formatJsonError: (type, message, requestId) => ({ type: 'error', error: { type, message }, request_id: requestId }),
  });
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm',
      stream: true,
      max_tokens: 8192,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'w0', name: 'Write', input }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w0', is_error: true, content: '<tool_use_error>Permission denied</tool_use_error>' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'r0', name: 'Read', input: { file_path: '/work/config.json' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r0', is_error: false, content: '1\t{}' }] },
      ],
      tools: [
        { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
        { name: 'Write', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
      ],
    }),
  });
  const text = await response.text();

  assert.equal(response.status, 422);
  assert.equal(attempts, 2);
  assert.match(text, /repeated_failed_write_tool_call/);
  assert.match(text, /The model repeated a Write call that previously failed/);
  assert.doesNotMatch(text, /tool_use_error/);
  assert.doesNotMatch(text, /Permission denied/);
});

test('invalid recovery target fails closed and does not expose the wrong tool call', async (t) => {
  let attempts = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempts === 1) {
      res.end(toolSse({
        id: 'bad-edit',
        name: 'Edit',
        input: { file_path: '/work/a.js', old_string: 'same', new_string: 'same' },
      }));
    } else {
      res.end(toolSse({ id: 'wrong-read', name: 'Read', input: { file_path: '/work/b.js' } }));
    }
  });
  const upstreamUrl = await listen(upstream);
  const config = configFor(upstreamUrl);
  const suite = createProtocolProxyServer({
    name: 'test-cc',
    metricPrefix: 'test_cc',
    config,
    guardedRoutes: new Map([['/v1/messages', createRoute(config)]]),
    allowPassthrough: () => false,
    formatJsonError: (type, message, requestId) => ({ type: 'error', error: { type, message }, request_id: requestId }),
  });
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm',
      stream: true,
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'edit it' }],
      tools: [
        { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
        { name: 'Edit', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
      ],
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 422);
  assert.match(text, /recovery_target_mismatch/);
  assert.doesNotMatch(text, /\/work\/b\.js/);
});

function thinkingLoopSse(text) {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
}

test('generic loop recovery is still semantically validated before replay', async (t) => {
  let attempts = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempts === 1) {
      res.end(thinkingLoopSse('Need evidence before editing. Need evidence before editing.'));
    } else {
      res.end(toolSse({
        id: 'bad-recovery-edit',
        name: 'Edit',
        input: { file_path: '/work/a.js', old_string: 'same', new_string: 'same' },
      }));
    }
  });
  const upstreamUrl = await listen(upstream);
  const config = Object.freeze({ ...configFor(upstreamUrl), loopMinPatternSize: 8 });
  const suite = createProtocolProxyServer({
    name: 'test-cc',
    metricPrefix: 'test_cc',
    config,
    guardedRoutes: new Map([['/v1/messages', createRoute(config)]]),
    allowPassthrough: () => false,
    formatJsonError: (type, message, requestId) => ({ type: 'error', error: { type, message }, request_id: requestId }),
  });
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true, max_tokens: 8192,
      messages: [{ role: 'user', content: 'edit it' }],
      tools: [
        { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
        { name: 'Edit', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
      ],
    }),
  });
  const text = await response.text();
  assert.equal(attempts, 2);
  assert.equal(response.status, 422);
  assert.match(text, /no_op_edit_tool_call/);
  assert.doesNotMatch(text, /bad-recovery-edit/);
});
