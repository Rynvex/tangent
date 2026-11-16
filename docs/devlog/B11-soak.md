# B11 · 全功能長跑

> 2026-10-22 ～ 23。工作單。前置：`B5-search-perf.md`「穩定性長跑」、`B8-p1.md`、`B9-p2.md`、`B10-p3.md`。
> 沒有 commit；沒有動 `web/`、`docs/DESIGN.md`、`docs/API.md`、`宿主專案`（需要協調者寫進文件的列在「給協調者」）。
> 只用 :5444 的 `tangent_soak`（長跑）/ `tangent_smoke`（smoke）/ `tangent_test`，伺服器 :8122、smoke :8121；fake runner + fake Embedder，**沒有呼叫任何付費 API**。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 通過 |
| `gofmt -l .`（不含 `web/`） | 無輸出 |
| `go test ./... -count=1` | 通過：**914** 個頂層測試 PASS、0 FAIL、5 SKIP（都是 opt-in：`TestRealModelSmoke` 沒金鑰、兩個 `_Explain`、`TestPerf_MemoryRecallWithinBudget`、`TestPerf_BranchTurnWithRebalance`）；DB 測試都實際連 :5444（`pgvector/pgvector:pg17`，`vector` 與 `pg_trgm` 都在） |
| `-race` | `go test -race -count=1 ./scripts/soak ./store .` 通過；`./scripts/soak` 另外 `-race -count=5` 連跑 5 次通過（迷你長跑穩定） |
| `sqlc` | `make sqlc` 重新產生（新增兩個查詢），`store/db` 與查詢檔一致 |
| `scripts/smoke.sh` | 通過（704 個事件） |
| 長跑 | **1 小時通過**（修正後的程式碼）：433,647 個請求、0 違反、0 失敗、0 個缺少的操作、28 項結束檢查全 0、伺服器日誌 0 行 ERROR。見「實際跑」 |

**注意：驗收是在「HEAD + 本步的改動」的快照上跑的**（`git archive HEAD` 再疊上本步的檔案）。跑最後一次長跑時，另一個 agent 正在 `cmd/tangent-server/`（`cli.go`、`config.go`、`models.go`、`runners.go`）與 `runner/cli/` 改到一半，工作目錄的伺服器暫時編譯不過；那些檔案不是本步的，我沒有動，也沒有算進上面的結果。

**TDD**：四個 tangent 的錯誤都是先寫重現的測試、看到紅（編譯失敗或斷言失敗），再修到綠，見「發現與修正的問題」。驅動程式是工具，邊寫邊測；它的檢查（分類、操作統計、必須做過的操作、資源比較、SQL 結束檢查）各有單元測試，SQL 檢查用一個真的資料庫測試（先在乾淨 schema 全 0，再種下每一種問題確認數得到）。

## 1. `scripts/soak.sh`

- `SOAK_FEATURES`（預設 `full`）：
  - `full`：`notes,chapters,aside,summary:auto,card_draft,branch_suggest:auto,search,leaf:auto,parking,spinoff,rebalance:auto,goal:auto,relations:auto,open_loops,fisheye,group:auto,ibis:suggest,fold:auto,diverge:manual,memory:suggest`，`TANGENT_EMBEDDER=fake`，驅動程式帶 `-require-ops`（每一種操作至少成功一次，否則失敗）。
  - `default`：參考伺服器的預設功能（`TANGENT_FEATURES` 留空）；`<清單>`：自己給的 `TANGENT_FEATURES`。
- 模式的選擇：auto 和 suggest 行為不同的（`summary` 自動 compact、`leaf` 直接確認、`goal` 直接寫目標）都開 auto，讓背景 job 真的跑；`rebalance`、`relations`、`group`、`fold`、`branch_suggest` 的 auto 等同 suggest，也寫 auto。
  例外：`ibis` 用 **suggest**（auto 寫的是 confirmed，就沒有「AI 草稿」可以確認）；`memory` 依工作單用 suggest（擷取經過建議匣）；`diverge` 在任何模式都是使用者按了才做（manual）。
