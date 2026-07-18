#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const required = [
  'README.md',
  'docs/observability.md',
  'CHANGELOG.md',
  'package.json',
  'Dockerfile',
  'docker-compose.partial.yaml',
  'apps/gateway/server.js',
  'apps/vllm-cc-proxy/server.js',
  'apps/vllm-openai-proxy/server.js',
  'packages/core/attempt-runner.js',
  'packages/core/buffer-budget.js',
  'packages/core/config.js',
  'packages/core/loop-detector.js',
  'packages/core/sse.js',
  'packages/core/tool-correlation.js',
  'packages/anthropic/messages.js',
  'packages/anthropic/claude-code-tools/recovery.js',
  'packages/openai/chat-completions.js',
  'packages/openai/responses.js',
  'packages/openai/recovery.js',
  'packages/openai/tool-classifier.js',
  'packages/server/create-proxy-server.js',
  'vllm-proxy-suite.js',
];

const errors = [];
for (const path of required) {
  try {
    const stat = statSync(resolve(root, path));
    if (!stat.isFile() || stat.size === 0) errors.push(`required file is empty: ${path}`);
  } catch {
    errors.push(`required file is missing: ${path}`);
  }
}

try {
  statSync(resolve(root, 'apps/gateway/nginx.conf'));
  errors.push('Nginx gateway configuration must not be present');
} catch {
  // Expected: the gateway is implemented in JavaScript.
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (packageJson.name !== 'vllm-proxy-suite') errors.push('package.json name must be vllm-proxy-suite');
if (packageJson.type !== 'module') errors.push('package.json type must be module');
if (packageJson.engines?.node !== '>=22') errors.push('Node.js engine must be >=22');
if (packageJson.version !== '0.5.0') errors.push('package.json version must be 0.5.0');

const compose = readFileSync(resolve(root, 'docker-compose.partial.yaml'), 'utf8');
if (!compose.includes('https://github.com/ericli1018/vllm-proxy-suite.git')) errors.push('Compose repository URL is incorrect');
if (!compose.includes('git clone')) errors.push('Compose must initialize the named volume from GitHub');
if (compose.includes('git config --global --add safe.directory /app')) errors.push('Compose must not rely on global safe.directory state');
if (!compose.includes('git -c safe.directory=/app -C /app fetch --force --prune origin')) errors.push('Compose must fetch with command-local safe.directory');
if (!compose.includes('git -c safe.directory=/app -C /app reset --hard FETCH_HEAD')) errors.push('Compose must reset with command-local safe.directory');
if (!compose.includes('git -c safe.directory=/app -C /app clean -fdx')) errors.push('Compose must clean with command-local safe.directory');
if (compose.includes('git -C /app pull')) errors.push('Compose must not use git pull for runtime synchronization');
if (/nginx/i.test(compose)) errors.push('Compose must not contain Nginx');
if (/3457|3458/.test(compose)) errors.push('Compose must not expose or reference internal protocol ports');
if (!/ports:[\s\S]*3456:3456/.test(compose)) errors.push('Suite service must publish port 3456');
if (!compose.includes('node /app/vllm-proxy-suite.js')) errors.push('Compose must start vllm-proxy-suite.js');
if (!compose.includes('VLLM_CC_PROXY_API_KEY')) errors.push('Compose must expose the Anthropic API key');
if (!compose.includes('VLLM_OPENAI_PROXY_API_KEY')) errors.push('Compose must expose the OpenAI API key');
if (!compose.includes('PROGRESS_LOG_INTERVAL_MS')) errors.push('Compose must expose progress logging interval');
if (!compose.includes('PROGRESS_STALL_WARNING_MS')) errors.push('Compose must expose stall warning threshold');
if (!compose.includes('LOG_FORMAT')) errors.push('Compose must expose log format');
if (!compose.includes('TOOL_CORRELATION_TTL_MS')) errors.push('Compose must expose tool correlation TTL');
if (!compose.includes('TOOL_CORRELATION_MAX_ENTRIES')) errors.push('Compose must expose tool correlation capacity');

const servicesPart = compose.split(/^services:\s*$/m)[1] || '';
const serviceNames = [...servicesPart.matchAll(/^  ([a-zA-Z0-9_-]+):$/gm)].map((match) => match[1]);
if (serviceNames.length !== 1 || serviceNames[0] !== 'vllm-proxy-suite') {
  errors.push(`Compose must define exactly one service named vllm-proxy-suite; found: ${serviceNames.join(', ')}`);
}

const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
if (!dockerfile.includes('CMD ["node", "/app/vllm-proxy-suite.js"]')) errors.push('Dockerfile must start the JavaScript Gateway');
if (!dockerfile.includes('USER node')) errors.push('Dockerfile must run as node user');

const gateway = readFileSync(resolve(root, 'apps/gateway/server.js'), 'utf8');
for (const route of ["path === '/v1/messages'", "path === '/v1/messages/count_tokens'", "path.startsWith('/v1/')"]) {
  if (!gateway.includes(route)) errors.push(`JavaScript Gateway route missing: ${route}`);
}
if (!gateway.includes('createAnthropicProxyRuntime')) errors.push('Gateway must load the Anthropic runtime in-process');
if (!gateway.includes('createOpenAiProxyRuntime')) errors.push('Gateway must load the OpenAI runtime in-process');

function collect(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.worktrees', 'tmp'].includes(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) collect(absolute, output);
    else output.push(relative(root, absolute).split(sep).join('/'));
  }
  return output;
}

const files = collect(root).sort();
const report = {
  project: 'VLLM-PROXY-SUITE',
  version: packageJson.version,
  architecture: 'single-process-javascript-gateway',
  repository: 'https://github.com/ericli1018/vllm-proxy-suite.git',
  valid: errors.length === 0,
  files: files.length,
  requiredFiles: required.length,
  errors,
};

process.stdout.write(`${JSON.stringify(report)}\n`);
if (errors.length) process.exitCode = 1;
