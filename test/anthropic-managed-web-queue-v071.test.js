import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnthropicProxyRuntime, loadAnthropicConfig } from '../apps/vllm-cc-proxy/server.js';
import { createAnthropicManagedWebToolsFetch } from '../packages/anthropic/managed-web-tools.js';
import { createManagedHttpServer } from '../packages/server/create-proxy-server.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function jsonMessage(text) {
  return new Response(JSON.stringify({
    id: 'm-json', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn',
    content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function managedConfig(overrides = {}) {
  return {
    managedWebSearchEnabled: true,
    managedWebSearchToolNames: ['WebSearch'],
    managedWebFetchEnabled: true,
    managedWebFetchToolNames: ['WebFetch'],
    managedWebToolsThink: false,
    managedWebToolsMaxBatch: 8,
    webSearchMaxParallel: 2,
    webFetchMaxParallel: 2,
    searxngBaseUrl: 'http://searxng:8080',
    searxngApiKey: '', searxngTimeoutMs: 1000, searxngMaxUses: 8,
    searxngMaxResults: 3, searxngMaxResultBytes: 4096, searxngMaxResponseBytes: 1024 * 1024,
    searxngMaxSnippetChars: 120, searxngMaxTitleChars: 300, searxngMaxQueryChars: 1024,
    searxngLanguage: 'all', searxngCategories: ['general'], searxngSafeSearch: 0,
    webFetchTimeoutMs: 1000, webFetchMaxUses: 8, webFetchMaxRedirects: 2,
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

test('homogeneous parallel WebSearch calls are queued internally and report each completion immediately', async () => {
  const progress = [];
  const vllmBodies = [];
  let activeSearches = 0;
  let peakSearches = 0;
  let slowFinished = false;

  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('http://searxng:8080/')) {
      const query = new URL(target).searchParams.get('q');
      activeSearches += 1;
      peakSearches = Math.max(peakSearches, activeSearches);
      await sleep(query === 'slow' ? 100 : 10);
      activeSearches -= 1;
      if (query === 'slow') slowFinished = true;
      return new Response(JSON.stringify({ results: [{ title: query, url: `https://example.com/${query}`, content: `${query} evidence` }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }

    vllmBodies.push(JSON.parse(init.body));
    if (vllmBodies.length === 1) {
      return sseResponse([
        { type: 'tool_use', id: 'slow-id', name: 'WebSearch', input: { query: 'slow' } },
        { type: 'tool_use', id: 'fast-id', name: 'WebSearch', input: { query: 'fast' } },
      ], 'tool_use');
    }
    return sseResponse([{ type: 'text', text: 'Batch search complete.' }]);
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, managedConfig());
  const final = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebSearch' }] }),
    onManagedProgress(event) {
      progress.push({ ...event, slowFinished });
    },
  });

  assert.match(await final.text(), /Batch search complete/);
  assert.equal(peakSearches, 2);
  const completedProgress = progress.filter((event) => event.phase === 'completed');
  assert.deepEqual(completedProgress.map((event) => event.toolUseId), ['fast-id', 'slow-id']);
  assert.equal(completedProgress[0].slowFinished, false);
  assert.deepEqual(completedProgress.map((event) => [event.completed, event.total]), [[1, 2], [2, 2]]);
  assert.deepEqual(progress.filter((event) => event.phase === 'started').map((event) => event.toolUseId), ['slow-id', 'fast-id']);

  const toolResults = vllmBodies[1].messages.at(-1).content;
  assert.deepEqual(toolResults.map((item) => item.tool_use_id), ['slow-id', 'fast-id']);
  assert.ok(toolResults.every((item) => item.type === 'tool_result' && item.is_error === false));
});

test('homogeneous parallel WebFetch calls remain proxy-managed and preserve tool ids', async () => {
  const vllmBodies = [];
  const progress = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://1.1.1.1/a' || target === 'https://1.1.1.1/b') {
      await sleep(target.endsWith('/a') ? 40 : 5);
      return new Response(`<html><title>${target.at(-1)}</title><body><p>Evidence ${target.at(-1)}</p></body></html>`, {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    }
    vllmBodies.push(JSON.parse(init.body));
    const body = vllmBodies.at(-1);
    if (vllmBodies.length === 1) {
      return sseResponse([
        { type: 'tool_use', id: 'fetch-a', name: 'WebFetch', input: { url: 'https://1.1.1.1/a', prompt: 'read a' } },
        { type: 'tool_use', id: 'fetch-b', name: 'WebFetch', input: { url: 'https://1.1.1.1/b', prompt: 'read b' } },
      ], 'tool_use');
    }
    if (String(body.system).includes('chunk reader')) return jsonMessage(JSON.stringify({ relevant: true, summary: 'evidence', facts: [], uncertainties: [] }));
    if (String(body.system).includes('document synthesizer')) return jsonMessage('document summary');
    return sseResponse([{ type: 'text', text: 'Batch fetch complete.' }]);
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, managedConfig(), { resolveHost: async () => ['1.1.1.1'] });
  const final = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }] }),
    onManagedProgress(event) { progress.push(event); },
  });

  assert.match(await final.text(), /Batch fetch complete/);
  assert.deepEqual(progress.filter((event) => event.phase === 'completed').map((event) => event.toolUseId), ['fetch-b', 'fetch-a']);
  assert.deepEqual(progress.filter((event) => event.phase === 'started').map((event) => event.toolUseId), ['fetch-a', 'fetch-b']);
  const continuation = vllmBodies.find((body) => Array.isArray(body.messages?.at(-1)?.content) && body.messages.at(-1).content.length === 2);
  assert.ok(continuation);
  assert.deepEqual(continuation.messages.at(-1).content.map((item) => item.tool_use_id), ['fetch-a', 'fetch-b']);
  assert.ok(vllmBodies.slice(1).every((body) => body.think === false && body.chat_template_kwargs.enable_thinking === false));
});

