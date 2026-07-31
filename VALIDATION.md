# VLLM-PROXY-SUITE v0.6.3 Validation

Validation date: 2026-07-31

## Scope

This validation covers the single-process JavaScript Gateway, Claude Code Managed WebSearch → SearXNG bridge, the completed opt-in SearXNG Compose backend, existing Anthropic/OpenAI protocol behavior, packaging, and clean extraction.

## Source verification

- `npm test`: 218 passed, 0 failed.
- `npm run check`: passed.
- JavaScript syntax: 55 files passed `node --check`.
- Package validator: `valid:true`, version `0.6.3`, 67 files, 40 required files.
- Compose YAML parsed successfully with services `vllm-proxy-suite` and `searxng`.
- Only the Gateway publishes host port `3456:3456`; SearXNG uses internal `expose: 8080`.
- SearXNG is gated behind the `websearch` profile and joins `vllm-test-network`.
- Named volumes `searxng-config` and `searxng-data` persist `/etc/searxng` and `/var/cache/searxng`.
- Embedded SearXNG initialization shell passed `sh -n` and creates default-engine settings with HTML/JSON formats plus a generated or supplied secret.
- Gateway embedded Compose startup command passed `sh -n`.
- Gateway smoke: `/health/live`, `/health/ready`, `/health/cc`, `/health/openai`, and `/metrics` passed.
- Managed WebSearch metrics were present with zero startup values.
- Graceful SIGTERM: process exit code 0.

## Managed WebSearch behavior verified

- Exactly one configured `WebSearch` Tool Call is hidden from Claude Code and executed through SearXNG.
- SearXNG results are normalized, URL-deduplicated, domain-filtered, byte-bounded, and returned as untrusted standard Anthropic `tool_result` content.
- The internal continuation can return final text or a normal Claude Code Tool Call such as `Bash`.
- Streaming and non-streaming Anthropic responses are supported.
- SearXNG failures become `is_error:true` tool results and do not expose the hidden WebSearch call.
- Search-use limits remove the managed tool before the final continuation.
- Oversized queries are rejected before contacting SearXNG.
- Unsupported/opaque Anthropic content blocks disable interception to avoid lossy reconstruction.
- Mixed or parallel Tool Calls are passed through unchanged.

## Compose backend behavior verified

- Official image reference: `docker.io/searxng/searxng:${SEARXNG_VERSION:-latest}`.
- Profile activation: `docker compose --profile websearch up -d searxng vllm-proxy-suite`.
- No host SearXNG port is published by the partial Compose file.
- First start initializes `/etc/searxng/settings.yml` only when absent, preserving later operator edits.
- JSON Search API is enabled by the generated settings.
- Healthcheck probes the internal SearXNG HTTP listener.
- External SearXNG remains supported by leaving the profile disabled and overriding `SEARXNG_BASE_URL`.

## Clean ZIP verification

- Clean extraction tests: 218 passed, 0 failed.
- Clean extraction `npm run check`: passed.
- JavaScript syntax: 55 files passed.
- Package validator: `valid:true`, 67 files, 40 required files.
- Source and extracted ZIP SHA-256 manifests: identical.
- ZIP root: exactly `VLLM-PROXY-SUITE/`.
- Gateway health/metrics smoke: passed.
- Graceful SIGTERM: exit code 0.
- Versioned and fixed-name ZIP artifacts: byte-identical.

## Not executed in this environment

- Docker image pull/build or a real Docker Compose deployment; Docker CLI is unavailable in this runtime.
- Live Claude Code → Gateway → target vLLM → SearXNG execution.
- Real SearXNG engine quality, rate limits, authentication, or internet access.
- Long-duration concurrency, production load, and failure-injection testing.
- WebFetch, PDF extraction, Anthropic Hosted Web Search emulation, encrypted content, or native citation generation.
