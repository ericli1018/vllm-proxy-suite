import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSearxngSearchUrl,
  createAnthropicManagedWebSearchFetch,
  normalizeSearxngResults,
} from '../packages/anthropic/managed-websearch.js';
import { loadAnthropicConfig } from '../apps/vllm-cc-proxy/server.js';

function anthropicSse(content, stopReason = 'end_turn') {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
  ];
  content.forEach((block, index) => {
    frames.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block })}\n\n`);
    if (block.type === 'tool_use') {
      frames.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } })}\n\n`);
    }
    frames.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
  });
  frames.push(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } })}\n\n`);
  frames.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  return frames.join('');
}

function response(body, contentType = 'text/event-stream') {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

function config(overrides = {}) {
  return {
    managedWebSearchEnabled: true,
    managedWebSearchToolNames: ['WebSearch'],
    searxngBaseUrl: 'http://searxng:8080',
    searxngApiKey: '',
    searxngTimeoutMs: 1000,
    searxngMaxUses: 3,
    searxngMaxResults: 3,
    searxngMaxResultBytes: 4096,
    searxngMaxResponseBytes: 1024 * 1024,
    searxngMaxSnippetChars: 120,
    searxngLanguage: 'all',
    searxngCategories: ['general'],
    searxngSafeSearch: 0,
    ...overrides,
  };
}

test('SearXNG URL maps query and bounded search options', () => {
  const url = new URL(buildSearxngSearchUrl({ query: 'vllm codex', language: 'zh-TW', page: 2 }, config()));
  assert.equal(url.origin, 'http://searxng:8080');
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), 'vllm codex');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(url.searchParams.get('language'), 'zh-TW');
  assert.equal(url.searchParams.get('pageno'), '2');
  assert.equal(url.searchParams.get('categories'), 'general');
});

test('SearXNG normalization filters domains, deduplicates URLs, and limits payload', () => {
  const result = normalizeSearxngResults({
    query: 'test',
    allowedDomains: ['example.com'],
    blockedDomains: ['blocked.example.com'],
    payload: {
      results: [
        { title: 'A', url: 'https://example.com/a?utm_source=x', content: 'a'.repeat(300), engine: 'brave' },
        { title: 'A duplicate', url: 'https://example.com/a', content: 'duplicate' },
        { title: 'Blocked', url: 'https://blocked.example.com/x', content: 'blocked' },
        { title: 'Other', url: 'https://other.test/x', content: 'other' },
      ],
    },
    config: config({ searxngMaxResultBytes: 700, searxngMaxSnippetChars: 80 }),
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].url, 'https://example.com/a');
  assert.equal(result.results[0].snippet.length, 80);
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 700);
  assert.match(result.text, /untrusted external search data/i);
});

test('managed WebSearch executes SearXNG and continues Anthropic messages internally', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).startsWith('http://searxng:8080/')) {
      return response(JSON.stringify({ results: [{ title: 'vLLM docs', url: 'https://docs.vllm.ai/', content: 'tool calling docs', engine: 'brave' }] }), 'application/json');
    }
    const vllmCalls = calls.filter((call) => call.url === 'http://vllm:8001/v1/messages');
    if (vllmCalls.length === 1) {
      return response(anthropicSse([
        { type: 'thinking', thinking: 'Need current sources.' },
        { type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: { query: 'vLLM Codex tools' } },
      ], 'tool_use'));
    }
    return response(anthropicSse([{ type: 'text', text: 'Research complete.' }]));
  };
  const wrapped = createAnthropicManagedWebSearchFetch(fetchImpl, config());
  const original = {
    model: 'm', stream: true, max_tokens: 1024,
    messages: [{ role: 'user', content: 'research it' }],
    tools: [{ name: 'WebSearch', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
  };
  const final = await wrapped('http://vllm:8001/v1/messages', { method: 'POST', body: JSON.stringify(original) });
  const text = await final.text();
  assert.match(text, /Research complete/);
  assert.doesNotMatch(text, /"name":"WebSearch"/);
  assert.equal(final.headers.get('x-vllm-proxy-managed-websearch-uses'), '1');

  const vllmCalls = calls.filter((call) => call.url === 'http://vllm:8001/v1/messages');
  assert.equal(vllmCalls.length, 2);
  const continuation = vllmCalls[1].body;
  assert.deepEqual(continuation.messages.at(-2).content[1], {
    type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: { query: 'vLLM Codex tools' },
  });
  const toolResult = continuation.messages.at(-1).content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'toolu_1');
  assert.equal(toolResult.is_error, false);
  assert.match(toolResult.content, /docs\.vllm\.ai/);
});

test('mixed WebSearch and client tool response is serialized once and repeated mixing is fused', async () => {
  let upstreamCalls = 0;
  let searxngCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).startsWith('http://searxng:8080/')) {
      searxngCalls += 1;
      return response(JSON.stringify({ results: [{ title: 'R', url: 'https://example.com/r', content: 'evidence' }] }), 'application/json');
    }
    upstreamCalls += 1;
    return response(anthropicSse([
      { type: 'tool_use', id: `s${upstreamCalls}`, name: 'WebSearch', input: { query: 'x' } },
      { type: 'tool_use', id: `b${upstreamCalls}`, name: 'Bash', input: { command: 'pwd' } },
    ], 'tool_use'));
  };
  const wrapped = createAnthropicManagedWebSearchFetch(fetchImpl, config());
  const final = await wrapped('http://vllm:8001/v1/messages', { method: 'POST', body: JSON.stringify({ stream: true, messages: [], tools: [{ name: 'WebSearch' }, { name: 'Bash' }] }) });
  const payload = await final.json();
  assert.equal(final.status, 422);
  assert.equal(payload.error.type, 'managed_web_mixed_batch_repeated');
  assert.equal(payload.error.retryable, false);
  assert.equal(upstreamCalls, 2);
  assert.equal(searxngCalls, 1);
});

test('SearXNG failure becomes an error tool_result and the model can continue', async () => {
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('http://searxng:8080/')) return new Response('unavailable', { status: 503 });
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) return response(anthropicSse([{ type: 'tool_use', id: 's1', name: 'WebSearch', input: { query: 'x' } }], 'tool_use'));
    return response(anthropicSse([{ type: 'text', text: 'Search backend failed; continuing without it.' }]));
  };
  const wrapped = createAnthropicManagedWebSearchFetch(fetchImpl, config());
  const final = await wrapped('http://vllm:8001/v1/messages', { method: 'POST', body: JSON.stringify({ stream: true, messages: [] }) });
  assert.match(await final.text(), /continuing without it/);
  assert.equal(final.headers.get('x-vllm-proxy-managed-websearch-failures'), '1');
  const toolResult = bodies[1].messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /503/);
});

test('Anthropic config exposes an opt-in bounded WebSearch bridge', () => {
  const loaded = loadAnthropicConfig({
    CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED: 'true',
    SEARXNG_BASE_URL: 'http://searxng:8080/',
    CLAUDE_CODE_WEBSEARCH_TOOL_NAMES: 'WebSearch,web_search',
    SEARXNG_MAX_USES: '4',
    SEARXNG_MAX_RESULTS: '7',
  });
  assert.equal(loaded.managedWebSearchEnabled, true);
  assert.equal(loaded.searxngBaseUrl, 'http://searxng:8080');
  assert.deepEqual(loaded.managedWebSearchToolNames, ['WebSearch', 'web_search']);
  assert.equal(loaded.searxngMaxUses, 4);
  assert.equal(loaded.searxngMaxResults, 7);
});

test('managed WebSearch enforces the use limit and removes the tool before final continuation', async () => {
  const bodies = [];
  let searchCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('http://searxng:8080/')) {
      searchCalls += 1;
      return response(JSON.stringify({ results: [{ title: 'R', url: `https://example.com/${searchCalls}`, content: 'result' }] }), 'application/json');
    }
    bodies.push(JSON.parse(init.body));
    if (bodies.length <= 2) {
      return response(anthropicSse([{ type: 'tool_use', id: `s${bodies.length}`, name: 'WebSearch', input: { query: `q${bodies.length}` } }], 'tool_use'));
    }
    return response(anthropicSse([{ type: 'text', text: 'Stopped searching and summarized.' }]));
  };
  const wrapped = createAnthropicManagedWebSearchFetch(fetchImpl, config({ searxngMaxUses: 1 }));
  const final = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      stream: true,
      messages: [],
      tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }, { name: 'Bash', input_schema: { type: 'object' } }],
    }),
  });
  assert.match(await final.text(), /Stopped searching/);
  assert.equal(searchCalls, 1);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[2].tools.map((tool) => tool.name), ['Bash']);
  assert.equal(bodies[2].messages.at(-1).content[0].is_error, true);
  assert.match(bodies[2].messages.at(-1).content[0].content, /use limit reached/i);
  assert.equal(final.headers.get('x-vllm-proxy-managed-websearch-limit-reached'), 'true');
});

