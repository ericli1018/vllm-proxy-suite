# Observability and Hermes Tool-Loop Diagnosis

## Log level policy

- `error`: terminal failures only.
- `warn`: stalls, loops, cancellations, rejected requests, Tool argument growth thresholds, observe-only Tool validation findings, and retries of previously failed requests.
- `info`: request lifecycle, Recovery, OpenAI Tool passthrough, protected replay, Tool delivery, and latest-turn Tool Results.
- `debug`: state transitions, periodic progress, exact-request fingerprints, and full-history versus latest-turn Tool Result context.
- `trace`: transport chunk metadata and optional redacted payload previews.

Use `info` normally, `debug` for long reasoning or Tool-loop diagnosis, and `trace` only for short controlled reproductions.

## Recovery request construction

OpenAI Chat Recovery emits a debug record before the second upstream attempt:

```text
recovery_request_built
recoveryInstructionPlacement="merged_leading_system" | "inserted_leading_system"
messageCount=...
systemMessageCount=1
systemMessageIndexes=[0]
```

Responses Recovery reports `recoveryInstructionPlacement="instructions"`.

If Recovery construction violates the request contract, the Proxy emits:

```text
recovery_request_rejected
reason="system_message_not_first"
message_index=...
system_message_indexes=[...]
```

A Client request already containing a System Message outside `messages[0]` is rejected before upstream access with `request_rejected status=400 reason="system_message_not_first"`.

## Progress interpretation

Transport and semantic progress are independent:

```text
upstreamBytes / upstreamChunks
→ bytes are arriving from vLLM

sseEvents
→ complete protocol events are being parsed

semanticBytes
→ reasoning, content, Tool-name, or Tool-argument bytes are increasing
```

Common patterns:

```text
recentBytesPerSec = 0
lastUpstreamActivityMs increasing
→ vLLM or the upstream connection is idle
```

```text
recentBytesPerSec > 0
sseEvents increasing
semanticBytes unchanged
→ metadata, ping, role-only, usage, or completion events are arriving without model semantics
```

```text
toolArgumentBytes increasing
→ the model is assembling Tool Call arguments
```

Tool diagnostics:

```text
toolCallCount
toolCallIndexes
toolCallKeys
toolCallIds
toolNames
toolArgumentBytesByCall
toolArgumentFragmentsByCall
parallelToolCallsDetected
```

For Chat Completions, a continuation fragment without `index` remains attached to the active Tool Call. A fragment with a new Tool Call `id` creates a new call. Keys are:

```text
Chat Completions: choice:<choice>/tool:<index>
Responses:        output:<index>/call:<id>
Anthropic:        block:<index>
```



## Responses behavior mode diagnostics

Every `/v1/responses` request reports:

```text
responsesBehaviorMode="transparent" | "guarded"
behaviorGuardsEnabled=false | true
```

Default `transparent` mode does not emit `loop_detected`, `actionless_completion_detected`, `recovery_started`, or malformed required-tool retry events for Responses. A terminal model response is delivered as protocol output even when it contains only reasoning or only narration.

`guarded` mode restores the earlier behavioral diagnostics and Recovery flow for controlled A/B testing. Transport limits, Hosted Tool filtering, Tool passthrough, parser errors, cancellation, and resource safety remain active in both modes.

## Responses upstream mode diagnostics

Every guarded `/v1/responses` request includes the safe field:

```text
responsesUpstreamMode="chat_adapter"
# or "native"
```

In `chat_adapter` mode, upstream network traffic goes to `/v1/chat/completions`, but all attempt/replay/Tool lifecycle logs remain protocol=`vllm_openai_proxy`, path=`/v1/responses` because the route-scoped adapter reconstructs Responses before the common attempt runner observes it.

Default deployment reports:

```text
responsesUpstreamMode="native"
responsesBehaviorMode="transparent"
responsesToolChoicePolicy="preserve"
```

Native mode does not emit `responses_hosted_tools_filtered`; Hosted Tool declarations are forwarded to vLLM unchanged. Hosted filtering and its counters apply only to `chat_adapter`.

## Responses Tool Choice Policy diagnostics

Every `/v1/responses` `request_tool_context` includes:

