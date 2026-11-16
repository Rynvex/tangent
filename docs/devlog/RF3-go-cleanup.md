# RF3 · Go 小整理與每輪查詢數量測（行為不變）

> 2026-11-13。工單（工單 38，後端重構）。基線 `637fd5a`（含 B25；RF2 檔案改名**還沒做**，所以直接從這個 `main` 開始，沒有改任何檔名）。
> 在獨立 worktree 由一個實作 agent 完成，**未 commit**。中途因 API 速率限制中斷一次，接續時確認過工作區完整、可編譯、改動前指紋還在。
> 只改 Go 與 `docs/`；沒有改 `web/`、`store/migrations/`、`store/queries/`、`httpapi/testdata/`、`scripts/`，沒有改檔名。
> 沒有碰 宿主、:8120、:5183；零付費呼叫；開發資料庫 `tangent` 沒有寫入（測試都在 `tangent_test` 的暫存 schema）。

## 進度

- [x] 改動前指紋（scratchpad，Go 部分：契約樣本 sha256＋四個套件的 `go doc -all`）
- [x] 任務一：鎖主線輔助函式合併
- [x] 任務一：三個超過 50 行的函式抽步驟；AST 前後清單
- [x] 任務二：查詢計數輔助 `tangenttest.CountQueries`
- [x] 任務二：三種設定 × 主線／深度 3 的量測、重複查詢分析
- [x] 任務二：有上限的測試 `cmd/tangent-server/turn_queries_test.go`
- [x] 驗收關卡（見「驗收」）
- [x] 改動後指紋與 `diff -r`

## 驗收

| 檢查 | 結果 |
|---|---|
| `go build ./... && go vet ./...` | 通過 |
| `gofmt -l .` | 無輸出 |
| `~/go/bin/sqlc diff` | 乾淨（沒有改 `store/queries/`） |
| `TANGENT_TEST_REQUIRE_DB=1 go test ./... -count=1` | 16 個有測試的套件全部 ok（`store/db` 沒有測試檔）；**1,367 PASS、0 FAIL、6 SKIP**（同 B25 的 6 個刻意 SKIP：`TestRealModelSmoke`、`TestRealCLISmoke`、`TestPromote_Explain`、`TestSearch_Explain`、`TestPerf_MemoryRecallWithinBudget`、`TestPerf_BranchTurnWithRebalance`）；`REQUIRE_DB=1` 保證 DB 測試沒有因連不上而 SKIP；`store` 的併發測試（`*Concurrent*`、`*Racing*` 等 24 個）都 PASS。PASS 數含新的 `TestTurnQueries_StayWithinTheirCaps` 與它的三個子測試（core、standard、full） |
| `-race` | `go test -race ./store ./tangenttest ./domain`（整個套件）通過；根套件與 `cmd/tangent-server` 跑和改動相關的 `-run 'Note\|Chapter\|Goal\|Group\|Seed\|Parking\|Memo\|Term\|Glossary\|Extract\|Import\|Attach\|Detach\|Turn'` 通過 |
| 指紋 | 見下 |
| `bash scripts/smoke.sh` | **沒有跑**（依指示由協調者驗收時執行，基準事件數 1013） |
| 效能 | `perf_test.go` 與基線（`git archive HEAD` 解出的一份）輪流跑：BeginTurn p95 RF3 14.04／14.42／13.80／15.63 ms vs 基線 14.04／14.00／16.08／15.13；CompleteTurn 8.12／8.34／8.06／8.11 vs 7.72／7.74／8.32／8.70；MergeBranch 15.5／13.4 vs 18.8／14.7；MoveToBranch 19.8／14.1 vs 15.3／13.9；PromoteBranch（n=20）94.0／65.6／58.8／63.9／57.0 vs 60.2／61.6／61.4／70.8／57.1。差異在雜訊內（機器 load 約 3；第一次的 94 ms 之後四次都回到 57–64 ms），而且這些路徑沒有經過本工單改到的函式 |

### 指紋

