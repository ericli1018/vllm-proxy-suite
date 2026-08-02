# VLLM-PROXY-SUITE v0.7.16 Validation

Validation date: 2026-08-02

## Scope

v0.7.16 prevents the single bounded Anthropic Output／Action Recovery from repeating the original Thinking-only failure:

- normal initial Anthropic requests preserve their existing Thinking policy;
- `output_required` Recovery preserves `tools[]` and the original `tool_choice`, including `auto`;
- `action_required` Recovery preserves `tools[]` and continues to force `tool_choice={type:"any",disable_parallel_tool_use:true}`;
- both modes default to `think:false` and `chat_template_kwargs.enable_thinking:false`;
- unrelated file, schema-correction, Managed Web, OpenAI, and generic loop Recovery behavior is unchanged;
- each guarded request remains bounded to one initial Attempt plus at most one Recovery Attempt;
- a second empty or narration-only result still returns HTTP/SSE `422` with `retryable:false` and no third upstream request.

## Source verification

- Full test suite: 316 passed, 0 failed.
- Focused Anthropic Recovery/config regressions: 17 passed, 0 failed.
- `npm run check`: passed.
- Package validator: `valid:true`, version `0.7.16`, 92 files, 59 required files.
- JavaScript syntax validation: 76 files passed.
- `docker-compose.partial.yaml`: parsed successfully with services `vllm-proxy-suite`, `searxng`, and `awesome-web-fetch`.

## No-loop verification

Automated regressions verify:

```text
initial request
→ Thinking remains enabled according to the original/default policy

thinking_without_output
→ exactly one output_required Recovery
→ think:false
→ enable_thinking:false
→ original tool_choice preserved
→ visible text or Tool Call delivered

immediate action narration
→ exactly one action_required Recovery
→ think:false
→ enable_thinking:false
→ tool_choice=any, parallel disabled
→ Tool Call delivered

Recovery still produces no visible output / no Tool Call
→ HTTP/SSE 422
→ retryable:false
→ no third upstream Attempt
```

The two No-Think policies can be independently disabled for compatibility testing:

```text
CLAUDE_CODE_OUTPUT_REQUIRED_RECOVERY_DISABLE_THINKING=false
CLAUDE_CODE_ACTION_REQUIRED_RECOVERY_DISABLE_THINKING=false
```

Both default to `true`.

## Artifact verification

- ZIP integrity: passed.
- Clean extracted ZIP: 316 passed, 0 failed; `npm run check` passed.
- v0.7.15 -> v0.7.16 patch apply: passed.
- Patch-applied copy: 316 passed, 0 failed; `npm run check` passed.
- Source, extracted ZIP, and patch-applied SHA-256 manifests: identical across 92 files.

## Not executed

- A live Docker/Compose image build.
- A real Claude Code -> Proxy -> vLLM deployment integration.
- Production load or long-duration testing.
