# B6 · 嵌入指南、範例宿主、API 參考

> 2026-10-16。工作單。只寫文件、範例與測試，**沒有改函式庫行為**（`store/`、`domain/`、root 套件、`httpapi/` 的非測試程式碼、`web/` 都沒動）。
> 在獨立 worktree 進行；路由以當時的 `main`（b273ffc）為準，B8 新增的路由由 B8 補文件（`httpapi/apidoc_test.go` 會提醒）。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 通過 |
| `go test ./... -count=1` | 通過（含新套件 `examples/embedding`、`examples/minimal-host` 與 `httpapi/apidoc_test.go`）；DB 測試實際連 :5444，新測試沒有 skip |
| `gofmt -l .` | 無輸出 |
| `bash scripts/smoke.sh` | 通過（82 個事件） |

## 做了什麼

### 1. `docs/EMBEDDING.md`

八節：最小嵌入（18 行）、選功能（功能表、模式、`FeaturePolicy`、`search` 的擴充與 `MigrateFeatures`）、執行 AI（`BeginTurn` / `CompleteTurn`
契約、`RunTurn`、`NewRunnerDispatcher` 的選項、自訂 Dispatcher 與六條規則）、宿主掛勾（`PromptContributor`、`TurnGate`、`Publisher`、
`InTx`、`host_meta`、`QuoteUntrusted`）、認證與租戶（`Scope` / `CanWrite`、SSE `Hub` 與自己的通道）、遷移策略（自動、自己的 migrator、
`MigrateDown`）、維護迴圈、升級規則。

**每段程式碼都能編譯、有測試**：放在 `examples/embedding/`（`package embedding`），以 `// snippet:<name>` … `// endsnippet` 標出區段，
文件用 `<!-- snippet: examples/embedding/<file>#<name> -->` 原樣引用。`examples/embedding/snippets_test.go`：

- `TestGuideSnippets`：文件裡每個引用都等於對應區段，`examples/embedding/*.go` 的每個區段都被引用（沒有孤兒）。
- `TestMinimalEmbeddingFitsTheGuide`：最小嵌入 ≤ 20 行。

範例本身的測試（`examples/embedding/examples_test.go`，都用 `tangenttest`）：`Mount` 經 HTTP 跑完一輪；`Serve` 依 context 停止、壞位址回錯；
`NewEngine` + `TierPolicy` 讓免費租戶的 summary 變 manual、search / branch_suggest 關閉；`AskSync` 回傳回覆、拒絕時回錯、執行一輪啟動的 job
（auto 摘要真的寫進去）；`RunManually` 串流與完成、失敗時不外洩上游錯誤、取消後 `AppendDelta` 讓模型停下；`ChatRequest` 與 `Prompt.Chat()` 一致；
`QueueDispatcher` 跑回合與起草 job、滿了 / 關了拒收、關閉時排隊中的回合都寫回；`PlanContributor` 的內容被引用並去掉協定標記；
`QuotaGate` + `StatusFor` 經 HTTP 回 402、`UserScope` / `UserCanWrite` 的 401 / 403 / `canWrite`；`Publishers` + `Relay`；
`SendWithAttachments`（hook 失敗時沒有任何訊息、成功時 audit 列與 `host_meta`）與 `DeleteWithFiles`（hook 讀到附件）；
`ApplyWithOwnMigrator` 套兩次、之後 `store.Migrate` 無事可做、`tangent.New(Search())` 通過檢查且搜尋可用。

### 2. `examples/minimal-host/`

`package main`，同一個 module。`host.go`：自己的 `ServeMux`（`GET /health`、`GET /whoami`），`/api` 底下掛 `httpapi`（含 `/api/events`），
認證是固定 API key → tenant（`Authorization: Bearer`，以 SHA-256 查表，actor = 雜湊前 8 碼），fake runner，`SetJobDispatcher`。
`main.go`：只讀環境變數（`EXAMPLE_API_KEYS` 必填、key ≥ 16 字元；`EXAMPLE_DATABASE_URL` 預設 `tangent_example`；`EXAMPLE_ADDR` 預設 `127.0.0.1:8122`）、
每分鐘 `Maintain`、SIGINT / SIGTERM 時排空請求、關 Hub、`Shutdown` dispatcher。`README.md` 說明建立資料庫、啟動、curl 試用。

