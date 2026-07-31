# VLLM-PROXY-SUITE v0.7.10 Validation

Validation date: 2026-07-31

## Scope

v0.7.10 adds targeted Anthropic Tool input-schema correction:

- exactly one unsupported property under `additionalProperties:false` is eligible only when removing it makes the entire Tool input valid;
- Recovery is scoped to the rejected Tool and forces that Tool with parallel calls disabled;
- all accepted argument values must remain unchanged, and text-only or altered Recovery output is fused;
- missing identifiers, multiple unsupported properties, and still-invalid inputs retain generic `tool_choice:auto` Recovery;
- targeted correction can be disabled independently with `CLAUDE_CODE_TARGETED_SCHEMA_CORRECTION_ENABLED=false`.

## Source verification

- Full test suite: 284 passed, 0 failed.
- `npm run check`: passed.
- Package validator: `valid:true`, version `0.7.10`, 87 files, 54 required files.
- JavaScript syntax validation: 71 files passed.
- `docker-compose.partial.yaml`: parsed successfully with services `vllm-proxy-suite` and `searxng`.

## Artifact verification

The release procedure additionally verifies:

```text
unzip -t VLLM-PROXY-SUITE-v0.7.10.zip
npm test from a clean extracted ZIP
npm run check from a clean extracted ZIP
source and extracted ZIP SHA-256 manifests are identical
```

Artifact hashes are reported with the release delivery.
