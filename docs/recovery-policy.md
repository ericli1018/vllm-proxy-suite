# Recovery Policy

## Anthropic attempt lifecycle

```text
ORIGINAL_ATTEMPT
├── VALID → COMMIT RAW RESPONSE
└── INVALID／LOOP／INTERRUPTED
    ├── RECOVERABLE AND ATTEMPTS AVAILABLE → RECOVERY_ATTEMPT
    │   ├── VALID → COMMIT RECOVERY RAW RESPONSE
    │   └── INVALID → PROTOCOL ERROR
    └── NOT RECOVERABLE → PROTOCOL ERROR
```

## OpenAI attempt lifecycle

```text
ORIGINAL_ATTEMPT
├── no Tool Call yet
│   ├── VALID final response → protected replay
│   └── INVALID／THINK LOOP／INTERRUPTED
│       └── recoverable → at most one Recovery
│
└── first Tool Call observed
    → irreversible transparent Tool commit
    → no Tool validation gate
    → no Tool repair or Recovery
    → stream completion or committed-stream interruption
```

`MAX_RECOVERY_ATTEMPTS` is limited to `0` or `1`. Recovery always starts from the original request and accepted Tool Result history; a failed protected Attempt is not written into context.

If an OpenAI Recovery generation emits a Tool Call, that Recovery response crosses the same transparent commit boundary. Post-generation forced-Tool validation cannot revoke bytes already delivered.

For `/v1/responses`, terminal protocol state has priority over Think Loop classification. Once any of the following appears, the reasoning-loop guard is permanently closed for that Attempt:

```text
output text or refusal
Function Call
response.completed
response.incomplete
response.failed
response.cancelled
```

A valid completed response is replayed even if its preceding reasoning contains a repeated suffix. A terminal `status="incomplete"` or `status="cancelled"` is protocol-valid even when it contains only reasoning and no visible output. It is replayed unchanged and does not trigger `reasoning_without_output` Recovery. The official `response.incomplete` event and the vLLM variant `response.completed` with an embedded incomplete status are treated equivalently. `status="failed"` and explicit upstream errors remain invalid.

Before an action boundary, exact suffix, normalized suffix, and ABAB line-cycle detection all require `LOOP_MIN_COUNT` repetitions. The default is `3`; two repeats alone are not treated as a loop.

## Responses actionless-completion recovery

A valid terminal response can still be an invalid agent transition when all of these are true:

```text
status=completed
tools are available and tool_choice is not none
no Function Call was emitted
visible text is a narrow first-person promise to begin work
```

The original narration is discarded. The single Recovery slot preserves all request tools, forces `tool_choice="required"`, sets `parallel_tool_calls=false`, and requests exactly one immediate tool call. This mode does not use network-tool filtering.

If the Recovery still contains no Function Call, `actionless_completion` is returned with `retryable:false`. The Proxy never performs a third Attempt. Normal final answers, generic procedural explanations, incomplete/cancelled responses, requests without tools, and requests with `tool_choice="none"` are not candidates.

## OpenAI Chat System Message contract

For `/v1/chat/completions`, a System Message is optional, but when present it must be the only System Message and must occupy `messages[0]`.

Proxy-generated Recovery instructions preserve that contract:

```text
leading System Message exists
→ append Recovery text to its content

no System Message exists
→ insert Recovery System Message at messages[0]

System Message exists at any later index
→ reject before vLLM with HTTP 400 system_message_not_first
```

The Proxy never moves a Client-supplied late System Message because doing so could change conversation authority or chronology. Recovery construction preserves the relative order and content of all user, assistant, and Tool messages.

For System Message content arrays, Recovery appends a `{type:"text", text:"..."}` block. `/v1/responses` remains unchanged and appends Recovery text through `instructions` rather than `messages[]`.

## OpenAI network capability

Tool classification does not depend on fixed product names. Explicit exact-name configuration has highest priority; otherwise the classifier uses network semantics in function names, descriptions, and parameter schemas while excluding local filesystem, repository, database, and shell capabilities.

When no usable network tool is identified, Recovery preserves the original tool set and does not invent a function name. This Recovery logic applies only before an OpenAI Tool Call is committed.

## Claude Code action-intent recovery

This policy exists only in the Anthropic service and uses the same single Recovery slot as other guarded failures.

An initial response is classified as `action_intent_without_tool_call` only when all conditions hold:

