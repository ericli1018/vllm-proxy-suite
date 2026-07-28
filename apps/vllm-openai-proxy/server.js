#!/usr/bin/env node

import { loadCommonConfig, parseCsv } from '../../packages/core/config.js';
import { chatCompletionsAdapter } from '../../packages/openai/chat-completions.js';
import { responsesAdapter } from '../../packages/openai/responses.js';
import {
  convertResponsesRequestToChat,
  createResponsesChatAdapterFetch,
  normalizeResponsesRequestForChatAdapter,
} from '../../packages/openai/responses-chat-adapter.js';
import {
  assertChatMessageOrdering,
  buildOpenAiRecoveryRequest,
  inspectChatSystemMessages,
  validateForcedToolRecovery,
} from '../../packages/openai/recovery.js';
import { planNetworkRecovery } from '../../packages/openai/tool-classifier.js';
import { detectActionlessCompletion, summarizeOpenAiToolContext } from '../../packages/openai/actionless-completion.js';
import { createProtocolProxyRuntime } from '../../packages/server/create-proxy-server.js';

export function loadOpenAiConfig(env = process.env) {
  const protocolEnv = {
    ...env,
    PROXY_API_KEY: env.VLLM_OPENAI_PROXY_API_KEY ?? env.PROXY_API_KEY,
  };
  return Object.freeze({
    ...loadCommonConfig(protocolEnv, { port: 3456 }),
    responsesUpstreamMode: (() => {
      const value = String(env.RESPONSES_UPSTREAM_MODE ?? env.VLLM_PROXY_RESPONSES_UPSTREAM_MODE ?? 'chat_adapter').toLowerCase();
      return ['native', 'chat_adapter'].includes(value) ? value : 'chat_adapter';
    })(),
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

function createRoute(adapter, api, config, options = {}) {
  return {
    adapter,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    transparentToolPassthrough: true,
    prepareRequest(body) {
      if (api === 'chat') assertChatMessageOrdering(body?.messages);
      if (api === 'responses' && config.responsesUpstreamMode === 'chat_adapter') {
        const normalized = normalizeResponsesRequestForChatAdapter(body);
        convertResponsesRequestToChat(normalized);
        return normalized;
      }
      return structuredClone(body);
    },
    requestDiagnostics(body) {
      return { ...summarizeOpenAiToolContext(body), ...(api === 'responses' ? { responsesUpstreamMode: config.responsesUpstreamMode } : {}) };
    },
    validateAttempt(attempt, { firstBody, recovery = false }) {
      if (api !== 'responses' || !config.actionlessCompletionGuardEnabled) return { ok: true };
      return detectActionlessCompletion({
        requestBody: firstBody,
        output: adapter.extractOutput(attempt.result),
        completion: adapter.completionDiagnostics(attempt.result),
        recovery,
      });
    },
    buildRecovery({ originalBody, reason }) {
      const context = api === 'responses'
        ? [originalBody.instructions || '', originalBody.input || '']
        : originalBody.messages || [];
      const plan = reason.reason === 'actionless_completion'
        ? {
          mode: 'action_required',
          candidateNames: summarizeOpenAiToolContext(originalBody).requestToolNames,
        }
        : reason.kind === 'loop'
          ? planNetworkRecovery({ tools: originalBody.tools || [], context, options: config.recoveryToolOptions })
          : { mode: 'none', candidateNames: [] };
      const body = buildOpenAiRecoveryRequest(originalBody, {
          api,
          reason: reason.reason,
          plan,
          config,
        });
      const systemMessages = api === 'chat' ? inspectChatSystemMessages(body.messages) : null;
      return {
        body,
        plan,
        diagnostics: api === 'chat'
          ? {
            recoveryInstructionPlacement: originalBody.messages?.[0]?.role === 'system'
              ? 'merged_leading_system'
              : 'inserted_leading_system',
            messageCount: body.messages.length,
            systemMessageCount: systemMessages.count,
            systemMessageIndexes: systemMessages.indexes,
          }
          : {
            recoveryInstructionPlacement: 'instructions',
            recoveryMode: plan.mode,
            forcedToolChoice: plan.mode === 'action_required' ? 'required' : null,
          },
      };
    },
    validateRecovery(attempt, recovery) {
      return validateForcedToolRecovery(adapter.extractOutput(attempt.result), recovery.plan);
    },
  };
}

function openAiRuntimeOptions({ config, fetchImpl, exposeControlRoutes = true, logSink }) {
  const responsesFetchImpl = config.responsesUpstreamMode === 'chat_adapter'
    ? createResponsesChatAdapterFetch(fetchImpl)
    : null;
  return {
    name: 'vllm-openai-proxy',
    metricPrefix: 'vllm_openai_proxy',
    config,
    fetchImpl,
    exposeControlRoutes,
    logSink,
    guardedRoutes: new Map([
      ['/v1/chat/completions', createRoute(chatCompletionsAdapter, 'chat', config)],
      ['/v1/responses', createRoute(responsesAdapter, 'responses', config, { fetchImpl: responsesFetchImpl })],
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

export function createOpenAiProxyRuntime({ env = process.env, config = loadOpenAiConfig(env), fetchImpl = globalThis.fetch, exposeControlRoutes = true, logSink } = {}) {
  return createProtocolProxyRuntime(openAiRuntimeOptions({ config, fetchImpl, exposeControlRoutes, logSink }));
}
