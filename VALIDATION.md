# VLLM-PROXY-SUITE v0.6.1 Validation

Validated in the artifact environment:

- `npm test`: 206 tests passed, 0 failed in both the source tree and a clean final ZIP extraction.
- `npm run check`: passed in both the source tree and a clean final ZIP extraction.
- All 52 JavaScript files passed `node --check` in both trees.
- Package validator reports version `0.6.1`, 64 files, 37 required files, and `valid:true`.
- Compose YAML parses successfully, defines one `vllm-proxy-suite` service, defaults `RESPONSES_UPSTREAM_MODE` to `native`, `RESPONSES_BEHAVIOR_MODE` to `transparent`, and `RESPONSES_TOOL_CHOICE_POLICY` to `preserve`.
- The Compose startup command passed `sh -n` after YAML parsing.
- Single Gateway smoke passed `/health/live`, `/health/ready`, `/health/cc`, `/health/openai`, combined `/metrics`, the Tool Choice rewrite counter, and graceful SIGTERM drain with exit code `0` in both source and clean trees.
- Source and clean ZIP manifests are byte-identical at 64 files.
- The final ZIP root is exactly `VLLM-PROXY-SUITE/`.
- Versioned and fixed-name ZIPs are byte-identical.
- Native Responses is the default upstream path and preserves the original request body under the default `preserve` Tool Choice policy.
- `required_on_explicit_continue` rewrites only eligible short user execution turns from `auto`/omitted to `required`; Tool Result turns, no-tool requests, and explicit Client choices remain unchanged.
- Native Responses Lite `additional_tools` are included in safe request tool diagnostics.
- `chat_adapter` remains available as an explicit fallback and retains Hosted Tool filtering diagnostics.
- Responses remains behavior-transparent by default; no response-side Think Loop, Actionless, reasoning-only or malformed-tool automatic Recovery is introduced by this release.

Not validated in this environment:

- Docker image/container build or execution.
- Live Codex → Gateway → target vLLM integration.
- Production load, long-duration throughput, and multi-client backpressure behavior.
- Target-model tool selection reliability under `tool_choice=auto`.
- Whether the target vLLM/model accepts `tool_choice=required` for every Codex tool set used in production.

```bash
node --version
npm test
npm run check
```
