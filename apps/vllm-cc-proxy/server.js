#!/usr/bin/env node

import { loadCommonConfig, parseBoolean, parseCsv, trimTrailingSlash } from '../../packages/core/config.js';
import { anthropicMessagesAdapter, applyAnthropicRequestPolicy, buildAnthropicRecoveryRequest } from '../../packages/anthropic/messages.js';
import {
  analyzeClaudeCodeToolAttempt,
  buildClaudeCodeToolRecovery,
  validateClaudeCodeToolRecovery,
} from '../../packages/anthropic/claude-code-tools/recovery.js';
import { createProtocolProxyRuntime } from '../../packages/server/create-proxy-server.js';
import { createAnthropicManagedWebSearchFetch } from '../../packages/anthropic/managed-websearch.js';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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
  });
}

export function createAnthropicGuardedRoute(config, options = {}) {
  return {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
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
      if (uses <= 0 && failures <= 0 && !limitReached) return;
      metrics.managedWebSearchExecutionsTotal += uses;
      metrics.managedWebSearchFailuresTotal += failures;
      if (limitReached) metrics.managedWebSearchLimitsTotal += 1;
      logger.info('managed_websearch_completed', {
        attempt: attemptNumber,
        phase,
        uses,
        failures,
        limitReached,
      });
    },
  };
}

function anthropicRuntimeOptions({ config, fetchImpl, exposeControlRoutes = true }) {
  const managedFetchImpl = config.managedWebSearchEnabled
    ? createAnthropicManagedWebSearchFetch(fetchImpl, config)
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
