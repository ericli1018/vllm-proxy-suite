# VLLM-PROXY-SUITE v0.5.4 Validation

Validated in the artifact environment:

- `npm test`: 122 tests passed, 0 failed.
- `npm run check`: passed.
- Source and clean ZIP extraction both passed the full test suite and package validator.
- All 41 JavaScript files passed `node --check`.
- Package validator reports version `0.5.4`, 53 files, 26 required files, and `valid:true`.
- Compose YAML parses successfully and defines exactly one `vllm-proxy-suite` service on `3456:3456`.
- Compose startup shell passed `sh -n`.
- Single Gateway smoke passed `/health/live`, `/health/ready`, `/health/cc`, `/health/openai`, combined `/metrics`, and graceful SIGTERM drain.
- OpenAI Chat Recovery merges its instruction into the single leading System Message or inserts it at `messages[0]` when absent.
- OpenAI Chat Recovery preserves user, assistant, Tool Call, and Tool Result history order.
- Client-supplied System Messages outside `messages[0]` are rejected with HTTP 400 before vLLM is contacted.
- Leading System Message content arrays retain their existing blocks and receive a new Recovery text block.
- OpenAI Responses Recovery remains based on `instructions` and is unaffected by Chat message ordering.
- OpenAI Chat Completions and Responses commit buffered bytes at the first Tool Call and stream later upstream bytes before upstream completion.
- OpenAI malformed Tool arguments remain in the original status-200 stream and produce observe-only diagnostics rather than Proxy failure or Recovery.
- Non-stream OpenAI Tool responses bypass Tool argument validity gates unchanged after the complete JSON body is received.
- Thinking Loop detection remains active before the OpenAI Tool commit boundary and is disabled after the irreversible commit.
- Anthropic Messages and Claude Code Tool validation/recovery remain fail closed and retain protected replay behavior.
- Heartbeat output stops before raw OpenAI Tool SSE commit.
- Tool passthrough honors Node response backpressure and waits for response `finish` at normal completion.
- Tool passthrough start/write/end failures are marked as committed interruptions and cannot trigger a second Recovery stream.
- Tool argument observation is bounded by `TOOL_PASSTHROUGH_OBSERVATION_MAX_BYTES`; `0` retains no argument content while total bytes and fragments remain exact.
- Chat Completions and Responses retained-byte counters remain incremental during long Tool streams.
- Truncated diagnostic prefixes are not misclassified as complete invalid Tool JSON.
- Progress distinguishes exact `parsedSemanticBytes` from bounded `parsedSemanticRetainedBytes`.
- Exact-request retry timing separates delay after terminal, previous request duration, and request-start interval.
- Prometheus output includes Tool passthrough start, completion, interruption, and observe-only validation warning counters.
- Source and clean ZIP manifests are identical.

Not validated in this environment:

- Docker image/container build or execution.
- Live Hermes → Gateway → vLLM, OpenAI SDK → Gateway → vLLM, or Claude Code → Gateway → vLLM integration.
- Production load, long-duration throughput, and multi-client backpressure behavior.
- Application-level acknowledgement that Hermes consumed Tool bytes after Node emitted response `finish`.
- Whether a target model/client produces complete Tool arguments within its configured completion-token budget.

```bash
node --version
npm test
npm run check
```
