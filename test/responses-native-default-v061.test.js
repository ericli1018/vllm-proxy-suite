import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createOpenAiProxyRuntime, loadOpenAiConfig } from '../apps/vllm-openai-proxy/server.js';
import { applyResponsesToolChoicePolicy } from '../packages/openai/responses-tool-choice-policy.js';
import { summarizeOpenAiToolContext } from '../packages/openai/actionless-completion.js';

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

const execTool = {
  type: 'function',
  name: 'exec_command',
  description: 'Execute a command',
  parameters: {
    type: 'object',
    properties: { cmd: { type: 'string' } },
    required: ['cmd'],
  },
};

test('Responses defaults to native transparent preserve mode', () => {
  const config = loadOpenAiConfig(env());
  assert.equal(config.responsesUpstreamMode, 'native');
  assert.equal(config.responsesBehaviorMode, 'transparent');
  assert.equal(config.responsesToolChoicePolicy, 'preserve');
});

test('native tool diagnostics include Responses Lite additional_tools', () => {
  const context = summarizeOpenAiToolContext({
    input: [{ type: 'additional_tools', role: 'developer', tools: [execTool] }],
    tool_choice: 'auto',
  });
  assert.equal(context.requestToolCount, 1);
  assert.deepEqual(context.requestToolNames, ['exec_command']);
  assert.equal(context.requestToolsEnabled, true);
});

test('preserve policy never rewrites tool choice', () => {
  const original = { model: 'qwen', input: '開始你的工作', tools: [execTool], tool_choice: 'auto' };
  const result = applyResponsesToolChoicePolicy(original, { policy: 'preserve' });
  assert.deepEqual(result.body, original);
  assert.notEqual(result.body, original);
  assert.equal(result.diagnostics.toolChoiceRewritten, false);
  assert.equal(result.diagnostics.effectiveToolChoice, 'auto');
});

test('required_on_explicit_continue rewrites an eligible user execution turn', () => {
  const result = applyResponsesToolChoicePolicy({
    model: 'qwen',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '繼續做' }] }],
    tools: [execTool],
    tool_choice: 'auto',
  }, { policy: 'required_on_explicit_continue' });

  assert.equal(result.body.tool_choice, 'required');
  assert.equal(result.diagnostics.originalToolChoice, 'auto');
  assert.equal(result.diagnostics.effectiveToolChoice, 'required');
  assert.equal(result.diagnostics.latestInputKind, 'user');
  assert.equal(result.diagnostics.explicitContinueDetected, true);
  assert.equal(result.diagnostics.toolChoiceRewritten, true);
});

test('required_on_explicit_continue treats omitted tool_choice as auto when tools exist', () => {
  const result = applyResponsesToolChoicePolicy({
    model: 'qwen', input: 'Start your work.', tools: [execTool],
  }, { policy: 'required_on_explicit_continue' });
  assert.equal(result.body.tool_choice, 'required');
  assert.equal(result.diagnostics.originalToolChoice, 'auto');
});

test('required_on_explicit_continue does not rewrite a Tool Result turn', () => {
  const result = applyResponsesToolChoicePolicy({
    model: 'qwen',
    input: [
      { type: 'message', role: 'user', content: '繼續做' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ],
    tools: [execTool],
    tool_choice: 'auto',
  }, { policy: 'required_on_explicit_continue' });

  assert.equal(result.body.tool_choice, 'auto');
  assert.equal(result.diagnostics.latestInputKind, 'tool_result');
  assert.equal(result.diagnostics.toolChoiceRewritten, false);
});

test('required_on_explicit_continue preserves no-tools and explicit client choices', () => {
  const noTools = applyResponsesToolChoicePolicy({ model: 'qwen', input: '繼續做', tool_choice: 'auto' }, { policy: 'required_on_explicit_continue' });
  assert.equal(noTools.body.tool_choice, 'auto');
  assert.equal(noTools.diagnostics.toolChoiceRewritten, false);

  const none = applyResponsesToolChoicePolicy({ model: 'qwen', input: '繼續做', tools: [execTool], tool_choice: 'none' }, { policy: 'required_on_explicit_continue' });
  assert.equal(none.body.tool_choice, 'none');

  const specified = applyResponsesToolChoicePolicy({ model: 'qwen', input: '繼續做', tools: [execTool], tool_choice: { type: 'function', name: 'exec_command' } }, { policy: 'required_on_explicit_continue' });
  assert.deepEqual(specified.body.tool_choice, { type: 'function', name: 'exec_command' });
});

test('default runtime forwards Responses to the native upstream path unchanged', async (t) => {
  let receivedPath = null;
  let receivedBody = null;
  const upstream = http.createServer(async (req, res) => {
    receivedPath = req.url;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    receivedBody = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({
    config: loadOpenAiConfig(env({ VLLM_BASE_URL: upstreamUrl })),
    exposeControlRoutes: false,
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const body = { model: 'qwen', input: 'Explain only', stream: true, tools: [execTool], tool_choice: 'auto' };
  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await response.text();

  assert.equal(response.status, 200);
  assert.equal(receivedPath, '/v1/responses');
  assert.deepEqual(receivedBody, body);
});

test('native explicit-continue policy rewrites only the upstream tool choice', async (t) => {
  let receivedBody = null;
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    receivedBody = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({
    config: loadOpenAiConfig(env({
      VLLM_BASE_URL: upstreamUrl,
      RESPONSES_TOOL_CHOICE_POLICY: 'required_on_explicit_continue',
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
    body: JSON.stringify({ model: 'qwen', input: '開始你的工作', stream: true, tools: [execTool], tool_choice: 'auto' }),
  });
  await response.text();

  assert.equal(response.status, 200);
  assert.equal(receivedBody.tool_choice, 'required');
  const context = logs.find((row) => row.event === 'request_tool_context');
  assert.equal(context.responsesUpstreamMode, 'native');
  assert.equal(context.responsesToolChoicePolicy, 'required_on_explicit_continue');
  assert.equal(context.originalToolChoice, 'auto');
  assert.equal(context.effectiveToolChoice, 'required');
  assert.equal(context.toolChoiceRewritten, true);
});
