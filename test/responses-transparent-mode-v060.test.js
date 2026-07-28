import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createOpenAiProxyRuntime, loadOpenAiConfig } from '../apps/vllm-openai-proxy/server.js';

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

function env(overrides = {}) {
  return {
    VLLM_API_KEY: 'vllm-secret',
    VLLM_OPENAI_PROXY_API_KEY: 'client-secret',
    RESPONSES_UPSTREAM_MODE: 'chat_adapter',
    LOG_LEVEL: 'debug',
    HEARTBEAT_INTERVAL_MS: '60000',
    UPSTREAM_IDLE_TIMEOUT_MS: '5000',
    SEMANTIC_STALL_TIMEOUT_MS: '5000',
    TOTAL_GENERATION_TIMEOUT_MS: '5000',
    RECOVERY_TIMEOUT_MS: '5000',
    MAX_TOTAL_BUFFERED_BYTES: '1048576',
    MAX_RESPONSE_BUFFER_BYTES: '1048576',
    ...overrides,
  };
}

function chatSse({ reasoning = '', content = '', finishReason = 'stop' } = {}) {
  const chunks = [];
  if (reasoning) chunks.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }] })}\n\n`);
  if (content) chunks.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  chunks.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}

const shellTool = {
  type: 'function',
  name: 'exec_command',
  description: 'Execute a command',
  parameters: {
    type: 'object',
    properties: { cmd: { type: 'string' } },
    required: ['cmd'],
  },
};

test('Responses behavior mode defaults to transparent and guarded remains opt-in', () => {
  const defaults = loadOpenAiConfig(env());
  assert.equal(defaults.responsesBehaviorMode, 'transparent');
  assert.equal(defaults.responsesMalformedToolRetryEnabled, false);

  const guarded = loadOpenAiConfig(env({
    RESPONSES_BEHAVIOR_MODE: 'guarded',
    RESPONSES_MALFORMED_TOOL_RETRY_ENABLED: 'true',
  }));
  assert.equal(guarded.responsesBehaviorMode, 'guarded');
  assert.equal(guarded.responsesMalformedToolRetryEnabled, true);
});

test('transparent Responses mode replays reasoning-only completed response without recovery', async (t) => {
  let calls = 0;
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    calls += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chatSse({ reasoning: 'check files check files check files check files' }));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({
    config: loadOpenAiConfig(env({
      VLLM_BASE_URL: upstreamUrl,
      LOOP_MIN_PATTERN_SIZE: '8',
      LOOP_MAX_PATTERN_SIZE: '128',
      LOOP_MIN_COUNT: '2',
    })),
    exposeControlRoutes: false,
    logSink(line) { logs.push(JSON.parse(line)); },
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen', input: 'Continue', stream: true, tools: [shellTool] }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.match(text, /response\.completed/);
  assert.doesNotMatch(text, /reasoning_without_output/);
  assert.equal(logs.some((row) => row.event === 'recovery_started'), false);
  assert.equal(logs.some((row) => row.event === 'loop_detected'), false);
});



test('transparent Responses mode accepts non-stream reasoning-only completed JSON', async (t) => {
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chat_1',
      model: 'qwen',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', reasoning_content: 'considering only', content: null } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({
    config: loadOpenAiConfig(env({ VLLM_BASE_URL: upstreamUrl })),
    exposeControlRoutes: false,
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen', input: 'Continue', stream: false, tools: [shellTool] }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(payload.status, 'completed');
  assert.equal(payload.output[0].type, 'reasoning');
});

test('transparent Responses mode delivers action narration without forced-tool recovery', async (t) => {
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    calls += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chatSse({ content: '好的，我來開始實際使用工具執行。' }));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({
    config: loadOpenAiConfig(env({ VLLM_BASE_URL: upstreamUrl })),
    exposeControlRoutes: false,
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen', input: 'Do the work', stream: true, tools: [shellTool], tool_choice: 'auto' }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.match(text, /我來開始實際使用工具/);
});

test('transparent Responses mode does not retry malformed required-tool upstream errors', async (t) => {
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    calls += 1;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unterminated string starting at: line 1 column 13 (char 12)', type: 'BadRequestError', code: 400 } }));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({
    config: loadOpenAiConfig(env({
      VLLM_BASE_URL: upstreamUrl,
      RESPONSES_MALFORMED_TOOL_RETRY_ENABLED: 'true',
    })),
    exposeControlRoutes: false,
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen', input: 'Run pwd', stream: true, tools: [shellTool], tool_choice: 'required' }),
  });
  await response.text();

  assert.equal(calls, 1);
});

test('guarded Responses mode retains actionless recovery as an opt-in diagnostic mode', async (t) => {
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    calls += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (calls === 1) {
      res.end(chatSse({ content: '好的，我來開始實際使用工具執行。' }));
      return;
    }
    res.end([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({
    config: loadOpenAiConfig(env({ VLLM_BASE_URL: upstreamUrl, RESPONSES_BEHAVIOR_MODE: 'guarded' })),
    exposeControlRoutes: false,
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen', input: 'Do the work', stream: true, tools: [shellTool], tool_choice: 'auto' }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.match(text, /function_call/);
  assert.doesNotMatch(text, /我來開始實際使用工具/);
});
