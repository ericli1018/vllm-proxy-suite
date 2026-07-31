# VLLM-PROXY-SUITE v0.7.2 Validation

Validation date: 2026-07-31

## Scope

This release replaces pre-message SSE comments and `event: ping` keepalives for Managed WebSearch/WebFetch with a valid synthetic Anthropic Messages stream envelope. It validates immediate downstream message lifecycle start, periodic invisible text deltas, final vLLM SSE splicing, homogeneous Managed Web Tool queues, Tool ID preservation, no-thinking internal requests, both protocol runtimes, Compose packaging, and clean extraction.

## Source verification

- Tests: 239 passed, 0 failed.
- `npm run check`: passed.
- JavaScript syntax: 60 files passed `node --check`.
- Package validator: `valid:true`, version `0.7.2`, 74 files, 45 required files.
- Compose YAML: parsed successfully.
- Embedded Gateway and SearXNG shell: passed `sh -n`.
- Compose exposes `MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS=${MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS:-15000}`.
- Gateway `/health/live`, `/health/ready`, `/health/cc`, `/health/openai`: passed.
- Metrics include:
  - `vllm_cc_proxy_managed_stream_progress_deltas_total`
  - `vllm_cc_proxy_managed_stream_splices_total`
- Graceful SIGTERM: exit code 0.

## Managed stream envelope verification

- Streaming begins with one synthetic `message_start` before waiting for Managed Web Tool completion.
- A dedicated progress text block uses content block index 0.
- An invisible `text_delta` is sent immediately and periodically according to `MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS`.
- Queue-item completion sends an additional valid progress delta.
- The final upstream `message_start` is discarded.
- Every upstream content block index is shifted by one.
- The progress block is closed exactly once before final upstream content.
- Final responses contain exactly one `message_start` and one `message_stop`.
- Final Claude Code Tool Calls such as `Bash` retain their Tool ID and arguments after index shifting.
- Streamed upstream errors close the progress block before `event:error`.
- Managed streaming does not use pre-message `event: ping` or SSE comments for idle-timeout prevention.

## Clean ZIP verification

- Candidate ZIP tests: 239 passed, 0 failed.
- Candidate `npm run check`: passed.
- Candidate JavaScript syntax: 60 files passed.
- Candidate package validator: `valid:true`, version `0.7.2`, 74 files, 45 required files.
- Candidate Compose YAML and embedded shell: passed.
- Candidate Gateway health and metrics: passed.
- Candidate graceful SIGTERM: exit code 0.
- Source and candidate ZIP file manifests: identical.
- ZIP root: `VLLM-PROXY-SUITE/`.

## Not executed in this environment

- Live Claude Code → Gateway → target vLLM → SearXNG/public website integration.
- Docker image build or real Compose startup.
- A real 310-second Claude Code idle-watchdog run.
- Production concurrency, long-duration load, or network-failure testing.
- Browser JavaScript rendering for dynamic websites.

## Operational note

When either Managed Web bridge is enabled, all streaming Anthropic Messages requests on that route use the synthetic stream envelope because the Managed Web wrapper buffers upstream sub-responses before deciding whether a Tool Call is managed. This prevents silent downstream waiting even before the first Managed Tool is identified. The progress block contains zero-width text; it is normally invisible, but a client that exposes invisible Unicode may show an empty text block.
The synthetic `message_start` is emitted before upstream usage is available, so downstream `usage.input_tokens` is `0`; Proxy completion diagnostics still use the actual upstream usage.
