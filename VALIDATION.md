# VLLM-PROXY-SUITE v0.7.5 Validation

Validation date: 2026-07-31

## Scope

This release corrects the Anthropic semantic Recovery boundary introduced in v0.7.4. A terminal `thinking_without_output` response now enters Output-Required Recovery without implying that a Tool Call is mandatory. The original Anthropic Tool choice is preserved, so `tool_choice={type:"auto"}` remains `auto` and the model may produce valid user-facing text, ask one blocking question, or call a Tool when external action is actually required.

Forced `tool_choice={type:"any",disable_parallel_tool_use:true}` remains limited to `action_intent_without_tool_call`, where the model has already announced a conservative first-person immediate external action while enabled tools are available.

## Source verification

- Full test suite: 256 passed, 0 failed.
- `npm run check`: passed.
- Package validator: `valid:true`, version `0.7.5`, 82 files, 50 required files.
- JavaScript syntax: 66 files passed `node --check` through the package checks and focused syntax verification.
- Compose YAML: parsed successfully.
- Compose services: `vllm-proxy-suite`, `searxng`.

## Original-failure regressions

- Immediate narration such as `好的，我開始執行階段 1。先查看當前目錄結構。` is still discarded when tools are available and the response ends with `end_turn` without a Tool Call.
- Action-Intent Recovery preserves the original Anthropic `tools[]` and sets `tool_choice={type:"any",disable_parallel_tool_use:true}`.
- A successful Action-Intent Recovery replays only the recovered Tool Call; the discarded narration is not delivered to Claude Code.
- If Action-Intent Recovery returns only Thinking, the final failure is `action_intent_without_tool_call` with `retryable:false`.
- If the initial result is `thinking_without_output`, Recovery preserves the original Tool choice; `auto` remains `auto`.
- A Thinking-only Recovery may return a normal planning or explanatory answer and complete with HTTP 200.
- If both attempts return only Thinking, the final failure remains `thinking_without_output` with `retryable:false` and no forced Tool Call.
- Short inputs such as `繼續`, `開始`, `proceed`, and `go ahead` no longer promote Thinking-only Recovery to `tool_choice=any`.

## Observability verification

- Incoming and upstream Tool counts, names, Tool choice, and preservation state are logged without schemas, arguments, prompt text, or generated text.
- Action-Intent Recovery logs `recoveryMode="action_required"` and `forcedToolChoice="any"`.
- Thinking-only Recovery logs:
  - `recoveryMode="output_required"`
  - `recoveryOriginReason="thinking_without_output"`
  - `recoveryToolChoice="auto|any|none|tool:<name>"`
  - `forcedToolChoice=false`
- A repeated empty-output Recovery records `thinking_without_output_fused` with `retryable:false`.
- Prometheus metrics include:
  - `vllm_cc_proxy_action_intent_without_tool_call_detected_total`
  - `vllm_cc_proxy_action_intent_recoveries_fused_total`
  - `vllm_cc_proxy_thinking_without_output_recoveries_fused_total`

## Compatibility verification

- Existing OpenAI Responses Actionless Completion behavior remains unchanged.
- Existing OpenAI transparent/guarded, Chat Completions, Tool Passthrough, malformed Tool recovery, Claude Code file-tool recovery, Managed WebSearch/WebFetch, stream envelope, retry fingerprint, and deployment validation tests remain green.
- Existing Anthropic action narration still uses one bounded forced-Tool Recovery.
- Generic Anthropic loop and incomplete-output Recovery remains limited to one internal Recovery attempt.

## Remaining deployment verification

The following require the target deployment environment and were not executed in this package workspace:

- Live Claude Code → Proxy → target vLLM integration.
- Docker image build and container startup against the production model endpoint.
- Long-running concurrency, cancellation, and memory-pressure tests.
