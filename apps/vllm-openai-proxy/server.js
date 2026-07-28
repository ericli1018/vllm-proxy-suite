#!/usr/bin/env node

import { loadCommonConfig, parseBoolean, parseCsv } from '../../packages/core/config.js';
import { chatCompletionsAdapter } from '../../packages/openai/chat-completions.js';
import { responsesAdapter } from '../../packages/openai/responses.js';
import {
  convertResponsesRequestToChat,
  createResponsesChatAdapterFetch,
  prepareResponsesRequestForChatAdapter,
  responsesHostedToolDiagnostics,
} from '../../packages/openai/responses-chat-adapter.js';
import {
  assertChatMessageOrdering,
  buildOpenAiRecoveryRequest,
  inspectChatSystemMessages,
  validateForcedToolRecovery,
} from '../../packages/openai/recovery.js';
import { planNetworkRecovery } from '../../packages/openai/tool-classifier.js';
import { detectActionlessCompletion, summarizeOpenAiToolContext } from '../../packages/openai/actionless-completion.js';
import {
  applyResponsesToolChoicePolicy,
  normalizeResponsesToolChoicePolicy,
  responsesToolChoiceDiagnostics,
} from '../../packages/openai/responses-tool-choice-policy.js';
import { createProtocolProxyRuntime } from '../../packages/server/create-proxy-server.js';

