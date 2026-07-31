import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  detectActionlessCompletion,
  summarizeOpenAiToolContext,
} from '../packages/openai/actionless-completion.js';
import { buildOpenAiRecoveryRequest } from '../packages/openai/recovery.js';
import { loadCommonConfig } from '../packages/core/config.js';
import { createOpenAiProxyRuntime } from '../apps/vllm-openai-proxy/server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

function config(overrides = {}) {
  return Object.freeze({
    ...loadCommonConfig({
      PROXY_API_KEY: 'client-secret',
      VLLM_API_KEY: 'vllm-secret',
      HEARTBEAT_INTERVAL_MS: '60000',
      UPSTREAM_IDLE_TIMEOUT_MS: '5000',
      SEMANTIC_STALL_TIMEOUT_MS: '5000',
      TOTAL_GENERATION_TIMEOUT_MS: '5000',
      RECOVERY_TIMEOUT_MS: '5000',
      MAX_TOTAL_BUFFERED_BYTES: '1048576',
      MAX_RESPONSE_BUFFER_BYTES: '1048576',
      ACTIONLESS_COMPLETION_GUARD_ENABLED: 'true',
      LOG_LEVEL: 'debug',
    }),
    port: 0,
    responsesBehaviorMode: 'guarded',
    ...overrides,
  });
}

const responsesTools = [
  {
    type: 'function',
    name: 'shell',
    description: 'Execute a shell command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    type: 'function',
    name: 'write_file',
    description: 'Write a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
];

function narration(text = '好的，我來開始執行。首先建立協調目錄，然後啟動研究工作。') {
  return {
    toolCalls: [],
    finalText: text,
  };
}

function completedDiagnostics() {
  return {
    responseTerminal: true,
    responseCompleted: true,
    responseIncomplete: false,
    responseCancelled: false,
    responseFailed: false,
    responseStatus: 'completed',
  };
}

test('OpenAI request tool context reports direct Responses function tools without schemas', () => {
  assert.deepEqual(summarizeOpenAiToolContext({
    tools: responsesTools,
    tool_choice: 'auto',
    parallel_tool_calls: true,
  }), {
    requestToolCount: 2,
    requestToolNames: ['shell', 'write_file'],
    requestToolChoice: 'auto',
    requestToolsEnabled: true,
    parallelToolCallsRequested: true,
  });
});

test('completed Responses narration with enabled tools is actionless', () => {
  const validation = detectActionlessCompletion({
    requestBody: { tools: responsesTools, tool_choice: 'auto' },
    output: narration(),
    completion: completedDiagnostics(),
    recovery: false,
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'actionless_completion');
  assert.equal(validation.retryable, true);
  assert.equal(validation.diagnostics.requestToolCount, 2);
  assert.equal(validation.diagnostics.actionlessRecoveryAttempted, false);
});

test('actionless guard recognizes a short preface before an immediate first-person action promise', () => {
  const validation = detectActionlessCompletion({
    requestBody: { tools: responsesTools, tool_choice: 'auto' },
    output: narration('Now I have enough data. Let me create the complete interactive report.'),
    completion: completedDiagnostics(),
    recovery: false,
  });
  assert.equal(validation.reason, 'actionless_completion');
});

test('actionless guard ignores normal answers, disabled tools, and incomplete responses', () => {
  assert.deepEqual(detectActionlessCompletion({
    requestBody: { tools: responsesTools, tool_choice: 'auto' },
    output: narration('首先建立目錄，接著執行測試。'),
    completion: completedDiagnostics(),
    recovery: false,
  }), { ok: true });

  assert.deepEqual(detectActionlessCompletion({
    requestBody: { tools: responsesTools, tool_choice: 'auto' },
    output: narration('我會建立三個模組，這是建議的架構。'),
    completion: completedDiagnostics(),
    recovery: false,
  }), { ok: true });

  assert.deepEqual(detectActionlessCompletion({
    requestBody: { tools: responsesTools, tool_choice: 'auto' },
    output: narration('I will create three modules in the proposed architecture.'),
    completion: completedDiagnostics(),
    recovery: false,
  }), { ok: true });

  assert.deepEqual(detectActionlessCompletion({
    requestBody: { tools: responsesTools, tool_choice: 'auto' },
    output: narration('The implementation is complete and all tests pass.'),
    completion: completedDiagnostics(),
    recovery: false,
  }), { ok: true });

  assert.deepEqual(detectActionlessCompletion({
    requestBody: { tools: responsesTools, tool_choice: 'none' },
    output: narration(),
    completion: completedDiagnostics(),
    recovery: false,
  }), { ok: true });

  assert.deepEqual(detectActionlessCompletion({
    requestBody: { tools: responsesTools, tool_choice: 'auto' },
    output: narration(),
    completion: { ...completedDiagnostics(), responseCompleted: false, responseIncomplete: true, responseStatus: 'incomplete' },
    recovery: false,
  }), { ok: true });
});

test('actionless recovery keeps all tools and forces one required non-parallel call', () => {
  const body = buildOpenAiRecoveryRequest({
    model: 'm',
    input: 'Build the project',
    instructions: 'Use tools to do the work.',
    tools: responsesTools,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    max_output_tokens: 4096,
  }, {
    api: 'responses',
    reason: 'actionless_completion',
    plan: { mode: 'action_required', candidateNames: ['shell', 'write_file'] },
    config: config(),
  });

  assert.equal(body.tool_choice, 'required');
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.tools, responsesTools);
  assert.match(body.instructions, /completed without calling any tool/i);
  assert.match(body.instructions, /Call exactly one appropriate available tool now/i);
});

test('Responses runtime replaces action narration with one required-tool recovery', async (t) => {
  let attempts = 0;
  const received = [];
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempts === 1) {
      res.end([
        'event: response.output_text.done\ndata: {"type":"response.output_text.done","item_id":"m1","output_index":0,"content_index":0,"text":"好的，我來開始執行。首先建立協調目錄，然後啟動研究工作。"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":"好的，我來開始執行。首先建立協調目錄，然後啟動研究工作。","annotations":[]}]}]}}\n\n',
      ].join(''));
      return;
    }
    res.end([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc1","type":"function_call","call_id":"call-1","name":"shell","arguments":""}}\n\n',
      'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc1","call_id":"call-1","output_index":0,"name":"shell","arguments":"{\\"command\\":\\"mkdir -p .coordination\\"}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r2","status":"completed"}}\n\n',
    ].join(''));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({
    config: config({ vllmBaseUrl: upstreamUrl }),
    exposeControlRoutes: false,
    logSink(line) { logs.push(JSON.parse(line)); },
  });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm',
      input: 'Build the project',
      stream: true,
      tools: responsesTools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
    }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.doesNotMatch(text, /我來開始執行/);
  assert.match(text, /function_call/);
  assert.equal(received[1].tool_choice, 'required');
  assert.equal(received[1].parallel_tool_calls, false);
  assert.deepEqual(received[1].tools, responsesTools);
  assert.ok(logs.some((entry) => entry.event === 'request_tool_context'
    && entry.requestToolCount === 2
    && entry.requestToolChoice === 'auto'));
  assert.ok(logs.some((entry) => entry.event === 'recovery_started'
    && entry.reason === 'actionless_completion'));
  assert.equal(runtime.metrics.actionlessCompletionsDetectedTotal, 1);
  assert.equal(runtime.metrics.actionlessRecoveriesFusedTotal, 0);
});