- the request exposes at least one Tool and Tool choice is not `none`;
- the Anthropic message terminates with `stop_reason="end_turn"`;
- no `tool_use` block exists;
- visible text is a conservative first-person immediate-action statement.

Generic plans, procedural explanations, completed final answers, and explicit confirmation boundaries remain valid.

The initial narration is discarded. Recovery preserves the original Tool set, sets `tool_choice={type:"any",disable_parallel_tool_use:true}`, lowers sampling through the common Recovery caps, and instructs the model to produce a Tool Call without another narration-only response.

`thinking_without_output` does not imply that the task requires a Tool. It enters a separate Output-Required Recovery that preserves the prepared Anthropic request and its original Tool choice. In particular, `tool_choice={type:"auto"}` remains `auto`; short user continuations such as `繼續`, `開始`, `proceed`, or `go ahead` do not promote it to `any`.

The Output-Required instruction permits a user-facing answer, explanation, plan, completion report, confirmation boundary, one genuinely blocking question, or a Tool Call when external action is actually necessary. It only forbids another reasoning-only terminal response. A second `thinking_without_output` is fused as the same reason with `retryable=false`, while a valid text response is delivered normally.


A separate `placeholder_completion_without_progress` classifier applies only when the latest accepted Anthropic input is a `tool_result`, the response ends with `end_turn`, no Tool Call exists, and the entire visible response normalizes to one of the explicit placeholder markers: `No response`, `No output`, `無回應`, `沒有回應`, `無輸出`, or `沒有輸出`. It does not classify longer sentences, generic short answers, or ordinary user turns.

The placeholder Attempt is discarded and uses the same Output-Required Recovery path with the original Tool choice preserved. The Recovery instruction explicitly rejects another placeholder but still permits substantive text, a Tool Call, or one blocking question. A repeated placeholder is fused as `placeholder_completion_without_progress` with `retryable=false`.

Action-Required Recovery remains exclusive to `action_intent_without_tool_call`. If that Recovery does not produce a Tool Call, every failure shape is fused with `retryable=false` and the originating reason remains `action_intent_without_tool_call`. The Proxy performs no third Attempt and does not delegate the same semantic retry to Claude Code.

## Claude Code file-tool recovery

This policy exists only in the Anthropic service. `tools[]` and `input_schema` are runtime authority.

The initial and Recovery outputs are checked before raw replay for:

- `Edit` with `old_string === new_string`.
- Exact retries of canonical mutation arguments already proven failed by `tool_result.is_error:true`.
- Required fields, primitive types, enums, and constants for `Read`, `Edit`, `Write`, and `NotebookEdit`.
- Precisely identifiable Tool targets.

Read freshness is derived from accepted history. A failed mutation invalidates prior Read evidence for the target; a Bash Tool Result clears Read freshness according to configuration.

Without fresh target evidence, Recovery permits only the exact `Read`. With fresh evidence, it permits only the original mutation tool, locks the target, and rejects no-op, `replace_all` expansion, and exact failed-argument replay.

### Targetless invalid mutation input

A mutation Tool issue enters exact-target Recovery only when the rejected input contains an exact `file_path` or `notebook_path`. Inputs such as `Write({})` have no safe target to lock and therefore use generic Output-Required Recovery instead of failing Recovery construction.

The targetless path preserves the original Tool set and Tool choice. It does not force the rejected Tool because the correct continuation may be a planning response, a completion report, another valid Tool, or one blocking question. The rejected generation is discarded, and another empty or schema-incomplete targetless mutation in the single Recovery Attempt is returned as `invalid_claude_code_tool_input` with `retryable=false`.

```text
invalid mutation + exact target
→ locked file-tool Recovery

invalid mutation + no exact target
→ output_required / tool_choice preserved
→ substantive text | valid Tool Call | blocking question
→ repeated invalid targetless mutation: fused
```

## Universal Tool Input Schema Guard

Every buffered Anthropic Tool Call is validated against the matching runtime `tools[].input_schema` before replay. This guard applies to all exposed Tools, including task-management and MCP Tools, not only Claude Code file mutation Tools.

The validator recursively enforces required fields, declared types, enum and const values, nested object properties, array items, and `additionalProperties:false`. Unknown schema keywords are ignored rather than guessed. `$ref` and composite schemas are not expanded or guessed by the Proxy.

```text
TaskUpdate({"status":"completed"})
+ input_schema.required=["taskId"]
→ invalid_tool_input_schema
→ discard initial Attempt
→ one Output-Required Recovery with original tool_choice
```

