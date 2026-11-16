# Tangent 後端開發計畫書

日期：2026-10-15　狀態：執行中　契約：`docs/DESIGN.md`（本計畫與契約衝突時以契約為準，先改契約）
相關：`docs/ROADMAP.md`（步驟總表）、`docs/design/EXTENSIONS.md`（功能模組清單）、`docs/design/UI_DESIGN_BRIEF.md`（前端設計稿需求）

---

## 0. 兩條工作線

| 工作線 | 範圍 | 產出 |
|---|---|---|
| **後端（B）** | Go 核心函式庫：`domain`、`store`、Engine、功能模組、`runner`、`httpapi`、參考伺服器 | 可嵌入的 Go 模組 + HTTP API + 嵌入指南 |
| **前端（F）** | 這個專案自己的 UI：`@tangent/client`、`@tangent/react`、`apps/demo` | 設計稿 → 元件 → demo app |

兩條線只透過**契約**接觸：HTTP API（DESIGN §7）、事件（§6）、錯誤碼、`/capabilities`（§11）。
契約的唯一事實來源是 Go 端；前端用**契約樣本**（§6.3）驗證自己的型別。

### 同步點

| 同步點 | 何時 | 後端交出 | 前端開始 |
|---|---|---|---|
| **C0 契約草案** | 現在 | DESIGN §6–§7、W0 的暫定型別 | 設計稿（Claude Design）、元件骨架（用 mock） |
| **C1 核心 API 凍結** | B4 完成 | 核心與第一批模組的全部路由、契約樣本、參考伺服器 + fake runner | 接真 API、Playwright e2e |
| **C2 P1 API** | B8 完成 | leaf、spinoff、parking、rebalance、建議匣 | P1 的 UI |
| **C3 P2 API** | B9 完成 | fisheye、group、relations、goal、open_loops | P2 的 UI |
| **C4 P3 API** | B10 完成 | memory、ibis、diverge、fold | P3 的 UI |

每個同步點之後，API 只能**新增**欄位與路由；改名、刪除或改語意要先在 DESIGN 記錄並通知前端。

---

## 1. 現況（2026-10-16）

| 步驟 | 狀態 | 結果 |
|---|---|---|
| S0–S2、B2.1 | ✅ | 骨架、`domain/`、`store/`（含死鎖與審查修正） |
| B3 | ✅ | Engine、turn 協定、功能模組機制、第一批 6 個模組 |
| B4（含 B4.1、B4.2） | ✅ = 同步點 **C1** | runner、httpapi、參考伺服器、契約樣本、安全強化、串流標記過濾、部分回覆存檔 |
| B5 | ✅（外部審查 R4 進行中） | 搜尋模組、F2 的 API 缺口、測資產生器、1 小時長跑（0 違反） |
| B6 | 待做 | 嵌入指南、範例宿主、API 文件 |
| B8–B10 | 待做 | P1–P3 功能模組 |

前端：W0、F0–F3 完成（外部審查 R5 待跑），F4–F6 跟著 B8–B10。交接文件：`docs/HANDOFF.md`。

---|---|---|
| S0 骨架 | ✅ `bf59fb8` | DESIGN、ROADMAP、docker compose（:5444）、port 登記 |
| S1 `domain/` | ✅ `55a1c88` | 127 個測試、94.7% 覆蓋率，只依賴 uuid |
| S2 `store/` | ✅ `8e456b0`，**審查修正中** | 4 組 migration、所有交易、90 個 DB 測試實際執行 |
| W0 前端基礎 | ✅ `239e72e`，審查修正中 | client、react 骨架、demo 殼 |

---

## 2. 共同規則（每個里程碑都適用）

**完成條件（Definition of Done）**
1. `go vet ./...`、`go test ./... -count=1`（DB 測試實際執行，不可 skip）、`gofmt -l .` 為空、`sqlc diff` 無差異。
2. 新增或修改的程式碼覆蓋率 ≥ 80%；交易類操作要有「掛勾失敗會整筆回滾」與併發測試。
3. 審查：`go-reviewer`；動到 SQL / 鎖時加 `database-reviewer`；動到 HTTP / 認證時加 `security-reviewer`。CRITICAL 與 HIGH 修完才算完成。
4. `docs/devlog/<步驟>.md`：做了什麼、跟契約的差異、移植或刪掉的測試、留給下一步的問題。
5. 契約有變動就更新 DESIGN（§12 決定紀錄加一列）。
6. commit（conventional commits，不加 AI 署名）並推到 `main`。

