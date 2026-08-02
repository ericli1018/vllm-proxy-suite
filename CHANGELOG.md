# Changelog

## 0.7.14 - 2026-08-02

- Moved Managed Web Tool stop-reason normalization ahead of Managed Tool classification, so a complete `web_search` or `WebFetch` Tool Call that incorrectly ends with `end_turn` is still consumed internally instead of being replayed to Claude Code.
- Added one-shot serialization for mixed parallel batches containing a Proxy-managed Web Tool plus client-executed Tools such as `TaskUpdate` or `Bash`. Managed work executes first; deferred client calls are not executed and must be reissued. A second mixed batch is fused as `managed_web_mixed_batch_repeated`, `retryable:false`.
- Added `managed_hosted_tool_escape` fail-closed protection. Hosted `web_search` responses that cannot be safely parsed or managed are blocked locally and can no longer escape back to Claude Code.
- Replaced the immediate post-limit API failure with one bounded finalization continuation. The first call to a disabled Search or Fetch kind receives an explicit error Tool Result instructing the model to continue with collected evidence; a second post-finalization call still fuses as `managed_web_tool_limit_repeated` with no further model request.
- Added runtime observability for Managed Web limit finalizations and mixed-batch serialization, plus focused unit and full-runtime regressions. `awesome-web-fetch` execution and Browser-to-Internal reroute accounting remain independent from `WEBFETCH_MAX_USES`.

## 0.7.13 - 2026-08-01

- Added a content-aware Managed WebFetch provider router. HTML and unknown browser-like pages can use the opt-in `awesome-web-fetch` Playwright sidecar, while PDF, plain text, Markdown, JSON, XML, CSV, TSV, YAML, and log documents retain the existing internal downloader and parsers.
- Added conservative routing: known document extensions bypass the sidecar; extensionless URLs use one bounded, SSRF-checked HEAD probe; probe failures and HTML responses route to the browser sidecar.
- Added tolerant consumption of `awesome-web-fetch` metadata including `source`, `final_url`, `title`, `content_type`, `status_code`, and `browser_rendered`, while preserving the existing Chunk Reader, Document Synthesizer, bounded Tool Result, and internal continuation.
- Added a one-way Browser-to-Internal reroute when sidecar metadata identifies a non-HTML document. The reroute occurs at most once, Internal never falls back to Browser, and sidecar failure never silently triggers a direct HTML GET.
- Added final-URL SSRF validation, bounded sidecar response parsing, API-key authentication, provider metrics, and an opt-in `awesome-web-fetch` service in the same Compose file under the `webfetch-browser` profile.
- Added focused unit and Gateway integration regressions covering HTML, PDF, plain text, one-way reroute, no-fallback failure handling, metrics, package validation, and documentation.

## 0.7.12 - 2026-08-01

- Added an Anthropic Hosted Web Search compatibility adapter for Claude Code child requests that carry `type="web_search_20250305"`, `name="web_search"`, and no `input_schema`.
- Hosted Web Search requests are converted before vLLM validation into a Proxy-managed custom Tool with a bounded `query` schema; hosted-only fields are retained as request-local policy and are never sent upstream.
- Request `max_uses` is enforced together with `SEARXNG_MAX_USES` by taking the smaller positive limit. Hosted allowed/blocked domain policies are applied as defaults to managed search calls.
- Replaced the global Managed Web limit-continuation flag with per-kind Search/Fetch disabling, so exhausting WebFetch no longer disables a later WebSearch and exhausting WebSearch no longer disables a later WebFetch.
- Added a bounded post-limit fuse: if the model calls a Managed Tool after that kind was removed for reaching its limit, the Proxy preserves `managed_web_tool_limit_repeated` with `retryable:false`, emits HTTP `422` before headers are committed or an equivalent SSE error after managed progress has begun, and does not issue another model request or expose the Tool Call to Claude Code.
- Added local rejection for Hosted Web Search when the bridge is disabled, the `anthropic_hosted_web_search_adapted` lifecycle event, focused no-loop regressions, package validation, and documentation.

## 0.7.11 - 2026-08-01

