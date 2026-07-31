# Claude Code Action-Intent Guard Design


> **Superseded behavior note (v0.7.5):** `thinking_without_output` now uses Output-Required Recovery and preserves the original Tool choice. Only `action_intent_without_tool_call` uses forced Action-Required Recovery.

## Goal

Prevent Anthropic/Claude Code responses from ending with narration such as "I am starting" or "I will inspect" when tools are available but no `tool_use` block was produced.

## Scope

- Add a conservative Traditional Chinese and English immediate-action detector shared with the existing OpenAI Actionless Completion Guard.
- Apply the detector to `/v1/messages` only when tools are enabled, the response terminates with `stop_reason="end_turn"`, no Tool Call exists, and visible text is immediate action narration.
- Use the existing single Recovery slot. Preserve all Claude Code tools, force one tool-capable recovery with Anthropic `tool_choice={type:"any",disable_parallel_tool_use:true}`, discard the narrated response, and request an immediate Tool Call.
- Fail closed with `retryable:false` when Recovery again contains no Tool Call, preventing Claude Code from repeating the same API retry cycle.
- Add request/recovery diagnostics without logging prompt or Tool schemas.

## Non-goals

- Do not classify generic plans, procedural explanations, completed final answers, requests without tools, or explicit `tool_choice=none`.
- Do not create a second Recovery loop.
- Do not alter Claude Code file-tool semantic recovery.
- Do not force a specific Tool name when the failed response did not establish one.

## Data Flow

1. Parse and protocol-validate the Anthropic response.
2. Run existing Claude Code Tool semantic validation.
3. If still valid, run Action-Intent validation.
4. On detection, discard Attempt 1 and build one required-action Recovery.
5. Accept Recovery only when at least one Tool Call exists; otherwise return a non-retryable typed failure.

## Diagnostics

- `request_tool_context`: incoming and prepared Tool counts/names/choice.
- `action_intent_without_tool_call_detected`: initial semantic failure.
- `action_intent_without_tool_call_fused`: Recovery failed to produce a Tool Call.
- `recovery_request_built`: recovery mode, Tool count, forced Tool choice, instruction placement.


## Explicit continuation hardening

A short latest-user continuation (`繼續`, `開始`, `proceed`, or `go ahead`) with enabled tools promotes an initial `thinking_without_output` into the same bounded Action-Required Recovery. If that Recovery still produces no Tool Call, the Proxy preserves `thinking_without_output`, marks it `retryable:false`, and records `thinking_without_output_fused`. Generic plans and explanatory requests remain outside this rule.