- **新檢查：伺服器日誌不能有 `level=ERROR`**（fake runner 刻意的失敗都是 WARN）。這一條抓到了下面三個問題。
- 其餘同 B5：每次重建 `tangent_soak`、build、`TANGENT_DEBUG_STATS=1`、`TANGENT_MAINTAIN_INTERVAL=10s`、放寬速率限制、SIGTERM 後確認 exit 0。

## 2. 驅動程式（`scripts/soak/`）

開始時讀 `/capabilities`，只做開著的功能的操作（`ops.go` 的加權表；`SOAK_FEATURES=default` 時 P1–P3 的操作自動不出現）。檔案：`ops.go`（表與抽選）、`p1.go`、`p2.go`、`p3.go`、`memory.go`、`expectations.go`（必須做過的操作、資源比較）、`report.go`（結束檢查）。

| 權重 | 操作 | 內容 |
|---|---|---|
| 核心 72 | 回合、開支線、merge、discard（leaf 開著時一半帶 `dead_end` 收尾）、promote、move、同時送兩則、搜尋、旁支呼叫 | 同 B5；旁支呼叫多了 milestone；訊息多了 `[fake:drift]` 與長訊息（讓章節夠長） |
| P1 6 | 建議匣 | 讀整棵樹的 open 建議，1/3 略過、2/3 接受；接受的本文依種類（樹平衡選 payload 的 `actions` 之一；記憶帶 importance），接受成 spinoff 的支線記下來最後一起刪 |
| P1 3 | 收尾 | 任一支線：PUT（檢查回來是 confirmed）/ DELETE / 請 AI 起草 / GET |
| P1 3 | 停車場 | 新增，或對 open 的種子展開（新支線加入可操作的線）/ 記進紀要 / 丟掉 |
| P1 2 | 獨立成新對話 | fresh（從一則訊息）或 detach（支線），1/3 只預覽；新主線記下來最後刪 |
| P1 2 | 一路深入 | 在一條支線連續 5 回合（觸發 rebalance 的 `recent`），沒有支線就先開一條 |
| P2 2 | 目標 | PUT（檢查 `rootLineId` 是主線）/ DELETE / AI 提案 / GET |
| P2 2 | 關聯 | 在樹內或對 spinoff 出去的對話畫一條（一半從訊息出發），之後 2/3 改說明或刪掉一條 |
| P2 1 | 未結事項 | `GET /open-loops`（一半帶 `root`、`staleDays=1`），檢查有 `staleBranches` |
| P2 2 | 群組 | 用 2–3 條已結束、有收尾（或 merge）的支線建群組；之後 3/4 改名 / 重寫摘要 / 解散 |
| P2 2 | 合併支線 | 同一條父線下兩條進行中的支線 combine（一半帶一個矛盾），檢查舊支線 `discarded` 且 `mergedIntoLineId` 指向新支線 |
| P2 1 | 釘選 | 釘一則完成的訊息（檢查 `pinned`），一半再取消 |
| P2 — | 魚眼 | 所有預覽（旁支呼叫、折疊、記憶召回）在 fisheye 開著時都必須帶 `fisheye` |
| P3 3 | 論證類型 | 有 AI 草稿時 2/3 確認它（PUT 同一種）；否則 設 / 改成別種 / 清，每次檢查回來的標記是使用者的、confirmed |
| P3 3 | 折疊 | 在最新 150 則內摺 2–6 則：一半帶摘要（必須 `active`）、一半讓 AI 起草（必須 `drafting`）；或改摘要 / 收回。帶摘要建好之後**馬上預覽，`folds` 必須含它**（並計「與魚眼並用」） |
| P3 2 | 發散 → 收斂 → 決定 | 3/4 先從一則訊息 diverge 2–3 個方向並等支線出現（30 秒）；再對兩條進行中的兄弟支線 converge（一半帶 criteria）、等 `ready`；4/5 decide 並檢查（見下） |
| P3 3 | 記憶 | 租戶共用：新增（一半帶 `sourceLineId`）/ 列表（active、superseded、all）/ 用某筆的原文搜尋（必須找到東西）/ 召回（用原文預覽，`memories` 必須非空）/ 改 importance / 取代（檢查舊的 `supersededBy` 指向新的） |