- Extended the conservative Anthropic Action-Intent classifier to immediate test and verification narrations, including `讓我測試 server`, `讓我驗證 TLS handshake`, `Let me test`, and `Let me verify`, while preserving completed reports, phase plans, and confirmation boundaries.
- Kept the existing hard Recovery bound: one initial Attempt plus at most one `action_required` Recovery; there is no third upstream generation.
- A successful Recovery must contain a valid Tool Call. A second narration-only or thinking-only result is fused as `action_intent_without_tool_call` with `retryable:false`.
- Changed only the exhausted Action-Intent fuse response from HTTP 502 to HTTP 422 and added `client_retry_suppressed`, preventing Claude Code from turning a deliberately bounded semantic fuse into a 10-attempt 5xx client retry chain.
- Added exact live-phrase regressions, false-positive boundaries, successful one-shot Tool recovery, repeated-narration fusion, package validation, and documentation.

## 0.7.10 - 2026-07-31

- Added Targeted Tool Input Schema Correction for a single `additionalProperties:false` violation when removing that one unsupported property makes the original Tool input fully schema-valid.
- Targeted correction narrows Recovery to the rejected Tool, sets `tool_choice={type:"tool",name:<tool>,disable_parallel_tool_use:true}`, and uses a scoped one-message context instead of resending the full conversation.
- The Recovery must preserve every accepted argument value exactly and remove only the identified unsupported property; changing the Tool name, returning text, modifying other arguments, or remaining schema-invalid is fused as `invalid_tool_input_schema` with `retryable:false`.
- Missing required identifiers, multiple unsupported properties, and any input that remains invalid after one removal continue to use the v0.7.9 generic `tool_choice:auto` Recovery.
- Added `CLAUDE_CODE_TARGETED_SCHEMA_CORRECTION_ENABLED`, targeted lifecycle events and Prometheus counters, focused safety-boundary regressions, deployment validation, and documentation.

## 0.7.9 - 2026-07-31

- Added a universal Anthropic Tool Input Schema Guard that validates every buffered Tool Call before replay, including task-management, MCP, and dynamically supplied Tools rather than only file mutation Tools.
- Added recursive validation for required fields, primitive and container types, enums, constants, nested object properties, array items, `additionalProperties:false`.
- Schema-invalid calls such as `TaskUpdate({"status":"completed"})` without the required `taskId` are discarded as `invalid_tool_input_schema` before Claude Code can execute them.
- Added one generic Output-Required Recovery that preserves the complete Tool set and original `tool_choice`; `auto` remains `auto`, missing identifiers are never invented, and the model may inspect current state with a list/read Tool before retrying.
- A second schema-invalid Tool Call is fused with `retryable:false`, preventing client API retry cascades.
- Added `CLAUDE_CODE_TOOL_INPUT_SCHEMA_GUARD_ENABLED`, dedicated lifecycle events and Prometheus counters, focused recursive and integration regressions, deployment validation, and documentation.

## 0.7.8 - 2026-07-31

- Added guarded Anthropic Tool stop-reason normalization for complete, schema-valid Tool Calls that incorrectly terminate with `stop_reason="end_turn"`.
- Normalization is applied consistently to initial and Recovery attempts only after the Tool name is exposed by the request and every Tool input satisfies the runtime `tools[].input_schema` contract.
- The Proxy rewrites the actual buffered Anthropic SSE or JSON response from `end_turn` to `tool_use`, updates parsed completion diagnostics, and then performs the normal Recovery-target validation before replay.
- Malformed Tool JSON, unknown Tools, missing required fields, invalid types, excessive calls, unclosed blocks, cancellation, and failure terminals remain non-normalizable and fail closed.
- Added `CLAUDE_CODE_TOOL_STOP_REASON_NORMALIZATION_ENABLED`, the `tool_stop_reason_normalized` lifecycle event, a Prometheus counter, focused initial/Recovery regressions, deployment validation, and documentation.

## 0.7.7 - 2026-07-31

- Split invalid Claude Code mutation Tool recovery by target availability: only issues with an exact `file_path` or `notebook_path` enter the existing locked-target Recovery.
- Targetless invalid mutation calls such as `Write({})` are discarded and routed to one generic Output-Required Recovery instead of throwing `Claude Code tool recovery requires an exact target path`.
- Generic continuation preserves the full Anthropic `tools[]` set and original `tool_choice`; `auto` remains `auto`, so the model may return a substantive answer, a complete valid Tool Call, or one genuinely blocking question.
- The Recovery instruction does not assume the rejected Tool must be reused and explicitly rejects another empty or incomplete Tool Call.
- A second targetless invalid mutation call is fused as `invalid_claude_code_tool_input` with `retryable:false`, preventing Claude Code API retry cascades.
- Added `targetless_tool_recovery_started` / `targetless_tool_recovery_fused` lifecycle events, Prometheus counters, focused regressions, package validation, and documentation.

