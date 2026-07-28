# Known Limitations

1. Anthropic Messages and OpenAI responses without Tool Calls use Protected Streaming rather than immediate model-token streaming.
2. OpenAI Chat Completions and Responses become immediate transparent streams only after the first Tool Call is parsed. Pre-Tool reasoning remains buffered so Thinking Loops can still be discarded.
3. The OpenAI Tool commit boundary is irreversible. Malformed, truncated, oversized, or semantically incorrect Tool arguments are not repaired or blocked by the Proxy after commit.
4. Transparent Tool passthrough does not solve model completion-limit truncation. The client may still reject an incomplete Tool Call or retry the same request.
5. If the upstream or client connection fails after Tool commit, the Proxy terminates the stream and cannot safely append a second structured error or Recovery response.
6. Observe-only Tool parsing retains only a configurable prefix. When truncated, the Proxy preserves exact byte/fragment counts but cannot determine final JSON validity. Set `TOOL_PASSTHROUGH_OBSERVATION_MAX_BYTES=0` to retain no argument content.
7. OpenAI `/v1/completions` remains transparent passthrough and does not receive the reasoning Loop Guard.
8. Gateway routing is static: exact Anthropic Messages paths first, then the remaining `/v1/*` paths to OpenAI.
9. Both protocol runtimes share one Node.js heap. Their request counters, metrics and buffer budgets remain separate, but process-level memory exhaustion affects the whole suite.
10. Claude Code Tool Recovery recognizes only the official `Read`, `Edit`, `Write`, `NotebookEdit` and `Bash` tools actually present in the Anthropic request; arbitrary MCP tools are not treated as built-in editors.
11. The Proxy does not parse Bash commands. Any Bash Tool Result conservatively invalidates prior Read freshness.
12. Unknown SSE events are preserved by protected replay or transparent streaming but may not contribute to Loop Detection or semantic progress.
13. Runtime Git synchronization force-resets the named volume to the configured ref on container start. Pin `VLLM_PROXY_SUITE_REF` or build the Dockerfile for immutable deployment.
14. A valid Responses `status="incomplete"` is delivered unchanged. The Proxy does not automatically continue the response, increase `max_output_tokens`, or synthesize visible output from reasoning; the Client owns continuation policy.
15. Live integration with the target vLLM, Claude Code, Hermes, and OpenAI SDK must still be verified in the deployment environment.

## Think Loop heuristic

Think Loop detection remains heuristic before an action boundary. The default requires three repeated cycles, but unusual repetitive reasoning may still trigger Recovery before output, refusal, Function Call, or terminal response state appears. After an OpenAI action boundary, loop detection is disabled for that Attempt.
