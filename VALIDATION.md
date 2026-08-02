# VLLM-PROXY-SUITE v0.7.13 Validation

Validation date: 2026-08-01

## Scope

v0.7.13 adds a content-aware HTML browser provider without replacing the existing document fetch path:

- `WEBFETCH_HTML_PROVIDER=awesome-web-fetch` routes HTML and unknown browser-like pages to the `awesome-web-fetch` Playwright sidecar;
- known PDF, plain text, Markdown, JSON, XML, CSV, TSV, YAML, and log URLs bypass the sidecar and retain the existing internal downloader and parsers;
- extensionless URLs use one bounded, SSRF-checked HEAD probe before provider selection;
- sidecar `page_content` and metadata are normalized, including `source`, `final_url`, `title`, `content_type`, `status_code`, and `browser_rendered` plus compatible aliases;
- a sidecar result identified as a non-HTML document may reroute Browser -> Internal exactly once;
- Internal never falls back to Browser, sidecar failure never silently triggers a direct HTML GET, and no new model Recovery path was added;
- the original URL and sidecar-reported final URL are validated before use;
- the existing Chunk Reader, Document Synthesizer, bounded Tool Result, per-kind use limits, and post-limit fuse remain in place;
- the same Compose file now includes an opt-in `awesome-web-fetch` service under the `webfetch-browser` profile.

## Source verification

- Full test suite: 303 passed, 0 failed.
- Focused content-router and Gateway integration tests: 8 passed, 0 failed.
- `npm run check`: passed.
- Package validator: `valid:true`, version `0.7.13`, 91 files, 58 required files.
- JavaScript syntax validation: 74 files passed.
- `docker-compose.partial.yaml`: parsed successfully with services `vllm-proxy-suite`, `searxng`, and `awesome-web-fetch`.
- Sidecar profile: `webfetch-browser`.

## No-loop verification

Automated regressions verify:

```text
known document -> Internal only
HTML -> sidecar only
sidecar non-HTML metadata -> one Internal reroute
sidecar HTTP failure -> error tool_result, no direct HTML fallback
Internal -> Browser transition does not exist
```

The integration does not add an Attempt Recovery. A model may still issue another WebFetch during the normal managed continuation, but the existing request-local `WEBFETCH_MAX_USES` limit and `managed_web_tool_limit_repeated` fuse bound that behavior.

## Artifact verification

The release procedure additionally verifies:

```text
unzip -t VLLM-PROXY-SUITE-v0.7.13.zip
npm test from a clean extracted ZIP
npm run check from a clean extracted ZIP
source and extracted ZIP SHA-256 manifests are identical
v0.7.12 -> v0.7.13 patch applies cleanly and produces the same manifest
```

## Not executed

- A live Docker/Compose image build of the external Git context.
- A live `awesome-web-fetch` Chromium request against public websites.
- A real Claude Code -> Proxy -> vLLM -> awesome-web-fetch deployment integration.
- Production load, long-duration browser-context, or egress-policy testing.

The current environment could not retrieve the repository through its web/Git network path. The adapter therefore uses the confirmed `{urls:[...]}` / `page_content` baseline and accepts the documented metadata fields plus compatible snake_case/camelCase aliases. Artifact hashes are reported with the release delivery.
