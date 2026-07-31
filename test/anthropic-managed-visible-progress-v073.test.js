import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnthropicProxyRuntime, loadAnthropicConfig } from '../apps/vllm-cc-proxy/server.js';
import { applyAnthropicRequestPolicy } from '../packages/anthropic/messages.js';
import {
  MANAGED_PROGRESS_SENTINEL,
  createManagedAnthropicStatusDelta,
} from '../packages/anthropic/stream-envelope.js';
import { createManagedHttpServer } from '../packages/server/create-proxy-server.js';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function anthropicSse(content, stopReason = 'end_turn') {
  const frames = ['event: message_start\ndata: {"type":"message_start","message":{"id":"m-upstream","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":10,"output_tokens":0}}}\n\n'];
  content.forEach((block, index) => {
    frames.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block })}\n\n`);
    if (block.type === 'text' && block.text) frames.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}\n\n`);
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

function baseConfig(extra = {}) {
  return {
    ...loadAnthropicConfig({
      PROXY_HOST: '127.0.0.1', VLLM_BASE_URL: 'http://vllm:8001', VLLM_API_KEY: 'vllm', VLLM_CC_PROXY_API_KEY: 'client',
      CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED: 'true', CLAUDE_CODE_WEBFETCH_BRIDGE_ENABLED: 'true',
      SEARXNG_BASE_URL: 'http://searxng:8080', MANAGED_WEB_STREAM_PROGRESS_MODE: 'visible',
      MANAGED_WEB_STREAM_PROGRESS_DETAIL: 'query', MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS: '20',
      MANAGED_WEB_STREAM_PROGRESS_MAX_LABEL_CHARS: '80', MANAGED_WEB_STREAM_PROGRESS_MAX_DOTS: '3',
      HEARTBEAT_INTERVAL_MS: '60000', UPSTREAM_IDLE_TIMEOUT_MS: '5000', TOTAL_GENERATION_TIMEOUT_MS: '5000',
      RECOVERY_TIMEOUT_MS: '5000', MAX_TOTAL_BUFFERED_BYTES: '1048576', MAX_RESPONSE_BUFFER_BYTES: '1048576',
      ...extra,
    }),
    port: 0,
  };
}

async function startRuntime(t, config, fetchImpl) {
  const runtime = createAnthropicProxyRuntime({ config, fetchImpl, exposeControlRoutes: false });
  const server = createManagedHttpServer({ handler: runtime.handle, config: runtime.config });
  const base = await server.start();
  t.after(() => server.stop());
  return base;
}

async function requestStream(base, tools, content = 'work') {
  return fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content }], tools }),
  });
}

test('ordinary Claude Code Bash response does not create a synthetic progress block', async (t) => {
  const config = baseConfig();
  const base = await startRuntime(t, config, async () => sseResponse([
    { type: 'tool_use', id: 'bash-id', name: 'Bash', input: { command: 'pwd' } },
  ], 'tool_use'));
  const response = await requestStream(base, [{ name: 'Bash', input_schema: { type: 'object' } }]);
  const all = await response.text();
  assert.equal([...all.matchAll(/event: message_start/g)].length, 1);
  assert.match(all, /"type":"content_block_start","index":0/);
  assert.match(all, /"name":"Bash"/);
  assert.doesNotMatch(all, /正在搜尋|正在讀取|\u2063/);
  assert.doesNotMatch(all, /"type":"content_block_start","index":1/);
});

