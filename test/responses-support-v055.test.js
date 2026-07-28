import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { loadCommonConfig } from '../packages/core/config.js';
import { responsesAdapter } from '../packages/openai/responses.js';
import { createOpenAiProxyRuntime } from '../apps/vllm-openai-proxy/server.js';

function config(overrides = {}) {
  return Object.freeze({
    ...loadCommonConfig({
      PROXY_API_KEY: 'client-secret',
      VLLM_API_KEY: 'vllm-secret',
      VLLM_BASE_URL: 'http://upstream.invalid',
      HEARTBEAT_INTERVAL_MS: '60000',
      UPSTREAM_IDLE_TIMEOUT_MS: '5000',
      SEMANTIC_STALL_TIMEOUT_MS: '5000',
      TOTAL_GENERATION_TIMEOUT_MS: '5000',
      RECOVERY_TIMEOUT_MS: '5000',
      MAX_RECOVERY_ATTEMPTS: '1',
      MAX_TOTAL_BUFFERED_BYTES: '1048576',
      MAX_RESPONSE_BUFFER_BYTES: '1048576',
    }),
    ...overrides,
  });
}

function feed(parser, frames) {
  for (const frame of frames) parser.push(frame);
  return parser.finish();
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.close();
  await once(server, 'close').catch(() => {});
}

test('Responses accepts official response.incomplete with reasoning-only output', () => {
  const parser = responsesAdapter.createStreamParser(config());
  const result = feed(parser, [
    'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","item_id":"rs1","output_index":0,"content_index":0,"delta":"Thinking"}\n\n',
    'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"r1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"id":"rs1","type":"reasoning","status":"incomplete","content":[{"type":"reasoning_text","text":"Thinking"}]}],"usage":{"input_tokens":106,"output_tokens":256,"total_tokens":362}}}\n\n',
  ]);

  assert.equal(result.terminal, true);
  assert.equal(result.completed, false);
  assert.equal(result.incomplete, true);
  assert.equal(result.terminalEvent, 'response.incomplete');
  assert.deepEqual(responsesAdapter.validateStream(result, config()), { ok: true });
  assert.equal(responsesAdapter.semanticMetrics(result).responseTerminal, true);
  assert.equal(responsesAdapter.semanticMetrics(result).responseIncomplete, true);
  assert.equal(responsesAdapter.semanticMetrics(result).responseTerminalEvent, 'response.incomplete');
  assert.deepEqual(responsesAdapter.completionDiagnostics(result), {
    responseTerminal: true,
    responseTerminalEvent: 'response.incomplete',
    responseCompleted: false,
    responseIncomplete: true,
    responseCancelled: false,
    responseFailed: false,
    responseStatus: 'incomplete',
    responseIncompleteReason: 'max_output_tokens',
    responseIncompleteDetails: { reason: 'max_output_tokens' },
    usagePromptTokens: 106,
    usageCompletionTokens: 256,
    usageTotalTokens: 362,
  });
});

test('Responses accepts vLLM response.completed event carrying status incomplete', () => {
  const parser = responsesAdapter.createStreamParser(config());
  const result = feed(parser, [
    'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","item_id":"rs1","output_index":0,"content_index":0,"delta":"Thinking"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":106,"output_tokens":256,"total_tokens":362}}}\n\n',
  ]);

  assert.equal(result.terminal, true);
  assert.equal(result.completed, false);
  assert.equal(result.incomplete, true);
  assert.equal(result.terminalEvent, 'response.completed');
  assert.equal(responsesAdapter.validateStream(result, config()).ok, true);
});

test('Responses non-stream accepts an incomplete reasoning-only response unchanged', () => {
  const raw = Buffer.from(JSON.stringify({
    id: 'r1',
    object: 'response',
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ id: 'rs1', type: 'reasoning', status: 'incomplete', content: [{ type: 'reasoning_text', text: 'Thinking' }] }],
    usage: { input_tokens: 106, output_tokens: 256, total_tokens: 362 },
  }));
  const result = responsesAdapter.parseJson(raw, config());

  assert.equal(result.terminal, true);
  assert.equal(result.incomplete, true);
  assert.deepEqual(responsesAdapter.validateJson(result, config()), { ok: true });
});

