# VLLM-PROXY-SUITE v0.7.0 Validation

Validation date: 2026-07-31

## Scope

This validation covers the single-process JavaScript Gateway, Managed WebSearch, Managed WebFetch document reading, internal no-thinking requests, HTML/text/PDF extraction, Anthropic/OpenAI regression behavior, Compose packaging, and clean extraction.

## Source verification

- `npm test`: 230 passed, 0 failed.
- `npm run check`: passed.
- JavaScript syntax: 58 files passed `node --check`.
- Package validator: `valid:true`, version `0.7.0`, 71 files, 43 required files.
- Compose YAML parsed with services `vllm-proxy-suite` and `searxng`.
- Compose defaults expose `CLAUDE_CODE_WEBFETCH_BRIDGE_ENABLED=false`, `MANAGED_WEB_TOOLS_THINK=false`, and `WEBFETCH_PDF_PAGES_PER_CHUNK=1`.
- Gateway embedded Compose startup command passed `sh -n`.
- Dockerfile and Compose runtime both install `poppler-utils`.
- A real two-page PDF generated in the validation host was extracted by the default `pdftotext -layout` implementation; exactly two page Reader requests were produced and both carried `think:false`.
- Gateway smoke: `/health/live`, `/health/ready`, `/health/cc`, `/health/openai`, and `/metrics` passed.
- Managed WebFetch execution/failure/limit/chunk metrics were present.
- Graceful SIGTERM: process exit code 0.

## Managed WebSearch no-thinking behavior verified

- A managed WebSearch result is appended as a standard Anthropic `tool_result`.
- The internal continuation request carries top-level `think:false`.
- The same request carries `chat_template_kwargs.enable_thinking=false`.
- Existing Chat Template kwargs are preserved.
- The outer Claude Code request remains independently controlled by `DEFAULT_ENABLE_THINKING`.

## Managed WebFetch behavior verified

- Exactly one configured WebFetch call is hidden from Claude Code and handled internally.
- Missing `url` or `prompt` becomes an internal `is_error:true` tool_result instead of a client-visible invalid call.
- HTML active content and tags are removed before text extraction.
- HTML/plain text is chunked with bounded overlap and chunk count.
- PDF page boundaries are retained; trailing empty form-feed pages are removed.
- Default PDF behavior is one page per Reader request; grouping is configurable.
- Every redirect is DNS-revalidated and private/link-local/metadata destinations are rejected before the next fetch.
- Download bytes, extracted characters, prompt length, redirect count, PDF pages, Reader chunks, model response, synthesis input, and final result bytes are bounded.
- Chunk Reader and Document Synthesizer requests are non-streaming and tool-free.
- Chunk Reader, Document Synthesizer, and final WebFetch continuation carry `think:false` and `enable_thinking:false` by default.
- Only bounded summary/evidence is returned to the original model; full documents are not appended to the main Claude Code conversation.
- Mixed or parallel WebFetch/client-tool responses are passed through unchanged.
- WebFetch execution, failure, limit, and chunk metrics are exported.

## Security boundaries verified

- Only HTTP and HTTPS URLs are accepted.
- URL credentials are rejected.
- Loopback, RFC1918, carrier-grade NAT, link-local, metadata, IPv6 ULA/link-local, multicast, and selected reserved/documentation ranges are rejected.
- Redirect targets are checked before the redirect request is issued.
- Unsupported MIME types are rejected.
- Fetched content is labeled as untrusted external data in Reader and final tool-result prompts.

## Clean ZIP verification

- Clean extraction `npm test`: 230 passed, 0 failed.
- Clean extraction `npm run check`: passed.
- JavaScript syntax: 58 files passed.
- Package validator: `valid:true`, 71 files, 43 required files.
- Compose parsed with `vllm-proxy-suite` and `searxng`; no-thinking and one-page PDF defaults were preserved.
- Real `pdftotext` PDF smoke produced exactly two Reader requests for a two-page PDF; both used `think:false`.
- Gateway health and Managed WebFetch metrics smoke passed.
- Graceful SIGTERM: exit code 0.
- Source and clean-ZIP SHA-256 manifests: identical.
- ZIP root: exactly `VLLM-PROXY-SUITE/`.

## Not executed in this environment

- Live Claude Code → Gateway → target vLLM → SearXNG/public-web execution.
- Docker image build or real Docker Compose container startup; Docker CLI is unavailable.
- JavaScript browser rendering, authenticated sites, CAPTCHA bypass, or anti-bot circumvention.
- Production concurrency, long-duration load, and external failure injection.
- Anthropic Hosted WebSearch/WebFetch emulation, encrypted content, or native citation generation.

## Residual limitation

Hostnames are resolved and checked before each fetch and redirect, but the current fetch transport does not pin the validated address. Deployments requiring DNS-rebinding resistance should enforce outbound egress policy or use a controlled outbound HTTP proxy.
