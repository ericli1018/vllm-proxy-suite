# Observability and Hermes Tool-Loop Diagnosis

## Log level policy

- `error`: terminal failures only.
- `warn`: abnormal but diagnosable conditions, including stalls, loops, cancellations, and rejected guarded requests.
- `info`: request lifecycle, recovery, tool readiness/delivery, correlated tool results, and tool-bearing replay events.
- `debug`: state transitions, all replay events, and periodic progress snapshots.
- `trace`: transport chunk metadata and optional redacted payload previews.

Normal operation should use `info`. Use `debug` while diagnosing long reasoning or tool-loop waits. `trace` is intended for short controlled reproductions.

## Progress interpretation

Transport and semantic progress are independent:

```text
upstreamBytes / upstreamChunks
→ bytes are arriving from vLLM

sseEvents
→ complete protocol events are being parsed

semanticBytes
→ reasoning, content, tool-name, or tool-argument bytes are increasing
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

For Chat Completions, a continuation fragment that omits `index` is attached to the active Tool Call instead of being counted as a new call. Per-call keys use `choice:<choice>/tool:<index>`. Responses use `output:<index>/call:<id>`, and Anthropic uses `block:<index>`.

## Hermes tool round-trip

The expected sequence is:

```text
tool_calls_ready
response_replay_started
response_replay_completed
tool_calls_delivered
request_completed
```

A later Hermes request should contain:

```text
tool_results_received
parentRequestIds=[source request ID]
toolCallIds=[call ID]
toolRoundTripMs=...
```

Interpretation:

- `tool_calls_ready` without `response_replay_completed`: the proxy did not finish replaying the protected response.
- `tool_calls_delivered` without a later correlated `tool_results_received`: Node finished writing the response, but Hermes did not submit the next tool-result request before the correlation TTL expired.
- Correlated `tool_results_received`, followed by `upstream_waiting_first_byte`: Hermes completed the tool round-trip and the proxy is waiting on vLLM.
- Correlated `tool_results_received`, followed by active semantic progress: the next model generation is operating normally.

`tool_calls_delivered` is based on Node's response `finish` event. It is not a Hermes application-level acknowledgement. A correlated tool-result request is the strongest available acknowledgement.

## Data safety

Tool arguments and results are excluded by default. With both conditions below:

```text
LOG_LEVEL=trace
LOG_TOOL_PAYLOADS=true
```

The proxy emits a truncated preview and redacts common credential keys. This mode can still expose project data and should only be used for controlled debugging.

## Malformed Tool argument diagnostics

Deterministic Tool JSON failures are logged with `retryable:false` and safe fields such as:

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
parseErrorLine
parseErrorColumn
```

The full Tool arguments are not included. `malformed_tool_arguments` and equivalent Anthropic/Responses failures bypass generic Proxy Recovery to avoid repeating the same invalid generation inside the Proxy.