**工程規則**
- TDD：先寫測試（看它失敗），再實作。
- 所有寫入遵守 DESIGN §5：鎖順序 root → parent → child、一組 line 依 id 排序；事件只在 commit 之後發。
- 檔案 < 800 行（一般 200–400）、函式 < 50 行、巢狀 ≤ 4 層。
- 不可在 `domain` 做 IO；不可在 `store` 發事件；不可在核心程式碼寫「功能是否開啟」的判斷（走擴充點，DESIGN §11）。
- 錯誤一律是 `domain` 的錯誤碼；新錯誤碼要同步到前端的錯誤碼清單測試。

**效能預算**（用測試資料量測，寫進 devlog）

| 操作 | 條件 | p95 目標（不含 LLM） |
|---|---|---|
| `BeginTurn`（含組 prompt） | 主線 2,000 則、樹 200 條支線 | < 60 ms |
| `ListBranches` | 200 條支線 | < 30 ms |
| `CompleteTurn` | 同上 | < 30 ms |
| `MergeBranch` / `PromoteBranch` / `MoveToBranch` | 同上 | < 80 ms |
| 魚眼脈絡選取（B9） | 同上 | < 40 ms |

---

## 3. 里程碑總覽

| 代號 | 內容 | 依賴 | 規模 | 前端可平行做的事 |
|---|---|---|---|---|
| **B2.1** | S2 審查修正 | S2 | S | 設計稿 |
| **B3** | Engine 核心 + 功能模組機制 + 第一批模組 | B2.1 | L | 設計稿、元件（mock） |
| **B4** | runner、httpapi、參考伺服器、契約樣本 → **C1** | B3 | L | 元件（mock） |
| **B5** | 效能與穩定性：量測、壓測、維護迴圈 | B4 | S | 接真 API |
| **B6** | 嵌入指南、範例宿主、API 參考文件 | B4 | S | e2e |
| **B8** | 功能模組 P1 + 建議匣 → **C2** | B4 | L | P1 UI |
| **B9** | 功能模組 P2 + 評估工具 → **C3** | B8 | L | P2 UI |
| **B10** | 功能模組 P3（含 pgvector）→ **C4** | B9 | L | P3 UI |

規模：S ≈ 1 個工作階段；M ≈ 2–3 個；L ≈ 3–5 個（一個工作階段 = 一個實作 agent 跑完 + 審查 + 修正）。

---

## 4. 里程碑細節

### B2.1 S2 審查修正

來源：go-reviewer 與 database-reviewer 的報告（2026-10-15）。重點：

- **寫入成功卻回錯**：結果改在交易內讀取（用 tx 綁定的 queries），回傳的是這次 commit 的快照。
- **公開的 `InsertMessage` 不得寫入 pending**；加部分唯一索引 `(line_id) WHERE status='pending'` 當最後防線。
- 重試用盡改回 domain 錯誤碼；每次重試前檢查 `ctx.Err()`；補重試路徑的測試。
- `FailStaleTurns` 單筆失敗不中斷整批；部分結果的回傳規則寫進註解，`PromoteBranch` 失敗時回零值。
- `TxHook` 改收窄介面（只有 `Exec` / `Query` / `QueryRow`），並能拿到這次寫入產生的 id。
- 時間來源統一：store 一律用 `s.now`。
- `tangenttest`：只有「連不上」才 skip；`TANGENT_TEST_REQUIRE_DB=1` 時直接失敗；測試 context 加逾時。
- 補齊每個寫入的「掛勾失敗回滾」測試。
- 加上 database-reviewer 的發現（索引、鎖、遞迴 CTE 上限等）。

**驗收**：兩份審查的 CRITICAL / HIGH 全部修正並有回歸測試；DoD。

### B3 Engine 核心 + 功能模組機制 + 第一批模組