```text
responsesToolChoicePolicy="preserve" | "required_on_explicit_continue"
originalToolChoice="auto|required|none|explicit"
effectiveToolChoice="auto|required|none|explicit"
toolChoiceRewritten=false|true
latestInputKind="user|tool_result|..."
explicitContinueDetected=false|true
```

When an eligible explicit user execution turn is rewritten before upstream contact:

```text
event=responses_tool_choice_rewritten
responsesToolChoicePolicy="required_on_explicit_continue"
originalToolChoice="auto"
effectiveToolChoice="required"
toolChoiceRewritten=true
```

Prometheus counter:

```text
vllm_openai_proxy_tool_choice_rewrites_total
```

This policy creates no Recovery attempt. Tool Result turns retain the Client's original `tool_choice`.

Unsupported adapter features terminate before upstream contact:

```text
request_rejected status=400 reason="unsupported_responses_tool"
request_rejected status=400 reason="unsupported_previous_response_id"
request_rejected status=400 reason="unsupported_responses_input_item"
```

`request_tool_context` is emitted after Responses Lite `additional_tools` normalization, so its tool count/names include dynamically supplied Function, Custom and Namespace tools without logging their schemas.

For a Custom Tool, the expected sequence is:

```text
response.output_item.added type=custom_tool_call
tool_passthrough_started
...
response.custom_tool_call_input.done
response.output_item.done
response.completed
```

This early item announcement preserves the same irreversible Tool boundary used by ordinary Function Calls.

## Guarded Responses Think Loop action boundary

Only when `responsesBehaviorMode="guarded"`, `loop_detected` is permitted while the Attempt contains reasoning and no action or terminal marker. The guard closes when any visible output/refusal, Function Call, or response terminal event is observed.

A normal successful sequence may therefore contain repeated reasoning but must still end as:

```text
request_progress responseTerminal=true responseStatus="completed" contentBytes>0
response_replay_started
response_replay_completed
request_completed status=200
```

It must not emit `loop_detected` or `recovery_started` after that boundary. If Codex reports `stream closed before response.completed`, verify whether the Proxy logged a valid terminal event followed by a loop event; v0.5.6 prevents that ordering.

`LOOP_MIN_COUNT` defaults to `3` and is applied consistently to exact, normalized, and ABAB cycles. Tests that intentionally exercise two-repeat recovery must set it explicitly to `2`.

## OpenAI Tool passthrough lifecycle

OpenAI Chat Completions and Responses use a pre-Tool protected phase and a post-Tool transparent phase.

Expected sequence:

```text
upstream_connecting
upstream_headers_received
upstream_waiting_first_byte
upstream_streaming

# First Tool Call becomes observable
tool_passthrough_committing
tool_passthrough_started
tool_passthrough_streaming

# Upstream ends and Node response finishes
tool_passthrough_completed
tool_calls_delivered
request_completed mode=tool_passthrough
```

Interpretation:

- Before `tool_passthrough_started`, semantic-stall detection and buffer limits remain active. Thinking Loop detection and Recovery are additionally active only in `responsesBehaviorMode="guarded"` (and remain active for runtimes that explicitly use them).
- `tool_passthrough_started` is the irreversible boundary. The Proxy stops heartbeat output, flushes all buffered upstream bytes, releases the raw response buffer reservation, and forwards later bytes with backpressure.
- After commit, Tool JSON validation is observe-only. The Proxy does not block, rewrite, repair, split, or recover the Tool Call.
- `tool_passthrough_validation_warning action=observe_only` means the retained observation was sufficient to identify a malformed Tool Call, but delivery was not changed.
- If observation exceeded its retained-prefix limit, the Proxy does not claim the complete Tool JSON is valid or invalid.
- `tool_passthrough_completed` means the upstream stream ended and Node finished writing the outgoing response. It is not a Hermes application-level acknowledgement.
- A later correlated `tool_results_received` is stronger evidence that Hermes parsed and executed the Tool Call.

Non-stream OpenAI Tool responses emit the same passthrough lifecycle after the complete upstream JSON body is available; they cannot stream earlier because the upstream response itself is non-streaming.

## Protected replay lifecycle

