# B5 · 搜尋、補齊 API 缺口、效能與穩定性

> 2026-10-16。工作單。前端要改的地方見 `docs/devlog/B4-contract-diff.md` 的「B5 增補」。
> 沒有 commit；沒有動 `web/`；沒有改 `docs/DESIGN.md`（契約變動列在「與契約的差異」，由協調者決定是否寫進 §12）。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 通過 |
| `go test ./... -count=1` | 通過：**535** 個頂層測試 PASS（B4 結束時 478）、0 FAIL、3 SKIP（`TestRealModelSmoke` 沒金鑰時依設計跳過；`TestSearch_Explain`、`TestPromote_Explain` 只在 `TANGENT_PERF_EXPLAIN=1` 時印計畫）；DB 測試都實際連 :5444 |
| `-race` | `go test . ./httpapi ./store -race -count=1` 通過；`./cmd/tangent-server ./scripts/soak ./tangenttest/seed -race` 也通過 |
| `gofmt -l`（不含 `web/`） | 無輸出 |
| `~/go/bin/sqlc diff` | 無差異（改 1 個查詢 `MarkCardsDelivered`、加 3 個 `RenameOpenBranch`、`ListSubtreesLineIDs`、`ListBranchViewsByLineIDs`，`sqlc generate` 後；搜尋的 SQL 用到 pg_trgm 函式，sqlc 的 schema 沒有，所以手寫在 `store/search.go`） |
| 新程式碼覆蓋率 | **89.2%**（`-coverpkg` 合併各套件；新檔 89.0%：store 的 features / search / rename、domain 的 search / 草稿紀要、`feature_search.go`、`branch_b5.go`、`httpapi/b5.go`、伺服器 `stats.go`、`tangenttest/seed`、`scripts/soak`；加上改過的函式 89.2%）。soak 驅動程式 87.4%（有一個 3 秒的迷你 soak 測試） |
| 契約樣本 | `go test ./httpapi -update` 重新產生，**71** 檔（+4）；連跑 3 次穩定 |
| `scripts/smoke.sh` | 通過（加了分支預覽、改名、草稿的紀要提案與 merge 帶回、搜尋、`/capabilities` 的 models；82 個事件） |
| 長跑 `scripts/soak.sh` | **通過**：1 小時（405k 請求）+ 最終程式碼的 20 分鐘（138k 請求），見「穩定性長跑」 |
| 大小 | 最大的新檔 `perf_test.go` 250 行；新函式（含測試）都 ≤ 50 行 |

**TDD 說明**：domain（搜尋、草稿紀要）、store 的搜尋 / 改名 / 卡片送達 / 交易提交、Engine 的搜尋、改名、預覽、送達事件、草稿紀要、model catalog、
httpapi 的三條路由、伺服器的 catalog / stats、fake runner 的新指令都是先寫測試看到失敗（編譯失敗或斷言失敗）再實作。
例外：`store/features.go`（功能 migration）是先寫實作、隨即補測試再第一次執行；`tangenttest/seed` 與 soak 驅動程式是工具，邊寫邊測。

## 1. 搜尋（功能模組 `search`）

- **功能**：`tangent.Search()`（名稱 `search`，開 / 關，沒有 AI）。`catalog` 最後一項，`/capabilities` 會列出。`AllFeatures()` **不含**它（需要資料庫擴充）；
  參考伺服器的預設 `TANGENT_FEATURES` 加上了 `search`。
- **功能專屬 migration**（DESIGN §11 規則 5）：`store/features/search/001_trigram_indexes.{up,down}.sql`（嵌入 `store.FeatureMigrationsFS`）：
  `tangent_line.title`、`tangent_branch.purpose` 的 `gin_trgm_ops`；訊息內容的 `gin_trgm_ops`（部分索引：`status='done' AND kind='chat' AND role IN (user, assistant)`）；
  以及同條件的 `(tenant_id, seq DESC)`。版本記在 `tangent_feature_migrations(feature, version)`，跟核心的 `tangent_schema_migrations` 分開，共用同一個 advisory lock。
- **`store.MigrateFeatures(ctx, pool, "search")`**：先處理擴充：已安裝 → 檢查它的 schema 在 `search_path` 上；沒安裝 → 先查 `pg_available_extensions`，沒有就回
  「伺服器沒有 pg_trgm（裝 contrib，或不要開這個功能）」；有就 `CREATE EXTENSION IF NOT EXISTS pg_trgm`，失敗時說明需要 superuser 或資料庫擁有者。同時建立時撞到
  unique violation 視為成功。然後跑沒跑過的步驟。名稱不是有 migration 的功能 → 錯誤（打錯字不會默默通過）。另有 `MigrateFeaturesDown`（擴充保留）、
  `CheckFeatures`、`FeatureExtension(name)`。