**B3a Engine 骨架與 turn 協定**
- `tangent.New(pool, opts...)`，選項見 DESIGN §6、§11。`New` 驗證設定：`Limits.Validate()`、功能依賴、Memory 這類功能的必要設定。
- `Scope` 檢查（租戶必填）、`TurnGate`（交易前）、`PromptContributor`。
- `BeginTurn`：store.BeginTurn → `domain.BuildPrompt`（規則、背景包、未送達卡片、筆記、摘要、`Limits.HistoryScan` 內的歷史、宿主區塊、`WithExtraMarkers`）→ 回傳 `Turn`。
- `AppendDelta` / `StreamSince`：每條線一個環狀緩衝（64 KB、30 分鐘、每租戶 64 條線）。
- `CompleteTurn`：`ExtractBranchSuggestions` + `ResolveTurnOutcome` → store.CompleteTurn → 擴充點 `OnTurnCompleted` / `AfterCommit`。
- `CancelTurn`、`FailStaleTurns`、`RunTurn(runner)`、`PreviewTurn`（不寫入，回傳 prompt 與 token 估計，分區塊列出）。
- prompt 快取友善的排序：不變的區塊（規則、背景包、筆記）在前，變動的（卡片通知、最近歷史）在後；背景包建立後不可修改。測試：同一條支線連續兩輪，前綴位元組相同。

**B3b 支線、卡片、背景工作**
- `CreateBranch`：鎖外建背景包（`domain.BuildBranchPack`），交易內重驗 anchor；支援 `includeLater`、`confirmDeeper`、建議來源（`origin=suggestion` 時重新比對訊息 meta）。
- `MergeBranch`：`CheckBranchCardShape` → 讀 `CappedReferencedIDs` 的訊息 → `ValidateBranchCard` → `RenderBranchCardMarkdown` → store。
- `DiscardBranch`、`MoveToBranch`、`PromoteBranch`、`ArchiveTree`、`DeleteTree`。
- `Job`：`StartDraft`、`StartSummary`、`FinishJob`（依 kind 分派）、`FailStaleJobs`（DESIGN §12）。
- `Dispatcher` 介面與 `NewRunnerDispatcher`（goroutine、逾時、錯誤寫回 job、panic 防護）。

**B3c 功能模組機制**
- `Feature` 內部介面：`Name()`、`Requires()`、`AI() bool`、`register(*registry)`。
- 擴充點（DESIGN §11 表格）：`ContextProvider`、`HistorySelector`（至多一個）、`OnTurnCompleted`、`OnBranchCreated`、`OnBranchClosed`、`AfterCommit`、`JobHandler(kind)`。
- 每個擴充點依 `WithFeatures` 的順序執行；交易內的掛勾回錯就整筆回滾。
- `FeaturePolicy`（只能收窄）、`Capabilities(scope)`、`feature_disabled` 錯誤。
- 模式 `ModeOff / ModeManual / ModeSuggest / ModeAuto`，`JobModel(provider, model)` 選項讓功能指定便宜模型。

**B3d 第一批模組**

| 模組 | 內容 | 關閉時 |
|---|---|---|
| `notes` | 筆記 CRUD、取代、merge 同交易套用、每輪帶入（revision 有變才重送） | prompt 不帶筆記；merge 的 `noteChanges` 回 `feature_disabled` |
| `chapters` | 章節計算、milestone、摘要時記錄 topic 切點 | 不記錄切點；路由不掛 |
| `aside` | `kind=aside` 的一問一答、答完結束、`PurgeExpiredAsides` | 建立 aside 回 `feature_disabled` |
| `summary` | 超過門檻排程摘要 job、摘要取代涵蓋的歷史 | 只用 `HistoryScan` 截斷 |
| `card_draft` | 起草結論卡（manual：按了才起草；auto：結束支線時自動） | 只能手寫結論卡 |
| `branch_suggest` | prompt 加建議規則、解析 `[BRANCH-SUGGEST]` | prompt 不加規則、不解析 |

**B3 驗收**
- 整合測試走完：建主線 → 對話（fake runner）→ 開支線 → 起草 → merge → 下一輪 prompt 帶卡片 → 卡片標記送達 → promote → move → 刪除整棵。
- 每個第一批模組各一組「關閉時核心照常、prompt 不含該功能」的測試。
- 事件順序測試：commit 失敗不發事件；同一操作的事件順序固定。
- 效能預算中的 `BeginTurn`、`CompleteTurn`。

