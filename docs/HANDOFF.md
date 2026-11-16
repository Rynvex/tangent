# Tangent 交接文件

> **歷史交接紀錄**：本文件主要記錄截至 `2026-11-04` 的早期開發與審查里程碑（例如 `v0.1.0` 發布與開源配套已於後續完成）。最新功能與版本狀態請參閱 [CHANGELOG.md](../CHANGELOG.md) 與 [docs/devlog/](devlog/)。

更新：2026-11-04　HEAD：見 `git log`

## 0. 給新 session 的開場 prompt（整段貼上）

> 你是 Tangent 專案的協調者。先讀 `docs/HANDOFF.md`（本文件）、`CLAUDE.md`、`docs/ROADMAP.md`，
> 再依需要讀 `docs/DESIGN.md`（契約；§12 是依主題分組的目前有效決定，依時間的原始列在 `docs/design/DECISIONS_LOG.md`）。目前核心功能（後端與前端）都已完成。
> commit 不加 AI 署名。回覆使用者用繁體中文。

## 1. 這是什麼

可嵌入的 Go 函式庫：AI 對話可以從任一則訊息岔出支線，在支線裡討論，再帶著結構化的結論卡回到主線。附參考伺服器與 React Web UI，便於嵌入任何 Go + Postgres 宿主服務。

| 文件 | 用途 |
|---|---|
| `docs/DESIGN.md` | **契約**。§4 資料表、§5 不變條件、§6 Engine API、§7 HTTP API、§11 功能模組、§12 目前有效的決定（依主題分組） |
| `docs/design/DECISIONS_LOG.md` | 決定的依時間原始紀錄（只追加，不改舊列；含已被推翻的） |
| `docs/ROADMAP.md` | 步驟總表與狀態 |
| `docs/plan/BACKEND_PLAN.md` | 後端里程碑 B2.1–B10、同步點 C0–C4、完成條件、效能預算 |
| `docs/design/EXTENSIONS.md` | 19 個功能模組的清單與規格（P1–P3） |
| `docs/design/UI_DESIGN_BRIEF.md` | 前端設計需求（用語 §3） |
| `docs/design/prototype-v2/` | 原型與交接包（`handoff/` 的文字規格優先於原型） |
| `docs/design/UI_PROTOTYPE_REVIEW.md` | 原型審查、前端階段 F0–F6 |
| `docs/devlog/<步驟>.md` | 每個步驟的開發紀錄、偏離、留給下一步的問題 |

## 2. 目前狀態

### 已完成（全部已 commit）

| 步驟 | 內容 | 主要 commit |
|---|---|---|
| S0 | 骨架、DESIGN、docker compose、port 登記 | `bf59fb8` |
| S1 | `domain/` 純邏輯與測試 | `55a1c88` |
| S2 + B2.1 | `store/` Postgres、交易、migration（含死鎖修正） | `8e456b0`、`a21e571` |
| B3 | Engine、turn 協定、功能模組機制、第一批 6 個模組 | `62d122a`、`36c3e84`、`6dbc8b1` |
| B4 + B4.1 + B4.2 | runner（openai / anthropic / fake）、httpapi、參考伺服器、契約樣本、安全強化、串流標記過濾、部分回覆存檔 | `6134ea2`、`7b8ac3e`、`d7c4313` |
| B5 | 搜尋模組（pg_trgm）、F2 的 API 缺口、測資產生器、1 小時長跑 | `af6c0dc` |
| W0 / F0 | 前端 workspace、token、字體、基礎元件、外框、快捷鍵、mock | `239e72e`、`06c1c35`、`e26a1d4` |
| F1 | 對話介面接真 API、契約測試 | `0c44a9f`、`665076f`、`9a55735` |
| F2 | 支線流程、結論卡、大綱、地圖、匯出、章節、非模態預覽 | `4a67d91`、`ede5f4d`、`5d232c8` |
| F3 | 紀要、設定、功能開關呈現、420 嵌入示範、搜尋介面 | `2840936` |
| 外部審查 | R1（B4.2 + F1）、R2（F2 階段一）、R3（F2 階段二）、R4（B5，`9ba1ff1`）、R5（F3）全部處理完 | 見相關 devlog |

