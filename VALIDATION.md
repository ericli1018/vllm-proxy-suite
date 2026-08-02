# VLLM-PROXY-SUITE v0.7.15 Validation

Validation date: 2026-08-02

## Scope

v0.7.15 fixes Claude Code file-mutation prerequisite state and terminal semantic error mapping without changing Managed WebSearch, WebFetch, or `awesome-web-fetch` behavior:

- `File has not been read yet` is classified as a resolvable `read_precondition`;
- a successful `Read` of the same path after that failure permits the exact original `Write`;
- Reads do not clear permission, schema, stale replacement, notebook, or other deterministic failures;
- stale Reads from before the failed mutation remain invalid;
- repeated mutation errors use stable Proxy messages instead of returning raw `<tool_use_error>` markup;
- every terminal Anthropic `invalid` result with `retryable:false` maps to HTTP `422` and emits `client_retry_suppressed`;
- Recovery remains bounded to one initial Attempt plus at most one Recovery Attempt.

## Source verification

- Full test suite: 314 passed, 0 failed.
- Focused file-tool regressions: 24 passed, 0 failed.
- `npm run check`: passed.
- Package validator: `valid:true`, version `0.7.15`, 92 files, 59 required files.
- JavaScript syntax validation: 76 files passed.
- `docker-compose.partial.yaml`: parsed successfully with services `vllm-proxy-suite`, `searxng`, and `awesome-web-fetch`.

## No-loop verification

Automated regressions verify:

```text
failed Write: read_precondition
→ successful Read of exact path
→ exact Write delivered once
→ no Proxy Recovery

persistent deterministic Write failure
→ one bounded Recovery
→ repeated invalid mutation returns HTTP/SSE 422
→ retryable:false
→ no third upstream request

terminal semantic invalid
→ client_retry_suppressed
→ no HTTP 502 client retry cascade
```

## Artifact verification

- ZIP integrity: passed.
- Clean extracted ZIP: 314 passed, 0 failed with the package `npm test` command; `npm run check` passed.
- v0.7.14 -> v0.7.15 patch apply: passed.
- Patch-applied copy: 314 passed, 0 failed with the package `npm test` command; `npm run check` passed.
- Source, extracted ZIP, and patch-applied SHA-256 manifests: identical across 92 files.
- The package test script uses `--test-concurrency=1` to prevent nondeterministic listener collisions among full-runtime integration tests.

The verified commands include:

```text
unzip -t VLLM-PROXY-SUITE-v0.7.15.zip
npm test from a clean extracted ZIP
npm run check from a clean extracted ZIP
git apply --check vllm-proxy-suite-v0715.patch
source and extracted ZIP SHA-256 manifests are identical
v0.7.14 -> v0.7.15 patch produces the same manifest
```

## Not executed

- A live Docker/Compose image build.
- A real Claude Code -> Proxy -> vLLM deployment integration.
- Production load or long-duration testing.
