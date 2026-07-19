# VLLM-PROXY-SUITE

`VLLM-PROXY-SUITE` 是面向本地 vLLM 的雙協議 Reverse Proxy。正式執行方式是一個**單一 Node.js Gateway Process**：它只監聽一個 Port，依原生 API path 直接呼叫 Anthropic 或 OpenAI 模組，不依賴外部路由服務，也不透過內部 HTTP Port 串接兩個 Proxy。

```text
Claude Code / Anthropic Client
                         ┌→ Anthropic runtime ───────┐
Client → JS Gateway :3456                           ├→ vLLM :8001
                         └→ OpenAI runtime ──────────┘
OpenAI SDK / OpenAI-compatible Client
```

## 設計目標

- 對外只暴露 `3456`。
- 依原生 API path 精確分流，不增加 `/anthropic` 或 `/openai` 前綴。
- Gateway 與協議模組位於同一個 Node.js process，路由不產生額外網路 hop。
- Anthropic 與 OpenAI runtime 各自保有 API Key、Metrics、active-request 計數與 Buffer Budget。
- 共用 Loop Detector、Timeout、Cancellation 與最多一次 Recovery 控制。
- Anthropic Messages 保持完整 Attempt 緩衝、驗證、Recovery 與原始 bytes 回放。
- OpenAI Chat Completions／Responses 在第一個 Tool Call 前保持 Protected Streaming；第一個 Tool delta 出現後立即切換成透明直送。
- OpenAI Tool commit 後不阻擋、不修補、不拆分、不重寫 Tool arguments，也不再執行 Recovery；Proxy 只保留有界觀測與計數。
- OpenAI 沒有 Tool Call 的回應仍保留上游原始 response bytes，通過驗證後回放。
- OpenAI Recovery 只在 Tool commit 前使用當次 request 真正提供的網路查詢或下載工具，不預設固定工具名稱。
- Claude Code Tool Recovery 只載入 Anthropic runtime，不會影響 OpenAI API。

## 原生路徑路由

| Client Path | Runtime | 行為 |
|---|---|---|
| `POST /v1/messages` | Anthropic | Messages Guard、Loop Recovery、Claude Code Tool Recovery |
| `/v1/messages/count_tokens` | Anthropic | 透明穿透 |
| `POST /v1/chat/completions` | OpenAI | Pre-Tool Think Guard；Tool Call 透明直送 |
| `POST /v1/responses` | OpenAI | Pre-Tool Think Guard；Function Call 透明直送 |
| 其他 `/v1/*` | OpenAI | 透明穿透 |
| 其他路徑 | Gateway | `404` |

路由實作位於：

```text
apps/gateway/server.js
```

核心判定順序是：

```text
/v1/messages
/v1/messages/count_tokens
→ Anthropic runtime

其他 /v1/*
→ OpenAI runtime

其他 path
→ 404
```

## Repository 結構

```text
VLLM-PROXY-SUITE/
├── apps/
│   ├── gateway/server.js
│   ├── vllm-cc-proxy/server.js
│   └── vllm-openai-proxy/server.js
├── packages/
│   ├── core/
│   ├── anthropic/
│   │   └── claude-code-tools/recovery.js
│   ├── openai/
│   └── server/
├── test/
├── docs/
├── Dockerfile
├── docker-compose.partial.yaml
└── vllm-proxy-suite.js
```

主要入口是：

```text
node vllm-proxy-suite.js
```

進度欄位、Hermes Tool Call 往返判讀與資料安全說明見：

```text
docs/observability.md
```

Anthropic 與 OpenAI 僅作為 in-process runtime 模組，不提供獨立對外 listener。

## 必要環境

- Node.js 22 或以上。
- vLLM API 可由 Docker network 存取。
- Compose 範例預設：
  - vLLM service：`vllm`
  - vLLM port：`8001`
  - Docker network：`vllm-test-network`

## Docker Compose 部署

`docker-compose.partial.yaml` 用於合併至既有 Compose。它只新增一個 service 與一個 named volume：

