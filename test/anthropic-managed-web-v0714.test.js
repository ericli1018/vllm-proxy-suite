import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnthropicProxyRuntime, loadAnthropicConfig } from '../apps/vllm-cc-proxy/server.js';
import { createAnthropicManagedWebToolsFetch } from '../packages/anthropic/managed-web-tools.js';
import { createManagedHttpServer } from '../packages/server/create-proxy-server.js';

function anthropicSse(content, stopReason = 'end_turn') {
  const frames = ['event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":10,"output_tokens":0}}}\n\n'];
  content.forEach((block, index) => {
    frames.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block })}\n\n`);
    if (block.type === 'tool_use') frames.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } })}\n\n`);
    frames.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
  });
  frames.push(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } })}\n\n`);
  frames.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  return frames.join('');
}

function sseResponse(content, stopReason = 'end_turn') {
  return new Response(anthropicSse(content, stopReason), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function config(overrides = {}) {
  return {
    managedWebSearchEnabled: true,
    managedWebSearchToolNames: ['WebSearch', 'web_search'],
    managedWebFetchEnabled: true,
    managedWebFetchToolNames: ['WebFetch', 'web_fetch'],
    managedWebToolsThink: false,
    managedWebToolsMaxBatch: 8,
    webSearchMaxParallel: 2,
    webFetchMaxParallel: 2,
    searxngBaseUrl: 'http://searxng:8080',
    searxngApiKey: '', searxngTimeoutMs: 1000, searxngMaxUses: 5,
    searxngMaxResults: 3, searxngMaxResultBytes: 4096, searxngMaxResponseBytes: 1024 * 1024,
    searxngMaxSnippetChars: 120, searxngMaxTitleChars: 300, searxngMaxQueryChars: 1024,
    searxngLanguage: 'all', searxngCategories: ['general'], searxngSafeSearch: 0,
    webFetchTimeoutMs: 1000, webFetchMaxUses: 1, webFetchMaxRedirects: 2,
    webFetchMaxDownloadBytes: 1024 * 1024, webFetchMaxExtractedChars: 100000,
    webFetchMaxPromptChars: 4000, webFetchReaderChunkChars: 10000,
    webFetchReaderChunkOverlapChars: 100, webFetchReaderMaxChunks: 8,
    webFetchPdfPagesPerChunk: 1, webFetchPdfMaxPages: 10, webFetchPdfExtractTimeoutMs: 1000,
    webFetchReaderMaxTokens: 200, webFetchSynthesisMaxTokens: 300,
    webFetchSynthesisInputMaxChars: 20000, webFetchResultMaxBytes: 16384,
    webFetchModelTimeoutMs: 2000, webFetchModelResponseMaxBytes: 1024 * 1024,
    maxContentItems: 128, maxReasoningBytes: 1024 * 1024, maxToolArgumentBytes: 1024 * 1024,
    maxToolCalls: 32,
    ...overrides,
  };
}

test('managed web classification treats end_turn with a tool call as tool_use before dispatch', async () => {
  const vllmBodies = [];
  let searchCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('http://searxng:8080/')) {
      searchCalls += 1;
      return new Response(JSON.stringify({ results: [{ title: 'R', url: 'https://example.com/r', content: 'evidence' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmBodies.push(JSON.parse(init.body));
    if (vllmBodies.length === 1) return sseResponse([{ type: 'tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }], 'end_turn');
    return sseResponse([{ type: 'text', text: 'Search completed.' }], 'end_turn');
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config());
  const response = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'web_search' }] }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /Search completed/);
  assert.doesNotMatch(text, /"name":"web_search"/);
  assert.equal(searchCalls, 1);
  assert.equal(vllmBodies.length, 2);
});

test('mixed managed and client tool batch defers client calls and executes managed search first', async () => {
  const vllmBodies = [];
  let searchCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('http://searxng:8080/')) {
      searchCalls += 1;
      return new Response(JSON.stringify({ results: [{ title: 'R', url: 'https://example.com/r', content: 'evidence' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmBodies.push(JSON.parse(init.body));
    if (vllmBodies.length === 1) {
      return sseResponse([
        { type: 'tool_use', id: 's1', name: 'WebSearch', input: { query: 'x' } },
        { type: 'tool_use', id: 't1', name: 'TaskUpdate', input: { taskId: '1', status: 'done' } },
      ], 'tool_use');
    }
    return sseResponse([{ type: 'tool_use', id: 't2', name: 'TaskUpdate', input: { taskId: '1', status: 'done' } }], 'tool_use');
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config());
  const response = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'm', stream: true, messages: [],
      tools: [{ name: 'WebSearch' }, { name: 'TaskUpdate' }],
    }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(searchCalls, 1);
  assert.equal(vllmBodies.length, 2);
  assert.doesNotMatch(text, /"name":"WebSearch"/);
  assert.match(text, /"name":"TaskUpdate"/);
  assert.equal(vllmBodies[1].messages.at(-2).content.some((block) => block.name === 'TaskUpdate'), false);
});

test('second mixed managed and client batch is fused without a third continuation', async () => {
  const vllmBodies = [];
  let searchCalls = 0;
  const mixed = (suffix) => [
    { type: 'tool_use', id: `s${suffix}`, name: 'WebSearch', input: { query: `q${suffix}` } },
    { type: 'tool_use', id: `t${suffix}`, name: 'TaskUpdate', input: { taskId: '1', status: 'done' } },
  ];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('http://searxng:8080/')) {
      searchCalls += 1;
      return new Response(JSON.stringify({ results: [{ title: 'R', url: 'https://example.com/r', content: 'evidence' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmBodies.push(JSON.parse(init.body));
    return sseResponse(mixed(vllmBodies.length), 'tool_use');
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config());
  const response = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebSearch' }, { name: 'TaskUpdate' }] }),
  });
  const payload = await response.json();

  assert.equal(response.status, 422);
  assert.equal(payload.error.type, 'managed_web_mixed_batch_repeated');
  assert.equal(payload.error.retryable, false);
  assert.equal(searchCalls, 1);
  assert.equal(vllmBodies.length, 2);
});

test('repeated fetch after limit gets one bounded finalization continuation instead of immediate API error', async () => {
  const vllmBodies = [];
  const fetchImpl = async (_url, init = {}) => {
    vllmBodies.push(JSON.parse(init.body));
    if (vllmBodies.length <= 3) {
      return sseResponse([{ type: 'tool_use', id: `f${vllmBodies.length}`, name: 'WebFetch', input: {} }], 'tool_use');
    }
    return sseResponse([{ type: 'text', text: 'Continued with collected evidence.' }], 'end_turn');
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config({ webFetchMaxUses: 1 }));
  const response = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }] }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /Continued with collected evidence/);
  assert.equal(vllmBodies.length, 4);
  assert.equal(vllmBodies[3].tools.length, 0);
  assert.match(vllmBodies[3].messages.at(-1).content[0].content, /do not call WebFetch again/i);
});

test('second repeated fetch after bounded finalization is fused without another model request', async () => {
  const vllmBodies = [];
  const fetchImpl = async (_url, init = {}) => {
    vllmBodies.push(JSON.parse(init.body));
    return sseResponse([{ type: 'tool_use', id: `f${vllmBodies.length}`, name: 'WebFetch', input: {} }], 'tool_use');
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config({ webFetchMaxUses: 1 }));
  const response = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }] }),
  });
  const payload = await response.json();

  assert.equal(response.status, 422);
  assert.equal(payload.error.type, 'managed_web_tool_limit_repeated');
  assert.equal(payload.error.retryable, false);
  assert.equal(payload.error.kind, 'fetch');
  assert.equal(vllmBodies.length, 4);
});


test('malformed hosted web_search is blocked from escaping to Claude Code', async () => {
  let upstreamCalls = 0;
  const fetchImpl = async () => {
    upstreamCalls += 1;
    const body = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"hs1","name":"web_search","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config());
  const response = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'm', stream: true, messages: [{ role: 'user', content: 'search' }],
      tools: [{
        name: 'web_search',
        input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        x_vllm_proxy_hosted_web_search: { maxUses: 2, allowedDomains: [], blockedDomains: [] },
      }],
      tool_choice: { type: 'tool', name: 'web_search' },
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 422);
  assert.equal(payload.error.type, 'managed_hosted_tool_escape');
  assert.equal(payload.error.retryable, false);
  assert.equal(upstreamCalls, 1);
});

test('full proxy maps repeated mixed managed batch to retry-suppressed SSE 422 semantics', async (t) => {
  const vllmBodies = [];
  let searchCalls = 0;
  const runtimeConfig = loadAnthropicConfig({
    PROXY_HOST: '127.0.0.1', PROXY_PORT: '0',
    VLLM_BASE_URL: 'http://vllm:8001', VLLM_API_KEY: 'vllm', VLLM_CC_PROXY_API_KEY: 'client',
    CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED: 'true', SEARXNG_BASE_URL: 'http://searxng:8080',
    HEARTBEAT_INTERVAL_MS: '60000', TOTAL_GENERATION_TIMEOUT_MS: '10000', RECOVERY_TIMEOUT_MS: '10000',
    MAX_TOTAL_BUFFERED_BYTES: '1048576', MAX_RESPONSE_BUFFER_BYTES: '1048576',
  });
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('http://searxng:8080/')) {
      searchCalls += 1;
      return new Response(JSON.stringify({ results: [{ title: 'R', url: 'https://example.com/r', content: 'evidence' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmBodies.push(JSON.parse(init.body));
    return sseResponse([
      { type: 'tool_use', id: `s${vllmBodies.length}`, name: 'WebSearch', input: { query: 'x' } },
      { type: 'tool_use', id: `t${vllmBodies.length}`, name: 'TaskUpdate', input: { taskId: '1', status: 'done' } },
    ], 'tool_use');
  };

  const runtime = createAnthropicProxyRuntime({ config: runtimeConfig, fetchImpl, exposeControlRoutes: false });
  const server = createManagedHttpServer({ handler: runtime.handle, config: runtime.config });
  const base = await server.start();
  t.after(() => server.stop());

  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true, messages: [{ role: 'user', content: 'research' }],
      tools: [{ name: 'WebSearch' }, { name: 'TaskUpdate' }],
    }),
  });
  const text = await response.text();
  const errorLine = text.split('\n').find((line) => line.startsWith('data: {"type":"error"'));
  assert.ok(errorLine, text);
  const payload = JSON.parse(errorLine.slice(6));

  assert.equal(payload.error.type, 'managed_web_mixed_batch_repeated');
  assert.equal(payload.error.retryable, false);
  assert.equal(payload.error.managedWebMixedBatchRepeated, true);
  assert.equal(searchCalls, 1);
  assert.equal(vllmBodies.length, 2);
});
