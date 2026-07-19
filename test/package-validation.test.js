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
  assert.equal(report.version, '0.5.3');
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
  assert.match(readme, /no-op.*Edit|Edit.*no-op/i);
  assert.match(readme, /CLAUDE_CODE_TOOL_RECOVERY_ENABLED/);
  assert.match(readme, /單一 Node\.js Gateway Process|單一.*JavaScript Gateway/s);
  assert.match(readme, /github\.com\/ericli1018\/vllm-proxy-suite/);
  assert.doesNotMatch(readme, /Nginx Gateway/);
});
