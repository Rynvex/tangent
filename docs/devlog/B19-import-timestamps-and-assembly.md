# B19 · 匯入保留歷史時間、一次寫入章節切點與已帶回結論卡的支線、主題詞標籤縫合邊角

> 2026-11-02。工單。基線 `main` @ `719ad78`（B18.1）。
> 實作 agent 在獨立 worktree（`../tangent-b19`，分支 `b19`）做，未 commit；CHANGELOG / HANDOFF / ROADMAP、合併與重啟 :8120 由協調者做。
> 沒有碰 宿主；沒有動 :8120、:5183；沒有寫 dev 資料庫 `tangent`；沒有新 migration（仍到 016）；沒有呼叫付費模型（測試只用 fake runner）。
> 沒有改 `web/` 底下任何檔案。

## 驗收

| 檢查 | 結果 |
|---|---|
| `~/go/bin/sqlc diff` | 沒有差異 |
| `go vet ./...`、`gofmt -s -l .` | 通過、沒有輸出 |
| `go test ./... -count=1` | 全部 ok（`-json` 計數：**1202 pass、0 fail、6 skip**，子測試也算；B18.1 是 1186） |
| `bash scripts/smoke.sh` | `SMOKE PASSED (905 events)`（開工時在 `main` 跑是 899；多的 6 個是 B19 區段的主線與支線 `line.created`、`branch.changed`、`leaf.changed`、`chapters.changed`、`line.deleted`） |
| `git status --short` | `web/` 底下沒有任何變動 |
| client vitest（唯讀） | **1067 passed**（78 個檔案）；基線 1065，多的 2 個是新樣本自動產生的契約測試（`contract.test.ts` 與 `mock-contract.test.ts` 各一） |

client vitest 的跑法：worktree 沒有 `node_modules`，為了不在 `web/` 底下安裝東西，在主 repo（同樣是 `719ad78`、`web/` 與 worktree 完全相同）
執行 `TANGENT_CONTRACT_DIR=<worktree>/httpapi/testdata/contract/ npx vitest run`（`contract-samples.ts` 讀這個環境變數），主 repo 的檔案沒有變動。
不帶環境變數時是 1065，確認新樣本確實被讀到。

### 契約樣本

- 新增 `httpapi/testdata/contract/route.lines.import.assembled.json`（新流程 `contract_b19_test.go` 的 `f.b19()`，接在 `f.b18()` 之後）：
  帶 `createdAt`（對話、訊息、支線，含一個 `+08:00` 的時間與一則沒有時間的訊息）、`chapterCuts` 兩個、一條 `status: "merged"` + `card` 的支線。
  回應形狀和 `route.lines.import.json` 相同（`line`、`branches`、`messageCount`），時間被樣本正規化成固定值。
- 既有樣本**一個都沒變**（`go test ./httpapi -update` 之後 `git status` 只有新檔）；B19 的事件排在既有事件之後，不會取代任何事件樣本。
- 前端的 `ImportBranchInput.status` 型別目前只有 `"open" | "discarded"`，但 client 照原樣送出本文，所以新樣本的請求比對與回應正規化都通過；F14 要補型別。

## 做了什麼

### 任務一：保留歷史時間（`createdAt`）

- `domain/import.go`：`ImportMessage.CreatedAt`、`ImportBranch.CreatedAt`（JSON `createdAt,omitempty`）、`ImportInput.CreatedAt`；`ImportPlan.Dates` 與
  `ImportPlanBranch.Dates`（`*domain.ImportDates{CreatedAt, LastActivityAt}`）。**整個請求沒有任何時間時 `Dates` 是 nil、訊息的 `CreatedAt` 也是 nil**，store 走原本的 `InsertMessage`，行為與 B18 完全相同。
- `domain/import_assembly.go`（新檔）：
  - `checkImportTime`：轉 UTC，零值、早於 `ImportEarliest`（1970-01-01Z）、晚於 `now + ImportFutureSlack`（24h）都是 `400 invalid_input`，`field` 是 `createdAt`、`messages[i].createdAt`、`branches[i].createdAt`、`branches[i].messages[j].createdAt`。
  - `planImportDates` / `dateImportLine`：只要有一個時間，每條線各自補齊：開始取線的 `createdAt` 與第一則有時間的訊息中**較早的**（都沒有就 `now`）；沒時間或比上一則早的訊息取上一則的時間（第一則取開始時間），所以時間隨 `seq` 不倒退；最後活動是最後一則的時間。輸入不被修改（複製每則訊息）。
