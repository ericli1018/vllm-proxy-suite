#!/usr/bin/env node

import { loadCommonConfig, parseBoolean, parseCsv, trimTrailingSlash } from '../../packages/core/config.js';
import { anthropicMessagesAdapter, applyAnthropicRequestPolicy, buildAnthropicRecoveryRequest, normalizeAnthropicToolStopReason } from '../../packages/anthropic/messages.js';
import {
  analyzeClaudeCodeToolAttempt,
  buildClaudeCodeSchemaCorrectionRecovery,
  buildClaudeCodeToolRecovery,
  isTargetedToolInputSchemaCorrectionIssue,
  isTargetlessClaudeCodeToolRecoveryIssue,
  validateClaudeCodeSchemaCorrectionRecovery,
  validateClaudeCodeToolRecovery,
  validateExposedClaudeCodeToolCalls,
} from '../../packages/anthropic/claude-code-tools/recovery.js';
import { createProtocolProxyRuntime } from '../../packages/server/create-proxy-server.js';
import { createAnthropicManagedWebToolsFetch } from '../../packages/anthropic/managed-web-tools.js';
import {
  buildAnthropicActionRequiredRecovery,
  buildAnthropicOutputRequiredRecovery,
  detectAnthropicActionIntentWithoutToolCall,
  detectAnthropicPlaceholderCompletionWithoutProgress,
  summarizeAnthropicExecutionContext,
  summarizeAnthropicToolContext,
  validateAnthropicActionRequiredRecovery,
  validateAnthropicOutputRequiredRecovery,
} from '../../packages/anthropic/action-intent.js';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}


