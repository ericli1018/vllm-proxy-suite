import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAnthropicGuardedRoute,
  loadAnthropicConfig,
} from '../apps/vllm-cc-proxy/server.js';

const tools = [
  {
    name: 'Read',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  },
  {
    name: 'Edit',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
];

test('Anthropic service enables Claude Code tool recovery by default and permits explicit disable', () => {
  const enabled = loadAnthropicConfig({});
  assert.equal(enabled.claudeCodeToolRecoveryEnabled, true);
  assert.equal(enabled.claudeCodeActionIntentGuardEnabled, true);
  assert.equal(enabled.claudeCodeEditRecoveryEnabled, true);
  assert.equal(enabled.claudeCodeWriteRecoveryEnabled, true);
  assert.equal(enabled.claudeCodeNotebookEditRecoveryEnabled, true);
  assert.equal(enabled.claudeCodeBashInvalidatesReads, true);

  const disabled = loadAnthropicConfig({
    CLAUDE_CODE_TOOL_RECOVERY_ENABLED: 'false',
    CLAUDE_CODE_ACTION_INTENT_GUARD_ENABLED: 'false',
    CLAUDE_CODE_EDIT_RECOVERY_ENABLED: 'false',
    CLAUDE_CODE_WRITE_RECOVERY_ENABLED: 'false',
    CLAUDE_CODE_NOTEBOOK_EDIT_RECOVERY_ENABLED: 'false',
    CLAUDE_CODE_BASH_INVALIDATES_READS: 'false',
  });
  assert.equal(disabled.claudeCodeToolRecoveryEnabled, false);
  assert.equal(disabled.claudeCodeActionIntentGuardEnabled, false);
  assert.equal(disabled.claudeCodeEditRecoveryEnabled, false);
  assert.equal(disabled.claudeCodeWriteRecoveryEnabled, false);
  assert.equal(disabled.claudeCodeNotebookEditRecoveryEnabled, false);
  assert.equal(disabled.claudeCodeBashInvalidatesReads, false);
});

test('Anthropic guarded route converts no-op Edit into exact Read recovery', () => {
  const config = loadAnthropicConfig({});
  const route = createAnthropicGuardedRoute(config);
  const originalBody = {
    model: 'm',
    max_tokens: 8192,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    seed: 7,
    messages: [{ role: 'user', content: 'edit' }],
    tools,
  };
  const attempt = {
    result: {
      blocks: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/work/a.js', old_string: 'x', new_string: 'x' } }],
    },
  };
  const validation = route.validateAttempt(attempt, { originalBody });
  assert.equal(validation.reason, 'no_op_edit_tool_call');

  const recovery = route.buildRecovery({
    originalBody,
    firstBody: route.prepareRequest(originalBody),
    reason: validation,
  });
  assert.equal('thinking' in recovery.body, false);
  assert.equal('seed' in recovery.body, false);
  assert.equal(recovery.body.chat_template_kwargs.enable_thinking, true);
  assert.equal(recovery.plan.mode, 'read_target');
  assert.deepEqual(recovery.body.tools.map((tool) => tool.name), ['Read']);
  assert.deepEqual(recovery.body.tool_choice, { type: 'tool', name: 'Read' });
});
