# B4 · runner、httpapi、參考伺服器、契約樣本（→ C1）

> 2026-10-15。工作單。前端要改的地方另見 `docs/devlog/B4-contract-diff.md`。
> 沒有 commit；沒有改 `web/`；沒有改 `docs/DESIGN.md`（契約變動列在本文「與契約的差異」，由協調者決定是否寫進 §12）。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 通過 |
| `go test ./... -count=1` | 通過：**412** 個頂層測試 PASS、0 FAIL、1 SKIP（`TestRealModelSmoke`，沒設 `TANGENT_REAL_SMOKE=1` 時依設計跳過）；DB 測試全部實際連 :5444 |
| `-race` | `go test ./httpapi/... ./runner/... ./cmd/... -race` 通過；root 的新測試（pricing）亦通過 |
| `gofmt -l .`（不含 `web/`） | 無輸出 |
| `~/go/bin/sqlc diff` | 無差異（改了一個查詢後 `sqlc generate`） |
| 新程式碼覆蓋率 | httpapi 88.3%、runner/anthropic 98.5%、runner/openai 94.2%、runner/fake 93.4%、runner/internal/httpstream 85.6%、cmd/tangent-server 91.0%（合計 89.8%）；`pricing.go` 100%、`FeatureConfigured` 100% |
| `scripts/smoke.sh` | **通過**（新建 `tangent_smoke`，fake runner，69 個 SSE 事件，優雅關機 exit 0，約 2.4 秒） |
| 真模型冒煙 | 未執行：環境裡沒有任何 provider 金鑰（`TANGENT_REAL_SMOKE` 未設）。測試已寫好（見下） |
| 檔案 / 函式大小 | 最大檔 `cmd/tangent-server/config.go` 292 行；所有新函式（含測試）≤ 50 行 |

新增頂層測試 61 個：root 4、store 2、httpapi 16、runner 26、cmd/tangent-server 13（含跳過的真模型冒煙）。

**TDD 說明**：domain / store 加法、pricing、runner 三個套件、伺服器設定都是先寫測試看到失敗再實作。httpapi 的 handler 是先寫完（介面很機械）、
隨即寫完整的測試再第一次執行；這一段不算嚴格的 test-first，記錄在此。

## 做了什麼

### B4a runner（只用 `net/http`）

| 套件 | 內容 |
|---|---|
| `runner/internal/httpstream` | 共用：SSE 增量解析（LF / CRLF、註解、多行 data、單行上限 1 MiB）；`Send` 重試迴圈（只重試 429 / 5xx，指數退避 + 抖動、上限 `MaxDelay`，尊重 `Retry-After` 秒數或 HTTP 日期，超過 `MaxRetryAfter` 就不等；每次重試前呼叫 `OnRetry` → Engine 發 `turn.retrying`）；`ReadEvents`（閒置看門狗：太久沒資料就關 body → `ErrStalled`；提前結束 → `ErrEarlyEnd`；ctx 取消回 ctx 錯誤）；`Public(err)` 把失敗轉成 `tangent.RunnerError{Public}`（操作者看得到的固定文字，細節只進 log）；`Redactor` 把金鑰從 provider 錯誤訊息中遮掉 |
| `runner/openai` | Chat Completions 相容（`BaseURL` 可設：OpenAI、DeepSeek、OpenRouter、Ollama），`stream: true` + `stream_options.include_usage`；`reasoning_content` / `reasoning` → reasoning delta；用量含 `prompt_tokens_details.cached_tokens` 或 DeepSeek 的 `prompt_cache_hit_tokens`；有 `finish_reason` 但缺 `[DONE]` 仍視為完成；金鑰可空（Ollama） |
| `runner/anthropic` | Messages API 串流；system 一個 block、最新一則訊息各加 `cache_control: ephemeral`（`DisableCache` 可關）；`thinking_delta` → reasoning；用量：`InputTokens = input + cache_creation + cache_read`，另記 `CacheReadTokens` / `CacheWriteTokens`；`error` 事件 → 「the model provider stopped the reply (overloaded_error)」；預設 `max_tokens` 4096 |
| `runner/fake` | 參考伺服器、smoke、e2e 用的確定性 runner：turn 回「Fake reply to: …」分段串流（`ChunkRunes`、`ChunkDelay`）；card_draft job 回合法 `[BRANCH-CARD]`、summary job 回合法 `[SESSION-SUMMARY]`；指令 `[fake:error]` / `[fake:retry]` / `[fake:slow]` / `[fake:reasoning]` / `[fake:suggest]` |

共同：`Config.Timeout`（預設 10 分）、`IdleTimeout`（2 分）、`MaxRetries`（預設 3，負數關閉）、`RetryBaseDelay` / `RetryMaxDelay`；取消即停（ctx 綁在 request 上）；
API key 只從設定來，不進錯誤訊息與 log（有測試：401 body 裡帶回金鑰時也被遮掉）。測試全部用 `httptest` 模擬各家 SSE：串流、reasoning、用量、429 + `Retry-After`、
529 / 503、401、錯誤事件、斷線、壞 JSON、取消、閒置、逾時。

### B4b httpapi

- `httpapi.New(Config) (http.Handler, error)`；`Config{Engine, Dispatcher, Scope, CanWrite, Hub, StatusFor, MaxBodyBytes, Logger}`。標準函式庫 `ServeMux`（Go 1.22 pattern）。
- 每個請求：`Scope`（失敗 → 401 `unauthorized`；宿主回 `*domain.Error` 就照它的碼）→ 寫入路由檢查 `CanWrite`（→ 403 `forbidden`）→ `MaxBytesReader`（→ 413 `payload_too_large`）→ handler。
- 錯誤 `{error, code, ...extra}`；`domain.AsError` 補 extra；未知 domain 碼走 `StatusFor`，查不到 409；非 domain 錯誤 500 `internal`、訊息固定 "internal error"、細節只寫 log。
- 功能路由只在 `Engine.FeatureConfigured` 時掛上；沒掛的路徑由 catch-all 回 JSON 404 `not_found`；掛了但被 `FeaturePolicy` 關掉 → engine 回 `feature_disabled` → 404（extra `feature`）。
- `POST /messages`：`BeginTurn` → `Dispatcher.DispatchTurn` → 202。Dispatcher 拒絕時立刻以 "the turn could not be started" 讓這一輪失敗（伺服器端呼叫 `CompleteTurn`，沒有路由）並回 503 `unavailable`。
  `/compact`、`/branch/draft` 同理：`StartSummary` / `StartDraft` → `DispatchJob` → 202，拒絕時 `FinishJob(…, err)` 結束 job。
