import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('package validator confirms required deployable artifacts', () => {
  const result = spawnSync(process.execPath, ['scripts/validate-package.js'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, true);
  assert.equal(report.project, 'VLLM-PROXY-SUITE');
  assert.equal(report.version, '0.7.13');
  assert.equal(report.architecture, 'single-process-javascript-gateway');
  assert.equal(report.repository, 'https://github.com/ericli1018/vllm-proxy-suite.git');
  assert.ok(report.files >= 20);
});

test('README documents native path routing and separate protocol keys', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  assert.match(readme, /\/v1\/messages/);
  assert.match(readme, /\/v1\/chat\/completions/);
  assert.match(readme, /VLLM_CC_PROXY_API_KEY/);
  assert.match(readme, /VLLM_OPENAI_PROXY_API_KEY/);
  assert.match(readme, /完整.*Attempt.*丟棄|整份.*Attempt.*丟棄/s);
  assert.match(readme, /OpenAI Tool Passthrough/i);
  assert.match(readme, /不可逆 commit boundary|irreversible Tool boundary/i);
  assert.match(readme, /Claude Code.*Tool Recovery/i);
  assert.match(readme, /System Message.*messages\[0\]|messages\[0\].*System Message/i);
  assert.match(readme, /response\.incomplete.*原樣|status=.incomplete..*原樣|incomplete.*HTTP 200/is);
  assert.match(readme, /terminal.*Think Loop.*優先|action boundary.*關閉 Loop Guard/is);
  assert.match(readme, /LOOP_MIN_COUNT.*3/is);
  assert.match(readme, /RESPONSES_BEHAVIOR_MODE.*transparent/is);
  assert.match(readme, /RESPONSES_UPSTREAM_MODE.*native/is);
  assert.match(readme, /RESPONSES_TOOL_CHOICE_POLICY.*preserve/is);
  assert.match(readme, /actionless_completion|Actionless Completion/i);
  assert.match(readme, /tool_choice.*required/is);
  assert.match(readme, /no-op.*Edit|Edit.*no-op/i);
  assert.match(readme, /CLAUDE_CODE_TOOL_RECOVERY_ENABLED/);
  assert.match(readme, /CLAUDE_CODE_ACTION_INTENT_GUARD_ENABLED/);
  assert.match(readme, /CLAUDE_CODE_PLACEHOLDER_COMPLETION_GUARD_ENABLED/);
  assert.match(readme, /CLAUDE_CODE_TOOL_INPUT_SCHEMA_GUARD_ENABLED/);
  assert.match(readme, /CLAUDE_CODE_TARGETED_SCHEMA_CORRECTION_ENABLED/);
  assert.match(readme, /CLAUDE_CODE_TOOL_STOP_REASON_NORMALIZATION_ENABLED/);
  assert.match(readme, /invalid_tool_input_schema/);
  assert.match(readme, /tool_input_schema_recovery_started/);
  assert.match(readme, /tool_input_schema_correction_started/);
  assert.match(readme, /schema_correction/);
  assert.match(readme, /tool_stop_reason_normalized/);
  assert.match(readme, /placeholder_completion_without_progress/);
  assert.match(readme, /targetless_tool_recovery|Targetless Invalid Tool Recovery/i);
  assert.match(readme, /action_intent_without_tool_call/);
  assert.match(readme, /讓我測試 server|Let me test the TLS server/);
  assert.match(readme, /HTTP 422|422/);
  assert.match(readme, /client_retry_suppressed/);
  assert.match(readme, /thinking_without_output/);
  assert.match(readme, /Output-Required Recovery|output_required/i);
  assert.match(readme, /auto.*仍為 auto|auto.*remains.*auto/is);
  assert.match(readme, /繼續.*proceed|proceed.*繼續/s);
  assert.match(readme, /CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED/);
  assert.match(readme, /SearXNG/i);
  assert.match(readme, /web_search_20250305/);
  assert.match(readme, /anthropic_hosted_web_search_adapted/);
  assert.match(readme, /managed_web_tool_limit_repeated/);
  assert.match(readme, /WEBFETCH_HTML_PROVIDER/);
  assert.match(readme, /awesome-web-fetch/);
  assert.match(readme, /Browser.*Internal.*一次|Browser.*Internal.*one/is);
  assert.match(readme, /單一 Node\.js Gateway Process|單一.*JavaScript Gateway/s);
  assert.match(readme, /github\.com\/ericli1018\/vllm-proxy-suite/);
  assert.doesNotMatch(readme, /Nginx Gateway/);
});