Anthropic Messages and OpenAI responses that never emit a Tool Call remain protected:

```text
attempt_validating
tool_calls_ready                 # when a protected runtime has Tool Calls
response_replay_started
response_replay_completed
tool_calls_delivered
request_completed
```

`tool_calls_ready` without `response_replay_completed` indicates protected replay did not finish. This sequence remains especially relevant to Anthropic/Claude Code Tool Recovery.

## Completion and usage diagnostics

Progress and terminal records normalize protocol completion:

- Chat Completions: `finishReason`, `finishReasonsByChoice`, `doneReceived`.
- Responses: `responseTerminal`, `responseTerminalEvent`, `responseCompleted`, `responseIncomplete`, `responseCancelled`, `responseFailed`, `responseStatus`, `responseIncompleteReason`, `responseIncompleteDetails`.
- Anthropic Messages: `messageStopped`, `stopReason`.
- All protocols: `usagePromptTokens`, `usageCompletionTokens`, `usageTotalTokens` when supplied upstream.

Examples:

```text
finishReason="length"
→ likely completion-limit truncation

finishReason="tool_calls" + malformed Tool JSON
→ Tool boundary declared, but arguments were invalid

doneReceived=false
→ inspect stream termination and parser completion
```

For OpenAI Tool passthrough these are diagnostics only; they do not revoke delivered bytes.

Responses terminal interpretation:

```text
responseTerminal=true
responseIncomplete=true
responseStatus="incomplete"
responseIncompleteReason="max_output_tokens"
→ valid terminal response; replay unchanged, no reasoning_without_output Recovery
```

The upstream may emit the official `response.incomplete` event or a `response.completed` event whose embedded response object has `status="incomplete"`. The response object status is authoritative. `response.failed` and explicit error events remain failures. Terminal `response.output[]` and done events are authoritative and may supply complete reasoning, output text, refusal, or function-call arguments even when no delta event preceded them.

## Bounded Tool observation

Configuration:

```text
TOOL_PASSTHROUGH_OBSERVATION_MAX_BYTES=65536
```

After OpenAI Tool commit, the parser retains at most this many UTF-8 bytes per Tool argument for diagnostics. Total `argumentBytes` and fragment counts remain exact and incremental.

```text
65536 → retain up to 64 KiB per Tool argument
0     → retain no Tool argument content; counters only
```

When the retained prefix is incomplete:

```text
argumentsObservationTruncated=true
argumentRetainedBytes=<bounded prefix>
argumentBytes=<exact total observed bytes>
```

The Proxy does not parse the prefix as if it were the complete JSON document.

## Tool argument growth thresholds

```text
TOOL_ARGUMENT_WARNING_BYTES=8192
TOOL_ARGUMENT_CRITICAL_BYTES=16384
MAX_TOOL_ARGUMENT_BYTES=8388608
```

Warning and critical thresholds are diagnostic. Each Attempt/Tool Call emits each event at most once:

```text
tool_argument_growth_warning
tool_argument_growth_critical
```

For transparent OpenAI Tool Calls, even `MAX_TOOL_ARGUMENT_BYTES` cannot revoke the stream after commit. The hard limit remains enforceable on protected validation paths, including Anthropic.

## Tool Result round-trip

A later request is divided into full history and newly trailing Tool Results:

```text
tool_result_context
  historyCount=...
  latestTurnCount=...
  correlatedCount=...

tool_results_received
  count=<latest-turn only>
  historyCount=<full history>
  parentRequestIds=[...]
  toolRoundTripMs=...
```

- `historyCount > 0`, `latestTurnCount = 0`: only old Tool Results are present.
- `latestTurnCount > 0`: the request contains a newly trailing Tool Result round.
- A correlated latest-turn result followed by `upstream_waiting_first_byte` means Hermes completed the Tool round-trip and the Proxy is waiting on vLLM.

## Client retry diagnosis

The Proxy hashes the guarded API path plus exact raw request body. A byte-identical request repeated within the TTL emits:

```text
client_retry_detected
previousRequestId=...
previousTerminalEvent=...
previousFailureReason=...
previousRetryable=...
retryDelayMs=...
retryDelayAfterTerminalMs=...
previousRequestDurationMs=...
requestStartIntervalMs=...
retryOrdinal=...
```

