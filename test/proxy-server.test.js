import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createProtocolProxyServer } from '../packages/server/create-proxy-server.js';
import { chatCompletionsAdapter } from '../packages/openai/chat-completions.js';
import { assertChatMessageOrdering, buildOpenAiRecoveryRequest, validateForcedToolRecovery } from '../packages/openai/recovery.js';
import { planNetworkRecovery } from '../packages/openai/tool-classifier.js';
import { loadCommonConfig } from '../packages/core/config.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function baseConfig(upstream) {
  return Object.freeze({
    ...loadCommonConfig({
      PROXY_API_KEY: 'client-secret',
      VLLM_API_KEY: 'vllm-secret',
      VLLM_BASE_URL: upstream,
      HEARTBEAT_INTERVAL_MS: '60000',
      UPSTREAM_IDLE_TIMEOUT_MS: '5000',
      SEMANTIC_STALL_TIMEOUT_MS: '5000',
      TOTAL_GENERATION_TIMEOUT_MS: '5000',
      RECOVERY_TIMEOUT_MS: '5000',
      MAX_TOTAL_BUFFERED_BYTES: '1048576',
      MAX_RESPONSE_BUFFER_BYTES: '1048576',
      LOOP_MIN_PATTERN_SIZE: '8',
    }),
    port: 0,
  });
}

function openAiGuardedRoute() {
  return {
    adapter: chatCompletionsAdapter,
    prepareRequest(body) {
      assertChatMessageOrdering(body?.messages);
      return structuredClone(body);
    },
    buildRecovery({ originalBody, reason, config }) {
      const plan = reason.kind === 'loop'
        ? planNetworkRecovery({ tools: originalBody.tools || [], context: originalBody.messages || [] })
        : { mode: 'none', candidateNames: [] };
      return {
        body: buildOpenAiRecoveryRequest(originalBody, { api: 'chat', reason: reason.reason, plan, config }),
        plan,
      };
    },
    validateRecovery(attempt, recovery) {
      return validateForcedToolRecovery(chatCompletionsAdapter.extractOutput(attempt.result), recovery.plan);
    },
  };
}

function createSuite(upstream) {
  return createProtocolProxyServer({
    name: 'test-openai',
    metricPrefix: 'test_openai',
    config: baseConfig(upstream),
    guardedRoutes: new Map([['/v1/chat/completions', openAiGuardedRoute()]]),
    allowPassthrough: (path) => path.startsWith('/v1/'),
    formatJsonError: (type, message, requestId, extra = {}) => ({
      error: { message, type, param: null, code: type, request_id: requestId, ...extra },
    }),
  });
}

test('proxy rejects missing auth and transparently forwards non-guarded /v1 paths', async (t) => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization });
    res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamUrl = await listen(upstream);
  const suite = createSuite(upstreamUrl);
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const denied = await fetch(`${proxyUrl}/v1/models`);
  assert.equal(denied.status, 401);

  const response = await fetch(`${proxyUrl}/v1/embeddings?x=1`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: '{"input":"x"}',
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-upstream'), 'yes');
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(seen[0], { url: '/v1/embeddings?x=1', method: 'POST', body: '{"input":"x"}', authorization: 'Bearer vllm-secret' });
});

test('guarded request discards looping first attempt and returns only recovery bytes', async (t) => {
  let attempts = 0;
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempts === 1) {
      res.end('data: {"choices":[{"index":0,"delta":{"reasoning":"Need evidence then act. Need evidence then act."}}]}\n\ndata: [DONE]\n\n');
    } else {
      res.end('data: {"choices":[{"index":0,"delta":{"content":"RECOVERED"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
  });
  const upstreamUrl = await listen(upstream);
  const suite = createSuite(upstreamUrl);
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'answer' }] }),
  });
  const text = await response.text();
  assert.equal(attempts, 2);
  assert.match(text, /RECOVERED/);
  assert.doesNotMatch(text, /Need evidence then act/);
  assert.equal(received[1].messages[0].role, 'system');
  assert.match(received[1].messages[0].content, /failed attempt is not task progress/i);
  assert.deepEqual(received[1].messages.slice(1), [{ role: 'user', content: 'answer' }]);
  assert.equal(received[1].messages.filter((message) => message.role === 'system').length, 1);
});

test('guarded Chat request rejects a system message outside index zero before upstream', async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamUrl = await listen(upstream);
  const suite = createSuite(upstreamUrl);
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'late policy' },
      ],
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(upstreamRequests, 0);
  const payload = await response.json();
  assert.equal(typeof payload.error.request_id, 'string');
  assert.deepEqual({ ...payload, error: { ...payload.error, request_id: '<request-id>' } }, {
    error: {
      message: 'System messages are only permitted at messages[0].',
      type: 'system_message_not_first',
      param: null,
      code: 'system_message_not_first',
      request_id: '<request-id>',
      message_index: 1,
      system_message_indexes: [1],
    },
  });
});

test('loop recovery forces only a currently available generic network tool', async (t) => {
  let attempts = 0;
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push(body);
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempts === 1) {
      res.end('data: {"choices":[{"index":0,"delta":{"reasoning":"Search sources now. Search sources now."}}]}\n\ndata: [DONE]\n\n');
    } else {
      res.end('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"net_probe","arguments":"{\\"query\\":\\"official docs\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    }
  });
  const upstreamUrl = await listen(upstream);
  const suite = createSuite(upstreamUrl);
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  const tools = [
    { type: 'function', function: { name: 'net_probe', description: 'Search the public internet', parameters: { type: 'object', properties: { query: { type: 'string' } } } } },
    { type: 'function', function: { name: 'search_files', description: 'Search local repository', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  ];
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'research first' }], tools }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /net_probe/);
  assert.deepEqual(received[1].tools.map((tool) => tool.function.name), ['net_probe']);
  assert.deepEqual(received[1].tool_choice, { type: 'function', function: { name: 'net_probe' } });
});

test('health, metrics, and drain state are observable', async (t) => {
  const upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const upstreamUrl = await listen(upstream);
  const suite = createSuite(upstreamUrl);
  const proxyUrl = await suite.start();
  t.after(async () => { await suite.stop(); upstream.close(); });

  assert.deepEqual(await (await fetch(`${proxyUrl}/health/live`)).json(), { status: 'ok', service: 'test-openai' });
  assert.equal((await fetch(`${proxyUrl}/health/ready`)).status, 200);
  const metrics = await (await fetch(`${proxyUrl}/metrics`)).text();
  assert.match(metrics, /test_openai_requests_total/);
  suite.beginDrain();
  assert.equal((await fetch(`${proxyUrl}/health/ready`)).status, 503);
  const rejected = await fetch(`${proxyUrl}/v1/models`, { headers: { authorization: 'Bearer client-secret' } });
  assert.equal(rejected.status, 503);
});
