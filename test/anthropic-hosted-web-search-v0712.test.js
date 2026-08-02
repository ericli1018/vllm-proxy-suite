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

function managedConfig(overrides = {}) {
  return {
    managedWebSearchEnabled: true,
    managedWebSearchToolNames: ['WebSearch', 'web_search'],
    managedWebFetchEnabled: true,
    managedWebFetchToolNames: ['WebFetch'],
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

test('hosted web_search_20250305 is normalized before vLLM and remains proxy-managed', async (t) => {
  const vllmBodies = [];
  let searxngCalls = 0;
  const config = loadAnthropicConfig({
    PROXY_HOST: '127.0.0.1', PROXY_PORT: '0',
    VLLM_BASE_URL: 'http://vllm:8001', VLLM_API_KEY: 'vllm', VLLM_CC_PROXY_API_KEY: 'client',
    CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED: 'true', SEARXNG_BASE_URL: 'http://searxng:8080',
    SEARXNG_MAX_USES: '5', HEARTBEAT_INTERVAL_MS: '60000',
    TOTAL_GENERATION_TIMEOUT_MS: '10000', RECOVERY_TIMEOUT_MS: '10000',
    MAX_TOTAL_BUFFERED_BYTES: '1048576', MAX_RESPONSE_BUFFER_BYTES: '1048576',
  });
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('http://searxng:8080/')) {
      searxngCalls += 1;
      return new Response(JSON.stringify({ results: [{ title: 'News', url: 'https://example.com/news', content: 'Current evidence' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmBodies.push(JSON.parse(init.body));
    if (vllmBodies.length > 3) throw new Error('unexpected managed loop');
    if (vllmBodies.length === 1) return sseResponse([{ type: 'tool_use', id: 'hs1', name: 'web_search', input: { query: 'August 1 2026 news' } }], 'tool_use');
    return sseResponse([{ type: 'text', text: 'Hosted search complete.' }]);
  };

  const runtime = createAnthropicProxyRuntime({ config, fetchImpl, exposeControlRoutes: false });
  const server = createManagedHttpServer({ handler: runtime.handle, config: runtime.config });
  const base = await server.start();
  t.after(() => server.stop());

  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true, max_tokens: 1024,
      messages: [{ role: 'user', content: 'Search current news.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      tool_choice: { type: 'tool', name: 'web_search' },
    }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /Hosted search complete/);
  assert.equal(searxngCalls, 1);
  assert.equal(vllmBodies.length, 2);
  assert.equal(vllmBodies[0].tools[0].name, 'web_search');
  assert.equal(vllmBodies[0].tools[0].type, undefined);
  assert.equal(vllmBodies[0].tools[0].max_uses, undefined);
  assert.equal(vllmBodies[0].tools[0].input_schema.type, 'object');
  assert.deepEqual(vllmBodies[0].tools[0].input_schema.required, ['query']);
  assert.deepEqual(vllmBodies[0].tool_choice, { type: 'tool', name: 'web_search' });
});

test('hosted max_uses bounds managed searches without exposing another hosted tool request', async (t) => {
  const vllmBodies = [];
  let searxngCalls = 0;
  const config = loadAnthropicConfig({
    PROXY_HOST: '127.0.0.1', PROXY_PORT: '0',
    VLLM_BASE_URL: 'http://vllm:8001', VLLM_API_KEY: 'vllm', VLLM_CC_PROXY_API_KEY: 'client',
    CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED: 'true', SEARXNG_BASE_URL: 'http://searxng:8080',
    SEARXNG_MAX_USES: '5', HEARTBEAT_INTERVAL_MS: '60000',
    TOTAL_GENERATION_TIMEOUT_MS: '10000', RECOVERY_TIMEOUT_MS: '10000',
    MAX_TOTAL_BUFFERED_BYTES: '1048576', MAX_RESPONSE_BUFFER_BYTES: '1048576',
  });
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('http://searxng:8080/')) {
      searxngCalls += 1;
      return new Response(JSON.stringify({ results: [{ title: 'R', url: `https://example.com/${searxngCalls}`, content: 'evidence' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmBodies.push(JSON.parse(init.body));
    if (vllmBodies.length > 4) throw new Error('unexpected managed loop');
    if (vllmBodies.length === 1) return sseResponse([{ type: 'tool_use', id: 's1', name: 'web_search', input: { query: 'first' } }], 'tool_use');
    if (vllmBodies.length === 2) return sseResponse([{ type: 'tool_use', id: 's2', name: 'web_search', input: { query: 'second' } }], 'tool_use');
    return sseResponse([{ type: 'text', text: 'Bounded hosted search complete.' }]);
  };

  const runtime = createAnthropicProxyRuntime({ config, fetchImpl, exposeControlRoutes: false });
  const server = createManagedHttpServer({ handler: runtime.handle, config: runtime.config });
  const base = await server.start();
  t.after(() => server.stop());
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true, messages: [{ role: 'user', content: 'search' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      tool_choice: { type: 'tool', name: 'web_search' },
    }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /Bounded hosted search complete/);
  assert.equal(searxngCalls, 1);
  assert.equal(vllmBodies.length, 3);
  assert.equal(vllmBodies[2].tools.length, 0);
  assert.match(vllmBodies[2].messages.at(-1).content[0].content, /use limit reached/i);
});

test('WebFetch limit disables only fetch and a subsequent WebSearch remains managed', async () => {
  const vllmBodies = [];
  let searxngCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('http://searxng:8080/')) {
      searxngCalls += 1;
      return new Response(JSON.stringify({ results: [{ title: 'R', url: 'https://example.com/r', content: 'evidence' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmBodies.push(JSON.parse(init.body));
    if (vllmBodies.length > 5) throw new Error('unexpected managed loop');
    if (vllmBodies.length === 1) return sseResponse([{ type: 'tool_use', id: 'f1', name: 'WebFetch', input: {} }], 'tool_use');
    if (vllmBodies.length === 2) return sseResponse([{ type: 'tool_use', id: 'f2', name: 'WebFetch', input: {} }], 'tool_use');
    if (vllmBodies.length === 3) return sseResponse([{ type: 'tool_use', id: 's1', name: 'WebSearch', input: { query: 'still search' } }], 'tool_use');
    return sseResponse([{ type: 'text', text: 'Search continued after fetch limit.' }]);
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, managedConfig({ webFetchMaxUses: 1 }));
  const response = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }, { name: 'WebSearch' }] }),
  });
  const text = await response.text();

  assert.match(text, /Search continued after fetch limit/);
  assert.equal(searxngCalls, 1);
  assert.equal(vllmBodies.length, 4);
  assert.deepEqual(vllmBodies[2].tools.map((tool) => tool.name), ['WebSearch']);
});

test('WebSearch limit disables only search and a subsequent WebFetch remains managed', async () => {
  const vllmBodies = [];
  let searxngCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('http://searxng:8080/')) {
      searxngCalls += 1;
      return new Response(JSON.stringify({ results: [{ title: 'R', url: 'https://example.com/r', content: 'evidence' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmBodies.push(JSON.parse(init.body));
    if (vllmBodies.length > 5) throw new Error('unexpected managed loop');
    if (vllmBodies.length === 1) return sseResponse([{ type: 'tool_use', id: 's1', name: 'WebSearch', input: { query: 'first' } }], 'tool_use');
    if (vllmBodies.length === 2) return sseResponse([{ type: 'tool_use', id: 's2', name: 'WebSearch', input: { query: 'second' } }], 'tool_use');
    if (vllmBodies.length === 3) return sseResponse([{ type: 'tool_use', id: 'f1', name: 'WebFetch', input: {} }], 'tool_use');
    return sseResponse([{ type: 'text', text: 'Fetch continued after search limit.' }]);
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, managedConfig({ searxngMaxUses: 1, webFetchMaxUses: 1 }));
  const response = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebSearch' }, { name: 'WebFetch' }] }),
  });
  const text = await response.text();

  assert.match(text, /Fetch continued after search limit/);
  assert.equal(searxngCalls, 1);
  assert.equal(vllmBodies.length, 4);
  assert.deepEqual(vllmBodies[2].tools.map((tool) => tool.name), ['WebFetch']);
});

test('hosted web search is rejected locally when the managed bridge is disabled', async (t) => {
  let upstreamCalls = 0;
  const config = loadAnthropicConfig({
    PROXY_HOST: '127.0.0.1', PROXY_PORT: '0',
    VLLM_BASE_URL: 'http://vllm:8001', VLLM_API_KEY: 'vllm', VLLM_CC_PROXY_API_KEY: 'client',
    CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED: 'false',
  });
  const runtime = createAnthropicProxyRuntime({
    config,
    fetchImpl: async () => { upstreamCalls += 1; return new Response('unexpected'); },
    exposeControlRoutes: false,
  });
  const server = createManagedHttpServer({ handler: runtime.handle, config: runtime.config });
  const base = await server.start();
  t.after(() => server.stop());

  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: false, messages: [{ role: 'user', content: 'search' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      tool_choice: { type: 'tool', name: 'web_search' },
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(upstreamCalls, 0);
  assert.equal(payload.error.type, 'anthropic_hosted_web_search_unavailable');
  assert.equal(payload.error.retryable, false);
});

test('repeated managed tool call after its limit is fused without another model request or client-visible tool call', async () => {
  const vllmBodies = [];
  let searxngCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('http://searxng:8080/')) {
      searxngCalls += 1;
      return new Response(JSON.stringify({ results: [{ title: 'R', url: 'https://example.com/r', content: 'evidence' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmBodies.push(JSON.parse(init.body));
    if (vllmBodies.length > 4) throw new Error('unexpected managed loop');
    return sseResponse([{ type: 'tool_use', id: `s${vllmBodies.length}`, name: 'WebSearch', input: { query: `q${vllmBodies.length}` } }], 'tool_use');
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, managedConfig({ searxngMaxUses: 1 }));
  const response = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebSearch' }] }),
  });
  const payload = await response.json();

  assert.equal(response.status, 422);
  assert.equal(payload.error.type, 'managed_web_tool_limit_repeated');
  assert.equal(payload.error.retryable, false);
  assert.equal(payload.error.kind, 'search');
  assert.equal(searxngCalls, 1);
  assert.equal(vllmBodies.length, 4);
});

test('full proxy preserves bounded managed limit failure as non-retryable SSE error without another model request', async (t) => {
  const vllmBodies = [];
  let searxngCalls = 0;
  const config = loadAnthropicConfig({
    PROXY_HOST: '127.0.0.1', PROXY_PORT: '0',
    VLLM_BASE_URL: 'http://vllm:8001', VLLM_API_KEY: 'vllm', VLLM_CC_PROXY_API_KEY: 'client',
    CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED: 'true', SEARXNG_BASE_URL: 'http://searxng:8080',
    SEARXNG_MAX_USES: '1', HEARTBEAT_INTERVAL_MS: '60000',
    TOTAL_GENERATION_TIMEOUT_MS: '10000', RECOVERY_TIMEOUT_MS: '10000',
    MAX_TOTAL_BUFFERED_BYTES: '1048576', MAX_RESPONSE_BUFFER_BYTES: '1048576',
  });
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('http://searxng:8080/')) {
      searxngCalls += 1;
      return new Response(JSON.stringify({ results: [{ title: 'R', url: 'https://example.com/r', content: 'evidence' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmBodies.push(JSON.parse(init.body));
    if (vllmBodies.length > 4) throw new Error('unexpected managed loop');
    return sseResponse([{ type: 'tool_use', id: `s${vllmBodies.length}`, name: 'web_search', input: { query: `q${vllmBodies.length}` } }], 'tool_use');
  };

  const runtime = createAnthropicProxyRuntime({ config, fetchImpl, exposeControlRoutes: false });
  const server = createManagedHttpServer({ handler: runtime.handle, config: runtime.config });
  const base = await server.start();
  t.after(() => server.stop());

  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true, messages: [{ role: 'user', content: 'search' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      tool_choice: { type: 'tool', name: 'web_search' },
    }),
  });
  const text = await response.text();
  const errorLine = text.split('\n').find((line) => line.startsWith('data: {"type":"error"'));
  assert.ok(errorLine, text);
  const payload = JSON.parse(errorLine.slice(6));

  assert.equal(payload.error.type, 'managed_web_tool_limit_repeated');
  assert.equal(payload.error.retryable, false);
  assert.equal(payload.error.managedWebToolKind, 'search');
  assert.equal(searxngCalls, 1);
  assert.equal(vllmBodies.length, 4);
});