- `CompleteTurn`、`AppendDelta`、`FinishJob` **沒有路由**（`TestRoutes_TheTableCoversEveryRoute` 固定路由數 31）。
- JSON 解碼：一律要 JSON 物件、拒絕結尾多餘內容；未知欄位忽略（同 宿主），**卡片**用 `domain.DecodeBranchCardJSON` 嚴格解碼（未知 / 重複欄位 → 422 `invalid_card`）。
  `hostMeta` 由宿主寫，客戶端送來一律 400。
- path id 不是正規 UUID → 直接回該資源的 not-found 碼（`line_not_found`、`note_not_found`、`milestone_not_found`），不查資料庫。
- `/events`：`Hub`（也是 `tangent.Publisher`）依租戶分流；`event: <type>` + `data: <Event JSON>`；每個客戶端佇列（預設 256）滿了丟最舊；`: connected` 與每 25 秒 `: keepalive`；
  `ResponseController` 清掉寫入期限；`Hub.Close()` 結束所有串流並拒絕新連線（503），參考伺服器在 `Shutdown` 時呼叫。
- `/stream` 先 `GetLine`（別的租戶 404），再回 `StreamSince` 的 `{deltas, seq, truncated}`。

### B4c 參考伺服器（`cmd/tangent-server`）

只讀環境變數（`config.go`，每個錯誤訊息都點名變數）；啟動時 `store.Migrate`、連不上資料庫就結束並說明（URL 密碼遮掉）；`/health`（DB ping，公開）；
`/api/*` = `requireToken`（`Authorization: Bearer`，constant-time 比對）→ 速率限制（token bucket，429 + `Retry-After`）→ httpapi；`TANGENT_STATIC_DIR` 時其餘路徑提供 SPA（找不到檔案回 `index.html`）；
維護迴圈每 `TANGENT_MAINTAIN_INTERVAL` 呼叫 `Engine.Maintain`；`RunnerDispatcher` 同時是 `Engine.SetJobDispatcher`；依 provider 提示分派的 `routedRunner`；
SIGINT / SIGTERM → `http.Server.Shutdown`（`RegisterOnShutdown(hub.Close)`）→ `Dispatcher.Shutdown`，都在 `TANGENT_SHUTDOWN_TIMEOUT` 內。`.env.example` 不含任何金鑰。

| 變數 | 預設 | 說明 |
|---|---|---|
| `TANGENT_DATABASE_URL` | `postgres://tangent:tangent@localhost:5444/tangent?sslmode=disable` | |
| `TANGENT_ADDR` | `:8120`（dev 無 token 時 `127.0.0.1:8120`） | |
| `TANGENT_TOKEN` | — | 必填、≥ 16 字；只有 `TANGENT_DEV=1` 且位址是 loopback 時可省略 |
| `TANGENT_DEV` | — | `1` = 開發模式（provider 預設 fake） |
| `TANGENT_TENANT` / `TANGENT_ACTOR` | `default` / `operator` | 參考伺服器是單一租戶 |
| `TANGENT_PROVIDER` | dev 時 `fake` | `fake` / `openai` / `anthropic` |
| `TANGENT_MODEL` | — | openai / anthropic 必填 |
| `OPENAI_API_KEY`（或 `TANGENT_OPENAI_API_KEY`）、`TANGENT_OPENAI_BASE_URL`、`TANGENT_OPENAI_MODEL` | | 有金鑰或 base URL 就註冊 openai runner |
| `ANTHROPIC_API_KEY`（或 `TANGENT_ANTHROPIC_API_KEY`）、`TANGENT_ANTHROPIC_BASE_URL`、`TANGENT_ANTHROPIC_MODEL` | | 有金鑰就註冊 anthropic runner |
| `TANGENT_FEATURES` | 全部第一批（`AllFeatures`） | `name` 或 `name:mode`，逗號分隔；`none` = 全關；非 AI 功能帶 mode 是錯誤 |
| `TANGENT_PRICING` | — | JSON：`{"model":{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}}`（USD / 百萬 token） |
| `TANGENT_RATE_LIMIT` / `TANGENT_RATE_BURST` | 600 / 分、60 | 每個 token（無 token 時每個 IP） |
| `TANGENT_MAINTAIN_INTERVAL` | 1m | |
| `TANGENT_TURN_TIMEOUT` / `TANGENT_MAX_CONCURRENT` | 10m / 8 | dispatcher |
| `TANGENT_SHUTDOWN_TIMEOUT` | 30s | |
| `TANGENT_FAKE_CHUNK_DELAY` | 0 | fake runner 的串流節奏（e2e 用） |
| `TANGENT_STATIC_DIR` | — | 例如 `web/apps/demo/dist` |
| `TANGENT_LOG_LEVEL` | info | |

### B4d 契約樣本

`httpapi/contract_test.go` 用真 API（假 runner、`WithPricing`）走完整流程，把 **31 個路由回應 + 2 個錯誤 + 15 種事件**（`branch.changed` 依 change 分檔）寫成
`httpapi/testdata/contract/route.*.json` 與 `event.*.json`（共 47 檔）。格式 `{method, path, status, request?, response?}`；事件檔是 SSE `data:` 的完整 envelope。
不穩定的值換成固定值：UUID → `00000000-0000-4000-8000-00000000000N`（同一檔內依出現順序）、時間 → `2026-01-01T00:00:00Z`、`durationMs` → 42、
delta 的 seq → 1000 起、`nextCursor` → `CURSOR`、以時間命名的章節標題 → `2026-01-01 00:00`。沒加 `-update` 時逐位元組比對，多出或消失的樣本也會失敗；
`go test ./httpapi -update` 重新產生。連跑 8 次（含 `-race`）結果穩定。

### smoke 與真模型冒煙

- `scripts/smoke.sh`：在容器內 drop / create `tangent_smoke` → build → 以 fake runner 在 **:8121** 啟動（避開開發用的 :8120）→ curl 走「建主線 → 兩輪 → 開支線 → 支線一輪 → 起草（等到 ready）→ merge →
  主線下一輪（確認卡片 `delivered`）→ promote → 主線一輪 → move 2 則 → 刪除」→ 檢查 `/events` 收到 `line.created`、`message.created`、`message.delta`、`message.updated`、`line.updated`、
  `line.deleted` 與 `branch.changed` 的 created / draft / merged / promoted / moved → SIGTERM，確認 exit 0。需要 docker、go、curl、jq。
