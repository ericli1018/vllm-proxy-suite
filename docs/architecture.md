# Architecture

## Single-process JavaScript Gateway

```text
Client
  → vllm-proxy-suite.js :3456
      ├── /v1/messages
      ├── /v1/messages/count_tokens
      │     → Anthropic runtime
      │
      └── remaining /v1/*
            → OpenAI runtime

Anthropic runtime ─┐
                   ├→ vLLM :8001
OpenAI runtime ────┘
```

`apps/gateway/server.js` owns the only HTTP listener. It classifies the native path and calls the selected protocol runtime directly in memory. There is no Nginx layer, no internal HTTP forwarding, and no protocol service ports.

## Runtime policy split

The two protocol runtimes deliberately use different Tool policies.

### Anthropic runtime

```text
Upstream Messages stream
→ protected buffer
→ Thinking/structure/Tool validation
├── valid → replay original bytes
└── invalid/loop → at most one Recovery → validate → replay or fail closed
```

Claude Code file-tool validation and Recovery remain Anthropic-only.

### OpenAI runtime

```text
Before first Tool Call
→ protected buffer
→ Thinking Loop and semantic guards remain active

First Tool Call observed
→ irreversible commit boundary
→ stop heartbeat
→ flush all buffered upstream bytes
→ release response buffer reservation
→ stream later upstream bytes directly with backpressure
→ Tool parsing continues for bounded observe-only metrics
→ no Tool blocking, rewriting, repair, splitting, or Recovery
```

This policy applies to `/v1/chat/completions` and `/v1/responses`. Non-stream OpenAI responses containing Tool Calls are delivered unchanged after the complete upstream JSON body arrives. OpenAI responses without Tool Calls keep the protected buffered validation path.

## Components

```text
JavaScript Gateway
├── native path classification
├── suite health and combined metrics
├── socket lifecycle and graceful drain
├── Anthropic runtime instance
└── OpenAI runtime instance

Anthropic runtime
├── Messages request policy
├── Anthropic SSE adapter
├── Claude Code file-tool semantic recovery
└── fail-closed protocol auth, metrics and buffer budget

OpenAI runtime
├── Chat Completions adapter
├── Responses adapter
├── pre-Tool Thinking Loop guard
├── irreversible transparent Tool stream commit
├── bounded observe-only Tool diagnostics
└── protocol-specific auth, metrics and buffer budget

Shared core
├── loop detector
├── response/global buffer budget implementation
├── SSE frame decoder
├── protected attempt runner with optional Tool commit sink
└── timeout/cancellation handling
```

## Commit boundary invariant

Before the OpenAI Tool boundary, no formal model bytes are committed except optional SSE heartbeat comments. A failed pre-Tool attempt can therefore be discarded and recovered.

After `tool_passthrough_started`, model bytes have entered the client stream. The boundary is irreversible:

- Recovery is disabled for that attempt.
- Tool JSON validity cannot block delivery.
- A later upstream, client, or response-sink failure terminates the committed stream; the Proxy does not append a second protocol error body.
- Node response backpressure is honored.

The observer retains at most `TOOL_PASSTHROUGH_OBSERVATION_MAX_BYTES` of each Tool argument while total bytes and fragment counts remain exact. The retained prefix can be disabled with `0`.

## Isolation boundary

The two protocol runtimes share one Node.js process and one heap, but each owns separate configuration, API key, active-request counters, metrics and `BufferBudget`. Claude Code Tool Recovery is loaded only by the Anthropic runtime. Generic OpenAI Recovery can operate only before a Tool stream is committed.

## Deployment boundary

The Compose service uses a named volume mounted at `/app`. On startup it clones or fast-forward updates:

```text
https://github.com/ericli1018/vllm-proxy-suite.git
```

It then runs `node /app/vllm-proxy-suite.js`. The included Dockerfile remains available for immutable image builds.

## Responses upstream adapter boundary

`/v1/responses` 有兩個固定配置模式：

```text
RESPONSES_UPSTREAM_MODE=native（預設）
Responses frontend
→ optional request-side Tool Choice Policy
→ native vLLM Responses upstream
→ existing Responses parser/delivery

RESPONSES_UPSTREAM_MODE=chat_adapter（明確 fallback）
Responses frontend
→ normalize Responses Lite additional_tools
→ optional request-side Tool Choice Policy
→ canonical message/tool mapping
→ Chat Completions upstream
→ Responses event encoder
→ existing Responses parser/delivery
```

The route-scoped fetch adapter sits below the existing attempt runner. The attempt runner therefore continues to see standard Responses JSON/SSE in both modes, so protocol parsing, transparent Tool commit, replay, cancellation, timeouts and metrics do not need a second implementation. Responses behavioral guards remain disabled by default through `RESPONSES_BEHAVIOR_MODE=transparent`.

The adapter uses a request-local mapping table to flatten namespace tools for Chat upstreams and restore `(namespace, name)` in Responses function calls. Custom tools are represented upstream as strict wrapper functions with a single freeform `__arg1` string; the encoder restores native `custom_tool_call` items.

There is no automatic native-to-chat fallback after an attempt starts. A deployment selects one mode per runtime to prevent duplicate inference or duplicate Tool side effects. The default is native because it preserves vLLM's Responses renderer, item lifecycle and model-specific tool context.

## Managed WebSearch execution layer

The Anthropic runtime can optionally wrap its vLLM fetch path with `packages/anthropic/managed-websearch.js`.

```text
Claude Code /v1/messages
→ vLLM Anthropic Messages generation
→ exactly one WebSearch tool_use
→ SearXNG JSON Search API
→ bounded untrusted tool_result
→ internal Anthropic continuation
→ final text or ordinary Claude Code tool_use
```

The bridge does not change the shared protocol runtime. Anthropic responses are already buffered before replay, so the bridge can hide the managed Tool Call without crossing an irreversible client-delivery boundary. Responses containing mixed tools, multiple Tool Calls, malformed tool input, unknown content blocks, or a non-`tool_use` stop reason are returned untouched.

The continuation preserves supported thinking, text, and tool-use blocks and appends a matching `tool_result`. It does not emulate Anthropic Hosted Web Search, server tool lifecycle events, encrypted content, citations, or WebFetch.