function enumValue(value, allowed, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function loadAnthropicConfig(env = process.env) {
  const protocolEnv = {
    ...env,
    PROXY_API_KEY: env.VLLM_CC_PROXY_API_KEY ?? env.PROXY_API_KEY,
  };
  return Object.freeze({
    ...loadCommonConfig(protocolEnv, { port: 3456 }),
    defaultEnableThinking: parseBoolean(env.DEFAULT_ENABLE_THINKING, true),
    defaultMaxTokens: positiveInteger(env.DEFAULT_MAX_TOKENS, 8192),
    claudeCodeToolRecoveryEnabled: parseBoolean(env.CLAUDE_CODE_TOOL_RECOVERY_ENABLED, true),
    claudeCodeActionIntentGuardEnabled: parseBoolean(env.CLAUDE_CODE_ACTION_INTENT_GUARD_ENABLED, true),
    claudeCodePlaceholderCompletionGuardEnabled: parseBoolean(env.CLAUDE_CODE_PLACEHOLDER_COMPLETION_GUARD_ENABLED, true),
    claudeCodeToolInputSchemaGuardEnabled: parseBoolean(env.CLAUDE_CODE_TOOL_INPUT_SCHEMA_GUARD_ENABLED, true),
    claudeCodeTargetedSchemaCorrectionEnabled: parseBoolean(env.CLAUDE_CODE_TARGETED_SCHEMA_CORRECTION_ENABLED, true),
    claudeCodeToolStopReasonNormalizationEnabled: parseBoolean(env.CLAUDE_CODE_TOOL_STOP_REASON_NORMALIZATION_ENABLED, true),
    claudeCodeEditRecoveryEnabled: parseBoolean(env.CLAUDE_CODE_EDIT_RECOVERY_ENABLED, true),
    claudeCodeWriteRecoveryEnabled: parseBoolean(env.CLAUDE_CODE_WRITE_RECOVERY_ENABLED, true),
    claudeCodeNotebookEditRecoveryEnabled: parseBoolean(env.CLAUDE_CODE_NOTEBOOK_EDIT_RECOVERY_ENABLED, true),
    claudeCodeBashInvalidatesReads: parseBoolean(env.CLAUDE_CODE_BASH_INVALIDATES_READS, true),
    managedWebSearchEnabled: parseBoolean(env.CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED, false),
    managedWebSearchToolNames: parseCsv(env.CLAUDE_CODE_WEBSEARCH_TOOL_NAMES || 'WebSearch'),
    managedWebFetchEnabled: parseBoolean(env.CLAUDE_CODE_WEBFETCH_BRIDGE_ENABLED, false),
    managedWebFetchToolNames: parseCsv(env.CLAUDE_CODE_WEBFETCH_TOOL_NAMES || 'WebFetch'),
    managedWebToolsThink: parseBoolean(env.MANAGED_WEB_TOOLS_THINK, false),
    managedWebToolsMaxBatch: positiveInteger(env.MANAGED_WEB_TOOLS_MAX_BATCH, 8),
    managedWebStreamProgressMode: enumValue(env.MANAGED_WEB_STREAM_PROGRESS_MODE, ['visible', 'minimal', 'invisible', 'off'], 'visible'),
    managedWebStreamProgressDetail: enumValue(env.MANAGED_WEB_STREAM_PROGRESS_DETAIL, ['query', 'tool'], 'query'),
    managedWebStreamProgressIntervalMs: positiveInteger(env.MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS, 5000),
    managedWebStreamProgressMaxLabelChars: boundedInteger(env.MANAGED_WEB_STREAM_PROGRESS_MAX_LABEL_CHARS, 160, 16, 1000),
    managedWebStreamProgressMaxDots: boundedInteger(env.MANAGED_WEB_STREAM_PROGRESS_MAX_DOTS, 12, 0, 100),
    webSearchMaxParallel: positiveInteger(env.WEBSEARCH_MAX_PARALLEL, 2),
    webFetchMaxParallel: positiveInteger(env.WEBFETCH_MAX_PARALLEL, 2),
    searxngBaseUrl: trimTrailingSlash(env.SEARXNG_BASE_URL || ''),
    searxngApiKey: env.SEARXNG_API_KEY || '',
    searxngTimeoutMs: positiveInteger(env.SEARXNG_TIMEOUT_MS, 10000),
    searxngMaxUses: positiveInteger(env.SEARXNG_MAX_USES, 5),
    searxngMaxResults: positiveInteger(env.SEARXNG_MAX_RESULTS, 8),
    searxngMaxResultBytes: positiveInteger(env.SEARXNG_MAX_RESULT_BYTES, 16384),
    searxngMaxResponseBytes: positiveInteger(env.SEARXNG_MAX_RESPONSE_BYTES, 2097152),
    searxngMaxSnippetChars: positiveInteger(env.SEARXNG_MAX_SNIPPET_CHARS, 600),
    searxngMaxTitleChars: positiveInteger(env.SEARXNG_MAX_TITLE_CHARS, 300),
    searxngMaxQueryChars: positiveInteger(env.SEARXNG_MAX_QUERY_CHARS, 1024),
    searxngLanguage: env.SEARXNG_LANGUAGE || 'all',
    searxngCategories: parseCsv(env.SEARXNG_CATEGORIES || 'general'),
    searxngSafeSearch: boundedInteger(env.SEARXNG_SAFE_SEARCH, 0, 0, 2),
    webFetchTimeoutMs: positiveInteger(env.WEBFETCH_TIMEOUT_MS, 20000),
    webFetchMaxUses: positiveInteger(env.WEBFETCH_MAX_USES, 3),
    webFetchMaxRedirects: boundedInteger(env.WEBFETCH_MAX_REDIRECTS, 5, 0, 20),
    webFetchMaxDownloadBytes: positiveInteger(env.WEBFETCH_MAX_DOWNLOAD_BYTES, 20971520),
    webFetchMaxExtractedChars: positiveInteger(env.WEBFETCH_MAX_EXTRACTED_CHARS, 2000000),
    webFetchMaxPromptChars: positiveInteger(env.WEBFETCH_MAX_PROMPT_CHARS, 4000),
    webFetchReaderChunkChars: positiveInteger(env.WEBFETCH_READER_CHUNK_CHARS, 18000),
    webFetchReaderChunkOverlapChars: positiveInteger(env.WEBFETCH_READER_CHUNK_OVERLAP_CHARS, 600),
    webFetchReaderMaxChunks: positiveInteger(env.WEBFETCH_READER_MAX_CHUNKS, 32),
    webFetchPdfPagesPerChunk: positiveInteger(env.WEBFETCH_PDF_PAGES_PER_CHUNK, 1),
    webFetchPdfMaxPages: positiveInteger(env.WEBFETCH_PDF_MAX_PAGES, 100),
    webFetchPdfExtractTimeoutMs: positiveInteger(env.WEBFETCH_PDF_EXTRACT_TIMEOUT_MS, 30000),
    webFetchReaderMaxTokens: positiveInteger(env.WEBFETCH_READER_MAX_TOKENS, 800),
    webFetchSynthesisMaxTokens: positiveInteger(env.WEBFETCH_SYNTHESIS_MAX_TOKENS, 1600),
    webFetchSynthesisInputMaxChars: positiveInteger(env.WEBFETCH_SYNTHESIS_INPUT_MAX_CHARS, 200000),
    webFetchResultMaxBytes: positiveInteger(env.WEBFETCH_RESULT_MAX_BYTES, 65536),
    webFetchModelTimeoutMs: positiveInteger(env.WEBFETCH_MODEL_TIMEOUT_MS, 180000),
    webFetchModelResponseMaxBytes: positiveInteger(env.WEBFETCH_MODEL_RESPONSE_MAX_BYTES, 1048576),
  });
}

export function createAnthropicGuardedRoute(config, options = {}) {
  return {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    managedStreamEnvelopeEnabled: Boolean(config.managedWebSearchEnabled || config.managedWebFetchEnabled),
    adapter: anthropicMessagesAdapter,
    prepareRequest(body) {
      return applyAnthropicRequestPolicy(body, config);
    },
    requestDiagnostics(body, { originalBody }) {
      const incoming = summarizeAnthropicToolContext(originalBody);
      const upstream = summarizeAnthropicToolContext(body);
      const execution = summarizeAnthropicExecutionContext(originalBody);
      return {
        ...execution,
        incomingToolCount: incoming.requestToolCount,
        incomingToolNames: incoming.requestToolNames,
        incomingToolChoice: incoming.requestToolChoice,
        incomingToolsEnabled: incoming.requestToolsEnabled,
        upstreamToolCount: upstream.requestToolCount,
        upstreamToolNames: upstream.requestToolNames,
        upstreamToolChoice: upstream.requestToolChoice,
        upstreamToolsEnabled: upstream.requestToolsEnabled,
        toolSetPreserved: JSON.stringify(incoming.requestToolNames) === JSON.stringify(upstream.requestToolNames),
      };
    },
    validateAttempt(attempt, { originalBody, firstBody, recovery = false }) {
      const output = anthropicMessagesAdapter.extractOutput(attempt.result);
      const toolValidation = analyzeClaudeCodeToolAttempt({
        request: originalBody,
        output,
        config,
      });
      if (!toolValidation.ok) {
        if (isTargetlessClaudeCodeToolRecoveryIssue(toolValidation)) {
          return {
            ...toolValidation,
            retryable: !recovery,
            diagnostics: {
              ...(toolValidation.diagnostics || {}),
              targetlessToolRecovery: true,
              targetlessToolRecoveryAttempted: Boolean(recovery),
              rejectedToolName: toolValidation.context?.toolName || null,
            },
          };
        }
        return toolValidation;
      }
      if (config.claudeCodeToolInputSchemaGuardEnabled) {
        const exposedToolValidation = validateExposedClaudeCodeToolCalls({ request: originalBody, output });
        if (!exposedToolValidation.ok) {
          return {
            ...exposedToolValidation,
            retryable: !recovery,
            diagnostics: {
              ...(exposedToolValidation.diagnostics || {}),
              targetedSchemaCorrection: Boolean(
                config.claudeCodeTargetedSchemaCorrectionEnabled
                && exposedToolValidation.diagnostics?.targetedSchemaCorrectionAvailable === true
              ),
              toolInputSchemaRecoveryAttempted: Boolean(recovery),
            },
          };
        }
      }
      const completion = anthropicMessagesAdapter.completionDiagnostics(attempt.result);
      let normalization = null;
      if (
        config.claudeCodeToolStopReasonNormalizationEnabled
        && completion.stopReason === 'end_turn'
        && output.toolCalls.length > 0
      ) {
        const exposedToolValidation = validateExposedClaudeCodeToolCalls({ request: originalBody, output });
        if (!exposedToolValidation.ok) {
          return {
            ok: false,
            reason: 'tool_stop_reason_mismatch',
            detail: 'Tool stop reason cannot be normalized because the Tool Call is not fully valid.',
            retryable: false,
            diagnostics: {
              messageStopped: completion.messageStopped,
              stopReason: completion.stopReason,
              toolCallCount: output.toolCalls.length,
              toolNames: output.toolCalls.map((call) => call.name),
              toolValidationReason: exposedToolValidation.reason,
              toolValidationDetail: exposedToolValidation.detail,
            },
          };
        }
        normalization = normalizeAnthropicToolStopReason(attempt);
        if (!normalization.applied) {
          return {
            ok: false,
            reason: 'tool_stop_reason_mismatch',
            detail: 'Validated Tool Call stop reason could not be rewritten safely.',
            retryable: false,
            diagnostics: {
              messageStopped: completion.messageStopped,
              stopReason: completion.stopReason,
              toolCallCount: output.toolCalls.length,
              toolNames: output.toolCalls.map((call) => call.name),
              normalizationRewriteFailed: true,
              ...normalization,
            },
          };
        }
      }
      const normalizedCompletion = anthropicMessagesAdapter.completionDiagnostics(attempt.result);
      if (config.claudeCodePlaceholderCompletionGuardEnabled) {
        const placeholderValidation = detectAnthropicPlaceholderCompletionWithoutProgress({
          requestBody: firstBody || originalBody,
          output,
          completion: normalizedCompletion,
          recovery,
        });
        if (!placeholderValidation.ok) return placeholderValidation;
      }
      if (!config.claudeCodeActionIntentGuardEnabled) return { ok: true, normalization };
      const actionValidation = detectAnthropicActionIntentWithoutToolCall({
        requestBody: firstBody || originalBody,
        output,
        completion: normalizedCompletion,
        recovery,
      });
      return actionValidation.ok ? { ...actionValidation, normalization } : actionValidation;
    },
    classifyAttempt(attempt, { phase, recovery }) {
      if (
        phase !== 'recovery'
        || !['action_required', 'output_required'].includes(recovery?.plan?.mode)
        || attempt.kind === 'success'
        || attempt.kind === 'tool_passthrough'
      ) return attempt;

      const actionRequired = recovery.plan.mode === 'action_required';
      if (!actionRequired && attempt.reason !== 'thinking_without_output') return attempt;

      const originReason = recovery.plan.originReason
        || (actionRequired ? 'action_intent_without_tool_call' : 'thinking_without_output');
      return {
        ...attempt,
        kind: 'invalid',
        reason: originReason,
        detail: actionRequired
          ? 'The action-required Recovery ended without a Tool Call.'
          : 'The output-required Recovery ended without visible output or a Tool Call.',
        retryable: false,
        diagnostics: {
          ...(attempt.diagnostics || {}),
          requestToolCount: recovery.plan.candidateNames?.length || 0,
          requestToolNames: recovery.plan.candidateNames || [],
          ...(actionRequired
            ? { actionIntentRecoveryAttempted: true }
            : { outputRecoveryAttempted: true }),
          recoveryOriginReason: originReason,
          recoveryFailureKind: attempt.kind,
          recoveryFailureReason: attempt.reason || attempt.loopInfo?.reason || 'recovery_failed',
        },
      };
    },
    buildRecovery({ originalBody, firstBody, reason }) {
      const toolContext = summarizeAnthropicToolContext(originalBody);
      const actionRequired = config.claudeCodeActionIntentGuardEnabled
        && toolContext.requestToolsEnabled
        && reason?.reason === 'action_intent_without_tool_call';
      if (actionRequired) {
        return buildAnthropicActionRequiredRecovery({
          original: originalBody,
          prepared: firstBody || applyAnthropicRequestPolicy(originalBody, config),
          issue: reason,
          config,
        });
      }
      if (
        config.claudeCodeToolInputSchemaGuardEnabled
        && config.claudeCodeTargetedSchemaCorrectionEnabled
        && isTargetedToolInputSchemaCorrectionIssue(reason)
      ) {
        return buildClaudeCodeSchemaCorrectionRecovery({
          original: originalBody,
          prepared: firstBody || applyAnthropicRequestPolicy(originalBody, config),
          issue: reason,
          config,
        });
      }
      if (
        ['thinking_without_output', 'placeholder_completion_without_progress'].includes(reason?.reason)
        || (config.claudeCodeToolInputSchemaGuardEnabled && reason?.reason === 'invalid_tool_input_schema')
        || (config.claudeCodeToolRecoveryEnabled && isTargetlessClaudeCodeToolRecoveryIssue(reason))
      ) {
        return buildAnthropicOutputRequiredRecovery({
          original: originalBody,
          prepared: firstBody || applyAnthropicRequestPolicy(originalBody, config),
          issue: reason,
          config,
        });
      }
      if (reason?.context && config.claudeCodeToolRecoveryEnabled) {
        return buildClaudeCodeToolRecovery({
          original: originalBody,
          prepared: firstBody || applyAnthropicRequestPolicy(originalBody, config),
          issue: reason,
          config,
        });
      }
      return { body: buildAnthropicRecoveryRequest(originalBody, reason.reason, config), plan: null };
    },
    validateRecovery(attempt, recovery) {
      if (!recovery.plan) return { ok: true };
      const output = anthropicMessagesAdapter.extractOutput(attempt.result);
      if (recovery.plan.mode === 'action_required') {
        return validateAnthropicActionRequiredRecovery(output, recovery.plan);
      }
      if (recovery.plan.mode === 'output_required') {
        return validateAnthropicOutputRequiredRecovery(output, recovery.plan);
      }
      if (recovery.plan.mode === 'schema_correction') {
        return validateClaudeCodeSchemaCorrectionRecovery(output, recovery.plan);
      }
      return validateClaudeCodeToolRecovery(output, recovery.plan);
    },
    observeAttempt({ attempt, metrics, logger, attemptNumber, phase }) {
      const uses = Number.parseInt(attempt?.headers?.get?.('x-vllm-proxy-managed-websearch-uses') || '0', 10) || 0;
      const failures = Number.parseInt(attempt?.headers?.get?.('x-vllm-proxy-managed-websearch-failures') || '0', 10) || 0;
      const limitReached = attempt?.headers?.get?.('x-vllm-proxy-managed-websearch-limit-reached') === 'true';
      const fetchUses = Number.parseInt(attempt?.headers?.get?.('x-vllm-proxy-managed-webfetch-uses') || '0', 10) || 0;
      const fetchFailures = Number.parseInt(attempt?.headers?.get?.('x-vllm-proxy-managed-webfetch-failures') || '0', 10) || 0;
      const fetchLimitReached = attempt?.headers?.get?.('x-vllm-proxy-managed-webfetch-limit-reached') === 'true';
      const fetchChunks = Number.parseInt(attempt?.headers?.get?.('x-vllm-proxy-managed-webfetch-chunks') || '0', 10) || 0;
      if (uses > 0 || failures > 0 || limitReached) {
        metrics.managedWebSearchExecutionsTotal += uses;
        metrics.managedWebSearchFailuresTotal += failures;
        if (limitReached) metrics.managedWebSearchLimitsTotal += 1;
        logger.info('managed_websearch_completed', { attempt: attemptNumber, phase, uses, failures, limitReached });
      }
      if (fetchUses > 0 || fetchFailures > 0 || fetchLimitReached) {
        metrics.managedWebFetchExecutionsTotal += fetchUses;
        metrics.managedWebFetchFailuresTotal += fetchFailures;
        metrics.managedWebFetchChunksTotal += fetchChunks;
        if (fetchLimitReached) metrics.managedWebFetchLimitsTotal += 1;
        logger.info('managed_webfetch_completed', {
          attempt: attemptNumber,
          phase,
          uses: fetchUses,
          failures: fetchFailures,
          chunks: fetchChunks,
          limitReached: fetchLimitReached,
        });
      }
    },
  };
}

function anthropicRuntimeOptions({ config, fetchImpl, exposeControlRoutes = true, logSink }) {
  const managedFetchImpl = (config.managedWebSearchEnabled || config.managedWebFetchEnabled)
    ? createAnthropicManagedWebToolsFetch(fetchImpl, config)
    : null;
  return {
    name: 'vllm-cc-proxy',
    metricPrefix: 'vllm_cc_proxy',
    config,
    fetchImpl,
    exposeControlRoutes,
    logSink,
    guardedRoutes: new Map([[
      '/v1/messages',
      createAnthropicGuardedRoute(config, { fetchImpl: managedFetchImpl }),
    ]]),
    allowPassthrough: (path) => path === '/v1/messages/count_tokens',
    formatJsonError: (type, message, requestId, extra = {}) => ({
      type: 'error',
      error: { type, message, ...extra },
      ...(requestId ? { request_id: requestId } : {}),
    }),
  };
}

export function createAnthropicProxyRuntime({ env = process.env, config = loadAnthropicConfig(env), fetchImpl = globalThis.fetch, exposeControlRoutes = true, logSink } = {}) {
  return createProtocolProxyRuntime(anthropicRuntimeOptions({ config, fetchImpl, exposeControlRoutes, logSink }));
}
