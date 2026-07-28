# VLLM-PROXY-SUITE v0.5.8 Validation

Validated in the artifact environment:

- `npm test`: 174 tests passed, 0 failed in both the source tree and a clean ZIP extraction.
- `npm run check`: passed in both the source tree and a clean ZIP extraction.
- All 47 JavaScript files passed `node --check`.
- Package validator reports version `0.5.8`, 59 files, 32 required files, and `valid:true`.
- Compose YAML parses successfully, defines one `vllm-proxy-suite` service, and defaults `RESPONSES_UPSTREAM_MODE` to `chat_adapter` through `VLLM_PROXY_RESPONSES_UPSTREAM_MODE`.
- The Compose startup command passed `sh -n` after YAML parsing.
- Single Gateway smoke passed `/health/live`, `/health/ready`, `/health/cc`, `/health/openai`, combined `/metrics`, and graceful SIGTERM drain with exit code `0` in both source and clean ZIP trees.
- Source and clean ZIP manifests are identical at 59 files.
- `/v1/responses` supports selectable `chat_adapter` and `native` upstream modes; `chat_adapter` is the default.
- Adapter mode sends converted requests to vLLM `/v1/chat/completions` while preserving the external Codex `/v1/responses` contract.
- Request conversion covers instructions, developer/system messages, text input, user images, assistant history, function/custom/namespace tools, Responses Lite `additional_tools`, Tool Call results, tool choice, parallelism, output limits, reasoning effort, and supported text formats.
- Chat JSON and SSE reconstruction covers reasoning summaries, text output, function calls, custom tool calls, namespace restoration, usage, monotonic event sequence numbers, `response.completed`, and length-to-`response.incomplete` mapping.
- Function and custom tools cross the existing transparent Tool passthrough boundary before terminal completion; custom freeform input finishes with `response.custom_tool_call_input.done`.
- Text-before-reasoning interleaving preserves the correct Responses `output_index` for both items.
- Unsupported hosted/stateful Responses capabilities and unknown content blocks return typed HTTP 400 errors before contacting vLLM.
- Non-stream Responses JSON, Actionless Completion Recovery, Think Loop Guard, native Responses mode, OpenAI Chat behavior, and Anthropic/Claude Code recovery remain covered.

Not validated in this environment:

- Docker image/container build or execution.
- Live Codex/Hermes/OpenAI SDK → Gateway → vLLM or Claude Code → Gateway → vLLM integration.
- Production load, long-duration throughput, and multi-client backpressure behavior.
- OpenAI-hosted tools, server-side `previous_response_id` state, background Responses, stored Responses, encrypted reasoning persistence, computer use, local-shell specialized items, or compaction items in `chat_adapter` mode.

```bash
node --version
npm test
npm run check
```