Definitions:

- `retryDelayAfterTerminalMs`: current request start minus previous terminal event.
- `previousRequestDurationMs`: previous terminal event minus previous request start.
- `requestStartIntervalMs`: current request start minus previous request start.
- `retryDelayMs`: compatibility field; equals delay after terminal when available, otherwise start interval.

Only the first 16 hex characters of SHA-256 are logged. Near-duplicate or semantically equivalent requests are intentionally not correlated.

```text
CLIENT_RETRY_FINGERPRINT_TTL_MS=900000
CLIENT_RETRY_FINGERPRINT_MAX_ENTRIES=10000
```

## Malformed Tool diagnostics

Protected validation and complete observe-only samples can expose payload-safe fields:

```text
toolCallCount
toolCallKey
toolCallIndex
toolCallId
toolName
toolArgumentBytes
toolArgumentFragments
parseErrorCategory
parseErrorOffset
parseErrorOffsetUnit="utf16_code_unit"
parseErrorLine
parseErrorColumn
toolArgumentUtf8Bytes
toolArgumentUtf16Length
toolArgumentCodePoints
parseErrorAtEnd
```

No complete Tool payload is logged at normal levels. On OpenAI transparent Tool paths, malformed diagnostics are warnings with `action=observe_only`; on Anthropic protected paths, deterministic Tool structure errors remain non-retryable validation failures.

## Metrics

Protocol metrics include:

```text
<protocol>_client_retries_detected_total
<protocol>_tool_argument_warnings_total
<protocol>_tool_argument_critical_total
<protocol>_tool_passthrough_started_total
<protocol>_tool_passthrough_completed_total
<protocol>_tool_passthrough_interruptions_total
<protocol>_tool_passthrough_validation_warnings_total
```

The passthrough counters normally increase only for the OpenAI runtime. Metric prefixes are:

```text
vllm_openai_proxy_...
vllm_cc_proxy_...
```

Use `/metrics`, `/metrics/openai`, or `/metrics/cc`.

## Buffer fields

- `rawBufferedBytes`: pre-commit raw bytes retained by Protected Streaming; it drops to zero after OpenAI Tool commit.
- `parsedSemanticBytes`: exact semantic bytes observed from the model.
- `parsedSemanticRetainedBytes`: bytes actually retained by the parser for diagnostics; bounded Tool prefixes make this lower after large Tool streams.
- `toolPassthroughCommitted`: whether the irreversible boundary has been crossed.
- `toolPassthroughBufferedBytes`: raw bytes flushed at commit.
- `toolPassthroughElapsedMs`: time since Tool passthrough started.
- `globalBufferUtilizationRatio`: `0` to `1`.
- `globalBufferUtilizationPercent`: `0` to `100`.
- `globalBufferUtilization`: legacy ratio.
- `estimatedRequestMemoryBytes`: diagnostic estimate, not exact V8 heap accounting.

## Data safety

Tool arguments and results are excluded from normal logs. Only with both:

```text
LOG_LEVEL=trace
LOG_TOOL_PAYLOADS=true
```

the Proxy emits a truncated preview with common credential fields redacted. This may still expose project data and should only be enabled for controlled debugging. Set `TOOL_PASSTHROUGH_OBSERVATION_MAX_BYTES=0` when no in-memory Tool argument prefix should be retained after commit.

## Responses request tools and actionless completion

At debug level, every guarded OpenAI request emits a schema-free tool summary:

```text
request_tool_context
requestToolCount=...
requestToolNames=[...]
requestToolChoice="auto|required|none|function:<name>"
requestToolsEnabled=true|false
parallelToolCallsRequested=true|false|null
```

When a completed Responses result only promises future execution and emits no Function Call:

```text
actionless_completion_detected
attempt=1
retryable=true

recovery_request_built
recoveryMode="action_required"
forcedToolChoice="required"
```

If the one required-tool Recovery still emits no Function Call:

```text
actionless_completion_fused
attempt=2
retryable=false
```

Prometheus counters:

```text
*_actionless_completions_detected_total
*_actionless_recoveries_fused_total
```