- `PlanImport` 多一個 `now time.Time` 參數（domain 從不呼叫 `time.Now()`）；引擎傳 `e.now()`。
- SQL：`InsertMessageAt`（`messages.sql`）、`DateImportedLine`（`lines.sql`：`created_at`、`last_activity_at`、`updated_at = last_activity_at`）、`DateImportedBranch`（`branches.sql`：`created_at`，已結束的 `closed_at` 設成最後一則的時間）。
- `store/import.go`：有時間的訊息用 `InsertMessageAt`；支線寫完訊息、結束之後才標時間；主線在全部寫完之後標時間，再讀 `lineViewOf`，所以回應帶的是歷史時間。
- 效果：舊對話匯入後在左側清單依真實的最後活動排序；`GET /decompose` 對間隔 ≥ 30 分鐘的 user 訊息提出 `time_gap` 切點；章節檢視的閒置切點也看得到。

### 任務二：章節切點與已帶回的支線

**`chapterCuts`**
- `domain.ImportChapterCut{AnchorExternalID, Title}`；`planImportCuts`：最多 `ImportMaxChapterCuts`（20，也不超過 `Limits.Chapters.MilestoneMaxPerTree`）；錨點必須是主線的 `externalId`、一則一個；標題 `FlattenUntrusted` + `TrimSpace` 後 1–60 字（也不超過 `MilestoneTitleMaxRunes`）。
- `store/import_assembly.go` 的 `importCuts`：用 `AddMilestone` 同一個 `insertCut` 寫 `kind = milestone`，`created_by` 是匯入者。
- 引擎：`chapters` 開著且寫了切點時，commit 後發一個 `chapters.changed`。

**`status: "merged"` + `card`**
- `planImportCard`：`merged` 必須帶卡（`400 invalid_input`，`field: branches[i].card`），其他狀態不能帶（同上）；`question` 空的用支線 `purpose` 補；以**空的引用集**呼叫 `ValidateBranchCard`（匯入的訊息還沒有 id，`evidence`、`excerpts`、`needsDecision.mainLineMessageId` 都不能用），問題回 `422 invalid_card`，每個 `problems[].field` 加上 `branches[i].card.` 前綴；同時算好 `CardContent`（`RenderBranchCardMarkdown`）。
- HTTP（新檔 `httpapi/import_body.go`）：`createdAt` 以 `json.RawMessage` 讀，不是 RFC 3339 字串時 `400 invalid_input` 並指出欄位（如果直接解成 `time.Time`，整個本文會變成沒有 `field` 的「不是合法 JSON」）；卡片用 `DecodeBranchCardJSON` 解碼，和 merge / extract 一樣嚴格（未知、重複欄位是 `422 invalid_card`，`field: branches[i].card`）。`null` 一律當沒帶。
- 寫入順序（`insertImportedMain`）：先替每條支線產生 line id（`insertBranchAs`，`insertBranch` 改成呼叫它並傳 `uuid.New()`），寫每則主線訊息後，立刻寫錨點在它上面的 `merged` 支線的結論卡（同一錨點照輸入順序）：`role: system`、`kind: branch_card`、`meta.card`、`meta.branchLineId`、`meta.delivered: true`，時間同錨點（`InsertMessageAt`）。所以卡片的 `seq` 一定在錨點之後、下一則主線訊息之前。
- 支線寫完訊息後 `closeImported`：`discarded` 照舊；`merged` 由 `mergeImported` 寫 `status = merged`、`card_message_id`、`conclusion_line = BranchConclusionLine(card)`，`ImportLineInput.Leaves`（引擎在 `leaf` 開著時設）時用 `LeafFromCard` + `NormalizeLeaf` 寫 `confirmed` 葉子（同 extract 的 `closeExtracted`）。
- 背景包：`BuildPack` 拿到主線到錨點為止的列（含更早的卡片），`BuildBranchPack` 和一般開支線一樣只引用對話，不引用卡片。
- 事件（`importEvents`）：原本的 `line.created` / `line.created` + `branch.changed{created}`（`merged` 的也是 `created`），再加每個葉子的 `leaf.changed`、`chapters.changed`。全部在 commit 之後發。
- `ImportedLine` 多 `Cuts`、`Leaves`（給 InTx 與事件）；HTTP 回應的形狀不變。

### 任務三：`cleanSuggestedTags` 的邊角

- `domain/decompose.go`：收集 `inWord` 時不再排除租戶已用的標籤，所以「微分」「分幾」「幾何」（租戶已用）一起接成 `微分幾何`，不會再得到斷尾的 `微分幾`；租戶已用的標籤**不標 handled**，所以仍單獨保留（`幾何`）。
- 測試 `TestDecompose_ATenantTagInsideATitleWordNeverCutsItShort`：標題「微分幾何在物理研究中的應用」、候選 `微分 分幾 幾何 研究`，租戶標籤 `幾何` 排在 `微分` 之後、之前與最後三種順序，結果都有 `微分幾何`、`幾何`、`研究`，沒有 `微分幾`／`分幾`，再清一次不變；整個 `BuildDecomposePlan` 也驗一次。拿掉修正時這個測試失敗（得到 `["幾何","微分幾","研究"]` 等）。

