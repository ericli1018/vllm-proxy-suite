# Known Limitations

1. Guarded endpoints use Protected Streaming rather than Immediate Token Streaming.
2. OpenAI `/v1/completions` remains transparent passthrough and does not receive the reasoning Loop Guard.
3. Gateway routing is static: exact Anthropic Messages paths first, then the remaining `/v1/*` paths to OpenAI.
4. Both protocol runtimes share one Node.js heap. Their request counters, metrics and buffer budgets remain separate, but process-level memory exhaustion affects the whole suite.
5. Claude Code Tool Recovery recognizes only the official `Read`, `Edit`, `Write`, `NotebookEdit` and `Bash` tools actually present in the Anthropic request; arbitrary MCP tools are not treated as built-in editors.
6. The proxy does not parse Bash commands. Any Bash Tool Result conservatively invalidates prior Read freshness.
7. Unknown SSE events are preserved by raw replay but may not contribute to Loop Detection or semantic-stall progress.
8. Runtime Git synchronization force-resets the named volume to the configured ref on container start, so a restart can deploy a newer commit and discards local runtime modifications. Pin `VLLM_PROXY_SUITE_REF` to a release branch or tag, or build the included Dockerfile for immutable deployment.
9. Live integration with the target vLLM, Claude Code and OpenAI SDK must still be verified in the deployment environment.
