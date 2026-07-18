import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  classifyGatewayPath,
  createVllmProxySuiteServer,
  loadSuiteConfig,
} from '../apps/gateway/server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function envFor(upstreamUrl) {
  return {
    PROXY_HOST: '127.0.0.1',
    PROXY_PORT: '0',
    VLLM_BASE_URL: upstreamUrl,
    VLLM_API_KEY: 'upstream-key',
    VLLM_CC_PROXY_API_KEY: 'cc-key',
    VLLM_OPENAI_PROXY_API_KEY: 'openai-key',
    LOG_LEVEL: 'off',
    HEARTBEAT_INTERVAL_MS: '1000',
    UPSTREAM_IDLE_TIMEOUT_MS: '2000',
    SEMANTIC_STALL_TIMEOUT_MS: '2000',
    TOTAL_GENERATION_TIMEOUT_MS: '5000',
    RECOVERY_TIMEOUT_MS: '5000',
    SHUTDOWN_GRACE_MS: '2000',
  };
}

test('JavaScript gateway classifies native API paths without prefixes', () => {
  assert.equal(classifyGatewayPath('/v1/messages'), 'anthropic');
  assert.equal(classifyGatewayPath('/v1/messages/count_tokens'), 'anthropic');
  assert.equal(classifyGatewayPath('/v1/chat/completions'), 'openai');
  assert.equal(classifyGatewayPath('/v1/responses'), 'openai');
  assert.equal(classifyGatewayPath('/v1/models'), 'openai');
  assert.equal(classifyGatewayPath('/health/live'), null);
  assert.equal(classifyGatewayPath('/unknown'), null);
});

test('suite config resolves one listener and separate protocol API keys', () => {
  const config = loadSuiteConfig({
    PROXY_HOST: '127.0.0.1',
    PROXY_PORT: '4567',
    VLLM_CC_PROXY_API_KEY: 'cc-secret',
    VLLM_OPENAI_PROXY_API_KEY: 'openai-secret',
  });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4567);
  assert.equal(config.anthropic.proxyApiKey, 'cc-secret');
  assert.equal(config.openai.proxyApiKey, 'openai-secret');
});

test('single gateway routes both protocols directly to vLLM with separate authentication', async (t) => {
  const seen = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ path: request.url, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() });
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/v1/messages/count_tokens') return response.end('{"input_tokens":12}');
    if (request.url === '/v1/models') return response.end('{"object":"list","data":[]}');
    response.end('{"id":"unused"}');
  });
  const upstreamUrl = await listen(upstream);
  const suite = createVllmProxySuiteServer({ env: envFor(upstreamUrl) });
  const suiteUrl = await suite.start();
  t.after(async () => {
    await suite.stop();
    upstream.close();
  });

  const ccDenied = await fetch(`${suiteUrl}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { authorization: 'Bearer openai-key', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(ccDenied.status, 401);

  const cc = await fetch(`${suiteUrl}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'x-api-key': 'cc-key', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(cc.status, 200);
  assert.deepEqual(await cc.json(), { input_tokens: 12 });

  const openAiDenied = await fetch(`${suiteUrl}/v1/models`, {
    headers: { authorization: 'Bearer cc-key' },
  });
  assert.equal(openAiDenied.status, 401);

  const openAi = await fetch(`${suiteUrl}/v1/models`, {
    headers: { authorization: 'Bearer openai-key' },
  });
  assert.equal(openAi.status, 200);
  assert.deepEqual(await openAi.json(), { object: 'list', data: [] });

  assert.deepEqual(seen.map((entry) => entry.path), ['/v1/messages/count_tokens', '/v1/models']);
  assert.ok(seen.every((entry) => entry.authorization === 'Bearer upstream-key'));
});

test('gateway exposes suite health and combined protocol metrics', async (t) => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const upstreamUrl = await listen(upstream);
  const suite = createVllmProxySuiteServer({ env: envFor(upstreamUrl) });
  const suiteUrl = await suite.start();
  t.after(async () => {
    await suite.stop();
    upstream.close();
  });

  assert.deepEqual(await (await fetch(`${suiteUrl}/health/live`)).json(), {
    status: 'ok',
    service: 'vllm-proxy-suite',
  });
  assert.equal((await fetch(`${suiteUrl}/health/ready`)).status, 200);
  const metrics = await (await fetch(`${suiteUrl}/metrics`)).text();
  assert.match(metrics, /vllm_cc_proxy_requests_total/);
  assert.match(metrics, /vllm_openai_proxy_requests_total/);

  suite.beginDrain();
  assert.equal((await fetch(`${suiteUrl}/health/ready`)).status, 503);
});

test('gateway invokes both guarded protocol modules in-process', async (t) => {
  const seen = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/v1/messages') {
      return response.end(JSON.stringify({
        id: 'msg_local',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'cc-ok' }],
        model: 'local-model',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    }
    return response.end(JSON.stringify({
      id: 'chatcmpl_local',
      object: 'chat.completion',
      model: 'local-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'openai-ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  const upstreamUrl = await listen(upstream);
  const suite = createVllmProxySuiteServer({ env: envFor(upstreamUrl) });
  const suiteUrl = await suite.start();
  t.after(async () => {
    await suite.stop();
    upstream.close();
  });

  const cc = await fetch(`${suiteUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'cc-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'local-model', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(cc.status, 200);
  assert.equal((await cc.json()).content[0].text, 'cc-ok');

  const openai = await fetch(`${suiteUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer openai-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'local-model', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(openai.status, 200);
  assert.equal((await openai.json()).choices[0].message.content, 'openai-ok');

  assert.deepEqual(seen.map((entry) => entry.path), ['/v1/messages', '/v1/chat/completions']);
});
