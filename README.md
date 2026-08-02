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
- `/v1/responses` 預設使用 vLLM 原生 `native` 路徑；`chat_adapter` 保留為明確 fallback。
- OpenAI Tool commit 後不阻擋、不修補、不拆分、不重寫 Tool arguments，也不再執行 Recovery；Proxy 只保留有界觀測與計數。
- OpenAI 沒有 Tool Call 的回應仍保留上游原始 response bytes，通過驗證後回放。
- OpenAI Responses 將 `completed`、`incomplete` 與 `failed` 視為協議終止狀態；terminal event、可見 output、refusal 或 Function Call 具有高於 Think Loop 的優先權，合法結果會原樣回放。`incomplete`（包含只有 reasoning 的 `max_output_tokens` 結果）以原始 HTTP 200／SSE bytes 回放，不改寫成 Proxy 錯誤。
- OpenAI Responses 行為 Guard 只在 `RESPONSES_BEHAVIOR_MODE=guarded` 啟用；預設 `transparent` 不因短文字、reasoning-only 或未呼叫工具而自動 Recovery。
- OpenAI Recovery 只在 Tool commit 前使用當次 request 真正提供的網路查詢或下載工具，不預設固定工具名稱。
- OpenAI Chat 的 System Message 契約固定為最多一個且只能位於 `messages[0]`；Proxy 產生 Recovery 時會合併至該開頭訊息，Client 提供中途 System Message 則在進入 vLLM 前回傳明確 `400`。
- Claude Code Tool Recovery 只載入 Anthropic runtime，不會影響 OpenAI API。

## 原生路徑路由

| Client Path | Runtime | 行為 |
|---|---|---|
| `POST /v1/messages` | Anthropic | Messages Guard、Claude Code Tool Recovery；可選 Managed WebSearch／WebFetch 內部 Tool Loop |
| `/v1/messages/count_tokens` | Anthropic | 透明穿透 |
| `POST /v1/chat/completions` | OpenAI | Pre-Tool Think Guard；Tool Call 透明直送 |
| `POST /v1/responses` | OpenAI | 預設原生 Responses passthrough/validation；可選 Chat adapter；Function/Custom Tool 透明直送 |
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
│   │   ├── managed-web-tools.js
│   │   ├── managed-websearch.js  # 相容 re-export
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

`docker-compose.partial.yaml` 用於合併至既有 Compose。它提供 Gateway，以及由 `websearch` profile 控制的 SearXNG backend：

```text
services:
  vllm-proxy-suite
  searxng            # profile: websearch

volumes:
  vllm-proxy-suite
  searxng-config
  searxng-data
```

SearXNG 不發布 host port，只加入既有 `vllm-test-network`。首次啟動會在持久化設定 volume 建立最小 `settings.yml`，沿用預設 engines 並開啟 `html` 與 `json` Search formats。

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

### Claude Code Managed WebSearch／WebFetch

v0.7.3 提供 opt-in Managed Web Tools Layer。單一受管理工具與**同類型平行批次**都由 Proxy 攔截；`WebSearch + WebSearch` 或 `WebFetch + WebFetch` 進入有界內部隊列，混合 Managed/Client Tools 仍整份原樣交回 Claude Code。

v0.7.12 另外處理 Claude Code 產生的 Anthropic Hosted Web Search 子請求。當 request 只帶有：

```json
{
  "type": "web_search_20250305",
  "name": "web_search",
  "max_uses": 8
}
```

Proxy 會在送往 vLLM 前改寫為帶 `input_schema` 的 `web_search` Custom Tool，並由同一個 Managed WebSearch Layer 執行。Hosted-only `type`、`max_uses` 與 domain policy 只存在於 request-local policy，不會送入 vLLM。實際搜尋次數採 `min(max_uses, SEARXNG_MAX_USES)`；Bridge 關閉時，Proxy 會在本地回傳 `anthropic_hosted_web_search_unavailable`、`retryable:false`，不再讓 vLLM 以缺少 `input_schema` 的 400 拒絕。

成功改寫會記錄：

```text
event=anthropic_hosted_web_search_adapted
```

```text
WebSearch
→ SearXNG JSON Search API
→ 正規化 URL／snippet
→ 標準 Anthropic tool_result
→ 內部 vLLM continuation

WebFetch(url, prompt)
→ Content-Aware Router：已知文件副檔名直接 Internal；其他 URL 做一次有界 HEAD Probe
→ HTML／未知 Browser Page：awesome-web-fetch Playwright sidecar
→ PDF／plain text／Markdown／JSON／XML／CSV／TSV／YAML：原有 Internal Fetch
→ sidecar metadata 若判定為非 HTML，只允許 Browser → Internal 回切一次
→ HTML／Text 依字元預算分段；PDF 使用 pdftotext 保留 page break
→ 每段送至 vLLM Chunk Reader 擷取相關事實
→ Document Synthesizer 合併證據
→ 精簡 managed_webfetch_result 回灌主模型
→ 內部 vLLM continuation
```

