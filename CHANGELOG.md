# Changelog

## 0.3.0 - 2026-07-18

- Replace the Nginx Gateway and dual protocol processes with one Node.js Gateway process.
- Add `apps/gateway/server.js` and `vllm-proxy-suite.js` as the primary runtime entry points.
- Route `/v1/messages` and `/v1/messages/count_tokens` directly to the Anthropic runtime in memory.
- Route the remaining `/v1/*` paths directly to the OpenAI runtime in memory.
- Preserve separate protocol API keys, metrics, active-request counters and buffer budgets inside the shared process.
- Add combined `/metrics`, protocol-specific metrics and suite health endpoints.
- Remove `apps/gateway/nginx.conf` and all internal `3457`／`3458` deployment ports.
- Rewrite Compose as one `node:22-alpine` service using a named volume.
- Configure Compose to clone or fast-forward update `https://github.com/ericli1018/vllm-proxy-suite.git` before starting the suite.

## 0.2.0 - 2026-07-18

- Add Anthropic-only Claude Code Tool Recovery without affecting the OpenAI runtime.
- Validate `Read`, `Edit`, `Write` and `NotebookEdit` against the request's actual `tools[]` and `input_schema`.
- Block no-op Edit calls and exact retries of mutations already proven failed.
- Require exact-target Read recovery when fresh file evidence is unavailable.
- Keep Bash handling conservative by invalidating Read freshness without rewriting shell commands.

## 0.1.0 - 2026-07-18

- Establish the shared Loop Guard Core and independent Anthropic/OpenAI adapters.
- Add OpenAI Chat Completions and Responses support.
- Add generic network lookup/download/hybrid tool capability classification.
- Add full-attempt raw-byte buffering, one Recovery attempt, health, metrics and graceful drain.
