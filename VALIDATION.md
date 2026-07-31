# VLLM-PROXY-SUITE v0.7.3 Validation

Validation date: 2026-07-31

## Scope

This release replaces blank zero-width Claude Code progress bullets with lazy, visible Managed WebSearch/WebFetch progress. It validates that ordinary text and Claude Code native Tool responses remain unchanged; Managed WebSearch displays a sanitized bounded query; Managed WebFetch displays hostname only; periodic visible ellipses keep the stream active; completion states are appended; synthetic progress is removed from later vLLM history; and the final upstream response remains one valid Anthropic message lifecycle.

## Source verification

- Tests: 245 passed, 0 failed.
- `npm run check`: passed.
- JavaScript syntax: 62 files passed `node --check`.
- Package validator: `valid:true`, version `0.7.3`, 76 files, 46 required files.
- Compose YAML: parsed successfully.
- Embedded Gateway and SearXNG shell: passed `sh -n`.
- Compose defaults verified:
  - `MANAGED_WEB_STREAM_PROGRESS_MODE=visible`
  - `MANAGED_WEB_STREAM_PROGRESS_DETAIL=query`
  - `MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS=5000`
  - `MANAGED_WEB_STREAM_PROGRESS_MAX_LABEL_CHARS=160`
  - `MANAGED_WEB_STREAM_PROGRESS_MAX_DOTS=12`
- Gateway `/health/live`, `/health/ready`, `/health/cc`, `/health/openai`: passed.
- Metrics include:
  - `vllm_cc_proxy_managed_web_tool_items_completed_total`
  - `vllm_cc_proxy_managed_stream_progress_deltas_total`
  - `vllm_cc_proxy_managed_stream_splices_total`
- Graceful SIGTERM: exit code 0.

## Visible Managed Web progress verification

- Ordinary Bash Tool responses do not create a synthetic progress content block or an empty Claude Code bullet.
- The synthetic Anthropic lifecycle starts only after the Managed Tool queue emits its first `started` event.
- WebSearch status displays a control-character-cleaned and whitespace-normalized query, bounded by `MANAGED_WEB_STREAM_PROGRESS_MAX_LABEL_CHARS`.
- WebFetch status displays hostname only and does not reveal URL path, query string, token, session parameter, Cookie, Authorization header, snippet, or document content.
- Periodic progress uses valid Anthropic `content_block_delta` text events.
- Visible modes append ellipses continuously and wrap after `MANAGED_WEB_STREAM_PROGRESS_MAX_DOTS`; invisible mode remains available.
- Parallel Managed Tool items emit start and completion states while completion order may differ from request order.
- Tool Results preserve original `tool_use_id` order for the single protocol-correct continuation.
- Search completion may report normalized result count; WebFetch completion may report analyzed chunk count.
- Synthetic progress text begins with U+2063 and is removed from inbound Anthropic message history before vLLM access.
- Final responses contain exactly one `message_start` and one `message_stop`.
- Final Claude Code Tool Calls retain Tool ID and arguments after content-block index shifting.
- A continuation HTTP error after the synthetic stream starts closes progress block index 0 before emitting `event:error`.
- An upstream error before any Managed Tool is identified retains the original HTTP error response and does not create a synthetic lifecycle.
- Managed WebSearch continuations, WebFetch readers, synthesizers, and continuations retain `think:false` and `chat_template_kwargs.enable_thinking=false`.

## Clean candidate ZIP verification

- Candidate ZIP tests: 245 passed, 0 failed.
- Candidate `npm run check`: passed.
- Candidate JavaScript syntax: 62 files passed.
- Candidate package validator: `valid:true`, version `0.7.3`, 76 files, 46 required files.
- Candidate Compose YAML and embedded shell: passed.
- Candidate focused visible-progress tests: passed.
- Candidate Gateway health and metrics: passed.
- Candidate graceful SIGTERM: exit code 0.
- Source and candidate ZIP file manifests: identical.
- ZIP root: `VLLM-PROXY-SUITE/`.

## Not executed in this environment

- Live Claude Code → Gateway → target vLLM → SearXNG/public website integration.
- Docker image build or real Compose startup.
- Real Claude Code UI rendering across all client versions.
- A long-duration Claude Code idle-watchdog test against production network latency.
- Production concurrency, load, DNS failure, or external-site anti-bot behavior.
- Browser JavaScript rendering for dynamic websites.

## Operational notes

The default `visible` mode intentionally creates one synthetic assistant progress text block only for Managed WebSearch/WebFetch. Claude Code may retain that block in its local conversation transcript, but the Proxy removes the U+2063-marked block before forwarding later history to vLLM. The final model content is delivered in subsequent content-block indexes inside the same Anthropic message lifecycle.

Because the synthetic `message_start` is emitted before upstream usage is available, downstream `usage.input_tokens` is `0`; Proxy completion diagnostics still use the actual upstream usage reported by vLLM.