- **回應格式**：每個 2xx 有本文的回應必須是 JSON 物件，且能解碼成驅動程式讀的形狀，否則記為失敗（`shapeError`）；各操作另外檢查自己的承諾（上表）。
- **預期中的拒絕**：沿用 B5 的 `expectedCodes`，再依操作加上那個操作在忙碌的並行環境下會遇到的碼（例如種子的 `seed_not_open`、折疊的 `fold_overlap` / `invalid_fold`、記憶的 `memory_superseded`、建議的 `suggestion_not_open`）；別的 4xx、任何 5xx（503 除外）、格式錯誤都是失敗。
- **同時送兩則**改成兩則都帶 `[fake:wait=400ms]`，兩則都開始時比較兩則使用者訊息的 `createdAt`：相差不到 200 ms 才算違反（第一則不可能那麼快結束），否則記為「一前一後」。第一次 1 小時長跑有一次「兩則都開始」，舊的驅動程式分不出是真的同時還是第一則 10 ms 就答完了；改了之後最後一次 1 小時 2,807 次裡沒有兩則都開始的。
- `report.json` 新增 `features`、`operations`（每種操作 → 結果 → 次數，結果是 `ok`、`refused <碼>`、`skipped: <原因>`、`unexpected`、`failed` …）、`missingOperations`、`checkErrors`。

## 3. 檢查

**執行中**（違反就失敗）：B5 的全部（終態不逆轉、seq 遞增、每條線至多一則 pending、回合 3 分鐘內結束、delta seq 遞增），加上：同時開始兩回合（見上）；decide 的回應（選定的 `open` 且收尾是 `decision`；放棄的都 `discarded` 且收尾是 `dead_end`）與 decide 後重讀大綱（比較裡其他還掛在這條父線下的支線不能是 `open`）；新折疊出現在下一次預覽；記憶搜尋與召回找得到東西。

**結束時**（等伺服器安靜後查資料庫，全部必須是 0；`settle` 也等 drafting 的折疊與比較）：

| 檢查 | 內容 |
|---|---|
| B5 的 8 項 | pending 回覆、pending job、thinking 的線、同一條線兩則 pending、drafting 的支線、狀態與 `closed_at` 不一致、孤兒支線、merge 沒有卡片 |
| 卡住的 job（所有種類） | `pendingJobs`（所有 kind）＋`draftingFolds`、`draftingComparisons`、`draftingGroups`（active 群組的摘要） |
| 建議匣 | `suggestionsOnEndedBranches`（關於已結束支線的 open 建議）、`suggestionsOffTheirTree`（關於的線已不在這棵樹）、`suggestionsOnDeletedObjects`（payload 指向不存在的訊息或線：折疊兩端、偏題的 anchor、關聯兩端、群組成員） |
| 折疊 | `overlappingFolds`：同一條線 drafting / active 的折疊 seq 範圍不重疊 |
| 記憶 | `memorySupersedeCycles`（遞迴走 `superseded_by`，不能回到自己）、`activeMemoriesWithoutEmbedding` |
| 決定 | `decidedSiblingsOpen`（已決定的比較，其他還在同一父線下的支線不能是 open）、`decidedWithoutDecisionTime` |
| 其他 | `linesInTwoActiveGroups`、`activeGroupsWithOpenMembers`、`tagsOnUntaggableMessages` |
| 資源 | `goroutinesAboveStart`（結束 − 開始 − 10）、`heapAboveStartMB`（結束 − 開始 − 32 MB）、`inFlightAtEnd`（dispatcher 還持有的） |
| 覆蓋 | `-require-ops`：開著的功能的每一種操作至少成功一次（`expectations.go` 的清單；`seed to-note` 要 notes、「折疊與魚眼並用」要 fisheye、「確認 AI 草稿」要 ibis 在 suggest） |
| 日誌 | `soak.sh`：伺服器日誌沒有 `level=ERROR` |

## 4. 迷你長跑（`soak_test.go`）

