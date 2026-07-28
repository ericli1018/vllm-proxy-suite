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

For `/v1/responses`, a terminal `status="incomplete"` or `status="cancelled"` is protocol-valid even when it contains only reasoning and no visible output. It is replayed unchanged and does not trigger `reasoning_without_output` Recovery. The official `response.incomplete` event and the vLLM variant `response.completed` with an embedded incomplete status are treated equivalently. `status="failed"` and explicit upstream errors remain invalid.

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

## Claude Code file-tool recovery

This policy exists only in the Anthropic service. `tools[]` and `input_schema` are runtime authority.

The initial and Recovery outputs are checked before raw replay for:

- `Edit` with `old_string === new_string`.
- Exact retries of canonical mutation arguments already proven failed by `tool_result.is_error:true`.
- Required fields, primitive types, enums, and constants for `Read`, `Edit`, `Write`, and `NotebookEdit`.
- Precisely identifiable Tool targets.

Read freshness is derived from accepted history. A failed mutation invalidates prior Read evidence for the target; a Bash Tool Result clears Read freshness according to configuration.

Without fresh target evidence, Recovery permits only the exact `Read`. With fresh evidence, it permits only the original mutation tool, locks the target, and rejects no-op, `replace_all` expansion, and exact failed-argument replay.

## Deterministic Tool JSON failures

Anthropic and any protected non-passthrough validation path do not generically retry deterministic Tool structure failures:

```text
malformed_tool_arguments
malformed_tool_json
invalid_tool_arguments
invalid_tool_input
tool_argument_limit
too_many_tool_calls
```

OpenAI Tool Calls are different: after the transparent commit boundary, these conditions are observe-only diagnostics and cannot trigger blocking or Recovery. The client receives the original upstream stream and owns Tool aggregation, validation, execution, and retry policy.
