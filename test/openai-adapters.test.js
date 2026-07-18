import test from 'node:test';
import assert from 'node:assert/strict';

import { chatCompletionsAdapter } from '../packages/openai/chat-completions.js';
import { responsesAdapter } from '../packages/openai/responses.js';
import { loadCommonConfig } from '../packages/core/config.js';

const config = loadCommonConfig({ MAX_TOOL_ARGUMENT_BYTES: '4096', MAX_THINKING_BYTES: '4096' });

function feed(parser, frames) {
  for (const frame of frames) parser.push(new TextEncoder().encode(frame));
  return parser.finish();
}

test('Chat Completions parser assembles reasoning, content, and fragmented tool calls', () => {
  const parser = chatCompletionsAdapter.createStreamParser(config);
  const result = feed(parser, [
    'data: {"id":"x","choices":[{"index":0,"delta":{"reasoning":"checking "}}]}\n\n',
    'data: {"id":"x","choices":[{"index":0,"delta":{"reasoning_content":"evidence","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"internet_lookup","arguments":"{\\"query\\":"}}]}}]}\n\n',
    'data: {"id":"x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"vllm\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  assert.equal(result.done, true);
  assert.equal(result.choices.get(0).reasoning, 'checking evidence');
  assert.equal(result.choices.get(0).toolCalls.get(0).name, 'internet_lookup');
  assert.deepEqual(result.choices.get(0).toolCalls.get(0).parsedArguments, { query: 'vllm' });
  assert.deepEqual(chatCompletionsAdapter.validateStream(result, config), { ok: true });
});

test('Chat Completions parser rejects malformed tool JSON and missing DONE', () => {
  const parser = chatCompletionsAdapter.createStreamParser(config);
  parser.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"x","arguments":"{"}}]},"finish_reason":"tool_calls"}]}\n\n');
  const result = parser.finish();
  assert.equal(chatCompletionsAdapter.validateStream(result, config).reason, 'missing_done');

  result.done = true;
  assert.equal(chatCompletionsAdapter.validateStream(result, config).reason, 'malformed_tool_arguments');
});

test('Chat Completions non-stream parser accepts reasoning variants and tools', () => {
  const raw = Buffer.from(JSON.stringify({
    id: 'x',
    choices: [{ index: 0, finish_reason: 'tool_calls', message: {
      role: 'assistant',
      reasoning_content: 'verified',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'download_url', arguments: '{"url":"https://example.com"}' } }],
    } }],
  }));
  const result = chatCompletionsAdapter.parseJson(raw, config);
  assert.deepEqual(chatCompletionsAdapter.getJsonReasoning(result), ['verified']);
  assert.deepEqual(chatCompletionsAdapter.validateJson(result, config), { ok: true });
});

test('Responses parser assembles reasoning, output text, and function arguments', () => {
  const parser = responsesAdapter.createStreamParser(config);
  const result = feed(parser, [
    'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"inspect "}\n\n',
    'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"source"}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","name":"remote_read","arguments":""}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"url\\":\\"https://example.com\\"}"}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","name":"remote_read","arguments":"{\\"url\\":\\"https://example.com\\"}"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n',
  ]);
  assert.equal(result.completed, true);
  assert.equal(result.reasoning, 'inspect source');
  assert.deepEqual(result.functionCalls.get('fc_1').parsedArguments, { url: 'https://example.com' });
  assert.deepEqual(responsesAdapter.validateStream(result, config), { ok: true });
});

test('Responses non-stream parser validates output_text and function calls', () => {
  const raw = Buffer.from(JSON.stringify({
    id: 'r1', status: 'completed',
    output: [
      { id: 'rs1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'checked' }] },
      { id: 'm1', type: 'message', content: [{ type: 'output_text', text: 'done' }] },
    ],
  }));
  const result = responsesAdapter.parseJson(raw, config);
  assert.deepEqual(responsesAdapter.getJsonReasoning(result), ['checked']);
  assert.deepEqual(responsesAdapter.validateJson(result, config), { ok: true });
});

test('Responses output_item.done replaces incomplete delta arguments with authoritative final arguments', () => {
  const parser = responsesAdapter.createStreamParser(config);
  const result = feed(parser, [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_final","type":"function_call","name":"remote_read","arguments":""}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_final","output_index":0,"delta":"{\\"url\\":"}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_final","type":"function_call","name":"remote_read","arguments":"{\\"url\\":\\"https://example.com/final\\"}"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r2","status":"completed"}}\n\n',
  ]);
  assert.deepEqual(result.functionCalls.get('fc_final').parsedArguments, { url: 'https://example.com/final' });
  assert.deepEqual(responsesAdapter.validateStream(result, config), { ok: true });
});
