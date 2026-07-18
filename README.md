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
- 共用 Loop Detector、完整 Attempt 緩衝、Timeout、Cancellation 與 Recovery 控制。
- 正常成功回應保留上游原始 response bytes。
- Loop 或結構錯誤發生時，整份失敗 Attempt 丟棄；失敗 Thinking、Text 與 Tool Call 不會外洩或成為任務進度。
- 最多執行一次 Recovery。
- OpenAI Recovery 只使用當次 request 真正提供的網路查詢或下載工具，不預設固定工具名稱。
- Claude Code Tool Recovery 只載入 Anthropic runtime，不會影響 OpenAI API。

## 原生路徑路由

| Client Path | Runtime | 行為 |
|---|---|---|
| `POST /v1/messages` | Anthropic | Messages Guard、Loop Recovery、Claude Code Tool Recovery |
| `/v1/messages/count_tokens` | Anthropic | 透明穿透 |
| `POST /v1/chat/completions` | OpenAI | Chat Completions Guard |
| `POST /v1/responses` | OpenAI | Responses Guard |
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

第一次啟動會 `git clone`；named volume 已有 Repository 時會執行：

```text
git -C /app pull --ff-only origin <ref>
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

## Loop Guard

受保護端點採 Protected Streaming：

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

因此 Client 不會即時取得第一輪正式 token；這是確保錯誤輸出可完全撤銷的必要取捨。

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
| `MAX_RESPONSE_BUFFER_BYTES` | `33554432` |
| `MAX_TOTAL_BUFFERED_BYTES` | `1073741824`，每個 protocol runtime 各自計算 |

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

- Protected Streaming 增加首個正式 token 的延遲。
- 兩個 protocol runtime 共用同一個 Node.js heap；任一模組造成 process-level OOM 都會影響整套服務。
- 兩個 runtime 的 Buffer Budget 與 active-request counter 仍各自獨立，因此 `MAX_TOTAL_BUFFERED_BYTES` 是每個 runtime 的限制，不是整個 process 的合計限制。
- `/v1/responses` 未辨識的新事件會保留在原始 SSE bytes，但不一定計入語意進度。
- 尚未在本環境完成真實 Claude Code → Gateway → vLLM 與 OpenAI SDK → Gateway → vLLM 整合。

## 安全與部署

- 不要使用 Compose 中的預設範例 Key。
- 建議由外層 TLS Terminator／Ingress 提供 HTTPS。
- 不要向不可信網路直接暴露 vLLM port。
- Runtime Git 更新模式方便單機維護，但會讓重啟取得新 commit；正式固定版本部署應使用 tag 或自行 Build Dockerfile。
