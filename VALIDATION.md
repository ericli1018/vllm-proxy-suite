# VLLM-PROXY-SUITE v0.7.14 Validation

Validation date: 2026-08-02

## Scope

v0.7.14 hardens Managed Web Tool dispatch and post-limit behavior without changing the `awesome-web-fetch` provider contract:

- complete Managed `web_search` or `WebFetch` Tool Calls are classified before delivery even when vLLM incorrectly reports `stop_reason="end_turn"`;
- a mixed parallel batch containing Managed Web Tools and client-executed Tools is serialized once: Managed Web work executes first and deferred client Tool Calls are not executed or replayed;
- a second mixed batch is fused as `managed_web_mixed_batch_repeated`, `retryable:false`;
- Hosted `web_search` responses that cannot be parsed or safely consumed are fused as `managed_hosted_tool_escape` and never escape to Claude Code;
- after a Search or Fetch kind reaches its request-local use limit, the first repeated call receives one bounded finalization continuation with an explicit error Tool Result;
- a second post-finalization call remains fused as `managed_web_tool_limit_repeated`, `retryable:false`, with no additional model request;
- `awesome-web-fetch` Browser execution and Browser-to-Internal reroute counters remain separate from `WEBFETCH_MAX_USES`; each WebFetch Tool Call consumes exactly one attempt from the bounded use budget;
- HTML routing, PDF/text Internal routing, Reader/Synthesizer behavior, SSRF checks, and the Compose sidecar profile remain unchanged from v0.7.13.

## Source verification

- Full test suite: 310 passed, 0 failed.
- Focused v0.7.14 Managed Web regressions: 7 passed, 0 failed.
- `npm run check`: passed.
- Package validator: `valid:true`, version `0.7.14`, 92 files, 59 required files.
- JavaScript syntax validation: 76 files passed.
- `docker-compose.partial.yaml`: parsed successfully with services `vllm-proxy-suite`, `searxng`, and `awesome-web-fetch`.
- Sidecar profile: `webfetch-browser`.

## No-loop verification

Automated regressions verify:

```text
end_turn + complete managed Tool Call
→ classify as tool_use before Managed dispatch

Managed Web + client Tool mixed batch
→ serialize once
→ second mixed batch returns HTTP/SSE 422
→ no third continuation

use limit reached
→ one finalization continuation without external fetch/search
→ second repeated disabled Tool Call returns HTTP/SSE 422
→ no further vLLM request

malformed Hosted web_search
→ managed_hosted_tool_escape
→ no client-visible hosted Tool Call
```

The bounded finalization is not the general Recovery subsystem. It is request-local Managed Web continuation state and is hard-limited to one finalization per disabled kind.

## Artifact verification

The release procedure additionally verifies:

```text
unzip -t VLLM-PROXY-SUITE-v0.7.14.zip
npm test from a clean extracted ZIP
npm run check from a clean extracted ZIP
source and extracted ZIP SHA-256 manifests are identical
v0.7.13 -> v0.7.14 patch applies cleanly and produces the same manifest
```

## Not executed

- A live Docker/Compose image build of the external `awesome-web-fetch` Git context.
- A real Claude Code -> Proxy -> vLLM -> SearXNG/awesome-web-fetch deployment integration.
- Production load, long-duration browser-context, or egress-policy testing.