These diagnostics contain tool names and counts only; Tool schemas and generated text are not logged.



## Responses Hosted Tool and malformed-tool diagnostics

When `chat_adapter` drops optional Hosted Tools:

```text
event=responses_hosted_tools_filtered
hostedToolPolicy="drop_optional"
droppedToolTypes=["web_search"]
droppedToolCount=1
remainingToolCount=<client tools>
requestContinued=true
```

Required Hosted Tools are rejected before upstream execution with `required_hosted_tool_unavailable` and include `requiredToolType`／`required_tool_type` in structured diagnostics.

Malformed required-tool retry lifecycle:

```text
malformed_tool_arguments_retry_completed
→ one constrained Chat sub-attempt succeeded

malformed_tool_arguments_retry_fused
→ the one permitted sub-attempt also failed
→ final code malformed_required_tool_arguments
→ retryable=false
```

Prometheus counters:

```text
vllm_openai_proxy_hosted_tools_filtered_total
vllm_openai_proxy_required_hosted_tools_rejected_total
vllm_openai_proxy_malformed_tool_retries_total
vllm_openai_proxy_malformed_tool_retry_failures_total
```

## Claude Code Managed WebSearch

When the opt-in SearXNG bridge executes at least one managed search, the Anthropic runtime emits:

```text
event=managed_websearch_completed
attempt=<attempt number>
phase=initial|recovery
uses=<executed WebSearch calls>
failures=<SearXNG failures returned as error tool_result>
limitReached=true|false
```

Queries, snippets, titles, URLs, tool arguments, and result payloads are not included in normal logs.

Prometheus counters:

```text
vllm_cc_proxy_managed_web_search_executions_total
vllm_cc_proxy_managed_web_search_failures_total
vllm_cc_proxy_managed_web_search_limits_total
```

## Managed Web Tools

Managed WebSearch emits `managed_websearch_completed`. Managed WebFetch emits `managed_webfetch_completed` with `uses`, `failures`, `chunks`, and `limitReached`. Metrics:

```text
vllm_cc_proxy_managed_web_search_executions_total
vllm_cc_proxy_managed_web_search_failures_total
vllm_cc_proxy_managed_web_search_limits_total
vllm_cc_proxy_managed_web_fetch_executions_total
vllm_cc_proxy_managed_web_fetch_failures_total
vllm_cc_proxy_managed_web_fetch_limits_total
vllm_cc_proxy_managed_web_fetch_chunks_total
```

Managed tool calls are server-side internal operations, so Claude Code does not display `Search(...)` or `WebFetch(...)`. The final response or next ordinary Claude Code Tool Call is replayed after the internal loop completes.

## Managed Web Tool queue progress

A homogeneous WebSearch or WebFetch batch emits one lifecycle event per settled queue item:

```text
event=managed_tool_item_completed
kind="search" | "fetch"
toolUseId="..."
toolName="WebSearch" | "WebFetch"
ok=true | false
completed=1
total=3
durationMs=...
```

No query, URL, snippet, fetched page, or Tool Result content is logged. When either Managed Web bridge is enabled, a streaming request immediately begins one valid Anthropic lifecycle:

```text
event: message_start
event: content_block_start   # progress block index 0
event: content_block_delta   # invisible zero-width text delta
```

The Proxy sends another valid `content_block_delta` every `MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS` and immediately when a queue item settles. After the final internal model response arrives, the progress block is closed, upstream `message_start` is discarded, upstream content indexes are shifted by one, and the remaining SSE events are spliced into the same lifecycle. This avoids duplicate `message_start` frames and avoids relying on pre-message `event: ping`, which Claude Code may ignore for idle-timeout accounting.

Metrics:

```text
vllm_cc_proxy_managed_web_tool_items_completed_total
vllm_cc_proxy_managed_web_tool_progress_pings_total   # compatibility counter for item-completion progress
vllm_cc_proxy_managed_stream_progress_deltas_total
vllm_cc_proxy_managed_stream_splices_total
```

Queue and stream controls:

```text
MANAGED_WEB_TOOLS_MAX_BATCH=8
MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS=15000
WEBSEARCH_MAX_PARALLEL=2
WEBFETCH_MAX_PARALLEL=2
```
