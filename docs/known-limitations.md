# Known Limitations

1. Anthropic Messages and OpenAI responses without Tool Calls use buffered protocol delivery rather than immediate model-token streaming.
2. OpenAI Chat Completions still uses the pre-Tool behavioral guard. Responses defaults to `transparent`, so pre-Tool reasoning is buffered for protocol observation but is not discarded by Think Loop or Actionless classification.
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
15. `native` is the default and depends on the selected vLLM/model stack correctly implementing Responses rendering, Tool Calling and multi-turn item history. `chat_adapter` remains an explicit compatibility fallback and does not implement server-side Responses state. `previous_response_id`, background mode and `store=true` are rejected before upstream execution.
16. `chat_adapter` supports Client-executed function/custom/namespace tools, including Responses Lite `additional_tools`; Hosted Tools are not emulated. Optional Hosted Tool declarations may be filtered by policy, while explicitly required Hosted Tools are rejected unless native mode is used.
17. Specialized Responses history items such as compaction, shell/local-shell call records, hosted search records and unknown content blocks are rejected rather than silently discarded. Use `native` when the selected vLLM/model stack supports those items.
18. Namespace tools are flattened into Chat function names and restored from a request-local mapping. A model that invents or mutates a flattened name cannot be routed reliably.
19. Custom Tool freeform input is wrapped in a Chat JSON argument named `__arg1`. The Responses Tool boundary is announced immediately, but full freeform input remains available only when the Chat arguments are complete.
20. The malformed required-tool retry is heuristic and limited to one extra Chat upstream call. It can reduce parser failures but cannot guarantee that the model chooses the correct tool or produces semantically correct arguments.
21. `required_on_explicit_continue` recognizes only short explicit execution commands. It intentionally does not classify general task prompts, and `tool_choice=required` still cannot guarantee semantically correct tool selection or arguments.
22. Anthropic `thinking_without_output` Recovery preserves the request Tool choice and permits text or Tool output. This avoids forced irrelevant tools, but the model may still choose narration or a clarification instead of the external action the user intended unless the Action-Intent Guard independently matches its visible output.
23. The placeholder completion guard intentionally recognizes only exact `No response`, `No output`, `無回應`, `沒有回應`, `無輸出`, and `沒有輸出` markers after a latest Tool Result. Other model-specific placeholder phrases are delivered unless added explicitly; this conservative boundary avoids blocking legitimate short answers.
24. Targetless invalid mutation recovery intentionally does not infer or synthesize a missing file path. It preserves `tool_choice` and asks the model to continue from accepted state; if a precise target is required, the model must provide it in a complete Tool Call or ask the user.
25. Live integration with the target vLLM, Codex, Claude Code, Hermes, and OpenAI SDK must still be verified in the deployment environment.

## Think Loop heuristic

Think Loop detection remains heuristic before an action boundary. The default requires three repeated cycles, but unusual repetitive reasoning may still trigger Recovery before output, refusal, Function Call, or terminal response state appears. After an OpenAI action boundary, loop detection is disabled for that Attempt.

## Managed WebSearch limitations

- The SearXNG bridge is disabled by default and requires an externally reachable SearXNG instance with JSON output enabled.
- v0.7.3 manages one or more homogeneous WebSearch calls or one or more homogeneous WebFetch calls with bounded concurrency. Mixed Managed/Client Tool batches are still delivered unchanged to Claude Code.
- WebSearch results remain snippets and links. Managed WebFetch can read bounded HTML/text/PDF content, but native Anthropic citations, encrypted server-tool state, and hosted-search usage accounting are not implemented.
- Allowed and blocked domains are enforced by filtering returned result hostnames; they are not a transport-level guarantee that SearXNG queried only those domains.
- The bridge buffers each vLLM sub-response and performs an internal continuation, increasing latency and context usage. After the first Managed Tool starts, a synthetic Anthropic lifecycle sends periodic visible or invisible text deltas to keep Claude Code active, but the model continuation still waits for every Tool Result belonging to the same assistant turn.

## Managed WebFetch

- HTML extraction is static and does not execute JavaScript.
- Authenticated, CAPTCHA-protected, browser-only, and dynamically rendered pages may return incomplete content.
- PDF extraction requires `pdftotext` from `poppler-utils`.
- Managed Web Tool activity is internal to the Proxy and is not rendered as a Claude Code Tool row. In the default `visible` mode, Claude Code shows a synthetic assistant progress line with sanitized search query or hostname plus periodic ellipses. `invisible` mode may still appear as an empty text block in clients that expose invisible Unicode.
- The synthetic `message_start` is emitted before upstream token usage is known, so downstream `usage.input_tokens` is reported as `0`; Proxy completion logs and internal metrics still retain the actual upstream usage reported by vLLM.
- The implementation returns its own bounded evidence schema and does not emulate Anthropic hosted-tool encrypted content or native citations.
- URL hostnames are resolved and checked before each request/redirect, but the current fetch transport does not pin the validated IP; environments requiring DNS-rebinding resistance should place the Proxy behind an egress firewall or outbound HTTP proxy.
