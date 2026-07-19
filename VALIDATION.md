# VLLM-PROXY-SUITE v0.5.1 Validation

Validated in the artifact environment:

- `npm test`: 95 tests passed, 0 failed.
- `npm run check`: passed.
- All production JavaScript files passed `node --check`.
- Compose YAML parsed successfully and defines exactly one `vllm-proxy-suite` service on `3456:3456`.
- Compose startup shell passed `sh -n`.
- Semantic counters exclude metadata, pings, usage and completion events.
- Tool Call continuation fragments without a repeated Chat Completions `index` remain attached to the active call.
- Debug progress reports exact Tool Call count and per-call argument bytes/fragments across all three guarded protocols.
- Malformed Tool JSON exposes safe parse category/offset/line/column diagnostics and bypasses generic Proxy Recovery.
- Fragmented Chat Completions and Responses tool arguments count as semantic activity.
- Transport chunks and parsed SSE events are reported separately.
- Request duration and rate calculations use a monotonic clock.
- Response replay waits for Node `finish` before `response_replay_completed`, `tool_calls_delivered`, and `request_completed`.
- Buffer Budget remains reserved through protected response replay.
- Tool Call IDs correlate to later Chat Completions, Anthropic and Responses tool results with bounded TTL/capacity.
- Every logged `request_started` produces exactly one terminal lifecycle event.
- Text logging escapes control characters and protects reserved record fields.
- Optional tool payload previews are trace-only, redacted and truncated.
- The clean ZIP extraction was tested separately with the full test suite and package validator.

Not validated in this environment:

- Docker image/container execution.
- Live Hermes → Gateway → vLLM integration.
- Production load and long-duration throughput behavior.
- Application-level acknowledgement that Hermes consumed bytes after Node emitted response `finish`.

```bash
node --version
npm test
npm run check
```