test('managed WebSearch supports non-stream Anthropic responses', async () => {
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('http://searxng:8080/')) {
      return response(JSON.stringify({ results: [{ title: 'R', url: 'https://example.com/r', content: 'result' }] }), 'application/json');
    }
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return response(JSON.stringify({
        id: 'm1', type: 'message', role: 'assistant', model: 'm', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 's1', name: 'WebSearch', input: { query: 'q' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), 'application/json');
    }
    return response(JSON.stringify({
      id: 'm2', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'non-stream done' }],
      usage: { input_tokens: 2, output_tokens: 2 },
    }), 'application/json');
  };
  const wrapped = createAnthropicManagedWebSearchFetch(fetchImpl, config());
  const final = await wrapped('http://vllm:8001/v1/messages', { method: 'POST', body: JSON.stringify({ stream: false, messages: [] }) });
  assert.match(await final.text(), /non-stream done/);
  assert.equal(final.headers.get('x-vllm-proxy-managed-websearch-uses'), '1');
});

test('managed WebSearch refuses oversized queries before contacting SearXNG', async () => {
  let searchCalls = 0;
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('http://searxng:8080/')) {
      searchCalls += 1;
      return response('{}', 'application/json');
    }
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) return response(anthropicSse([{ type: 'tool_use', id: 's1', name: 'WebSearch', input: { query: 'x'.repeat(20) } }], 'tool_use'));
    return response(anthropicSse([{ type: 'text', text: 'Handled query error.' }]));
  };
  const wrapped = createAnthropicManagedWebSearchFetch(fetchImpl, config({ searxngMaxQueryChars: 8 }));
  const final = await wrapped('http://vllm:8001/v1/messages', { method: 'POST', body: JSON.stringify({ stream: true, messages: [] }) });
  assert.match(await final.text(), /Handled query error/);
  assert.equal(searchCalls, 0);
  assert.match(bodies[1].messages.at(-1).content[0].content, /query_too_long/i);
});

test('unsupported Anthropic content blocks disable interception to avoid lossy continuation', async () => {
  let calls = 0;
  const raw = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"s1","name":"WebSearch","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"x\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  const wrapped = createAnthropicManagedWebSearchFetch(async () => {
    calls += 1;
    return response(raw);
  }, config());
  const final = await wrapped('http://vllm:8001/v1/messages', { method: 'POST', body: JSON.stringify({ stream: true, messages: [] }) });
  assert.equal(calls, 1);
  assert.match(await final.text(), /redacted_thinking/);
});