### B4 runner、httpapi、參考伺服器（→ C1）

**B4a runner**（`runner/`，只用 `net/http`）
- `runner/fake`：可程式化的回覆（固定文字、延遲、串流分段、錯誤、`[BRANCH-SUGGEST]`），測試與 e2e 用。
- `runner/openai`：OpenAI 相容的 Chat Completions + SSE 串流（DeepSeek、OpenRouter、Ollama 等共用）。
- `runner/anthropic`：Messages API + SSE 串流；送出 `cache_control` 讓穩定前綴命中 prompt 快取；回報快取讀寫的 token。
- 共同：逾時、取消、重試（只對 429 / 5xx，指數退避加抖動；每次重試透過回呼讓 Engine 發 `turn.retrying` 事件）、用量回報、API key 只從環境變數或設定讀取、log 不印 key 與內容。
- 測試用 `httptest` 模擬各家串流格式，包括斷線與錯誤事件。

**B4b httpapi**（標準函式庫 `ServeMux`）
- DESIGN §7 的所有路由；`Config{Engine, Dispatcher, Scope, CanWrite, Hub, StatusFor, MaxBodyBytes}`。
- 錯誤格式 `{error, code, ...extra}`；錯誤碼對應 HTTP 狀態（S1 devlog 的對照表）；500 不外洩內部訊息。
- `/events` SSE hub：依租戶分流、慢客戶端丟最舊、keepalive、`Last-Event-ID` 不支援（前端用 `/stream` 補抓）。
- `/capabilities`、`/lines/{id}/preview`（含 `WithPricing` 時的 `estimatedCostUsd`）；功能路由只在功能開啟時掛上。
- `LineView` 彙總加 `awaitingReview`（草稿就緒待審的支線數）。
- 安全：請求大小上限、JSON 嚴格解析（分支/卡片等嚴格欄位拒絕未知鍵值）、id 格式驗證、租戶隔離測試（每個路由用 B 租戶讀不到 A 租戶的資料）。

**B4c 參考伺服器**（`cmd/tangent-server`）
- 設定只從環境變數：`TANGENT_DATABASE_URL`、`TANGENT_ADDR`（預設 `:8120`）、`TANGENT_TOKEN`（必填，除非 `TANGENT_DEV=1` 且只聽 localhost）、`TANGENT_PROVIDER` / `TANGENT_MODEL`、各家 API key、`TANGENT_FEATURES`（逗號分隔，含模式，例如 `notes,leaf:suggest`）。
- 啟動時跑 migration、檢查必要設定（缺就直接結束並說明）。
- 維護迴圈：`FailStaleTurns`、`FailStaleJobs`、`PurgeExpiredAsides`，各有間隔設定。
- 靜態檔：可選地提供 `web/apps/demo/dist`。
- `/health`（DB 連線）、簡單的每 token 速率限制、優雅關機（等待進行中的 turn 寫回）。

**B4d 契約樣本**（給前端）
- httpapi 測試把每個路由的代表性回應寫成 `testdata/contract/<route>.json`（`-update` 旗標重新產生）。
- 前端測試讀同一批檔案驗證型別與 normalizer；任何一邊改了欄位，另一邊的測試就會失敗。

**B4 驗收（C1）**
- httpapi 整合測試覆蓋每個路由的成功、驗證失敗、權限、租戶隔離、功能關閉。
- 用 fake runner 以 curl 腳本（`scripts/smoke.sh`）走完整流程。
- 用真的模型（環境變數開啟才跑）跑一次冒煙測試：建主線、兩輪對話、開支線、起草、merge。
- 契約樣本產生並提交；前端的契約測試通過。

### B5 效能與穩定性
- 測資產生器（`tangenttest/seed`）：主線 2,000 則、200 條支線、深度 6。
- 量測 §2 的效能預算並記錄；必要時加索引或改查詢（`database-reviewer` 複審）。
- 長時間測試：fake runner 隨機延遲與失敗，連續 1 小時，確認沒有卡住的 pending turn / job、沒有連線洩漏。

