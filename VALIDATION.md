# VLLM-PROXY-SUITE v0.5.9 Validation

Validated in the artifact environment:

- `npm test`: 191 tests passed, 0 failed in both the source tree and a clean candidate ZIP extraction.
- `npm run check`: passed in both the source tree and a clean candidate ZIP extraction.
- All 49 JavaScript files passed `node --check`.
- Package validator reports version `0.5.9`, 61 files, 34 required files, and `valid:true`.
- Compose YAML parses successfully, defines one `vllm-proxy-suite` service, and defaults `RESPONSES_UPSTREAM_MODE` to `chat_adapter`.
- Compose defaults `RESPONSES_HOSTED_TOOL_POLICY` to `drop_optional` and exposes malformed required-tool retry controls.
- The Compose startup command passed `sh -n` after YAML parsing.
- Single Gateway smoke passed `/health/live`, `/health/ready`, `/health/cc`, `/health/openai`, combined `/metrics`, and graceful SIGTERM drain with exit code `0` in both source and clean candidate trees.
- Source and clean candidate manifests are identical at 61 files.
- Optional `web_search`, `web_search_preview`, file-search, Code Interpreter, Computer Use, and Image Generation declarations are filtered in `drop_optional` mode while function/custom/namespace tools continue to Chat upstream.
- Responses Lite `additional_tools` is normalized before Hosted Tool filtering.
- `allowed_tools` is filtered as a closed allowlist; filtering does not widen the permitted Client tool set.
- All-hosted optional requests remove empty Chat `tools` and `tool_choice` fields instead of sending invalid empty tool controls to vLLM.
- Explicit or required Hosted Tools without a supported Client-executed alternative return typed `required_hosted_tool_unavailable` before upstream execution.
- `reject` and `native_only` Hosted Tool policies remain covered.
- Required Tool generations that receive a vLLM 400 malformed/unterminated arguments error receive exactly one constrained adapter sub-attempt.
- The constrained retry lowers temperature, guarantees a minimum output-token budget, disables parallel calls, requests a small complete JSON object, and explicitly selects the Function when only one tool remains.
- A successful malformed-tool retry is reconstructed into the normal Responses Function Call lifecycle.
- A second parser rejection is fused as typed `malformed_required_tool_arguments` with `retryable:false`; it is not returned as nested generic `upstream_http_error`.
- Prometheus exposes Hosted Tool filtering/rejection and malformed-tool retry/failure counters.
- Existing `chat_adapter`/`native` modes, Function/Custom/Namespace Tool conversion, transparent Tool passthrough, Think Loop Guard, Actionless Completion Recovery, Responses terminal handling, OpenAI Chat behavior, and Anthropic/Claude Code recovery remain covered.

Not validated in this environment:

- Docker image/container build or execution.
- Live Codex/Hermes/OpenAI SDK → Gateway → vLLM or Claude Code → Gateway → vLLM integration.
- Actual OpenAI Hosted Tool execution; `chat_adapter` filters optional declarations but does not emulate provider-hosted tools.
- Production load, long-duration throughput, and multi-client backpressure behavior.
- Whether every target model/tool parser will recover from malformed Tool arguments on the constrained retry.

```bash
node --version
npm test
npm run check
```
