import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  convertResponsesRequestToChat,
  prepareResponsesRequestForChatAdapter,
  responsesHostedToolDiagnostics,
} from '../packages/openai/responses-chat-adapter.js';
import { createOpenAiProxyRuntime, loadOpenAiConfig } from '../apps/vllm-openai-proxy/server.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function env(overrides = {}) {
  return {
    VLLM_BASE_URL: 'http://127.0.0.1:1',
    VLLM_API_KEY: 'vllm',
    VLLM_OPENAI_PROXY_API_KEY: 'client-secret',
    RESPONSES_UPSTREAM_MODE: 'chat_adapter',
    LOG_LEVEL: 'debug',
    ...overrides,
  };
}

const shellTool = {
  type: 'function',
  name: 'shell',
  description: 'Run shell',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
};

test('drop_optional removes optional web_search while preserving client tools', () => {
  const prepared = prepareResponsesRequestForChatAdapter({
    model: 'qwen', input: 'Inspect files', stream: true,
    tools: [{ type: 'web_search' }, shellTool],
    tool_choice: 'auto',
  }, { hostedToolPolicy: 'drop_optional' });
  const diagnostics = responsesHostedToolDiagnostics(prepared);
  const chat = convertResponsesRequestToChat(prepared, { hostedToolPolicy: 'drop_optional' });

  assert.deepEqual(prepared.tools, [shellTool]);
  assert.equal(chat.tools.length, 1);
  assert.equal(chat.tools[0].function.name, 'shell');
  assert.equal(chat.tool_choice, 'auto');
  assert.deepEqual(diagnostics.droppedToolTypes, ['web_search']);
  assert.equal(diagnostics.droppedToolCount, 1);
  assert.equal(diagnostics.remainingToolCount, 1);
});


test('drop_optional filters hosted tools introduced through Responses Lite additional_tools', () => {
  const prepared = prepareResponsesRequestForChatAdapter({
    model: 'qwen',
    input: [
      { type: 'additional_tools', tools: [{ type: 'web_search' }, shellTool] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect files' }] },
    ],
    tool_choice: 'auto',
  }, { hostedToolPolicy: 'drop_optional' });
  const chat = convertResponsesRequestToChat(prepared, { hostedToolPolicy: 'drop_optional' });
  assert.deepEqual(prepared.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect files' }] },
  ]);
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['shell']);
  assert.deepEqual(responsesHostedToolDiagnostics(prepared).droppedToolTypes, ['web_search']);
});

test('drop_optional removes an all-hosted auto tool set without sending empty Chat tool controls', () => {
  const chat = convertResponsesRequestToChat({
    model: 'qwen', input: 'Answer locally', tools: [{ type: 'web_search' }], tool_choice: 'auto',
  }, { hostedToolPolicy: 'drop_optional' });
  assert.equal('tools' in chat, false);
  assert.equal('tool_choice' in chat, false);
});

test('required hosted tool without a supported alternative is rejected', () => {
  assert.throws(
    () => prepareResponsesRequestForChatAdapter({
      model: 'qwen', input: 'Search', tools: [{ type: 'web_search' }], tool_choice: 'required',
    }, { hostedToolPolicy: 'drop_optional' }),
    (error) => error.code === 'required_hosted_tool_unavailable'
      && error.details.requiredToolType === 'web_search'
      && error.details.hostedToolPolicy === 'drop_optional',
  );
});

test('required mode drops hosted tools and continues when a client tool remains', () => {
  const chat = convertResponsesRequestToChat({
    model: 'qwen', input: 'Do work', tools: [{ type: 'web_search_preview' }, shellTool], tool_choice: 'required',
  }, { hostedToolPolicy: 'drop_optional' });
  assert.equal(chat.tool_choice, 'required');
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['shell']);
});

test('explicit hosted tool choice is rejected even when client tools exist', () => {
  assert.throws(
    () => prepareResponsesRequestForChatAdapter({
      model: 'qwen', input: 'Search', tools: [{ type: 'web_search' }, shellTool], tool_choice: { type: 'web_search' },
    }, { hostedToolPolicy: 'drop_optional' }),
    (error) => error.code === 'required_hosted_tool_unavailable' && error.details.requiredToolType === 'web_search',
  );
});

test('allowed_tools auto filters hosted entries and limits Chat tools', () => {
  const chat = convertResponsesRequestToChat({
    model: 'qwen', input: 'Inspect',
    tools: [{ type: 'web_search' }, shellTool, { type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } }],
    tool_choice: {
      type: 'allowed_tools', mode: 'auto',
      tools: [{ type: 'web_search' }, { type: 'function', name: 'shell' }],
    },
  }, { hostedToolPolicy: 'drop_optional' });

  assert.equal(chat.tool_choice, 'auto');
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['shell']);
});

