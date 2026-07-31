#!/usr/bin/env node

import { loadCommonConfig, parseBoolean, parseCsv, trimTrailingSlash } from '../../packages/core/config.js';
import { anthropicMessagesAdapter, applyAnthropicRequestPolicy, buildAnthropicRecoveryRequest } from '../../packages/anthropic/messages.js';
import {
  analyzeClaudeCodeToolAttempt,
  buildClaudeCodeToolRecovery,
  validateClaudeCodeToolRecovery,
} from '../../packages/anthropic/claude-code-tools/recovery.js';
import { createProtocolProxyRuntime } from '../../packages/server/create-proxy-server.js';
import { createAnthropicManagedWebToolsFetch } from '../../packages/anthropic/managed-web-tools.js';

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
    validateAttempt(attempt, { originalBody }) {
      return analyzeClaudeCodeToolAttempt({
        request: originalBody,
        output: anthropicMessagesAdapter.extractOutput(attempt.result),
        config,
      });
    },
    buildRecovery({ originalBody, firstBody, reason }) {
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
      return validateClaudeCodeToolRecovery(
        anthropicMessagesAdapter.extractOutput(attempt.result),
        recovery.plan,
      );
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

function anthropicRuntimeOptions({ config, fetchImpl, exposeControlRoutes = true }) {
  const managedFetchImpl = (config.managedWebSearchEnabled || config.managedWebFetchEnabled)
    ? createAnthropicManagedWebToolsFetch(fetchImpl, config)
    : null;
  return {
    name: 'vllm-cc-proxy',
    metricPrefix: 'vllm_cc_proxy',
    config,
    fetchImpl,
    exposeControlRoutes,
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

export function createAnthropicProxyRuntime({ env = process.env, config = loadAnthropicConfig(env), fetchImpl = globalThis.fetch, exposeControlRoutes = true } = {}) {
  return createProtocolProxyRuntime(anthropicRuntimeOptions({ config, fetchImpl, exposeControlRoutes }));
}
