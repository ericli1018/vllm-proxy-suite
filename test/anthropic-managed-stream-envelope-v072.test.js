import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnthropicProxyRuntime, loadAnthropicConfig } from '../apps/vllm-cc-proxy/server.js';
import { createManagedHttpServer } from '../packages/server/create-proxy-server.js';
import { createManagedAnthropicStreamStart, spliceManagedAnthropicStream } from '../packages/anthropic/stream-envelope.js';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function anthropicSse(content, stopReason = 'end_turn') {
  const frames = ['event: message_start\ndata: {"type":"message_start","message":{"id":"m-upstream","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":10,"output_tokens":0}}}\n\n'];
  content.forEach((block, index) => {
    frames.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block })}\n\n`);
    if (block.type === 'text' && block.text) {
      frames.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}\n\n`);
    }
    if (block.type === 'tool_use') {
      frames.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } })}\n\n`);
    }
    frames.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
  });
  frames.push(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } })}\n\n`);
  frames.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  return frames.join('');
}

function sseResponse(content, stopReason = 'end_turn') {
  return new Response(anthropicSse(content, stopReason), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function count(text, pattern) { return [...text.matchAll(pattern)].length; }

test('managed streaming starts a valid Anthropic envelope immediately and splices the final response into one lifecycle', async (t) => {
  let vllmCalls = 0;
  const config = { ...loadAnthropicConfig({
    PROXY_HOST: '127.0.0.1',
    VLLM_BASE_URL: 'http://vllm:8001', VLLM_API_KEY: 'vllm', VLLM_CC_PROXY_API_KEY: 'client',
    CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED: 'true', SEARXNG_BASE_URL: 'http://searxng:8080',
    MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS: '30', HEARTBEAT_INTERVAL_MS: '60000',
    UPSTREAM_IDLE_TIMEOUT_MS: '5000', TOTAL_GENERATION_TIMEOUT_MS: '5000', RECOVERY_TIMEOUT_MS: '5000',
    MAX_TOTAL_BUFFERED_BYTES: '1048576', MAX_RESPONSE_BUFFER_BYTES: '1048576',
  }), port: 0 };
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.startsWith('http://searxng:8080/')) {
      await sleep(180);
      return new Response(JSON.stringify({ results: [{ title: 'news', url: 'https://example.com/news', content: 'evidence' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmCalls += 1;
    if (vllmCalls === 1) return sseResponse([{ type: 'tool_use', id: 'search-id', name: 'WebSearch', input: { query: 'today news' } }], 'tool_use');
    return sseResponse([{ type: 'text', text: 'Final managed answer.' }]);
  };

  const runtime = createAnthropicProxyRuntime({ config, fetchImpl, exposeControlRoutes: false });
  const server = createManagedHttpServer({ handler: runtime.handle, config: runtime.config });
  const base = await server.start();
  t.after(() => server.stop());

  const started = Date.now();
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'news' }], tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }] }),
  });
  const reader = response.body.getReader();
  const first = await reader.read();
  const firstElapsed = Date.now() - started;
  const firstText = Buffer.from(first.value).toString('utf8');
  assert.ok(firstElapsed < 120, `first Anthropic event arrived too late: ${firstElapsed}ms`);
  assert.match(firstText, /event: message_start/);
  assert.match(firstText, /event: content_block_start/);
  assert.match(firstText, /event: content_block_delta/);
  assert.doesNotMatch(firstText, /event: ping/);

  const chunks = [firstText];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(Buffer.from(next.value).toString('utf8'));
  }
  const all = chunks.join('');
  assert.equal(count(all, /event: message_start/g), 1);
  assert.equal(count(all, /event: message_stop/g), 1);
  assert.match(all, /Final managed answer/);
  assert.match(all, /"type":"content_block_start","index":1/);
  assert.equal(count(all, /"type":"content_block_stop","index":0/g), 1);
});

