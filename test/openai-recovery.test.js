import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyTools, planNetworkRecovery } from '../packages/openai/tool-classifier.js';
import {
  buildOpenAiRecoveryRequest,
  inspectChatSystemMessages,
  validateChatMessageOrdering,
  validateForcedToolRecovery,
} from '../packages/openai/recovery.js';
import { loadCommonConfig } from '../packages/core/config.js';

const chatTools = [
  { type: 'function', function: { name: 'knowledge_probe', description: 'Search the public internet for relevant sources', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'resource_loader', description: 'Download and read a remote URL', parameters: { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'search_files', description: 'Search local repository source code', parameters: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string' } } } } },
];

test('classifyTools identifies arbitrary network capabilities and excludes local search', () => {
  const classified = classifyTools(chatTools);
  assert.equal(classified.find((tool) => tool.name === 'knowledge_probe').capability, 'network_lookup');
  assert.equal(classified.find((tool) => tool.name === 'resource_loader').capability, 'network_download');
  assert.equal(classified.find((tool) => tool.name === 'search_files').capability, 'non_network');
});

test('classifyTools honors exact configured names for opaque tools', () => {
  const tools = [{ type: 'function', function: { name: 'mcp_x1', description: 'Execute operation', parameters: { type: 'object', properties: { value: { type: 'string' } } } } }];
  assert.equal(classifyTools(tools, { lookupNames: ['mcp_x1'] })[0].capability, 'network_lookup');
});

test('planNetworkRecovery chooses download when accepted context contains a URL', () => {
  const plan = planNetworkRecovery({
    tools: chatTools,
    context: [{ role: 'user', content: 'Read https://example.com/spec before continuing.' }],
  });
  assert.equal(plan.mode, 'network_download');
  assert.deepEqual(plan.candidateNames, ['resource_loader']);
});

test('planNetworkRecovery chooses lookup without a URL and never fabricates a tool', () => {
  const lookup = planNetworkRecovery({ tools: chatTools, context: [{ role: 'user', content: 'Find the official specification.' }] });
  assert.equal(lookup.mode, 'network_lookup');
  assert.deepEqual(lookup.candidateNames, ['knowledge_probe']);
  assert.equal(planNetworkRecovery({ tools: [], context: [] }).mode, 'none');
});

test('buildOpenAiRecoveryRequest filters tools and forces one available Chat tool', () => {
  const config = loadCommonConfig({ RECOVERY_NETWORK_TEMPERATURE_MAX: '0.2', RECOVERY_NETWORK_MAX_TOKENS: '512' });
  const original = { model: 'm', messages: [{ role: 'user', content: 'Research it' }], tools: chatTools, temperature: 0.8, max_completion_tokens: 4096, parallel_tool_calls: true };
  const plan = planNetworkRecovery({ tools: chatTools, context: original.messages });
  const recovery = buildOpenAiRecoveryRequest(original, { api: 'chat', reason: 'repeated_reasoning_segment', plan, config });
  assert.equal(recovery.temperature, 0.2);
  assert.equal(recovery.max_completion_tokens, 512);
  assert.deepEqual(recovery.tools.map((tool) => tool.function.name), ['knowledge_probe']);
  assert.deepEqual(recovery.tool_choice, { type: 'function', function: { name: 'knowledge_probe' } });
  assert.equal(recovery.parallel_tool_calls, false);
  assert.equal(recovery.messages[0].role, 'system');
  assert.match(recovery.messages[0].content, /failed attempt is not task progress/i);
  assert.equal(recovery.messages.at(-1).role, 'user');
});

test('Chat recovery merges instruction into the single leading system message', () => {
  const original = {
    model: 'm',
    messages: [
      { role: 'system', content: 'Original policy' },
      { role: 'user', content: 'Do the task' },
      { role: 'assistant', content: 'Working' },
      { role: 'tool', tool_call_id: 'call-1', content: 'result' },
    ],
  };
  const recovery = buildOpenAiRecoveryRequest(original, {
    api: 'chat',
    reason: 'repeated_reasoning_segment',
    plan: { mode: 'none', candidateNames: [] },
    config: loadCommonConfig({}),
  });

  assert.equal(recovery.messages.length, original.messages.length);
  assert.equal(recovery.messages[0].role, 'system');
  assert.match(recovery.messages[0].content, /^Original policy\n\n/);
  assert.match(recovery.messages[0].content, /failed attempt is not task progress/i);
  assert.deepEqual(recovery.messages.slice(1), original.messages.slice(1));
  assert.deepEqual(inspectChatSystemMessages(recovery.messages), {
    count: 1,
    indexes: [0],
    valid: true,
  });
  assert.equal(original.messages[0].content, 'Original policy');
});

test('Chat recovery appends a text block when the leading system content is an array', () => {
  const recovery = buildOpenAiRecoveryRequest({
    model: 'm',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Original policy' }] },
      { role: 'user', content: 'Do the task' },
    ],
  }, {
    api: 'chat',
    reason: 'loop',
    plan: { mode: 'none', candidateNames: [] },
    config: loadCommonConfig({}),
  });

  assert.equal(recovery.messages[0].content.length, 2);
  assert.deepEqual(recovery.messages[0].content[0], { type: 'text', text: 'Original policy' });
  assert.equal(recovery.messages[0].content[1].type, 'text');
  assert.match(recovery.messages[0].content[1].text, /failed attempt is not task progress/i);
});

test('Chat recovery rejects an original system message outside index zero', () => {
  const messages = [
    { role: 'user', content: 'Do the task' },
    { role: 'system', content: 'Late policy' },
  ];
  assert.deepEqual(validateChatMessageOrdering(messages), {
    ok: false,
    code: 'system_message_not_first',
    message: 'System messages are only permitted at messages[0].',
    messageIndex: 1,
    systemMessageIndexes: [1],
  });
  assert.throws(() => buildOpenAiRecoveryRequest({ model: 'm', messages }, {
    api: 'chat',
    reason: 'loop',
    plan: { mode: 'none', candidateNames: [] },
    config: loadCommonConfig({}),
  }), (error) => error?.code === 'system_message_not_first' && error?.details?.message_index === 1);
});

test('buildOpenAiRecoveryRequest uses Responses tool_choice shape', () => {
  const tools = [{ type: 'function', name: 'open_remote', description: 'Fetch a URL from the internet', parameters: { type: 'object', properties: { url: { type: 'string' } } } }];
  const original = { model: 'm', input: 'Read https://example.com', instructions: 'Be exact', tools, max_output_tokens: 2000 };
  const plan = planNetworkRecovery({ tools, context: [original.input] });
  const recovery = buildOpenAiRecoveryRequest(original, { api: 'responses', reason: 'loop', plan, config: loadCommonConfig({}) });
  assert.deepEqual(recovery.tool_choice, { type: 'function', name: 'open_remote' });
  assert.match(recovery.instructions, /failed attempt is not task progress/i);
});

test('validateForcedToolRecovery requires exactly one candidate tool and no final text', () => {
  const plan = { mode: 'network_lookup', candidateNames: ['knowledge_probe'] };
  assert.deepEqual(validateForcedToolRecovery({ toolCalls: [{ name: 'knowledge_probe', parsedArguments: { query: 'x' } }], finalText: '' }, plan), { ok: true });
  assert.equal(validateForcedToolRecovery({ toolCalls: [], finalText: 'answer' }, plan).reason, 'forced_tool_call_required');
  assert.equal(validateForcedToolRecovery({ toolCalls: [{ name: 'other', parsedArguments: {} }], finalText: '' }, plan).reason, 'unexpected_recovery_tool');
});
