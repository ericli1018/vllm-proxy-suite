# Claude Code Action-Intent Guard Implementation Plan


> **Superseded behavior note (v0.7.5):** `thinking_without_output` now uses Output-Required Recovery and preserves the original Tool choice. Only `action_intent_without_tool_call` uses forced Action-Required Recovery.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single bounded Anthropic/Claude Code recovery for immediate action narration that ends without a Tool Call.

**Architecture:** Extract the conservative action-narration classifier into a protocol-neutral core module, then add an Anthropic detector/recovery module and integrate it into the existing guarded-route lifecycle. Reuse the current single Recovery slot and fail closed after Recovery.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, Anthropic Messages SSE, existing proxy runtime.

## Global Constraints

- Keep generic planning and final answers valid.
- Never perform more than one internal Recovery.
- Preserve all original Claude Code tools during action-required Recovery.
- Do not log prompt text or Tool schemas.
- Preserve existing file-tool recovery and Managed Web behavior.

---

### Task 1: Shared action narration classifier

**Files:**
- Create: `packages/core/action-narration.js`
- Modify: `packages/openai/actionless-completion.js`
- Test: `test/actionless-completion-v057.test.js`

**Interfaces:**
- Produces: `looksLikeActionNarration(text: unknown): boolean`

- [ ] Add failing regressions for `我開始執行` and `我繼續執行`.
- [ ] Run the focused test and verify failure.
- [ ] Extract and extend the classifier with conservative immediate-action forms.
- [ ] Run the focused test and verify pass.

### Task 2: Anthropic Action-Intent detector and Recovery

**Files:**
- Create: `packages/anthropic/action-intent.js`
- Test: `test/anthropic-action-intent-v074.test.js`

**Interfaces:**
- Produces: `summarizeAnthropicToolContext(body)`
- Produces: `detectAnthropicActionIntentWithoutToolCall({ requestBody, output, completion, recovery })`
- Produces: `buildAnthropicActionRequiredRecovery({ original, prepared, issue, config })`
- Produces: `validateAnthropicActionRequiredRecovery(output, plan)`

- [ ] Add unit tests for detection, exclusions, Recovery request shape, and fused validation.
- [ ] Run the focused test and verify failure.
- [ ] Implement the minimal detector and Recovery builder.
- [ ] Run the focused test and verify pass.

### Task 3: Claude Code runtime integration and observability

**Files:**
- Modify: `apps/vllm-cc-proxy/server.js`
- Modify: `packages/server/create-proxy-server.js`
- Test: `test/anthropic-action-intent-v074.test.js`

**Interfaces:**
- Consumes Task 2 functions.
- Produces route diagnostics and typed lifecycle events.

- [ ] Add integration tests proving narration is discarded, Recovery forces a Tool Call, and failed Recovery is non-retryable.
- [ ] Run the integration test and verify failure.
- [ ] Wire validation, Recovery, request diagnostics, metrics, and event names.
- [ ] Run the integration test and verify pass.

### Task 4: Configuration, documentation, and package validation

**Files:**
- Modify: `apps/vllm-cc-proxy/server.js`
- Modify: `docker-compose.partial.yaml`
- Modify: `README.md`
- Modify: `docs/recovery-policy.md`
- Modify: `docs/observability.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `scripts/validate-package.js`
- Test: `test/deployment.test.js`
- Test: `test/package-validation.test.js`

**Interfaces:**
- Produces: `CLAUDE_CODE_ACTION_INTENT_GUARD_ENABLED` configuration switch, default `true`.

- [ ] Add failing configuration/deployment/package assertions.
- [ ] Run focused tests and verify failure.
- [ ] Add configuration and documentation, bump version to `0.7.4`.
- [ ] Run focused tests and verify pass.

### Task 5: Full verification and artifact

**Files:**
- Create: release ZIP outside the project root.

- [ ] Run `npm test`.
- [ ] Run `npm run check`.
- [ ] Inspect changed files for debug output and accidental prompt/schema logging.
- [ ] Create `VLLM-PROXY-SUITE-v0.7.4.zip` with the project directory as ZIP root.
- [ ] List and checksum the ZIP.


## Explicit continuation hardening

A short latest-user continuation (`繼續`, `開始`, `proceed`, or `go ahead`) with enabled tools promotes an initial `thinking_without_output` into the same bounded Action-Required Recovery. If that Recovery still produces no Tool Call, the Proxy preserves `thinking_without_output`, marks it `retryable:false`, and records `thinking_without_output_fused`. Generic plans and explanatory requests remain outside this rule.
