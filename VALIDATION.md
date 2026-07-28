# VLLM-PROXY-SUITE v0.5.6 Validation

Validated in the artifact environment:

- `npm test`: 138 tests passed, 0 failed.
- `npm run check`: passed.
- Source and clean ZIP extraction both passed the full test suite and package validator.
- All 43 JavaScript files passed `node --check`.
- Package validator reports version `0.5.6`, 55 files, 28 required files, and `valid:true`.
- Compose YAML parses successfully and defines exactly one `vllm-proxy-suite` service on `3456:3456`.
- Compose startup shell passed `sh -n`.
- Single Gateway smoke passed `/health/live`, `/health/ready`, `/health/cc`, `/health/openai`, combined `/metrics`, and graceful SIGTERM drain.
- A Responses stream containing repeated reasoning, visible output, and `response.completed` replays byte-for-byte with HTTP 200 and no Recovery.
- Visible Responses output closes the Think Loop Guard for later chunks in the same Attempt.
- A true three-repeat reasoning loop before output, Function Call, or terminal state is still detected.
- Exact suffix, normalized suffix, and ABAB cycle detection honor `LOOP_MIN_COUNT`.
- Production Compose defaults `LOOP_MIN_COUNT` to `3`; tests that intentionally exercise two-repeat recovery opt into `2`.
- Existing Responses incomplete/cancelled terminal handling, transparent Tool passthrough, OpenAI Chat Recovery, and Anthropic Claude Code Recovery remain covered.
- Source and clean ZIP manifests are identical.

Not validated in this environment:

- Docker image/container build or execution.
- Live Codex/Hermes/OpenAI SDK → Gateway → vLLM or Claude Code → Gateway → vLLM integration.
- Production load, long-duration throughput, and multi-client backpressure behavior.

```bash
node --version
npm test
npm run check
```
