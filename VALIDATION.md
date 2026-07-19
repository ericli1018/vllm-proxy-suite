# VLLM-PROXY-SUITE v0.5.2 Validation

Validated in the artifact environment:

- `npm test`: 103 tests passed, 0 failed.
- `npm run check`: passed before packaging and repeated after clean ZIP extraction.
- All production JavaScript files passed `node --check`.
- Compose YAML parsed successfully and defines exactly one `vllm-proxy-suite` service on `3456:3456`.
- Compose startup shell passed `sh -n`.
- Completion-boundary diagnostics expose Chat finish reasons/`[DONE]`, Responses status/completion, Anthropic stop state, and normalized usage where available.
- Tool Result diagnostics separate full request history from trailing latest-turn Tool Results; only latest-turn results are logged as newly received and correlated.
- Exact byte-identical retries are correlated through a bounded monotonic TTL registry and expose previous terminal outcome, delay, and retry ordinal.
- Tool argument warning/critical thresholds emit at most once per attempt/Tool Call and do not log payload contents.
- Prometheus counters report detected client retries and Tool argument warning/critical events per protocol.
- Malformed Tool JSON reports explicit UTF-16 parse-offset units plus UTF-8, UTF-16, code-point, and end-of-input diagnostics.
- Semantic counters exclude metadata, pings, usage and completion events.
- Tool Call continuation fragments without a repeated Chat Completions `index` remain attached to the active call, while a new Tool Call ID still creates a distinct call.
- Transport chunks and parsed SSE events are reported separately.
- Request duration and rate calculations use a monotonic clock.
- Response replay waits for Node `finish`; Buffer Budget remains reserved through replay.
- Every logged `request_started` produces exactly one terminal lifecycle event.
- Text logging escapes control characters and protects reserved record fields.
- Optional Tool payload previews are trace-only, redacted and truncated.
- The clean ZIP extraction is re-tested with the full test suite, package validator, and Gateway smoke test.

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