Managed WebSearch continuation、WebFetch Chunk Reader、Document Synthesizer 與 WebFetch continuation 預設都注入：

```json
{
  "think": false,
  "chat_template_kwargs": {
    "enable_thinking": false
  }
}
```

外層 Claude Code request 不會被全域關閉 thinking；只有 Proxy 內部 Managed Web Tool requests 使用 no-thinking policy。

同類型平行工具採有界隊列：

```text
assistant: WebSearch A + WebSearch B + WebSearch C
→ Proxy queue，最多 WEBSEARCH_MAX_PARALLEL 筆同時執行
→ 只有確認第一個 Managed Tool 開始後才建立 Anthropic progress lifecycle
→ 前台顯示清理後的搜尋關鍵字，並每 5 秒追加省略號
→ 任一項完成即顯示完成狀態並保存對應 tool_result
→ 其他項目繼續執行
→ 全部 tool_use_id 都有結果後，以單一 user tool_result turn 做 continuation
```

`WebFetch` 使用相同排程，但每一項可能包含下載、Chunk Reader 與 Synthesizer，因此由 `WEBFETCH_MAX_PARALLEL` 獨立限制。Search 與 Fetch 的使用上限分別追蹤：WebFetch 達上限只移除 Fetch，後續 WebSearch 仍可繼續；WebSearch 達上限只移除 Search，後續 WebFetch 仍可繼續。若模型在某一種類已達上限並從 `tools[]` 移除後仍再次呼叫同一種類，Proxy 立即以 `managed_web_tool_limit_repeated`、`retryable:false` 熔斷；尚未送出回應標頭時使用 HTTP `422`，若 Managed SSE progress 已開始則在既有 stream 送出同型別 `event:error`。兩種路徑都會記錄 `client_retry_suppressed`，不再產生額外模型請求，也不把該 Tool Call 洩漏給 Claude Code。Proxy 不會把內部 `tool_result` 暴露給 Claude Code，也不會顯示成 `Search(...)` 工具列。只有確定進入 Managed WebSearch／WebFetch 後才建立 synthetic `message_start`；普通 Bash、Read、Write 或純文字回應維持原始 Anthropic stream，不會多出空白 `●`。WebSearch 預設顯示清理後的 query；WebFetch 只顯示 hostname，不顯示 URL path、query string、token、Cookie、snippet 或正文。週期性可見 `text_delta` 會持續追加省略號，最後將 vLLM SSE content block index 平移並 splice 到同一 lifecycle。Progress block 以不可見 sentinel 標記，下一輪送往 vLLM 前會整塊移除，避免污染模型歷史與 prefix cache。Anthropic Tool ID 配對仍要求同一 assistant turn 的所有結果齊備後才能安全 continuation。因 synthetic `message_start` 必須在取得 upstream usage 前送出，Claude Code 端的 `usage.input_tokens` 會是 `0`；Proxy Log 仍保留 vLLM 最終回報的實際 token usage。

啟用內建 SearXNG 與兩個 Bridge：

```bash
export CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED=true
export CLAUDE_CODE_WEBFETCH_BRIDGE_ENABLED=true
export MANAGED_WEB_TOOLS_THINK=false
export MANAGED_WEB_STREAM_PROGRESS_MODE=visible
export MANAGED_WEB_STREAM_PROGRESS_DETAIL=query
export MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS=5000
export SEARXNG_SECRET='replace-with-a-long-random-secret'

docker compose --profile websearch up -d searxng vllm-proxy-suite
```

若只使用 WebFetch，不需要啟動 SearXNG：

```bash
export CLAUDE_CODE_WEBFETCH_BRIDGE_ENABLED=true
docker compose up -d vllm-proxy-suite
```

若 HTML 頁面要改由 `awesome-web-fetch` 模擬瀏覽器讀取，啟用同一份 Compose 的 sidecar profile：

```bash
export CLAUDE_CODE_WEBFETCH_BRIDGE_ENABLED=true
export WEBFETCH_HTML_PROVIDER=awesome-web-fetch
export AWESOME_WEB_FETCH_API_KEY='replace-with-a-long-random-sidecar-key'

docker compose --profile webfetch-browser up -d --build awesome-web-fetch vllm-proxy-suite
```

`WEBFETCH_HTML_PROVIDER` 預設為 `internal`，因此升級不會自動改變既有 Fetch 行為。Browser Sidecar 只負責 HTML／JavaScript 頁面；PDF 與文字／結構化文件仍使用 Proxy 原有抓取與解析路徑。

WebFetch 需要 `url` 與 `prompt`。模型若產生空 `{}` 或缺少欄位，Proxy 會在內部建立 `is_error:true` tool_result，讓模型自行重試或降級，不再把無效 WebFetch 交給 Claude Code。

支援內容：