The Recovery instruction explicitly forbids inventing missing identifiers and permits a state-read Tool such as `TaskList`, another complete Tool Call, substantive text, or one blocking question. It does not force the rejected Tool. A repeated schema-invalid Tool Call is fused with `retryable=false`.

`CLAUDE_CODE_TOOL_INPUT_SCHEMA_GUARD_ENABLED=false` disables this universal pre-replay guard. Existing exact-target mutation Recovery remains independently controlled by `CLAUDE_CODE_TOOL_RECOVERY_ENABLED`.

## Claude Code Tool stop-reason normalization

A Tool block and its terminal stop reason are validated as one protocol transition. When a buffered Anthropic response contains at least one complete Tool Call but terminates with `stop_reason="end_turn"`, normalization is allowed only when all of the following hold:

- normalization is enabled;
- every Tool block is closed and its JSON parsed successfully;
- every Tool name exists in the request `tools[]`;
- every Tool input satisfies the exposed `input_schema`, including required fields, primitive types, enums, and constants;
- the response terminal is otherwise complete and successful.

The Proxy rewrites the actual buffered SSE `message_delta` or non-stream JSON payload to `tool_use`, updates parsed completion diagnostics, and then runs the ordinary Tool Recovery and target-lock validation. Initial and Recovery attempts use the same rule.

```text
valid Tool Call + end_turn
→ rewrite buffered protocol terminal to tool_use
→ continue semantic and target validation
→ replay

invalid or incomplete Tool Call + end_turn
→ no normalization
→ tool_stop_reason_mismatch or the more specific structural error
```

Malformed JSON, unknown Tools, schema-invalid input, excessive Tool Calls, unclosed blocks, cancellation, and failure terminals remain fail-closed. `CLAUDE_CODE_TOOL_STOP_REASON_NORMALIZATION_ENABLED=false` disables the rewrite and preserves strict mismatch rejection.

## Deterministic Tool JSON failures

The targetless mutation path above is a narrow exception for a fully parsed mutation object that lacks a safe target. Malformed JSON, oversized arguments, excessive Tool Calls, and unrelated deterministic Tool structure failures are not generically retried.

Anthropic and any protected non-passthrough validation path do not generically retry these deterministic Tool structure failures:

```text
malformed_tool_arguments
malformed_tool_json
invalid_tool_arguments
invalid_tool_input
tool_argument_limit
too_many_tool_calls
```

OpenAI Tool Calls are different: after the transparent commit boundary, these conditions are observe-only diagnostics and cannot trigger blocking or Recovery. The client receives the original upstream stream and owns Tool aggregation, validation, execution, and retry policy.

## Responses Chat-adapter recovery

Recovery bodies remain expressed in Responses form. In `chat_adapter` mode each initial or Recovery attempt is independently normalized and converted to Chat Completions immediately before the upstream fetch. This preserves the existing policy invariants:

- Think Loop Recovery still modifies `instructions`, not Chat history directly.
- Actionless Recovery still sets Responses `tool_choice="required"` and `parallel_tool_calls=false`; the adapter maps those values to the second Chat request.
- Function, Custom, Namespace and `additional_tools` definitions remain available during Recovery.
- Once the reconstructed Responses stream announces a Tool item, the common transparent Tool commit boundary disables further Recovery.
- Adapter request-validation errors are non-generation HTTP 400 failures and are never sent as retryable upstream transport errors.


## Hosted Tool filtering and malformed required-tool retry

In `chat_adapter` mode, Hosted Tool policy is evaluated before the request reaches vLLM:

```text
drop_optional + auto
→ remove unsupported Hosted Tools
→ preserve Client function/custom/namespace tools
→ continue

required or explicit Hosted Tool with no supported Client alternative
→ required_hosted_tool_unavailable
→ retryable=false
```

`allowed_tools` is filtered as a closed allowlist; filtering never widens the set of permitted tools.

A required Chat tool generation may be rejected by the vLLM Tool parser before any SSE bytes are returned. When the HTTP 400 body identifies malformed or unterminated Tool arguments, the adapter performs one internal sub-attempt with lower temperature, a minimum output-token budget, non-parallel execution, a small complete-JSON instruction, and explicit Function choice when only one tool exists.

This internal sub-attempt does not consume another generic Proxy Recovery slot. It is strictly fused after one retry. A second parser rejection is classified as:

```text
malformed_required_tool_arguments
retryable=false
```

The retry applies only when Tool choice is required or explicitly selects a Function. Optional `auto` generations are not silently retried as forced actions.