**測試數（2026-10-16）**：Go 634 通過（含子測試；3 個依設計跳過：真模型冒煙、兩個 EXPLAIN）；前端 vitest fonts 9、client 443、react 513、demo 66；
Playwright 87 通過、10 個依設計跳過（mock / real API / api-core 三個 project）。

**效能**（2,000 則主線、200 條支線、深度 6，p95）：BeginTurn 8.7 ms、CompleteTurn 7.9、ListBranches 4.9、Merge 12.1、Move 12.6、Promote 69.7、Search 14.5（預算見計畫 §2）。
長跑 1 小時：405k 請求、41k 回合、0 違反不變條件、0 伺服器錯誤、無洩漏。

### 進行中 / 待處理

1. **狀態（2026-10-23）**：P1–P3 前後端完成，外部審查 R1–R11 處理完；之後又完成：
   - **B11** 全功能長跑（`0e3137e`，1 小時 43 萬請求、0 違反，修了 4 個 bug）；**D1** CHANGELOG / v0.1.0 準備（`f59e4ed`）；**D2** DESIGN §12 依主題分組、歷史在 `DECISIONS_LOG.md`（`11eba39`）。
   - **B12 / B12.1** 命令列 runner：`claude-cli`、`codex-cli`、`agy-cli`（`be45ecd`、`bff04de`）。Claude 冒煙測試通過（真的 1 次呼叫）。
   - **B7.2 / B7.3** 宿主系統訊息與串流清理：`TurnResult.Notices`、`AppendSystemMessage`、`httpapi.Config.DeltaFilter`、清理順序與零寬字元（`043b418`、`c6df638`）。
   - **F7** 刪除對話（`eb1696a`）。
   - **v0.1.0 標籤**：還沒打；CHANGELOG 標「未發布」，打標籤時填日期，push 標籤前問使用者。
   - **本機測試環境**：參考伺服器 :8120（`TANGENT_DEV=1` 或 CLI／API 設定），web dev :5183（`VITE_TANGENT_API=http`；若需透過反向代理／Tailscale host 存取可設 `VITE_ALLOWED_HOSTS`）。
   - **UI 優化（2026-10-24）**：體檢 `docs/design/UI_AUDIT_2026-10.md`（27 項＋G1–G10）。
   - **專注模式**：規格 `docs/design/FOCUS_MODE.md`，設計稿第二版收在 `docs/design/focus-mode/`。**階段一（前端）2026-10-25 完成**：`docs/devlog/FM1-focus-mode.md`（驗收、和規格不同的地方、未完成項）。**階段二（B13）2026-10-25 完成**：後端 `memo` 功能（migration 014）、結束的支線改名（升為主線的與先前的主線仍拒絕）、前端的備忘分頁、「記成備忘」、結束支線的改名：`docs/devlog/B13-memo.md`。
   - **B14（後端）2026-10-25 完成**：`GET /search?root=`、`GET /lines/{id}/export`（每線 500 則＋`truncated`）、`POST /lines/{id}/diverge/models`、`POST /lines/{id}/seeds/batch`，沒有改 `web/`：`docs/devlog/B14-export-diverge-models.md`。前端 **F8** 隨後完成。
   - **F8（前端）2026-10-25 完成**：階段一～三（S1–S12）：訊息動作收斂與「⋯」、論證類型降噪與待確認卡、對話內搜尋、快捷鍵說明、置頂／改名／清單底部入口、匯出（完整報告、備份、ADR、閃卡）、修改並分岔、分岔重答、跨模型平行比較、費曼檢驗、清單存入停車場、前提已更新：`docs/devlog/F8-web.md`。主 JS 179.77 kB（F9 降到 146.16 kB）。兩個後端小補強在 B15 做了。
   - **B15＋F9 2026-10-25 完成**：`docs/devlog/B15-F9-polish.md`。
     - 後端 B15：關聯種類 `relationKind`（migration 015；related / supports / contradicts / depends_on；POST、PATCH、AI 建議）、`PUT /messages/{mid}/tag` 的 `status: draft`、`GET /lines/{id}/tag-drafts`（200 字摘錄、最多 500 筆、不含捨棄的支線）。Engine 新增 `EditRelation`、`SetMessageTag`，舊方法保留。
     - 前端 F9：主 JS 179.77 → **146.16 kB**（提示與側欄 sheet 延遲載入）；關聯對話框四種種類；「前提已更新」改看 `relationKind`；待確認卡讀整棵樹、可跨支線跳轉、「全部確認」後 10 秒內可復原；地圖雙指縮放；窄螢幕「樹狀地圖」入口；字型 `local()`；大綱已結束支線分組；設定的三組快速套用與四個分組。
   - **F10 2026-10-25 完成**（純前端）：`docs/devlog/F10-simple-ux.md`。
     - 字體預設現代黑體（`--tg-font-serif` 預設等於黑體堆疊），設定可切「書本襯線體」（`tg.readingFont`、`<html data-tg-reading-font>`）。
     - 開支線：依選取判斷名詞或句子，給 4 個快選問題，預填「第一句要問 AI 什麼」，目的自動跟著；主按鈕「開啟支線並送出問題」。框選工具列「秒問解釋」：不開對話框，直接開順口問並送出。
     - 備忘不必進專注模式：側欄「紀要｜備忘」、訊息 ⋯ 與輸入框的「存成備忘」、費曼檢驗。
     - 「結束並帶回」秒開預填（問題、結論），AI 草稿改成按需；順口問答完有收尾列；空白對話有三張引導卡；種子可以「直接問」。
     - 主 JS 146.16 → **150.2 kB**（上限 172）。
   - **B16＋F11 2026-10-26 完成**：`docs/devlog/B16-F11-leaf-topic-chapters.md`。
     - 後端 B16：
       - 第一輪回覆的 `[TOPIC]` 會改未命名或標題較長的主線標題，或目的超過 25 字的非順口問支線目的；第一輪期間使用者手動改過的保留。
       - 主線的 `[CHAPTER]` 會在該輪的使用者訊息記一個主題切點，並發 `chapters.changed`。
       - 兩條規則都在 prompt 尾端的 `reply_lines` 區塊；兩種標記一律從串流與存檔中拿掉，沒有額外模型呼叫。
       - 章節閒置門檻 2 小時 → 30 分鐘；fake runner 有 `[fake:topic]`、`[fake:chapter]`。
     - 前端 F11：
       - 順口問在地圖、大綱（預設顯示）、分岔膠囊與支線列都標成「單輪葉節點」，裡面不能開支線。
       - `summarizeTopic` 把長問題要約成標題與支線目的。
       - 主線章節（2 章以上）在地圖畫成主幹上的節點，在大綱上方是膠囊列，都能跳到該章。
     - 主 JS **151.68 kB**（上限 172）。
   - **B10.1＋收尾 2026-10-26 完成**：`docs/devlog/B10.1-final-cleanup.md`。
     - `GET /memories?cursor=` 游標分頁（`nextCursor`），記憶庫的卡片只分頁 active 記憶，有下一頁時底部顯示「載入更多」，被取代的舊版本另外讀一頁（最多 200 筆）。
     - CHANGELOG 補上 B13–B16、F8–F11、B10.1。
   - **B17 2026-10-30 完成**（只改後端）：`docs/devlog/B17-dismiss-all-card-edit.md`。
     - `POST /lines/{id}/suggestions/dismiss-all` 一次忽略整棵樹的開放建議；`PATCH /lines/{id}/branch/card` 編輯已帶回支線的結論卡（清掉 `delivered`，父線下一輪重新帶入一次；父線回合中回 `409 parent_busy`）；父線上的結論卡可以當開支線／預覽的錨點。
   - **F12 2026-10-30 完成**（只改 `web/`）：`docs/devlog/F12-ux-polish.md`。
     - S1 順口問原地展開、S2 字詞錨點、S3 側欄拖拉寬度與地圖自動符合、S4 慢速回覆階段與背景完成通知、S5 待處理篩選與忽略全部、S6 結論卡編輯與繼續追問、S7 Token 膠囊與上下文明細。
     - 主 JS **約 161.7 kB**（上限 172）。
   - **B17.1＋收尾 2026-10-30 完成**（後端＋前端）：`docs/devlog/B17.1-card-edited-at.md`（細節在 `docs/devlog/B17-dismiss-all-card-edit.md` 的 B17.1 追記）。
     - 編輯結論卡時記下 `meta.editedAt`（資料庫時鐘），大綱帶出 `BranchView.cardEditedAt`；「已修改・下一輪帶入」與「前提已更新」改成只看伺服器資料，重新整理、換裝置後一致。拿掉 `localStorage` 編輯紀錄。沒有 migration。
   - **B18 2026-10-30 完成**（只改後端）：`docs/devlog/B18-import-extract-organize.md`。
     - migration `016_line_organization`：主線 `folder`、`tags`（常數預設值，不改寫既有資料），`origin` 多 `import`。
     - 新路由：`POST /lines/import`、`POST /lines/folders/rename`、`POST /lines/{id}/branches/extract`（中段也可以，標記或已送達的結論卡留在原位）、`GET /lines/{id}/decompose`；`GET /lines` 可依 `folder` / `tag` 篩選。
   - **F13 2026-10-30 完成**（只改 `web/` 與 `docs/`）：`docs/devlog/F13-import-organize-decompose.md`，截圖在 `docs/devlog/screenshots/F13/`。
     - S1 左側清單資料夾與標籤篩選、S2 匯入對話框、S3 抽成支線對話框、S4 拆解建議面板、S5 對話選單與資料夾標籤彈窗。四個大元件都是延遲載入的 chunk。
     - 主 JS **約 164.7 kB**（上限 172）。
   - **B18.1 2026-11-01 完成**（後端＋前端，四階段）：`docs/devlog/B18.1-final-polish.md`。
     - `GET /lines/organization`（全租戶資料夾與標籤計數）；清單、彈窗、匯入對話框都改用它。沒有 migration，路由 89 → 90。
     - decompose 的中文建議標籤在伺服器清理：Go 與前端兩邊的規則同步（`domain/decompose_text.go` ↔ `web/packages/client/src/suggested-tags.ts`）。
     - 修正 extract 的 `fold.changed` 舊 `toSeq`；mock extract 照伺服器搬移摺疊與章節；`useF13Frame`；1 MiB 以上的匯入檔在 Web Worker 解析。
     - 主 JS **約 165.2 kB**（上限 172）；worker 是自己的 chunk（gzip 7.9 kB）。
   - **B19 2026-11-02 完成**（只改後端）：`docs/devlog/B19-import-timestamps-and-assembly.md`。
     - `POST /lines/import` 新的選填欄位：`createdAt`（對話、訊息、支線）、`chapterCuts`（milestone，最多 20 個）、支線 `status: "merged"` + `card`（結論卡在主線錨點正後方）。沒有 migration，舊請求不變。
     - `domain.PlanImport` 多一個 `now` 參數。
   - **F14 2026-11-03 完成**（對接 B19，只改 `web/` 與 `docs/`）：`docs/devlog/F14-chronological-multi-import.md`。
     - 匯入對話框改成兩步：多檔、搜尋與多選 → 時間序（小展開）與結構（時間軸章節圖／主幹＋支線樹／批次獨立匯入）→ 確認列。匯入後章節膠囊列帶日期、時間空檔分隔、結論卡在原位、拆解面板「依真實時間」，15 秒內可復原。
     - 測試數：vitest fonts 10、client 1,147、react 1,015、demo 218；Playwright 158 通過、3 個跳過；主 JS 167.7 kB（上限 172），對話框在 `import-dialog` chunk。
   - **B20 + F14.1 + F15 2026-11-03 完成**：`docs/devlog/B20-attach-line-and-f14-1-polish.md`。
     - 後端 `POST /lines/{id}/attach`：把另一篇獨立對話整棵樹掛成支線（已帶回並留結論卡，或進行中）。沒有 migration；新 sqlc 查詢在 `store/queries/attach.sql`。
     - 前端：訊息時間標籤、時間空檔章節不重複日期、卡片「匯入時建立」、mock 時間空檔章節、10 分鐘「復原這次匯入」（`sessionStorage`）、拆解面板「併為支線…」與「併入其他既有對話…」（`attach-line-dialog` lazy chunk）。
     - 測試數：go test 全過；smoke 905 → 929 個事件；vitest fonts 10、client 1,165、react 1,027、demo 226；Playwright 162 通過、3 個跳過；主 JS 169.5 kB（上限 172）。
   - **B20.1 2026-11-03 完成**：`docs/devlog/B20.1-final-polish.md`。
     - 修正 B20 留下的 5 項問題（`branch_card` 閒置章節、上鎖後確認主線、批次匯入 429 重抓、Toast `z-40` 與窄螢幕換行、`AttachLineDialog` 標題篩選）。
     - 測試數：go test 全過；smoke 929 個事件；vitest fonts 10、client 1,165、react 1,028、demo 226；主 JS **169,431 B**（上限 172 kB）。
   - **B21 + F16 2026-11-04 完成**：`docs/devlog/B21-long-combined-import.md`。
     - 後端 B21：`ImportMaxMessages` 2,000、`ImportMaxBranches` 50、`ImportMaxBranchMessages` 500、`ImportMaxChapterCuts` 50、`DecomposeMaxMessages` 2,000；沒有 migration（仍 016）。
     - 前端 F16：`text-terms.ts`、`import-topics.ts`、`import-combined-fixtures.ts`；`defaultRoles("tree")` 預設不超限；demo 上限文字用 `{limit}`、F14 第 2 步預填來源資料夾；`rate-limit-retry.ts` 處理 `429 rate_limited` 重試。
     - 測試數：go test 全過；smoke 929 個事件；vitest fonts 10、client 1,197、react 1,028、demo 230；Playwright f14＋f15（mock）7 通過；主 JS **169,136 B**（上限 172 kB）。
   - **F16.1 2026-11-04 完成**：`docs/devlog/F16.1-assembly-dnd-batch-merge.md`。只改前端，沒有 Go／migration（仍 016）。
     - client：`import-assembly-merge.ts`；demo `f14/` 支援緊湊檢視、篩選列、批次工具列、段落合併／無損拆回、右欄分類區與拖放。
   - **B22 + F16.2 2026-11-04 完成**：`docs/devlog/B22-ai-topic-tree-analysis.md`。沒有 migration（仍 016）。
     - 後端 B22：`POST /lines/import-analyze`（`Engine.AnalyzeImport`、`RunnerDispatcher.RunOnce`、`domain.BuildImportAnalyzePrompt`、`ParseImportAnalyzeOutput`、`AnalyzeImportDeterministic`）。
     - client：`analyzeImport`、`expandSessionsToTurnUnits`、`applyAnalyzePlanToAssembly`、`moveUnitBetweenNodes`、`syncAnalyzePlan`、`threadByTopicShifts`。
     - demo F16.2：第 2 步頂端「✨ AI 智慧分析並畫出支線樹」與各輪微調、跨段整合徽章。
   - **F17 2026-11-04 完成**：`docs/devlog/F17-import-mindmap-ui.md`。只改前端，沒有 migration（仍 016）、沒有 Go 或 API 變更。
     - client：`buildImportMindMapLayout`／`MINDMAP_METRICS`、`buildMindMapTrace`、`reanchorFork`／`reanchorMovedForks`、`extractSessionRounds`。
     - demo：第 2 步 1340 × 840、心智圖畫布、460px 節點問答明細欄、拖節點與拖單一輪、手機底部表、分岔點已移動警告、重新分析前確認。
   - 候選：記憶「帶入」做成伺服器概念；fisheye 品質評估與記憶門檻校準（embedding 需要 OpenAI 相容的 key 或本機 Ollama）；多個 API 行程。
   - dev 環境：:5444 是 `pgvector/pgvector:pg17`。

