# Observability and Hermes Tool-Loop Diagnosis

## Log level policy

- `error`: terminal failures only.
- `warn`: stalls, loops, cancellations, rejected requests, Tool argument growth thresholds, and retries of previously failed requests.
- `info`: request lifecycle, recovery, Tool readiness/delivery, latest-turn Tool results, and replay events.
- `debug`: state transitions, periodic progress, exact-request retry fingerprints, and full-history versus latest-turn Tool Result context.
- `trace`: transport chunk metadata and optional redacted payload previews.

Normal operation should use `info`. Use `debug` while diagnosing long reasoning or Tool-loop waits. Use `trace` only for short controlled reproductions.

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
→ the model is still assembling Tool Call arguments; this is semantic activity
```

Tool diagnostics in `debug` progress:

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

For Chat Completions, a continuation fragment that omits `index` is attached to the active Tool Call. A fragment carrying a new Tool Call `id` still creates a new call. Per-call keys use `choice:<choice>/tool:<index>`. Responses use `output:<index>/call:<id>`, and Anthropic uses `block:<index>`.

## Completion and usage diagnostics

Progress and terminal records normalize the upstream completion boundary:

- Chat Completions: `finishReason`, `finishReasonsByChoice`, `doneReceived`.
- Responses: `responseCompleted`, `responseFailed`, `responseStatus`.
- Anthropic Messages: `messageStopped`, `stopReason`.
- All protocols expose normalized `usagePromptTokens`, `usageCompletionTokens`, and `usageTotalTokens` when the upstream provides them.

Use these fields to distinguish:

```text
finishReason="length"
→ likely token-limit truncation

finishReason="tool_calls" + malformed Tool JSON
→ model/parser declared a Tool boundary but produced invalid arguments

doneReceived=false or no protocol completion marker
→ inspect stream termination and parser completion
```

## Tool argument growth thresholds

Configuration:

```text
TOOL_ARGUMENT_WARNING_BYTES=8192
TOOL_ARGUMENT_CRITICAL_BYTES=16384
MAX_TOOL_ARGUMENT_BYTES=8388608
```

Warning and critical thresholds are diagnostic only. Each attempt/Tool Call emits each event at most once:

```text
tool_argument_growth_warning
tool_argument_growth_critical
```

The hard rejection limit remains `MAX_TOOL_ARGUMENT_BYTES`. Threshold events include Tool identity, argument bytes, fragments, attempt, and phase; they never include the payload.

## Hermes Tool round-trip

Expected successful sequence:

```text
tool_calls_ready
response_replay_started
response_replay_completed
tool_calls_delivered
request_completed
```

A later Hermes request is split into two views:

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

Interpretation:

- `tool_calls_ready` without `response_replay_completed`: protected replay did not finish.
- `tool_calls_delivered` without a later correlated latest-turn result: Node finished writing, but Hermes did not submit the next Tool Result request before correlation expiry.
- `historyCount > 0` and `latestTurnCount = 0`: old Tool Results are merely present in conversation history; no new Tool Result was submitted in this request.
- Correlated latest-turn results followed by `upstream_waiting_first_byte`: Hermes completed the Tool round-trip and the Proxy is waiting on vLLM.
- Correlated latest-turn results followed by semantic progress: the next generation is operating normally.

`tool_calls_delivered` is based on Node's response `finish` event, not a Hermes acknowledgement. A correlated latest-turn Tool Result request is the strongest available acknowledgement.

## Client retry diagnosis

The Proxy hashes the guarded API path plus exact raw request body. A byte-identical request repeated within `CLIENT_RETRY_FINGERPRINT_TTL_MS` emits:

```text
client_retry_detected
previousRequestId=...
previousTerminalEvent=...
previousFailureReason=...
previousRetryable=...
retryDelayMs=...
retryOrdinal=...
```

Only the first 16 hex characters of the SHA-256 fingerprint are logged. This mechanism intentionally does not correlate near-duplicate or semantically equivalent requests.

Registry controls:

```text
CLIENT_RETRY_FINGERPRINT_TTL_MS=900000
CLIENT_RETRY_FINGERPRINT_MAX_ENTRIES=10000
```

## Malformed Tool argument diagnostics

Deterministic Tool JSON failures are logged with `retryable:false` and payload-safe fields:

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

`parseErrorOffset` comes from JavaScript's JSON parser and is not a UTF-8 byte offset. The separate length fields prevent incorrect direct comparison. Full Tool arguments are never included at normal levels.

Malformed, invalid, oversized, and excessive Tool structures bypass generic Proxy Recovery. They require a changed generation strategy rather than blind regeneration.

## Metrics

Each protocol exposes counters such as:

```text
<protocol>_client_retries_detected_total
<protocol>_tool_argument_warnings_total
<protocol>_tool_argument_critical_total
```

For the current metric prefixes:

```text
vllm_openai_proxy_...
vllm_cc_proxy_...
```

Use `/metrics`, `/metrics/openai`, or `/metrics/cc`.

## Buffer fields

- `globalBufferUtilizationRatio`: value from `0` to `1`.
- `globalBufferUtilizationPercent`: percentage from `0` to `100`.
- `globalBufferUtilization`: legacy ratio retained for compatibility.
- `estimatedRequestMemoryBytes`: diagnostic estimate, not exact V8 heap accounting.

## Data safety

Tool arguments and results are excluded by default. Only when both are enabled:

```text
LOG_LEVEL=trace
LOG_TOOL_PAYLOADS=true
```

the Proxy emits a truncated preview with common credential fields redacted. This can still expose project data and should only be used for controlled debugging.
