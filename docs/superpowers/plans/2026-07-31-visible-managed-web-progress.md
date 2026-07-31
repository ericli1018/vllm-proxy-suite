# Visible Managed Web Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release v0.7.3 with user-visible, sanitized WebSearch/WebFetch progress that replaces blank bullets while preserving Anthropic streaming correctness and removing synthetic progress from later vLLM context.

**Architecture:** Keep the v0.7.2 synthetic Anthropic stream lifecycle, but make activation lazy until the managed bridge reports the first managed tool item. The progress block starts with an invisible sentinel followed by visible status text, receives bounded periodic ellipses and stage/completion messages, and is stripped from inbound conversation history before request policy reaches vLLM.

**Tech Stack:** Node.js ESM, Anthropic Messages SSE, Node test runner, Docker Compose YAML.

## Global Constraints

- Version must be `0.7.3`.
- Ordinary text and Claude Code native tools must not create a synthetic progress block.
- WebSearch may display a sanitized query; WebFetch may display only a sanitized hostname.
- No authorization, cookies, URL query strings, snippets, or document body may be logged or displayed.
- Synthetic progress text must not be forwarded to vLLM on later turns.
- Managed internal vLLM requests remain `think:false` and `chat_template_kwargs.enable_thinking=false`.
- Final stream must contain exactly one `message_start` and one `message_stop`.

---

### Task 1: Progress formatter and history sanitizer

**Files:**
- Modify: `packages/anthropic/stream-envelope.js`
- Modify: `packages/anthropic/messages.js`
- Test: `test/anthropic-managed-visible-progress-v073.test.js`

**Interfaces:**
- Produces `createManagedAnthropicVisibleStart`, `createManagedAnthropicVisibleDelta`, and `stripManagedProgressBlocks`.
- Visible blocks begin with U+2063 and bounded text.

- [ ] Write failing tests for sanitized query/hostname labels, bounded ellipses, and stripping sentinel blocks.
- [ ] Run the focused test and confirm failure from missing behavior.
- [ ] Implement formatter and sanitizer.
- [ ] Run focused tests to green.

### Task 2: Lazy stream activation

**Files:**
- Modify: `packages/server/create-proxy-server.js`
- Modify: `packages/anthropic/managed-web-tools.js`
- Test: `test/anthropic-managed-visible-progress-v073.test.js`

**Interfaces:**
- Managed progress events include `phase`, a sanitized display descriptor, and item completion data.
- Server starts the synthetic envelope only after receiving a managed progress event.

- [ ] Write failing integration tests proving ordinary Bash/text have no extra block and managed search starts visible progress.
- [ ] Run tests and verify expected failures.
- [ ] Implement lazy envelope startup and periodic visible deltas.
- [ ] Verify one lifecycle and final index splice.

### Task 3: Configuration and deployment contract

**Files:**
- Modify: `apps/vllm-cc-proxy/server.js`
- Modify: `docker-compose.partial.yaml`
- Modify: `test/deployment.test.js`
- Modify: `test/anthropic-managed-visible-progress-v073.test.js`

**Interfaces:**
- `MANAGED_WEB_STREAM_PROGRESS_MODE=visible|minimal|invisible|off`
- `MANAGED_WEB_STREAM_PROGRESS_DETAIL=query|tool`
- `MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS=5000`
- `MANAGED_WEB_STREAM_PROGRESS_MAX_LABEL_CHARS=160`
- `MANAGED_WEB_STREAM_PROGRESS_MAX_DOTS=12`

- [ ] Add failing configuration and Compose tests.
- [ ] Implement parsing and defaults.
- [ ] Run focused and deployment tests.

### Task 4: Release documentation and packaging

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `VALIDATION.md`
- Modify: `scripts/validate-package.js` if required by version contract.

- [ ] Update release metadata and usage documentation.
- [ ] Run full test, syntax, package, YAML, shell, health, metrics, and shutdown validation.
- [ ] Build versioned and fixed-name ZIP files.
- [ ] Extract into a clean directory and repeat verification.
- [ ] Produce SHA-256 and external validation summary.