測試（`host_test.go`）：`TestHost_MainLineTurnBranchMerge`（建主線 → 一輪 → 開支線 → 支線一輪 → 起草 → merge → 下一輪卡片 `delivered`）、
租戶隔離與認證、`/api/events` 收到 `line.created`、`loadConfig`、`run` 啟動與停止。手動跑過 README 的 curl（health、whoami、建線、一輪、401），SIGTERM 結束碼 0。

### 3. `docs/API.md`

慣例（前綴、認證、寫入權限、功能路由、本文、路徑 id、回應、錯誤格式、長度上限）、共用物件、每條路由（方法、路徑、參數、本文、回應、常見錯誤、
範例與樣本連結）、錯誤碼表（code、HTTP、說明，分組）、SSE 格式與每個事件的 data。

**`httpapi/apidoc_test.go`**（package `httpapi`，內部測試）：

- `TestAPIDoc_EveryRouteIsDocumented`：`(&api{}).routes()` 加 `GET /events`，每條都要有 `` ### `METHOD /path` `` 標題；反過來，文件寫了不存在的路由也失敗。
- `TestAPIDoc_EveryEventIsDocumented`：用 `go/parser` 讀 root 套件所有 `Event*` 字串常數，加上 `httpapi.EventStreamLagged`，每個都要有 `` ### `type` `` 標題（反向亦然）；
  doc 註解提到 `branch.changed` 的常數區塊（`BranchCreated`…）每個值都要在 `branch.changed` 的表格裡。
- `TestAPIDoc_EveryErrorCodeIsDocumented`：`statusOf` 的每個碼都要有 `` | `code` | <HTTP 狀態> | `` 這一列（狀態要對）。
- `TestAPIDoc_SamplesExistAndAreReferenced`：連到的樣本檔都存在，`testdata/contract/*.json` 每個都被連到。

四個測試都做過反向檢查：拿掉一條路由標題、一個事件標題、一個 change、改錯一個狀態碼、拿掉一個樣本連結，各自失敗並指出要補什麼。

### 4. README

根目錄 README 加「嵌入」一段：連到 `EMBEDDING.md`、`API.md`、`examples/minimal-host/`，以及參考伺服器與 Web 的跑法。

## Port 登記

範例宿主用 **8122**（8120 參考伺服器、8121 smoke 腳本預設、5183 web；8122 在 registry 沒有人用、本機也沒有在聽）。
要加進 `服務登錄檔` 的 tangent 段（`tangent-web` 之後、`tangent-postgres` 之前）：

```yaml
      - id: tangent-example
        name: 範例宿主
        summary: examples/minimal-host（自己的路由與 API key 認證，httpapi 掛在 /api，fake runner，資料庫 tangent_example）
        kind: api
        port: 8122
        expect: on_demand
        manager: { type: manual, start: go run ./examples/minimal-host }
        health: { type: http, path: /health }
        depends_on: [tangent-postgres]
```

之後 `cd 服務登錄檔 && render services`。（實作 agent 的權限不允許改 服務清單，由協調者套用。）
資料庫 `tangent_example` 已在 :5444 建立。

## 寫文件時發現的 API 問題（給協調者）

沒有改任何一項；都記在 EMBEDDING.md 裡目前的做法。

1. **httpapi 的寫入沒辦法帶宿主的 `InTx` 或 `host_meta`。** `POST /messages`、`/lines`、`/branches` 等直接呼叫 Engine，不接受 TxOption；
   Dispatcher 在 commit 之後才被呼叫。DESIGN §9 寫的「宿主的 `DispatchTurn` 用 `InTx` 在同一交易寫 宿主任務佇列」用 httpapi 做不到
   （`DispatchTurn(ctx, Turn)` 也拿不到交易）。目前只能寫自己的路由（範例 `SendWithAttachments`）或接受「commit 後、派發前當掉 → 由 `Maintain` 判逾時」。
   可能的做法：`httpapi.Config` 加 `TxOptions func(r *http.Request, op string) []tangent.TxOption` 與 `HostMeta func(r, op) json.RawMessage`，或修改 §9 的說法。
