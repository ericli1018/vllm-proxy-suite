import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildManagedNoThinkRequest,
  chunkExtractedDocument,
  createAnthropicManagedWebToolsFetch,
  extractHtmlDocument,
  isPublicAddress,
} from '../packages/anthropic/managed-web-tools.js';
import { loadAnthropicConfig } from '../apps/vllm-cc-proxy/server.js';

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

function jsonMessage(text) {
  return new Response(JSON.stringify({
    id: 'm-json', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn',
    content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 20 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function sseResponse(content, stopReason = 'end_turn') {
  return new Response(anthropicSse(content, stopReason), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function config(overrides = {}) {
  return {
    managedWebSearchEnabled: true,
    managedWebSearchToolNames: ['WebSearch'],
    managedWebFetchEnabled: true,
    managedWebFetchToolNames: ['WebFetch'],
    managedWebToolsThink: false,
    searxngBaseUrl: 'http://searxng:8080',
    searxngApiKey: '', searxngTimeoutMs: 1000, searxngMaxUses: 3,
    searxngMaxResults: 3, searxngMaxResultBytes: 4096, searxngMaxResponseBytes: 1024 * 1024,
    searxngMaxSnippetChars: 120, searxngMaxTitleChars: 200, searxngMaxQueryChars: 1024,
    searxngLanguage: 'all', searxngCategories: ['general'], searxngSafeSearch: 0,
    webFetchTimeoutMs: 1000, webFetchMaxUses: 3, webFetchMaxRedirects: 3,
    webFetchMaxDownloadBytes: 1024 * 1024, webFetchMaxExtractedChars: 100000,
    webFetchReaderChunkChars: 120, webFetchReaderChunkOverlapChars: 10, webFetchReaderMaxChunks: 8,
    webFetchPdfPagesPerChunk: 2, webFetchPdfMaxPages: 20,
    webFetchReaderMaxTokens: 400, webFetchSynthesisMaxTokens: 800,
    webFetchResultMaxBytes: 16384, webFetchMaxPromptChars: 2000,
    ...overrides,
  };
}

test('managed no-think request sets both vLLM controls and removes tools', () => {
  const body = buildManagedNoThinkRequest({
    model: 'ornith', stream: true, max_tokens: 4096,
    chat_template_kwargs: { custom: 'keep', enable_thinking: true },
    tools: [{ name: 'WebSearch' }], tool_choice: { type: 'auto' },
  }, { system: 'reader', prompt: 'read this', maxTokens: 321 });
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.deepEqual(body.chat_template_kwargs, { custom: 'keep', enable_thinking: false });
  assert.equal(body.max_tokens, 321);
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
  assert.equal(body.system, 'reader');
});

test('HTML extraction removes active content and produces bounded structural chunks', () => {
  const doc = extractHtmlDocument('<html><head><title>News</title><script>ignore()</script></head><body><h1>Headline</h1><p>Alpha beta gamma.</p><p>Delta epsilon zeta.</p></body></html>', 'https://example.com/news');
  assert.equal(doc.title, 'News');
  assert.doesNotMatch(doc.text, /ignore/);
  assert.match(doc.text, /Headline/);
  const chunks = chunkExtractedDocument(doc, config({ webFetchReaderChunkChars: 25, webFetchReaderChunkOverlapChars: 5 }));
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].location.kind, 'section');
  assert.ok(chunks.every((chunk) => chunk.text.length <= 30));
});

test('public address classifier rejects local, private, link-local, and metadata ranges', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', 'fe80::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('WebSearch continuation is sent to vLLM with think false', async () => {
  const vllmBodies = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('http://searxng:8080/')) return new Response(JSON.stringify({ results: [{ title: 'R', url: 'https://example.com/r', content: 'result' }] }), { status: 200 });
    vllmBodies.push(JSON.parse(init.body));
    if (vllmBodies.length === 1) return sseResponse([{ type: 'tool_use', id: 's1', name: 'WebSearch', input: { query: 'q' } }], 'tool_use');
    return sseResponse([{ type: 'text', text: 'done' }]);
  };
  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config(), { resolveHost: async () => ['1.1.1.1'] });
  await (await wrapped('http://vllm:8001/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebSearch' }] }) })).text();
  assert.equal(vllmBodies[1].think, false);
  assert.equal(vllmBodies[1].chat_template_kwargs.enable_thinking, false);
});