- `cmd/tangent-server/realsmoke_test.go` `TestRealModelSmoke`：`TANGENT_REAL_SMOKE=1` 加上 `TANGENT_PROVIDER`、`TANGENT_MODEL`、金鑰時，用參考伺服器走「建主線、兩輪、開支線、支線一輪、起草、merge」；
  否則 skip。不印金鑰。本次環境沒有金鑰，所以沒有跑。

## 路由表（掛在 `/api` 之下）

| Method | Path | Body | 成功 | 寫入 | 功能 |
|---|---|---|---|---|---|
| GET | `/capabilities` | | 200 `{features:[{name,enabled,mode?}]}` | | |
| GET | `/lines?archived=&limit=1..200&cursor=` | | 200 `{lines, nextCursor}` | | |
| POST | `/lines` | `{title?, provider?, model?}` | 201 `LineView` | ✓ | |
| GET | `/lines/{id}` | | 200 `LineView` | | |
| PATCH | `/lines/{id}` | `{title?, provider?, model?}`（至少一項） | 200 `LineView` | ✓ | |
| DELETE | `/lines/{id}` | | 200 `{rootLineId, lineIds}` | ✓ | |
| POST | `/lines/{id}/archive`、`/unarchive` | | 200 `{lines}`（主線在前） | ✓ | |
| POST | `/lines/{id}/read` | | 200 `LineView` | ✓ | |
| GET | `/lines/{id}/messages?afterSeq=&limit=1..500` | | 200 `{messages}` | | |
| POST | `/lines/{id}/messages` | `{content}` | 202 `{turnId, userMessage, pendingMessage}` | ✓ | |
| GET | `/lines/{id}/stream?afterSeq=` | | 200 `{deltas, seq, truncated}` | | |
| POST | `/lines/{id}/cancel` | | 200 `{cancelled, line, message\|null}` | ✓ | |
| POST | `/lines/{id}/compact` | | 202 `{jobId, kind, lineId}` | ✓ | summary |
| POST | `/lines/{id}/preview` | `{content?}` | 200 `{prompt, blocks, totalTokens, provider, model, estimatedCostUsd?}` | 唯讀可用 | |
| GET | `/lines/{id}/branches?includeAside=` | | 200 `{branches}` | | |
| POST | `/lines/{id}/branches` | `{anchorMessageId, purpose, kind, excerpt?, provider?, model?, confirmDeeper?, includeLater?, suggestionMessageId?}` | 201 `{line, branch, pack}` | ✓ | （aside → aside；suggestionMessageId → branch_suggest） |
| POST | `/lines/{id}/branches/move` | `{count, purpose, kind?, provider?, model?, confirmDeeper?}` | 201 `{line, branch, marker, sourceLineId, rootLineId, movedMessageIds, reparented, summaryReset}` | ✓ | |
| GET | `/lines/{id}/branch` | | 200 `BranchDetail` | | |
| POST | `/lines/{id}/branch/draft` | | 202 `{jobId, kind, lineId}` | ✓ | card_draft |
| POST | `/lines/{id}/branch/merge` | `{card, parentTipMessageId, confirmParentMoved?, noteChanges?}` | 200 `{branch, message, line, notes?}` | ✓ | （noteChanges → notes） |
| POST | `/lines/{id}/branch/discard` | | 200 `{branch}` | ✓ | |
| POST | `/lines/{id}/branch/promote` | `{confirm: true}` | 200 `{branch, previousMainLine, line, reparented}` | ✓ | |
| GET | `/lines/{id}/notes` | | 200 `{rootLineId, revision, notes, limits}` | | notes |
| POST | `/lines/{id}/notes` | `{section, text, sourceLineId?, sourceMessageId?}` | 201 `{note, revision, rootLineId}` | ✓ | notes |
| PATCH | `/lines/{id}/notes/{nid}` | `{text?, section?, status?}` | 200 `{note, revision, rootLineId}` | ✓ | notes |
| POST | `/lines/{id}/notes/{nid}/supersede` | `{text, section?, sourceLineId?, sourceMessageId?}` | 201 `{note, superseded, revision, rootLineId}` | ✓ | notes |
| GET | `/lines/{id}/chapters` | | 200 `{lineId, rootLineId, chapters, milestones, limits}` | | chapters |
| POST | `/lines/{id}/chapters/milestones` | `{messageId, title?}` | 201 `{milestone, rootLineId}` | ✓ | chapters |
| DELETE | `/lines/{id}/chapters/milestones/{mid}` | | 204 | ✓ | chapters |
| GET | `/events` | | SSE | | （`Config.Hub` 非 nil） |

參考伺服器另有 `GET /health`（`{status: ok\|unavailable}`，200 / 503，不需 token）。

## 錯誤碼 → HTTP 狀態

S1 devlog 的表**全部照用**（`httpapi/errors.go` `statusOf`）。S1 之後新增的碼與 httpapi 自己的碼：

| Code | HTTP | 來源 |
|---|---|---|
| `job_not_found` | 404 | domain |
| `job_not_pending` | 409 | domain |
| `concurrent_change` | 409 | domain |
| `id_unavailable` | 409 | domain |
| `feature_disabled` | 404（extra `feature`） | domain（DESIGN §7） |
| `unauthorized` | 401 | httpapi（`Scope` 失敗）；參考伺服器的 token 檢查也用同一碼 |
| `forbidden` | 403 | httpapi（`CanWrite` = false） |
| `payload_too_large` | 413 | httpapi |
| `not_found` | 404 | httpapi（沒有這個路由，含沒掛上的功能路由） |
| `unavailable` | 503 | httpapi（Dispatcher 拒絕、`/events` 已關閉） |
| `internal` | 500 | httpapi（非 domain 錯誤，訊息固定 "internal error"） |
| `rate_limited` | 429 + `Retry-After` | 參考伺服器 |
| 其他（宿主的碼） | `Config.StatusFor`，查不到 409 | |

`httpapi.StatusOf(code)` 匯出對照表給宿主與測試。

## domain / store / root 的改動（只有新增）