測試伺服器開全部功能（同 `full`；memory 用 fake Embedder，schema 帶 `search`、`memory` 的功能 migration），3 個 worker 3 秒，檢查通過、事件有 delta、`features` 齊全、跑過至少 10 種操作。
迷你長跑**不要求**每種操作都做過（3 秒做不完，要求了就會因負載偶爾失敗）。`go test ./... -count=1` 下 3.6 s；`-race -count=5` 連跑 5 次通過。驅動程式套件的覆蓋率 64.8%（多數未覆蓋的是隨機才會走到的操作分支，由真的長跑覆蓋）。

## 5. 實際跑

| 執行 | 程式碼 | 時間 | 請求 | 結果 |
|---|---|---|---|---|
| 5 分鐘 #1 | 修正前 | 5 min | 36,439 | 失敗：驅動程式自己的錯（沒有收尾的 discard 送了 `null` 本文 → 50 次 400）；`group dissolve` 等三種沒做到 |
| 5 分鐘 #2 | 修了驅動程式 | 5 min | 34,999 | 只差 `group dissolve` 沒做到（seed 1 的 5 分鐘剛好沒抽到）；0 違反、0 失敗、結束檢查全 0 |
| **1 小時 #1** | 修正前 | 60 min | **424,189** | **失敗**：1 個違反（同時送兩則，見上）、2 個失敗（`accept relation` 400）、`suggestionsOnDeletedObjects` = 2；伺服器日誌 13 行 ERROR。→ 問題 1–4 |
| 5 分鐘 #3 | 修了 1、2 | 5 min | 34,996 | 只差 `group dissolve`；伺服器日誌 1 行 ERROR（goal_propose 的對話被刪，由問題 4 的修正涵蓋） |
| 10 分鐘 | 全部修正（seed 2） | 10 min | 76,356 | 通過，0 行 ERROR |
| **1 小時 #2** | **全部修正** | **60 min 03 s** | **433,647** | **通過** |
| 3 分鐘 | 之後把 `client.do`（60 行）與 DB 測試（63 行）各拆成兩個函式（純重構） | 3 min | 21,162 | 0 違反、0 失敗、0 行 ERROR、結束檢查全 0（3 分鐘只差 `group dissolve` 沒抽到，不算系統的問題） |

**最後一次 1 小時**（seed 1、8 個 worker、`full`）：

- 請求 433,647（約 120 / 秒）；回合開始 33,587（done 30,760、error 2,823、gone 4），retry 1,954；事件 575,761，`/events` 重連 0。
- **錯誤分類**：0 個 5xx、0 個非預期的拒絕、0 個格式錯誤、0 個違反、0 個缺少的操作、伺服器 0 行 ERROR。預期中的拒絕：`turn_pending` 6,699、`branch_closed` 1,410、`session_busy` 551、`source_busy` 488、`move_no_anchor` 386、`no_messages` 385、`branch_busy` 284、`parent_busy` 210、`invalid_fold` 209、`not_enough_messages` 201、`goal_not_found` 178、`leaf_not_found` 170、`parent_closed` 135、`move_protected_message` 132、`promote_not_top_level` 125、`fold_overlap` 93、`open_branches_on_old_tail` 79、`invalid_group` 34、`anchor_not_found` 16、`relation_exists` 12、`milestone_exists` 5、`invalid_parent_tip` 2、`branch_limit` 1、`memory_superseded` 1。
- 結束檢查 28 項全 0，安靜所需 0 s。p95 最高：`GET /search` 44 ms、merge 34 ms、combine 31 ms、discard 26 ms、promote 25 ms。

資源（每分鐘取樣，`?gc=1` 之後）：

| 時間 | goroutine | heap | Sys | pool 連線 | DB 連線（含驅動程式） | dispatcher 持有 | SSE |
|---|---|---|---|---|---|---|---|
| 開始 | 8 | 0.77 MB | 13.4 MB | 1 | 2 | 0 | 0 |
| 1 分 | 15 | 3.51 MB | 24.9 MB | 9 | 10 | 1 | 1 |
| 30 分 | 19 | 4.38 MB | 29.4 MB | 10 | 11 | 6 | 1 |
| 59 分 | 18 | 4.44 MB | 29.4 MB | 10 | 11 | 5 | 1 |
| 執行中範圍 | 13–28 | 3.5–4.7 MB | | 9–10 | 10–11 | 1–9 | 1 |
| 結束（安靜後） | **10** | **2.23 MB** | 29.4 MB | 2 | 3 | 0 | 0 |

