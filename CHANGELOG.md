# 變更紀錄

本檔記錄 tangent 每個版本的變更，格式依 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號依 [語意化版本](https://semver.org/lang/zh-TW/)。
**0.x 期間次版號（0.1 → 0.2）可能有不相容的變更**，會寫在該版的「變更」或「移除」；修訂號（0.1.0 → 0.1.1）只修錯誤、不改 API。
Go module 是 `github.com/Rynvex/tangent`（安裝方式見 [docs/EMBEDDING.md §0](docs/EMBEDDING.md#0-取得-tangent)）。

## [0.1.0] - 2026-11-16

第一個版本。將樹狀分支對話流程做成可嵌入的 Go 函式庫，附參考伺服器與 Web UI。
契約是 `docs/DESIGN.md`（§12 是依主題整理的目前有效決定，歷史在 `docs/design/DECISIONS_LOG.md`），HTTP 參考是 `docs/API.md`，嵌入方式是 `docs/EMBEDDING.md`。

### 新增：核心（`tangent`、`domain`、`store`）

- **主線、訊息與回合**：`Engine` 的 turn 協定 `BeginTurn` / `CompleteTurn`（冪等，已不是 pending 時回 `domain.ErrTurnNotPending`）、
  `CancelTurn`、`RetryTurn`；同步的 `RunTurn` 與現成的 `NewRunnerDispatcher`（`WithTurnTimeout`、`WithJobTimeout`、`WithMaxConcurrent`、
  `WithMaxQueue`、`WithMaxTenantTurns`，關機時 `Shutdown`）。執行 AI 的方式由宿主決定。
- **串流**：`AppendDelta` 的 delta 緩衝與 `StreamSince`（`GET /stream`）；進行中的回覆定期存部分文字並記 `meta.streamSeq`（`WithPartialFlush`）；
  串流中的標記過濾（`[BRANCH-SUGGEST]` 等，`WithExtraMarkers` 可加）。
- **支線**：開支線（背景包）、帶結論卡 merge、discard、promote（升為主線）、move（把訊息搬進支線）、改名、開支線前的預覽；
  整棵樹封存 / 刪除（`ArchiveTree`、`DeleteTree`）、已讀（`MarkRead`）。訊息釘選（`PinMessage`）是核心。
- **prompt**：結構化的 `domain.Prompt`（`Chat()`、分穩定段與變動段供 prompt 快取的 `ChatBlocks()`、給 CLI 代理的 `Text()`）；
  每一輪的區塊共用一個 token 預算 `Limits.Context.TokenBudget`（預設 40,000）；`PreviewTurn` 逐項回報預算，設了 `WithPricing` 時附估價。
- **事件**：只在 commit 之後發（`Publisher`、`Publishers`）；事件清單見 `docs/API.md`「事件」。
- **宿主掛勾**：`PromptContributor`（宿主區塊，可標 `Trailing` 放在不快取的尾段）、`TurnGate`、`Publisher`、`InTx`（同一個交易寫宿主自己的資料）、
  `host_meta`、`FeaturePolicy`（依租戶或對話收窄功能）、`WithModelCatalog` / `WithModelCheck` / `WithDefaultModel`。
- **宿主系統訊息**（`role=system`、`kind=chat`）：`TurnResult.Notices` 在 `CompleteTurn` 的同一個交易寫在回覆之後，`Engine.AppendSystemMessage` 單獨寫
  （`SkipRepeat` 不重複寫同一個狀態）；內容經 `domain.CleanSystemText`。宿主不必再改寫 `tangent_message`（EMBEDDING §4.6）。
- **清理不可信文字**：先正規化（換行、雙向控制字元、緊鄰 ASCII 的零寬字元）再移除協定標記與拆掉 code fence，被隱形字元拆開的標記不會被拼回來；行首有隱形字元的標記行，串流與回覆解析一樣當成標記行（B7.3）。
- **跨行程的 worker**：`LoadTurn`、`TurnPending`、`Observe`、`WithDeltaSink`、`Turn.Request()` / `ChatRequest`；API 行程是唯一編 delta 序號的地方（EMBEDDING §3.4）。
- **維護迴圈**：`Engine.Maintain`（逾時的回合與 job 標成失敗、功能的清理、過期的 delta 緩衝），函式庫不自己開計時器。
- **store**：嵌入的核心 migration（`001`–`015`）與功能 migration（`search`、`memory`）；`Migrate`、`MigrateDown`、`MigrateFeatures`、
  `MigrateFeaturesDown`、`CheckFeatures`，以及給宿主自己 migrator 用的 `RecordCoreMigration` / `RecordFeatureMigration`；資料表都以 `tangent_` 開頭。
  所有交易依固定的鎖順序（root → parent → child，同一組依 id 排序），線內排序一律用 `seq`。
- **錯誤碼**：完整錯誤碼表在 `docs/API.md`「錯誤碼」。

### 新增：HTTP API（`httpapi`）

- 可掛載的 `http.Handler`（標準函式庫 `ServeMux`）：`httpapi.New(Config{Engine, Dispatcher, Scope, CanWrite, Hub, StatusFor, MaxBodyBytes, Logger, TxOptions, HostMeta, DeltaFilter})`。
  認證與租戶由宿主的 `Scope` / `CanWrite` 決定；`CompleteTurn`、`AppendDelta`、`FinishJob` 不開放給客戶端。
- SSE `Hub`（`GET /events`）：依租戶分送、慢客戶端收到 `stream.lagged`、每 25 秒 keepalive。
- `Config.DeltaFilter`：依讀者過濾或改寫 `GET /stream` 的 delta 與 `/events` 的 `message.delta`（例如工具輸入只給可寫的成員）。
- 寫入路由帶穩定的操作名稱（`httpapi.Op…`），`Config.TxOptions` 與 `Config.HostMeta` 讓宿主在同一個交易寫自己的資料、提供 `host_meta`。
- `GET /capabilities` 回傳每個功能對這個租戶的有效狀態；功能關閉時路由回 `404 feature_disabled`。
- 回應形狀的契約樣本在 `httpapi/testdata/contract/`（前端的契約測試直接讀它們）；`docs/API.md` 列出每條路由、操作名稱、錯誤碼與事件，並有測試檢查表格完整。

### 新增：功能模組

內建、可選，用 `tangent.WithFeatures(...)` 挑選；用到 AI 的功能有模式 `off / manual / suggest / auto`，`JobModel` 讓背景工作用另一個模型。
完整說明見 `docs/EMBEDDING.md` §2 的功能表。

- **第一批**（`AllFeatures()`）：`notes`（紀要）、`chapters`（章節與 milestone）、`aside`（岔題，7 天後清除）、`summary`（滾動摘要、`POST /compact`）、
  `card_draft`（AI 起草結論卡）、`branch_suggest`（AI 在回覆裡提議支線）。
- **搜尋**：`search`（`GET /search`，`pg_trgm`，需要功能 migration）。
- **P1**：`leaf`（支線的收尾與死路原因）、`parking`（停車場種子）、`spinoff`（獨立成新對話、`GET /links`）、`rebalance`（樹平衡提示）；
  以及建議匣 `suggestions`（`/suggestions`，有會提建議的功能開著時才存在）。
- **P2**：`goal`（對話目標與偏題檢查）、`relations`（關聯線，可跨樹）、`open_loops`（未完成清單）、`fisheye`（魚眼脈絡，取代預設的歷史選擇）、
  `group`（群組與合併支線、`POST /branches/combine`）。
- **P3**：`ibis`（論證類型標記）、`fold`（折疊一段訊息成摘要）、`diverge`（發散成兄弟支線 → 比較表 → 決定）、
  `memory`（跨對話記憶：需要 `notes`、`Embedder`、`vector` 擴充與功能 migration；不在 `AllFeatures()`）。
- **B13**：`memo`（備忘，`/memos`：寫在節點上、不給 AI，每棵樹 500 則）。
- `tangent.SuggestionProbe()` 只給測試、smoke 與 e2e 用，不是產品功能。

### 新增：runner（`runner/`）

- `runner/fake`：不連網的假模型（可調串流速度）與決定性的 `fake.NewEmbedder`。
- `runner/openai`：OpenAI 相容的 chat completions（可設 `BaseURL`，OpenAI、DeepSeek、OpenRouter、Ollama 等）與 `openai.NewEmbedder`。
- `runner/anthropic`：Anthropic Messages API，穩定段標 `cache_control` 以使用 prompt 快取。
- 只用 `net/http`；遇到 429 / 5xx 重試並發 `turn.retrying` 事件（OpenAI 的 `insufficient_quota` 不重試）。
- `runner/cli`：用訂閱登入的命令列 AI 工具跑對話（Claude Code `claude -p`、Codex `codex exec`、Antigravity CLI `agy --print`），只用 `os/exec`。
  prompt 走 stdin、關掉工具（串流裡出現工具就殺掉程序）、每次一個空的暫存工作目錄、環境變數白名單（不給 `TANGENT_*`、資料庫 URL、API key）、
  取消或逾時殺掉整個程序群組、並行上限（預設 2）；沒裝、沒登入、額度用完（不重試）各有清楚的錯誤。參考伺服器的 provider 是
  `claude-cli`、`codex-cli`、`agy-cli`，可和 API provider 混用。適合個人使用，背景工作建議用 API（EMBEDDING §3.5）。

### 新增：參考伺服器與工具（`cmd/`、`scripts/`、`tangenttest/`）

- `cmd/tangent-server`（`make serve`，:8120）：只讀環境變數（見 `.env.example`）；Bearer token（至少 32 字元）、唯讀的 viewer token、
  `TANGENT_DEV=1` 只聽 localhost；依位址與 token 的速率限制；`TANGENT_FEATURES` 選功能與模式；`TANGENT_PRICING`、`TANGENT_ALLOWED_MODELS`；
  可服務建置好的 demo UI（`TANGENT_STATIC_DIR`，附 CSP 等標頭）；`TANGENT_DEBUG_STATS=1` 開 `GET /debug/stats`。
- `cmd/tangent-eval`：fisheye 的 token 比較（`-mode fisheye`）與記憶召回評估（`-mode recall`）。
- `tangenttest`：每個測試一個乾淨 schema、假 Runner、事件收集器、測資產生器（`tangenttest/seed`）。
- `scripts/smoke.sh`（獨立資料庫與 port，每次重建）、`scripts/soak.sh`（長跑；預設全功能，1 小時約 43 萬請求、0 違反，見 `docs/devlog/B11-soak.md`）。

### 新增：Web 套件（`web/`，pnpm workspace）

不發布到 npm（`private: true`）；宿主從 repo 取用。

- `@tangent/client`：型別化的 HTTP / SSE 客戶端與純邏輯（支線樹、結論卡、匯出、地圖版面等），不依賴 React；`./testing` 給 mock。
- `@tangent/react`：Provider、i18n（`en`、`zh-TW`，依語言延遲載入）、TanStack Query 的 query key、設計 token（`--tg-*`，樣式限制在 `[data-tg-root]` 下）、
  基礎元件、版面外框、命令面板與快捷鍵；對話（Markdown、KaTeX、程式碼高亮）、支線流程與結論卡、大綱與地圖、章節、匯出、紀要、設定、搜尋，
  以及 P1–P3 各功能的介面（收尾、停車場、建議匣、獨立成新對話、樹平衡、目標與偏題、關聯線、魚眼預覽與地圖圖層、群組與合併、論證類型、折疊、發散與決定、記憶庫）。
- `@tangent/fonts`：可選的自架字體（SIL OFL 1.1），依文字分檔按需載入。
- `apps/demo`：示範應用（預設 mock，`VITE_TANGENT_API=http` 接真 API；含 420 寬的嵌入示範）；`web/e2e` 是 Playwright 測試（含 axe 無障礙檢查）。

### 新增：嵌入支援與文件

- `docs/EMBEDDING.md`：最小嵌入、選功能、執行 AI（同步、Dispatcher、自訂佇列、跨行程 worker）、宿主掛勾、認證與即時通道、遷移策略、維護迴圈、升級規則。
  文中每段 Go 程式碼都引用 `examples/embedding/` 裡會編譯、有測試的程式碼（`TestGuideSnippets` 檢查兩邊一致）。
- `examples/minimal-host/`：自己的路由與 API key 認證、`/api` 掛 httpapi、fake runner 的完整範例服務。
- `docs/API.md`：HTTP API 參考。

### 新增：後續強化（B13–B25、F8–F17、B10.1）

**後端**
- **B13**：備忘 `memo`（見上）；已結束的支線也能改名。
- **B14**：
  - `GET /search?root=` 只搜一棵樹。
  - `GET /lines/{id}/export`：整棵樹匯出，每條線最多 500 則，附 `truncated`。
  - `POST /lines/{id}/diverge/models`：同一題給 2–5 個模型平行開支線。
  - `POST /lines/{id}/seeds/batch`：一次停 1–20 顆種子，全存或全不存。
- **B15**：
  - 關聯種類 `relationKind`（`related` / `supports` / `contradicts` / `depends_on`，migration `015`），建立、修改與 AI 建議都帶。
  - `PUT /messages/{mid}/tag` 可以把論證類型改回 AI 草稿（`status: draft`）。
  - `GET /lines/{id}/tag-drafts`：整棵樹的論證類型草稿。
- **B16**（都隨正常回合附帶，沒有額外的模型呼叫）：
  - 第一輪回覆的 `[TOPIC]` 把較長的第一則問題要約成主線標題，或替目的超過 25 字的支線換成短目的；使用者在這輪期間手動改過的會保留。
  - 主線的 `[CHAPTER]` 在話題轉換時自動記一個章節切點（`chapters.changed`）。
  - 兩條規則放在 prompt 尾端的 `reply_lines` 區塊，不影響穩定段的快取。
  - 章節閒置門檻預設 2 小時 → 30 分鐘。fake runner 新增 `[fake:topic]`、`[fake:chapter]`。
- **B10.1**：`GET /memories?cursor=` 游標分頁（新的在前，`created_at DESC, id DESC`），回應多了 `nextCursor`（最後一頁是空字串）；不合法的游標回 `400 invalid_input`。`Engine.ListMemoriesPage` 回傳 `MemoryPage{Memories, NextCursor}`，`ListMemories` 保留。
- **B17**：
  - `POST /lines/{id}/suggestions/dismiss-all`：一次忽略整棵對話樹所有開放中的 AI 建議（回傳被忽略的建議，新的在前）。
  - `PATCH /lines/{id}/branch/card`：原地編輯已帶回支線的結論卡。更新卡片訊息並拿掉 `delivered`，父線下一輪重新帶入一次；收尾若仍是 merge 自動產生的，一起更新。父線回合進行中回 `409 parent_busy`，放卡的線已結束回 `409 parent_closed`，支線已不是已帶回回 `409 branch_closed`。
  - 結論卡（`kind=branch_card`）可以當 `POST /branches` 與 `/branches/preview` 的 `anchorMessageId`，從結論卡繼續追問；背景包最後一則引用這張卡。
- **B17.1**：編輯結論卡時在卡片訊息記下 `meta.editedAt`（資料庫時鐘），支線的 `BranchView.cardEditedAt` 帶出同一個時間；沒編輯過的卡不輸出這兩個欄位。下一輪送達後 `delivered` 回來，`editedAt` 保留。不需要 migration。
- **B18**（migration `016_line_organization`）：
  - 主線有資料夾與標籤（`Line.folder`、`Line.tags`，支線永遠是 `""` / `[]`）；`GET /lines?folder=&tag=` 篩選，`PATCH /lines/{id}` 可改；`POST /lines/folders/rename` 一次改名或取消資料夾；spinoff 的新主線繼承兩者。
  - `POST /lines/import`：把外部對話（主線最多 200 則、最多 20 條支線）一次寫成新主線，不呼叫模型、不排任何背景工作；支線 `origin: import`。
  - `POST /lines/{id}/branches/extract`：把線上任何連續的一段（包括中段）抽成支線，原位留下標記，或直接留下已送達的結論卡；摺疊、章節、下層支線與摘要一起處理。
  - `GET /lines/{id}/decompose`：不呼叫模型的拆解建議（可能的離題段、標籤、停車種子、同租戶的相關對話）。
- **B18.1**（不需要 migration）：
  - `GET /lines/organization`：整個租戶的資料夾（未封存與封存主線分開計數）與標籤（未封存主線的篇數），唯讀身分可用；`Engine.TenantOrganization`。
  - `GET /lines/{id}/decompose` 的中文建議標籤由伺服器清理：標題主題詞裡的雙字詞縫回完整的詞（「微分」「分幾」「幾何」→「微分幾何」），帶功能字的碎片（「何在」）丟掉，租戶已在用的標籤原樣保留；規則與前端 `filterSuggestedTags` 一致，再清一次結果不變。
  - 修正：extract 搬走一個結束在範圍最後一則的摺疊時，`fold.changed` 帶的 `toSeq` 是舊的；現在和資料庫一致。
- **B19**（不需要 migration；新欄位都是選填，舊的請求行為與回應不變）：
  - `POST /lines/import` 保留來源時間：對話、訊息、支線可帶 `createdAt`（RFC 3339，轉 UTC，1970 到現在 + 24 小時），同一條線的訊息時間隨 `seq` 不會倒退；對話的建立與最後活動時間跟著來源，舊對話不再全部排在「今天」，decompose 也能依時間間隔建議章節。
  - 匯入時一次寫入主線章節切點 `chapterCuts`（milestone，最多 20 個），以及 `status: "merged"` + `card` 的支線：結論卡寫在主線錨點那則的正後方、已送達，支線標為已帶回（`leaf` 開著時寫結論收尾）。
  - 修正：租戶已有的雙字標籤（例如「幾何」）剛好在標題主題詞裡時，建議標籤不再縫出「微分幾」。
  - **嵌入者注意**：`domain.PlanImport` 多一個 `now time.Time` 參數；`Engine.ImportLine` 不變，`store.ImportedLine` 多了 `Cuts`、`Leaves`。
- **B20**（不需要 migration；新路由，其他請求不變）：
  - `POST /lines/{id}/attach`（`lines.attach`）：把另一篇獨立對話整串（訊息、子支線、筆記、備忘、種子、結論收尾、章節切點、建議、群組）掛成這條線的支線，是「獨立成新對話」的反向。沒指定錨點時依時間挑：目標線上、時間不晚於來源開始的最後一則，都比較晚就掛在最新一則。`status: "merged"` 要帶結論卡，卡片接在目標線最後、已送達，支線標為已帶回；不帶時是進行中支線。
  - 來源的資料夾、標籤與匯入膠囊拿掉，標題變成支線目的；來源的目標刪除；與目標已開著重複的建議先過期。子支線深度一起加深，樹的支線上限把來源整棵樹算進去。
  - 修正：幾個「先讀主線再上鎖」的寫入（提案、全部忽略、開支線、筆記、種子、備忘、從訊息開新對話、主題切點、關聯線）在主線被併走時會寫到舊的樹；現在上鎖後再確認主線，必要時重試。
  - 修正：結論卡（`kind=branch_card`）的建立時間與前一則相隔超過 30 分鐘時，不再在結論卡正前方多切一個只有 1 張卡片的閒置章節（`B20.1`）。
  - **嵌入者注意**：`store.AttachLine` / `Engine.AttachLine` 是新的；錯誤碼沿用既有的（`archived`、`source_busy`、`branch_busy`、`branch_drafting`、`tree_limit`、`depth_*`、`move_no_anchor`、`anchor_not_found`）。
- **B21**（不需要 migration；只放寬上限，請求格式不變）：
  - `POST /lines/import`：主線 1–2,000 則（原 200）、最多 50 條支線（原 20）、每條支線 1–500 則（原 100）、`chapterCuts` 最多 50 個（原 20，仍受 `MilestoneMaxPerTree`）；錯誤訊息的數字跟著常數，錯誤碼不變。本文上限仍是 16 MiB。
  - `GET /lines/{id}/decompose` 讀最舊的 2,000 則（原 400）。
- **B22**（不需要 migration；新路由，其他請求不變）：
  - `POST /lines/import-analyze`（核心、讀，不寫資料庫、不發事件）：匯入前的預處理分析。送 1–200 個單元（問答輪次或整篇對話），回一棵主幹＋支線樹的提案（`domain.ImportAnalyzePlan`）：跨段穿插的同主題單元（`A → B → A → C → A → B`）縫合成同一個節點，每個節點是章節、支線（掛在哪個章節的哪一輪之後、草擬結論）或獨立對話，附理由。
  - API 的 Dispatcher 能同步跑一次請求時（新的 `RunnerDispatcher.RunOnce`，算進佇列上限與同時執行數；介面 `tangent.OnceRunner`）用預設模型問一次（最多 45 秒，`tangent.ImportAnalyzeTimeout`），回覆嚴格檢查並修補（`domain.ParseImportAnalyzeOutput`）；沒有模型、失敗、逾時或回覆不可用時改用確定性演算法 `domain.AnalyzeImportDeterministic`（`source: "heuristic"`），所以不會因模型而失敗；伺服器 log 記原因但不記對話內容。
  - 新的 Go API：`Engine.AnalyzeImport`、`RunnerDispatcher.RunOnce`、`tangent.RunnerFunc`、`domain.NormalizeImportAnalyzeInput`、`BuildImportAnalyzePrompt`（單元以 `U1…` 編號、內容當引用資料）。
- **B26**（只改模型端的 prompt；請求與回應、契約樣本、確定性演算法的輸出都不變）：
  - 匯入分析的 prompt 裡，每個單元從「問題前 300 字、回答前 200 字」改成：問題全文到 400 字（更長時前 300 … 後 100）、回答的首句與末句（各 ≤ 120 字，程式碼區塊整塊算一句）、回答關鍵詞一行（≤ 8 個，回答裡問題沒提過、區分性最高的詞，漢字顯示成整段詞組），與上一個單元相隔超過 30 分鐘時在標頭標 `+2d 3h`。
  - 整個 prompt 不超過 60,000 字：每單元平分，放不下時依序去掉末句、首句，最後只剩問題（縮短）與關鍵詞；200 個單元在所有上限時從 116,056 字降到 59,958 字。
  - 輸入上限拆成問題 600 字、回答 2,000 字（新常數 `domain.ImportAnalyzeQuestionRunes`、`ImportAnalyzeAnswerRunes`）；`ImportAnalyzeTextRunes`（300）改指確定性演算法讀的摘錄。
  - 新的 Go API：`domain.BuildImportAnalyzePromptWith`、`ImportAnalyzePromptOptions`、`ImportAnalyzeKeywordRanking`（`weights` 預設、`idf`）；`tangent-eval -mode import -import-keywords weights|idf`。
- **B23**（**需要核心 migration `017_branch_keep`**：`tangent_branch.kept_at`，可為 NULL、沒有預設值，不重寫資料列；三條新路由，其他請求不變）：
  - `PUT /lines/{id}/branch/keep`（`branches.keep`，功能 `aside`）：保留順口問，維護工作不再清它；取消保留後照原本的時間清除。`BranchView` 多 `keptAt`（沒保留時不出現），事件 `branch.changed` 多一個值 `kept`。建立順口問時可以直接帶 `keep: true`。
  - `POST /lines/{id}/branch/continue`（`branches.continue`，功能 `aside`）：接著問。答完的順口問換成一條新的進行中支線（預設 `investigate`），原本的問答搬進去（訊息的 `id` 與 `seq` 不變），順口問那條線刪除——**線的 id 會換**，回應的 `replacedLineId` 是舊的。已結束的順口問不會被改回 `open`。
  - `DELETE /lines/{id}/branch`（`branches.delete`，核心）：刪除一條已結束的支線與它底下的支線。只有已結束的順口問與 `discarded` 的支線可以（先前的主線、被合併進別的支線的除外），其他回新的錯誤碼 `409 branch_not_deletable`；底下還有進行中的支線回 `409 branch_busy`。父線上指向它的標記會留著。
  - `line.deleted` 現在也用在「樹還在、只刪掉幾條線」：`rootLineId` 是還在的主線，`lineIds` 第一個是被刪的支線（順口問過期被清時原本就是這樣）。
  - **嵌入者注意**：新的 `Engine.KeepBranch`、`ContinueAside`、`DeleteBranch`（`InTx` 的型別見 EMBEDDING §4.4；`DeleteBranch` 的掛勾在刪除之前執行）；`BranchInput.Keep`、`store.CreateBranchInput.Keep`；`Config.HostMeta` 多被問一個 op `branches.continue`。
- **B24**（**需要核心 migration `018_glossary`**：新表 `tangent_term`；五條新路由，既有回應只多兩處：`/capabilities` 多 `glossary`、匯出多 `terms`）：
  - 功能 `glossary`（名詞表，沒有 AI）：一棵樹一份「名詞 → 解釋」。`GET/POST /lines/{id}/terms`、`PATCH /terms/{tid}`、`DELETE /terms/{tid}`（204）、`GET /terms?q=&limit=&cursor=`（全租戶查，帶對話標題，封存的不列）；op `terms.create/update/delete`；事件 `terms.changed`；錯誤碼 `term_not_found`、`term_limit`、`term_exists`（extra `term`，`replace: true` 可覆寫）。每棵樹 300 筆、名詞 60 字、解釋 1,000 字（`Limits.Glossary`）。
  - **進 prompt 的只有名詞本身**：每一輪不快取的尾段多一個 `glossary` 區塊（記憶之後、回覆行規則之前），最多 300 token、超過時留最近更新的；穩定段不受影響（prompt 快取不變）。`PreviewTurn` 的 `budget` 多 owner `glossary`。
  - 從順口問存名詞會在同一個交易把順口問設成保留（回應的 `keptBranch`，事件 `branch.changed{kept}`）。
  - 樹搬動：detach 帶走子樹內存的名詞、attach 合併（重複的保留目標的）、刪除支線與清除順口問保留名詞、接著問把來源改到新支線。
  - **嵌入者注意**：`tangent.AllFeatures()` 多了 `Glossary()`（參考伺服器的預設也開）；新的 `Engine.ListTerms`、`CreateTerm`、`UpdateTerm`、`DeleteTerm`、`SearchTerms`（`InTx` 收到 `store.TermChange`）；`domain.Limits.Glossary`；prompt section key `glossary` 成為內建保留的 key（宿主同名區塊改名 `host:glossary`）；`store.AttachMoved` 多 `Terms`、`DroppedTerms`。
- **B25**（**需要核心 migration `019_import_batch_pin`**：新表 `tangent_import_batch`，`tangent_line` 多四個可為 NULL 的欄位；兩條新路由；既有回應不變，`LineView` 只在有值時多 `importBatchId`、`pinnedAt`）：
  - **參考伺服器的功能預設組**：`TANGENT_FEATURES` 接受 `essential`（主迴圈加不會自己呼叫模型的小幫手）、`standard`（沒設時的預設，不變）、`full`（`standard` + `fisheye` + `memory`），可和個別功能混用，後面的覆寫前面的，`none` 清掉前面全部。`memory` 用 fake embedder 時啟動記一行 WARN。
  - **匯入批次**：`POST /lines/import` 選填 `batchId`（客戶端產生的 UUID）、`batchLabel`；`GET /imports` 列出批次（`lineCount`、`standaloneCount`）；`DELETE /imports/{bid}?force=` 逐棵刪掉仍獨立、匯入後沒用過的樹（`kept[].reason`：`attached`、`busy`、`changed`），沒有留下的才刪批次。op `imports.delete`；錯誤碼 `import_batch_not_found`。復原匯入不再只限同一個瀏覽器分頁的 10 分鐘。
  - **對話釘選存在伺服器**：`PATCH /lines/{id}` 的 `pinned`（只有主線，不算活動）、`LineView.pinnedAt`、`GET /lines?pinned=true`（依釘選時間、不分頁、最多 200；一般列表的排序與游標不變）。attach 清掉釘選；spinoff 的新主線不繼承釘選與批次。
  - **嵌入者注意**：新的 `Engine.ImportBatches`、`Engine.DeleteImportBatch`（`InTx` 每棵樹收到 `store.DeletedTree`，刪批次列時收到 `store.RemovedImportBatch`）；`domain.ImportInput` 多 `BatchID`、`BatchLabel`；`tangent.LinePatch` 多 `Pinned`；`tangent.LineQuery` 多 `Pinned`；`domain.Line` 多 `ImportBatchID`、`PinnedAt`。

**Web**
- **F8**：
  - 訊息動作收斂成三顆加「⋯」，觸控用底部動作表。
  - 論證類型降噪與「待確認」卡、對話內搜尋、快捷鍵說明、置頂與改名。
  - 匯出：完整報告、備份 JSON、ADR、閃卡。
  - 修改並分岔、分岔重答（可換模型）、跨模型平行比較、費曼檢驗、回覆清單一次停進停車場。
  - 「前提已更新」提示。
- **F9**：
  - 主程式 JS 從 179.77 kB 降到 146.16 kB。
  - 關聯對話框可選四種種類；待確認卡讀整棵樹，「全部確認」後 10 秒內可復原。
  - 地圖雙指縮放、手機的「樹狀地圖」入口；字型先用系統中文字型（`local()`）。
  - 大綱的已結束支線分組；設定有快速套用與分組。
- **F10**：
  - 預設現代黑體，可在設定切換「書本襯線體」。
  - 開支線會判斷選取的是名詞還是句子，給 4 個快選問題、預填第一句問題，並能「開啟支線並送出問題」。
  - 框選工具列「秒問解釋」：不開視窗，直接開順口問並送出。
  - 備忘不必進專注模式：側欄「紀要｜備忘」、訊息與輸入框一鍵記成備忘、費曼檢驗。
  - 結論卡秒開，預填問題與結論，AI 草稿改成按需起草。
  - 順口問答完有收尾動作列；空白對話有引導卡；種子可以「直接問」。
- **F11**：
  - 順口問在地圖、大綱、分岔膠囊與支線列都標成「單輪葉節點」，裡面不能開支線。
  - `summarizeTopic`：長問題取最後那句真正在問的話當標題或目的。
  - 主線章節（2 章以上）在地圖畫成主線下方的主幹節點，在大綱上方是一列膠囊，都能跳到該章。
- **B10.1**：記憶庫清單底部有「載入更多」。
- **F12**（深度閱讀與多支線探索，設計稿 S1～S7）：
  - S1：順口問在訊息下方原地展開小卡：串流回答、停止生成、記進紀要、記成備忘、展開完整畫面、收合。
  - S2：AI 回覆內文標出已開支線的 excerpt（依最新支線狀態著色的虛線底線與 `↳`），桌面滑過或鍵盤 focus 顯示預覽卡，觸控用底部預覽表。
  - S3：一般模式右側欄可拖拉調整寬度（280～600px，雙擊重設 360px）；地圖第一次打開時自動縮放置中。
  - S4：慢速回覆的 3 階段計時膠囊與「停止生成」；一般模式下，其他支線在背景答完時跳出通知。
  - S5：待處理面板頂部的「全部｜停車種子 (n)｜AI 建議 (n)」篩選，「忽略全部」後暫留 5 秒的結果提示。
  - S6：結論卡「編輯結論」，卡上標「已修改・下一輪帶入」；「繼續追問」以結論卡為錨點開新支線，附待解問題的快選晶片。卡片改過後，之前從它開出的追問支線標「前提已更新」。兩者都由伺服器的 `editedAt` / `cardEditedAt` 判斷，重新整理或換裝置後一致（B17.1）。
  - S7：頂列 Token 膠囊在 80% / 95% 換成警告 / 危險色，點了展開上下文組成與 Token 明細。
- **F13**（資料夾、標籤、匯入、抽成支線、拆解建議，設計稿 S1～S5；對接 B18）：
  - S1：左側清單頂列「匯入對話」；單選 `#tag (n)` 篩選膠囊與篩選提示列；一層的分類資料夾（收合、改名、解散）；對話列最多 2 顆標籤膠囊加 `+n`。
  - S2：匯入對話框：貼上文字／Markdown 或上傳 ChatGPT、Claude、Gemini（JSON、Takeout HTML、Markdown）、Tangent 備份的匯出檔；多篇時選一篇；可把重問／重新生成還原成支線；預覽列可切換角色、移除訊息；設定標題、資料夾、標籤。上限（檔案 20 MB、body 16 MiB、主線 200 則等）在送出前檢查，超過 200 則分段匯入。不呼叫模型。
  - S3：訊息選單「從這則抽成支線…」：選起點與終點（從 AI 回覆打開時起點對齊到那一輪的提問），主線範圍加外框；預設「直接標為已帶回」，原位留一張結論卡。抽出後重新載入原線與新支線。
  - S4：匯入完成橫幅與右側 400px「拆解與整理建議」面板（手機為底部大面板）：中段岔題（抽成支線並留結論卡／原地折疊成摘要／略過）、章節切點、標籤與停車、相關對話（建立關聯、前往、獨立成新對話）。建議標籤經 `filterSuggestedTags` 過濾中文雙字碎詞。
  - S5：對話選單加「資料夾與標籤…」與「拆解與整理建議…」；資料夾與標籤彈窗自動存檔，標籤上限 12 個。
- **B18.1（Web）**：
  - 左側清單的標籤膠囊、資料夾與篇數、資料夾與標籤彈窗、匯入對話框都改用 `GET /lines/organization` 的全租戶資料（`getLineOrganization`、`useLineOrganization`，事件與寫入後重讀）；篩選一個標籤時其他膠囊的篇數不變。
  - 1 MiB 以上的匯入檔在 Web Worker 解析，畫面不卡，並顯示讀取中提示；需要 DOM 的 HTML 匯出仍在頁面解析。
  - mock 的 extract 照伺服器搬移摺疊與章節切點；mock decompose 用同一套標籤清理。
  - demo 的 F13 狀態抽成 `useF13Frame`（`shell.tsx` 701 → 643 行）。
- **F14**（多檔、多 Session 時間序拼圖匯入，設計稿 2026-11-02 S1～S4；對接 B19）：
  - S1：匯入對話框改成兩步（寬 880）。一次放入多個匯出檔（檔案膠囊列）；搜尋標題與首問、多選勾選；每篇有時間徽章（真實時間／檔案時間／未定時間）與已匯入過的提示（同一個瀏覽器工作階段內，以來源 id 判斷）。只勾 1 篇時按「快速匯入單篇」走 F13 的單篇表單。
  - S2：依時間由舊到新排列；拖拉或 Alt+↑／↓ 調整順序；沒有時間戳記的篇用檔案修改時間排序並標警告色，可以手動設定日期時間。「小展開」只列時間段、30 分鐘以上的斷點、重問與結尾，點一段才看原文。
  - S3：三種組裝方式：時間軸章節圖、主幹＋支線樹、批次獨立匯入（相鄰篇自動建立關聯）。偵測到時間穿插或超過 200 則時標「建議」，不自動切換。每個節點可改角色、選擇掛在哪一則之後；已帶回支線的結論卡預填、可直接修改。
  - S4：確認列的摘要隨模式與角色即時更新；「確認並純匯入」「確認結構並展開拆解建議」。匯入時送出每則訊息的來源時間、章節切點與已帶回的支線（B19）。匯入後 15 秒內可從提示「復原這次匯入」。手機為「時間序｜結構圖」分頁，匯入後顯示橫幅。
  - 主線：新的 `TimeGapDivider`（相鄰兩則相隔 30 分鐘以上時顯示「間隔 n 小時 n 分・時刻」，所有主線都有，`timeGaps={false}` 可關）；`ChapterStrip` 章節膠囊列帶日期（有匯入或手動切點、2 個以上章節時才出現）；拆解面板的章節切點標「依真實時間」。
  - client：解析器保留每則訊息的時間（transcript 也讀時間）；`import-timeline`、`import-assembly*`、`time-gaps` 純函式；mock import 照 B19 做日期檢查、章節切點與已帶回的支線；`filterSuggestedTags` 同步 B19 的「微分幾」修正。
  - 對話框的程式全部在延遲載入的 `import-dialog` chunk（gzip 42.6 kB）；主 JS 165.2 → 167.7 kB（上限 172）。
- **F14.1 + F15**（對接 B20）：
  - 每則訊息旁顯示時間（今天 `14:52`，其他天 `08/12 14:52`）；依時間空檔切的章節膠囊不再重複日期；匯入時建立的支線結論卡標「匯入時建立・08/12 15:22」。
  - mock 照伺服器規則產生時間空檔章節（間隔超過 30 分鐘、相鄰切點至少隔 3 則、里程碑優先，且不在結論卡正前方切閒置章節）。
  - 「復原這次匯入」延長為 10 分鐘：記在 `sessionStorage`，提示消失或重新整理後，畫面在這次匯入的任一條線上時橫幅仍有「復原這次匯入」。匯入的對話之後被併為支線時，復原會把它跟著刪掉（併進同一次匯入的對話）或保留並說明（併進其他對話）。
  - 拆解面板「相關對話」每列多「併為支線…」，底部「併入其他既有對話…」（可選主線超過 3 篇時可依標題篩選）：選掛在哪一則之後，預設「掛為支線並留結論卡（已帶回）」（結論必填、預填），或「掛為進行中支線」。完成後該列顯示「已併為支線」與「前往支線」。對話框在延遲載入的 `attach-line-dialog` chunk（gzip 2.9 kB）；主 JS 167.7 → 169.4 kB（上限 172）。
  - 修正：批次匯入時每篇只寫入快取、整批結束後統一重讀一次清單與資料夾計數，不再重複觸發 `GET /lines` 與 `GET /lines/organization`；底部提示改為 `z-40` 且支援窄螢幕換行，不再蓋住對話框按鈕或超出 375px 畫面（`B20.1`）。
- **F16**（對接 B21；不呼叫模型）：
  - 合併匯出檔（`exportType: "combined"`，例如瀏覽器擴充功能匯出的整個 Gemini 資料夾 `Gemini-Combined_雜談-*.json`）依話題轉換自動分篇：新提問和目前這篇（提問與回覆開頭）及上一輪都沒有共同的話題詞、也不是「那／另外／如果／為什麼…」這類追問開頭時切開；每篇以第一則提問為標題、資料夾沿用 `projectName`，依檔案順序各差 1 分鐘，排時間時保持原本順序。沒有逐則時間、超過 500 則的其他長對話累積 20 則後同樣依話題切開；任何一篇超過 500 則時在提問邊界切開。
  - 用戶端上限同步 2,000／50／500／50；「主幹＋支線樹」的預設角色不再超限（超過 500 則或支線已滿 50 條的篇改成章節，主線放不下再改成獨立對話），手動選的角色照舊檢查。上限文字改由常數帶入。
  - 第 2 步的資料夾預填來源檔帶的資料夾（使用者改過就不再帶入）。
  - 匯入、關聯與「復原這次匯入」遇到伺服器限流（`429 rate_limited`）時照 `Retry-After` 等待後重送（最多 6 次；`withRateLimitRetry`），復原一次最多刪 4 條；等待時確認列顯示「伺服器忙碌，稍候重試…」。
  - 分篇程式只在延遲載入的 `import-dialog`／`import-worker` chunk，復原在按下時才載入；主 JS 169.4 → 169.1 kB（上限 172）。
- **F16.1**（匯入第 2 步的大量段落整理；只改前端、不呼叫模型）：
  - 緊湊單行檢視：挑選 8 篇以上時預設開啟（可切回「詳細卡片」），每篇一列約 36px：勾選框、把手、角色膠囊、標題、「已合併 n 篇」、則數、展開鈕；5 篇以上時有篩選列（搜尋標題與首問、全部／§ 章節／↳ 支線／獨立對話、全選目前顯示）。
  - 多選與批次工具列：勾選（Shift＋點擊或 Shift＋空白鍵連選）後置頂顯示「已選 n 篇」與設為章節、掛為支線（可指定掛在哪個章節）、另存成獨立對話、合併成 1 篇。手機保留批次工具列。
  - 段落合併與拆回：批次「合併成 1 篇」、選單「與上一篇合併」、拖到章節的「⊕ 合併進 §N」；「拆回原本的 n 篇」還原成原本的段落與各自的修改。合併的段落匯入成一條對話。`@tangent/client` 新增 `addSessionMerge`、`removeSessionMerge`、`applySessionMerges`、`mergedOrigin`、`mergeMembers`、`applyBatchRole`、`moveSessionsToIndex`。
  - 拖放：右欄頂端置頂的三個分類區（設為主線章節、掛為支線、另存成獨立對話），右欄節點也有拖曳把手，拖到章節可「↳ 掛在 §N 下當支線」；抓起已勾選的一篇會拖整組；兩欄靠近上下緣時自動捲動。分類區與章節目標也能按下，套用到已勾選的段落（不用拖曳）。手機不顯示把手與分類區。
  - 拖放或批次動作需要時自動切到「主幹＋支線樹」，並在頂端狀態列說明（其他修改保留）。
  - 都在延遲載入的 `import-dialog` chunk；主 JS 169.1 kB（上限 172）。
- **F16.2**（對接 B22）：
  - 第 2 步頂端「✨ AI 智慧分析並畫出支線樹」：勾選 1～3 篇、共 6 則以上時預設「拆解對話內部的穿插問答輪次」（每一輪問答拆開再跨段縫合，1 篇大雜燴對話也能畫出樹；超過 200 輪改以整篇分析）。分析後自動切到「主幹＋支線樹」、套用縫合、標題、角色、掛載點與結論卡，摘要列寫出章節、支線、獨立對話數與是 AI 模型還是內建規則做的；「還原分析前狀態」完整還原。網路失敗時說明原因、什麼都不變，可再試一次；限流照 `Retry-After` 重送。
  - 右欄每個節點：「跨段整合 N 輪（#1, #3, #5）」與理由、一鍵改角色、支線的「掛在：§ ▾」、「查看／微調各輪問答」列出各輪，每輪的選單可移到其他節點或拆出成獨立支線／獨立對話（不用拖曳）。手機上分析列縮成一行，分析完自動切到「結構圖」。
  - 合併匯出檔分篇改成跨段縫合（`threadByTopicShifts`）：回到先前話題的提問併回那一篇，不再切成碎片；`ParsedConversation.threadedRounds` 記下整合了哪幾輪。
  - `@tangent/client` 新增 `analyzeImport`（mock 用 `analyzeImportLocal`，與伺服器的確定性演算法相同、不連網）、`expandSessionsToTurnUnits`、`sessionsToUnits`、`applyAnalyzePlanToAssembly`、`moveUnitBetweenNodes`、`syncAnalyzePlan`、`threadUnits`。都在延遲載入的 `import-dialog` chunk；主 JS 169.1 kB（上限 172）。
- **F17**（匯入第 2 步的心智圖工作區，Claude Design 2026-11-04；只改前端、不呼叫模型）：
  - 第 2 步對話框放大到 1340 × 840（第 1 步仍 880）。AiTreeBar 右側的檢視切換「心智圖工作區｜雙欄時間序清單」與全幅鈕；預設仍是清單，清單頂端與分析摘要旁有進入心智圖的入口。
  - 心智圖畫布：主線根節點 → 主幹章節（主幹線串連，「跨段整合 N 輪」與 #n 膠囊）→ 支線（「自 §1 的 #3 後分岔」錨點膠囊、結論卡一行）→ 底部獨立對話泳道；任何輸入都不重疊。圖例、縮放（25%～200%）與置中適應；「顯示穿插順序 #1→#6」把原本的時間順序畫回樹上，「n→n+1」標籤不重疊。分析前、時間軸、批次與 120 篇都能畫。
  - 右側 460px 節點問答明細欄：角色一鍵切換、支線掛載於（章節＋第幾輪之後）、合併進、AI 歸納理由、結論卡編輯、每輪「提問／回覆」（展開完整回覆）；選根節點時是主線的組裝方式、標題、資料夾與標籤。全幅時收起明細欄。
  - 拖放：拖節點到章節的「掛在 §k 下當支線｜合併進 §k」或獨立泳道；從明細欄拖單一輪到任一節點。每個拖放都有鍵盤／選單的做法；手機不拖曳，改用「把第 #n 輪移到…」底部表，穿插順序改成清單。
  - 分岔輪次被移走時支線改掛到該章節的前一輪（或第一輪）並以警告色標示「分岔點已移動」，直到確認或改掛；分析後手動改過再按重新分析會先確認。
  - `@tangent/client` 新增 `buildImportMindMapLayout`、`MINDMAP_METRICS`、`buildMindMapTrace`、`extractSessionRounds`、`reanchorFork`、`reanchorMovedForks`；測試樣本 `mindmapConversation`。都在延遲載入的 `import-dialog` chunk；主 JS 169.1 kB（上限 172）。
- **F20b**（接真 API 建置的主 JS；只改前端，行為不變）：`@tangent/client` 的 `normalizeBaseUrl`、`errorFromResponse`／`ERROR_TEXT_MAX`、`noteDraft`／`NOTE_TEXT_MAX` 搬到 `base-url.ts`、`error-response.ts`、`note-draft.ts`，由原檔轉出；匯出名稱、函式本體與 `createTangentClient` 的型別都沒有變。接真 API 建置（`VITE_TANGENT_API=http`）的主 JS 171.87 → 171.80 kB gzip，mock 建置 159.77 → 159.70 kB。
  - 量測結論（`docs/devlog/F20b-http-main-chunk.md`）：首屏會呼叫 16 個 client 方法，它們的解析程式碼就是主 JS 的大部分；把 client 改成動態載入能讓主 JS 降到 159.72 kB，但那只是把首屏必需的程式碼移到第二輪下載（HTTP/1.1 下首屏慢約 0.9 秒），所以沒有採用。
  - **預算調整（使用者 2026-11-14 決定）**：接真 API 建置的主 JS 上限從 172 kB 改為 **185 kB**；mock 建置維持 172 kB。兩種建置每張前端工單都要量。

### 已知限制

- **只支援一個 API 行程**：delta 序號與緩衝在 API 行程的記憶體裡；多個 API 行程需要共用的序號來源，尚未設計（DESIGN §12 B7.0；worker 可以在別的行程，見 EMBEDDING §3.4）。
- **真模型冒煙測試尚未跑過**（`TestRealModelSmoke`，需要 `TANGENT_REAL_SMOKE=1` 與 API key）；openai / anthropic runner 目前只有對假伺服器的測試。
- **fisheye 的回答品質尚未評估**：只做了 token 比較（三組固定樣本合計省 45%，短支線約多 4–5%），LLM 評分未跑；參考伺服器預設關閉 fisheye。
- **記憶的門檻尚未用真的 Embedder 校準**：相似度 0.30、半衰期 30 天、每輪 5 筆 / 1,500 token、整併 0.92 都是暫定值（`Limits.Memory`，宿主可改）；召回評估只用 fake Embedder 跑過。
  記憶的向量沒有 ANN 索引；`memory` 在參考伺服器預設關閉。
- promote 的成本隨被搬走的尾段長度成長（2,000 則約 100 ms）；2 個字的冷門搜尋在大型租戶約 90 ms；搜尋每一類只排序最新 200 筆符合的候選（DESIGN §12）。
- **`[TOPIC]` / `[CHAPTER]` 只在同一個行程完成的回合生效**：這一輪有沒有要求標記只記在記憶體裡。重啟後才完成的回合，或由沒有 `LoadTurn` 的另一個行程完成的回合，標記仍會被拿掉，但不改名、也不切章節（DESIGN §12.10）。
- Web 套件的公開 API 在 1.0 前仍可能變動（例如 i18n 已改為依語言載入，DESIGN §12 F5）。

[0.1.0]: https://github.com/Rynvex/tangent/releases/tag/v0.1.0