## 0.7.6 - 2026-07-31

- Added the Anthropic `placeholder_completion_without_progress` guard for terminal placeholder-only replies immediately after a Claude Code Tool Result.
- The guard conservatively matches only exact `No response`, `No output`, `無回應`, `沒有回應`, `無輸出`, and `沒有輸出` markers after punctuation and formatting normalization; substantive sentences and ordinary user turns remain untouched.
- Placeholder responses are discarded and enter one Output-Required Recovery while preserving the original Anthropic Tool choice, including `tool_choice={type:"auto"}`.
- Recovery may return substantive text, a Tool Call, or one blocking question. Repeating the placeholder is fused as `retryable:false` with no third Attempt.
- Added `CLAUDE_CODE_PLACEHOLDER_COMPLETION_GUARD_ENABLED`, dedicated lifecycle logs, Prometheus counters, focused regressions, deployment validation, and documentation.

## 0.7.5 - 2026-07-31

- Split Anthropic semantic Recovery into `output_required` and `action_required` modes.
- `thinking_without_output` now preserves the original Anthropic Tool choice; an incoming `tool_choice={type:"auto"}` remains `auto` and the model may answer, explain, plan, report completion, wait for confirmation, ask one blocking question, or call a Tool.
- Removed the v0.7.4 special case that promoted short `繼續`/`開始`/`proceed` inputs into forced `tool_choice={type:"any"}` Recovery.
- Kept forced Tool Recovery only for `action_intent_without_tool_call`, where the model has already emitted a conservative first-person immediate-action narration while enabled tools are available.
- Added a bounded output-only fuse: a second reasoning-only result remains `thinking_without_output` with `retryable:false`, preventing Claude Code retry cascades without forcing an unrelated Tool Call.
- Added focused regressions for user-facing text after Thinking-only Recovery and repeated empty-output fusion.

## 0.7.4 - 2026-07-31

- Added an Anthropic/Claude Code Action-Intent Guard for terminal `end_turn` responses that announce immediate execution but emit no `tool_use` block while tools are available.
- Added conservative Traditional Chinese and English recognition for immediate forms including `我開始執行`, `我繼續執行`, `I am starting`, and `I will continue`, while preserving generic plans and completed final answers.
- Added one bounded action-required Recovery that preserves all Claude Code tools, sets Anthropic `tool_choice={type:"any",disable_parallel_tool_use:true}`, discards narration, and requests an immediate Tool Call.
- Added a strict Recovery fuse: text-only, thinking-only, malformed, interrupted, or otherwise non-tool Recovery results preserve the originating guarded reason and become `retryable:false`, preventing Claude Code API retry cascades.
- Added explicit continuation handling: short latest-user commands such as `繼續`, `開始`, `proceed`, and `go ahead` convert an initial `thinking_without_output` into one Action-Required Recovery when tools are available.
- Added schema-free incoming/upstream Tool diagnostics, Recovery diagnostics, dedicated lifecycle events, and Prometheus counters.
- Added `CLAUDE_CODE_ACTION_INTENT_GUARD_ENABLED`, v0.7.4 focused regressions, deployment validation, and documentation.
- Extracted the immediate action-narration and explicit-continuation classifiers into protocol-neutral core modules and retained the existing OpenAI Responses behavior.

## 0.7.3 - 2026-07-31

- Replaced blank zero-width Claude Code progress bullets with visible Managed WebSearch/WebFetch status text. WebSearch displays a sanitized bounded query; WebFetch displays hostname only.
- Changed the synthetic Anthropic stream envelope from eager to lazy activation. Ordinary text, Bash, Read, Write, and other Claude Code Tool responses no longer receive an extra progress content block.
- Added `started` and `completed` Managed Tool queue events. Parallel items display start and completion states while preserving original Tool Result IDs and continuation order.
- Added periodic visible ellipses with configurable line wrapping; valid zero-width deltas remain available through `invisible` mode.
- Added U+2063 progress-block marking and inbound history stripping so synthetic UI text is never forwarded to vLLM or retained in model prefix context.
- Added `MANAGED_WEB_STREAM_PROGRESS_MODE`, `MANAGED_WEB_STREAM_PROGRESS_DETAIL`, `MANAGED_WEB_STREAM_PROGRESS_MAX_LABEL_CHARS`, and `MANAGED_WEB_STREAM_PROGRESS_MAX_DOTS`; changed the default interval to 5000 ms.
- Preserved no-thinking Managed Web requests, one Anthropic message lifecycle, final SSE block-index splicing, error closure, bounded parallel queues, and mixed-tool passthrough.
- Added v0.7.3 focused, deployment, history-sanitization, ordinary-Tool, visible-query, hostname-redaction, periodic-progress, and continuation-error regressions.

