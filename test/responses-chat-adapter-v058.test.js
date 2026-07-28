import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  convertResponsesRequestToChat,
  normalizeResponsesRequestForChatAdapter,
  convertChatJsonToResponses,
  createResponsesChatAdapterFetch,
} from '../packages/openai/responses-chat-adapter.js';
import { createOpenAiProxyRuntime, loadOpenAiConfig } from '../apps/vllm-openai-proxy/server.js';
import { responsesAdapter } from '../packages/openai/responses.js';

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
    LOG_LEVEL: 'error',
    ...overrides,
  };
}

test('Responses request converts instructions, history, tools, and limits to Chat Completions', () => {
  const result = convertResponsesRequestToChat({
    model: 'qwen',
    instructions: 'Follow the runtime policy.',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Use Traditional Chinese.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect files.' }] },
      { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '/workspace' },
      { type: 'message', role: 'user', content: 'Continue.' },
    ],
    tools: [{ type: 'function', name: 'shell', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }, strict: true }],
    tool_choice: { type: 'function', name: 'shell' },
    parallel_tool_calls: false,
    max_output_tokens: 4096,
    temperature: 0.2,
    top_p: 0.9,
    stream: true,
  });

  assert.deepEqual(result.messages, [
    { role: 'system', content: 'Follow the runtime policy.\n\nUse Traditional Chinese.' },
    { role: 'user', content: 'Inspect files.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '/workspace' },
    { role: 'user', content: 'Continue.' },
  ]);
  assert.deepEqual(result.tools, [{ type: 'function', function: { name: 'shell', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }, strict: true } }]);
  assert.deepEqual(result.tool_choice, { type: 'function', function: { name: 'shell' } });
  assert.equal(result.max_tokens, 4096);
  assert.equal(result.stream, true);
  assert.deepEqual(result.stream_options, { include_usage: true });
});

test('Responses request rejects hosted tools and stateful response continuation', () => {
  assert.throws(() => convertResponsesRequestToChat({ model: 'm', input: 'x', tools: [{ type: 'web_search_preview' }] }, { hostedToolPolicy: 'reject' }), /unsupported_responses_tool/);
  assert.throws(() => convertResponsesRequestToChat({ model: 'm', input: 'x', previous_response_id: 'resp_1' }), /unsupported_previous_response_id/);
});

test('Chat JSON text and reasoning convert to a completed Responses object', () => {
  const response = convertChatJsonToResponses({
    id: 'chat_1', model: 'qwen', created: 123,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', reasoning_content: 'Checked.', content: 'Done.' } }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  }, { responseId: 'resp_test', model: 'qwen', createdAt: 123 });

  assert.equal(response.id, 'resp_test');
  assert.equal(response.status, 'completed');
  assert.equal(response.output[0].type, 'reasoning');
  assert.equal(response.output[1].content[0].text, 'Done.');
  assert.deepEqual(response.usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 });
});

test('Chat JSON tool calls convert to Responses function_call items', () => {
  const response = convertChatJsonToResponses({
    choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } },
    ] } }],
  }, { responseId: 'resp_test', model: 'qwen', createdAt: 123 });

  assert.equal(response.status, 'completed');
  assert.deepEqual(response.output, [{
    id: 'fc_resp_test_0', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"pwd"}',
  }]);
});

test('Chat finish_reason length converts to Responses incomplete max_output_tokens', () => {
  const response = convertChatJsonToResponses({
    choices: [{ finish_reason: 'length', message: { content: 'partial' } }],
  }, { responseId: 'resp_test', model: 'qwen', createdAt: 123 });
  assert.equal(response.status, 'incomplete');
  assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' });
});

test('stream adapter converts Chat SSE text into terminal Responses SSE', async () => {
  const chatSse = [
    'data: {"id":"chat_1","model":"qwen","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Check"},"finish_reason":null}]}\n\n',
    'data: {"id":"chat_1","model":"qwen","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n',
    'data: {"id":"chat_1","model":"qwen","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.stream_options.include_usage, true);
    return new Response(chatSse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const adapterFetch = createResponsesChatAdapterFetch(fetchImpl);
  const response = await adapterFetch('http://vllm:8001/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen', input: 'Reply OK', stream: true }),
  });
  const text = await response.text();

  assert.match(text, /event: response\.created/);
  assert.match(text, /event: response\.reasoning_summary_text\.delta/);
  assert.match(text, /event: response\.output_text\.delta/);
  assert.match(text, /event: response\.completed/);
  assert.match(text, /"status":"completed"/);
});

