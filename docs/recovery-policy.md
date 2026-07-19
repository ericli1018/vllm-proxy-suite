# Recovery Policy

## Attempt lifecycle

```text
ORIGINAL_ATTEMPT
├── VALID → COMMIT RAW RESPONSE
└── INVALID／LOOP／INTERRUPTED
    ├── RECOVERABLE AND ATTEMPTS AVAILABLE → RECOVERY_ATTEMPT
    │   ├── VALID → COMMIT RECOVERY RAW RESPONSE
    │   └── INVALID → PROTOCOL ERROR
    └── NOT RECOVERABLE → PROTOCOL ERROR
```

`MAX_RECOVERY_ATTEMPTS` 被限制為 `0` 或 `1`。Recovery 永遠由原始 request 與已接受的歷史 Tool Result 建立，不把失敗 Attempt 寫回 context。

## OpenAI network capability

Tool classifier 不依賴固定產品名稱。明確 exact-name 設定具有最高優先權；否則使用名稱、描述與 parameter schema 的網路語意進行保守分類，並排除 local filesystem、repository、database、shell 等能力。

找不到可用工具時，Recovery 保留原始工具集合，不生成不存在的 function name。

## Claude Code file-tool recovery

此政策只存在於 Anthropic service。`tools[]` 與 `input_schema` 是執行期權威。

第一輪與 Recovery 輸出在 raw replay 前都會檢查：

- `Edit` 是否為 `old_string === new_string`。
- Mutation arguments 是否完整重送已由 `tool_result.is_error:true` 證明失敗的 canonical call。
- `Read`、`Edit`、`Write`、`NotebookEdit` arguments 是否符合 required、primitive type、enum 與 const 約束。
- Tool target 是否可精確辨識。

Read freshness 依 accepted history 追蹤。任何 failed mutation 會使該 target 的先前 Read 失效；任何 Bash Tool Result 會依預設設定清除全部 Read freshness。

沒有新鮮 target evidence 時，Recovery 只允許精確 `Read`。已有新鮮 evidence 時，Recovery 只允許原 mutation tool，並鎖定 target、禁止 no-op、禁止 `replace_all` 擴張及原參數重送。

## Deterministic Tool JSON failures

The generic Recovery path does not retry deterministic Tool structure failures:

```text
malformed_tool_arguments
malformed_tool_json
invalid_tool_arguments
invalid_tool_input
tool_argument_limit
too_many_tool_calls
```

These failures return `retryable:false` with payload-safe diagnostics. They do not include Tool argument contents. Model-strategy recovery such as sequential chunked file output is handled separately rather than replaying the same generic generation.