## 0.7.2 - 2026-07-31

- Replaced pre-message SSE comments and `event: ping` keepalives with a valid synthetic Anthropic Messages stream envelope whenever a Managed Web bridge is enabled.
- Emit `message_start`, a dedicated progress text block, and an immediate invisible `text_delta` before waiting for buffered vLLM or Managed Web Tool work.
- Added periodic valid `content_block_delta` progress controlled by `MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS` (default 15000 ms), plus an immediate delta when each queue item settles.
- Added final SSE splicing: close progress block index 0, discard upstream `message_start`, shift every upstream content block index by one, and preserve exactly one `message_stop`.
- Disabled transparent Tool passthrough commit while the synthetic envelope is active so Bash/Read/Write Tool Calls are delivered inside the same lifecycle.
- Suppressed false transport/semantic stall warnings while downstream managed-stream progress is active; total-generation and client-cancellation limits remain enforced.
- Added `vllm_cc_proxy_managed_stream_progress_deltas_total` and `vllm_cc_proxy_managed_stream_splices_total`, regression tests, Compose configuration, and clean-package validation.

## 0.7.1 - 2026-07-31

- Added homogeneous Managed Web Tool batches: parallel `WebSearch` calls and parallel `WebFetch` calls are no longer passed back to Claude Code.
- Added bounded internal queues with `WEBSEARCH_MAX_PARALLEL`, `WEBFETCH_MAX_PARALLEL`, and `MANAGED_WEB_TOOLS_MAX_BATCH`.
- Each completed queue item is recorded immediately, preserves its original `tool_use_id`, and emits a standard Anthropic SSE `ping` to the connected Claude Code stream without exposing the internal Tool Result.
- Reset attempt activity and stall diagnostics on managed-item completion and added `managed_tool_item_completed` lifecycle logs.
- Added `vllm_cc_proxy_managed_web_tool_items_completed_total` and `vllm_cc_proxy_managed_web_tool_progress_pings_total` metrics.
- Kept one protocol-correct continuation after all Tool Results from the same assistant turn are available; mixed Managed/Client Tool responses remain passthrough.
- Updated `docker-compose.partial.yaml`, runtime configuration, deployment tests, and documentation for batch and concurrency controls.

## 0.7.0 - 2026-07-31

- Added an opt-in Claude Code Managed WebFetch bridge for exactly one `WebFetch` Tool Call.
- Added SSRF-safe HTTP/HTTPS downloading with DNS validation on every redirect, private/link-local/metadata rejection, content-type allowlisting, and bounded response reads.
- Added HTML/plain-text extraction and structural chunking.
- Added PDF extraction through `pdftotext -layout`, page preservation, page grouping, page-count limits, and container `poppler-utils` installation.
- Added sequential no-thinking vLLM Chunk Reader calls and a no-thinking Document Synthesizer; only bounded evidence and summary are returned to the main model.
- Added `think:false` plus `chat_template_kwargs.enable_thinking=false` to Managed WebSearch continuations, WebFetch readers, synthesis, and continuations.
- Added internal recovery for missing `WebFetch.url` or `WebFetch.prompt`, preventing invalid `{}` calls from reaching Claude Code.
- Added WebFetch execution, failure, limit, and chunk metrics and lifecycle logs.
- Added Compose and runtime controls for WebFetch download, extraction, chunk, page, model, and result limits.
- Preserved mixed/parallel client Tool responses unchanged and retained the existing WebSearch compatibility export.

## 0.6.3 - 2026-07-31

- Completed `docker-compose.partial.yaml` for Managed WebSearch: added an opt-in `searxng` service under the `websearch` profile.
- Added persistent `searxng-config` and `searxng-data` volumes and internal-only port exposure on `vllm-test-network`.
- Added first-start SearXNG settings initialization with default engines plus JSON Search API format.
- Added SearXNG readiness healthcheck and documented internal versus external SearXNG deployment.
- Updated deployment and package validation contracts to require both Gateway and opt-in SearXNG services.