2. **跨行程的執行端**：delta 緩衝與 Publisher 屬於呼叫 `AppendDelta` 的那個 `Engine`；另一個行程的 worker 串流的內容，API 行程的 `/stream` 看不到。
   也沒有「依 turn id 重建 `Turn`（含 prompt）」的 API，持久佇列只能序列化整個 `Turn`。宿主 若讓 daemon 端回報 delta，要先決定這條路。
3. **自訂 Dispatcher 要自己重做 `RunRequest`**：`systemBlocks` 沒有匯出，要用 `Prompt.ChatBlocks()` 重組（範例 `ChatRequest`），否則 anthropic 的快取斷點會消失。
   建議匯出一個 `tangent.ChatRequest(prompt, provider, model)` 或 `Turn.Request()`。另外 `RunTurn` 的執行會被同一行程的 `CancelTurn` 直接取消（inflight 登記）；
   自訂 worker 只有在 `AppendDelta` / `CompleteTurn` 時才知道，不串流的模型在取消後會跑到結束。可考慮匯出 `Engine.TurnPending(ctx, id)` 或取消回呼。
4. **自己的 migrator 要寫 tangent 的版本表**：`tangent.New` 用 `store.CheckFeatures` 檢查 `tangent_feature_migrations`，所以宿主的 migrator 套用
   `FeatureMigrationsFS` 時必須自己插入 `(feature, version)`（範例照做並附 DDL）。這是隱含的契約；可以寫進 DESIGN，或匯出記錄用的函式。
5. **`InTx` 的 `result` 是 `any`**，每個方法傳什麼型別（`store.BegunTurn`、`store.MergedBranch`、`store.DeletedTree`…）只能讀程式碼得知。
   建議在每個方法的註解寫明，或列一張表。
6. **`PromptContributor` 回錯會讓已經存好的回合失敗**（prompt 在 commit 之後組），不是乾淨的拒絕；拒絕要用 `TurnGate`。文件已說明，若要改成交易前組 prompt 需要另議。
7. **suggest 模式的摘要提示沒有到 HTTP**：`CompletedTurn.SummaryDue` 只在 Go API 回傳，`RunnerDispatcher` 與 httpapi 都沒有轉給客戶端（沒有欄位或事件），
   前端無從得知「該按 compact 了」。
8. **沒有現成的 Publisher 扇出**：參考伺服器測試、httpapi 測試與範例都各寫一個 `fanOut`。可以加 `tangent.Publishers(...)`（只新增）。
9. **測試工具**：`tangenttest` 的 pool 其 `Config().ConnString()` 不含測試 schema 的 `search_path`；拿它去跑宿主自己的 `main`（開新 pool）會遷移到 `public`。
   範例測試因此自己組 URL（加 `search_path` 並檢查 `current_schema()`）。建議 `tangenttest` 提供 `SchemaURL(t, pool)`。
   **待清理**：本步驟早期一版測試曾用 `ConnString()` 呼叫 `embedding.Serve`，在 `tangent_test` 的 `public` 建了 7 張空的 `tangent_*` 表
   （`tangent_schema_migrations` 的 applied_at 為 2026-10-16 08:59:57 UTC）。已修正測試，但沒有權限刪表；請協調者確認後執行
   `DROP TABLE public.tangent_branch, public.tangent_chapter_cut, public.tangent_job, public.tangent_note, public.tangent_message, public.tangent_line, public.tangent_schema_migrations;`
   （表都是空的；留著可能讓只用 `OpenFeatures`、`search_path` 含 `public` 的 MigrateDown 類測試看到 `public` 的表）。

## 偏離工作單的地方

- 範例程式碼放在兩處：`examples/embedding/`（文件引用的片段，可 import 的 package）與 `examples/minimal-host/`（工作單要求的獨立服務）。
- `服務清單` 的登記沒有做（權限不允許），改為把 YAML 片段放在本節，由協調者套用。