### B6 嵌入指南
- `docs/EMBEDDING.md`：最小嵌入（20 行內）、選功能、自訂 Dispatcher（佇列範例）、`PromptContributor` / `TurnGate` / `Publisher` 範例、遷移策略（自動或匯出 `MigrationsFS`）、升級規則。
- `examples/minimal-host/`：一個用自己的路由與認證、掛上 httpapi 的小服務。
- `docs/API.md`：路由、請求 / 回應、錯誤碼、事件，從契約樣本產生範例。

### B6.1 嵌入小修（B6 發現，B8 之後）
- suggest 模式的摘要提示（`CompletedTurn.SummaryDue`）傳到 HTTP（回應欄位或事件），前端才能提示 compact。
- 每個 `InTx` 方法的 `result` 型別寫進註解與 `docs/EMBEDDING.md`。
- 自己的 migrator 要寫 `tangent_feature_migrations`：寫進 DESIGN，或匯出記錄用的函式。
- `tangent.Publishers(...)` 扇出（只新增）；`tangenttest.SchemaURL(t, pool)`（連線字串帶測試 schema 的 `search_path`）。
- 只寫文件、不改：`PromptContributor` 回錯會讓已存好的回合失敗，乾淨的拒絕用 `TurnGate`。

### 宿主整合前置（B6 發現）
- httpapi 的寫入能帶宿主的 `InTx` 與 `host_meta`（例如 `Config.TxOptions`、`Config.HostMeta`），否則 DESIGN §9 的「同一交易寫宿主任務」做不到；或修改 §9。
- 跨行程的執行端：delta 與事件要能從 worker 行程回到 API 行程（`/stream` 看得到）；依 turn id 重建 `Turn` 的 API。
- 匯出組請求的函式（`tangent.ChatRequest` 或 `Turn.Request()`，保留 anthropic 的快取斷點）；自訂 worker 得知取消的方式（`TurnPending` 或回呼）。

### B8 功能模組 P1 + 建議匣（→ C2）

**共用：建議匣**（給所有 `ModeSuggest` 的功能）
- 資料：`tangent_suggestion(id, tenant_id, root_line_id, line_id, feature, kind, payload JSONB, status open|accepted|dismissed|expired, created_at, decided_at)`。
- API：`GET /lines/{id}/suggestions`、`POST /suggestions/{sid}/accept`（執行對應動作）、`POST /suggestions/{sid}/dismiss`。事件 `suggestion.changed`。
- 規則：同一對象同一種建議被拒絕後，在設定的期間內不再提出；建議永遠不會自動執行（`ModeAuto` 的功能直接做，不經過建議匣）。

**`leaf` 結論節點**
- 資料：`tangent_leaf(line_id PK, tenant_id, kind conclusion|decision|answer|dead_end|to_continue, line ≤200 字, body ≤4000 字, status draft|confirmed, source_job_id, created_by, created_at, updated_at)`。
- merge 時從結論卡自動產生（kind `conclusion`，不用 AI）；discard 可帶 `{kind: dead_end, line: 原因}`；suggest / auto 模式離開支線時排 `leaf_draft` job。
- API：`GET/PUT /lines/{id}/leaf`、`POST /lines/{id}/leaf/draft`；`BranchView` 加 `leaf: {kind, line}`。事件 `leaf.changed`。
- 測試：merge / discard / promote 後的 leaf；草稿過期與取代；關閉時 discard 的 leaf 參數回 `feature_disabled`。

**`spinoff` 獨立成新對話**
- 兩種方式：
  - `detach`：把一條支線連同子樹變成新的主線（刪掉 branch 記錄、子孫的 `root_line_id` 與 depth 重算），原本的背景包轉成新主線的「起始膠囊」。
  - `fresh`：從任一則訊息開一條全新的主線，起始膠囊 = 根到該訊息的路徑摘要 + 筆記快照（記錄出處）+（有的話）leaf。