- **domain**：`Usage.CacheReadTokens`、`Usage.CacheWriteTokens`（`omitempty`；`InputTokens` 的定義是「全部 prompt token，含快取讀寫」）；
  `Line.Usage`（`json:"usage"`，從 `input_tokens` / `output_tokens` / `cost_usd` 讀；只有三個總數）；`LineView.AwaitingReview`（`json:"awaitingReview"`）。
- **store**：`lineFromRow` 填 `Usage`；查詢 `ListBranchUnreadByAncestors` **多回一欄** `awaiting_review`（同一個遞迴 CTE：底下 open 且 `draft_status='ready'` 的支線數，
  跟 `branchUnread` 一樣不含自己），`hydrate` 填 `AwaitingReview`。`sqlc generate` 後 diff 乾淨。測試 `store/b4_additions_test.go`（2 個）。
- **root**：`pricing.go`：`Price{Input, Output, CacheRead, CacheWrite}`（USD / 百萬 token；快取價為 0 時用 Input 價）、`Price.Cost(Usage)`、`WithPricing(map[model]Price)`；
  `Preview.EstimatedCostUSD *float64`（`estimatedCostUsd,omitempty`；只算 prompt 端）；`RunResult.Model`（runner 實際跑的模型）；
  `RunTurn` 在 runner 沒給費用時依 `cmp.Or(result.Model, t.Model)` 的價格補上，並把 `result.Model` 記進訊息 meta；`Engine.FeatureConfigured(name)`。測試 `pricing_test.go`（4 個）。

## 與契約（DESIGN §6、§7）的差異

1. `httpapi.New` 回 `(http.Handler, error)`（契約只寫 `http.Handler`）：Engine、Dispatcher、Scope 缺一就回錯，而不是 panic 或執行期 500。
2. `Config` 多了 `StatusFor`、`MaxBodyBytes`、`Logger`（工作單已列）；`Hub` 有 `HubOption`（`WithClientBuffer`、`WithKeepalive`、`WithHubLogger`）與 `Close()`。
3. 沒掛上的功能路由回 JSON 404 `not_found`（catch-all）；被政策關閉回 404 `feature_disabled`。核心路由的功能輸入（`kind: aside`、`noteChanges`、`suggestionMessageId`）也是 404 `feature_disabled`。
4. 客戶端不能寫 `hostMeta`（`POST /lines`、`PATCH`、`/messages`、`/branches`、`/branches/move`）：400。宿主要讓客戶端寫，就自己包一層路由用 `InTx` / `UpdateLine`。
5. `POST /branch/promote` 要 `{confirm: true}`（同 宿主，S1 表 `invalid_input` 已列「promote 的 confirm」）。
6. `POST /preview` 唯讀身分也可以呼叫（不寫入）。
7. path id 格式不對時回該資源的 404 碼，不是 400。
8. 回應形狀以本文路由表為準（DESIGN §7 只寫了 `/messages` 的 202）。DELETE / archive / read / cancel 都有回應內容（前端可以忽略）。
9. `Runner` 契約加 `RunResult.Model`；`Usage` 加快取兩欄；`LineView` 加 `usage`（其實在 `Line` 上）與 `awaitingReview`（DESIGN §12 原型審查列）。
10. `WithPricing` 的 key 只比對 model 名稱（不含 provider）。估價只算輸入；實際費用在 `RunTurn` 補（宿主自己呼叫 `CompleteTurn` 時要自己算）。
11. httpapi 在 Dispatcher 拒絕時於伺服器端呼叫 `CompleteTurn` / `FinishJob` 把工作結束（DESIGN §12「只給執行端」：這是伺服器自己的清理，仍然沒有路由）。
12. 慢客戶端丟最舊事件時**不另行通知**（宿主 同樣做法）；客戶端靠 `onReconnect` 與 `/stream` 的 `truncated` 補。

## 留給 B5 / F1 / 協調者的問題

1. **anthropic 快取前綴**：`RunRequest.System` 是一個字串，摘要與 trailing 卡片也在裡面，所以「穩定前綴」只能整段 system 一個 breakpoint。要不要讓 `domain.Prompt.Chat()` 或 `RunRequest`
   多一個「分段 system」（例如 `SystemBlocks []string`，前段穩定、後段易變），讓 runner 在穩定段後面下 breakpoint？
2. **OpenAI 新模型**：只送 `max_tokens`；OpenAI 的 o 系列要 `max_completion_tokens`。需要時加 `Config.MaxTokensField`。
3. **Job 的模型**：參考伺服器還不能用環境變數設定 summary / card_draft 的 `JobModel`（便宜模型）。要不要加 `TANGENT_JOB_MODEL=provider/model`？
4. **參考伺服器的身分**：單一 token、單一租戶、沒有唯讀 token。B6 的範例宿主會示範多租戶；要不要在參考伺服器加 `TANGENT_READ_TOKEN`？
5. **事件遺失提示**：Hub 丟事件時要不要送一個 `stream.lagged` 事件讓前端立刻重抓？（目前要等前端自己發現。）
6. **B5 量測**：`hydrate` 的遞迴查詢多一個 `COUNT(*) FILTER`；`/stream` 多一次 `GetLine`。都很便宜，B5 量一下。
7. **DESIGN §12 要記的列**（我沒有改 DESIGN）：上面「與契約的差異」1、3、4、5、7、9、10，以及錯誤碼表新增的 httpapi 碼。
8. **F1**：照 `B4-contract-diff.md` 改型別與 normalizer，並讓前端測試讀 `httpapi/testdata/contract/*.json`。

---

# B4.1（2026-10-15）