test('allowed_tools required rejects an all-hosted allowlist', () => {
  assert.throws(
    () => prepareResponsesRequestForChatAdapter({
      model: 'qwen', input: 'Search', tools: [{ type: 'web_search' }],
      tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'web_search' }] },
    }, { hostedToolPolicy: 'drop_optional' }),
    (error) => error.code === 'required_hosted_tool_unavailable',
  );
});

test('reject and native_only hosted-tool policies fail explicitly', () => {
  assert.throws(
    () => prepareResponsesRequestForChatAdapter({ model: 'qwen', input: 'Search', tools: [{ type: 'web_search' }] }, { hostedToolPolicy: 'reject' }),
    (error) => error.code === 'unsupported_responses_tool',
  );
  assert.throws(
    () => prepareResponsesRequestForChatAdapter({ model: 'qwen', input: 'Search', tools: [{ type: 'web_search' }] }, { hostedToolPolicy: 'native_only' }),
    (error) => error.code === 'hosted_tool_requires_native_mode',
  );
});

test('Gateway filters optional web_search, emits diagnostics, and contacts Chat upstream', async (t) => {
  let upstreamRequests = 0;
  let upstreamPath = null;
  let upstreamBody = null;
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    upstreamRequests += 1;
    upstreamPath = req.url;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    upstreamBody = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chat_1', model: 'qwen', created: 1,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    }));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({
    config: loadOpenAiConfig(env({ VLLM_BASE_URL: upstreamUrl })),
    exposeControlRoutes: false,
    logSink(line) { logs.push(JSON.parse(line)); },
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen', input: 'Inspect files', stream: false, tools: [{ type: 'web_search' }, shellTool], tool_choice: 'auto' }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.status, 'completed');
  assert.equal(upstreamRequests, 1);
  assert.equal(upstreamPath, '/v1/chat/completions');
  assert.deepEqual(upstreamBody.tools.map((tool) => tool.function.name), ['shell']);
  assert.ok(logs.some((entry) => entry.event === 'responses_hosted_tools_filtered'
    && entry.droppedToolTypes?.includes('web_search')
    && entry.requestContinued === true));
  assert.equal(runtime.metrics.hostedToolsFilteredTotal, 1);
});

test('Gateway rejects required web_search before upstream and records its counter', async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer(async (_req, res) => { upstreamRequests += 1; res.writeHead(500).end(); });
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
    body: JSON.stringify({ model: 'qwen', input: 'Search', tools: [{ type: 'web_search' }], tool_choice: 'required' }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error.code, 'required_hosted_tool_unavailable');
  assert.equal(payload.error.required_tool_type, 'web_search');
  assert.equal(upstreamRequests, 0);
  assert.equal(runtime.metrics.requiredHostedToolsRejectedTotal, 1);
});

test('OpenAI config defaults hosted-tool and malformed-tool policies and accepts public overrides', () => {
  const defaults = loadOpenAiConfig(env());
  assert.equal(defaults.responsesHostedToolPolicy, 'drop_optional');
  assert.equal(defaults.responsesBehaviorMode, 'transparent');
  assert.equal(defaults.responsesMalformedToolRetryEnabled, false);
  assert.equal(defaults.responsesMalformedToolRecoveryMinTokens, 1024);
  assert.equal(defaults.responsesMalformedToolRecoveryTemperatureMax, 0.1);
  const overridden = loadOpenAiConfig(env({
    RESPONSES_HOSTED_TOOL_POLICY: undefined,
    VLLM_PROXY_RESPONSES_HOSTED_TOOL_POLICY: 'reject',
    VLLM_PROXY_RESPONSES_BEHAVIOR_MODE: 'guarded',
    VLLM_PROXY_RESPONSES_MALFORMED_TOOL_RETRY_ENABLED: 'true',
    VLLM_PROXY_RESPONSES_MALFORMED_TOOL_RECOVERY_MIN_TOKENS: '2048',
    VLLM_PROXY_RESPONSES_MALFORMED_TOOL_RECOVERY_TEMPERATURE_MAX: '0.05',
  }));
  assert.equal(overridden.responsesHostedToolPolicy, 'reject');
  assert.equal(overridden.responsesBehaviorMode, 'guarded');
  assert.equal(overridden.responsesMalformedToolRetryEnabled, true);
  assert.equal(overridden.responsesMalformedToolRecoveryMinTokens, 2048);
  assert.equal(overridden.responsesMalformedToolRecoveryTemperatureMax, 0.05);
});