```text
service: vllm-proxy-suite
volume:  vllm-proxy-suite
```

Container 啟動時會初始化或更新：

```text
https://github.com/ericli1018/vllm-proxy-suite.git
```

然後執行：

```text
node /app/vllm-proxy-suite.js
```

### 1. 設定 API Key

```bash
export VLLM_API_KEY='vllm'
export VLLM_CC_PROXY_API_KEY='replace-with-a-long-random-key'
export VLLM_OPENAI_PROXY_API_KEY='replace-with-another-long-random-key'
```

兩個協議共用 Base URL，但使用不同對外 Key：

- Claude Code／Anthropic Client：`VLLM_CC_PROXY_API_KEY`
- OpenAI Client：`VLLM_OPENAI_PROXY_API_KEY`

### 2. 啟動

```bash
docker compose up -d vllm-proxy-suite
```

對外 Base URL：

```text
http://127.0.0.1:3456
```

### 3. 更新行為

Compose 預設使用：

```text
VLLM_PROXY_SUITE_REPOSITORY=https://github.com/ericli1018/vllm-proxy-suite.git
VLLM_PROXY_SUITE_REF=main
```

第一次啟動會以 shallow clone 初始化；named volume 已有 Repository 時會先將 `/app` 設為 Git safe directory，再強制同步指定 ref：

```text
git -c safe.directory=/app -C /app remote set-url origin <repository>
git -c safe.directory=/app -C /app fetch --force --prune origin <ref>
git -c safe.directory=/app -C /app reset --hard FETCH_HEAD
git -c safe.directory=/app -C /app clean -fdx
```

若正式環境要求可重現部署，應將 `VLLM_PROXY_SUITE_REF` 固定至 release branch／tag，或使用本專案 Dockerfile 建立不可變 Image。

## Claude Code

```bash
export ANTHROPIC_BASE_URL='http://127.0.0.1:3456'
export ANTHROPIC_AUTH_TOKEN="$VLLM_CC_PROXY_API_KEY"
export ANTHROPIC_MODEL='your-vllm-served-model-name'
```

Proxy 不改寫 `model`，名稱必須與 vLLM `--served-model-name` 一致。

## OpenAI SDK

```bash
export OPENAI_BASE_URL='http://127.0.0.1:3456/v1'
export OPENAI_API_KEY="$VLLM_OPENAI_PROXY_API_KEY"
```

測試 Models API：

```bash
curl http://127.0.0.1:3456/v1/models \
  -H "Authorization: Bearer $VLLM_OPENAI_PROXY_API_KEY"
```

## Loop Guard 與 OpenAI Tool Passthrough

### Anthropic／無 Tool 的 OpenAI 回應

```text
Upstream Attempt
→ 完整緩衝與增量解析
→ Loop／結構／容量／語意驗證
├── 成功：原始 bytes 回放
└── 失敗：整份 Attempt 丟棄 → Recovery 一次 → 驗證 → 回放
```

Attempt 完成前只可能送出標準 SSE comment：

```text
: keep-alive
```

### OpenAI Tool Call

```text
Upstream Attempt
→ Tool Call 前：完整緩衝、Thinking Loop Guard、Semantic Guard
→ 第一個 Tool Call 被解析
→ 不可逆 commit boundary
→ 停止 heartbeat
→ 立即 flush 已緩衝的原始 bytes
→ 後續 upstream bytes 依 backpressure 直接送 Client
→ Tool parser 只作有界 observe-only 計數
```

Commit 之後：

- 不驗證後才決定是否交付。
- 不因 malformed／truncated／oversized Tool JSON 阻擋 response。
- 不修補、重組、分段或替換 Tool Call。
- 不執行 Proxy Recovery。
- 若 upstream 或 client 中斷，只能終止已 commit 的 stream，不能再附加第二份 protocol error。

這個設計讓 Proxy 只處理 Tool Call 前的 Thinking Loop，Tool aggregation、JSON validity、execution 與 retry policy 回到 Hermes／OpenAI-compatible Client。

