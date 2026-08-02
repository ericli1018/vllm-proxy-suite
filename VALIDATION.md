# VLLM-PROXY-SUITE v0.7.17 Validation

Validation date: 2026-08-02

## Scope

v0.7.17 prevents a valid forced Claude Code file Tool Recovery from being rejected only because the model emitted a short visible preamble:

- forced file Tool Recovery still requires exactly one Tool Call;
- Tool name, request `input_schema`, exact target path, no-op rules, scope widening, and repeated-fingerprint rules remain mandatory;
- optional auxiliary text is measured as UTF-8 bytes and defaults to a maximum of `1024` bytes;
- text cannot replace a Tool Call or authorize a different Tool, target, schema, or additional Tool Call;
- excess text fuses as `forced_tool_recovery_excess_text`, HTTP/SSE `422`, `retryable:false`;
- Targeted Schema Correction Recovery retains its zero-text policy;
- one initial Attempt plus at most one Recovery Attempt remains the hard bound.

## Source verification

- Full test suite: 318 passed, 0 failed.
- Focused forced Tool Recovery/config regressions: 28 passed, 0 failed.
- `npm run check`: passed.
- Package validator: `valid:true`, version `0.7.17`, 92 files, 59 required files.
- JavaScript syntax validation: 76 files passed.
- `docker-compose.partial.yaml`: parsed successfully with services `vllm-proxy-suite`, `searxng`, and `awesome-web-fetch`.

## Safety and no-loop verification

Automated regressions verify:

```text
no-op or repeated file mutation
→ exactly one forced file Tool Recovery

Recovery emits one valid Read/Edit/Write/NotebookEdit Tool Call
+ auxiliary text <= configured UTF-8 byte limit
→ Recovery accepted
→ Tool Call delivered

Recovery emits no Tool Call / multiple Tool Calls / wrong Tool / wrong target / invalid schema
→ HTTP/SSE 422
→ retryable:false

Recovery auxiliary text exceeds configured limit
→ forced_tool_recovery_excess_text
→ HTTP/SSE 422
→ retryable:false
→ no third upstream Attempt
```

The limit is configurable:

```text
CLAUDE_CODE_FORCED_TOOL_RECOVERY_MAX_TEXT_BYTES=1024
```

Accepted text is observed only through byte-count diagnostics and `forced_tool_recovery_auxiliary_text_accepted`; the text body is not logged by that event.

## Artifact verification

- ZIP integrity: passed.
- Clean extracted ZIP: 318 passed, 0 failed; `npm run check` passed.
- v0.7.16 -> v0.7.17 patch apply/check: passed.
- Patch-applied copy: 318 passed, 0 failed; `npm run check` passed.
- Source, extracted ZIP, and patch-applied SHA-256 manifests: identical across 92 files.

## Not executed

- A live Docker/Compose image build.
- A real Claude Code -> Proxy -> vLLM deployment integration.
- Production load or long-duration testing.