test('managed WebFetch reads HTML chunks, synthesizes evidence, and hides WebFetch from Claude Code', async () => {
  const vllmBodies = [];
  let documentFetches = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://example.com/article') {
      documentFetches += 1;
      return new Response('<html><head><title>Article</title></head><body><h1>A</h1><p>First factual paragraph with date 2026-07-31.</p><h2>B</h2><p>Second factual paragraph with number 35.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    vllmBodies.push(JSON.parse(init.body));
    const body = vllmBodies.at(-1);
    if (vllmBodies.length === 1) return sseResponse([{ type: 'tool_use', id: 'wf1', name: 'WebFetch', input: { url: 'https://example.com/article', prompt: 'Extract date and number' } }], 'tool_use');
    if (String(body.system).includes('chunk reader')) {
      return jsonMessage(JSON.stringify({ relevant: true, summary: 'Chunk fact', facts: [{ claim: 'fact', evidence: 'evidence', location: 'chunk' }], uncertainties: [] }));
    }
    if (String(body.system).includes('document synthesizer')) return jsonMessage('Article summary: 2026-07-31 and 35.');
    return sseResponse([{ type: 'text', text: 'Final answer from fetched source.' }]);
  };

  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config({ webFetchReaderChunkChars: 60 }), { resolveHost: async () => ['1.1.1.1'] });
  const final = await wrapped('http://vllm:8001/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', stream: true, max_tokens: 1024, messages: [{ role: 'user', content: 'read it' }], tools: [{ name: 'WebFetch' }] }),
  });
  const text = await final.text();
  assert.match(text, /Final answer/);
  assert.doesNotMatch(text, /"name":"WebFetch"/);
  assert.equal(documentFetches, 1);
  const readerBodies = vllmBodies.filter((body) => String(body.system).includes('chunk reader'));
  assert.ok(readerBodies.length >= 2);
  assert.ok(readerBodies.every((body) => body.stream === false && body.think === false && body.chat_template_kwargs.enable_thinking === false));
  const synth = vllmBodies.find((body) => String(body.system).includes('document synthesizer'));
  assert.equal(synth.think, false);
  const continuation = vllmBodies.at(-1);
  assert.equal(continuation.think, false);
  const result = JSON.parse(continuation.messages.at(-1).content[0].content);
  assert.equal(result.type, 'managed_webfetch_result');
  assert.equal(result.url, 'https://example.com/article');
  assert.match(result.summary, /2026-07-31/);
  assert.equal(final.headers.get('x-vllm-proxy-managed-webfetch-uses'), '1');
});

test('missing WebFetch parameters become an internal error tool_result instead of a client-visible invalid call', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init = {}) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) return sseResponse([{ type: 'tool_use', id: 'wf1', name: 'WebFetch', input: {} }], 'tool_use');
    return sseResponse([{ type: 'text', text: 'Recovered from missing fetch parameters.' }]);
  };
  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config(), { resolveHost: async () => ['1.1.1.1'] });
  const final = await wrapped('http://vllm:8001/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }] }) });
  const text = await final.text();
  assert.match(text, /Recovered/);
  assert.doesNotMatch(text, /"name":"WebFetch"/);
  const toolResult = bodies[1].messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /missing_url|missing_prompt/);
});

test('Anthropic config exposes bounded WebFetch and internal no-thinking defaults', () => {
  const loaded = loadAnthropicConfig({
    CLAUDE_CODE_WEBFETCH_BRIDGE_ENABLED: 'true',
    CLAUDE_CODE_WEBFETCH_TOOL_NAMES: 'WebFetch,web_fetch',
    MANAGED_WEB_TOOLS_THINK: 'false',
    WEBFETCH_MAX_USES: '4', WEBFETCH_READER_CHUNK_CHARS: '9000', WEBFETCH_PDF_PAGES_PER_CHUNK: '2',
  });
  assert.equal(loaded.managedWebFetchEnabled, true);
  assert.deepEqual(loaded.managedWebFetchToolNames, ['WebFetch', 'web_fetch']);
  assert.equal(loaded.managedWebToolsThink, false);
  assert.equal(loaded.webFetchMaxUses, 4);
  assert.equal(loaded.webFetchReaderChunkChars, 9000);
  assert.equal(loaded.webFetchPdfPagesPerChunk, 2);
});