test('stream adapter preserves reasoning output_index when text starts first', async () => {
  const chatSse = [
    'data: {"choices":[{"index":0,"delta":{"content":"Visible first"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"Reason later"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const adapterFetch = createResponsesChatAdapterFetch(async () => new Response(chatSse, { headers: { 'content-type': 'text/event-stream' } }));
  const response = await adapterFetch('http://vllm:8001/v1/responses', {
    method: 'POST', body: JSON.stringify({ model: 'qwen', input: 'Reply', stream: true }),
  });
  const events = (await response.text())
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)))
    .filter((event) => event.type);
  const reasoningAdded = events.find((event) => event.type === 'response.output_item.added' && event.item?.type === 'reasoning');
  const reasoningDelta = events.find((event) => event.type === 'response.reasoning_summary_text.delta');

  assert.equal(reasoningAdded.output_index, 1);
  assert.equal(reasoningDelta.output_index, 1);
});

test('stream adapter emits function call before terminal completion', async () => {
  const chatSse = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell","arguments":"{\\"cmd\\":"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"pwd\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const adapterFetch = createResponsesChatAdapterFetch(async () => new Response(chatSse, { headers: { 'content-type': 'text/event-stream' } }));
  const response = await adapterFetch('http://vllm:8001/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'qwen', input: 'Run pwd', tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }], stream: true }) });
  const text = await response.text();

  assert.ok(text.indexOf('response.output_item.added') < text.indexOf('response.completed'));
  assert.match(text, /response\.function_call_arguments\.delta/);
  assert.match(text, /"call_id":"call_1"/);
});

test('OpenAI runtime chat_adapter mode calls Chat Completions upstream and returns Responses SSE', async (t) => {
  let upstreamPath = null;
  let upstreamBody = null;
  const upstream = http.createServer(async (req, res) => {
    upstreamPath = req.url;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    upstreamBody = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const config = loadOpenAiConfig(env({ VLLM_BASE_URL: upstreamUrl, PROXY_PORT: '3456' }));
  const runtime = createOpenAiProxyRuntime({ config, exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen', input: 'Reply OK', stream: true }) });
  const text = await response.text();

  assert.equal(upstreamPath, '/v1/chat/completions');
  assert.equal(upstreamBody.messages.at(-1).content, 'Reply OK');
  assert.equal(response.status, 200);
  assert.match(text, /response\.completed/);
});

test('OpenAI runtime native mode keeps /v1/responses upstream', async (t) => {
  let upstreamPath = null;
  const upstream = http.createServer(async (req, res) => {
    upstreamPath = req.url;
    for await (const _chunk of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"m1","output_index":0,"content_index":0,"delta":"OK"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const config = loadOpenAiConfig(env({ VLLM_BASE_URL: upstreamUrl, RESPONSES_UPSTREAM_MODE: 'native' }));
  const runtime = createOpenAiProxyRuntime({ config, exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen', input: 'Reply OK', stream: true }) });
  await response.text();
  assert.equal(upstreamPath, '/v1/responses');
});

test('Responses custom tool is wrapped as a Chat function with a freeform string argument', () => {
  const result = convertResponsesRequestToChat({
    model: 'qwen', input: 'Patch the file.', stream: true,
    tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } }],
  });
  assert.deepEqual(result.tools, [{
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Apply a patch',
      parameters: {
        type: 'object',
        properties: { __arg1: { type: 'string', description: 'Freeform input for the custom tool.' } },
        required: ['__arg1'],
        additionalProperties: false,
      },
      strict: false,
    },
  }]);
});

test('custom tool history converts to Chat assistant tool call and tool output', () => {
  const result = convertResponsesRequestToChat({
    model: 'qwen',
    input: [
      { type: 'custom_tool_call', id: 'ct1', call_id: 'call_patch', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'Done!' },
      { type: 'message', role: 'user', content: 'Continue.' },
    ],
  });
  assert.deepEqual(result.messages, [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: '{"__arg1":"*** Begin Patch"}' } }] },
    { role: 'tool', tool_call_id: 'call_patch', content: 'Done!' },
    { role: 'user', content: 'Continue.' },
  ]);
});

test('Chat custom tool call converts back to custom_tool_call Responses item', () => {
  const response = convertChatJsonToResponses({
    choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: '{"__arg1":"*** Begin Patch"}' } }] } }],
  }, {
    responseId: 'resp_test', model: 'qwen', createdAt: 123,
    toolKinds: new Map([['apply_patch', { type: 'custom' }]]),
  });
  assert.deepEqual(response.output, [{
    id: 'ct_resp_test_0', type: 'custom_tool_call', status: 'completed', call_id: 'call_patch', name: 'apply_patch', input: '*** Begin Patch',
  }]);
});