- 資料：`tangent_line.origin_capsule JSONB`（prompt 組裝時當作一個不變的區塊）；`tangent_link(id, tenant_id, kind spinoff|relation, from_line_id, from_message_id, to_line_id, to_message_id, label, created_by, created_at)`；原樹留 `branch_marker` 類的標記訊息。
- 鎖：原樹 root → 支線子樹（id 排序）；新主線在同一交易建立。
- API：`POST /lines/{id}/spinoff {mode, atMessageId?, title, copyNotes}`；`GET /lines/{id}/links`。事件 `line.created`、`branch.changed{change: detached}`、`link.changed`。
- 測試：detach 後兩棵樹的上限、depth、筆記出處；fresh 的膠囊內容與 token 上限；併發 detach 與 promote。

**`parking` 念頭停車場**
- 資料：`tangent_seed(id, tenant_id, root_line_id, anchor_message_id NULL, text ≤500 字, status open|expanded|noted|dropped, expanded_line_id, note_id, created_by, created_at, updated_at)`；每棵樹開放中的種子上限 100。
- API：`GET/POST /lines/{id}/seeds`、`POST /seeds/{sid}/expand`（→ 建支線，`origin=seed`）、`/to-note`（需要 `notes`）、`/drop`。事件 `seeds.changed`。
- 不呼叫 AI、不進 prompt。
- 紀要條目新增 `sourceLabel`（寫入時的來源文字快照），順口問被清除後「記進紀要」的來源仍可顯示（含核心 migration）。

**`rebalance` 樹平衡提示**
- 不需要新表；`CompleteTurn` 之後（`AfterCommit`）計算這條支線的訊號：分岔點之後支線與父線的輪數 / token 比、最近 N 輪的位置；超過門檻且沒有被拒絕過 → 建一筆建議（kind `promote_or_spinoff`）。
- suggest 模式可以再排一個 `rebalance_check` job，讓便宜模型判斷支線是否比主線更接近對話目標（有 `goal` 時）。
- 接受建議時：promote 之前先替「前主線」排 `leaf_draft`；或轉到 spinoff。
- 測試：門檻計算、拒絕後的冷卻、與 promote / spinoff 的串接。

**B8 驗收（C2）**：每個模組都有 Engine 測試、httpapi 測試、契約樣本、「關閉時不影響核心」的測試；DoD。

### B9 功能模組 P2 + 評估工具（→ C3）

**`fisheye` 魚眼脈絡**
- 以 `HistorySelector` 取代預設的歷史挑選。分數 = 先天重要性 − 樹上距離（Furnas 1986）：
  - 距離：同一條線的訊息依 seq 距離；祖先線的訊息 = 層級差 + 該訊息到分岔點的距離；兄弟與其他支線只以 leaf 參與。
  - 先天重要性：使用者釘選（新增 `POST /messages/{mid}/pin`）、被結論卡或筆記引用、leaf 類型（decision > conclusion > answer > to_continue > dead_end）。
- 在 token 預算內由高分往低分選；輸出一個「其他支線的結論」區塊（只有一句話）。
- `PreviewTurn` 回傳每個被選入的項目與分數，給前端顯示。
- **評估工具** `cmd/tangent-eval`：用固定的對話樣本，比較「預設挑選」與「魚眼」的 token 數與回答品質（LLM 評分，評分 prompt 固定）。驗收：token 減少 ≥ 30%，品質不下降（評分差 ≤ 誤差）。結果寫進 devlog。

**`group` 群組摘要與支線合併**
- 資料：`tangent_group(id, tenant_id, root_line_id, title, summary, status active|dissolved, source_job_id, ...)`、`tangent_group_member(group_id, line_id)`；`tangent_branch` 加 `merged_into_line_id`。
- 群組摘要：選 2 條以上同一棵樹的已結束支線（需要 leaf）→ `group_summary` job → prompt 中以群組摘要取代成員的 leaf。
- 合併支線：選 2 條以上開放中的支線 → 新支線（`origin=merge`），背景包 = 各支線的 leaf + 最近幾則 → 舊支線關閉（`discarded` + `merged_into_line_id`）。
- 建議：`group_suggest` job（有 Embedder 用 embedding 相似度，沒有就由便宜模型分群）→ 建議匣；同時偵測互相矛盾的 leaf，列在建議裡。
- 合併請求帶每個矛盾項的選擇（`adoptBranch / adoptOther / keepBoth`），`keepBoth` 寫入紀要「待確認」。
- 測試：成員必須同一棵樹、狀態限制、解散、合併後的上限與 depth、衝突偵測的輸出解析、矛盾選擇的套用。

