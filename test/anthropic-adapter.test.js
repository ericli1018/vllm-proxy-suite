import test from 'node:test';
import assert from 'node:assert/strict';

import { anthropicMessagesAdapter, applyAnthropicRequestPolicy, buildAnthropicRecoveryRequest } from '../packages/anthropic/messages.js';
import { loadCommonConfig } from '../packages/core/config.js';

const config = Object.freeze({
  ...loadCommonConfig({ MAX_TOOL_ARGUMENT_BYTES: '4096', MAX_THINKING_BYTES: '4096' }),
  defaultEnableThinking: true,
  defaultMaxTokens: 8192,
});

function feed(frames) {
  const parser = anthropicMessagesAdapter.createStreamParser(config);
  for (const frame of frames) parser.push(frame);
  return parser.finish();
}

test('Anthropic parser assembles thinking, text, and fragmented tool JSON', () => {
  const result = feed([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"ornith","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"verify evidence"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"lookup","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"vllm\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  assert.equal(result.blocks[0].thinking, 'verify evidence');
  assert.deepEqual(result.blocks[1].input, { query: 'vllm' });
  assert.deepEqual(anthropicMessagesAdapter.validateStream(result, config), { ok: true });
  assert.deepEqual(anthropicMessagesAdapter.getReasoning(result), ['verify evidence']);
});

test('Anthropic parser rejects incomplete and malformed tool calls', () => {
  const result = feed([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"lookup","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  assert.equal(anthropicMessagesAdapter.validateStream(result, config).reason, 'malformed_tool_json');
});

test('applyAnthropicRequestPolicy preserves model and valid sampling while mapping thinking', () => {
  const body = applyAnthropicRequestPolicy({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hello' }],
    thinking: { type: 'enabled', budget_tokens: 2048 },
    temperature: 0.7,
    top_p: 0.95,
    top_k: 20,
    max_tokens: 4096,
    min_p: 0.1,
    seed: 10,
    chat_template_kwargs: { custom: true },
  }, config);
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.equal(body.temperature, 0.7);
  assert.equal(body.top_p, 0.95);
  assert.equal(body.top_k, 20);
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.chat_template_kwargs, { custom: true, enable_thinking: true });
  assert.equal('thinking' in body, false);
  assert.equal('min_p' in body, false);
  assert.equal('seed' in body, false);
});

test('applyAnthropicRequestPolicy removes invalid optional sampling and defaults max_tokens only', () => {
  const body = applyAnthropicRequestPolicy({ model: 'm', messages: [], temperature: 9, top_p: -1, top_k: 1.5 }, config);
  assert.equal('temperature' in body, false);
  assert.equal('top_p' in body, false);
  assert.equal('top_k' in body, false);
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.chat_template_kwargs.enable_thinking, true);
});

test('buildAnthropicRecoveryRequest discards failed output and appends recovery instruction', () => {
  const original = { model: 'm', system: 'Original policy', messages: [{ role: 'user', content: 'task' }], temperature: 0.8, max_tokens: 8192 };
  const recovery = buildAnthropicRecoveryRequest(original, 'repeated_reasoning_segment', config);
  assert.equal(recovery.temperature, 0.45);
  assert.equal(recovery.max_tokens, 4096);
  assert.match(recovery.system, /failed attempt is not task progress/i);
  assert.match(recovery.system, /recovery is expected/i);
  assert.match(recovery.system, /do not explain why the previous attempt failed/i);
  assert.deepEqual(recovery.messages, original.messages);
});

test('Anthropic non-stream response validates text and tool use', () => {
  const raw = Buffer.from(JSON.stringify({
    id: 'm1', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: 'checked' }, { type: 'text', text: 'done' }],
  }));
  const result = anthropicMessagesAdapter.parseJson(raw, config);
  assert.deepEqual(anthropicMessagesAdapter.getJsonReasoning(result), ['checked']);
  assert.deepEqual(anthropicMessagesAdapter.validateJson(result, config), { ok: true });
});
