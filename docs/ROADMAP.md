# Tangent · Roadmap

> **歷史開發路線圖**：本文件主要記錄截至 `2026-11-04` 的實作階段與驗收總表。後續更新與最新發布狀態請參閱 [CHANGELOG.md](../CHANGELOG.md) 與 [docs/devlog/](devlog/)。
>
> **狀態（2026-11-04）**：後端 S0–S2、B2.1、B3、B4（含 B4.1、B4.2）、B5、B6（含 B6.1）、B8（含 B8.1、B8.2）、B9（含 B9.1）、B10、B12–B22（含 B17.1、B18.1、B20.1）、B10.1 完成；前端 W0、F0–F17（含 F14.1、F16.1、F16.2）與專注模式階段一完成；P1–P3 全部完成（同步點 C2–C4）；外部審查 R1–R5 處理完。
> 最近一步：F17（匯入第 2 步的心智圖工作區：檢視切換、心智圖畫布與穿插順序、460px 節點問答明細欄、拖放與手機底部表、分岔點移動警告、重新分析前確認；只改前端），見 `docs/devlog/F17-import-mindmap-ui.md`。再之前是 B22 + F16.2（`POST /lines/import-analyze` 匯入前的 AI 預處理分析：跨段穿插主題縫合 A→B→A→C→A→B 與支線樹提案，模型不可用時改用確定性演算法；第 2 步「✨ AI 智慧分析並畫出支線樹」、拆解對話內部輪次、節點上的跨段整合徽章與各輪微調；合併匯出檔改為跨段縫合分篇），見 `docs/devlog/B22-ai-topic-tree-analysis.md`。再之前是 F16.1（匯入第 2 步的大量段落整理：緊湊單行檢視與篩選列、多選與批次工具列、段落合併與無損拆回、右欄置頂拖放分類區與章節「掛在／合併進」、拖曳邊緣自動捲動；只改前端），見 `docs/devlog/F16.1-assembly-dnd-batch-merge.md`。再之前是 B21 + F16（匯入上限放寬為主線 2,000 則、50 條支線、每條 500 則、50 個章節切點，decompose 讀 2,000 則；合併匯出檔依話題轉換自動分篇、標題取各篇首問、資料夾沿用 `projectName`；樹狀模式預設角色不超限；F14 第 2 步預填來源資料夾），見 `docs/devlog/B21-long-combined-import.md`。再之前是 B20.1（結論卡不觸發閒置章節；`store/chapters.go`、`store/relations.go`、`store/seeds.go`、`store/groups.go` 上鎖後確認主線；批次匯入不重複重抓清單；Toast `z-40` 與 375px 換行；「併入其他既有對話…」標題篩選），見 `docs/devlog/B20.1-final-polish.md`。再之前是 B20 + F14.1 + F15（`POST /lines/{id}/attach` 把另一篇對話整棵樹併為支線；訊息時間標籤、時間空檔章節不重複日期、卡片「匯入時建立」、10 分鐘「復原這次匯入」；拆解面板「併為支線…」），見 `docs/devlog/B20-attach-line-and-f14-1-polish.md`。再之前是 F14（多檔、多 Session 時間序拼圖匯入：搜尋與多選、時間序與小展開、時間軸章節圖／主幹＋支線樹／批次獨立匯入、確認列與 15 秒復原；主線時間空檔分隔與帶日期的章節膠囊列；對接 B19），見 `docs/devlog/F14-chronological-multi-import.md`。再之前是 B19（`POST /lines/import` 保留來源時間 `createdAt`、一次寫入章節切點與已帶回結論卡的支線、修好「微分幾」標籤邊角；只改後端，前端在 F14），見 `docs/devlog/B19-import-timestamps-and-assembly.md`。再之前是 B18.1（`GET /lines/organization` 全租戶資料夾與標籤計數、decompose 中文建議標籤由伺服器清理、mock extract 搬移摺疊與章節、`useF13Frame`、大檔匯入在 Web Worker 解析；測試手冊劇本六），見 `docs/devlog/B18.1-final-polish.md`。再之前是 F13（設計稿 S1～S5：左側清單資料夾與標籤篩選、外部對話匯入、中段抽成支線、拆解建議面板、資料夾與標籤彈窗；對接 B18），見 `docs/devlog/F13-import-organize-decompose.md`。再之前是 B18（migration `016`：主線資料夾與標籤、`POST /lines/import` 匯入對話、`POST /lines/{id}/branches/extract` 中段抽成支線、`GET /lines/{id}/decompose` 拆解建議；只改後端，前端在 F13），見 `docs/devlog/B18-import-extract-organize.md`。再之前是 B17.1（結論卡編輯時間 `meta.editedAt` / `BranchView.cardEditedAt`，「已修改」與「前提已更新」跨裝置一致；CHANGELOG 與測試手冊收尾），見 `docs/devlog/B17.1-card-edited-at.md`。再之前是 F12（設計稿 S1～S7：順口問原地展開、字詞錨點、側欄寬度、慢速回覆、待處理篩選、結論卡編輯與追問、Token 膠囊），見 `docs/devlog/F12-ux-polish.md`。再之前是 B17（一鍵忽略建議 `dismiss-all`、結論卡編輯 `PATCH /branch/card`、從結論卡開支線；只改後端），見 `docs/devlog/B17-dismiss-all-card-edit.md`。再之前是 B10.1（`GET /memories` 游標分頁與記憶庫「載入更多」）與最終收尾（CHANGELOG、測試手冊），見 `docs/devlog/B10.1-final-cleanup.md`。之前是 B16＋F11（`docs/devlog/B16-F11-leaf-topic-chapters.md`）。
>
> 工作分成兩條線：後端見 `docs/plan/BACKEND_PLAN.md`（里程碑 B2.1–B10、同步點 C0–C4）；前端先由 Claude Design 依 `docs/design/UI_DESIGN_BRIEF.md` 出設計稿，再寫實作規劃。