- **`tangent.New`** 對有 migration 的功能呼叫 `store.CheckFeatures`（10 秒逾時）：擴充不在、不在 `search_path`、或 migration 沒跑 → 回錯，訊息寫出要執行的
  `store.MigrateFeatures(ctx, pool, "search")`。沒有這類功能時 `New` 照舊不碰資料庫。
- **`Engine.Search(ctx, scope, SearchInput{Query, Limit, Archived}) ([]domain.SearchHit, error)`**：`needScoped(search)` → `domain.NormalizeSearchQuery`
  （去前後空白，2–200 字；太短 `invalid_input`，太長 `too_long{field:"q", max:200}`）→ store → 每筆用 `domain.SearchSnippet` 切片段。`Limit` 預設 20、上限 50（Engine 夾住；HTTP 超出回 400）。
- **比對**：`ILIKE '%…%'`（`domain.SearchLikePattern` 跳脫 `%`、`_`、`\`），不分大小寫的子字串，所以中文不用斷詞。範圍：主線標題（沒有 branch 記錄的線）、
  支線目的、`done` 的 user / assistant 聊天訊息。依租戶隔離；`Archived` 依**對話根**的 `archived_at`（同 `ListLines`：true 只搜封存的）。
- **排序**：分數 = (`word_similarity(q, text)` + min(1, 查詢字數 / 文字字數)) / 2，0..1。前者是 pg_trgm 的「整個詞出現」；後者是「這段文字大部分就是查詢」。
  只用 trigram 的 `word_similarity` / `similarity` 時，中文在一串字中間的命中分數 ≈ 0（沒有詞界），所以加了覆蓋率這一項。分數相同時新的在前（訊息用建立時間，標題 / 目的用線的最後活動），再依 kind、line、seq 固定。
- **候選與計畫**（效能段有 EXPLAIN）：每一類先取最新的 200 筆候選（`store.SearchCandidates`），分數只算候選。訊息分兩段：
  1. 先走該租戶最新的 4,000 則可搜尋訊息（`store.SearchWindow`，由 seq 往回走，到 200 筆就停）——常見的詞在這裡就滿了；
  2. 不滿 200 筆才搜更舊的：3 字以上走 GIN trigram 索引（`ORDER BY seq + 0` 讓 planner 不能改走 seq 索引），2 字（沒有 trigram）只能繼續往回走。
  兩段都用 `pgx.QueryExecModeExec`（不快取 generic plan）：快取的 generic plan 不知道 pattern，曾經在重複執行後改成全表掃描（82 ms → 12 ms）。
- **片段**：`domain.SearchSnippet(text, query, 120)`：換行 / tab 變空白；以第一個命中處為中心取 120 字，截斷的一端加「…」；snippet 裡每個命中（不分大小寫，不重疊）回傳
  `{start, end}`，單位是 **UTF-16 code unit**（前端 `slice` 直接用）。沒有找到（大小寫規則跟 Postgres 不同的極少數字元）時從頭取、不標。
- **HTTP**：`GET /search?q=&limit=&archived=`（功能沒設定時不掛路由；政策關閉 → 404 `feature_disabled`）→ `{query, hits}`。唯讀身分可用。
- **測試**：domain 7 個（長度、上限、跳脫、片段置中 / 邊界 / 換行 / UTF-16 / 沒命中）；store 6 個（中英混合、相似度與新舊、租戶、封存、萬用字元、上限、舊訊息兩條路徑、輸入）+ 3 個 migration
  （up / check / down / up、未知功能、擴充不存在（測試把 `featureExtensions` 換成不存在的名稱）、擴充不在 `search_path`）；Engine 4 個（中文 / 英文 / 混合 / 片段、封存與輸入、功能與政策、
  `New` 拒絕沒跑 migration）；httpapi 2 個 + 路由表三列（驗證、唯讀、匿名、租戶、功能關閉都自動跑）。
- **`tangenttest.OpenFeatures(t, "search")`**：擴充裝在 `public`（`EnsureExtensions`，advisory lock），測試 schema 的 `search_path` 是「測試 schema, public」。
  不能讓 `MigrateFeatures` 把擴充裝進某個測試 schema：刪掉那個 schema 會連帶刪掉擴充與其他測試的索引。`OpenSchema` / `Open` 不變。

## 2. 補齊 F2 的 API 缺口

| # | 項目 | 做法 | 測試 |
|---|---|---|---|
| 1 | `/capabilities` 的模型清單 | Engine 選項 `WithModelCatalog(groups ...ModelGroup)`、`Engine.ModelCatalog()`（複本；空白名稱丟掉、重複的只留一個）。httpapi 回 `models: [{provider, models}]`（一定有）。參考伺服器 `config.modelCatalog()`：有 runner 的 provider 才列；有 `TANGENT_ALLOWED_MODELS` 就用它，否則已設定的模型（含 job model）；fake 列 `fake-1`；預設 provider 在前、其餘依名稱、模型排序 | `TestB5_TheModelCatalogIsWhatTheHostGave`、`TestModelCatalog_ListsTheModelsOfTheConfiguredRunners`、`TestB5_CapabilitiesListTheModels…`、`TestServer_CapabilitiesSearchAndStats` |
| 2 | 不寫入的支線背景預覽 | `Engine.PreviewBranch(ctx, scope, parentLineID, BranchInput) (BranchPreview{Pack, Text, TokenEstimate})`：跟 `CreateBranch` 同一個 `buildPack`（同樣的摘要規則、`includeLater`），檢查輸入、`aside` 功能、分岔點（必須是父線上 `done` 的 user / assistant；結論卡不行）。目的可以空白。上限不檢查。HTTP `POST /lines/{id}/branches/preview` | `TestB5_PreviewBranchIsThePackCreateWouldBuildAndWritesNothing`（與真的建立的 pack 逐欄相同、沒有寫入、沒有事件）、`…RefusesWhatCreateWouldRefuse`、httpapi |
| 3 | 改支線目的 | `store.RenameBranch`：鎖支線線，`open` 才能改（`branch_closed`），封存 → `archived`，目的用 `NormalizeBranchPurpose`（去空白、1–200 字）；同一個 SQL 改 `tangent_branch.purpose` 與支線線的 `title`。`Engine.RenameBranch` 發 `branch.changed{renamed}` 與支線線的 `line.updated`；支援 `InTx`。HTTP `PATCH /lines/{id}/branch {purpose}` → `{branch}`。背景包不改（快照） | store `TestB5_RenameBranchChangesAnOpenBranchOnly`（租戶、主線、掛勾回滾、封存、關閉）、Engine `TestB5_RenameBranchPublishesRenamedAndTheLine`、httpapi |
| 4 | 草稿提出紀要變更 | `notes` 開啟時，草稿 prompt 加一段要求（最多 `MaxChangesPerMerge` 個，`add` 或 `supersede` 下方列出的紀要）與「目前的紀要」（每則 `note <id> (section): text`，最新的在前，2,000 token 內，其餘只計數）。模型輸出的 JSON 可以多一個 `noteChanges`（`domain.ParseBranchDraftProposal`，跟卡片一樣嚴格：未知 / 重複欄位整份失敗）。`domain.SanitizeDraftNoteChanges` 用 merge 的同一套檢查（`NormaliseNoteChanges`）再加：`supersede` 的 `noteId` 必須是這棵樹進行中的紀要、重複的文字去掉、`sourceLineId` 一律是這條支線、`sourceMessageId` 不是這條支線完成的訊息就清掉；丟掉的寫進 `warnings`，不會讓整份草稿失敗。存在草稿 JSON（`BranchDraftOutcome.NoteChanges`），`GET /branch` 的 `draft.noteChanges` 一定有。`notes` 關閉時 prompt 不要求、輸出裡的也丟掉。宿主的起草沒有這個功能（只讀確認過），這是新設計 | domain 3 個、Engine `TestB5_DraftsProposeNoteChangesWhenNotesAreOn`（提案原樣送 merge 成功）、`…WhenNotesAreOff`、`TestB5_TooManyProposalsAreCut` |
| 5 | 卡片送達時對卡片發 `message.updated` | 查詢 `MarkCardsDelivered` 改成 `:many RETURNING *`，而且只標還沒送達的；`store.CompletedTurn.DeliveredCards`；`afterTurnCompleted` 依序發：回覆的 `message.updated` → 每張卡的 `message.updated` → `line.updated` | store `TestB5_ACompletedTurnReturnsTheCardsItDelivered`、Engine `TestB5_ADeliveredCardIsPublishedAsUpdated`（只發一次） |
| 6 | 起草的 202 帶 provider / model | `jobStarted` 加 `provider`、`model`（`Job.Provider/Model`，已含 `JobModel` / `TANGENT_JOB_MODEL`）；`/compact` 也一樣 | httpapi `TestB5_CapabilitiesListTheModelsAndJobsNameTheirModel`、smoke |

### F3 追加（協調者轉來）

| 項目 | 做法 | 測試 |
|---|---|---|
| `/notes` 的 `limits` 加紀要的 token 預算 | `noteLimits.TokenBudget`（`json:"tokenBudget"`，`Limits.Notes.TokenBudget`，預設 2000），前端可以自己算哪些紀要會被略掉而不用呼叫 `/preview` | `TestB5_NotesLimitsCarryTheTokenBudget`；樣本 `route.notes.list`、`route.notes.list.rich` |
| fake provider 的新主線沒有 model | 參考伺服器 `config.defaultModel()` 對 fake 回 `fake.DefaultModel`（`fake-1`），與其他 provider 一樣經 `WithDefaultModel` 在建立時填入，所以有價格時就能估價 | `TestServer_FakeLinesTakeTheFakeDefaultModel`、`TestLoadConfig_…AllowedModels`（dev 的預設模型） |

## 3. 效能

### 測資：`tangenttest/seed`

`seed.Write(ctx, pool, seed.Config{Tenant, Seed, MainMessages, Branches, MaxDepth, OpenPerParent, BranchMessages})`：預設主線 2,000 則、200 條支線、深度 6、
每條線最多 4 條進行中（低於 Engine 的 8，讓 promote 提上來的子支線放得下）、每條支線 2–12 則。英文、繁中、混合三種句子；id、文字、形狀都由 `Seed` 決定（PCG）。
第一串支線一路到深度 6，其餘隨機掛（三分之一在主線，其餘偏好還有空位的進行中支線）。保持 DESIGN §5：分岔點是父線完成的訊息、進行中的支線只掛在進行中的線下、
merge 的支線在父線有已送達的卡片（`card_message_id`）、`closed_at` 與狀態一致；aside 都已回答並結束。用 `CopyFrom` 一個交易寫入，2,000 + 200 條約 0.1 秒。
測試：形狀與不變條件、Engine 在上面能列大綱 / 跑主線與最深支線的一輪 / 樹滿了拒絕開新支線、同一個 seed 得到同一棵樹。

### 結果

`perf_test.go`，本機（Linux、Postgres 17 docker :5444），長跑結束後、沒有其他負載時（長跑期間量到的數字約高 30–70%，不採用）。`TANGENT_PERF_ASSERT=1` 時超過預算會失敗（預設只記錄）；`TANGENT_PERF_SCALE=1` 另跑十棵樹的搜尋。

| 操作 | 條件 | n | p50 | p90 | p95 | 預算（p95） |
|---|---|---|---|---|---|---|
| `BeginTurn`（含組 prompt） | 主線 2,000 則、200 條支線 | 100 | 7.42 ms | 8.46 ms | **8.71 ms** | < 60 ms |
| `CompleteTurn` | 同上 | 100 | 6.84 ms | 7.41 ms | **7.94 ms** | < 30 ms |
| `ListBranches`（200 條，含 aside） | 同上 | 100 | 4.39 ms | 4.74 ms | **4.93 ms** | < 30 ms |
| `PreviewTurn` | 同上 | 100 | 5.30 ms | 6.05 ms | 6.36 ms | （無） |
| `MergeBranch` | 同上，30 條進行中的支線（最深的先） | 30 | 10.48 ms | 12.05 ms | **12.09 ms** | < 80 ms |
| `MoveToBranch`（2 則） | 主線 2,000 則、170 → 200 條支線 | 30 | 10.95 ms | 12.02 ms | **12.61 ms** | < 80 ms |
| `PromoteBranch` | 每次一棵新樹（199 → 200 條）；舊尾段 6–1,050 則（中位數 393） | 20 | 40.19 ms | 67.08 ms | **69.69 ms** | < 80 ms |
| `Search`（7 個查詢：中 2 字常見 / 少見、中 4 字、英文常見 ×2、中英混合少見、沒有） | 1 棵樹（約 3,400 則可搜尋訊息） | 196 | 11.79 ms | 14.36 ms | **14.50 ms** | < 80 ms |
| `Search`（同上，`TANGENT_PERF_SCALE=1`） | 10 棵樹、同一租戶（約 34k 則） | 196 | 19.78 ms | 90.15 ms | 91.98 ms | （參考） |

十棵樹時各查詢的 p95：`分岔` 16.4、`龍貓` **95.9**、`分岔對話` 17.5、`benchmark` 20.5、`效能 latency` 28.6、`deploy` 20.0、`nowhere to be found` 22.0 ms。只有少見的 2 字查詢超過 80 ms（見下）。
B3 / B4 的 `hydrate` 遞迴查詢多一個 `COUNT(*) FILTER`、`/stream` 多一次 `GetLine`（B4 的問題 6）：包含在上面的 `BeginTurn` / `ListBranches` 裡，沒有可見的影響。

### 搜尋的 EXPLAIN（十棵樹、34k 則訊息、同一租戶；`TANGENT_PERF_EXPLAIN=1 go test ./store -run TestSearch_Explain -v`）

| 查詢 | 段 | 計畫 | 時間 |
|---|---|---|---|
| `分岔`（常見、2 字） | 最新 4,000 | `Index Scan Backward using tangent_message_seq_key`，200 筆就停 | 6.8 ms |
| `deploy`（常見） | 最新 4,000 | 同上 | 10.0 ms（舊訊息段不會執行；若執行是 Seq Scan 8,615 筆、90 ms——這就是要先走最新的原因） |
| `效能 latency`（少見） | 最新 4,000 → 舊的 | 往回走 → `Bitmap Index Scan on idx_tangent_message_content_trgm`（1,182 筆候選頁） | 9.8 + 10.1 ms |
| `nowhere to be found`（沒有） | 最新 4,000 → 舊的 | 往回走 → Bitmap Index Scan，0 筆 | 9.6 + 3.1 ms |
| `龍貓`（2 字、沒有） | 最新 4,000 → 舊的 | 往回走 → **Seq Scan**（2 字沒有 trigram，GIN 幫不上） | 9.1 + 73.7 ms |

改之前（一個 SQL、`ORDER BY seq DESC LIMIT 200`、分數在 LIMIT 前算）：少見的詞讓 planner 沿 seq 索引走完整個租戶（82 ms）；改成「3 字以上一律 GIN」後常見的詞變成 417 ms
（所有命中都算分數再排序）。現在的兩段式兩種情況都在 20 ms 左右。剩下的弱點是**少見的 2 字查詢**：線性於租戶訊息數（34k 則約 75–90 ms，預算資料量內 10 ms）。
沒有加視窗上限去截斷（會漏掉舊的命中）；大量資料的宿主可以考慮 pg_bigm（不在本步範圍）。

### Promote

第一次量（長跑進行中）p50 70 ms / p95 161 ms。暫時插入計時（已移除）後，一次升級的時間分佈（p50 / p95，負載下）：鎖 1.1 / 2.0、檢查 0.5 / 0.9、建立前主線 1.5 / 2.7、
**搬訊息 10.7 / 26.2**、**重掛支線 18.4 / 52.9**、關閉與摘要 1.4 / 2.4、讀 view 4.6 / 6.1 ms，另外 commit 之後替每條被重掛的支線各讀一次（`GetBranch` 兩個查詢）來發事件。改法（改查詢，沒加索引）：

1. `requireTailClosed`：原本每條舊尾段上的支線各一次遞迴查詢 + 一次讀取（幾十條就是上百次來回）→ 新查詢 `ListSubtreesLineIDs`（一次走完所有子樹）+ 一次 `ListBranchesByLineIDs`。
2. `liftBranches`：原本每條被提上來的子支線各一次 `shiftSubtreeDepth`（三個查詢）→ 一次走子樹、一次 `ShiftBranchDepths`（深度只會變淺，不必檢查上限）。
3. Engine 的 `branchEvents`：原本每條支線一次 `GetBranch` → `store.BranchViews`（新查詢 `ListBranchViewsByLineIDs`，一次讀完，依傳入順序）。move 的事件也受惠。

結果 p50 40 ms / p95 70 ms（安靜時）。剩下的主要成本是搬訊息：每則一次 `UPDATE line_id`（不能 HOT，所有訊息索引都要重寫），約 40–50 µs / 則；
EXPLAIN（search 開啟、1,013 則）：`Update on tangent_message` 51.8 ms，其中 FK 觸發器 5.6 ms，掃描本身 0.6 ms（`tangent_message_seq_key`）。
所以**從很前面升級**（舊尾段接近 2,000 則）大約要 100 ms 以上，開了 search（GIN）會更多。這是資料模型（訊息以 `line_id` 歸屬）的成本，見「問題」1。
新增回歸測試 `TestB5_PromoteChecksAndShiftsEveryTailSubtreeAtOnce`（舊尾段上關閉支線底下的進行中支線仍擋住升級；所有子樹一起往下一層）、`TestB5_BranchViewsReadsManyBranchesInTheGivenOrder`。

## 4. 穩定性長跑

`scripts/soak.sh`（`SOAK_DURATION`，預設 1h；`SOAK_WORKERS` 8、`SOAK_SEED`、`TANGENT_SOAK_PORT` 8122、`SOAK_OUT`）：重建資料庫 `tangent_soak` → build 參考伺服器與驅動程式 →
以 fake runner 在 :8122 啟動（`TANGENT_DEBUG_STATS=1`、`TANGENT_MAINTAIN_INTERVAL=10s`、速率限制放寬）→ 跑 `scripts/soak`（Go）→ SIGTERM，確認 exit 0。

驅動程式（`scripts/soak/`）：8 個 worker 各自一棵接一棵地對話（每棵 15–40 步，結束時 70% 刪除、30% 封存），加權隨機：
一般回合（中文 / 英文 / 混合；`[fake:wait=50–4050ms]`、`[fake:slow]` 3 s、`[fake:error]`、`[fake:retry]`、`[fake:suggest]`、`[fake:reasoning]`、`[fake:job-error]`），
10% 在等待中取消，失敗後 70% `retry`；開支線（含 aside、`confirmDeeper`）並在裡面對話；起草 → 等草稿 → merge（一半帶上草稿的紀要提案、一半 `confirmParentMoved`；草稿失敗就手寫卡片）；
discard、promote、move 2 則；**同一條線同時送兩則**（最多一則能開始）；搜尋；送出前預覽、支線預覽、改名、新增紀要、compact、封存再解除。
另有一條連線跟著 `/events`，檢查每個回合的 delta seq 遞增；每分鐘取一次伺服器的 `/debug/stats?gc=1`（goroutine、heap、pool、SSE 連線、dispatcher 持有數）與資料庫的連線數。

不變條件（執行中）：同一條支線一旦讀到結束狀態，之後不能再是 `open` 或換成別的結束狀態（從 `GET /branches` 讀，不靠事件順序）；每次讀訊息 seq 嚴格遞增、pending 最多一則；
回合 3 分鐘內一定結束。結束後等伺服器安靜（最多 2 分鐘）再查資料庫：pending 回覆、pending job、thinking 的線、同一條線兩則 pending、drafting 的支線、
狀態與 `closed_at` 不一致、孤兒支線、merge 了卻沒有卡片，都必須是 0。5xx（503 除外）或驅動程式沒預期的拒絕都算失敗。

### 長跑抓到的問題（已修）

第一次 90 秒的試跑結束時留下 **1 個 pending 回合、1 條 thinking 的線**。原因：驅動程式結束時取消了進行中的請求，其中一個 `POST /messages` 剛好在
`BeginTurn` 的 **COMMIT 進行中**被取消。pgx 取消 COMMIT 時回錯，但伺服器其實已經提交；Engine 以為交易失敗就回錯，沒有人去跑或結束這一輪，要等 15 分鐘的 `FailStaleTurns`。
修正（`store/tx.go` `attemptTx`）：交易本身照舊用呼叫者的 context（之前被取消就 rollback、回錯——保留 `TestHooks_ACancelledContextLeavesNoPartialRows` 的語意），
但 **COMMIT（與 rollback）改用不受取消影響的 context**（15 秒逾時），一旦送出就完成。提交之後才發現呼叫者已離開的情況，原本就由 `failUnbuiltTurn` 把這一輪標為失敗
（新增回歸測試 `TestB5_ACallerGoneAfterTheCommitLeavesNoPendingTurn`，用 Publisher 在提交後取消 context）。「COMMIT 進行中被取消」這個時間窗沒辦法在測試裡穩定重現，由長跑驗證。

### 結果

| 執行 | 程式碼 | 時間 | 請求 | 回合 | 事件 | 不變條件違反 | 失敗（5xx / 未預期） | 結束檢查（8 項） | 安靜所需 |
|---|---|---|---|---|---|---|---|---|---|
| 試跑 90 s | 修正前 | 90 s | — | — | — | 0 | 1（上面的 COMMIT 問題） | pending 回覆 1、thinking 1 | > 2 分鐘 |
| 試跑 2 min | COMMIT 修正後 | 2 min | 13,811 | 1,402 | — | 0 | 0 | 全 0 | 1 s |
| 預備 | 同上（中途停止） | 9 分 38 秒 | 65,793 | — | — | 0 | 0 | 全 0 | 2 s |
| **1 小時** | 搜尋兩段式之後、promote 整批化之前 | **60 分 03 秒** | **404,981** | **41,254**（done 37,113、error 4,133、retry 2,888） | 480,738（重連 0） | **0** | **0** | **全 0** | 0 s |
| 最終 20 分鐘 | **最終程式碼**（含 promote 整批化、事件一次讀、F3 追加） | 20 min | 137,932 | 14,014 | 162,743（重連 0） | 0 | 0 | 全 0 | 0 s |

1 小時的操作：開支線 10,037、merge 2,740（一半帶草稿紀要）、discard 1,508、promote 735、move 1,357、刪除整棵 2,326；同時送兩則 3,707 次，**從沒有兩則同時開始**
（3,323 次一則、384 次兩則都被拒）。預期中的拒絕：`turn_pending` 6,443、`branch_closed` 2,146、`move_no_anchor` 484、`source_busy` 426、`no_messages` 248、`promote_not_top_level` 228、
`parent_closed` 212、`not_enough_messages` 196、`move_protected_message` 194、`session_busy` 174、`branch_busy` 135、`open_branches_on_old_tail` 98、`parent_busy` 27。沒有 5xx。
驅動程式量到的 p95 最高的是 `GET /search` 38 ms、`promote` 28 ms、`merge` 21 ms（8 個 worker 同時跑）。

資源（每 6 分鐘取樣，`?gc=1` 之後）：

| 時間 | goroutine | heap | Sys | pool 連線 | DB 連線（含驅動程式） | dispatcher 持有 |
|---|---|---|---|---|---|---|
| 開始 | 8 | 0.69 MB | 13.1 MB | 1 | 2 | 0 |
| 6 分 | 17 | 3.04 MB | 25.7 MB | 10 | 11 | 4 |
| 30 分 | 17 | 3.20 MB | 25.7 MB | 10 | 11 | 6 |
| 54 分 | 16 | 3.23 MB | 29.9 MB | 10 | 11 | 4 |
| 結束（安靜後） | **9** | **1.73 MB** | 29.9 MB | 4 | 5 | 0 |

heap 在運行中穩定在 3.0–3.2 MB（delta 緩衝、turn 快取、串流過濾器都有上限與過期），結束後降到 1.7 MB；goroutine 回到 9（比開始多 1：驅動程式那條 keep-alive 連線的伺服器 goroutine）；
pool 回到 4 條閒置連線（pgxpool 的閒置連線之後會自己關）。沒有看到洩漏。最終 20 分鐘那次：goroutine 8 → 20 → 9，heap 0.68 → 3.16 → 3.05 MB（結束時 pool 仍有 10 條閒置連線）。

## domain / store / root 的改動

- **domain**（新增）：`search.go`（`SearchHit`、`TextRange`、`NormalizeSearchQuery`、`ClampSearchLimit`、`SearchLikePattern`、`SearchSnippet` 與常數）；
  `branch_draft_notes.go`（`ParseBranchDraftProposal`、`DraftNoteContext`、`SanitizeDraftNoteChanges`、草稿 prompt 的紀要段）；`BranchDraftInput` 加 `ProposeNotes`、`Notes`；
  `BranchDraft` 加 `NoteChanges`（一定有）、`BranchDraftOutcome` 加 `NoteChanges`（`omitempty`，存在草稿 JSON）。
- **store**：`features.go` + `features/search/*.sql`（`FeatureMigrationsFS`、`MigrateFeatures`、`MigrateFeaturesDown`、`CheckFeatures`、`FeatureExtension`）；`loadMigrationsFrom`（從 `loadMigrations` 抽出）；
  `search.go`（`Search`、`SearchInput`、`SearchRow`、`SearchCandidates`、`SearchWindow`）；`branch_rename.go`（`RenameBranch`，新查詢 `RenameOpenBranch`）；
  `MarkCardsDelivered` 改 `:many` 並只標未送達的、`CompletedTurn.DeliveredCards`；`BranchViews`（一次讀多條支線的 view）；
  promote 的 `requireTailClosed` / `liftBranches` 改成整批（`subtreesIDs`）；`draftFromRow` 帶出 `NoteChanges`；**`tx.go` 的 COMMIT 不再被呼叫者取消**（上面）。
- **root**：`feature_search.go`（`Search()`、`FeatureSearch`、`SearchInput`、`Engine.Search`）；`New` 檢查功能 migration；`branch_b5.go`（`RenameBranch`、`PreviewBranch`、`BranchPreview`、
  `ModelGroup`、`WithModelCatalog`、`ModelCatalog`）；`BranchRenamed = "renamed"`；卡片送達事件；草稿的紀要提案；`RunnerDispatcher.InFlight()`；`branchEvents` 一次讀完。
- **httpapi**：三條路由（路由表 32 → 35）、`capabilities.models`、`jobStarted.provider/model`、`notes` 的 `limits.tokenBudget`。
- **參考伺服器**：fake 的預設模型 `fake-1` 填進新線；`search` 在預設功能裡、啟動時 `MigrateFeatures`、`WithModelCatalog`、`TANGENT_DEBUG_STATS=1` 的 `GET /debug/stats`（token 之後；`?gc=1` 先 GC）。
- **runner/fake**：`[fake:wait=…]`（`Config.MaxWait`，預設 30 s）、`[fake:job-error]`、草稿要求紀要時提一個。
- **tangenttest**：`OpenFeatures`、`EnsureExtensions`；`seed` 子套件。

## 與契約（DESIGN）的差異 / 給協調者寫進 §12 的列

1. 搜尋：`Engine.Search` 回 `[]domain.SearchHit`；HTTP 回 `{query, hits}`。命中多了 `role`、`rootTitle`、`purpose`、`at`（工作單只列 `lineId, rootLineId, kind, messageId?, seq?, snippet, score`）；
   命中範圍是 `highlights: [{start, end}]`（UTF-16 offset，可能多個）。`archived=true` 只搜封存的（同 `/lines`）。分數定義與兩段式候選見上。
2. 功能 migration 的版本表 `tangent_feature_migrations`；`store.MigrateFeatures` 對沒有 migration 的功能名稱回錯；`New` 會為有 migration 的功能查資料庫（10 秒）。`AllFeatures()` 不含 search；參考伺服器預設含。
3. `POST /branches/preview` 的目的可以空白，且不檢查深度 / 數量上限（只有建立時檢查）。
4. `PATCH /lines/{id}/branch` 回 `{branch}`；封存中的樹不能改（`archived`）；支線線的標題跟著改；背景包不改。
5. 草稿的紀要提案：丟掉不合格的而不是讓草稿失敗；`draft.noteChanges` 一定有。
6. 卡片的 `message.updated` 夾在回覆的 `message.updated` 與 `line.updated` 之間。
7. 202 的 `provider` / `model` 也加在 `/compact`。
8. store 的 COMMIT 不受呼叫者取消（在 COMMIT 之前取消仍然 rollback）。
9. `RunnerDispatcher.InFlight()`、`tangenttest/seed`、`scripts/soak.sh` 是新的公開工具；參考伺服器多了 `TANGENT_DEBUG_STATS`。

## 留給協調者 / 下一步的問題

1. **Promote 的成本與舊尾段大小成正比**（每則被搬走的訊息一次 `UPDATE line_id`，所有訊息索引都要重寫；開了 search 時還有 GIN）。B5 已把重掛支線改成整批查詢、事件的重讀改成一個查詢；
   剩下的是資料模型本身（訊息以 `line_id` 歸屬）。若要在 2,000 則的主線上「從很前面升級」也守住 80 ms，需要改資料模型（例如線以 seq 區段引用訊息），這是設計層級的決定。
2. **2 字的少見查詢**：線性於租戶訊息數（見 EXPLAIN）。要不要接受，或日後提供 pg_bigm 的選項？
3. 搜尋命中的 `highlights` 用 UTF-16 offset（給 JS）；Go 宿主若要用要自己換算。可以接受嗎？
4. `AllFeatures()` 不含 search（需要擴充與額外 migration）；參考伺服器預設開。要不要改成 `AllFeatures()` 也含？
5. DESIGN §12 要記的列：上面「與契約的差異」1–9。前端：照 `B4-contract-diff.md` 的「B5 增補」改型別（`SearchHit`、`Capabilities.models`、`BranchDraft.noteChanges`、`BranchPreview`、202 的 provider / model、`renamed`）。

## R4 修正

審查結果與判定見 工單。

- **A1**（`store/migrate.go`、`store/features.go`）：`MigrateDown` 只要會回退任何核心步驟，就在同一個 migration 鎖內先回退所有有 migration 的功能（`featureExtensions` 的每一個）已套用的 migration（每個功能新的先），再回退核心步驟。
  目標版本不低於目前版本（什麼核心步驟都不回退）時，功能 migration 不動。`MigrateFeaturesDown` 的回退迴圈抽成 `revertFeatures`，兩邊共用；版本表不存在時視為沒有套用（`featureVersions` 原本就如此）。
  新測試（`store/features_test.go`）：`TestMigrateDown_RevertsFeatureMigrationsBeforeCoreSteps`（目標 0 與 1：回退後 `CheckFeatures` 報「not migrated」，重跑 `Migrate` + `MigrateFeatures` 後四個索引都在、`CheckFeatures` 通過）、
  `TestMigrateDown_ToTheCurrentVersionKeepsFeatureMigrations`（目標 = 目前版本、目前版本 + 10）。修正前：目標 0 重跑後 0/4 個索引、目標 1 重跑後 3/4（少 `idx_tangent_branch_purpose_trgm`）。
- **A2**（`domain/search.go`）：snippet 的起點往前退、終點往後推，直到截斷點不在字形中間：該位置的字是延續字元（Mn / Me / Mc、U+FE00–FE0F、U+200D、U+1F3FB–1F3FF、U+E0020–E007F），或前一個字是 U+200D。
  每一端最多移 `snippetGraphemeMaxShift`（32）個 rune，一長串孤立的組合字元不會讓視窗無限變寬。只用標準函式庫，是近似（不處理國旗的區域指示符成對、Hangul 音節組合等完整 UAX #29 規則）。
  視窗只會變寬，所以原本在視窗內的命中仍然在內，高亮位移不變。`foldedAt` 改用 `unicode.SimpleFold` 的等價比較（同 `strings.EqualFold`），長 s（ſ）、詞尾 sigma（ς）等能對上。
  新測試（`domain/search_test.go`）：`TestSearchSnippet_NeverCutsInsideAGrapheme`（組合字元、膚色修飾、ZWJ 家族在 ZWJ 前後截斷、變體選擇符、標籤序列、兩端同時、純文字）、
  `TestSearchSnippet_GraphemeWideningIsBounded`、`TestSearchSnippet_MatchesSimpleFoldEquivalents`。修正前除了純文字、上限與 Kelvin 符號（`ToLower` 本來就對得上）之外全部失敗。
- **A3**（`store/features.go`）：`MigrateFeatures` 的註解寫明擴充裝在連線 `search_path` 的第一個 schema（同 tangent 的資料表），想放共用 schema 的宿主可以事先自己 `CREATE EXTENSION ... SCHEMA ...`，之後只檢查可見性。

偏離：無。snippet 在兩端加寬後可能比 `SearchSnippetRunes` 多幾個 rune（最多每端 32），常數的意思本來就是「大約」。