test('managed WebFetch groups extracted PDF pages and preserves page locations', async () => {
  const vllmBodies = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url) === 'https://example.com/report.pdf') {
      return new Response(Buffer.from('%PDF-1.7 fake'), { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    vllmBodies.push(JSON.parse(init.body));
    const body = vllmBodies.at(-1);
    if (vllmBodies.length === 1) return sseResponse([{ type: 'tool_use', id: 'pdf1', name: 'WebFetch', input: { url: 'https://example.com/report.pdf', prompt: 'Find page facts' } }], 'tool_use');
    if (String(body.system).includes('chunk reader')) return jsonMessage(JSON.stringify({ relevant: true, summary: 'pages', facts: [], uncertainties: [] }));
    if (String(body.system).includes('document synthesizer')) return jsonMessage('PDF summary.');
    return sseResponse([{ type: 'text', text: 'PDF done.' }]);
  };
  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config({ webFetchPdfPagesPerChunk: 2 }), {
    resolveHost: async () => ['1.1.1.1'],
    pdfTextExtractor: async () => 'Page one\fPage two\fPage three',
  });
  const final = await wrapped('http://vllm:8001/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }] }) });
  assert.match(await final.text(), /PDF done/);
  const readers = vllmBodies.filter((body) => String(body.system).includes('chunk reader'));
  assert.equal(readers.length, 2);
  assert.match(readers[0].messages[0].content, /"page_start":1/);
  assert.match(readers[0].messages[0].content, /"page_end":2/);
  assert.match(readers[1].messages[0].content, /"page_start":3/);
});

test('WebFetch revalidates every redirect and blocks a redirect to metadata address', async () => {
  let metadataFetches = 0;
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://example.com/start') return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    if (target.startsWith('http://169.254.169.254')) {
      metadataFetches += 1;
      return new Response('secret');
    }
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) return sseResponse([{ type: 'tool_use', id: 'wf1', name: 'WebFetch', input: { url: 'https://example.com/start', prompt: 'read' } }], 'tool_use');
    return sseResponse([{ type: 'text', text: 'Blocked unsafe redirect.' }]);
  };
  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config(), {
    resolveHost: async (host) => host === 'example.com' ? ['1.1.1.1'] : ['169.254.169.254'],
  });
  const final = await wrapped('http://vllm:8001/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }] }) });
  assert.match(await final.text(), /Blocked unsafe redirect/);
  assert.equal(metadataFetches, 0);
  assert.match(bodies[1].messages.at(-1).content[0].content, /private_address/);
});

test('mixed WebFetch and client tool response remains client-visible and performs no document fetch', async () => {
  let calls = 0;
  const wrapped = createAnthropicManagedWebToolsFetch(async () => {
    calls += 1;
    return sseResponse([
      { type: 'tool_use', id: 'wf1', name: 'WebFetch', input: { url: 'https://example.com', prompt: 'read' } },
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pwd' } },
    ], 'tool_use');
  }, config(), { resolveHost: async () => ['1.1.1.1'] });
  const final = await wrapped('http://vllm:8001/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [] }) });
  const text = await final.text();
  assert.equal(calls, 1);
  assert.match(text, /"name":"WebFetch"/);
  assert.match(text, /"name":"Bash"/);
});

test('PDF extraction ignores trailing empty form-feed pages', async () => {
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url) === 'https://example.com/trailing.pdf') return new Response(Buffer.from('%PDF-1.7 fake'), { status: 200, headers: { 'content-type': 'application/pdf' } });
    bodies.push(JSON.parse(init.body));
    const body = bodies.at(-1);
    if (bodies.length === 1) return sseResponse([{ type: 'tool_use', id: 'pdf1', name: 'WebFetch', input: { url: 'https://example.com/trailing.pdf', prompt: 'read' } }], 'tool_use');
    if (String(body.system).includes('chunk reader')) return jsonMessage(JSON.stringify({ relevant: true, summary: 'page', facts: [], uncertainties: [] }));
    if (String(body.system).includes('document synthesizer')) return jsonMessage('summary');
    return sseResponse([{ type: 'text', text: 'done' }]);
  };
  const wrapped = createAnthropicManagedWebToolsFetch(fetchImpl, config({ webFetchPdfPagesPerChunk: 1 }), {
    resolveHost: async () => ['1.1.1.1'],
    pdfTextExtractor: async () => 'Page one\fPage two\f',
  });
  await (await wrapped('http://vllm:8001/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [], tools: [{ name: 'WebFetch' }] }) })).text();
  const readers = bodies.filter((body) => String(body.system).includes('chunk reader'));
  assert.equal(readers.length, 2);
});