heap 在執行中穩定在 4.2–4.7 MB（比 B5 的 3.0–3.2 MB 高，因為多了記憶、折疊、群組等快取與更多事件），結束後 2.2 MB；goroutine 回到 10（比開始多 2：驅動程式的 keep-alive 連線）；沒有看到洩漏。

**每種操作的次數**（最後一次 1 小時；「成功」之外的結果括號列出）：

| 操作 | 成功 | 其他結果 |
|---|---|---|
| 送出 `send` | 37,311 | turn_pending 3,608、branch_closed 894 |
| 取消 / retry | 3,501 / 1,954 | — |
| 開支線 / merge / discard / promote / move | 8,796 / 1,799 / 1,239 / 534 / 715 | 各種預期的 409 / 400（見上） |
| 同時送兩則 | 一則開始 2,395、都被拒 412 | 從沒有兩則同時開始 |
| 搜尋 / 預覽 / 支線預覽 / 改名 / 紀要 / compact / milestone | 3,665 / 2,724 / 1,883 / 448 / 2,274 / 590 / 577 | |
| 封存再解除 / 刪除整棵 / 留下封存 | 880 / 3,577 / 1,112 | 刪除時 session_busy 551（等一下再刪） |
| 釘選 / 取消 | 809 / 373 | |
| 建議匣：讀 / 略過 | 5,563 / 437 | |
| 接受：樹平衡 / 偏題 / 關聯 / 群組 / 記憶擷取 / 記憶整併 | 92 / 114 / 227 / 32 / 310 / 3 | 樹平衡 open_branches_on_old_tail 10、source_busy 7；群組 invalid_group 20 |
| 收尾：PUT / DELETE / 起草 / GET | 589 / 125 / 290 / 227 | leaf_not_found 170、no_messages 48 |
| 種子：新增 / 展開 / 記進紀要 / 丟掉 | 2,295 / 162 / 157 / 161 | |
| spinoff：fresh / detach / 預覽 | 751 / 144 / 562 | source_busy 144 |
| 一路深入 | 744 | 先開支線 985、中途停 111 |
| 目標：PUT / DELETE / AI 提案 / GET | 715 / 213 / 429 / 275 | goal_not_found 178 |
| 關聯：畫 / 改說明 / 刪 | 946 / 313 / 322 | relation_exists 8 |
| 未結事項 | 923 | |
| 群組：建 / 改名 / 重寫摘要 / 解散；合併支線 | 178 / 45 / 36 / 56；61 | combine 時兩條進行中的兄弟支線不夠 1,813 次 |
| 魚眼預覽 | 4,064 | |
| 論證類型：設 / 改 / 清 / 確認 AI 草稿 | 1,691 / 129 / 116 / 518 | |
| 折疊：帶摘要 / AI 起草 / 改摘要 / 收回 / 預覽裡看得到（與魚眼並用） | 957 / 959 / 95 / 97 / 957 | invalid_fold 209、fold_overlap 93 |
| diverge / converge / decide | 1,220 / 1,040 / 798 | diverge 開出支線 1,021 次、沒開出 199 次（job 失敗）；converge 後留著不決定 210、比較失敗 25 |
| 記憶：新增 / 列表 / 搜尋 / 召回 / 改 / 取代 | 1,198 / 2,698 / 386 / 383 / 313 / 418 | |

沒有發生的：接受折疊建議（章節要「已結束、≥ 8 則、≥ 1000 token、不是最後一章」，隨機對話很少湊齊；smoke 有固定流程涵蓋）、接受目標提案（`goal:auto` 直接寫成目標，不進建議匣）。兩者都不在必須清單裡。

## 6. 發現與修正的問題

### 問題 1：detach 帶走的線，舊樹裡指向它的關聯 / 群組建議沒有失效（第一次 1 小時：2 個失敗＋`suggestionsOnDeletedObjects` = 2）

