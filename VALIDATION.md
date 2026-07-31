# VLLM-PROXY-SUITE v0.7.8 Validation

Validation date: 2026-07-31

## Scope

v0.7.8 adds guarded Anthropic Tool stop-reason normalization:

- complete, exposed, schema-valid Tool Calls ending with `end_turn` are rewritten to `tool_use`;
- the actual buffered SSE or JSON payload and parsed completion diagnostics are updated together;
- initial and Recovery attempts share the same rule;
- invalid, unknown, malformed, unclosed, excessive, cancelled, or failed Tool transitions remain fail-closed;
- normalization can be disabled with `CLAUDE_CODE_TOOL_STOP_REASON_NORMALIZATION_ENABLED=false`.

## Source verification

- Full test suite: 272 passed, 0 failed.
- `npm run check`: passed.
- Package validator: `valid:true`, version `0.7.8`, 85 files, 52 required files.
- JavaScript syntax validation: 69 files passed.
- `docker-compose.partial.yaml`: parsed successfully.

## Artifact verification

The release procedure additionally verifies:

```text
unzip -t VLLM-PROXY-SUITE-v0.7.8.zip
npm test from a clean extracted ZIP
npm run check from a clean extracted ZIP
source and extracted ZIP SHA-256 manifests are identical
```

Artifact hashes are reported with the release delivery.