test('stream adapter emits native custom tool lifecycle for Codex', async () => {
  const chatSse = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_patch","type":"function","function":{"name":"apply_patch","arguments":"{\\"__arg1\\":\\"*** Begin"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" Patch\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const adapterFetch = createResponsesChatAdapterFetch(async () => new Response(chatSse, { headers: { 'content-type': 'text/event-stream' } }));
  const response = await adapterFetch('http://vllm:8001/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'qwen', input: 'Patch', tools: [{ type: 'custom', name: 'apply_patch', description: 'Patch files' }], stream: true }),
  });
  const text = await response.text();
  assert.match(text, /"type":"custom_tool_call"/);
  assert.match(text, /event: response\.custom_tool_call_input\.done/);
  assert.match(text, /"input":"\*\*\* Begin Patch"/);
  assert.ok(text.indexOf('custom_tool_call') < text.indexOf('response.completed'));
});


test('Responses parser treats custom tool lifecycle as an executable tool call', () => {
  const parser = responsesAdapter.createStreamParser({ toolPassthroughObservationMaxBytes: 65536 });
  const raw = [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"ct1","type":"custom_tool_call","status":"in_progress","call_id":"call_patch","name":"apply_patch","input":""}}\n\n',
    'event: response.custom_tool_call_input.done\ndata: {"type":"response.custom_tool_call_input.done","item_id":"ct1","output_index":0,"input":"*** Begin Patch"}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"ct1","type":"custom_tool_call","status":"completed","call_id":"call_patch","name":"apply_patch","input":"*** Begin Patch"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"id":"ct1","type":"custom_tool_call","status":"completed","call_id":"call_patch","name":"apply_patch","input":"*** Begin Patch"}]}}\n\n',
  ].join('');
  parser.push(Buffer.from(raw));
  const result = parser.finish();
  const metrics = responsesAdapter.semanticMetrics(result);
  assert.equal(metrics.toolCallCount, 1);
  assert.equal(metrics.toolNames[0], 'apply_patch');
  assert.equal(responsesAdapter.validateStream(result, { maxReasoningBytes: 1024, maxToolCalls: 10, maxToolArgumentBytes: 1024 }).ok, true);
});

test('Gateway chat_adapter commits a custom tool without actionless recovery', async (t) => {
  let requests = 0;
  const upstream = http.createServer(async (req, res) => {
    requests += 1;
    for await (const _chunk of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_patch","type":"function","function":{"name":"apply_patch","arguments":"{\\"__arg1\\":\\"*** Begin Patch\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''));
  });
  const upstreamUrl = await listen(upstream);
  const config = loadOpenAiConfig(env({ VLLM_BASE_URL: upstreamUrl, RESPONSES_HOSTED_TOOL_POLICY: 'reject' }));
  const runtime = createOpenAiProxyRuntime({ config, exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen', input: 'Patch', stream: true, tools: [{ type: 'custom', name: 'apply_patch', description: 'Patch files' }] }),
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /custom_tool_call/);
  assert.equal(requests, 1);
  assert.equal(runtime.metrics.recoveriesTotal, 0);
});

test('Responses namespace tools flatten for Chat and restore namespace in JSON output', () => {
  const request = {
    model: 'qwen', input: 'Browse',
    tools: [{ type: 'namespace', name: 'mcp__playwright__', description: 'Browser tools', tools: [{ name: 'browser_navigate', description: 'Navigate', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }] }],
  };
  const chat = convertResponsesRequestToChat(request);
  assert.equal(chat.tools[0].function.name, 'mcp__playwright__browser_navigate');

  const response = convertChatJsonToResponses({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'mcp__playwright__browser_navigate', arguments: '{"url":"https://example.com"}' } }] } }] }, {
    responseId: 'resp_test', model: 'qwen', createdAt: 123,
    toolKinds: new Map([['mcp__playwright__browser_navigate', { type: 'function', namespace: 'mcp__playwright__', originalName: 'browser_navigate' }]]),
  });
  assert.equal(response.output[0].name, 'browser_navigate');
  assert.equal(response.output[0].namespace, 'mcp__playwright__');
});

