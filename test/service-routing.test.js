import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyGatewayPath } from '../apps/gateway/server.js';
import { isOpenAiPassthroughPath } from '../apps/vllm-openai-proxy/server.js';

test('OpenAI module rejects Anthropic paths even behind the JavaScript gateway', () => {
  assert.equal(isOpenAiPassthroughPath('/v1/messages'), false);
  assert.equal(isOpenAiPassthroughPath('/v1/messages/count_tokens'), false);
  assert.equal(isOpenAiPassthroughPath('/v1/models'), true);
  assert.equal(isOpenAiPassthroughPath('/v1/embeddings'), true);
});

test('gateway gives exact Anthropic paths precedence over OpenAI catch-all', () => {
  assert.equal(classifyGatewayPath('/v1/messages'), 'anthropic');
  assert.equal(classifyGatewayPath('/v1/messages/count_tokens'), 'anthropic');
  assert.equal(classifyGatewayPath('/v1/messages/extra'), 'openai');
  assert.equal(classifyGatewayPath('/v1/models'), 'openai');
});