test('managed stream emits periodic valid text deltas before a long WebSearch item completes', async (t) => {
  let vllmCalls = 0;
  const config = { ...loadAnthropicConfig({
    PROXY_HOST: '127.0.0.1', VLLM_BASE_URL: 'http://vllm:8001', VLLM_API_KEY: 'vllm', VLLM_CC_PROXY_API_KEY: 'client',
    CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED: 'true', SEARXNG_BASE_URL: 'http://searxng:8080',
    MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS: '25', HEARTBEAT_INTERVAL_MS: '60000',
    UPSTREAM_IDLE_TIMEOUT_MS: '5000', TOTAL_GENERATION_TIMEOUT_MS: '5000', RECOVERY_TIMEOUT_MS: '5000',
    MAX_TOTAL_BUFFERED_BYTES: '1048576', MAX_RESPONSE_BUFFER_BYTES: '1048576',
  }), port: 0 };
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.startsWith('http://searxng:8080/')) {
      await sleep(170);
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    vllmCalls += 1;
    if (vllmCalls === 1) return sseResponse([{ type: 'tool_use', id: 'search-id', name: 'WebSearch', input: { query: 'slow' } }], 'tool_use');
    return sseResponse([{ type: 'text', text: 'done' }]);
  };
  const runtime = createAnthropicProxyRuntime({ config, fetchImpl, exposeControlRoutes: false });
  const server = createManagedHttpServer({ handler: runtime.handle, config: runtime.config });
  const base = await server.start();
  t.after(() => server.stop());

  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'news' }], tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }] }),
  });
  const reader = response.body.getReader();
  let beforeCompletion = '';
  const deadline = Date.now() + 130;
  while (Date.now() < deadline) {
    const result = await Promise.race([reader.read(), sleep(50).then(() => null)]);
    if (result?.value) beforeCompletion += Buffer.from(result.value).toString('utf8');
  }
  assert.ok(count(beforeCompletion, /"type":"text_delta"/g) >= 3, beforeCompletion);
  await reader.cancel();
});

test('managed stream splicing preserves a final Claude Code Tool Call with shifted block indexes', () => {
  const raw = Buffer.from(anthropicSse([{ type: 'tool_use', id: 'bash-id', name: 'Bash', input: { command: 'pwd' } }], 'tool_use'));
  const all = createManagedAnthropicStreamStart({ requestId: 'req', model: 'm' }) + spliceManagedAnthropicStream(raw).toString('utf8');
  assert.equal(count(all, /event: message_start/g), 1);
  assert.equal(count(all, /event: message_stop/g), 1);
  assert.match(all, /"type":"content_block_start","index":1/);
  assert.match(all, /"type":"tool_use","id":"bash-id","name":"Bash"/);
  assert.match(all, /"type":"content_block_delta","index":1/);
  assert.match(all, /"type":"content_block_stop","index":1/);
  assert.doesNotMatch(all, /m-upstream/);
});

test('managed stream closes its progress block before a streamed upstream error', async (t) => {
  const config = { ...loadAnthropicConfig({
    PROXY_HOST: '127.0.0.1', VLLM_BASE_URL: 'http://vllm:8001', VLLM_API_KEY: 'vllm', VLLM_CC_PROXY_API_KEY: 'client',
    CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED: 'true', SEARXNG_BASE_URL: 'http://searxng:8080',
    MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS: '25', MAX_RECOVERY_ATTEMPTS: '0',
    TOTAL_GENERATION_TIMEOUT_MS: '5000', MAX_TOTAL_BUFFERED_BYTES: '1048576', MAX_RESPONSE_BUFFER_BYTES: '1048576',
  }), port: 0 };
  const runtime = createAnthropicProxyRuntime({
    config,
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'bad upstream' } }), { status: 400, headers: { 'content-type': 'application/json' } }),
    exposeControlRoutes: false,
  });
  const server = createManagedHttpServer({ handler: runtime.handle, config: runtime.config });
  const base = await server.start();
  t.after(() => server.stop());

  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'news' }], tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }] }),
  });
  const all = await response.text();
  assert.equal(response.status, 200);
  assert.equal(count(all, /event: message_start/g), 1);
  assert.equal(count(all, /"type":"content_block_stop","index":0/g), 1);
  assert.match(all, /event: error/);
  assert.match(all, /upstream_http_error/);
});

test('Anthropic config exposes the managed stream progress interval', () => {
  const config = loadAnthropicConfig({ MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS: '12000' });
  assert.equal(config.managedWebStreamProgressIntervalMs, 12000);
});
