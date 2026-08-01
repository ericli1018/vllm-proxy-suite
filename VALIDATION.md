# VLLM-PROXY-SUITE v0.7.12 Validation

Validation date: 2026-08-01

## Scope

v0.7.12 closes the Anthropic Hosted Web Search compatibility gap without adding recursive model Recovery:

- exact `type="web_search_20250305"`, `name="web_search"` requests are normalized before vLLM validation into a Proxy-managed custom Tool with a bounded `input_schema`;
- hosted-only `type`, `max_uses`, and domain policies remain request-local and are removed before the first vLLM request;
- request `max_uses` and `SEARXNG_MAX_USES` are combined using the smaller positive limit;
- Search and Fetch limits are tracked independently, so exhausting one kind does not disable the other;
- calling a Managed Tool again after its kind reaches the limit is fused locally as `managed_web_tool_limit_repeated`, `retryable:false`; no additional vLLM request or client-visible Tool Call is produced;
- before response headers are committed the fuse returns HTTP `422`; after managed SSE progress begins it emits an equivalent SSE `event:error` and records `client_retry_suppressed`;
- the bridge-disabled path rejects Hosted Web Search locally before contacting vLLM.

## Source verification

- Full test suite: 294 passed, 0 failed.
- `npm run check`: passed.
- Package validator: `valid:true`, version `0.7.12`, 89 files, 56 required files.
- JavaScript syntax validation: 73 files passed.
- `docker-compose.partial.yaml`: parsed successfully with services `vllm-proxy-suite` and `searxng`.

## Artifact verification

The release procedure additionally verifies:

```text
unzip -t VLLM-PROXY-SUITE-v0.7.12.zip
npm test from a clean extracted ZIP
npm run check from a clean extracted ZIP
source and extracted ZIP SHA-256 manifests are identical
v0.7.11 -> v0.7.12 patch applies cleanly and produces the same manifest
```

Artifact hashes are reported with the release delivery.