- HTML／XHTML：`WEBFETCH_HTML_PROVIDER=awesome-web-fetch` 時使用 Playwright Sidecar；否則使用 Internal Fetch。
- Plain text、Markdown、JSON、XML、CSV、TSV、YAML 與 log：使用 Internal Fetch。
- PDF：使用 Internal Fetch 與 `pdftotext -layout`，保留 form-feed page boundary。

Sidecar 回應使用 `page_content` 與 metadata。Proxy 會讀取 `source`、`final_url`、`title`、`content_type`、`status_code`、`browser_rendered`；額外 metadata 保留為不受信任的 provider 資料，不直接寫入主模型結果。Sidecar metadata 若指出 PDF／文字文件，Proxy 只允許一次 Browser → Internal reroute。Internal 路徑不會再回到 Browser，Sidecar HTTP 失敗也不會改用 Direct HTML GET。

安全限制包括：

- 僅允許 HTTP／HTTPS。
- 禁止 URL credentials。
- 每次 redirect 都重新解析 DNS 並拒絕 loopback、RFC1918、link-local、metadata、ULA、multicast 與保留位址。
- 限制 redirect、download bytes、extracted chars、PDF pages、reader chunks、model response 與最終 tool_result bytes。
- 文件內容一律標記為 untrusted external data；Reader 不得執行頁面內指令。
- 不偽造 Anthropic `server_tool_use`、`web_search_tool_result`、encrypted content 或 native citation blocks。


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

### Responses upstream 模式

Codex 對外固定使用：

```text
POST /v1/responses
```

Proxy 提供兩種 upstream mode：

```text
native（預設）
Codex Responses
→ Proxy protocol/transport observation
→ vLLM /v1/responses
→ Responses protocol normalization/replay

chat_adapter（明確 fallback）
Codex Responses
→ Proxy request normalization
→ vLLM /v1/chat/completions
→ Proxy Responses JSON/SSE encoder
→ Codex
```

預設設定：

```env
VLLM_PROXY_RESPONSES_UPSTREAM_MODE=native
VLLM_PROXY_RESPONSES_BEHAVIOR_MODE=transparent
VLLM_PROXY_RESPONSES_TOOL_CHOICE_POLICY=preserve
```

只有在目標 vLLM 原生 Responses 不可用或需要 A/B 比較時，才切換：

```env
VLLM_PROXY_RESPONSES_UPSTREAM_MODE=chat_adapter
```

`chat_adapter` 支援：

- stream 與 non-stream。
- `instructions`、developer/system/user/assistant message history。
- user `input_text` 與 `input_image`，後者轉為 Chat `image_url`。
- Function tools、Custom tools、Namespace tools。
- Codex Responses Lite `additional_tools`，會正規化並合併至可呼叫工具集合。
- `function_call`／`function_call_output` 與 `custom_tool_call`／`custom_tool_call_output` history。
- `tool_choice=auto|required|none` 與指定 Function。
- `parallel_tool_calls`、`max_output_tokens`、temperature、top-p、seed、reasoning effort、JSON response format。
- Chat reasoning/content/Tool Call/usage 轉回 Responses lifecycle。
- Chat `finish_reason=length` 轉為 `response.incomplete`，reason 為 `max_output_tokens`。
- Custom Tool 在第一個 Chat Tool fragment 即建立 `custom_tool_call` item，讓 Tool passthrough 不必等待完整 freeform input。

`chat_adapter` 會在接觸 vLLM 前，以明確 HTTP 400 拒絕無法安全降級的功能，包括：

- `previous_response_id`。
- `background=true`。
- `store=true`。
- 明確要求且無法由 Client 執行的 hosted web/file search、Code Interpreter、Computer Use、Image Generation 等工具。可選 Hosted Tool 預設會被過濾，不會拒絕整個 Codex request。
- 尚未映射的 specialized input item，例如 compaction、shell/local-shell、hosted MCP lifecycle item。
- 未支援的 content block。

需要上述原生 Responses 功能時，改用 `native`；不要在已開始生成後自動 fallback，以避免重複 Tool action。


### Responses behavior 模式

Codex 路徑預設採透明行為模式：

```env
VLLM_PROXY_RESPONSES_BEHAVIOR_MODE=transparent
```

`transparent` 只負責協議與傳輸，不替模型決定是否應繼續工作。以下結果都會原樣交付 Codex：

- reasoning-only `response.completed`。
- 有文字但沒有 Tool Call 的完成回應。
- 短完成宣告、執行敘述或模型自行回報的工具狀態。
- 可被解析的 `response.incomplete`／`response.completed` terminal。

透明模式不執行：

- Responses Think Loop classification。
- `reasoning_without_output` rejection。
- Actionless Completion Recovery。
- forced-tool Recovery validation。
- malformed required-tool automatic retry。

仍保留：Chat↔Responses conversion、Hosted Tool filtering、Tool passthrough、格式解析、認證、request/body/buffer limits、timeout、client cancellation 與 observability。