## OpenAI 網路工具 Recovery

OpenAI runtime 由 request 的 `tools[]` 建立以下 Capability：

- `network_lookup`
- `network_download`
- `network_hybrid`
- `non_network`
- `unknown`

判定依據包括 function name、description 與 JSON Schema。工具名稱可完全自訂。自動分類不足時可使用：

```bash
RECOVERY_NETWORK_LOOKUP_TOOL_NAMES='net_probe,remote_search'
RECOVERY_NETWORK_DOWNLOAD_TOOL_NAMES='url_reader,download_resource'
RECOVERY_NETWORK_HYBRID_TOOL_NAMES='browser_agent'
```

沒有可辨識網路工具時，Proxy 不會虛構工具名稱。
此 Recovery 僅能發生在 OpenAI Tool commit 前；Recovery generation 一旦開始輸出 Tool Call，也立即切換為透明直送。

## Anthropic Request Policy

只有 `POST /v1/messages` 進行必要封包處理：

- 保留合法 `temperature`、`top_p`、`top_k`。
- 缺少或不合法的 `max_tokens` 使用 `DEFAULT_MAX_TOKENS`。
- `thinking.type` 轉成 `chat_template_kwargs.enable_thinking`。
- 移除 vLLM Anthropic schema 不接受的 generation 擴充欄位。
- `model` 原樣保留。

## Claude Code Tool Recovery

Anthropic runtime 以本次 request 的 `tools[]` 與 `input_schema` 為執行期權威，處理：

- `Read`
- `Edit`
- `Write`
- `NotebookEdit`
- `Bash`：只作為檔案證據可能失效的訊號，不解析或改寫 shell command。

主要介入條件：

```text
Edit old_string == new_string
→ 阻擋 no-op Edit

同一 mutation tool + canonical arguments
且歷史 tool_result is_error:true
→ 阻擋完全相同的失敗重送

Tool arguments 不符合本次 tools[].input_schema
→ 阻擋結構不合法的 mutation
```

Recovery 必須只有一個允許的 Tool Call、不能帶 Final Text、不能改變 target。沒有足夠證據證明修復安全時，Proxy fail closed。

Recovery Prompt 使用狀態重置與策略切換，而不是空泛鼓勵：前次 generation 已丟棄、Recovery 是正常流程、不得解釋前次失敗，只執行下一個有效動作。

## 主要環境變數

### Gateway／共用

| 變數 | 預設 |
|---|---:|
| `PROXY_HOST` | `0.0.0.0` |
| `PROXY_PORT` | `3456` |
| `VLLM_BASE_URL` | `http://vllm:8001` |
| `VLLM_API_KEY` | `vllm` |
| `VLLM_CC_PROXY_API_KEY` | 無 |
| `VLLM_OPENAI_PROXY_API_KEY` | 無 |
| `MAX_RECOVERY_ATTEMPTS` | `1` |
| `HEARTBEAT_INTERVAL_MS` | `10000` |
| `TOTAL_GENERATION_TIMEOUT_MS` | `1800000` |
| `RECOVERY_TIMEOUT_MS` | `900000` |
| `MAX_ACTIVE_REQUESTS` | `256`，每個 protocol runtime 各自計算 |
| `MAX_RESPONSE_BUFFER_BYTES` | `33554432`，OpenAI Tool commit 前與受保護回應使用 |
| `MAX_TOTAL_BUFFERED_BYTES` | `1073741824`，每個 protocol runtime 各自計算 |
| `MAX_TOOL_ARGUMENT_BYTES` | `8388608`，受保護 Tool 驗證路徑的硬上限；OpenAI commit 後不阻擋 |
| `TOOL_ARGUMENT_WARNING_BYTES` | `8192`，設為 `0` 可停用 warning |
| `TOOL_ARGUMENT_CRITICAL_BYTES` | `16384`，設為 `0` 可停用 critical warning |
| `TOOL_PASSTHROUGH_OBSERVATION_MAX_BYTES` | `65536`，OpenAI Tool commit 後每個 arguments 最多保留的診斷前綴；`0` 表示只計數、不保留內容 |
| `TOOL_CORRELATION_TTL_MS` | `900000` |
| `TOOL_CORRELATION_MAX_ENTRIES` | `10000` |
| `CLIENT_RETRY_FINGERPRINT_TTL_MS` | `900000` |
| `CLIENT_RETRY_FINGERPRINT_MAX_ENTRIES` | `10000` |