### 尚未做、需要使用者提供或決定
- **fisheye 的品質評估（`tangent-eval` 的 LLM 評分）先不跑**（使用者 2026-10-16 決定）：只做 token 比較，fisheye 在參考伺服器預設關閉，等有 key 再評估。
- **真模型冒煙測試從沒跑過**（沒有 API key）。需要使用者提供 Anthropic 或 OpenAI 相容的 key，設成環境變數 `TANGENT_REAL_SMOKE=1` + 對應 key 再跑。
- Base UI Select 的無障礙問題：已在本地繞過，使用者決定**不**向上游回報。

### 已接受的限制（DESIGN §12）
- promote 的成本隨被搬走的尾段長度成長（2,000 則約 100 ms）。
- 2 個字的冷門搜尋在大型租戶約 90 ms。
- 桌機的送出前預覽是對話旁的固定欄（偏離原型的浮層）。

## 3. 驗證與開發流程

1. **驗證**：
   - Go：`go vet ./...`、`go test ./... -count=1`（確認 DB 測試真的跑了，沒有 skip）、`gofmt -l .`、`make sqlc`、diff 檢查、`bash scripts/smoke.sh`。
   - 前端：`pnpm -C web typecheck`、**每個套件分別跑** `npx vitest run`（`web/packages/fonts`、`packages/client`、`packages/react`、`apps/demo`）、兩種建置（mock 與 `VITE_TANGENT_API=http`）。
     不要只看 `pnpm -C web test`：第一個套件失敗時後面的不會跑。
   - 前後端契約相連：前端測試讀 `httpapi/testdata/contract/*.json`。