export function loadOpenAiConfig(env = process.env) {
  const protocolEnv = {
    ...env,
    PROXY_API_KEY: env.VLLM_OPENAI_PROXY_API_KEY ?? env.PROXY_API_KEY,
  };
  const responsesBehaviorMode = (() => {
    const value = String(env.RESPONSES_BEHAVIOR_MODE ?? env.VLLM_PROXY_RESPONSES_BEHAVIOR_MODE ?? 'transparent').toLowerCase();
    return ['transparent', 'guarded'].includes(value) ? value : 'transparent';
  })();
  const malformedToolRetryConfigured = parseBoolean(
    env.RESPONSES_MALFORMED_TOOL_RETRY_ENABLED ?? env.VLLM_PROXY_RESPONSES_MALFORMED_TOOL_RETRY_ENABLED,
    true,
  );
  return Object.freeze({
    ...loadCommonConfig(protocolEnv, { port: 3456 }),
    responsesBehaviorMode,
    responsesUpstreamMode: (() => {
      const value = String(env.RESPONSES_UPSTREAM_MODE ?? env.VLLM_PROXY_RESPONSES_UPSTREAM_MODE ?? 'native').toLowerCase();
      return ['native', 'chat_adapter'].includes(value) ? value : 'native';
    })(),
    responsesToolChoicePolicy: normalizeResponsesToolChoicePolicy(
      env.RESPONSES_TOOL_CHOICE_POLICY ?? env.VLLM_PROXY_RESPONSES_TOOL_CHOICE_POLICY,
    ),
    responsesHostedToolPolicy: (() => {
      const value = String(env.RESPONSES_HOSTED_TOOL_POLICY ?? env.VLLM_PROXY_RESPONSES_HOSTED_TOOL_POLICY ?? 'drop_optional').toLowerCase();
      return ['drop_optional', 'reject', 'native_only'].includes(value) ? value : 'drop_optional';
    })(),
    responsesMalformedToolRetryEnabled: responsesBehaviorMode === 'guarded' && malformedToolRetryConfigured,
    responsesMalformedToolRecoveryMinTokens: (() => {
      const value = Number.parseInt(String(env.RESPONSES_MALFORMED_TOOL_RECOVERY_MIN_TOKENS ?? env.VLLM_PROXY_RESPONSES_MALFORMED_TOOL_RECOVERY_MIN_TOKENS ?? '1024'), 10);
      return Number.isSafeInteger(value) && value > 0 ? value : 1024;
    })(),
    responsesMalformedToolRecoveryTemperatureMax: (() => {
      const value = Number(env.RESPONSES_MALFORMED_TOOL_RECOVERY_TEMPERATURE_MAX ?? env.VLLM_PROXY_RESPONSES_MALFORMED_TOOL_RECOVERY_TEMPERATURE_MAX ?? 0.1);
      return Number.isFinite(value) && value >= 0 && value <= 2 ? value : 0.1;
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
  const behaviorGuardsEnabled = api !== 'responses' || config.responsesBehaviorMode === 'guarded';
  return {
    adapter,
    behaviorGuardsEnabled,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    transparentToolPassthrough: true,
    prepareRequest(body) {
      if (api === 'chat') assertChatMessageOrdering(body?.messages);
      if (api !== 'responses') return structuredClone(body);

      let prepared = config.responsesUpstreamMode === 'chat_adapter'
        ? prepareResponsesRequestForChatAdapter(body, { hostedToolPolicy: config.responsesHostedToolPolicy })
        : structuredClone(body);
      if (config.responsesUpstreamMode === 'chat_adapter') {
        convertResponsesRequestToChat(prepared, { hostedToolPolicy: config.responsesHostedToolPolicy });
      }
      prepared = applyResponsesToolChoicePolicy(prepared, {
        policy: config.responsesToolChoicePolicy,
      }).body;
      return prepared;
    },
    requestDiagnostics(body) {
      const hosted = api === 'responses' && config.responsesUpstreamMode === 'chat_adapter'
        ? responsesHostedToolDiagnostics(body)
        : null;
      const toolChoice = api === 'responses' ? responsesToolChoiceDiagnostics(body) : null;
      return {
        ...summarizeOpenAiToolContext(body),
        ...(api === 'responses' ? {
          responsesUpstreamMode: config.responsesUpstreamMode,
          responsesBehaviorMode: config.responsesBehaviorMode,
          responsesToolChoicePolicy: config.responsesToolChoicePolicy,
          responsesHostedToolPolicy: config.responsesHostedToolPolicy,
          ...(toolChoice || {}),
          ...(hosted || {}),
        } : {}),
      };
    },
    onPreparedRequest({ body, metrics, logger }) {
      if (api !== 'responses') return;
      const toolChoice = responsesToolChoiceDiagnostics(body);
      if (toolChoice?.toolChoiceRewritten) {
        metrics.toolChoiceRewritesTotal += 1;
        logger.info('responses_tool_choice_rewritten', toolChoice);
      }
      if (config.responsesUpstreamMode !== 'chat_adapter') return;
      const hosted = responsesHostedToolDiagnostics(body);
      if (!hosted.droppedToolCount) return;
      metrics.hostedToolsFilteredTotal += hosted.droppedToolCount;
      logger.info('responses_hosted_tools_filtered', {
        hostedToolPolicy: hosted.hostedToolPolicy,
        droppedToolTypes: hosted.droppedToolTypes,
        droppedToolCount: hosted.droppedToolCount,
        remainingToolCount: hosted.remainingToolCount,
        requestContinued: true,
      });
    },
    observeAttempt({ attempt, metrics, logger, attemptNumber, phase }) {
      if (api !== 'responses') return;
      const retryType = attempt?.headers?.get?.('x-vllm-proxy-chat-adapter-retry');
      if (retryType !== 'malformed_tool_arguments') return;
      const result = attempt.headers.get('x-vllm-proxy-chat-adapter-retry-result') || 'unknown';
      metrics.malformedToolRetriesTotal += 1;
      if (result !== 'success') metrics.malformedToolRetryFailuresTotal += 1;
      logger[result === 'success' ? 'info' : 'warn'](
        result === 'success' ? 'malformed_tool_arguments_retry_completed' : 'malformed_tool_arguments_retry_fused',
        { attempt: attemptNumber, phase, retryType, result },
      );
    },
    classifyAttempt(attempt) {
      if (api !== 'responses') return attempt;
      const retryType = attempt?.headers?.get?.('x-vllm-proxy-chat-adapter-retry');
      const result = attempt?.headers?.get?.('x-vllm-proxy-chat-adapter-retry-result');
      if (retryType !== 'malformed_tool_arguments' || result !== 'failed') return attempt;
      return {
        ...attempt,
        kind: 'http_error',
        status: 400,
        reason: 'malformed_required_tool_arguments',
        retryable: false,
        diagnostics: {
          ...(attempt.diagnostics || {}),
          malformedToolRetryAttempted: true,
          malformedToolRetryResult: 'failed',
        },
      };
    },
    validateAttempt(attempt, { firstBody, recovery = false }) {
      if (api !== 'responses' || !behaviorGuardsEnabled || !config.actionlessCompletionGuardEnabled) return { ok: true };
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
    ? createResponsesChatAdapterFetch(fetchImpl, {
      hostedToolPolicy: config.responsesHostedToolPolicy,
      malformedToolRetryEnabled: config.responsesMalformedToolRetryEnabled,
      malformedToolRecoveryMinTokens: config.responsesMalformedToolRecoveryMinTokens,
      malformedToolRecoveryTemperatureMax: config.responsesMalformedToolRecoveryTemperatureMax,
    })
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