P0 的檔案是在更早的 commit 量的（之後合併了 B23–B26），所以基準是本工單動手前在 `637fd5a` 上輸出的一份。worktree 沒有裝 web 依賴，只做 `fingerprint.sh` 的 Go 部分（第 1、2 段：契約樣本 sha256、`tangent`／`domain`／`store`／`httpapi` 的 `go doc -all`）；本工單沒有改 `web/`，web 匯出指紋不受影響。

```
$ bash fp.sh <scratch>/fp-before     # 動手前
$ bash fp.sh <scratch>/fp-after      # 完成後
$ diff -r <scratch>/fp-before <scratch>/fp-after && echo FINGERPRINT-IDENTICAL
FINGERPRINT-IDENTICAL
```

（`contract-sha256.txt`、`go-api-domain.txt`、`go-api-httpapi.txt`、`go-api-store.txt`、`go-api-tangent.txt` 五個檔完全相同；版本庫裡的 `docs/devlog/P0/` 沒有動。）

## 任務一：小整理

### 鎖主線的輔助函式

`git grep 'lock[A-Z][A-Za-z]*Root'`（不含測試）找到的同型函式與處置：

| 函式 | 做的事 | 處置 |
|---|---|---|
| `store/notes.go` `lockNoteRoot(tenant, lineID string)` | `s.lineRow`（租戶檢查）→ `lockRootOf` → 封存回 `ErrLineArchived` | **合併**為 `lockOpenRoot` |
| `store/goals.go` `lockGoalRoot(tenant, lineID string)` | `s.lineRow` → `lockSeedRoot`（= `lockRootOf` → 封存回 `ErrLineArchived`） | **合併**為 `lockOpenRoot`（與上一列逐步相同） |
| `store/seeds.go` `lockSeedRoot(lineID uuid.UUID)` | `lockRootOf` → 封存回 `ErrLineArchived`；**不做**租戶檢查（呼叫端已經讀過該租戶的線、種子、名詞或群組） | 不和上面兩個合併（少一個租戶檢查）；**改名**為中性的 `lockOpenRootOf` 並搬到 `branch_guard.go`，`lockOpenRoot` 就是「`lineRow` ＋ `lockOpenRootOf`」 |
| `store/branch_delete.go` `lockBranchUnderRoot` | 讀線 → 讀支線列（主線回 `ErrDeleteBranchIsMainLine`）→ 鎖主線 → 鎖支線 → 重讀比對 `root_line_id` | 不合併：鎖兩條線、錯誤值不同、沒有封存檢查 |

新函式都在 `store/branch_guard.go`，緊接在 `lockRootOf` 後面：

- `(s *Store) lockOpenRoot(ctx, q, tenant, lineID string)`：原 `lockNoteRoot`／`lockGoalRoot` 的呼叫端（`notes.go` ×2、`chapters.go` ×2、`goals.go` ×2、`groups.go` ×1）。
- `lockOpenRootOf(ctx, q, lineID uuid.UUID)`：原 `lockSeedRoot` 的呼叫端（`seeds.go` ×2、`seeds_batch.go`、`seed_end.go`、`memos.go`、`terms.go` ×2、`groups.go` 的 `lockActiveGroup`）。函式本體與註解（B13／B20 的重查說明）原樣搬過去；原來是 `*Store` 的方法但沒用到 `s`，改成普通函式。

`memos.go`、`terms.go`、`seeds.go`、`seeds_batch.go` 是「`lineRow` → `lockOpenRootOf(line.ID)`」，看起來可以改用 `lockOpenRoot`，但它們之後還要用 `line`（錨點、來源訊息、`keepSourceAside`），所以維持原樣，只換名字。

同樣呼叫 `lockRootOf`、但**沒有**合併的（行為不同）：

| 位置 | 差異 |
|---|---|
| `suggestions.go` `ProposeSuggestion`、`DismissOpenSuggestions` | 不拒絕封存（建議匣在封存的對話也能寫入／清掉） |
| `group_summary.go` `CompleteGroupSummary` | 不拒絕封存；之後鎖群組並比對 `root_line_id` |
| `spinoff_fresh.go` `lockFreshSource` | 還要鎖來源線本身；封存檢查是「來源**或**主線」；再檢查來源沒有進行中的回合（`ErrBranchSourceBusy`） |

