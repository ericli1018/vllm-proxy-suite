#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { createAnthropicProxyRuntime, loadAnthropicConfig } from '../vllm-cc-proxy/server.js';
import { createOpenAiProxyRuntime, loadOpenAiConfig } from '../vllm-openai-proxy/server.js';
import { jsonResponse } from '../../packages/core/http.js';
import { createManagedHttpServer } from '../../packages/server/create-proxy-server.js';

function parseListenerPort(value, fallback = 3456) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) return fallback;
  return parsed;
}

export function classifyGatewayPath(path) {
  if (path === '/v1/messages' || path === '/v1/messages/count_tokens') return 'anthropic';
  if (path.startsWith('/v1/')) return 'openai';
  return null;
}

export function loadSuiteConfig(env = process.env) {
  const anthropic = loadAnthropicConfig(env);
  const openai = loadOpenAiConfig(env);
  return Object.freeze({
    host: env.PROXY_HOST || '0.0.0.0',
    port: parseListenerPort(env.PROXY_PORT, 3456),
    shutdownGraceMs: Math.max(anthropic.shutdownGraceMs, openai.shutdownGraceMs),
    logLevel: env.LOG_LEVEL || 'info',
    anthropic,
    openai,
  });
}

function sendTextMetrics(response, bodyText) {
  const body = Buffer.from(bodyText);
  response.writeHead(200, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'content-length': String(body.length),
  });
  response.end(body);
}

function notFound(response) {
  jsonResponse(response, 404, {
    error: {
      message: 'unsupported gateway path',
      type: 'not_found',
      param: null,
      code: 'not_found',
    },
  });
}

export function createVllmProxySuiteServer({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = loadSuiteConfig(env);
  const anthropic = createAnthropicProxyRuntime({
    config: config.anthropic,
    fetchImpl,
    exposeControlRoutes: false,
  });
  const openai = createOpenAiProxyRuntime({
    config: config.openai,
    fetchImpl,
    exposeControlRoutes: false,
  });
  let draining = false;

  const handler = async (request, response) => {
    request.socket.setKeepAlive(true, 15000);
    request.socket.setNoDelay(true);
    const path = new URL(request.url || '/', 'http://gateway.local').pathname;

    if (request.method === 'GET' && path === '/health/live') {
      return jsonResponse(response, 200, { status: 'ok', service: 'vllm-proxy-suite' });
    }
    if (request.method === 'GET' && path === '/health/ready') {
      return jsonResponse(response, draining ? 503 : 200, {
        status: draining ? 'draining' : 'ready',
        service: 'vllm-proxy-suite',
      });
    }
    if (request.method === 'GET' && path === '/health/cc') {
      return jsonResponse(response, anthropic.isDraining() ? 503 : 200, {
        status: anthropic.isDraining() ? 'draining' : 'ready',
        service: anthropic.name,
      });
    }
    if (request.method === 'GET' && path === '/health/openai') {
      return jsonResponse(response, openai.isDraining() ? 503 : 200, {
        status: openai.isDraining() ? 'draining' : 'ready',
        service: openai.name,
      });
    }
    if (request.method === 'GET' && path === '/metrics') {
      return sendTextMetrics(response, `${anthropic.renderMetrics()}${openai.renderMetrics()}`);
    }
    if (request.method === 'GET' && path === '/metrics/cc') {
      return sendTextMetrics(response, anthropic.renderMetrics());
    }
    if (request.method === 'GET' && path === '/metrics/openai') {
      return sendTextMetrics(response, openai.renderMetrics());
    }

    const protocol = classifyGatewayPath(path);
    if (protocol === 'anthropic') return anthropic.handle(request, response);
    if (protocol === 'openai') return openai.handle(request, response);
    return notFound(response);
  };

  const managed = createManagedHttpServer({ handler, config });
  const beginDrain = () => {
    if (draining) return;
    draining = true;
    anthropic.beginDrain();
    openai.beginDrain();
  };
  return {
    ...managed,
    config,
    anthropic,
    openai,
    beginDrain,
    isDraining() { return draining; },
    async stop() {
      beginDrain();
      await managed.stop();
    },
  };
}

export async function main() {
  const suite = createVllmProxySuiteServer();
  const url = await suite.start();
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event: 'listening', service: 'vllm-proxy-suite', url })}\n`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    suite.beginDrain();
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event: 'draining', service: 'vllm-proxy-suite', signal })}\n`);
    await suite.stop();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
  process.once('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}
