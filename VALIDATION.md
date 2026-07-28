# VLLM-PROXY-SUITE v0.6.0 Validation

Validated in the artifact environment:

- `npm test`: 197 tests passed, 0 failed in both the source tree and a clean ZIP extraction.
- `npm run check`: passed in both the source tree and a clean ZIP extraction.
- All 50 JavaScript files passed `node --check` in both trees.
- Package validator reports version `0.6.0`, 62 files, 35 required files, and `valid:true`.
- Compose YAML parses successfully, defines one `vllm-proxy-suite` service, defaults `RESPONSES_UPSTREAM_MODE` to `chat_adapter`, and defaults `RESPONSES_BEHAVIOR_MODE` to `transparent`.
- The Compose startup command passed `sh -n` after YAML parsing.
- Single Gateway smoke passed `/health/live`, `/health/ready`, `/health/cc`, `/health/openai`, combined `/metrics`, and graceful SIGTERM drain with exit code `0` in both source and clean trees.
- Source and clean ZIP manifests are byte-identical at 62 files.
- Transparent Responses mode delivers reasoning-only and narration-only `response.completed` results without Think Loop, Actionless, forced-tool, or malformed-tool automatic Recovery.
- Transparent mode preserves Hosted Tool filtering, Chat↔Responses conversion, Function/Custom/Namespace Tool passthrough, protocol parsing, request/body/buffer limits, timeouts, cancellation, and diagnostics.
- Non-stream reasoning-only completed JSON is accepted in transparent mode.
- `RESPONSES_BEHAVIOR_MODE=guarded` retains the previous Actionless and behavioral Recovery flow for A/B testing.
- OpenAI Chat Completions and Anthropic/Claude Code behavior remain covered by their existing guard/recovery tests.

Not validated in this environment:

- Docker image/container build or execution.
- Live Codex → Gateway → target vLLM integration.
- Production load, long-duration throughput, and multi-client backpressure behavior.
- Whether removing Proxy behavioral guards alone causes every target model to continue autonomously; transparent mode intentionally leaves that decision to Codex and the model.

```bash
node --version
npm test
npm run check
```