**`relations` 關聯線**
- 資料：`tangent_link`（kind `relation`），兩端可以是訊息或線，同一棵樹或跨樹；說明 ≤ 200 字。
- API：`GET/POST/DELETE /lines/{id}/relations`。suggest 模式由便宜模型建議（建議匣）。
- `group` 的建議會參考關聯線。

**`goal` 對話目標與偏題偵測**
- 資料：`tangent_goal(root_line_id PK, tenant_id, text ≤300 字, source manual|ai, updated_at)`。
- prompt：目標放在規則之後（不變的區塊）。
- 偏題偵測：每 N 輪（可設定）在 `AfterCommit` 排 `drift_check` job；判定偏題時建立建議（開岔題或支線，附預填的目的）。
- API：`GET/PUT /lines/{id}/goal`、`POST /lines/{id}/goal/propose`（AI 從前幾輪提出目標）。

**`open_loops` 未完成清單**
- 只讀查詢：閒置超過 N 天的開放支線、`to_confirm` 筆記、開放中的種子、未處理的建議，可依租戶或單一對話。
- API：`GET /open-loops?root=&staleDays=`。

**B9 驗收（C3）**：同 B8；另外 `tangent-eval` 的結果符合 fisheye 的驗收門檻；魚眼脈絡符合效能預算。

### B10 功能模組 P3（→ C4）

**`memory` 跨對話記憶**
- 宿主提供 `Embedder` 介面：`Embed(ctx, texts) ([][]float32, error)`、`Dim() int`；附 `runner/openai` 相容的 embedding 實作。
- 功能專屬 migration（需要 pgvector）：`tangent_memory(id, tenant_id, kind fact|decision|preference|lesson, text, status active|superseded, superseded_by, importance 1–10, valid_until, source_line_id, source_message_id, source_leaf_line_id, source_note_id, embedding vector(dim), created_at, updated_at)`。
- 寫入：merge / leaf 確認 / 筆記 decided 之後排 `memory_extract` job；輸出依 Mem0 的四種動作，但「刪除」一律改成「取代」，保留歷史。
- 召回：開新對話、開支線、每輪（可設定）以「相關性 × 近期 × 重要性」（Generative Agents）取前 k 筆，在預算內作為一個 prompt 區塊，並列出出處。
- 整併：維護迴圈排 `memory_consolidate` job（合併重複、標出矛盾 → 建議匣）。
- API：`GET/POST /memories`、`PATCH /memories/{mid}`、`POST /memories/{mid}/supersede`、`POST /memories/search`。
- 測試：pgvector 不在時 `New` 回清楚的錯誤；召回排序；取代鏈；租戶隔離。

**`ibis` 論證節點類型**
- 資料：`tangent_message_tag(message_id PK, tenant_id, kind question|idea|pro|con|decision, source ai|user, updated_at)`。
- auto / suggest 模式每輪之後排 `ibis_tag` job（便宜模型，一次標多則）；使用者修改的標記不會被 AI 覆蓋。
- API：`PUT/DELETE /messages/{mid}/tag`；大綱與訊息列表帶出標記。

**`diverge` 發散 / 收斂**
- 發散：`POST /lines/{id}/diverge {anchorMessageId, count 2..5}` → `diverge` job → 建立 N 條兄弟支線（`kind=alternative`、`origin=diverge`），目的由 AI 提出。
- 收斂：`POST /lines/{id}/converge {lineIds}` → `converge` job → `tangent_comparison(id, tenant_id, root_line_id, line_ids, matrix JSONB{criteria, options, scores, recommendation}, ...)`。
- 決定：`POST /comparisons/{cid}/decide {lineId}` 一個交易內替選定支線建 `decision` leaf、其他兄弟支線設為未帶回並加 `dead_end` leaf。

**`fold` 折疊**
- 資料：`tangent_fold(id, tenant_id, line_id, from_seq, to_seq, summary, tokens_original, tokens_summary, status active|removed, source_job_id, ...)`；同一條線的折疊不可重疊。
- prompt：折疊範圍內的訊息以摘要取代（在 `HistorySelector` 之前套用，與 `fisheye` 相容）。
- 建議：依章節的 topic 切點排 `fold_suggest` job → 建議匣。
- API：`GET/POST /lines/{id}/folds`、`DELETE /folds/{fid}`。