鎖順序沒有變：每個呼叫端仍然是同一串查詢（`GetLine`／`GetBranch` → `GetLineForUpdate`（主線）→ `GetBranch` 重查），只是經過的函式名字不同。

### 超過 50 行的函式

用 `go/ast` 量（`func` 那一行到結尾的 `}`；不含 `_test.go`、`store/db/`、`web/`、`node_modules`）。工具在 scratchpad（`funclen/main.go`），基線是 `git archive HEAD` 解出來的一份。

| | 函式總數 | 超過 50 行 |
|---|---|---|
| 改動前（`637fd5a`） | 2,352 | `store/import.go` `ImportLine` 58、`domain/decompose.go` `cleanSuggestedTags` 54、`store/branch_extract.go` `extract` 53 |
| 改動後 | 2,357 | **無** |

（P0 數到 2,236 個函式、`ImportLine` 52 行；之後 B23–B26 加了程式碼，`ImportLine` 在 B25 又多了匯入批次的兩步。）功能軌（B23–B26）新加的程式碼沒有其他超過 50 行的函式；目前最長的是 `readExtractRange` 50、`applyNoteChange` 49。

| 函式 | 前 | 後 | 抽出的步驟 |
|---|---|---|---|
| `domain.cleanSuggestedTags` | 54 | 34 | `candidateTags`（13：正規化、去重、去掉自己的標籤／太長／碎片，保持排名順序）、`joinWordTerms`（10：標題主題詞內的漢字詞接回去並標記 handled，已用標籤不標記） |
| `store.(*Store).extract` | 53 | 38 | `extractPackBase`（9：範圍在摘要之後就把摘要帶進 pack base，回傳 `reset`）、`markExtracted`（16：留下標記訊息、保住章節起點、有卡片就收尾） |
| `store.(*Store).ImportLine` | 58 | 47 | `insertImportedLine`（10：寫入匯入的主線）、`importBranches`（14：依序開計畫裡的支線，收集 branch／line／leaf） |

`cleanSuggestedTags` 只搬移程式碼：判斷式、`handled[other] = handled[other] || !used[other]`、`add` 的呼叫順序都逐字保留；網頁的 `cleanSuggestedTags`（`web/packages/client/src/suggested-tags.ts`）也是同樣三段（先過濾 → 主迴圈 → 標題詞內接回／串接），規則仍一致。`domain` 的 `TestDecompose_CleanSuggestedTagsMatchesTheWebClient`（與網頁共用案例、再清一次不變）不改就通過。

## 任務二：每輪的查詢數

### 量法

- `tangenttest/querycount.go`：`QueryCounter` 是 `pgx.QueryTracer`，按 sqlc 名稱（`-- name: X`）計數，沒有名稱的取前 60 字（`begin`、`commit`、手寫 SQL）。`CountQueries(t, pool)` 用 `pool.Config()` 加上 tracer 另開一個連線池（同一個 schema），把要量的 engine 建在它上面。**沒有改任何產品程式或公開 API**；新增的只有 `tangenttest` 的測試輔助。
- `cmd/tangent-server/turn_queries_test.go`：設定照參考伺服器讀 `TANGENT_FEATURES` 的方式產生（`loadConfig`，`TANGENT_DEV=1`＝fake provider；`full` 的 memory 用 fake embedder），engine 的選項只有 `WithFeatures` 與 logger（伺服器的 pricing／預設模型／model check 不讀資料庫）。沒有 dispatcher：回合啟動的 job 只寫 job 列、不執行，所以量到的是回合本身的查詢。
- 樹：主線先跑 2 輪，再開深度 1、2、3 的支線（`ConfirmDeeper`）各跑 1 輪；然後主線量 10 輪、深度 3 量 10 輪。每輪分開記 `BeginTurn`（交易＋commit 後組 prompt）與 `CompleteTurn`（交易＋commit 後的 AfterCommit）。
- `TANGENT_QUERY_REPORT=1` 會印出每輪各查詢的次數。