test('Responses actionless recovery is fused after one required-tool attempt', async (t) => {
  let attempts = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    attempts += 1;
    const text = attempts === 1
      ? '好的，我來開始執行。首先建立目錄。'
      : '我現在會先建立目錄，接著執行測試。';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      `event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', item_id: `m${attempts}`, output_index: 0, content_index: 0, text })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: `r${attempts}`, status: 'completed', output: [{ id: `m${attempts}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }] } })}\n\n`,
    ].join(''));
  });
  const upstreamUrl = await listen(upstream);
  const runtime = createOpenAiProxyRuntime({ config: config({ vllmBaseUrl: upstreamUrl }), exposeControlRoutes: false });
  const proxy = http.createServer(runtime.handle);
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', input: 'Build it', stream: true, tools: responsesTools }),
  });
  const text = await response.text();

  assert.equal(attempts, 2);
  assert.equal(response.status, 502);
  assert.match(text, /actionless_completion/);
  assert.match(text, /"retryable":false/);
  assert.equal(runtime.metrics.actionlessCompletionsDetectedTotal, 2);
  assert.equal(runtime.metrics.actionlessRecoveriesFusedTotal, 1);
});

test('actionless guard recognizes immediate start and continue execution narration', () => {
  for (const text of [
    '好的，我開始執行階段 1。先查看當前目錄結構。',
    '我繼續執行，先檢查目前狀態。',
  ]) {
    const validation = detectActionlessCompletion({
      requestBody: { tools: responsesTools, tool_choice: 'auto' },
      output: narration(text),
      completion: completedDiagnostics(),
      recovery: false,
    });
    assert.equal(validation.reason, 'actionless_completion');
  }
});
