import test from 'node:test';
import assert from 'node:assert/strict';

import { loadCommonConfig } from '../packages/core/config.js';
import { detectReasoningLoop } from '../packages/core/loop-detector.js';
import { BufferBudget } from '../packages/core/buffer-budget.js';

test('loadCommonConfig applies bounded defaults and valid overrides', () => {
  const config = loadCommonConfig({
    MAX_ACTIVE_REQUESTS: '12',
    LOOP_MIN_PATTERN_SIZE: '16',
    LOOP_MAX_PATTERN_SIZE: '512',
    MAX_TOTAL_BUFFERED_BYTES: '2048',
  });
  assert.equal(config.maxActiveRequests, 12);
  assert.equal(config.loopMinPatternSize, 16);
  assert.equal(config.loopMaxPatternSize, 512);
  assert.equal(config.maxTotalBufferedBytes, 2048);
  assert.equal(loadCommonConfig({ MAX_ACTIVE_REQUESTS: '0' }).maxActiveRequests, 256);
});

test('detectReasoningLoop detects exact and normalized repeated reasoning', () => {
  const config = loadCommonConfig({ LOOP_MIN_PATTERN_SIZE: '8', LOOP_MAX_PATTERN_SIZE: '256' });
  const exact = detectReasoningLoop('先檢查來源與限制。先檢查來源與限制。', config);
  assert.equal(exact?.reason, 'repeated_reasoning_segment');

  const normalized = detectReasoningLoop('Need evidence, then verify.\nNeed evidence then verify!', config);
  assert.equal(normalized?.reason, 'normalized_reasoning_segment');
});

test('detectReasoningLoop detects ABAB line cycles', () => {
  const config = loadCommonConfig({ LOOP_MIN_PATTERN_SIZE: '4' });
  const result = detectReasoningLoop('分析假設 A\n檢查假設 B\n分析假設 A\n檢查假設 B\n', config);
  assert.equal(result?.reason, 'abab_reasoning_lines');
});

test('detectReasoningLoop ignores code and log-shaped output', () => {
  const config = loadCommonConfig({ LOOP_MIN_PATTERN_SIZE: '4' });
  const code = '```js\nconsole.log("x");\nconsole.log("x");\n```';
  const logs = '[INFO] request complete\n[INFO] request complete\n';
  assert.equal(detectReasoningLoop(code, config), null);
  assert.equal(detectReasoningLoop(logs, config), null);
});

test('detectReasoningLoop enforces reasoning length limit', () => {
  const config = loadCommonConfig({ LOOP_REASONING_CHAR_LIMIT: '128' });
  const unique = Array.from({ length: 129 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join('');
  const result = detectReasoningLoop(unique, config);
  assert.equal(result?.reason, 'reasoning_without_action');
});

test('BufferBudget reserves and releases per request without exceeding total', () => {
  const budget = new BufferBudget(100);
  assert.equal(budget.reserve('a', 60), true);
  assert.equal(budget.reserve('b', 50), false);
  assert.equal(budget.reserve('a', 40), true);
  assert.equal(budget.total, 100);
  assert.equal(budget.release('a'), 100);
  assert.equal(budget.total, 0);
  assert.equal(budget.reserve('b', 50), true);
  assert.equal(budget.usedBy('b'), 50);
});
