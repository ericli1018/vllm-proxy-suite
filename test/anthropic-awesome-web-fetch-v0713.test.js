import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnthropicManagedWebToolsFetch } from '../packages/anthropic/managed-web-tools.js';
import { createAnthropicProxyRuntime, loadAnthropicConfig } from '../apps/vllm-cc-proxy/server.js';
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

function jsonMessage(text) {
  return new Response(JSON.stringify({
    id: 'm-json', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn',
    content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 20 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function config(overrides = {}) {
  return {
    managedWebSearchEnabled: false,
    managedWebSearchToolNames: ['WebSearch'],
    managedWebFetchEnabled: true,
    managedWebFetchToolNames: ['WebFetch'],
    managedWebToolsThink: false,
    managedWebToolsMaxBatch: 8,
    webFetchMaxParallel: 2,
    webFetchTimeoutMs: 1000,
    webFetchProbeTimeoutMs: 500,
    webFetchMaxUses: 3,
    webFetchMaxRedirects: 3,
    webFetchMaxDownloadBytes: 1024 * 1024,
    webFetchMaxExtractedChars: 100000,
    webFetchMaxPromptChars: 2000,
    webFetchReaderChunkChars: 1000,
    webFetchReaderChunkOverlapChars: 10,
    webFetchReaderMaxChunks: 8,
    webFetchPdfPagesPerChunk: 1,
    webFetchPdfMaxPages: 20,
    webFetchPdfExtractTimeoutMs: 1000,
    webFetchReaderMaxTokens: 400,
    webFetchSynthesisMaxTokens: 800,
    webFetchSynthesisInputMaxChars: 100000,
    webFetchResultMaxBytes: 16384,
    webFetchModelTimeoutMs: 1000,
    webFetchModelResponseMaxBytes: 1024 * 1024,
    webFetchHtmlProvider: 'awesome-web-fetch',
    awesomeWebFetchBaseUrl: 'http://awesome-web-fetch:3000',
    awesomeWebFetchPath: '/',
    awesomeWebFetchApiKey: 'sidecar-secret',
    awesomeWebFetchTimeoutMs: 1000,
    awesomeWebFetchMaxResponseBytes: 1024 * 1024,
    ...overrides,
  };
}

function modelResponse(vllmBodies, init, toolInput, finalText = 'Final answer.') {
  vllmBodies.push(JSON.parse(init.body));
  const body = vllmBodies.at(-1);
  if (vllmBodies.length === 1) return sseResponse([{ type: 'tool_use', id: 'wf1', name: 'WebFetch', input: toolInput }], 'tool_use');
  if (String(body.system).includes('chunk reader')) return jsonMessage(JSON.stringify({ relevant: true, summary: 'evidence', facts: [], uncertainties: [] }));
  if (String(body.system).includes('document synthesizer')) return jsonMessage('Synthesized evidence.');
  return sseResponse([{ type: 'text', text: finalText }]);
}

test('Anthropic config exposes content-aware awesome-web-fetch settings', () => {
  const loaded = loadAnthropicConfig({
    WEBFETCH_HTML_PROVIDER: 'awesome-web-fetch',
    WEBFETCH_PROBE_TIMEOUT_MS: '4321',
    AWESOME_WEB_FETCH_BASE_URL: 'http://awesome-web-fetch:3000/',
    AWESOME_WEB_FETCH_PATH: '/fetch',
    AWESOME_WEB_FETCH_API_KEY: 'secret',
    AWESOME_WEB_FETCH_TIMEOUT_MS: '8765',
    AWESOME_WEB_FETCH_MAX_RESPONSE_BYTES: '7654321',
  });
  assert.equal(loaded.webFetchHtmlProvider, 'awesome-web-fetch');
  assert.equal(loaded.webFetchProbeTimeoutMs, 4321);
  assert.equal(loaded.awesomeWebFetchBaseUrl, 'http://awesome-web-fetch:3000');
  assert.equal(loaded.awesomeWebFetchPath, '/fetch');
  assert.equal(loaded.awesomeWebFetchApiKey, 'secret');
  assert.equal(loaded.awesomeWebFetchTimeoutMs, 8765);
  assert.equal(loaded.awesomeWebFetchMaxResponseBytes, 7654321);
});

test('HTML WebFetch uses awesome-web-fetch metadata and preserves Reader/Synthesizer flow', async () => {
  const vllmBodies = [];
  let probes = 0;
  let sidecarCalls = 0;
  let directGets = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://example.com/article' && init.method === 'HEAD') {
      probes += 1;
      return new Response('', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (target === 'https://example.com/article') {
      directGets += 1;
      return new Response('must not use direct GET');
    }
    if (target === 'http://awesome-web-fetch:3000/') {
      sidecarCalls += 1;
      assert.equal(init.method, 'POST');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer sidecar-secret');
      assert.deepEqual(JSON.parse(init.body), { urls: ['https://example.com/article'] });
      return new Response(JSON.stringify([{
        page_content: 'Rendered browser content with fact 42.',
        metadata: {
          source: 'https://example.com/article',
          final_url: 'https://example.com/article?rendered=1',
          title: 'Rendered Article',
          content_type: 'text/html',
          status_code: 200,
          browser_rendered: true,
        },
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return modelResponse(vllmBodies, init, { url: 'https://example.com/article', prompt: 'Find fact 42' }, 'HTML final.');
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config(), { resolveHost: async () => ['1.1.1.1'] });
  const final = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }] }),
  });
  assert.match(await final.text(), /HTML final/);
  assert.equal(probes, 1);
  assert.equal(sidecarCalls, 1);
  assert.equal(directGets, 0);
  const continuation = vllmBodies.at(-1);
  const payload = JSON.parse(continuation.messages.at(-1).content[0].content);
  assert.equal(payload.provider, 'awesome-web-fetch');
  assert.equal(payload.url, 'https://example.com/article?rendered=1');
  assert.equal(payload.title, 'Rendered Article');
  assert.equal(payload.content_type, 'text/html');
});

test('PDF URL bypasses awesome-web-fetch and keeps page-aware internal extraction', async () => {
  const vllmBodies = [];
  let sidecarCalls = 0;
  let probes = 0;
  let documentGets = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === 'http://awesome-web-fetch:3000/') {
      sidecarCalls += 1;
      throw new Error('sidecar must not be used for PDF');
    }
    if (target === 'https://example.com/report.pdf' && init.method === 'HEAD') {
      probes += 1;
      return new Response('', { headers: { 'content-type': 'application/pdf' } });
    }
    if (target === 'https://example.com/report.pdf') {
      documentGets += 1;
      return new Response(Buffer.from('%PDF-1.7 fake'), { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    return modelResponse(vllmBodies, init, { url: 'https://example.com/report.pdf', prompt: 'Read PDF' }, 'PDF final.');
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config(), {
    resolveHost: async () => ['1.1.1.1'],
    pdfTextExtractor: async () => 'Page one\fPage two',
  });
  const final = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }] }),
  });
  assert.match(await final.text(), /PDF final/);
  assert.equal(sidecarCalls, 0);
  assert.equal(probes, 0);
  assert.equal(documentGets, 1);
  const payload = JSON.parse(vllmBodies.at(-1).messages.at(-1).content[0].content);
  assert.equal(payload.provider, 'internal');
  assert.equal(payload.pages_total, 2);
});