關聯建議與群組建議的 `lineId` 是主線，payload 才寫兩端（`fromLineId` / `toLineId`）或成員（`members[].lineId`）。detach 只讓「關於那條支線」（`line_id`）的建議失效，所以一條支線被 detach（或被 rebalance 接受成 spinoff）之後，舊樹的建議匣裡還留著指向它的關聯 / 群組建議：
接受關聯回 **400 `invalid_input`**（「a relation starts in the conversation it is drawn from」——客戶端只送了 `{}`），接受群組回 422；之後那棵獨立出去的對話被刪掉，建議就指向不存在的線。另外也有反方向的競態：關聯 / 群組 job 在 detach 之前開始、之後才完成，提出的建議一開始就指向樹外的線。岔題清除（`aside.purge` 刪掉結束的岔題與底下的線）也是同一類。

修正（store，`store/suggestion_lines.go`、兩個新查詢 `ExpireSuggestionsNamingLines`、`CountLinesOutsideTree`）：
- `Detach` 在同一個交易裡讓舊樹中 payload 寫到被帶走的任何一條線的 open 建議失效（`SpunOff.ExpiredSuggestions`）；`purgeAside` 對被刪的線做同樣的事（`PurgedAside.ExpiredSuggestions`）。Engine 對它們發 `suggestion.changed`（＋主線的 `line.updated`）。
- `ProposeSuggestion` 不提 payload 寫到樹外（別棵樹或不存在）的線的建議。兩邊都在主線的鎖下做，不會互相漏掉。
- 測試：`store/b11_soak_test.go` `TestB11_ADetachExpiresTheOldTreesSuggestionsThatNameItsLines`、`TestB11_AProposalNamingALineOutsideTheTreeIsNotRaised`、`TestB11_APurgedAsideExpiresTheSuggestionsThatNameIt`（修正前編譯失敗；拿掉提案檢查時 `AProposal…` 斷言失敗）；`b11_soak_test.go` `TestB11_ADetachExpiresTheRelationSuggestionsNamingTheBranch`（接受變成 `suggestion_not_open`，修正前沒有 `suggestion.changed`）、`TestB11_ARelationJobFinishingAfterTheDetachRaisesNothing`（修正前提出了建議）。

### 問題 2：auto 目標的 job 完成時樹已封存 → ERROR「job result not recorded」（第一次 1 小時 6 行）

`goal:auto` 的 `goal_propose` job 完成時先把 job 標成 done，再寫目標；樹在 job 執行中被封存，`PutGoal` 回 `archived`，錯誤一路傳到 dispatcher，記成 ERROR「job result not recorded」——其實結果已經記錄（job done），只是封存的樹不收寫入。
修正（`feature_goal_jobs.go`）：auto 寫目標遇到 `archived` 時 WARN「an automatic goal was not written」並回 nil（同 memory auto 寫入失敗的處理）。測試：`TestB11_AnAutoGoalForAnArchivedConversationIsSkippedNotAnError`（修正前 FinishJob 回 `the conversation is archived`）。

### 問題 3：記憶整併掃描在對話被刪的那一刻整個失敗（第一次 1 小時 5 行 ERROR「maintenance failed … start memory_consolidate job: conversation not found」）

掃描找出的近似重複記憶要求至少一筆的來源線還在；在查詢與建立 job 之間那棵樹被刪掉，建立 job 回 `line_not_found`，**整個維護任務回錯**，同一輪後面的記憶對也沒開始。
修正（`feature_memory_consolidate.go`）：抽出 `consolidatePairs`；建立 job 遇到 `line_not_found` 就略過那一對（INFO，下一輪會再找到它，改用另一筆的來源線）。測試：`TestB11_ConsolidationSkipsAPairWhoseConversationWentInBetween`（`export_test.go` 的 `ConsolidatePairs`；修正前回 `start memory_consolidate job: conversation not found`、0 個 job）。

### 問題 4：job 的對話在完成途中被刪 → ERROR「job result not recorded … conversation not found」（第一次 1 小時 2 行 ibis_tag；5 分鐘 #3 1 行 goal_propose）