### 結果（10 輪的範圍；數字含 `begin`／`commit`）

| 設定 | 線 | BeginTurn | CompleteTurn | 一輪合計 |
|---|---|---|---|---|
| 只開核心（無功能） | 主線 | 18 | 12 | **30**（每輪相同） |
| 只開核心 | 深度 3 | 22 | 11 | **33**（每輪相同） |
| `standard` | 主線 | 28 | 15–23 | **43–51** |
| `standard` | 深度 3 | 26 | 24–55 | **50–81** |
| `full`（＋fisheye、memory／fake embedder） | 主線 | 37 | 15–23 | **52–60** |
| `full` | 深度 3 | 35 | 24–55 | **59–90** |

CompleteTurn 的起伏來自功能的節奏：大約每三輪一次的標記 job（`LatestDoneJobInput`、`ListUntaggedChatMessages`、`SupersedePendingJobs`、`InsertJob`，多一個交易）；支線第 6 個回覆起 rebalance 讀訊號並提出建議（`RebalanceSignals` ＋ `ProposeSuggestion` 交易，+19～+31）。

只開核心、主線的一輪（30）：

- BeginTurn 交易（15）：`begin`、`GetLineForUpdate`、`GetBranch`（requireWritable）、`CountPendingMessages`、`ListUndeliveredCards`、`GetBranch`（prepareTurn 的 `rootOf`）、`GetNotesRevisions`、`InsertMessage` ×2、`TouchLine`、`SetLineStatus`、hydrate 三個（`CountBranchesByParents`、`ListBranchesByLineIDs`、`ListBranchUnreadByAncestors`）、`commit`；之前的 `CountOpenInbox`（`e.inbox`）；之後組 prompt 的 `GetLine`＋`ListRecentMessages`（`RecentMessages`）。
- CompleteTurn（12）：`CountOpenInbox`、`begin`、`GetLineForUpdate`、`GetMessage`、`CompletePendingMessage`、`ApplyTurnToLine`、`GetBranch`（`endAnsweredAside`）、`GetBranch`（`rootOf`）、hydrate 三個、`commit`。

### 重複的查詢（同一輪內）

| 查詢 | 次數 | 來源 | 性質 |
|---|---|---|---|
| `GetBranch`（主線 BeginTurn） | 2（standard 3） | `requireWritable` 讀線的支線列；`prepareTurn` 的 `rootOf` 再讀一次；standard 的 `ListChapters`（commit 後）又一次 | 同一主鍵重讀 |
| `GetBranch`（CompleteTurn） | 2 | `endAnsweredAside` 與 `rootOf` 讀同一列 | 同一主鍵重讀 |
| `GetBranch`（深度 3 BeginTurn） | 5 | `requireWritable` 沿祖先往上逐層讀（深度 d 讀 d+1 次）＋`rootOf` | **迴圈裡逐筆**（上限 `HardMaxDepth` 6） |
| `GetLine`（commit 後組 prompt） | standard 2、full 4 | `ListChapters`、`RecentMessages`、fisheye 的 `FisheyeTree`／`PinnedMessages`／`RecentMessages` 各自 `lineRow`（各自做租戶檢查） | 多個功能各自重讀同一列 |
| `ListActiveNotes`（full） | 2 | `notesContext` 與 fisheye 的 `fisheyeReferences` 各讀一次 | 多個功能各自重讀 |
| `GetBranch` ×4＋`GetLine` ×3（深度 3、rebalance 那幾輪） | | `RebalanceSignals`：`branchOfTenant` 讀一次，`BranchLineEnded` 從同一列開始再逐層往上讀支線列與父線；之後又 `GetLine` 父線一次 | 迴圈裡逐筆＋重讀 |
| `GetBranch` ×7、`GetLineForUpdate` ×2（深度 3、提出建議那幾輪） | | `ProposeSuggestion`：`lockRootOf`（`rootOf` ×2）、`lockProposalTarget`（`rootOf`＋`requireWritable` 逐層） | 迴圈裡逐筆 |

