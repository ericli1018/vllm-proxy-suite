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

function config() {
  return loadAnthropicConfig({
    PROXY_HOST: '127.0.0.1', PROXY_PORT: '0',
    VLLM_BASE_URL: 'http://vllm:8001', VLLM_API_KEY: 'vllm', VLLM_CC_PROXY_API_KEY: 'client',
    CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED: 'true', SEARXNG_BASE_URL: 'http://searxng:8080',
    HEARTBEAT_INTERVAL_MS: '60000', UPSTREAM_IDLE_TIMEOUT_MS: '5000', SEMANTIC_STALL_TIMEOUT_MS: '5000',
    TOTAL_GENERATION_TIMEOUT_MS: '5000', RECOVERY_TIMEOUT_MS: '5000',
    MAX_TOTAL_BUFFERED_BYTES: '1048576', MAX_RESPONSE_BUFFER_BYTES: '1048576',
  });
}

test('Anthropic proxy hides WebSearch, executes SearXNG, and returns the next Claude Code tool', async (t) => {
  const vllmBodies = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('http://searxng:8080/')) {
      return new Response(JSON.stringify({ results: [{ title: 'Source', url: 'https://example.com/source', content: 'evidence' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    vllmBodies.push(JSON.parse(init.body));
    if (vllmBodies.length === 1) {
      return new Response(anthropicSse([{ type: 'tool_use', id: 'ws1', name: 'WebSearch', input: { query: 'source' } }], 'tool_use'), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(anthropicSse([{ type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'pwd' } }], 'tool_use'), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  };
  const runtime = createAnthropicProxyRuntime({ config: config(), fetchImpl, exposeControlRoutes: false });
  const server = createManagedHttpServer({ handler: runtime.handle, config: runtime.config });
  const url = await server.start();
  t.after(() => server.stop());

  const response = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer client', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true, max_tokens: 1024,
      messages: [{ role: 'user', content: 'research then run' }],
      tools: [
        { name: 'WebSearch', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
        { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      ],
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(text, /"name":"WebSearch"/);
  assert.match(text, /"name":"Bash"/);
  assert.equal(vllmBodies.length, 2);
  assert.match(vllmBodies[1].messages.at(-1).content[0].content, /example\.com\/source/);

  const metrics = runtime.renderMetrics();
  assert.match(metrics, /vllm_cc_proxy_managed_web_search_executions_total 1/);
  assert.match(metrics, /vllm_cc_proxy_managed_web_search_failures_total 0/);
});