`TOOL_ARGUMENT_WARNING_BYTES` 與 `TOOL_ARGUMENT_CRITICAL_BYTES` 只發出診斷事件，不會截斷或改寫 Tool arguments。`MAX_TOOL_ARGUMENT_BYTES` 仍用於受保護的驗證路徑；OpenAI Tool Call 一旦 commit，任何大小或 JSON 狀態都只能 observe-only，不能撤銷已送出的 stream。`TOOL_PASSTHROUGH_OBSERVATION_MAX_BYTES` 只限制 Proxy 內部保留的 arguments 前綴，總 byte／fragment counters 仍精確。Client retry fingerprint 使用 path 與原始 request body 的精確 SHA-256；只辨識 byte-identical retry，不會對相似 prompt 做模糊比對。

### Claude Code Recovery

| 變數 | 預設 |
|---|---:|
| `CLAUDE_CODE_TOOL_RECOVERY_ENABLED` | `true` |
| `CLAUDE_CODE_EDIT_RECOVERY_ENABLED` | `true` |
| `CLAUDE_CODE_WRITE_RECOVERY_ENABLED` | `true` |
| `CLAUDE_CODE_NOTEBOOK_EDIT_RECOVERY_ENABLED` | `true` |
| `CLAUDE_CODE_BASH_INVALIDATES_READS` | `true` |

## Health 與 Metrics

單一 Gateway 提供：

```text
GET /health/live
GET /health/ready
GET /health/cc
GET /health/openai
GET /metrics
GET /metrics/cc
GET /metrics/openai
```

`SIGTERM`／`SIGINT` 會同時將兩個 runtime 切入 drain，再等待現有 request 完成至 grace deadline。

## 本機驗證

```bash
node --version
npm test
npm run check
```

本專案執行期不依賴第三方 npm package。

## 已知限制

- OpenAI Tool passthrough 不會修復模型因 completion limit、parser 或格式錯誤產生的不完整 Tool arguments；Client 仍可能拒絕或重試。
- `tool_passthrough_started` 之後 response 已不可撤銷；上游或 Client 中斷時不能再附加 Recovery 或第二份 protocol error。
- Tool commit 前的 reasoning 仍採 Protected Streaming，因此第一個正式 token 會有延遲。
- 兩個 protocol runtime 共用同一個 Node.js heap；任一模組造成 process-level OOM 都會影響整套服務。
- 兩個 runtime 的 Buffer Budget 與 active-request counter 各自獨立，因此 `MAX_TOTAL_BUFFERED_BYTES` 是每個 runtime 的限制，不是 process 合計。
- `/v1/responses` 未辨識的新事件會保留在原始 SSE bytes，但不一定計入語意進度。
- 詳細限制見 `docs/known-limitations.md`。
- 尚未在本環境完成真實 Claude Code／Hermes／OpenAI SDK → Gateway → vLLM 整合。

## 安全與部署

- 不要使用 Compose 中的預設範例 Key。
- 建議由外層 TLS Terminator／Ingress 提供 HTTPS。
- 不要向不可信網路直接暴露 vLLM port。
- Runtime Git 更新模式方便單機維護，但會讓重啟取得新 commit；正式固定版本部署應使用 tag 或自行 Build Dockerfile。

## Request progress logging

The suite uses structured log levels. Reasoning, response text, source code, Tool arguments and Tool results are not logged by default.