**B10 驗收（C4）**：同 B8；memory 的召回品質用 `tangent-eval` 的固定樣本量測並記錄。

### 宿主整合指南
- 依 DESIGN §9 的對照表：資料遷移、自訂 Dispatcher 寫宿主任務（用 `InTx`）、`PromptContributor`、`TurnGate`、`Publisher`。
- 前端改用 `@tangent/react` 元件，用 `--tg-*` token 對應宿主主題。

---

## 5. API 開放時程（給前端）

| 路由群組 | C1 | C2 | C3 | C4 |
|---|---|---|---|---|
| lines、messages、stream、cancel、preview、capabilities、events | ✅ | | | |
| branches、branch（draft / merge / discard / promote）、move | ✅ | | | |
| notes、chapters（第一批模組） | ✅ | | | |
| suggestions、leaf、spinoff、links、seeds、rebalance 建議 | | ✅ | | |
| pin、group、relations、goal、open-loops、preview 的魚眼分數 | | | ✅ | |
| memories、message tag、diverge / converge、folds | | | | ✅ |

C1 之前前端用 W0 的暫定型別加 mock；C1 之後一律以契約樣本為準。

---

## 6. 測試策略

| 層 | 工具 | 內容 |
|---|---|---|
| `domain` | `go test` | 純邏輯、prompt 組裝、卡片驗證、魚眼分數計算 |
| `store` | `go test` + `tangenttest`（每測試一個 schema） | 交易、不變條件、併發、掛勾回滾、migration up / down |
| Engine | `go test` + fake runner + 事件收集器 | 端到端流程、功能開關、事件順序 |
| `httpapi` | `httptest` | 路由、錯誤碼、租戶隔離、契約樣本 |
| runner | `httptest` 模擬各家串流 | 串流解析、錯誤、重試、取消 |
| 契約 | 契約樣本 + 前端測試 | 前後端欄位一致 |
| e2e | Playwright + 參考伺服器 + fake runner | 前端主要流程（F 線負責） |
| 真模型冒煙 | 環境變數開啟 | 每個同步點跑一次 |
| 評估 | `tangent-eval` | fisheye、memory 的 token 與品質 |

---

## 7. 風險與對策

| 風險 | 影響 | 對策 |
|---|---|---|
| 功能模組的擴充點不夠用，後期功能得改核心 | 核心反覆改動 | B3c 先用第一批 6 個模組驗證；B8 開始前再檢查一次 P1–P3 需要的擴充點 |
| 魚眼脈絡省了 token 但回答變差 | 核心價值受損 | `tangent-eval` 驗收門檻；功能預設關閉，量測通過才在參考伺服器預設開啟 |
| AI 建議太多打斷思考（違反心流） | 使用者關掉功能 | 建議匣集中、永不彈窗、被拒絕後冷卻、每輪最多一個建議 |
| pgvector 讓嵌入變難 | 宿主不願意裝 | memory 是唯一需要它的功能，用功能專屬 migration 隔離 |
| 前後端欄位漂移 | 前端壞掉 | 契約樣本雙向測試；同步點之後只新增不改名 |
| 交易變多導致死鎖 | 正式環境卡住 | 鎖順序寫進 DESIGN §5；每個新寫入都有併發測試；database-reviewer 必審 |
| prompt 注入（模型輸出、使用者資料進入下一輪） | 標記被偽造、指令被注入 | 一律走 `domain` 的清洗與引用；宿主資料用 `QuoteUntrusted` |
| 費用失控 | 使用者帳單 | line 累計用量、`PreviewTurn`、功能預設用便宜模型、背景工作有逾時與上限 |

---

## 8. 執行方式

- 每個里程碑由一個實作 agent 負責，工作單包含範圍、契約章節、驗收與邊界。
- 實作完成後由協調者跑審查 agent，把發現整理成修正清單交回同一個實作 agent，修完再驗收。
- 前後端兩條線可以同時有各自的 agent；動到契約（DESIGN）只由協調者修改。
- 每個里程碑結束：更新 `docs/ROADMAP.md` 的狀態、推到 GitHub。
