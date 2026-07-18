import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('JavaScript gateway is the only deployed listener and Nginx is absent', async () => {
  const compose = await read('docker-compose.partial.yaml');
  assert.match(compose, /^  vllm-proxy-suite:/m);
  const services = compose.split(/^services:\s*$/m)[1] || '';
  assert.equal((services.match(/^  [a-zA-Z0-9_-]+:/gm) || []).length, 1);
  assert.equal((compose.match(/ports:/g) || []).length, 1);
  assert.match(compose, /- "3456:3456"/);
  assert.doesNotMatch(compose, /nginx/i);
  assert.doesNotMatch(compose, /3457|3458/);
  assert.match(compose, /node \/app\/vllm-proxy-suite\.js/);
});

test('Compose synchronizes the requested GitHub repository into the named volume', async () => {
  const compose = await read('docker-compose.partial.yaml');
  assert.match(compose, /https:\/\/github\.com\/ericli1018\/vllm-proxy-suite\.git/);
  assert.match(compose, /^  vllm-proxy-suite:$/m);
  assert.match(compose, /vllm-proxy-suite:\/app/);
  assert.match(compose, /git clone/);
  assert.match(compose, /git -C \/app pull --ff-only/);
});

test('Compose exposes both protocol-specific API keys on the single service', async () => {
  const compose = await read('docker-compose.partial.yaml');
  for (const name of [
    'VLLM_CC_PROXY_API_KEY',
    'VLLM_OPENAI_PROXY_API_KEY',
    'CLAUDE_CODE_TOOL_RECOVERY_ENABLED',
    'RECOVERY_NETWORK_LOOKUP_TOOL_NAMES',
  ]) {
    assert.match(compose, new RegExp(name));
  }
});

test('Dockerfile starts the JavaScript suite gateway as non-root', async () => {
  const dockerfile = await read('Dockerfile');
  assert.match(dockerfile, /FROM node:22-alpine/);
  assert.match(dockerfile, /COPY --chown=node:node/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /vllm-proxy-suite\.js/);
  assert.doesNotMatch(dockerfile, /nginx/i);
});
