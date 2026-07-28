# VLLM-PROXY-SUITE v0.5.5 Validation

Validated in the artifact environment:

- `npm test`: 132 tests passed, 0 failed.
- `npm run check`: passed.
- Source and clean ZIP extraction both passed the full test suite and package validator.
- All 42 JavaScript files passed `node --check`.
- Package validator reports version `0.5.5`, 54 files, 27 required files, and `valid:true`.
- Compose YAML parses successfully and defines exactly one `vllm-proxy-suite` service on `3456:3456`.
- Compose startup shell passed `sh -n`.
- Single Gateway smoke passed `/health/live`, `/health/ready`, `/health/cc`, `/health/openai`, combined `/metrics`, and graceful SIGTERM drain.
- Streamed official `response.incomplete` reasoning-only responses validate and replay unchanged.
- vLLM `response.completed` events carrying `response.status="incomplete"` validate and replay unchanged.
- Non-stream incomplete Responses JSON is returned byte-for-byte with HTTP 200 and no Recovery.
- `response.failed` and explicit upstream errors remain fail-closed.
- Reasoning text/summary, output text, refusal, function-call argument done events, and `response.output_item.done` are parsed without duplicating earlier deltas.
- Terminal response `output[]` is ingested when no preceding delta events exist.
- Progress and terminal logs expose response terminal state, incomplete reason/details, and usage tokens.
- OpenAI Chat Recovery retains exactly one leading System Message and rejects late Client System Messages before vLLM.
- OpenAI Chat Completions and Responses retain Reasoning-Guarded Transparent Tool Passthrough.
- Anthropic Messages and Claude Code Tool validation/recovery remain fail closed.
- Source and clean ZIP manifests are identical.

Not validated in this environment:

- Docker image/container build or execution.
- Live Hermes → Gateway → vLLM, OpenAI SDK → Gateway → vLLM, or Claude Code → Gateway → vLLM integration.
- Production load, long-duration throughput, and multi-client backpressure behavior.
- Client-specific continuation behavior after receiving a valid Responses `status="incomplete"`.

```bash
node --version
npm test
npm run check
```
