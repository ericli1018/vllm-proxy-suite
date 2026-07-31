import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('JavaScript gateway is the only published listener and Nginx is absent', async () => {
  const compose = await read('docker-compose.partial.yaml');
  assert.match(compose, /^  vllm-proxy-suite:/m);
  const services = compose.split(/^services:\s*$/m)[1] || '';
  assert.deepEqual(
    (services.match(/^  [a-zA-Z0-9_-]+:/gm) || []).map((line) => line.trim().slice(0, -1)),
    ['vllm-proxy-suite', 'searxng'],
  );
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
  assert.doesNotMatch(compose, /git config --global --add safe\.directory \/app/);
  assert.match(compose, /git -c safe\.directory=\/app -C \/app fetch --force --prune origin/);
  assert.match(compose, /git -c safe\.directory=\/app -C \/app reset --hard FETCH_HEAD/);
  assert.match(compose, /git -c safe\.directory=\/app -C \/app clean -fdx/);
  assert.doesNotMatch(compose, /git -C \/app pull/);
});

test('Compose exposes both protocol-specific API keys on the gateway service', async () => {
  const compose = await read('docker-compose.partial.yaml');
  for (const name of [
    'VLLM_CC_PROXY_API_KEY',
    'MANAGED_WEB_TOOLS_MAX_BATCH',
    'MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS',
    'WEBSEARCH_MAX_PARALLEL',
    'WEBFETCH_MAX_PARALLEL',
    'VLLM_OPENAI_PROXY_API_KEY',
    'CLAUDE_CODE_TOOL_RECOVERY_ENABLED',
    'RECOVERY_NETWORK_LOOKUP_TOOL_NAMES',
    'TOOL_CORRELATION_TTL_MS',
    'TOOL_CORRELATION_MAX_ENTRIES',
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

test('Compose provides an opt-in SearXNG backend for the managed WebSearch bridge', async () => {
  const compose = await read('docker-compose.partial.yaml');
  assert.match(compose, /^  searxng:$/m);
  assert.match(compose, /image: docker\.io\/searxng\/searxng:\$\{SEARXNG_VERSION:-latest\}/);
  assert.match(compose, /profiles:\s*\n\s*- websearch/);
  assert.match(compose, /searxng-config:\/etc\/searxng/);
  assert.match(compose, /searxng-data:\/var\/cache\/searxng/);
  assert.match(compose, /use_default_settings: true/);
  assert.match(compose, /'  formats:'/);
  assert.match(compose, /'    - html'/);
  assert.match(compose, /'    - json'/);
  assert.match(compose, /SEARXNG_SECRET: "\$\{SEARXNG_SECRET:-\}"/);
  assert.match(compose, /secrets\.token_urlsafe\(48\)/);
  assert.match(compose, /secret_key:/);
  assert.match(compose, /\/usr\/local\/searxng\/entrypoint\.sh/);
  assert.match(compose, /http:\/\/127\.0\.0\.1:8080\//);
  assert.match(compose, /SEARXNG_BASE_URL: "\$\{SEARXNG_BASE_URL:-http:\/\/searxng:8080\}"/);

  const searxngService = compose.split(/^  searxng:$/m)[1] || '';
  assert.doesNotMatch(searxngService, /^    ports:/m);
  assert.match(searxngService, /^    networks:\s*\n\s*- vllm-test-network/m);
});
