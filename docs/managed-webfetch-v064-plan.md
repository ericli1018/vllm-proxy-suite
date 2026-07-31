# Managed WebFetch Reader Implementation Plan

**Goal:** Add a proxy-managed WebFetch bridge that safely downloads HTML, text, and PDF documents, reads them in bounded chunks through the configured vLLM, synthesizes evidence, and returns a standard Anthropic tool_result without exposing the internal WebFetch call to Claude Code.

**Architecture:** Extend the existing managed WebSearch loop into a managed web-tools loop. WebFetch performs SSRF-safe bounded download, document extraction, page/chunk segmentation, sequential no-thinking reader calls, a no-thinking synthesis call, then a no-thinking continuation of the original Claude Code request. WebSearch continuations also use the same no-thinking policy.

**Global constraints:**
- Preserve ordinary Claude Code tool passthrough.
- Intercept only exactly one managed tool call in an assistant turn.
- Never fabricate Anthropic hosted-tool blocks or citations.
- Default internal managed-tool requests to `think:false` and `chat_template_kwargs.enable_thinking=false`.
- Do not put full fetched documents into the final main-model context.
- Enforce URL, redirect, byte, character, chunk, page, and output limits.
- Reject loopback, private, link-local, and metadata destinations on every redirect.

## Tasks

1. Write failing tests for internal no-thinking requests and WebSearch continuation behavior.
2. Write failing tests for HTML extraction/chunking and PDF page grouping.
3. Write failing tests for SSRF-safe WebFetch download and missing-argument recovery.
4. Write failing end-to-end tests for Reader, Synthesizer, tool_result, and final continuation.
5. Implement document fetching/extraction and managed WebFetch orchestration.
6. Add config, metrics, Compose settings, Docker `pdftotext`, and documentation.
7. Run focused tests, full regression, syntax/package/Compose checks, clean-ZIP verification, and package v0.7.0.
