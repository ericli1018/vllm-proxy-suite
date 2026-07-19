#!/usr/bin/env node

import { loadCommonConfig, parseCsv } from '../../packages/core/config.js';
import { chatCompletionsAdapter } from '../../packages/openai/chat-completions.js';
import { responsesAdapter } from '../../packages/openai/responses.js';
import { buildOpenAiRecoveryRequest, validateForcedToolRecovery } from '../../packages/openai/recovery.js';
import { planNetworkRecovery } from '../../packages/openai/tool-classifier.js';
import { createProtocolProxyRuntime } from '../../packages/server/create-proxy-server.js';

export function loadOpenAiConfig(env = process.env) {
  const protocolEnv = {
    ...env,
    PROXY_API_KEY: env.VLLM_OPENAI_PROXY_API_KEY ?? env.PROXY_API_KEY,
  };
  return Object.freeze({
    ...loadCommonConfig(protocolEnv, { port: 3456 }),
    recoveryToolOptions: Object.freeze({
      lookupNames: parseCsv(env.RECOVERY_NETWORK_LOOKUP_TOOL_NAMES),
      downloadNames: parseCsv(env.RECOVERY_NETWORK_DOWNLOAD_TOOL_NAMES),
      hybridNames: parseCsv(env.RECOVERY_NETWORK_HYBRID_TOOL_NAMES),
    }),
  });
}

export function isOpenAiPassthroughPath(path) {
  return path.startsWith('/v1/')
    && path !== '/v1/messages'
    && path !== '/v1/messages/count_tokens';
}

function createRoute(adapter, api, config) {
  return {
    adapter,
    prepareRequest(body) {
      return structuredClone(body);
    },
    buildRecovery({ originalBody, reason }) {
      const context = api === 'responses'
        ? [originalBody.instructions || '', originalBody.input || '']
        : originalBody.messages || [];
      const plan = reason.kind === 'loop'
        ? planNetworkRecovery({ tools: originalBody.tools || [], context, options: config.recoveryToolOptions })
        : { mode: 'none', candidateNames: [] };
      return {
        body: buildOpenAiRecoveryRequest(originalBody, {
          api,
          reason: reason.reason,
          plan,
          config,
        }),
        plan,
      };
    },
    validateRecovery(attempt, recovery) {
      return validateForcedToolRecovery(adapter.extractOutput(attempt.result), recovery.plan);
    },
  };
}

function openAiRuntimeOptions({ config, fetchImpl, exposeControlRoutes = true }) {
  return {
    name: 'vllm-openai-proxy',
    metricPrefix: 'vllm_openai_proxy',
    config,
    fetchImpl,
    exposeControlRoutes,
    guardedRoutes: new Map([
      ['/v1/chat/completions', createRoute(chatCompletionsAdapter, 'chat', config)],
      ['/v1/responses', createRoute(responsesAdapter, 'responses', config)],
    ]),
    allowPassthrough: (path) => isOpenAiPassthroughPath(path),
    formatJsonError: (type, message, requestId, extra = {}) => ({
      error: {
        message,
        type,
        param: null,
        code: type,
        ...(requestId ? { request_id: requestId } : {}),
        ...extra,
      },
    }),
  };
}

export function createOpenAiProxyRuntime({ env = process.env, config = loadOpenAiConfig(env), fetchImpl = globalThis.fetch, exposeControlRoutes = true } = {}) {
  return createProtocolProxyRuntime(openAiRuntimeOptions({ config, fetchImpl, exposeControlRoutes }));
}