test('namespace function call history flattens back into a Chat tool name', () => {
  const chat = convertResponsesRequestToChat({
    model: 'qwen',
    input: [
      { type: 'function_call', id: 'fc1', call_id: 'call_1', namespace: 'mcp__playwright__', name: 'browser_navigate', arguments: '{"url":"https://example.com"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'OK' },
    ],
  });
  assert.equal(chat.messages[0].tool_calls[0].function.name, 'mcp__playwright__browser_navigate');
});

test('Gateway chat_adapter rejects unsupported Responses features before contacting upstream', async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer(async (_req, res) => {
    upstreamRequests += 1;
    res.writeHead(500).end();
  });
  const upstreamUrl = await listen(upstream);
  const config = loadOpenAiConfig(env({ VLLM_BASE_URL: upstreamUrl, RESPONSES_HOSTED_TOOL_POLICY: 'reject' }));
  const runtime = createOpenAiProxyRuntime({ config, exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen', input: 'Search', tools: [{ type: 'web_search_preview' }], stream: true }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error.code, 'unsupported_responses_tool');
  assert.equal(upstreamRequests, 0);
});

test('converted Responses terminal preserves request-level response context', async () => {
  const adapterFetch = createResponsesChatAdapterFetch(async () => new Response(JSON.stringify({
    id: 'chat_1', model: 'qwen', created: 123,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  }), { headers: { 'content-type': 'application/json' } }));
  const requestBody = {
    model: 'qwen',
    instructions: 'Use tools carefully.',
    input: 'Reply OK',
    tools: [{ type: 'function', name: 'shell', description: 'Run shell', parameters: { type: 'object', properties: {} } }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    max_output_tokens: 2048,
    stream: false,
  };
  const response = await adapterFetch('http://vllm:8001/v1/responses', { method: 'POST', body: JSON.stringify(requestBody) });
  const payload = await response.json();

  assert.equal(payload.instructions, requestBody.instructions);
  assert.equal(payload.max_output_tokens, 2048);
  assert.equal(payload.parallel_tool_calls, false);
  assert.equal(payload.tool_choice, 'auto');
  assert.deepEqual(payload.tools, requestBody.tools);
});

test('Gateway chat_adapter supports non-stream Responses JSON through Chat Completions', async (t) => {
  let upstreamPath = null;
  let upstreamBody = null;
  const upstream = http.createServer(async (req, res) => {
    upstreamPath = req.url;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    upstreamBody = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chat_1', model: 'qwen', created: 123,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }));
  });
  const upstreamUrl = await listen(upstream);
  const config = loadOpenAiConfig(env({ VLLM_BASE_URL: upstreamUrl }));
  const runtime = createOpenAiProxyRuntime({ config, exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen', input: 'Reply OK', stream: false }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(upstreamPath, '/v1/chat/completions');
  assert.equal(upstreamBody.stream, false);
  assert.equal(payload.object, 'response');
  assert.equal(payload.status, 'completed');
  assert.equal(payload.output[0].content[0].text, 'OK');
});

test('Gateway chat_adapter preserves Actionless Recovery and forces the second Chat request to required', async (t) => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push({ path: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (received.length === 1) {
      res.end([
        'data: {"choices":[{"index":0,"delta":{"content":"好的，我來開始執行。首先建立目錄。"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''));
      return;
    }
    res.end([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell","arguments":"{\\"cmd\\":\\"mkdir work\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''));
  });
  const upstreamUrl = await listen(upstream);
  const config = loadOpenAiConfig(env({ VLLM_BASE_URL: upstreamUrl }));
  const runtime = createOpenAiProxyRuntime({ config, exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen', input: 'Build it', stream: true,
      tools: [{ type: 'function', name: 'shell', description: 'Run shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }],
      tool_choice: 'auto', parallel_tool_calls: true,
    }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(received.length, 2);
  assert.equal(received[0].path, '/v1/chat/completions');
  assert.equal(received[1].path, '/v1/chat/completions');
  assert.equal(received[1].body.tool_choice, 'required');
  assert.equal(received[1].body.parallel_tool_calls, false);
  assert.doesNotMatch(text, /我來開始執行/);
  assert.match(text, /response\.function_call_arguments\.done/);
  assert.equal(runtime.metrics.actionlessCompletionsDetectedTotal, 1);
});

test('Responses Lite additional_tools are normalized into top-level tools before Chat conversion', () => {
  const normalized = normalizeResponsesRequestForChatAdapter({
    model: 'qwen',
    input: [
      {
        type: 'additional_tools', role: 'developer',
        tools: [
          { type: 'function', name: 'exec', description: 'Execute', parameters: { type: 'object', properties: {} } },
          { type: 'namespace', name: 'collaboration', description: 'Subagents', tools: [{ name: 'spawn', description: 'Spawn', parameters: { type: 'object', properties: {} } }] },
        ],
      },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Use tools.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start.' }] },
    ],
  });
  const chat = convertResponsesRequestToChat(normalized);

  assert.deepEqual(normalized.input.map((item) => item.type), ['message', 'message']);
  assert.equal(normalized.tools.length, 2);
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['exec', 'collaboration__spawn']);
  assert.equal(chat.messages[0].role, 'system');
  assert.equal(chat.messages.at(-1).content, 'Start.');
});

test('Gateway chat_adapter exposes additional_tools to Actionless Recovery', async (t) => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (received.length === 1) {
      res.end('data: {"choices":[{"index":0,"delta":{"content":"我來開始執行。"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    res.end('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec","arguments":"{}"}}]},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const config = loadOpenAiConfig(env({ VLLM_BASE_URL: upstreamUrl }));
  const runtime = createOpenAiProxyRuntime({ config, exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen', stream: true,
      input: [
        { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'exec', description: 'Execute', parameters: { type: 'object', properties: {} } }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start.' }] },
      ],
    }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(received.length, 2);
  assert.equal(received[0].tools[0].function.name, 'exec');
  assert.equal(received[1].tool_choice, 'required');
  assert.match(text, /function_call/);
});

test('direct adapter restores namespace metadata supplied through additional_tools', async () => {
  const adapterFetch = createResponsesChatAdapterFetch(async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'mcp__browser__navigate', arguments: '{"url":"https://example.com"}' } }] } }],
  }), { headers: { 'content-type': 'application/json' } }));
  const response = await adapterFetch('http://vllm:8001/v1/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: 'qwen', stream: false,
      input: [
        { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'mcp__browser__', tools: [{ name: 'navigate', parameters: { type: 'object', properties: {} } }] }] },
        { type: 'message', role: 'user', content: 'Browse' },
      ],
    }),
  });
  const payload = await response.json();
  assert.equal(payload.output[0].name, 'navigate');
  assert.equal(payload.output[0].namespace, 'mcp__browser__');
});