test('text/plain probe routes to internal fetch instead of browser sidecar', async () => {
  const vllmBodies = [];
  let sidecarCalls = 0;
  let probes = 0;
  let documentGets = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === 'http://awesome-web-fetch:3000/') {
      sidecarCalls += 1;
      throw new Error('sidecar must not be used for text');
    }
    if (target === 'https://example.com/raw' && init.method === 'HEAD') {
      probes += 1;
      return new Response('', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (target === 'https://example.com/raw') {
      documentGets += 1;
      return new Response('Plain text evidence.', { headers: { 'content-type': 'text/plain' } });
    }
    return modelResponse(vllmBodies, init, { url: 'https://example.com/raw', prompt: 'Read text' }, 'Text final.');
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config(), { resolveHost: async () => ['1.1.1.1'] });
  const final = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }] }),
  });
  assert.match(await final.text(), /Text final/);
  assert.equal(sidecarCalls, 0);
  assert.equal(probes, 1);
  assert.equal(documentGets, 1);
  const payload = JSON.parse(vllmBodies.at(-1).messages.at(-1).content[0].content);
  assert.equal(payload.provider, 'internal');
  assert.equal(payload.content_type, 'text/plain');
});

test('sidecar non-HTML metadata reroutes to internal exactly once without provider loop', async () => {
  const vllmBodies = [];
  let sidecarCalls = 0;
  let internalGets = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://example.com/download' && init.method === 'HEAD') {
      return new Response('', { headers: { 'content-type': 'text/html' } });
    }
    if (target === 'http://awesome-web-fetch:3000/') {
      sidecarCalls += 1;
      return new Response(JSON.stringify([{
        page_content: 'Browser noticed a download.',
        metadata: {
          source: 'https://example.com/download',
          final_url: 'https://example.com/report.pdf',
          title: 'Report',
          content_type: 'application/pdf',
          status_code: 200,
          browser_rendered: true,
        },
      }]), { headers: { 'content-type': 'application/json' } });
    }
    if (target === 'https://example.com/report.pdf') {
      internalGets += 1;
      return new Response(Buffer.from('%PDF-1.7 fake'), { headers: { 'content-type': 'application/pdf' } });
    }
    return modelResponse(vllmBodies, init, { url: 'https://example.com/download', prompt: 'Read report' }, 'Rerouted final.');
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config(), {
    resolveHost: async () => ['1.1.1.1'],
    pdfTextExtractor: async () => 'PDF page',
  });
  const final = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }] }),
  });
  assert.match(await final.text(), /Rerouted final/);
  assert.equal(sidecarCalls, 1);
  assert.equal(internalGets, 1);
  const payload = JSON.parse(vllmBodies.at(-1).messages.at(-1).content[0].content);
  assert.equal(payload.provider, 'internal');
  assert.equal(payload.content_type, 'application/pdf');
});