### 測試

- domain（`domain/b19_test.go`）：沒時間就不標時間；UTC、補齊、不倒退；線的開始取較早的；範圍外的四個欄位（零值、1969、超過 24h、西元 99999）與邊界剛好可以；`chapterCuts` 的各種拒絕與 milestone 上限；`merged` 的卡（`question` 從 `purpose` 補、輸入沒被改）、缺卡、非 merged 帶卡、`invalid_card` 的欄位前綴。
- 引擎 + store（新檔 `b19_test.go`）：讀回 `Line.CreatedAt` / `LastActivityAt` / `UpdatedAt`、每則 `Message.CreatedAt`、支線的 `createdAt` / `closedAt`；清單依真實時間排序；decompose 找到 `time_gap`、章節檢視多一章；沒時間的匯入時間是現在；組裝匯入（rollback 不留任何列、事件順序、卡片位置與 meta、葉子、milestone 與章節起點、預覽沒有卡片通知、下一輪不帶卡、背景包）；功能關著時切點照寫、沒有 `chapters.changed` / 葉子；拒絕；同一錨點兩張卡照輸入順序、錨點是最後一則、上限內最長的卡寫葉子。
- 既有的 `TestImport_WritesTheConversationInOneTransactionWithoutAModel` 不改仍通過（舊請求不變）。
- HTTP（`httpapi/b19_routes_test.go`）：成功路徑（回應的歷史時間、卡片訊息、milestone）；新欄位的 `400`（非 RFC 3339、數字、1969、未來、支線訊息時間、缺卡、`null` 卡、非 merged 帶卡、未知錨點、空標題）與 `422`（未知卡片欄位、卡片不是物件、缺 conclusion、引用訊息）都檢查 `field`；新欄位全部 `null` 時等於沒帶。
- smoke B18 區段後加一段 B19：組裝匯入、`createdAt` / `lastActivityAt` / 支線 `createdAt` / `closedAt`、訊息種類順序與每則時間（含 `+09:00` 轉 UTC 與沒時間的那則）、卡片 `meta.delivered` 與補上的 `question`、milestone 標題與章節起點、預覽沒有卡片通知，最後刪掉。

## 和工單不同的地方

1. **`chapterCuts` 上限 20**：工單寫「`DecomposeMaxCuts` 或 20」；`DecomposeMaxCuts` 是 8，對 F14 多 Session 組裝太少，所以用新常數 `ImportMaxChapterCuts = 20`（同 `ImportMaxBranches`），也受 `MilestoneMaxPerTree` 限制。標題同時受 `MilestoneTitleMaxRunes` 限制。
2. **`chapters` 關著時切點照樣寫**：工單寫「當 chapters 開啟時（或 core store 寫入）」。`tangent_chapter_cut` 是核心表，`decompose`（核心）也讀切點，所以照寫，只是不發 `chapters.changed`。這和 `AddMilestone`（功能關著時 `feature_disabled`）不同，已寫進 API.md / DESIGN.md。
3. **時間倒退時不拒絕**：工單要求「單調不減」，沒說怎麼處理比上一則早的時間。匯出檔常有些微亂序（例如重新生成的回答），所以取上一則的時間（clamp），不回錯誤。
4. **線的 `createdAt` 晚於第一則訊息時取較早的**：工單寫「取主線最早時間（或 `in.CreatedAt`）」，這裡定義成兩者中較早的，線不會比它的第一則訊息晚開始。
5. **`PlanImport` 多一個 `now` 參數**：範圍檢查需要現在時間，domain 不呼叫 `time.Now()`。這是匯出的 domain API 的破壞性改動（B18 才加，引擎的 `Engine.ImportLine` 簽名沒變）；CHANGELOG 請協調者註明。
6. **支線列也標時間**：工單只說線與訊息；大綱的 `BranchView.createdAt` / `closedAt` 來自 `tangent_branch`，不標的話已帶回的歷史支線會顯示今天，所以 `DateImportedBranch` 一併標上（大綱照 `created_at` 排，歷史支線因此依時間排序）。
7. **卡片的時間同錨點訊息**：工單沒指定。同 extract 的卡片「時間同它取代的訊息」，主線時間不倒退、閒置切點不會在卡片處跳動。支線的 `closedAt` 是它最後一則訊息的時間，可能晚於卡片。
8. **`messageCount` 不含卡片**：仍是匯入的主線訊息數（`messages` 的則數），舊回應語意不變。
9. **卡片的 `question` 空時用 `purpose` 補**：照工單；`purpose` 本身沒給時是支線第一則 user 訊息的前 60 字，所以先算 `purpose` 再檢查卡片。卡片不能引用訊息（匯入時還沒有 id），工單沒寫。
10. **卡片錯誤的欄位前綴**：`invalid_card` 的 `problems[].field` 加上 `branches[i].card.`（merge / extract 是 `question` 這種沒有前綴的），才知道是哪一條支線。
11. **租戶已用的標籤在主題詞裡**：工單寫「若排在前面已被處理則保留」，沒說排在後面時怎樣。這裡兩種順序都保留它單獨一個（B18.1 的規則「租戶已在用的標籤原樣保留」，既有的 `TestDecompose_ChineseTagsAreWholeWords` 也要求），只是它也參與接合，所以不會出現 `微分幾`。
12. **事件**：`merged` 的匯入支線發 `branch.changed{created}`（同 B18 的 `discarded`），不是 `merged`；卡片不發 `message.created`（匯入的主線訊息本來就不發）。
13. **契約流程的位置**：新樣本在新的 `f.b19()`，`contract_test.go` 只加一行呼叫；沒有改任何既有樣本。