test('OpenAI config accepts the public VLLM proxy Responses mode environment variable', () => {
  assert.equal(loadOpenAiConfig(env({ RESPONSES_UPSTREAM_MODE: undefined, VLLM_PROXY_RESPONSES_UPSTREAM_MODE: 'native' })).responsesUpstreamMode, 'native');
});

test('custom tool announces its Responses item before the Chat stream terminal event', async () => {
  const encoder = new TextEncoder();
  let releaseTerminal;
  const upstreamBody = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_patch","type":"function","function":{"name":"apply_patch","arguments":"{\\"__arg1\\":\\"*** Begin"}}]},"finish_reason":null}]}\n\n'));
      releaseTerminal = () => {
        controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" Patch\\"}"}}]},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      };
    },
  });
  const adapterFetch = createResponsesChatAdapterFetch(async () => new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } }));
  const response = await adapterFetch('http://vllm:8001/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'qwen', input: 'Patch', stream: true, tools: [{ type: 'custom', name: 'apply_patch' }] }),
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.match(decoder.decode(first.value), /response\.created/);

  const pending = reader.read();
  const early = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 50)),
  ]);
  releaseTerminal();
  assert.equal(early.timeout, undefined, 'custom Tool boundary was not emitted before terminal');
  const earlyText = decoder.decode(early.value);
  assert.match(earlyText, /"type":"custom_tool_call"/);
  assert.doesNotMatch(earlyText, /response\.completed/);

  let remainder = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    remainder += decoder.decode(value);
  }
  assert.match(remainder, /response\.custom_tool_call_input\.done/);
  assert.match(remainder, /response\.completed/);
});

test('Responses user input_image converts to Chat image_url content without dropping text', () => {
  const chat = convertResponsesRequestToChat({
    model: 'qwen',
    input: [{
      type: 'message', role: 'user',
      content: [
        { type: 'input_text', text: 'Inspect this image.' },
        { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'high' },
      ],
    }],
  });
  assert.deepEqual(chat.messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'Inspect this image.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high' } },
    ],
  }]);
});

test('Responses unknown content blocks fail explicitly instead of being silently dropped', () => {
  assert.throws(() => convertResponsesRequestToChat({
    model: 'qwen',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_audio', audio_url: 'data:audio/wav;base64,AA==' }] }],
  }), /unsupported_responses_content_item/);
});