> 協調者轉來的 DESIGN §12「B4 問題」決定、安全審查（HIGH / MEDIUM / LOW）、go-reviewer、前端（F1）的請求，以及契約樣本變體。沒有 commit；沒有動 `web/`。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...`、`gofmt -l`、`sqlc diff` | 通過 / 無輸出 / 無差異（B4.1 沒有新 SQL） |
| `go test ./... -count=1` | **461** PASS、0 FAIL、1 SKIP（真模型冒煙，依設計） |
| `-race` | httpapi、runner、cmd/tangent-server 全部；root 與 store 的 B4.1 測試（dispatcher 上限、併發 retry） |
| 覆蓋率 | httpapi 90.5%、runner/anthropic 97.6%、openai 95.1%、fake 93.7%、httpstream 90.7%、cmd/tangent-server 93.6% |
| 契約樣本 | `go test ./httpapi -update` 與 `go test ./cmd/tangent-server -update` 重新產生，共 **67** 檔；連跑 5 次穩定 |
| `scripts/smoke.sh` | 通過（多了「失敗 → retry」一段；78 個事件） |

## A. DESIGN §12 的決定

| 項目 | 做法 | 測試 |
|---|---|---|
| A1 `SystemBlocks` | domain 加 `Prompt.ChatBlocks() (stable, volatile, messages)`：stable = sections，volatile = 摘要 + Trailing + Earlier；兩者以空行相接 = `Chat()` 的 system。`RunRequest.SystemBlocks []SystemBlock{Text, Stable}`（`System` 不變，仍是全文）。anthropic：breakpoint 只在**最後一個 stable block** 之後 + 最新一則訊息；沒有 blocks 時 `System` 整段當 stable。openai 用 `System`（相接） | `TestChatBlocks_…`、`TestB41_TurnRequestsCarry…`、`TestRun_TheCacheBreakpointFollowsTheStableSystemBlock` |
| A2 `max_completion_tokens` | openai：model 名（去掉 `vendor/` 前綴）以 `o<數字>` 或 `gpt-5` 開頭時送 `max_completion_tokens`，否則 `max_tokens`；`Config.TokenField` 覆寫 | `TestRun_ReasoningModelsGetMaxCompletionTokens` |
| A3 `TANGENT_JOB_MODEL`、`TANGENT_VIEWER_TOKEN` | `provider:model` → summary 與 card_draft 的 `JobModel`（anthropic 需要金鑰）。viewer token → `CanWrite=false`（gate 把角色放進 context） | `TestLoadConfig_ViewerTokenJobModelAndAllowedModels`、`TestServer_TheViewerTokenOnlyReads` |
| A4 `stream.lagged` | 客戶端佇列滿了丟最舊並計數；下一次寫入前先送 `event: stream.lagged`，`data` 是 `{type:"stream.lagged", tenant, rootLineId:"", lineId:"", data:{dropped:n}}`，之後照常。**持續落後**（一直有丟、佇列從沒清空）超過 `WithMaxLag`（預設 30 秒）就斷線。工作單說「persistently」沒定義，我用時間而不是次數：一陣短暫的突發不該斷線 | `TestStream_TellsALaggingClientAndEndsAPersistentOne`、`TestB41_ALaggingClientIsToldAndAStuckOneIsDropped` |

## B. 安全（HIGH）

1. **暴力破解**：新的 `gate` 順序 = Host 檢查（無 token 時）→ **每個位址**的速率 → 認證 → **每個 token**的速率。認證失敗另有每個位址的嚴格額度（先 5 次，之後每分鐘 10 次），用完回 429。token 以 sha256 後的固定長度比對（`subtle.ConstantTimeCompare`）。`TANGENT_TOKEN` / `TANGENT_VIEWER_TOKEN` 至少 32 字，錯誤訊息與 `.env.example` 都寫 `openssl rand -hex 32`。測試 `TestGate_*`。
2. **SSE**：`WithMaxStreams(total, perTenant)`（預設 256 / 16；參考伺服器 `TANGENT_MAX_STREAMS`，預設 64）→ 503 `unavailable`；每次寫入前 `SetWriteDeadline(now + 10s)`（`WithWriteTimeout`）；持續落後的客戶端斷線（A4）。測試 `TestB41_StreamsAreCapped`、卡住的 TCP 客戶端被斷線且 `Publish` 不被擋（`TestB41_ALaggingClient…`）、併發 Publish / 訂閱 / 取消（`TestB41_ConcurrentPublishingAndSubscribing`，`-race`）。

## C. 安全（MEDIUM）

3. **長度上限**：domain 新增 `Limits.Text{TitleMaxRunes 200, ModelMaxRunes 100, MessageMaxRunes 32000}`（可設定、逐欄補預設）、`CheckRunes(field, text, max)`、碼 `too_long`（422，extra `{field, max}`）。Engine 在 `CreateLine`、`UpdateLine`、`BeginTurn`，以及 `CreateBranch` / `MoveToBranch` 的 provider / model 檢查。
4. **Dispatcher 佇列**：`WithMaxQueue(n)`（預設 64，執行中 + 等位子的總數）、`WithMaxTenantTurns(n)`（預設 16，一個租戶同時在 dispatcher 裡的 turn）→ `ErrDispatcherBusy` → httpapi 503 `unavailable`（turn 立刻標失敗）。turn 完成後派不出去的 job（例如 summary auto）也立刻 `FinishJob` 結束，不等清掃。參考伺服器：`TANGENT_MAX_QUEUE`、`TANGENT_MAX_TENANT_TURNS`。測試 `TestB41_TheDispatcherBoundsItsQueueAndEachTenant`、`…ConcurrentDispatchRespectsTheQueue`（`-race`）、`…AJobTheDispatcherRefusesIsFailedAtOnce`。
5. **模型白名單**：Engine `WithModelCheck(func(provider, model) bool)`，在建立 / 修改線與開支線 / move 時檢查（支線沒指定就看它會繼承的組合），拒絕 → `model_not_allowed`（422，extra `{provider, model}`）。參考伺服器 `TANGENT_ALLOWED_MODELS=provider:model,…`；**沒設時只允許已設定的模型**（`TANGENT_MODEL`、`TANGENT_*_MODEL`、`TANGENT_JOB_MODEL`），fake provider 任何名稱都可以。
6. **沒有 token 的 dev 模式**：httpapi 對所有宿主要求寫入請求的 body 是 `application/json`（有 `Content-Type` 但不是 JSON，或有 body 卻沒有 `Content-Type` → 415 `unsupported_media_type`；空 body 且沒有 `Content-Type` 可以，前端的 `post(path)` 就是這樣）；參考伺服器沒有 token 時只回應 Host 為 `localhost` / loopback IP 的請求（403，防 DNS rebinding）。
7. **靜態檔**：自己的 SPA handler：只收 GET / HEAD（405）、拒絕 `.` / `..` 片段（400；ServeMux 通常會先 redirect 到清理過的路徑）、`EvalSymlinks` 後必須仍在根目錄內（指到外面的 symlink 當作不存在 → `index.html`）；每個回應帶 CSP（`default-src 'self'`…`frame-ancestors 'none'`）、`nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`。

## D. 安全（LOW）

runner 預設 client 不跟 redirect（`ErrUseLastResponse`）且有 `ResponseHeaderTimeout`（2 分）；base URL 是 http:// 且不是 loopback 時啟動時警告；provider 錯誤 type 限 `[a-z_]{1,40}`，否則丟掉；回覆上限 `MaxReplyBytes`（預設 1 MiB，超過 → 「the reply is longer than this server accepts」）；`/health` 結果快取 1 秒、仍不需認證；速率桶以 token 身分分開（writer / viewer 各一個）；JSON body 後面有任何內容一律 400（改用 `decoder.Token() == io.EOF`）；docker compose 只綁 `127.0.0.1:5444`（**正在跑的容器要重建才生效**；我沒有重建，因為別的 agent 也在用）；smoke 的 token 改用 curl 的 header 檔（`-H @file`，權限 600），不出現在 argv。

## E. go-reviewer

| 項目 | 做法 | 測試 |
|---|---|---|
| HIGH 1 merge / promote commit 後讀取失敗卻回錯 | store 在**同一個交易**讀出 `MergedBranch.Parent`、`PromotedBranch.Main / Promoted / Previous`；httpapi 直接用，不再於 commit 後讀取，所以已 commit 的 merge / promote 一定回 200。Engine 自己發事件時的重讀仍是「失敗只記 log」 | `TestB41_MergeAndPromoteReturnTheirViewsFromTheTransaction` |
| HIGH 2 閒置看門狗不認註解 keepalive | `ReadEvents` 包一層 reader：每次 `Read` 有位元組就重設計時器 | `TestReadEvents_CommentKeepalivesKeepAStreamAlive`（80 ms 的純註解 vs 50 ms 閒置） |
| M4 關機 | `srv.Shutdown` 與 `dispatcher.Shutdown` 各自一份 `TANGENT_SHUTDOWN_TIMEOUT`；`Serve` 自己失敗時也照樣關 dispatcher；`serve` 等維護 goroutine 結束才回傳（`run` 之後才 `pool.Close()`） | `TestServe_MaintainsAtStartupAndShutsDownAfterAServeFailure` |
| M6 reasoning 重複 | `cmp.Or(reasoning_content, reasoning)` | `TestRun_OneReasoningFieldOnlyBlankEventsAndHugeReplies` |
| M7 空 `data:` | `ReadEvents` 略過 data 為空白的事件（兩家共用） | `TestReadEvents_SkipsBlankDataEvents`、anthropic 測試的空 `ping` |
| M8 header 逾時、傳輸錯誤重試 | 預設 transport 設 `ResponseHeaderTimeout`；沒有收到回應的傳輸錯誤也照退避重試（ctx 結束時不重試） | `TestSend_RetriesTransportErrorsUntilTheLastAttempt` |
| LOW 9 Retry-After | 解析不溢位（超過 `MaxRetryAfter` 的值、超大數字、遠方日期都當作「太久」→ 不等、回原 429）；採用時加最多 10% 抖動，且不超過 `MaxRetryAfter`；指數退避維持 `MaxDelay` 上限、抖動下限是一半 | `TestRetryAfter_NeverOverflowsAndClamps`、`TestBackoff_JitterKeepsHalfTheDelay` |
| LOW 10 重試狀態 | 只重試 429 / 500 / 502 / 503 / 504；`Policy.ExtraRetryable` 讓 anthropic 加 529（overloaded，Anthropic 文件要求重試，我保留）；`Policy.NoRetry` 讓 openai 跳過 `insufficient_quota` | `TestSend_OnlyTheUsualStatusesAreRetriedAndNoRetryCanRefuse`、`TestRun_AnExhaustedQuotaIsNotRetried` |
| LOW 11 anthropic usage 被清零 | `message_delta` 的 usage 改指標，缺少時保留原值 | `TestRun_AMessageDeltaWithoutUsageKeepsTheOutputCount` |
| LOW 13 客戶端斷線 | `writeError` 遇到 `context.Canceled` 且請求的 ctx 已結束：debug log、什麼都不寫 | `TestWriteError_AClientThatLeftGetsNothing` |
| LOW 14 方法不符 | 見下方「方法不符回 404」 | — |
| LOW 15 啟動時維護 | `serve` 開始前同步跑一次 `Maintain`（上一個行程留下的 stale turn / job） | 同 M4 的測試（1 小時前的 pending turn 啟動後變 error） |
| LOW 16 OpenAI 用量遺失 | 見下方 | — |

**方法不符回 404**：httpapi 有 catch-all `/`，所以對已存在的路徑用錯方法（例如 `PUT /lines/{id}`）會落到 catch-all，回 JSON 404 `not_found`，不是 405。這是有意的：所有回應都有 envelope，前端不用處理 ServeMux 的純文字 405。

**OpenAI 提前結束的用量遺失**：用量放在 `[DONE]` 之前的最後一個 chunk。若串流在 `finish_reason` 之後、用量 chunk 之前斷掉，我們把回覆當作完成（內容是完整的），但用量是 0，這一輪不計費也不計 token。Anthropic 沒有這個問題（輸入用量在 `message_start`）。

**測試**：hub 併發 Publish（`-race`）、卡住的 SSE 客戶端、Retry-After 溢位、抖動下限都有。「commit 後讀取失敗」：httpapi 的 merge / promote 已經沒有 commit 後的讀取，回歸測試改為 store 層確認回傳的 view 來自交易本身。

## F. 前端（F1）的請求

1. viewer token：A3。
2. 沒指定 provider / model 的新主線，在建立時填入伺服器預設（Engine `WithDefaultModel(provider, model)`；只指定同一 provider 時補 model）。計價本來就是 `cmp.Or(RunResult.Model, line model)`。
3. 取消的紀錄：E LOW 13。
4. 失敗的一輪也記 provider / model / durationMs：`RunTurn` 失敗時帶 `Provider`、`Model`、`DurationMs`（pending 訊息本來就有 provider / model）。`TestB41_RetryTurnRunsTheFailedTurnAgain`。
5. **`POST /lines/{id}/retry`**（`Engine.RetryTurn`、`store.RetryTurn`）：線上最新兩則必須是 `user(done)` + `assistant(error, chat)`，否則 409 `nothing_to_retry`；有 pending turn → 409 `turn_pending`。失敗的回覆保留（status error），對同一則使用者訊息建新的 pending 回覆，不重複使用者訊息；回 202 `{turnId, userMessage, pendingMessage}`（`userMessage` 是原本那一則）。**所有 prompt 的歷史都不含 status error 的訊息**（domain `buildHistory` 只取 `done`）。測試：store 3 個（含 4 個併發 retry 只成功 1 個，`-race`）、engine、httpapi、smoke。
6. `/capabilities` 加 `permissions: {canWrite}`（依 `Config.CanWrite` 對這個呼叫者計算）。
7. **搜尋不在 B4.1**，排在 B5。

## 契約樣本（67 檔，前端可以斷言全部存在）

路由：`route.branch.discard`、`route.branch.draft`、`route.branch.get`、`route.branch.get.ready`、`route.branch.merge`、`route.branch.promote`、`route.branches.create`、
`route.branches.list`、`route.branches.list.rich`、`route.branches.move`、`route.cancel`、`route.capabilities`、`route.capabilities.viewer`、`route.chapters.list`、
`route.chapters.milestones.add`、`route.chapters.milestones.delete`、`route.compact`、`route.lines.archive`、`route.lines.create`、`route.lines.create.rich`、`route.lines.delete`、
`route.lines.get`、`route.lines.get.rich`、`route.lines.list`、`route.lines.read`、`route.lines.unarchive`、`route.lines.update`、`route.messages.list`、`route.messages.list.pending`、
`route.messages.list.rich`、`route.messages.send`、`route.notes.create`、`route.notes.list`、`route.notes.list.rich`、`route.notes.supersede`、`route.notes.update`、`route.preview`、
`route.retry`、`route.stream`、`route.stream.midturn`、`route.stream.truncated`。

錯誤：`route.error.forbidden`（403）、`route.error.invalid_card`（422）、`route.error.line_not_found`（404）、`route.error.nothing_to_retry`（409）、`route.error.parent_moved`（409，`movedMessages` / `movedCards`）、
`route.error.too_long`（422，`field` / `max`）、`route.error.turn_pending`（409）、`route.error.unsupported_media_type`（415）、`route.server.rate_limited`（429，`headers.Retry-After`）、
`route.server.unauthorized`（401，`headers.WWW-Authenticate`）。`route.server.*` 由 `cmd/tangent-server` 的測試寫（`go test ./cmd/tangent-server -update`），httpapi 不檢查它們。

事件：`event.branch.changed.{created,discarded,draft,merged,moved,promoted}`、`event.chapters.changed`、`event.line.created`、`event.line.deleted`、`event.line.updated`、`event.message.created`、
`event.message.delta`、`event.message.updated`、`event.notes.changed`、`event.stream.lagged`、`event.turn.retrying`。

`*.rich` 樣本的欄位都是非零 / 非空：`lines.get.rich` 有 `unread`、`branchUnread`、`awaitingReview: 1`、`branchCounts`、`usage`；`messages.list.rich` 有已送達的卡片、`suggestions`、`deliversCards`、
`notesRevision`、含 `cacheReadTokens` / `cacheWriteTokens` 的用量、一則 `status: error` 的回覆（`meta.error`）與 retry 的成功回覆；`branches.list.rich` 有 `unread`、`messageCount`、`draftStatus: ready`；
`notes.list.rich` 有來源欄位。

**pending 訊息的 `content`**：串流中的 pending 訊息 `content` 一律是 `""`（`route.messages.list.pending`）——in-process 的 run 也一樣，部分文字只在記憶體（`/stream` 與 `message.delta`）。
取消時才把已串流的文字寫進訊息（`meta.cancelled: true`）；失敗時內容是失敗說明。前端顯示串流中的文字要靠 delta，不要讀 pending 訊息的 content。

## 其他

- fake runner 的指令只看「最新的一段」（最後一個空行之後）：Chat 會合併相鄰的 user 訊息（失敗的回覆被排除後，前一則 user 訊息會跟新的合併），不這樣做的話上一則的 `[fake:error]` 會讓下一輪也失敗。smoke 抓到的。
- 串流的 delta 會包含 `[BRANCH-SUGGEST]` 那一行的原文（解析與清除只在完成時做）。這是 B3 的行為，沒改；前端顯示串流文字時可以自己藏掉以 `[BRANCH-SUGGEST]` 開頭的行。要不要在 `AppendDelta` 就過濾，留給協調者。

---

# B4.2（2026-10-15）

## 串流文字過濾協定標記行

- `stream_filter.go`：每個 turn 一個逐行過濾器。行首（去掉前導空白後）是協定標記的行**絕不送出**；標記清單 = `domain.ProtocolMarkers(extra)`（新增的匯出函式：
  `[SESSION-SUMMARY]`、`[BRANCH-CARD]`、`[BRANCH-SUGGEST]` 與各自的 `[/…]`，加上 `WithExtraMarkers`）。行首還可能變成標記時先暫存；一旦不可能（例如 `[1] …`、`[link](…)`、一般文字）就立刻送出，之後同一行的文字直接通過。
- 換行與行尾空白也暫存到有文字接在後面才送，結尾的直接丟掉——等同 reply filter 對儲存內容的處理（刪掉建議行、`TrimRight`），所以**串流的全文 = `CompleteTurn` 存的內容**（有回歸測試以 1 到 N 位元組切片逐一比對）。
- `CompleteTurn` 開頭送出最後一行暫存的部分（確定不是標記行時）；`failTurn`、`CancelTurn` 丟掉過濾器；`Maintain` 清掉別的行程完成的 turn 的過濾器。完成時的解析不變。
- 只過濾 text delta；reasoning / tool 照原樣。`message.delta` 與 `/stream` 走同一條路（`emitDelta`），seq 只在真的送出時配發，所以仍然單調遞增。
- 限制：行**中間**的標記（`… [BRANCH-SUGGEST] …`）串流時不會被拿掉（儲存時會），因為要拿掉就得暫存整行。被關掉 `branch_suggest` 的租戶，建議行仍存在儲存內容裡但不會出現在串流中。
- 測試：`stream_filter_internal_test.go`（標記被切成多段、最後一行沒有換行、一般的 `[` 開頭行立即送出、與儲存內容逐位元組相同、清掃與上限）、`b42_test.go`（Engine 端：事件與 `/stream` 一致、seq 遞增、host 標記、完成時送出暫存、6 個併發 turn，`-race`）。

## 部分回覆存到 pending 訊息

- 串流中已送出的文字（已過濾）會定期寫回 pending 訊息的 `content`，並記 `meta.streamSeq` = 這段內容涵蓋到的最後一個 delta seq。條件：距上次儲存 ≥ 2 秒**或**新文字 ≥ 8 KB（`WithPartialFlush(interval, bytes)`，在 delta 到達時檢查，不另開計時器），取消時以同樣的過濾文字結束。
- 寫入：新查詢 `SavePendingPartial`（`store.SavePartialReply`）——單列 `UPDATE … WHERE id = $1 AND status = 'pending' AND streamSeq < 新值`，不鎖 line、不發 `message.updated`；回覆已完成或已有更新的部分時什麼都不寫，所以跟 `CompleteTurn` 的先後無關。完成與取消時清掉 `streamSeq`（meta 設 null，API 不再顯示）。
- 前端：重新載入時 `GET /messages` 拿到 pending 訊息的 `content`（到 `streamSeq` 為止），再用 `/stream?afterSeq=streamSeq` 補上之後的 delta。
- 另一個行程接手（原行程當掉）時，`CancelTurn` 保留「已存的部分 + 本行程緩衝中 streamSeq 之後的 delta」；同行程取消則用過濾器累積的完整文字（上限 1 MiB，超過就退回 run 的原始文字）。
- **寫入頻率**：一個 30 秒、每秒 200 位元組（約每秒 50 token）的回覆 = **14 次** UPDATE（`TestB42_PartialSaveRate`）；一般而言每個 turn 最多 `時長 / 2 秒 + 位元組 / 8 KB` 次，再加完成或取消的那一次。每次是一列的 UPDATE（內容最多 1 MiB）。
- 已知取捨：串流停頓時（沒有新 delta），最後不到 2 秒的文字要等下一個 delta 或完成才會寫入。
- 測試：時間與大小門檻、不發事件、完成後清掉 `streamSeq`（`TestB42_PartialRepliesAreSavedOnTimeAndSize`）；行程當掉後另一個 Engine 讀到部分內容並以它取消（`…ARestartedProcessCancelsWithTheSavedPartial`）；取消保留過濾後的文字（`…ACancelKeepsTheFilteredText`）；store 層的 pending 守門與不倒退（`TestB42_SavePartialReplyOnlyTouchesAPendingReplyAndNeverGoesBack`）；6 個併發串流各存各的（`-race`）。

## 契約樣本

- `route.messages.list.pending`：pending 回覆現在有 `content: "Half of the answer"` 與 `meta.streamSeq`（契約測試讓每個 delta 都存檔，好讓樣本有值）。
- `route.stream*`、`event.message.delta`：fake 回覆的 `[BRANCH-SUGGEST]` 行不再出現在 delta 裡；暫存的行尾空白改由下一段帶出（例如 `"Half of"`、`" the answer"`）。
- 參考伺服器的 gate 樣本改名為 `route.error.rate_limited`（429，`headers.Retry-After`）與 `route.error.unauthorized`（401，`headers.WWW-Authenticate`），由 `go test ./cmd/tangent-server -update` 產生；`route.server.*` 已刪除。總數仍是 67。
- 正規化：`meta.streamSeq` 跟 delta 的 seq 一樣換成 1000 起的值。

## 其他

- 修掉 B4.1 測試輔助的一個死結：SSE 測試讀取器在沒人取事件時會卡在送 channel，取消後不結束（`TestB41_ConcurrentPublishingAndSubscribing` 偶爾跑到 10 分鐘逾時）。改成送出時也看 ctx。

## 驗收

`go vet`、`gofmt`、`sqlc diff`（`sqlc generate` 後）乾淨；`go test ./... -count=1` **476 PASS**、1 SKIP；`-race`（root、httpapi、runner、cmd）通過；契約樣本連跑 6 次穩定；`scripts/smoke.sh` 通過（78 個事件）。

---

# R1 review fixes（2026-10-15，外部審查 B4.2 `d7c4313`）

| 等級 | 問題 | 修正 | 測試 |
|---|---|---|---|
| MEDIUM | `ExtractBranchSuggestions` 沒有標記時提早回傳、不做結尾修剪；串流與儲存內容的「逐位元組相同」靠測試裡的 `TrimRight` 掩蓋。另外查到：`ResolveTurnOutcome` 用 `TrimSpace` 修掉**前後**的 Unicode 空白，但過濾器只丟結尾、而且只認 ` \t\r\n`，所以開頭的空白 / 空行與 NBSP 之類也會不一致 | 單一來源 `domain.TrimReply`（= `strings.TrimSpace`）：`ResolveTurnOutcome` 與 `ExtractBranchSuggestions` 的兩個回傳都用它。過濾器照它做：以 `unicode.IsSpace` 判斷空白，第一段文字之前的空白丟掉（`started`），結尾的暫存空白在完成時丟掉，標記判斷也用 Unicode 左修剪 | `TestLineFilter_TheStreamIsByteIdenticalToTheStoredReply`：5 種回覆（含無標記的結尾空白 `"Hello world\n\n  "`、開頭空行與空白、NBSP、第一行就是建議行、全空白），以每個 rune 長度切片逐一比對 `ExtractBranchSuggestions(ResolveTurnOutcome(…))`；`TestB42_StreamsMatchTheStoredReplyWithoutMarkersToo` 拿掉 trim、改成前後都有空白的回覆 |
| LOW | `CancelTurn` 的 `streams.finish` 若落在 `AppendDelta` 檢查 turn 與 `push` 之間，`push` 會替已結束的 turn 重建 stream，留到 Maintain 才清 | `finish` 留下墓碑（`finished` map，1 分鐘、最多 4096 筆：滿了先丟過期的、仍然太多就丟任意幾筆）；`push` 遇到墓碑不收文字、不建 stream；`Maintain` 清過期墓碑 | `TestStreamFilters_AFinishedTurnTakesNoMoreText`（確定性：finish 後 push 回空、從沒串流過的 turn 也擋、清掃、上限）；`TestR1_ACancelRacingAppendsLeavesNoStreamBehind`（20 次 cancel 與 50 個 append 併發，結束後 stream 數為 0，`-race`） |

**注意**：測試的切片改在 rune 邊界上：runner 的 delta 是解碼後的 JSON 字串，不會切開一個 UTF-8 字元；在位元組中間切開的 NBSP 不是空白，會被當成文字送出。

驗收：`go vet`、`gofmt`、`sqlc diff` 乾淨；`go test ./... -count=1` **478 PASS**、1 SKIP；`-race`（root、httpapi、runner、cmd）通過；契約樣本重新產生後沒有變動；`scripts/smoke.sh` 通過（78 個事件）。
