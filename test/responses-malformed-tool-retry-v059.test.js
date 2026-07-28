import test from 'node:test';
import assert from 'node:assert/strict';

import { createResponsesChatAdapterFetch } from '../packages/openai/responses-chat-adapter.js';

const shellTool = {
  type: 'function',
  name: 'shell',
  description: 'Run a command',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
};

function requestBody(toolChoice = 'required') {
  return {
    model: 'qwen',
    input: 'Start the implementation',
    stream: false,
    tools: [shellTool],
    tool_choice: toolChoice,
    max_output_tokens: 256,
    temperature: 0.8,
  };
}

function malformedResponse() {
  return new Response(JSON.stringify({
    error: {
      message: 'Unterminated string starting at: line 1 column 13 (char 12)',
      type: 'BadRequestError',
      code: 400,
    },
  }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

function successfulChatResponse() {
  return new Response(JSON.stringify({
    id: 'chat_retry',
    model: 'qwen',
    created: 1,
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'shell', arguments: '{"command":"pwd"}' },
        }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('chat adapter retries one malformed required-tool 400 with a constrained request', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return calls.length === 1 ? malformedResponse() : successfulChatResponse();
  };
  const adapterFetch = createResponsesChatAdapterFetch(fetchImpl, {
    malformedToolRetryEnabled: true,
    malformedToolRecoveryMinTokens: 1024,
    malformedToolRecoveryTemperatureMax: 0.1,
  });

  const response = await adapterFetch('http://vllm/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody()),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'http://vllm/v1/chat/completions');
  assert.equal(calls[1].body.parallel_tool_calls, false);
  assert.deepEqual(calls[1].body.tool_choice, { type: 'function', function: { name: 'shell' } });
  assert.equal(calls[1].body.temperature, 0.1);
  assert.equal(calls[1].body.max_tokens, 1024);
  assert.match(calls[1].body.messages[0].content, /complete JSON object/i);
  assert.match(calls[1].body.messages[0].content, /keep the first tool action small/i);
  assert.equal(response.headers.get('x-vllm-proxy-chat-adapter-retry'), 'malformed_tool_arguments');
  assert.equal(response.headers.get('x-vllm-proxy-chat-adapter-retry-result'), 'success');
  assert.equal(payload.status, 'completed');
  assert.equal(payload.output[0].type, 'function_call');
});

test('chat adapter does not retry malformed 400 when tool choice is auto', async () => {
  let calls = 0;
  const adapterFetch = createResponsesChatAdapterFetch(async () => {
    calls += 1;
    return malformedResponse();
  }, { malformedToolRetryEnabled: true });

  const response = await adapterFetch('http://vllm/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody('auto')),
  });

  assert.equal(response.status, 400);
  assert.equal(calls, 1);
  assert.equal(response.headers.get('x-vllm-proxy-chat-adapter-retry'), null);
});

test('chat adapter fuses malformed required-tool retry after one additional request', async () => {
  let calls = 0;
  const adapterFetch = createResponsesChatAdapterFetch(async () => {
    calls += 1;
    return malformedResponse();
  }, { malformedToolRetryEnabled: true });

  const response = await adapterFetch('http://vllm/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody()),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(calls, 2);
  assert.equal(response.headers.get('x-vllm-proxy-chat-adapter-retry'), 'malformed_tool_arguments');
  assert.equal(response.headers.get('x-vllm-proxy-chat-adapter-retry-result'), 'failed');
  assert.match(payload.error.message, /Unterminated string/);
});

import http from 'node:http';
import { createOpenAiProxyRuntime, loadOpenAiConfig } from '../apps/vllm-openai-proxy/server.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }

test('Gateway recovers actionless narration through one malformed required-tool retry', async (t) => {
  const received = [];
  const logs = [];
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push(JSON.parse(raw));
    calls += 1;
    if (calls === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chat_narration', model: 'qwen', created: 1,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '好，讓我開始實際使用工具來執行這個任務。' } }],
        usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
      }));
      return;
    }
    if (calls === 2) {
      const malformed = malformedResponse();
      res.writeHead(malformed.status, Object.fromEntries(malformed.headers));
      res.end(await malformed.text());
      return;
    }
    const success = successfulChatResponse();
    res.writeHead(success.status, Object.fromEntries(success.headers));
    res.end(await success.text());
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({
    config: loadOpenAiConfig({
      VLLM_BASE_URL: upstreamUrl,
      VLLM_API_KEY: 'vllm',
      VLLM_OPENAI_PROXY_API_KEY: 'client-secret',
      RESPONSES_UPSTREAM_MODE: 'chat_adapter',
      RESPONSES_HOSTED_TOOL_POLICY: 'drop_optional',
      ACTIONLESS_COMPLETION_GUARD_ENABLED: 'true',
      HEARTBEAT_INTERVAL_MS: '60000',
      LOG_LEVEL: 'debug',
    }),
    exposeControlRoutes: false,
    logSink(line) { logs.push(JSON.parse(line)); },
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen',
      input: 'Start the implementation',
      stream: false,
      tools: [shellTool],
      tool_choice: 'auto',
      max_output_tokens: 256,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  assert.equal(received[1].tool_choice, 'required');
  assert.deepEqual(received[2].tool_choice, { type: 'function', function: { name: 'shell' } });
  assert.equal(received[2].max_tokens, 1024);
  assert.equal(payload.output[0].type, 'function_call');
  assert.equal(runtime.metrics.malformedToolRetriesTotal, 1);
  assert.equal(runtime.metrics.malformedToolRetryFailuresTotal, 0);
  assert.ok(logs.some((entry) => entry.event === 'malformed_tool_arguments_retry_completed'
    && entry.phase === 'recovery'));
});

test('Gateway returns a typed non-retryable error after malformed required-tool retry is exhausted', async (t) => {
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    calls += 1;
    const malformed = malformedResponse();
    res.writeHead(malformed.status, Object.fromEntries(malformed.headers));
    res.end(await malformed.text());
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({
    config: loadOpenAiConfig({
      VLLM_BASE_URL: upstreamUrl,
      VLLM_API_KEY: 'vllm',
      VLLM_OPENAI_PROXY_API_KEY: 'client-secret',
      RESPONSES_UPSTREAM_MODE: 'chat_adapter',
      RESPONSES_MALFORMED_TOOL_RETRY_ENABLED: 'true',
      MAX_RECOVERY_ATTEMPTS: '0',
      LOG_LEVEL: 'error',
    }),
    exposeControlRoutes: false,
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen', input: 'Run pwd', stream: false,
      tools: [shellTool], tool_choice: 'required',
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(calls, 2);
  assert.equal(payload.error.code, 'malformed_required_tool_arguments');
  assert.equal(payload.error.retryable, false);
  assert.equal(runtime.metrics.malformedToolRetriesTotal, 1);
  assert.equal(runtime.metrics.malformedToolRetryFailuresTotal, 1);
});
