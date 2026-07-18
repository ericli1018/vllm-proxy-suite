# Validation Report

## Environment

- Date: 2026-07-18
- Node.js: 22.16.0
- Docker CLI: not installed in the execution environment
- Architecture: single-process JavaScript Gateway

## Verified

- `apps/gateway/server.js` is the only deployed HTTP listener and routes native API paths directly to in-process Anthropic/OpenAI runtimes.
- `/v1/messages` and `/v1/messages/count_tokens` route to Anthropic; the remaining `/v1/*` routes to OpenAI; unknown paths return `404`.
- Anthropic and OpenAI use separate external API keys while forwarding directly to the configured vLLM base URL.
- Guarded Anthropic Messages and OpenAI Chat Completions requests both execute successfully through the single Gateway in integration tests.
- Suite health, protocol health, combined metrics, protocol metrics and graceful drain are observable from port `3456`.
- Full `node:test` suite passes: 74 tests, 0 failures.
- `npm run check` passes and package validation reports the `single-process-javascript-gateway` architecture.
- Every JavaScript source file under `apps/`, `packages/`, and `scripts/`, plus `vllm-proxy-suite.js`, passes `node --check`.
- Compose YAML parses successfully and defines exactly one service named `vllm-proxy-suite`.
- Compose publishes only `3456`, contains no Nginx service, and contains no internal protocol listener ports.
- Compose startup shell passes `sh -n` after Docker Compose dollar escaping is resolved.
- Compose repository source is exactly `https://github.com/ericli1018/vllm-proxy-suite.git`.
- The real `vllm-proxy-suite.js` entry point starts, reports live/ready, exposes combined metrics, and drains cleanly on `SIGTERM`.
- Claude Code Tool Recovery and OpenAI network-tool Recovery regression tests remain passing.

## Not Executed Here

A real Docker container build, `docker compose config`, live GitHub clone inside the container, and end-to-end integration with the target vLLM, Claude Code and OpenAI SDK were not executed because Docker is not installed in this environment.