需要重現舊行為作 A/B 排障時：

```env
VLLM_PROXY_RESPONSES_BEHAVIOR_MODE=guarded
```

`ACTIONLESS_COMPLETION_GUARD_ENABLED`、`MAX_RECOVERY_ATTEMPTS` 與 malformed-tool retry 設定只在 `guarded` 模式生效。OpenAI Chat Completions 與 Anthropic／Claude Code runtime 不受此 Responses 專用模式影響。

### Responses Tool Choice Policy

預設保留 Codex 原始工具選擇：

```env
VLLM_PROXY_RESPONSES_TOOL_CHOICE_POLICY=preserve
```

可選值：

| 值 | 行為 |
|---|---|
| `preserve` | 不改寫 `tool_choice`；這是預設，也是最接近 vLLM 原生 Responses 的模式 |
| `required_on_explicit_continue` | 只有最新有效輸入是短而明確的 user「開始／繼續」指令、存在可用工具，且原始選擇為 `auto`／未指定時，才將 upstream `tool_choice` 改為 `required` |

`required_on_explicit_continue` 不會改寫：

- `function_call_output`／`custom_tool_call_output` Tool Result 回合。
- 沒有工具的請求。
- Client 明確指定的 `none`、`required` 或特定 Function。
- 一般長任務描述、技術問答或完成摘要。

它是 request-side 約束，不是 response Guard：不丟棄生成、不追加 Recovery，也不產生第二次 upstream request。啟用範例：

```env
VLLM_PROXY_RESPONSES_UPSTREAM_MODE=native
VLLM_PROXY_RESPONSES_BEHAVIOR_MODE=transparent
VLLM_PROXY_RESPONSES_TOOL_CHOICE_POLICY=required_on_explicit_continue
```

### Hosted Tool Policy

Codex 可能在一般 Responses request 中自動附帶 `web_search`。`chat_adapter` 無法替 OpenAI 執行 Hosted Tool，因此預設使用：

```env
VLLM_PROXY_RESPONSES_HOSTED_TOOL_POLICY=drop_optional
```

Policy：

| 值 | 行為 |
|---|---|
| `drop_optional` | `auto`／未指定時過濾不支援的 Hosted Tools，保留 function/custom/namespace tools 並繼續請求 |
| `reject` | 只要看到不支援 Hosted Tool 就回 HTTP 400 |
| `native_only` | 回 `hosted_tool_requires_native_mode`，要求改用 native Responses |

`tool_choice="required"` 在仍有 Client Tool 時會過濾 Hosted Tools後繼續；若只剩 Hosted Tool，或 `tool_choice` 明確指定 `web_search`，Proxy 回：

```text
required_hosted_tool_unavailable
retryable=false
```

`allowed_tools` 也會同步過濾。`mode="auto"` 且過濾後為空時，Proxy 移除空的 `tools`／`tool_choice`，避免 vLLM Chat API 因空工具控制欄位拒絕請求；`mode="required"` 且沒有可執行 Client Tool 時則明確拒絕。

Proxy 不會把 Hosted `web_search` 偽裝成一般 Function Tool，因為 Codex Client 沒有對應的 Hosted Tool executor。

### Malformed required-tool retry

Actionless Completion Recovery 或原始 `tool_choice="required"` 可能讓模型進入工具路徑，但 vLLM Tool parser 仍可能回：

```text
BadRequestError: Unterminated string ...
```

`guarded` behavior 模式下，`chat_adapter` 可做一次受限重試；預設 `transparent` 模式不執行此重試：

```env
VLLM_PROXY_RESPONSES_MALFORMED_TOOL_RETRY_ENABLED=true
VLLM_PROXY_RESPONSES_MALFORMED_TOOL_RECOVERY_MIN_TOKENS=1024
VLLM_PROXY_RESPONSES_MALFORMED_TOOL_RECOVERY_TEMPERATURE_MAX=0.1
```

重試會：

- 保持 `tool_choice="required"`；只有一個工具時改為明確指定該 Function。
- 設定 `parallel_tool_calls=false`。
- 要求完整且符合 schema 的小型 JSON arguments，不先塞入完整報告、大檔案或大型 patch。
- 將 Tool output budget 至少提高到設定值，並降低 temperature。

第二次仍被 vLLM parser 拒絕時立即熔斷：

```text
malformed_required_tool_arguments
retryable=false
```

不會再進行第三次 Tool retry，也不會回傳巢狀的 generic `upstream_http_error`。

### Responses API 終止狀態

`POST /v1/responses` 支援 stream 與 non-stream。Proxy 接受並保留以下合法終止狀態：

```text
response.completed
response.incomplete
response.failed
```

vLLM 也可能以 `response.completed` 事件攜帶 `response.status="incomplete"`。Proxy 以 response object 的實際 status 為準，因此下列情況會原樣回傳 HTTP 200，不會產生 `reasoning_without_output`：

