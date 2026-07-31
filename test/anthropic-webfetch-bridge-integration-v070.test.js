import assert from 'node:assert/strict';
import test from 'node:test';

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

function nonStream(text) {
  return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('Gateway manages WebFetch end-to-end and exports fetch metrics', async (t) => {
  const vllmBodies = [];
  const config = loadAnthropicConfig({
    PROXY_HOST: '127.0.0.1', PROXY_PORT: '0', VLLM_BASE_URL: 'http://vllm:8001',
    VLLM_API_KEY: 'vllm', VLLM_CC_PROXY_API_KEY: 'client',
    CLAUDE_CODE_WEBFETCH_BRIDGE_ENABLED: 'true', WEBFETCH_READER_CHUNK_CHARS: '1000',
    HEARTBEAT_INTERVAL_MS: '60000', TOTAL_GENERATION_TIMEOUT_MS: '10000', RECOVERY_TIMEOUT_MS: '10000',
    MAX_TOTAL_BUFFERED_BYTES: '1048576', MAX_RESPONSE_BUFFER_BYTES: '1048576',
  });
  const fetchImpl = async (url, init = {}) => {
    if (String(url) === 'https://1.1.1.1/article') return new Response('<html><title>T</title><body><p>Evidence 42.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    vllmBodies.push(JSON.parse(init.body));
    const body = vllmBodies.at(-1);
    if (vllmBodies.length === 1) return new Response(anthropicSse([{ type: 'tool_use', id: 'wf1', name: 'WebFetch', input: { url: 'https://1.1.1.1/article', prompt: 'find evidence' } }], 'tool_use'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    if (String(body.system).includes('chunk reader')) return nonStream(JSON.stringify({ relevant: true, summary: '42', facts: [{ claim: '42', evidence: 'Evidence 42', location: 'section' }], uncertainties: [] }));
    if (String(body.system).includes('document synthesizer')) return nonStream('Evidence is 42.');
    return new Response(anthropicSse([{ type: 'text', text: 'Final 42.' }]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const runtime = createAnthropicProxyRuntime({ config, fetchImpl, exposeControlRoutes: false });
  const server = createManagedHttpServer({ handler: runtime.handle, config: runtime.config });
  const base = await server.start();
  t.after(() => server.stop());
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, max_tokens: 1024, messages: [{ role: 'user', content: 'read' }], tools: [{ name: 'WebFetch', input_schema: { type: 'object' } }] }),
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Final 42/);
  assert.doesNotMatch(text, /"name":"WebFetch"/);
  assert.ok(vllmBodies.slice(1).every((body) => body.think === false && body.chat_template_kwargs.enable_thinking === false));
  const metrics = runtime.renderMetrics();
  assert.match(metrics, /vllm_cc_proxy_managed_web_fetch_executions_total 1/);
  assert.match(metrics, /vllm_cc_proxy_managed_web_fetch_chunks_total 1/);
});