| Level | Events |
|---|---|
| `error` | unrecoverable upstream, protocol, buffer, replay, and request failures |
| `warn` | loop detection, cancellation, transport/semantic stalls, Tool growth thresholds, observe-only Tool findings, and failed-request client retries |
| `info` | request lifecycle, Recovery, protected replay, OpenAI Tool passthrough, Tool delivery, and latest-turn Tool Results |
| `debug` | state transitions, exact-request fingerprints, Tool Result history context, and periodic request progress |
| `trace` | upstream chunk metadata; optional redacted and truncated Tool payload previews when explicitly enabled |

Recommended troubleshooting settings:

```yaml
LOG_LEVEL: "debug"
LOG_FORMAT: "text"
PROGRESS_LOG_INTERVAL_MS: "10000"
PROGRESS_STALL_WARNING_MS: "30000"
LOG_TOOL_PAYLOADS: "false"
TOOL_ARGUMENT_WARNING_BYTES: "8192"
TOOL_ARGUMENT_CRITICAL_BYTES: "16384"
TOOL_PASSTHROUGH_OBSERVATION_MAX_BYTES: "65536"
TOOL_CORRELATION_TTL_MS: "900000"
TOOL_CORRELATION_MAX_ENTRIES: "10000"
CLIENT_RETRY_FINGERPRINT_TTL_MS: "900000"
CLIENT_RETRY_FINGERPRINT_MAX_ENTRIES: "10000"
```

Example debug record:

```text
2026-07-19T00:00:00.000Z [debug] event=request_progress service="vllm-openai-proxy" requestId="..." phase="initial" attempt=1 state="tool_passthrough_streaming" elapsedMs=40000 upstreamBytes=18240 streamAverageBytesPerSec=612 recentBytesPerSec=590 upstreamChunks=93 sseEvents=147 reasoningBytes=7412 contentBytes=0 toolNameBytes=4 toolArgumentBytes=128 semanticBytes=7544 toolCallCount=1 toolCallIndexes=[0] toolNames=["Read"] toolArgumentBytesByCall={"choice:0/tool:0":128} toolArgumentFragmentsByCall={"choice:0/tool:0":6} parallelToolCallsDetected=false toolPassthroughCommitted=true toolPassthroughBufferedBytes=4096 finishReason=null doneReceived=false usagePromptTokens=null usageCompletionTokens=null rawBufferedBytes=0 parsedSemanticRetainedBytes=7544 estimatedRequestMemoryBytes=15088 globalBufferedBytes=0 globalBufferUtilizationRatio=0 globalBufferUtilizationPercent=0 lastUpstreamActivityMs=183 lastSemanticActivityMs=183 timeToHeadersMs=12 timeToFirstByteMs=845 timeToFirstSemanticMs=901
```

The counters have distinct meanings:

- `upstreamChunks`: calls to the upstream stream reader. This is transport chunking, not an SSE frame count.
- `sseEvents`: complete protocol events parsed by the active adapter.
- `semanticBytes`: UTF-8 bytes from reasoning, content, Tool names and fragmented Tool arguments only. Metadata, role-only chunks, usage, ping, completion markers and `[DONE]` do not increment it.
- `toolCallCount`: current distinct Tool Calls, not Tool argument fragment count. `toolArgumentFragmentsByCall` reports fragment count separately.
- `parallelToolCallsDetected`: `true` when the current assistant response contains more than one Tool Call.
- `finishReason` / `finishReasonsByChoice`, `doneReceived`, `messageStopped`, `responseCompleted`, and normalized usage fields explain how the upstream attempt terminated.
- `lastUpstreamActivityMs`: time since any upstream bytes arrived.
- `lastSemanticActivityMs`: time since actual semantic bytes increased.
- `rawBufferedBytes`: raw upstream bytes retained for Protected Streaming.
- `parsedSemanticRetainedBytes`: semantic bytes currently retained by protocol parsers; after Tool commit this can be lower than total `semanticBytes`.
- `toolPassthroughCommitted`: `true` after OpenAI crosses the irreversible Tool boundary.
- `toolPassthroughBufferedBytes`: raw bytes flushed when Tool passthrough began.
- `toolPassthroughElapsedMs`: elapsed time since the Tool stream was committed.
- `estimatedRequestMemoryBytes`: diagnostic estimate including raw and parsed data; it is not Node heap accounting.
- `globalBufferUtilizationRatio` and `globalBufferUtilizationPercent`: unambiguous ratio and percentage views; the legacy `globalBufferUtilization` field remains for compatibility.