`Engine.FinishJob` 讀到 job 之後、handler 鎖線之前，那棵樹被刪（job 跟著 cascade 刪掉），handler 回 `line_not_found`，dispatcher 記成 ERROR。幾個 handler（ibis、比較、群組摘要、折疊、收尾、草稿）都是「先讀 job、再鎖線」，都有這個時間窗。
修正（`jobs.go`，集中處理）：handler 回錯而 job 已經不存在時，`FinishJob` 回 `job_not_found`（dispatcher 本來就把它當作「沒有要記錄的」）。job 還在時 handler 的錯誤照舊回。測試：`TestB11_AJobWhoseConversationWentWhileFinishingIsNotFound`（stub 功能在 handler 裡刪樹；修正前回 `conversation not found`；第二段確認 job 還在時錯誤不變）。

### 驅動程式自己的問題（已修，不是 tangent 的錯）

- 沒有收尾的 discard 把 nil map 送成 `null` 本文（400 `the body must be a JSON object`）。
- `coverage.go` 被 `.gitignore` 的 `coverage.*` 擋掉 → 改名 `expectations.go`。
- 同時送兩則的判斷分不出「真的同時」與「第一則已經答完」（見上）。
- 關聯 / 群組的後續動作（改說明、刪除、改名、解散）在一棵樹裡很少輪到 → 同一次操作裡先建、再對既有的做一個動作。

## 7. 給協調者

1. **API.md**（我沒有改，工作單不讓動）：`POST /lines/{id}/spinoff`（detach）的事件多了「舊樹中 payload 寫到被帶走的線的 open 建議 `suggestion.changed{expired}` ＋主線 `line.updated`」；建議匣一節可以補一句「關聯 / 群組建議寫到的線離開這棵樹（detach、岔題清除）時建議變 `expired`；寫到樹外的線的建議不會被提出」。岔題清除（maintenance）同樣發這些事件。
2. **DESIGN §12 建議的列**：
   - 建議的失效除了 `line_id` 之外，也看 payload 寫到的線（`fromLineId`、`toLineId`、`members[].lineId`）：離開樹就 expired、提案時就在樹外就不提（store 認得這三個欄位；之後的功能若在 payload 寫線，用同樣的欄位名）。
   - `Engine.FinishJob`：handler 失敗而 job 已不存在（隨對話刪除）時回 `job_not_found`。
   - auto 的 AI 寫入遇到已封存的樹：略過並 WARN，job 照樣 done（goal 與 memory 一致）。
   - 記憶整併：一對記憶的對話在掃描途中被刪，略過那一對，不讓整個維護任務失敗。
3. **長跑的規則**：`scripts/soak.sh` 預設 `full`，且伺服器日誌有 ERROR 就失敗；CLAUDE.md / HANDOFF 若有寫長跑的用法可以補 `SOAK_FEATURES`。
4. 觀察（沒有改）：`tangent: a suggestion was not recorded … conversation not found`、`a tagging job was not started … conversation not found` 這類 WARN 在樹被刪的同時偶爾出現，都是 WARN、沒有殘留狀態，我認為合理。

## 檔案

- 長跑：`scripts/soak.sh`；`scripts/soak/` 的 `main.go`、`worker.go`、`branches.go`、`client.go`、`checks.go`、`report.go`、`soak_test.go`、`checks_test.go`（改），`ops.go`、`p1.go`、`p2.go`、`p3.go`、`memory.go`、`expectations.go`、`checks_db_test.go`（新）。
- 修正：`jobs.go`、`feature_goal_jobs.go`、`feature_memory_consolidate.go`、`feature_spinoff.go`、`feature_aside.go`、`export_test.go`、`store/suggestions.go`、`store/spinoff.go`、`store/maintenance.go`、`store/queries/suggestions.sql`、`store/db/suggestions.sql.go`（sqlc）、`store/suggestion_lines.go`（新）；測試 `b11_soak_test.go`、`store/b11_soak_test.go`（新）。
- 最大的檔：`scripts/soak/report.go` 263 行；新函式都 ≤ 50 行。