每一步結束時必須：`go vet ./...`、`go test ./... -count=1` 全綠（有 web 之後加 `pnpm -C web typecheck test build`），
跑過 code review、處理 CRITICAL / HIGH，並在 `docs/devlog/` 留一份紀錄（做了什麼、偏離契約的地方、未完成項）。

| Step | 內容 | 驗收 |
|---|---|---|
| S0 | 專案骨架、DESIGN.md、docker compose、Makefile、port 登記 | `make db-up` 可連線 |
| S1 | `domain/`：純邏輯與測試（pack、card、render、draft、suggest、move、chapters、notes、summary、prompt、tokens） | 測試全綠；`domain` 只依賴標準函式庫與 uuid |
| S2 | `store/`：migrations、sqlc 查詢、所有交易（line、message、turn、branch create/merge/discard/move/promote、draft、notes、chapters、aside purge、tree delete/archive）+ `tangenttest.Open` | storage 測試（含併發測試）全綠 |
| S3 | root `tangent`：Engine、turn 協定、prompt 組裝、事件、delta 緩衝、Dispatcher、Job、TxHook、PromptContributor、TurnGate；功能模組機制（DESIGN §11），把 notes / chapters / aside / summary / card_draft / branch_suggest 做成第一批模組 | Engine 層整合測試：完整走過「建主線 → 對話 → 開支線 → 起草 → merge → 下一輪帶卡 → promote / move」；每個模組關閉時核心流程仍正常、路由與 prompt 不含該功能 |
| S4 | `runner/`（fake、openai 相容、anthropic）、`httpapi/`（含 SSE hub）、`cmd/tangent-server` | httpapi 整合測試；fake runner 下用 curl 走完整流程 |
| S5 | `web/`：client、react、demo | vitest、typecheck、build 全綠；Playwright e2e 對參考伺服器（fake runner）走完整流程 |
| S6 | 文件：README、嵌入指南 | — |
| S7 | 宿主整合範例與嵌入介面驗證 | — |
| S8 | 功能模組 P1：leaf、spinoff、parking、rebalance（見 `docs/design/EXTENSIONS.md`） | 每個模組：Engine 測試 + httpapi 測試 + UI + e2e；關閉時不影響核心 |
| S9 | 功能模組 P2：fisheye、group、relations、goal、open_loops | 同上；fisheye 要量測 token 節省與回答品質 |
| S10 | 功能模組 P3：memory（pgvector）、ibis、diverge、fold | 同上 |