```text
status="incomplete"
incomplete_details.reason="max_output_tokens"
只有 reasoning，尚未產生 output_text 或 Tool Call
```

Client 應依 `status` 與 `incomplete_details` 決定是否提高 `max_output_tokens`、縮短任務或續接處理。`status="failed"` 與明確 upstream error 仍由 Proxy 視為失敗。

Proxy 解析並觀測官方 Responses done/final events，包括 reasoning、summary、output text、refusal 與 function-call arguments；即使沒有先行 delta，terminal response 的完整 `output[]` 仍可作為權威結果。

只有 `RESPONSES_BEHAVIOR_MODE=guarded` 時，Responses Think Loop Guard 才會在模型仍處於純 reasoning、尚未產生 output/refusal/Function Call、且尚未收到 terminal event 時啟用。一旦任一 action boundary 出現，後續 reasoning 即使包含重複片段，也不能覆蓋合法 `response.completed`。這可避免 Codex 已有完整 terminal event，Proxy 卻丟棄它並造成 `stream closed before response.completed`。

### Responses Actionless Completion Guard

此 Guard 與 Think Loop 分離，只處理以下完整條件：

```text
response.status="completed"
request tools[] 非空
tool_choice 不是 none
回應沒有 Function Call
回應文字以第一人稱承諾立即開始／建立／執行等工作
```

初次命中時，Proxy 丟棄該段進度宣告並進行一次策略型 Recovery：

```text
保留原 tools[]
tool_choice="required"
parallel_tool_calls=false
要求立即呼叫一個適當工具
禁止在工具前再次輸出進度宣告
```

若 Recovery 仍只輸出文字而沒有工具，Proxy 回傳：

```text
reason="actionless_completion"
retryable=false
```

下列情況不會觸發：沒有工具、`tool_choice="none"`、`status="incomplete"`／`cancelled`、已產生 Function Call、正常最終答案，以及不含第一人稱執行承諾的一般步驟說明。可用 `ACTIONLESS_COMPLETION_GUARD_ENABLED=false` 停用。

## Loop Guard 與 OpenAI Tool Passthrough

### Anthropic／無 Tool 的 OpenAI 回應