test('managed WebSearch displays a sanitized query, periodic dots, and completion text', async (t) => {
  let vllmCalls = 0;
  const config = baseConfig();
  const fetchImpl = async (url) => {
    if (String(url).startsWith('http://searxng:8080/')) {
      await sleep(95);
      return new Response(JSON.stringify({ results: [{ title: 'A', url: 'https://example.com/a', content: 'evidence' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmCalls += 1;
    if (vllmCalls === 1) return sseResponse([{ type: 'tool_use', id: 'search-id', name: 'WebSearch', input: { query: '  OpenSSL\n integration\u0007 example  ' } }], 'tool_use');
    return sseResponse([{ type: 'text', text: 'Final answer.' }]);
  };
  const base = await startRuntime(t, config, fetchImpl);
  const response = await requestStream(base, [{ name: 'WebSearch', input_schema: { type: 'object' } }], 'search');
  const all = await response.text();
  assert.match(all, /正在搜尋：OpenSSL integration example/);
  assert.doesNotMatch(all, /OpenSSL\\n|OpenSSL.*\\u0007/);
  assert.ok([...all.matchAll(/…/g)].length >= 2, all);
  assert.match(all, /搜尋完成，取得 1 筆結果/);
  assert.match(all, /Final answer/);
  assert.equal([...all.matchAll(/event: message_start/g)].length, 1);
  assert.equal([...all.matchAll(/event: message_stop/g)].length, 1);
});


test('managed stream closes visible progress before a continuation HTTP error', async (t) => {
  let vllmCalls = 0;
  const config = baseConfig({ MAX_RECOVERY_ATTEMPTS: '0' });
  const fetchImpl = async (url) => {
    if (String(url).startsWith('http://searxng:8080/')) {
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    vllmCalls += 1;
    if (vllmCalls === 1) return sseResponse([{ type: 'tool_use', id: 'search-id', name: 'WebSearch', input: { query: 'error path' } }], 'tool_use');
    return new Response(JSON.stringify({ error: { message: 'continuation failed' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  const base = await startRuntime(t, config, fetchImpl);
  const response = await requestStream(base, [{ name: 'WebSearch', input_schema: { type: 'object' } }]);
  const all = await response.text();
  assert.equal(response.status, 200);
  assert.equal([...all.matchAll(/event: message_start/g)].length, 1);
  assert.equal([...all.matchAll(/"type":"content_block_stop","index":0/g)].length, 1);
  assert.match(all, /event: error/);
  assert.match(all, /upstream_http_error/);
});

test('WebFetch visible status exposes hostname only and never URL query parameters', () => {
  const delta = createManagedAnthropicStatusDelta({
    phase: 'started', kind: 'fetch', displayValue: 'https://news.example.com/path?token=secret&session=abc',
  }, { mode: 'visible', detail: 'query', maxLabelChars: 160 });
  assert.match(delta, /正在讀取：news\.example\.com/);
  assert.doesNotMatch(delta, /token|secret|session|\/path/);
});

test('synthetic progress blocks are removed from later vLLM request history', () => {
  const config = baseConfig();
  const body = applyAnthropicRequestPolicy({
    model: 'm', max_tokens: 100,
    messages: [
      { role: 'user', content: 'search' },
      { role: 'assistant', content: [
        { type: 'text', text: `${MANAGED_PROGRESS_SENTINEL}正在搜尋：private query………完成。` },
        { type: 'text', text: 'Final answer retained.' },
      ] },
    ],
  }, config);
  assert.deepEqual(body.messages[1].content, [{ type: 'text', text: 'Final answer retained.' }]);
});

test('v0.7.3 config exposes visible progress controls', () => {
  const config = loadAnthropicConfig({
    MANAGED_WEB_STREAM_PROGRESS_MODE: 'minimal',
    MANAGED_WEB_STREAM_PROGRESS_DETAIL: 'tool',
    MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS: '7000',
    MANAGED_WEB_STREAM_PROGRESS_MAX_LABEL_CHARS: '120',
    MANAGED_WEB_STREAM_PROGRESS_MAX_DOTS: '9',
  });
  assert.equal(config.managedWebStreamProgressMode, 'minimal');
  assert.equal(config.managedWebStreamProgressDetail, 'tool');
  assert.equal(config.managedWebStreamProgressIntervalMs, 7000);
  assert.equal(config.managedWebStreamProgressMaxLabelChars, 120);
  assert.equal(config.managedWebStreamProgressMaxDots, 9);
});