## 0.6.2 - 2026-07-31

- Added an opt-in Claude Code `WebSearch` managed-tool bridge backed by the SearXNG JSON Search API.
- A single managed `WebSearch` call is hidden from Claude Code, executed by the Proxy, converted to a bounded untrusted `tool_result`, and continued internally through Anthropic Messages until the model returns text or a normal Claude Code tool.
- Preserved thinking, text, and tool-use blocks in the continuation; unsupported or opaque Anthropic content blocks disable interception instead of being dropped.
- Mixed or parallel Tool Calls remain untouched and are delivered to Claude Code; v0.6.2 intercepts only exactly one configured WebSearch call.
- Added query, timeout, use-count, raw-response, normalized-result, result-count, title, and snippet limits; URL deduplication; tracking-parameter removal; and allowed/blocked-domain filtering.
- Added SearXNG failure `tool_result` handling, use-limit continuation with WebSearch removal, stream/non-stream support, lifecycle logs, Prometheus counters, and end-to-end Gateway tests.
- The bridge is disabled by default and does not emulate Anthropic Hosted Web Search, encrypted content, native citations, or WebFetch.

## 0.6.1 - 2026-07-28

- Make vLLM native `/v1/responses` the default Codex upstream path; retain `chat_adapter` as an explicit A/B or compatibility fallback.
- Preserve the v0.6.0 `transparent` Responses behavior default, so native model output is not discarded or automatically recovered by Proxy behavioral guards.
- Add `RESPONSES_TOOL_CHOICE_POLICY` with default `preserve` and opt-in `required_on_explicit_continue`.
- Add conservative Traditional Chinese and English explicit-start/continue detection. Eligible user turns with available tools rewrite only `tool_choice=auto` (or omitted) to `required`; Tool Result turns and explicit Client choices remain unchanged.
- Add `responses_tool_choice_rewritten` diagnostics and `vllm_openai_proxy_tool_choice_rewrites_total` without logging prompt text.
- Restrict Hosted Tool filtering diagnostics to `chat_adapter`; native mode forwards Hosted Tool declarations without false dropped-tool events.
- Add native-default, request-integrity, Tool Result, diagnostics and fallback regression coverage.

## 0.6.0 - 2026-07-28

- Make Codex `/v1/responses` behavior-transparent by default with `RESPONSES_BEHAVIOR_MODE=transparent`.
- Disable Responses Think Loop classification, `reasoning_without_output` rejection, Actionless Completion Recovery, forced-tool validation, and malformed required-tool automatic retry in transparent mode.
- Preserve Chat↔Responses conversion, Hosted Tool filtering, Tool passthrough, protocol parsing, timeouts, request/body limits, buffer limits, and observability.
- Keep the previous behavior available as an explicit A/B diagnostic mode with `RESPONSES_BEHAVIOR_MODE=guarded`.
- Add request diagnostics for `responsesBehaviorMode` and `behaviorGuardsEnabled`.

## 0.5.9 - 2026-07-28

- Added `RESPONSES_HOSTED_TOOL_POLICY` with `drop_optional` as the default for `chat_adapter`. Optional `web_search`, `web_search_preview`, file-search, Code Interpreter, Computer Use, and Image Generation declarations are removed while Client-executed function/custom/namespace tools continue upstream.
- Added strict required-hosted-tool handling. Explicit hosted-tool choices and required requests with no supported Client tool return typed `required_hosted_tool_unavailable`; `reject` and `native_only` policies remain available.
- Added `allowed_tools` normalization so optional hosted entries are filtered from both the allowlist and effective Chat tool set without widening the permitted tools.
- Added hosted-tool diagnostics and Prometheus counters for filtered declarations and rejected required hosted tools.
- Added one bounded malformed required-tool retry inside the Responses-to-Chat adapter for vLLM 400 JSON/tool-parser errors. The retry lowers temperature, guarantees a minimum Tool output budget, disables parallel calls, requests a small complete JSON object, and explicitly selects the tool when only one remains.
- Added a strict malformed-tool fuse. A second parser rejection returns typed `malformed_required_tool_arguments` with `retryable:false` instead of a nested generic `upstream_http_error`.
- Preserved native Responses mode, transparent post-Tool passthrough, Think Loop handling, Actionless Completion Recovery, OpenAI Chat behavior, and Anthropic/Claude Code recovery.

## 0.5.8 - 2026-07-28