```text
Upstream Attempt
→ 完整緩衝與增量解析
→ OpenAI Responses：只在 pre-action reasoning 階段執行 Loop Guard
→ terminal/output/refusal/Function Call 出現後關閉 Loop Guard
→ 結構／容量／語意驗證
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

## Claude Code Action-Intent Guard

此 Guard 與 Think Loop、Claude Code 檔案 Tool Recovery 分離，只處理以下完整條件：

```text
stop_reason="end_turn"
request tools[] 非空
tool_choice 不是 none
回應沒有 tool_use
可見文字是第一人稱立即執行宣告
```

典型命中內容包括：

```text
好的，我開始執行階段 1。先查看當前目錄結構。
我繼續執行，先檢查目前狀態。
I am starting the implementation now.
Let me inspect the workspace first.
憑證已存在。讓我測試 server。
Let me test the TLS server now.
```

初次命中時，Proxy 丟棄整份 narration Attempt，只使用既有單一 Recovery slot：

```text
保留原 tools[]
tool_choice={type:"any",disable_parallel_tool_use:true}
要求立即產生 Tool Call
禁止再次只輸出進度宣告
```

若 Action-Required Recovery 仍沒有 Tool Call，包括只剩 Thinking、只輸出文字、格式錯誤或 upstream 中斷，Proxy 會在單一 Recovery slot 後熔斷：

```text
reason="action_intent_without_tool_call"
retryable=false
HTTP status=422
```

Action-Required Recovery 最多只執行一次。第二次仍未產生有效 Tool Call 時，Proxy 不會進行第三次上游請求，並以 HTTP `422` 回傳 `retryable=false`；此非 5xx 狀態用來避免 Claude Code 將已熔斷的語意失敗再展開成 `attempt 1/10` 客戶端重試。日誌同時記錄 `client_retry_suppressed`。

`thinking_without_output` 使用另一條 **Output-Required Recovery**，不代表本回合一定需要工具：

```text
保留原 tools[]
保留原 tool_choice；auto 仍為 auto
允許正常回答、解釋、規劃、完成報告、等待確認、必要提問或 Tool Call
禁止再次只輸出 Thinking
```

因此短指令 `繼續`、`開始`、`proceed` 或 `go ahead` 不會再單獨觸發強制 Tool Call。若第二次仍只有 Thinking，Proxy 保留 `reason="thinking_without_output"` 並回傳 `retryable=false`，避免 Claude Code 反覆重送；若 Recovery 產生有效可見文字，則正常交付給使用者。一般規劃、步驟說明、完成報告與等待使用者確認均屬合法文字輸出。可用 `CLAUDE_CODE_ACTION_INTENT_GUARD_ENABLED=false` 停用 Action-Intent Guard；Output-Required Recovery 仍屬通用輸出完整性處理。

當最新輸入是 Claude Code `tool_result`，而模型只輸出精確佔位文字 `No response`、`No output`、`無回應`、`沒有回應`、`無輸出` 或 `沒有輸出` 並以 `end_turn` 結束時，Proxy 將其分類為 `placeholder_completion_without_progress`。完整句子（例如 `No response was received from the server.`）、一般短回答及非 Tool Result 回合不會命中。

初次命中會丟棄佔位 Attempt，使用同一個 Output-Required Recovery slot，保留原 `tools[]` 與 `tool_choice`；`auto` 仍為 `auto`。Recovery 可產生實質文字、適當 Tool Call 或一個真正阻塞問題。若第二次仍是佔位文字，Proxy 回傳同一原因且 `retryable=false`，避免 Claude Code 進入 API retry cascade。可用 `CLAUDE_CODE_PLACEHOLDER_COMPLETION_GUARD_ENABLED=false` 停用此 Guard。

### Universal Tool Input Schema Guard

每個尚未交付給 Claude Code 的 Anthropic Tool Call，都會先以本次 request 的 `tools[].input_schema` 驗證。這項檢查不限於 `Read`、`Edit`、`Write` 或 `NotebookEdit`；`TaskUpdate`、`TaskCreate`、MCP Tool 與其他動態 Tool 也使用相同規則。

目前遞迴驗證：

```text
required
type
enum / const
nested object properties
array items
additionalProperties:false
```

例如模型輸出 `TaskUpdate({"status":"completed"})`，但本次 Tool Schema 要求 `taskId`，Proxy 會在 replay 前將該 Attempt 分類為 `invalid_tool_input_schema`，不會讓 Claude Code 執行後才產生 `InputValidationError`。

Schema Recovery 依可確定性分流：

- 若錯誤是單一 `additionalProperties:false` 違規，且只移除該欄位後其餘輸入已完全符合 Schema，Proxy 進入 `schema_correction`。Recovery 只保留原 Tool，強制 `tool_choice={type:"tool",name:<tool>,disable_parallel_tool_use:true}`，並使用縮減後的一則訊息上下文。修正後參數必須與原參數完全相同，只能刪除該不允許欄位。
- 若缺少 `taskId`／路徑／外部識別碼、有多個不允許欄位，或刪除一個欄位後仍不合法，維持 generic Output-Required Recovery，保留完整 `tools[]` 與原始 `tool_choice`；`auto` 仍為 `auto`。Recovery 不會猜測缺失資料，可先呼叫 `TaskList`／其他讀取型 Tool。

第二次仍無法產生符合契約的結果時，Proxy 保留 `reason="invalid_tool_input_schema"` 並回傳 `retryable=false`。

Lifecycle：

```text
tool_input_schema_correction_started
tool_input_schema_correction_completed
tool_input_schema_correction_fused
tool_input_schema_recovery_started
tool_input_schema_recovery_fused
```

可用 `CLAUDE_CODE_TARGETED_SCHEMA_CORRECTION_ENABLED=false` 單獨停用精準修正並退回 generic Recovery；`CLAUDE_CODE_TOOL_INPUT_SCHEMA_GUARD_ENABLED=false` 則停用整個 Guard。未知或未支援的 JSON Schema 關鍵字採保守忽略；`$ref` 與複合 Schema 不會被 Proxy 猜測展開。

當模型已產生完整 `tool_use` block，但錯誤以 `stop_reason="end_turn"` 結束時，Proxy 不會直接忽略協議矛盾。只有在所有 Tool Call JSON 完整、Tool 名稱存在於本次 `tools[]`，且輸入通過該 Tool 的 `input_schema` 後，才會將實際 SSE／JSON 的 `end_turn` 正規化為 `tool_use` 並繼續既有語意驗證與 Recovery target 驗證。未知 Tool、缺少必要欄位、型別錯誤、Malformed JSON、未閉合 block 或失敗終止都不會被正規化。成功時記錄 `tool_stop_reason_normalized`；可用 `CLAUDE_CODE_TOOL_STOP_REASON_NORMALIZATION_ENABLED=false` 恢復嚴格拒絕。

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

### Targetless Invalid Tool Recovery

當 mutation Tool 的輸入不符合本次 `input_schema`，Proxy 先依是否具有精確目標分流：

```text
有 file_path／notebook_path
→ 既有 exact-target Recovery
→ 鎖定 Read 或原 mutation Tool 與目標路徑