2. **決定**：契約層面的決定寫進 DESIGN §12 最後的「新增決定」表（日期 + 內容），同時追加到 `docs/design/DECISIONS_LOG.md`。
3. **commit**：conventional commits，**不加 AI 署名**。

## 4. 環境

| 項目 | 值 |
|---|---|
| Postgres | docker `tangent-postgres`，`127.0.0.1:5444`，user / password `tangent`，db `tangent`、`tangent_test`（`make db-up`） |
| 參考伺服器 | `make serve`，`:8120`（設定見 `.env.example`；`TANGENT_TOKEN` 至少 32 字元，或 `TANGENT_DEV=1` 只聽 localhost） |
| Web dev | `pnpm -C web dev`，`:5183`，`/api` 代理到 8120；`VITE_TANGENT_API=http` 才接真 API，預設用 mock |
| smoke | `bash scripts/smoke.sh`（資料庫 `tangent_smoke`、port 8121，每次重建） |
| 長跑 | `scripts/soak.sh`（時間可設定；用獨立資料庫與 port） |
| e2e | `web/e2e`，Playwright 會自己啟動伺服器（每次用獨立資料庫與 port） |

## 5. 重要的設計事實（新 session 容易誤解的地方）

- 訊息 `seq` 是全域遞增，**同一條線內不連續**；delta 的 seq 是每個伺服器程序一個計數器，也不連續。只比大小，不能用 +1 判斷接續。
- 鎖順序 root → parent → child，一組 line 依 id 排序；事件只在 commit 之後發；line 鎖用 `FOR NO KEY UPDATE`。
- 執行 AI 的方式由宿主決定：`BeginTurn` / `CompleteTurn` 是契約；`CompleteTurn`、`AppendDelta`、`FinishJob` 只給執行端，httpapi 絕不開放。
- 功能模組是內建封閉集合，宿主用 `WithFeatures` 挑；核心程式碼不得寫「功能是否開啟」的判斷（走擴充點）。需要資料庫擴充的功能（search、之後的 memory）用功能專屬 migration。
- 前端：伺服器狀態只在 TanStack Query，SSE 事件只做 invalidate / 精準更新；樣式限制在 `[data-tg-root]` 下、只用 `--tg-*` token；介面用語「紀要」（不是筆記）、「收尾」= leaf。
- 主 JS 的預算（2026-11-14 使用者決定）：`pnpm -C web build`（mock）上限 172 kB gzip；`VITE_TANGENT_API=http pnpm -C web build`（接真 API）上限 **185 kB**。每張前端調整兩種都要量。首屏本來就要呼叫 16 個 client 方法，把 client 改成動態載入只是把同樣的程式碼移到第二輪下載、首屏更慢，不要用這個方式降數字（`docs/devlog/F20b-http-main-chunk.md`）。
- 進行中回覆的訊息 `content` 會定期存部分文字並記 `meta.streamSeq`；前端顯示「已存內容 + streamSeq 之後的 delta」。

## 6. 不要做的事
- 不要在 commit 加 AI 署名；不要把 API key 或本機憑證寫進任何檔案。
- 對外公開的動作（GitHub issue、公開 repo 等）要先問使用者。