hydrate 的三個查詢在 BeginTurn 與 CompleteTurn 各一次，是兩個交易各自回傳線的檢視，不算重複。

### 有沒有改：**沒有改**

全部是主鍵查詢（每個約 0.1 ms 等級），一輪最多可省的幾個查詢相對於 30–90 個、以及 P0 量到的 BeginTurn／CompleteTurn p95（8.7 ms／7.9 ms，預算內很多）都不是問題，照工單的預設結果「量了，不用改」。可以做、但留給協調者決定的：

| # | 項目 | 可省 | 需要 |
|---|---|---|---|
| Q1 | 祖先逐層讀（`requireWritable`、`BranchLineEnded`、`lockProposalTarget`）改成一個遞迴 CTE 查詢 | 深度 d 的支線每輪 d 個（rebalance／建議那幾輪再 2d 個） | **改 `store/queries/*.sql`**（新查詢）→ 依規定先回報，沒有做 |
| Q2 | `prepareTurn` 沿用 `requireBranchAcceptsTurn` 已讀到的支線列算 root（不再 `rootOf`）；`CompleteTurn` 的 `endAnsweredAside` 與 `rootOf` 共用一次讀取 | 每輪 2 個 | 只改 Go（`store` 內部簽名），不動鎖順序與交易；但要改 guard 的回傳值 |
| Q3 | `RebalanceSignals` 把 `branchOfTenant` 讀到的列與父線傳給內部版的 `BranchLineEnded` | rebalance 那幾輪 2 個 | 只改 Go（新增未匯出函式） |
| Q4 | commit 後組 prompt 時，各功能共用一次 `lineRow`／root／`ActiveNotes` | standard 2–3、full 4–5 | 要讓 `store.ListChapters`／`RecentMessages`／`FisheyeTree`／`PinnedMessages` 接受已檢查過的線 → **改 store 公開 API**（指紋會變），不在本工單範圍 |

### 有上限的測試

`TestTurnQueries_StayWithinTheirCaps`（`cmd/tangent-server/turn_queries_test.go`）：每種設定、每條線跑 10 輪，任何一輪超過上限就失敗。上限＝量到的最大值＋約 10%：

| 設定 | 主線（量到最大 → 上限） | 深度 3（量到最大 → 上限） |
|---|---|---|
| 核心 | 30 → 33 | 33 → 36 |
| `standard` | 51 → 56 | 81 → 89 |
| `full` | 60 → 66 | 90 → 99 |

更新方式寫在檔頭註解：功能工單讓查詢變多時，用 `TANGENT_QUERY_REPORT=1` 跑這個測試看每個查詢的次數（新的是否預期、有沒有重讀），再把上限改成新的最大值加同樣的餘裕，數字記在那張工單的 devlog。放在 `cmd/tangent-server` 是因為三種設定要照參考伺服器讀 `TANGENT_FEATURES` 的方式產生（`loadConfig` 是 `package main` 的）。

找來源時臨時在 tracer 裡印呼叫堆疊（只在 scratch 用過，已移除，沒有留在程式碼裡）。

## 發現的問題（沒有修）

- 沒有發現行為上的 bug。
- `store.(*Store).BranchLineEnded` 是公開方法，迴圈上限是 `HardMaxDepth+1`，`requireWritable` 是 `HardMaxDepth`；兩者都是防呆上限，正常資料碰不到，只記下不一致。

## 之後值得做的項目

- 上面的 Q1–Q4（Q2、Q3 只改 Go、風險低；Q1 要新查詢；Q4 要改 store 公開 API）。
- `readExtractRange`（50 行）、`applyNoteChange`（49）貼著 50 行的界線，下次碰到時順手抽步驟。
- P0 的 `fingerprint.sh` 沒有 web 依賴時整支會失敗（`set -e` 遇到 node）；Go 部分可以分成獨立的模式，後端工單就不必裝 web。
