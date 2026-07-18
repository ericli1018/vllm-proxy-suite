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
└── protocol-specific auth, metrics and buffer budget

OpenAI runtime
├── Chat Completions adapter
├── Responses adapter
├── generic network tool classifier
└── protocol-specific auth, metrics and buffer budget

Shared core
├── loop detector
├── response/global buffer budget implementation
├── SSE frame decoder
├── full-attempt runner
└── timeout/cancellation handling
```

## Isolation boundary

The two protocol runtimes share one Node.js process and one heap, but each owns separate configuration, API key, active-request counters, metrics and `BufferBudget`. Claude Code Tool Recovery is loaded only by the Anthropic runtime. Generic network-tool recovery is loaded only by the OpenAI runtime.

## Guarded response invariant

A guarded response cannot enter the formal transcript before validation. On success, the proxy replays the original upstream bytes. On failure, the entire attempt—including reasoning, text and tool calls—is discarded before the single Recovery attempt.

## Deployment boundary

The Compose service uses a named volume mounted at `/app`. On startup it clones or fast-forward updates:

```text
https://github.com/ericli1018/vllm-proxy-suite.git
```

It then runs `node /app/vllm-proxy-suite.js`. The included Dockerfile remains available for immutable image builds.