test('Responses final done events are authoritative and do not duplicate deltas', () => {
  const parser = responsesAdapter.createStreamParser(config());
  const result = feed(parser, [
    'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","item_id":"rs1","output_index":0,"content_index":0,"delta":"Think"}\n\n',
    'event: response.reasoning_text.done\ndata: {"type":"response.reasoning_text.done","item_id":"rs1","output_index":0,"content_index":0,"text":"Thinking"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"m1","output_index":1,"content_index":0,"delta":"O"}\n\n',
    'event: response.output_text.done\ndata: {"type":"response.output_text.done","item_id":"m1","output_index":1,"content_index":0,"text":"OK"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n',
  ]);

  assert.equal(result.reasoning, 'Thinking');
  assert.equal(result.outputText, 'OK');
  assert.deepEqual(responsesAdapter.validateStream(result, config()), { ok: true });
});

test('Responses output_item.done replaces reasoning deltas without duplication', () => {
  const parser = responsesAdapter.createStreamParser(config());
  const result = feed(parser, [
    'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","item_id":"rs1","output_index":0,"content_index":0,"delta":"Think"}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs1","type":"reasoning","status":"completed","content":[{"type":"reasoning_text","text":"Thinking"}]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n',
    'event: response.output_text.done\ndata: {"type":"response.output_text.done","item_id":"m1","output_index":1,"content_index":0,"text":"OK"}\n\n',
  ]);

  assert.equal(result.reasoning, 'Thinking');
  assert.equal(result.outputText, 'OK');
});

test('Responses terminal event parses complete output without prior delta events', () => {
  const parser = responsesAdapter.createStreamParser(config());
  const result = feed(parser, [
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"id":"rs1","type":"reasoning","summary":[{"type":"summary_text","text":"Checked"}]},{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[]}]}]}}\n\n',
  ]);

  assert.equal(result.reasoning, 'Checked');
  assert.equal(result.outputText, 'OK');
  assert.equal(responsesAdapter.semanticMetrics(result).contentBytes, 2);
  assert.equal(responsesAdapter.semanticMetrics(result).reasoningBytes, 7);
  assert.deepEqual(responsesAdapter.validateStream(result, config()), { ok: true });
});

test('Responses refusal done is valid visible output', () => {
  const parser = responsesAdapter.createStreamParser(config());
  const result = feed(parser, [
    'event: response.refusal.done\ndata: {"type":"response.refusal.done","item_id":"m1","output_index":0,"content_index":0,"refusal":"Cannot comply"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n',
  ]);

  assert.equal(result.refusalText, 'Cannot comply');
  assert.equal(responsesAdapter.validateStream(result, config()).ok, true);
  assert.equal(responsesAdapter.extractOutput(result).finalText, 'Cannot comply');
});

test('Responses function_call_arguments.done supplies authoritative final arguments', () => {
  const parser = responsesAdapter.createStreamParser(config());
  const result = feed(parser, [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc1","type":"function_call","name":"lookup","arguments":""}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc1","output_index":0,"delta":"{\\"q\\":"}\n\n',
    'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc1","output_index":0,"name":"lookup","arguments":"{\\"q\\":\\"docs\\"}"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n',
  ]);

  assert.deepEqual(result.functionCalls.get('fc1').parsedArguments, { q: 'docs' });
});

test('Responses runtime replays reasoning-only incomplete SSE without a Proxy error event', async (t) => {
  const raw = [
    'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","item_id":"rs1","output_index":0,"content_index":0,"delta":"Thinking"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":106,"output_tokens":256,"total_tokens":362}}}\n\n',
  ].join('');
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(raw);
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({ config: config({ vllmBaseUrl: upstreamUrl, port: 0 }), exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', input: 'Reply OK', stream: true, max_output_tokens: 256 }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(text, raw);
  assert.doesNotMatch(text, /reasoning_without_output/);
  assert.doesNotMatch(text, /^event: error/m);
  assert.equal(runtime.metrics.recoveriesTotal, 0);
  assert.equal(runtime.metrics.validationFailuresTotal, 0);
});


test('Responses runtime replays non-stream incomplete JSON unchanged', async (t) => {
  const payload = JSON.stringify({
    id: 'r-json',
    object: 'response',
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ id: 'rs1', type: 'reasoning', status: 'incomplete', content: [{ type: 'reasoning_text', text: 'Thinking' }] }],
    usage: { input_tokens: 106, output_tokens: 256, total_tokens: 362 },
  });
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({ config: config({ vllmBaseUrl: upstreamUrl, port: 0 }), exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', input: 'Reply OK', stream: false, max_output_tokens: 256 }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(text, payload);
  assert.doesNotMatch(text, /reasoning_without_output/);
  assert.equal(runtime.metrics.recoveriesTotal, 0);
  assert.equal(runtime.metrics.validationFailuresTotal, 0);
});