test('awesome-web-fetch failure does not silently fall back to direct HTML GET', async () => {
  const vllmBodies = [];
  let sidecarCalls = 0;
  let directGets = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://example.com/blocked' && init.method === 'HEAD') {
      return new Response('', { headers: { 'content-type': 'text/html' } });
    }
    if (target === 'https://example.com/blocked') {
      directGets += 1;
      return new Response('<html>unexpected fallback</html>', { headers: { 'content-type': 'text/html' } });
    }
    if (target === 'http://awesome-web-fetch:3000/') {
      sidecarCalls += 1;
      return new Response(JSON.stringify({ error: 'browser unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return modelResponse(vllmBodies, init, { url: 'https://example.com/blocked', prompt: 'Read page' }, 'Handled browser failure.');
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config(), { resolveHost: async () => ['1.1.1.1'] });
  const final = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }] }),
  });
  assert.match(await final.text(), /Handled browser failure/);
  assert.equal(sidecarCalls, 1);
  assert.equal(directGets, 0);
  const toolResult = vllmBodies[1].messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /awesome_web_fetch_http_503/);
});



test('sidecar private final_url is rejected before any follow-up fetch', async () => {
  const vllmBodies = [];
  let sidecarCalls = 0;
  let privateGets = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://example.com/public' && init.method === 'HEAD') {
      return new Response('', { headers: { 'content-type': 'text/html' } });
    }
    if (target === 'http://awesome-web-fetch:3000/') {
      sidecarCalls += 1;
      return new Response(JSON.stringify([{
        page_content: 'Redirected content.',
        metadata: {
          source: 'https://example.com/public', final_url: 'http://127.0.0.1/private',
          title: 'Unsafe', content_type: 'text/html', status_code: 200, browser_rendered: true,
        },
      }]), { headers: { 'content-type': 'application/json' } });
    }
    if (target === 'http://127.0.0.1/private') {
      privateGets += 1;
      return new Response('must not fetch');
    }
    return modelResponse(vllmBodies, init, { url: 'https://example.com/public', prompt: 'Read page' }, 'Handled unsafe redirect.');
  };
  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config(), {
    resolveHost: async (hostname) => [hostname === '127.0.0.1' ? '127.0.0.1' : '1.1.1.1'],
  });
  const final = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }] }),
  });
  assert.match(await final.text(), /Handled unsafe redirect/);
  assert.equal(sidecarCalls, 1);
  assert.equal(privateGets, 0);
  const toolResult = vllmBodies[1].messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /managed_webfetch_private_address/);
});