## 審查與修正

唯讀的 go-reviewer agent：沒有 CRITICAL / HIGH。處理的：
- MEDIUM：`chapters` 關著時照寫切點要寫進文件 → API.md 與 DESIGN.md 已寫。
- MEDIUM：`mergeImported` 裡 `NormalizeLeaf` 失敗會在交易裡晚失敗 → 確認 `LeafFromCard` 本來就把 line / body 截到葉子上限、`conclusion` 必填所以 line 不會空，不會失敗；加了上限內最長卡片寫葉子的測試。
- MEDIUM：`PlanImport` 簽名改變 → 留給協調者在 CHANGELOG 註明（見上「和工單不同的地方」5）。
- LOW：錯誤訊息寫死 `createdAt`（訊息與支線的欄位也用）→ 改成「the date is …」。
- LOW：每條線各自補時間，支線可能早於錨點；`closedAt` 晚於卡片；未來 24h 內的線會排在最前 → API.md 加說明，不改行為（照工單）。
- LOW：插卡片時每則訊息掃一次所有支線 → 改成先建「錨點 → merged 支線」的表。
- 測試缺口：同一錨點兩張卡的順序、錨點是最後一則、最長卡片的葉子、新欄位全部 `null` → 都加了。

沒有改的：混合匯入（只有支線有時間）時主線用應用程式時鐘 `e.now()` 而不是資料庫 `NOW()`（差別可忽略，審查也認為無害）。

## 留著的

- **F14 要同步前端**：`web/packages/client/src/suggested-tags.ts` 的 `filterSuggestedTags` 與 mock 的 decompose 仍是舊行為（租戶已用的雙字詞不參與主題詞接合，可能得到 `微分幾`）。B18.1 起兩邊保持一致，這次只改了 Go，F14 要照 `cleanSuggestedTags` 一起改（以及 `suggested-tags.test.ts` 加同樣的三種順序）。
- F14 還要：client 型別（`ImportMessageInput.createdAt`、`ImportBranchInput.status: "merged"`、`card`、`createdAt`、`ImportConversationInput.createdAt`、`chapterCuts`）、mock 的 import 支援新欄位（卡片位置、時間、milestone）。
- `docs/design/DECISIONS_LOG.md`（B18.1 有同步 DESIGN 的決定列）與 `docs/EMBEDDING.md`（B18 段落提到 `ImportLine`；`PlanImport` 的新參數、`ImportedLine.Cuts` / `Leaves`）不在這次允許修改的檔案內，請協調者決定是否同步。
- 匯入的已帶回支線發 `branch.changed{created}`；如果前端需要區分，可以之後改發 `merged`。

## 協調者驗證（2026-11-02）

- 在 worktree 重跑：`sqlc diff` 沒有差異；`go vet`、`gofmt -s -l` 沒有輸出；`go test ./... -count=1` 全部 ok；smoke `SMOKE PASSED (905 events)`；`web/` 沒有修改；migration 仍到 016。
- web client 用 `TANGENT_CONTRACT_DIR` 指向這個 worktree 的樣本：1,067 passed。
- 協調者補上 CHANGELOG（含 `domain.PlanImport` 多 `now` 參數的提醒）、HANDOFF、ROADMAP，並把 DESIGN 的 B19 決定列同步到 `docs/design/DECISIONS_LOG.md`，`docs/EMBEDDING.md` 補上 B19 的 `ImportLine` 與 `ImportedLine.Cuts` / `Leaves`。
