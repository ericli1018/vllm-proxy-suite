# VLLM-PROXY-SUITE v0.7.9 Validation

Validation date: 2026-07-31

## Scope

v0.7.9 adds universal Anthropic Tool input-schema validation before replay:

- every buffered Tool Call is matched to the current request `tools[]` definition;
- required fields, types, enums, constants, nested object properties, array items, and `additionalProperties:false` are validated recursively;
- schema-invalid calls such as `TaskUpdate({"status":"completed"})` without `taskId` are discarded before Claude Code can execute them;
- one generic Output-Required Recovery preserves the full Tool set and original `tool_choice`; `auto` remains `auto`;
- Recovery is instructed not to invent missing identifiers and may use a list/read Tool before retrying;
- a second schema-invalid Tool Call is fused as `invalid_tool_input_schema` with `retryable:false`;
- the guard can be disabled with `CLAUDE_CODE_TOOL_INPUT_SCHEMA_GUARD_ENABLED=false`.

## Source verification

- Full test suite: 278 passed, 0 failed.
- `npm run check`: passed.
- Package validator: `valid:true`, version `0.7.9`, 86 files, 53 required files.
- JavaScript syntax validation: 69 files passed.
- `docker-compose.partial.yaml`: parsed successfully.

## Artifact verification

The release procedure additionally verifies:

```text
unzip -t VLLM-PROXY-SUITE-v0.7.9.zip
npm test from a clean extracted ZIP
npm run check from a clean extracted ZIP
source and extracted ZIP SHA-256 manifests are identical
```

Artifact hashes are reported with the release delivery.