沒有精確目標，例如 Write({})
→ generic Output-Required Recovery
→ 保留完整 tools[]
→ 保留原 tool_choice；auto 仍為 auto
```

Targetless Recovery 不假設模型一定應該再次呼叫 `Write`、`Edit` 或 `NotebookEdit`。它允許模型根據原始任務與已接受 Tool Result，輸出實質文字、完整有效的 Tool Call，或一個真正阻塞問題；同時禁止重複空白或不完整 Tool Call。第二次仍產生 targetless invalid mutation 時，Proxy 保留 `reason="invalid_claude_code_tool_input"` 並回傳 `retryable=false`，不再讓 Recovery Builder 因缺少路徑拋出 `recovery_build_failed`。

Lifecycle：

```text
targetless_tool_recovery_started
targetless_tool_recovery_fused
```

此能力由既有 `CLAUDE_CODE_TOOL_RECOVERY_ENABLED` 控制，不新增獨立開關。

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
| `LOOP_MIN_PATTERN_SIZE` | `24` |
| `LOOP_MAX_PATTERN_SIZE` | `2048` |
| `LOOP_MIN_COUNT` | `3`，exact／normalized／ABAB 三種偵測都必須達到此重複次數 |
| `LOOP_REASONING_CHAR_LIMIT` | `24000` |
| `RESPONSES_UPSTREAM_MODE` | `native`；可設為 `chat_adapter`。Compose 對外變數為 `VLLM_PROXY_RESPONSES_UPSTREAM_MODE` |
| `RESPONSES_BEHAVIOR_MODE` | `transparent`；設為 `guarded` 才啟用 Responses 行為判定與 Recovery |
| `RESPONSES_TOOL_CHOICE_POLICY` | `preserve`；可設為 `required_on_explicit_continue` |
| `ACTIONLESS_COMPLETION_GUARD_ENABLED` | `true`，但只在 `RESPONSES_BEHAVIOR_MODE=guarded` 時生效 |
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

`LOOP_MIN_COUNT` 的 production 預設為 `3`；兩次自然重複不再直接構成 Think Loop。`TOOL_ARGUMENT_WARNING_BYTES` 與 `TOOL_ARGUMENT_CRITICAL_BYTES` 只發出診斷事件，不會截斷或改寫 Tool arguments。`MAX_TOOL_ARGUMENT_BYTES` 仍用於受保護的驗證路徑；OpenAI Tool Call 一旦 commit，任何大小或 JSON 狀態都只能 observe-only，不能撤銷已送出的 stream。`TOOL_PASSTHROUGH_OBSERVATION_MAX_BYTES` 只限制 Proxy 內部保留的 arguments 前綴，總 byte／fragment counters 仍精確。Client retry fingerprint 使用 path 與原始 request body 的精確 SHA-256；只辨識 byte-identical retry，不會對相似 prompt 做模糊比對。

### Claude Code Managed WebSearch／WebFetch

| 變數 | 預設 |
|---|---:|
| `CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED` | `false` |
| `CLAUDE_CODE_WEBSEARCH_TOOL_NAMES` | `WebSearch`；Hosted `web_search_20250305` 會自動加入 request-local `web_search` alias，不需修改此變數 |
| `SEARXNG_VERSION` | `latest`；只供 Compose `websearch` profile 的內建 service 使用 |
| `SEARXNG_SECRET` | 空；內建 service 首次建立設定時自動產生並持久化，正式環境可自行指定 |
| `SEARXNG_BASE_URL` | Runtime 預設空；Compose 內建 service 使用 `http://searxng:8080` |
| `SEARXNG_TIMEOUT_MS` | `10000` |
| `SEARXNG_MAX_USES` | `5` |
| `SEARXNG_MAX_RESULTS` | `8` |
| `SEARXNG_MAX_RESULT_BYTES` | `16384` |
| `SEARXNG_MAX_RESPONSE_BYTES` | `2097152` |
| `SEARXNG_MAX_QUERY_CHARS` | `1024` |
| `SEARXNG_MAX_TITLE_CHARS` | `300` |
| `SEARXNG_MAX_SNIPPET_CHARS` | `600` |
| `SEARXNG_LANGUAGE` | `all` |
| `SEARXNG_CATEGORIES` | `general` |
| `SEARXNG_SAFE_SEARCH` | `0` |
| `CLAUDE_CODE_WEBFETCH_BRIDGE_ENABLED` | `false` |
| `CLAUDE_CODE_WEBFETCH_TOOL_NAMES` | `WebFetch` |
| `MANAGED_WEB_TOOLS_THINK` | `false`；Managed Search/Fetch 內部 vLLM request 使用 `think:false` |
| `MANAGED_WEB_TOOLS_MAX_BATCH` | `8`；單一 assistant turn 可由 Proxy 管理的同類工具上限，超出項目回內部 error result |
| `MANAGED_WEB_STREAM_PROGRESS_MODE` | `visible`；可設 `minimal`、`invisible`、`off` |
| `MANAGED_WEB_STREAM_PROGRESS_DETAIL` | `query`；可設 `tool`，只顯示工具類型 |
| `MANAGED_WEB_STREAM_PROGRESS_INTERVAL_MS` | `5000`；可見或不可見有效 `text_delta` 週期，防止 Claude Code idle watchdog |
| `MANAGED_WEB_STREAM_PROGRESS_MAX_LABEL_CHARS` | `160`；搜尋關鍵字前台顯示上限 |
| `MANAGED_WEB_STREAM_PROGRESS_MAX_DOTS` | `12`；每行省略號數量，達上限後換行繼續 |
| `WEBSEARCH_MAX_PARALLEL` | `2`；WebSearch 隊列最大同時執行數 |
| `WEBFETCH_MAX_PARALLEL` | `2`；WebFetch 文件工作最大同時執行數 |
| `WEBFETCH_HTML_PROVIDER` | `internal`；可設 `awesome-web-fetch`，只替換 HTML／Browser Page 取得層 |
| `WEBFETCH_PROBE_TIMEOUT_MS` | `5000`；extensionless URL 的有界 HEAD 分類時間 |
| `AWESOME_WEB_FETCH_BASE_URL` | Runtime 預設空；Compose 使用 `http://awesome-web-fetch:3000` |
| `AWESOME_WEB_FETCH_PATH` | `/` |
| `AWESOME_WEB_FETCH_API_KEY` | 空；Compose sidecar 與 Proxy 必須使用相同強密鑰 |
| `AWESOME_WEB_FETCH_TIMEOUT_MS` | `90000` |
| `AWESOME_WEB_FETCH_MAX_RESPONSE_BYTES` | `8388608` |
| `AWESOME_WEB_FETCH_BUILD_CONTEXT` | `https://github.com/ericli1018/awesome-web-fetch.git#main`；只供 Compose build |
| `AWESOME_WEB_FETCH_IMAGE` | `awesome-web-fetch:local`；只供 Compose build/tag |
| `WEBFETCH_TIMEOUT_MS` | `20000`；Internal 文件下載 timeout |
| `WEBFETCH_MAX_USES` | `3` |
| `WEBFETCH_MAX_REDIRECTS` | `5` |
| `WEBFETCH_MAX_DOWNLOAD_BYTES` | `20971520` |
| `WEBFETCH_MAX_EXTRACTED_CHARS` | `2000000` |
| `WEBFETCH_MAX_PROMPT_CHARS` | `4000` |
| `WEBFETCH_READER_CHUNK_CHARS` | `18000` |
| `WEBFETCH_READER_CHUNK_OVERLAP_CHARS` | `600` |
| `WEBFETCH_READER_MAX_CHUNKS` | `32` |
| `WEBFETCH_PDF_PAGES_PER_CHUNK` | `1`；預設逐頁讀取，可提高以降低呼叫次數 |
| `WEBFETCH_PDF_MAX_PAGES` | `100` |
| `WEBFETCH_PDF_EXTRACT_TIMEOUT_MS` | `30000` |
| `WEBFETCH_READER_MAX_TOKENS` | `800` |
| `WEBFETCH_SYNTHESIS_MAX_TOKENS` | `1600` |
| `WEBFETCH_SYNTHESIS_INPUT_MAX_CHARS` | `200000` |
| `WEBFETCH_RESULT_MAX_BYTES` | `65536` |
| `WEBFETCH_MODEL_TIMEOUT_MS` | `180000` |
| `WEBFETCH_MODEL_RESPONSE_MAX_BYTES` | `1048576` |