Request states include:

```text
upstream_connecting
upstream_headers_received
upstream_waiting_first_byte
upstream_streaming
attempt_validating
response_replay_started / response_replay_completed
tool_passthrough_committing
tool_passthrough_streaming
tool_passthrough_completed
```

OpenAI Tool passthrough sequence:

```text
tool_passthrough_started
# raw Tool SSE is already flowing to Client
tool_passthrough_completed
tool_calls_delivered
request_completed mode=tool_passthrough

# Next Hermes request
tool_result_context historyCount=... latestTurnCount=...
tool_results_received count=... parentRequestIds=[...]
```

Protected replay sequence, primarily for Anthropic and OpenAI responses without Tool Calls:

```text
tool_calls_ready
response_replay_started
response_replay_completed
tool_calls_delivered
request_completed
```

`tool_result_context` is a `debug` event: `historyCount` covers the full conversation history, while `latestTurnCount` covers only trailing Tool Result carrier messages in the new request. `tool_results_received` is emitted only when `latestTurnCount > 0`; it no longer republishes every historical Tool Result as a new receipt.

`tool_calls_delivered` means Node emitted `finish` for either protected replay or transparent Tool passthrough. It confirms response bytes were handed to the outgoing stream, but is not an application-level acknowledgement from Hermes. A correlated `tool_results_received` is stronger evidence that Hermes parsed the call, executed the tool, and submitted the next request.

When Tool arguments cross configured thresholds, each attempt/Tool Call emits at most one `tool_argument_growth_warning` and one `tool_argument_growth_critical`. These are diagnostics only; the payload is not logged and the Tool Call is not modified.

Malformed Tool JSON diagnostics include Tool identity, per-call bytes/fragments, `parseErrorCategory`, and explicit parse-offset units without logging the payload. On Anthropic protected paths these remain `retryable:false` failures. On OpenAI transparent Tool paths they are emitted only as `tool_passthrough_validation_warning action=observe_only`; delivery is unchanged. If the retained diagnostic prefix was truncated, the Proxy does not claim the complete Tool JSON is valid or invalid.

Exact byte-identical request retries within the configured TTL emit `client_retry_detected` and increment the protocol metric. `retryDelayAfterTerminalMs`, `previousRequestDurationMs`, and `requestStartIntervalMs` separate the timing semantics; `retryDelayMs` remains a compatibility alias. Only a shortened hash is logged. Semantically similar requests whose bytes changed are intentionally not correlated.

New Prometheus counters include:

```text
vllm_openai_proxy_client_retries_detected_total
vllm_openai_proxy_tool_argument_warnings_total
vllm_openai_proxy_tool_argument_critical_total
vllm_openai_proxy_tool_passthrough_started_total
vllm_openai_proxy_tool_passthrough_completed_total
vllm_openai_proxy_tool_passthrough_interruptions_total
vllm_openai_proxy_tool_passthrough_validation_warnings_total
vllm_cc_proxy_client_retries_detected_total
vllm_cc_proxy_tool_argument_warnings_total
vllm_cc_proxy_tool_argument_critical_total
```

Every logged `request_started` terminates with exactly one of:

```text
request_completed
request_rejected
request_failed
request_cancelled
```

If `LOG_TOOL_PAYLOADS=true`, previews are emitted only at `trace`, are size-limited by `LOG_TOOL_PAYLOAD_MAX_BYTES`, and redact common credential fields. Keep this disabled in normal operation.