- Added selectable Responses upstream modes: `chat_adapter` (default) and `native`. Codex continues to call `/v1/responses`; adapter mode calls vLLM `/v1/chat/completions` internally and reconstructs Responses JSON/SSE.
- Added deterministic Responses request conversion for instructions, developer/system messages, text and image inputs, function/custom/namespace tools, `additional_tools`, Tool Call history/results, tool choice, parallelism, output limits, reasoning effort, and text formats.
- Added Chat-to-Responses JSON/SSE reconstruction for reasoning summaries, output text, function calls, custom tool calls, usage, monotonic sequence numbers, `response.completed`, and length-to-`response.incomplete` mapping.
- Added Codex custom-tool support for `apply_patch`-style freeform input. Custom tools cross the transparent Tool commit boundary at the first Chat tool fragment and finish with native `response.custom_tool_call_input.done`.
- Added namespace-tool flattening for Chat upstreams and namespace/name restoration for Codex Tool dispatch, including Responses Lite `additional_tools` normalization.
- Added explicit pre-upstream HTTP 400 errors for unsupported hosted/stateful Responses features instead of converting adapter failures into retryable 502 transport errors.
- Preserved the existing Think Loop Guard, Actionless Completion Recovery, Tool passthrough, Responses terminal handling, native mode, OpenAI Chat behavior, and Anthropic/Claude Code recovery.

## 0.5.7 - 2026-07-28

- Added a Responses-only Actionless Completion Guard for completed replies that narrate immediate future work while tools are available but emit no Function Call.
- Added request tool-context diagnostics without logging schemas: tool count, names, normalized `tool_choice`, enabled state, and requested parallelism.
- Added one strategy-aware Recovery that preserves the request tools, sets `tool_choice="required"`, disables parallel calls, and instructs the model to issue exactly one tool call without another progress announcement.
- Added a strict fuse: if the required-tool Recovery still returns text without a Function Call, the Proxy returns `actionless_completion` with `retryable:false` and performs no additional Recovery.
- Added conservative first-person action-narration detection in Traditional Chinese and English, including short prefaces such as “Now I have enough data. Let me create…”, while leaving generic procedural explanations such as “首先建立…” untouched.
- Added `ACTIONLESS_COMPLETION_GUARD_ENABLED`, dedicated lifecycle events, Prometheus counters, and end-to-end Responses regressions.

## 0.5.6 - 2026-07-28

- Fixed successful `/v1/responses` terminal results being overridden by `repeated_reasoning_segment`, which discarded valid `response.completed` events and caused Codex to report `stream closed before response.completed`.
- Added adapter-controlled reasoning-loop eligibility. Responses loop detection now runs only before visible output, refusal, Function Call, or any terminal event; valid completed/incomplete/cancelled responses are replayed instead of recovered.
- Added the same OpenAI action boundary to Chat Completions after visible content or Tool Call, while preserving reasoning-only loop recovery when no action has occurred.
- Made exact suffix, normalized suffix, and ABAB line-cycle detection honor `LOOP_MIN_COUNT` consistently.
- Raised the production default `LOOP_MIN_COUNT` from `2` to `3` to reduce false positives from short natural repetition.
- Added unit, attempt-runner, and live Gateway regressions proving completed Responses output survives repeated reasoning, output permanently closes the loop guard, and true three-repeat pre-action loops remain recoverable.

## 0.5.5 - 2026-07-28

- Fixed `/v1/responses` incorrectly converting valid reasoning-only `status:"incomplete"` results into the custom `reasoning_without_output` error and Recovery.
- Added transparent HTTP 200 replay for streamed `response.incomplete`, non-stream incomplete responses, and the vLLM variant that emits `response.completed` with `response.status="incomplete"`.
- Added normalized terminal diagnostics: `responseTerminal`, `responseTerminalEvent`, `responseIncomplete`, `responseCancelled`, `responseIncompleteReason`, incomplete details, and usage tokens.
- Added official Responses done-event support for reasoning text/summary, output text, refusal, function-call arguments, and `response.output_item.done`, with authoritative replacement instead of delta duplication.
- Added terminal-response `output[]` ingestion so completed-only streams without preceding delta events still expose reasoning, text, refusal, or function calls.
- Kept `response.failed` and explicit upstream errors fail-closed while allowing incomplete/cancelled terminal responses to pass protocol validation.
- Added streamed and non-stream Gateway regressions proving incomplete reasoning-only responses are replayed byte-for-byte without Proxy Recovery.

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
