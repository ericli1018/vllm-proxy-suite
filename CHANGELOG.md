# Changelog

## 0.5.0 - 2026-07-19

- Replaced synthetic semantic scores with UTF-8 byte counters for reasoning, content, tool names, and fragmented tool arguments.
- Separated upstream transport chunks from parsed SSE event counts.
- Added monotonic request timing, headers/first-byte/first-semantic latency, stream-average throughput, memory estimates, and buffer utilization.
- Added explicit upstream state transitions and terminal request lifecycle guarantees.
- Added protected response replay lifecycle; Buffer Budget is retained until Node response `finish`.
- Split tool-call readiness from replay completion and added bounded cross-request Tool Call/Tool Result correlation.
- Added OpenAI Responses `function_call_output` result detection.
- Added logger control-character escaping, reserved-field protection, and trace-only redacted payload previews.
- Added regression coverage for metadata-only semantic stalls and fragmented tool-argument activity.

## 0.4.0

- Added level-aware structured logging (`error`, `warn`, `info`, `debug`, `trace`).
- Added 10-second configurable request progress reporting with average and recent upstream bytes/sec.
- Added transport and semantic stall warnings.
- Added tool-call generation and tool-result receipt correlation without logging payload contents.
- Added request lifecycle, recovery lifecycle, cancellation, and completion records.
- Added Compose controls for log level, format, progress interval, stall threshold, and payload policy.


## 0.3.2

- Fixed Docker named-volume restarts failing with Git `dubious ownership` by registering `/app` as a safe directory before repository access.
- Replaced runtime `git pull --ff-only` with deterministic `fetch --force --prune`, `reset --hard FETCH_HEAD`, and `clean -fdx`.
- Kept the single JavaScript Gateway service and single published port `3456`.

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