### Claude Code Recovery

| 變數 | 預設 |
|---|---:|
| `CLAUDE_CODE_TOOL_RECOVERY_ENABLED` | `true` |
| `CLAUDE_CODE_ACTION_INTENT_GUARD_ENABLED` | `true`；阻擋立即行動宣告後無 Tool Call 的 `end_turn` |
| `CLAUDE_CODE_PLACEHOLDER_COMPLETION_GUARD_ENABLED` | `true`；阻擋 Tool Result 後只有 `No response`／`No output` 類佔位內容的 `end_turn` |
| `CLAUDE_CODE_TOOL_INPUT_SCHEMA_GUARD_ENABLED` | `true`；所有 Anthropic Tool Call 在 replay 前依本次 `input_schema` 驗證 |
| `CLAUDE_CODE_TARGETED_SCHEMA_CORRECTION_ENABLED` | `true`；單一可安全移除的額外欄位使用強制原 Tool 的縮減上下文修正 |
| `CLAUDE_CODE_TOOL_STOP_REASON_NORMALIZATION_ENABLED` | `true`；僅將完整且 schema-valid Tool Call 的錯誤 `end_turn` 改寫為 `tool_use` |
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
- `native` 模式下，`/v1/responses` 未辨識的新事件會保留在原始 SSE bytes，但不一定計入語意進度。
- `chat_adapter` 是明確的 Text/Image + Client Tool 相容層，不等同完整 OpenAI hosted Responses runtime；不支援項目會在 upstream 前回傳 400。
- 詳細限制見 `docs/known-limitations.md`。
- 尚未在本環境完成真實 Claude Code → Gateway → vLLM → SearXNG 整合；測試使用 deterministic mock upstream。

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
LOOP_MIN_COUNT: "3"
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

