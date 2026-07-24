# Changelog

## 0.5.4 - 2026-07-24

- Fixed OpenAI Chat Recovery placing a new `role:"system"` message at the end of `messages[]`, which violated Ornith/vLLM chat-template ordering and caused `System message must be at the beginning` HTTP 400 failures.
- Recovery now merges its instruction into the existing leading System Message, or inserts one at `messages[0]` when none exists, without reordering user/assistant/tool history.
- Added support for leading System Message content arrays by appending a text content block instead of stringifying the array.
- Added request-contract validation that rejects Client-supplied System Messages outside `messages[0]` before contacting vLLM, returning `system_message_not_first` with message indexes.
- Added `recovery_request_built` and `recovery_request_rejected` diagnostics with instruction placement and System Message counts/indexes.
- Added unit and end-to-end OpenAI runtime coverage for leading-System merge, System-free insertion, late-System rejection, history preservation, and unaffected Responses Recovery.

## 0.5.3 - 2026-07-19

- Changed OpenAI Chat Completions and Responses to Reasoning-Guarded Transparent Tool Passthrough.
- Added an irreversible commit boundary at the first observed OpenAI Tool Call: buffered pre-Tool bytes are flushed immediately and later upstream bytes stream directly to the client with backpressure.
- Disabled Tool JSON blocking, rewriting, repair, splitting, and Recovery after the OpenAI Tool commit boundary; final Tool validation is observe-only.
- Kept Thinking Loop detection, semantic validation, and one Recovery attempt active before the Tool commit boundary.
- Preserved Anthropic Messages and Claude Code Tool validation/recovery as fail-closed buffered behavior.
- Added bounded Tool argument observation with exact total byte/fragment counters and configurable retained prefix size; `0` retains no argument content.
- Added Tool passthrough lifecycle metrics and logs, stopped SSE heartbeat before raw Tool stream commit, and made delivery-start failures irreversible to prevent replay after partial output.
- Fixed client retry delay diagnostics to separate delay-after-terminal, previous request duration, and request-start interval.
- Fixed per-call retained-byte accounting to remain incremental instead of reintroducing near O(n²) work on long Tool streams.

## 0.5.2 - 2026-07-19

- Added normalized completion-boundary diagnostics for Chat Completions, Responses, and Anthropic Messages, including finish/stop status, protocol completion markers, and usage tokens.
- Split Tool Result diagnostics into full conversation history and latest-turn results; only latest-turn results emit `tool_results_received` and participate in correlation.
- Added bounded exact-request fingerprint correlation and `client_retry_detected` events with previous terminal outcome, retry delay, and ordinal.
- Added configurable per-Tool argument warning/critical thresholds with once-per-attempt events and Prometheus counters.
- Clarified JSON parse offsets as UTF-16 code-unit positions and added UTF-8, UTF-16, code-point, and end-of-input diagnostics without logging Tool payloads.
- Added unambiguous global buffer ratio/percentage fields while retaining the legacy ratio field.
- Fixed the README Git update example so every existing-repository Git command uses command-local `safe.directory=/app`.
- Added regression coverage for completion diagnostics, Tool Result history separation, retry TTL/ordinal behavior, and Tool argument threshold events.

## 0.5.1 - 2026-07-19

- Added exact Tool Call count, indexes, IDs, names, per-call argument bytes, and fragment counts to debug progress for Chat Completions, Responses, and Anthropic Messages.
- Fixed Chat Completions continuation fragments without a repeated `index` being misclassified as new Tool Calls.
- Added safe JSON parse diagnostics for malformed Tool arguments, including category, byte offset, line, column, Tool identity, and argument size without logging payload contents.
- Marked malformed, oversized, invalid, and excessive Tool Call structures as non-retryable by the generic Proxy Recovery path.
- Propagated safe retryability and Tool diagnostics into terminal error logs and protocol error responses.
- Added regression coverage for single-call continuation, parallel Tool Call accounting, cross-protocol diagnostics, and retry-storm prevention.

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
