# VLLM-PROXY-SUITE v0.7.1 Validation

Validation date: 2026-07-31

## Scope

This validation covers homogeneous Managed WebSearch/WebFetch batches, bounded internal queues, per-item completion progress, immediate Anthropic SSE ping delivery, Tool ID preservation, no-thinking internal requests, existing WebFetch document reading, both protocol runtimes, Compose packaging, and clean extraction.

## Source verification

- `npm test`: 234 passed, 0 failed.
- `npm run check`: passed.
- JavaScript syntax: 59 files passed `node --check`.
- Package validator: `valid:true`, version `0.7.1`, 72 files, 43 required files.
- Compose YAML parsed with services `vllm-proxy-suite` and `searxng`.
- Compose exposes `MANAGED_WEB_TOOLS_MAX_BATCH=8`, `WEBSEARCH_MAX_PARALLEL=2`, and `WEBFETCH_MAX_PARALLEL=2` defaults.
- Embedded Gateway Compose startup command passed `sh -n` after Compose interpolation normalization.
- Gateway smoke: `/health/live`, `/health/ready`, `/health/cc`, `/health/openai`, and `/metrics` passed.
- New queue metrics were present.
- Graceful SIGTERM: process exit code 0.

## Managed queue behavior verified

- A homogeneous batch of parallel WebSearch calls is intercepted and not delivered to Claude Code.
- A homogeneous batch of parallel WebFetch calls is intercepted and not delivered to Claude Code.
- Queue execution is bounded by the configured per-kind parallel limit.
- Faster items can complete before earlier items.
- Every completed item immediately emits a progress callback and a standard Anthropic `event: ping` frame on streaming requests.
- The first SSE headers and ping are delivered before a slower sibling item completes.
- Progress completion resets attempt activity timing and uses state `managed_tool_executing`.
- Tool Results are assembled in original assistant Tool Call order and preserve every original `tool_use_id`.
- One protocol-correct model continuation occurs after all Tool Results from the assistant turn are available.
- Mixed Managed/Client Tool batches remain passthrough.
- Batch overflow and use-limit items become internal error Tool Results instead of escaping to Claude Code.

## No-thinking behavior verified

- Managed WebSearch continuations carry `think:false` and `chat_template_kwargs.enable_thinking=false`.
- Managed WebFetch Chunk Readers, Document Synthesizers, and continuations carry the same no-thinking policy.
- Parallel Managed WebFetch work preserves the no-thinking policy for every internal model request.
- The outer Claude Code request remains controlled independently by `DEFAULT_ENABLE_THINKING`.

## Observability verified

- Per-item event: `managed_tool_item_completed`.
- Metrics:
  - `vllm_cc_proxy_managed_web_tool_items_completed_total`
  - `vllm_cc_proxy_managed_web_tool_progress_pings_total`
- Per-item logs contain Tool ID/name, completion count, success state, and duration, but not query, URL, snippet, fetched document, or Tool Result content.
- SSE progress frames are standard ping events and do not expose internal Tool Results or create visible Claude Code Tool rows.

## Clean candidate ZIP verification

- Clean extraction `npm test`: 234 passed, 0 failed.
- Clean extraction `npm run check`: passed.
- JavaScript syntax: 59 files passed.
- Package validator: `valid:true`, version `0.7.1`, 72 files, 43 required files.
- Compose batch/parallel defaults were preserved.
- Source and clean-candidate SHA-256 manifests were identical.
- ZIP root: exactly `VLLM-PROXY-SUITE/`.

## Not executed in this environment

- Live Claude Code → Gateway → target vLLM → SearXNG/public-web execution.
- Docker image build or real Docker Compose startup; Docker CLI is unavailable.
- Production concurrency, long-duration load, and external network failure injection.
- Visible Claude Code UI rendering of ping frames; protocol tests verify the bytes, while Claude Code normally treats them as non-visible keepalive events.

## Protocol constraint

A Tool Result from a Proxy-managed Tool cannot be sent to Claude Code as a client Tool Result without transferring Tool ownership to Claude Code. For multiple Tool Calls in one assistant turn, the internal model continuation is therefore delayed until every corresponding Tool Result is available. v0.7.1 sends immediate SSE ping progress for each completed queue item to prevent silent waiting and timeout while preserving Anthropic Tool ID/role semantics.
