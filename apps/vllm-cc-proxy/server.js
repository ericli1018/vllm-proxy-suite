#!/usr/bin/env node

import { loadCommonConfig, parseBoolean } from '../../packages/core/config.js';
import { anthropicMessagesAdapter, applyAnthropicRequestPolicy, buildAnthropicRecoveryRequest } from '../../packages/anthropic/messages.js';
import {
  analyzeClaudeCodeToolAttempt,
  buildClaudeCodeToolRecovery,
  validateClaudeCodeToolRecovery,
} from '../../packages/anthropic/claude-code-tools/recovery.js';
import { createProtocolProxyRuntime } from '../../packages/server/create-proxy-server.js';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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
  });
}

export function createAnthropicGuardedRoute(config) {
  return {
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
  };
}

function anthropicRuntimeOptions({ config, fetchImpl, exposeControlRoutes = true }) {
  return {
    name: 'vllm-cc-proxy',
    metricPrefix: 'vllm_cc_proxy',
    config,
    fetchImpl,
    exposeControlRoutes,
    guardedRoutes: new Map([[
      '/v1/messages',
      createAnthropicGuardedRoute(config),
    ]]),
    allowPassthrough: (path) => path === '/v1/messages/count_tokens',
    formatJsonError: (type, message, requestId) => ({
      type: 'error',
      error: { type, message },
      ...(requestId ? { request_id: requestId } : {}),
    }),
  };
}

export function createAnthropicProxyRuntime({ env = process.env, config = loadAnthropicConfig(env), fetchImpl = globalThis.fetch, exposeControlRoutes = true } = {}) {
  return createProtocolProxyRuntime(anthropicRuntimeOptions({ config, fetchImpl, exposeControlRoutes }));
}
