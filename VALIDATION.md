# VLLM-PROXY-SUITE v0.7.7 Validation

Validation date: 2026-07-31

## Scope

This release fixes the Claude Code Recovery routing failure triggered by targetless mutation Tool inputs such as `Write({})`.

Previously, every invalid Claude Code mutation Tool issue carrying a context object entered exact-target Recovery. When `file_path` or `notebook_path` was absent, Recovery construction threw `Claude Code tool recovery requires an exact target path`, producing `recovery_build_failed` before a second model Attempt could begin.

v0.7.7 separates the paths:

```text
invalid mutation + exact target
→ existing locked-target Read/mutation Recovery

invalid mutation + no exact target
→ generic Output-Required Recovery
→ preserve tools[] and tool_choice
→ substantive text | complete valid Tool Call | blocking question
```

A repeated targetless invalid mutation in the Recovery Attempt is fused as `invalid_claude_code_tool_input` with `retryable:false`.

## Source verification

- Full test suite: 268 passed, 0 failed.
- `npm run check`: passed.
- Package validator: `valid:true`, version `0.7.7`, 84 files, 51 required files.
- JavaScript syntax: 68 files passed `node --check`.
- Compose YAML: parsed successfully.
- Compose services: `vllm-proxy-suite`, `searxng`.

## Original-failure regressions

- `Write({})` is classified as `invalid_claude_code_tool_input` with `targetPath=null`.
- The route selects `output_required` instead of calling exact-target Recovery.
- Recovery preserves the original full Tool set.
- An incoming `tool_choice={type:"auto"}` remains `auto`.
- Recovery instructions state that the rejected Tool does not have to be reused.
- A successful generic continuation may return substantive planning text with HTTP 200.
- A second `Write({})` is returned with `retryable:false` after exactly two upstream Attempts.
- No `recovery_request_rejected` or `recovery_build_failed` event occurs for the targetless path.

## Compatibility verification

- Exact-target no-op Edit and failed mutation Recovery remains unchanged.
- Exact target mismatch remains fail-closed.
- Claude Code Action-Intent, Thinking-only, and Placeholder Completion Recovery tests remain green.
- Managed WebSearch/WebFetch and stream-envelope tests remain green.
- OpenAI Responses transparent/guarded, Chat Completions, Tool Passthrough, Hosted Tool filtering, and malformed Tool tests remain green.
- Package and deployment validation tests remain green.

## Observability verification

Initial targetless invalid mutation:

```text
targetless_tool_recovery_started
phase="initial"
targetlessToolRecovery=true
rejectedToolName="Write|Edit|NotebookEdit"
```

Recovery construction:

```text
recovery_request_built
recoveryMode="output_required"
recoveryOriginReason="invalid_claude_code_tool_input"
recoveryToolChoice="auto|any|none|tool:<name>"
targetlessToolRecovery=true
forcedToolChoice=false
```

Repeated failure:

```text
targetless_tool_recovery_fused
phase="recovery"
retryable=false
```

Prometheus counters:

```text
vllm_cc_proxy_targetless_tool_recoveries_detected_total
vllm_cc_proxy_targetless_tool_recoveries_fused_total
```

## Remaining deployment verification

The following require the target deployment environment and were not executed in this package workspace:

- Live Claude Code → Proxy → target vLLM integration.
- Docker image build and container startup against the production model endpoint.
- Long-running concurrency, cancellation, and memory-pressure tests.