test('streaming gateway emits a managed Anthropic stream envelope before batch completion', async (t) => {
  let vllmCalls = 0;
  const config = { ...loadAnthropicConfig({
    PROXY_HOST: '127.0.0.1',
    VLLM_BASE_URL: 'http://vllm:8001', VLLM_API_KEY: 'vllm', VLLM_CC_PROXY_API_KEY: 'client',
    CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED: 'true', SEARXNG_BASE_URL: 'http://searxng:8080',
    WEBSEARCH_MAX_PARALLEL: '2', MANAGED_WEB_TOOLS_MAX_BATCH: '8',
    HEARTBEAT_INTERVAL_MS: '60000', UPSTREAM_IDLE_TIMEOUT_MS: '5000',
    TOTAL_GENERATION_TIMEOUT_MS: '5000', RECOVERY_TIMEOUT_MS: '5000',
    MAX_TOTAL_BUFFERED_BYTES: '1048576', MAX_RESPONSE_BUFFER_BYTES: '1048576',
  }), port: 0 };
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('http://searxng:8080/')) {
      const query = new URL(target).searchParams.get('q');
      await sleep(query === 'slow' ? 250 : 20);
      return new Response(JSON.stringify({ results: [{ title: query, url: `https://example.com/${query}`, content: query }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmCalls += 1;
    if (vllmCalls === 1) return sseResponse([
      { type: 'tool_use', id: 'slow-id', name: 'WebSearch', input: { query: 'slow' } },
      { type: 'tool_use', id: 'fast-id', name: 'WebSearch', input: { query: 'fast' } },
    ], 'tool_use');
    return sseResponse([{ type: 'text', text: 'Gateway batch complete.' }]);
  };

  const runtime = createAnthropicProxyRuntime({ config, fetchImpl, exposeControlRoutes: false });
  const server = createManagedHttpServer({ handler: runtime.handle, config: runtime.config });
  const base = await server.start();
  t.after(() => server.stop());

  const started = Date.now();
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'search' }], tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }] }),
  });
  const headersElapsed = Date.now() - started;
  assert.ok(headersElapsed < 180, `headers arrived too late: ${headersElapsed}ms`);
  const reader = response.body.getReader();
  const first = await reader.read();
  const firstText = Buffer.from(first.value).toString('utf8');
  assert.match(firstText, /event: message_start/);
  assert.match(firstText, /event: content_block_start/);
  assert.match(firstText, /"type":"text_delta"/);

  const chunks = [firstText];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(Buffer.from(next.value).toString('utf8'));
  }
  assert.match(chunks.join(''), /Gateway batch complete/);
  const metrics = runtime.renderMetrics();
  assert.match(metrics, /vllm_cc_proxy_managed_web_search_executions_total 2/);
  assert.match(metrics, /vllm_cc_proxy_managed_web_tool_items_completed_total 2/);
  assert.match(metrics, /vllm_cc_proxy_managed_web_tool_progress_pings_total 2/);
  assert.match(metrics, /vllm_cc_proxy_managed_stream_splices_total 1/);
});

test('Anthropic config exposes managed batch and bounded parallel queue defaults', () => {
  const loaded = loadAnthropicConfig({
    MANAGED_WEB_TOOLS_MAX_BATCH: '6',
    WEBSEARCH_MAX_PARALLEL: '3',
    WEBFETCH_MAX_PARALLEL: '1',
  });
  assert.equal(loaded.managedWebToolsMaxBatch, 6);
  assert.equal(loaded.webSearchMaxParallel, 3);
  assert.equal(loaded.webFetchMaxParallel, 1);
});