test('Gateway exports awesome-web-fetch provider metrics without exposing the managed Tool Call', async (t) => {
  const vllmBodies = [];
  let sidecarCalls = 0;
  const config = loadAnthropicConfig({
    PROXY_HOST: '127.0.0.1', PROXY_PORT: '0', VLLM_BASE_URL: 'http://vllm:8001',
    VLLM_API_KEY: 'vllm', VLLM_CC_PROXY_API_KEY: 'client',
    CLAUDE_CODE_WEBFETCH_BRIDGE_ENABLED: 'true',
    WEBFETCH_HTML_PROVIDER: 'awesome-web-fetch',
    AWESOME_WEB_FETCH_BASE_URL: 'http://awesome-web-fetch:3000',
    AWESOME_WEB_FETCH_API_KEY: 'sidecar-secret',
    WEBFETCH_READER_CHUNK_CHARS: '1000',
    HEARTBEAT_INTERVAL_MS: '60000', TOTAL_GENERATION_TIMEOUT_MS: '10000', RECOVERY_TIMEOUT_MS: '10000',
    MAX_TOTAL_BUFFERED_BYTES: '1048576', MAX_RESPONSE_BUFFER_BYTES: '1048576',
  });
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://1.1.1.1/article' && init.method === 'HEAD') {
      return new Response('', { headers: { 'content-type': 'text/html' } });
    }
    if (target === 'http://awesome-web-fetch:3000/') {
      sidecarCalls += 1;
      return new Response(JSON.stringify([{
        page_content: 'Browser rendered evidence 42.',
        metadata: {
          source: 'https://1.1.1.1/article', final_url: 'https://1.1.1.1/article',
          title: 'Browser Article', content_type: 'text/html', status_code: 200, browser_rendered: true,
        },
      }]), { headers: { 'content-type': 'application/json' } });
    }
    return modelResponse(vllmBodies, init, { url: 'https://1.1.1.1/article', prompt: 'find evidence' }, 'Browser final 42.');
  };
  const runtime = createAnthropicProxyRuntime({ config, fetchImpl, exposeControlRoutes: false });
  const server = createManagedHttpServer({ handler: runtime.handle, config: runtime.config });
  const base = await server.start();
  t.after(() => server.stop());
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true, max_tokens: 1024, messages: [{ role: 'user', content: 'read' }],
      tools: [{ name: 'WebFetch', input_schema: { type: 'object' } }],
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Browser final 42/);
  assert.doesNotMatch(text, /"name":"WebFetch"/);
  assert.equal(sidecarCalls, 1);
  const metrics = runtime.renderMetrics();
  assert.match(metrics, /vllm_cc_proxy_awesome_web_fetch_executions_total 1/);
  assert.match(metrics, /vllm_cc_proxy_awesome_web_fetch_reroutes_total 0/);
});
