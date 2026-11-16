# B23 · 順口問的保留、接著問、刪除已結束的支線

> 2026-11-13。工單（工單 29，後端）。基線 `99e7901`。
> 在獨立 worktree 由一個實作 agent 完成，**未 commit**。
> 只改 Go、`store/queries/`、`store/migrations/`、`docs/`、契約樣本與 `scripts/smoke.sh`；沒有改 `web/`。
> 沒有碰 宿主；沒有動 :8120、:5183；沒有呼叫任何真實模型（測試全部用 fake runner）。
> **`bash scripts/smoke.sh` 沒有執行**（它用固定的 `tangent_smoke` 與 :8121，當時有其他 agent 平行工作）；B23 的步驟已加進去，留給協調者跑。
> D1–D3 使用者已確認，照建議值實作，寫進 `DESIGN.md` §12.10 與 `DECISIONS_LOG.md`。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 無輸出 |
| `gofmt -l .` | 無輸出 |
| `~/go/bin/sqlc diff` | 無差異（`store/db/` 由 `sqlc generate` 產生，沒有手改） |
| `go test ./... -count=1` | **全部 ok**，數字見最後一節；DB 測試實際執行（沒有因為連不到 :5444 而 skip） |
| API 文件檢查（`httpapi/apidoc_test.go`、`ops_doc_test.go`、`intx_doc_test.go`） | 通過（路由、op 表 70 列、事件與 `kept`、錯誤碼、樣本連結、InTx 表） |
| 既有契約樣本 | **沒有任何一份變動**（`git status --short httpapi/testdata/` 只有 4 個新檔） |
| `bash scripts/smoke.sh` | **沒有跑**。改跑了一份私有檢查：同一段 B23 步驟（從 `smoke.sh` 原樣取出）接上自己建的伺服器（:8137、資料庫 `tangent_b23_check`、`TANGENT_PROVIDER=fake`），全部通過，跑完資料庫已刪除。事件總數要等協調者跑完整的 smoke 才有 |

## 做了什麼

### Migration `017_branch_keep`

`ALTER TABLE tangent_branch ADD COLUMN kept_at TIMESTAMPTZ;`（可為 NULL、沒有預設值，不重寫資料列）；down 是 `DROP COLUMN IF EXISTS`。

### 保留：`PUT /lines/{id}/branch/keep`

- `store.KeepBranch`（`store/branch_keep.go`）：`lockBranch(withParent=false)` 鎖順口問那條線 → 不是順口問 `kind_unsupported`、封存 `archived` → 狀態有變才寫 `SetBranchKept`（`clock_timestamp()` 或 NULL）→ 回 `KeptBranch{Branch, Changed}`。
- `Engine.KeepBranch`（`branch_b23.go`）：功能 `aside`（先檢查功能再查線，所以別的租戶、關掉功能的租戶都得到 `feature_disabled`）；`Changed` 才發 `branch.changed{kept}`。
- 清除：`ListExpiredAsides` 加 `AND kept_at IS NULL`；`purgeAside` 鎖住後重讀時也看 `kept_at`（清單列出之後才被保留的不會被刪；把這個條件拿掉，`TestB23_AKeptAsideIsSkippedByThePurgeEvenWhenItWasListed` 15 次裡會失敗）。
- 建立時就保留：`BranchInput.Keep` / `store.CreateBranchInput.Keep` / `POST /branches` 的 `keep`；不是順口問 → `400 invalid_input`（`field: keep`）。

### 接著問：`POST /lines/{id}/branch/continue`

`Engine.ContinueAside` → `store.ContinueAside`（`store/branch_continue.go`）。

1. Engine（鎖外）：功能 `aside` → 正規化 `kind` → 讀順口問的大綱列（父線、錨點、目的、摘錄）→ 用父線照一般支線建背景包（`buildPack`，同 `CreateBranch`）。
2. Store（一個交易）：
   - `lockBranch(withParent=true)`：主線 → 父線 → 順口問；鎖住後確認父線與主線沒變（變了就 `errBranchMoved` 重試）。
   - 拒絕：不是順口問、封存、還是 `open`（`branch_busy`）、父線或錨點和建背景包時不同（`concurrent_change`）。
   - 子樹的線依 id 上鎖（`lockLines`），有線在回合中 → `branch_busy`；沒有完成的回答 → `no_messages`。
   - 父線照建立支線檢查（`checkBranchLimitsReplacing`，被取代的那條不算進整棵樹的數量）＋ `requireAnchor`。
   - `insertBranch`：`origin`、`excerpt`、`provider`、`model` 沿用順口問的。
   - `MoveDoneMessages`（所有 `done` 的訊息，`seq` 不變）→ `RehomeLinkEnds`（端點在搬走訊息上的連結跟到新線）→ 順口問的直接子支線 `ReparentBranches`（深度不變）。
   - `releaseLines`（見下）→ `DeleteLines`（順口問那條線）。
3. Engine（commit 後）：停掉跟著刪除的 job、清掉這個行程記的東西（`forgetLines`）、發事件、跑 AfterCommit（`commitBranchCreated`）。

### 刪除：`DELETE /lines/{id}/branch`

`Engine.DeleteBranch` → `store.DeleteBranch`（`store/branch_delete.go`）。

- `lockBranchUnderRoot`：不加鎖先讀（不存在 `line_not_found`、主線 `invalid_input`）→ 鎖主線 → 鎖這條線 → 重讀支線列，不是支線了或主線變了就 `errBranchMoved` 重試。
- 封存 `archived` → `domain.BranchDeletable` 不成立 `branch_not_deletable` → 子樹依 id 上鎖，有線在回合中 `branch_busy`、有 `open` 的支線 `branch_busy`。
- `releaseLines` → 掛勾（**刪除之前**，同 `DeleteTree`）→ `DeleteLines`。

### 共用：`store.releaseLines`（`store/lines_gone.go`）

接著問與刪除共用，回 `LinesGone`：

| 資料 | 做什麼 |
|---|---|
| 線與訊息的 `host_meta`、pending 的 job | `readDeletedTree` 讀出來（給宿主清理、給 Engine 停掉 job） |
| `tangent_note`（來源是這些線） | `labelMovingSources` 補上來源標籤（來源線要不見了） |
| `tangent_link`（端點在這些線上） | 先讀出來（連同兩端各自的主線），之後由 CASCADE 刪除；Engine 發 `link.changed{deleted}` |
| `tangent_suggestion`（payload 提到這些線） | `expireNamingLines` → `expired` |
| `tangent_group_member` | `DeleteGroupMembersOfLines`；群組剩不到 2 條（`domain.GroupMinMembers`）就 `DissolveGroup` |
| `tangent_memo` | 不動：`line_id ON DELETE SET NULL`，留在樹上 |
| 這些線自己的訊息、建議、收尾、折疊、章節切點、job、比較表 | 外鍵 CASCADE |
| 父線上的 `branch_marker` | 不動 |

`purgeAside` 沒有改用它（只加了 `kept_at` 的重讀）：清除是背景清掃、不發連結與群組事件，這次不擴大它的行為。

### 路由、op、錯誤碼

- `httpapi/b23.go`：三條路由（`b23Routes()`），op `branches.keep` / `branches.continue` / `branches.delete`。`continue` 會問 `Config.HostMeta`（同 `branches.create`，因為開了一條新線）。
- 新錯誤碼 `branch_not_deletable`（409），放在 `domain/errors.go`（web 的 `errors.test.ts` 會讀這個檔）。其餘都是既有錯誤碼的 `refine`（訊息更明確，碼不變）：`kind_unsupported`、`branch_busy`、`no_messages`、`invalid_input`。

## 測試

| 檔案 | 內容 |
|---|---|
| `domain/branch_b23_test.go` | `BranchDeletable` 九種、`NormalizeContinueKind`、refine 過的錯誤碼 |
| `b23_test.go`（Engine，9 個） | 保留後過了保留期不被清、取消後下一次清掉、重複設定不發事件、rollback；建立時 `keep`（答完仍在）、不是順口問回 `invalid_input`；保留的拒絕（非順口問、主線、別的租戶、封存、功能關閉；進行中的可以保留）；接著問（訊息 id 與 `seq` 不變、失敗的訊息沒搬、順口問不在了、新支線 `open` 且能再開一輪、歷史帶著原本的問答、備忘還在且 `lineId` 是 `""`、事件順序、掛勾收到的型別、rollback）；給目的與種類、子支線改掛；接著問的 12 種拒絕（含父線滿 8 條時 `branch_limit` 且什麼都沒改）；刪除 `discarded` 支線連子樹（標記還在、備忘留下、關聯刪除、掛勾在刪除前看得到列、事件）；群組少一個成員與解散；刪除的拒絕（主線、不存在、進行中、`merged`、被合併的、底下有 `open`、別的租戶、`promoted`、先前的主線、進行中的順口問、封存） |
| `store/b23_test.go`（5 個，併發） | 保留 與 清除；接著問 與 清除（結果是其中之一、沒有孤兒訊息）；兩個接著問 加 一個刪除 搶同一條順口問（剛好一個成功）；刪除 與 detach（刪除跟著支線到新的樹）；刪除 與 attach |
| `httpapi/b23_routes_test.go`（3 個）＋ 路由表 | 三條路由的成功與狀態碼、`field`；路由表 95 條（原 92），所以唯讀、未登入、別的租戶、功能關閉、功能被政策關掉、宿主掛勾拒絕時 rollback 這些既有的表格測試都涵蓋新路由 |
| `httpapi/contract_b23_test.go` | 契約流程 `f.b23()` |
| `intx_doc_test.go` | `KeepBranch`、`ContinueAside`、`DeleteBranch` 的 InTx 型別 |

TDD 的說明：測試先寫（`b23_test.go`、`store/b23_test.go`），第一次「紅」是編譯不過（方法還不存在）；實作後第一次執行就全過。為了確認測試有鑑別力，另外做了一次變異檢查（拿掉 `purgeAside` 的 `kept_at` 重讀 → 併發測試失敗 → 還原）。

## 和工單不同的地方

1. **契約樣本新增 4 份，不是 3 份**：多了 `event.branch.changed.kept.json`。契約測試對 `branch.changed` 的每個 `change` 值各記一份事件樣本（`sampler.event`），流程裡只要真的保留一次就會產生；既有的 8 個值也都有樣本，所以照慣例加進 `TestContract_…` 的必備清單與 `docs/API.md`。既有樣本沒有任何變動。若要維持 3 份，把流程改成「建立時就 `keep: true`」再保留一次（不發事件）即可，但前端就沒有這個事件的樣本。
2. **保留的鎖只鎖順口問那條線**，不是「root → 這條線」：`RenameBranch` 實際上就是 `lockBranch(withParent=false)`（只鎖支線，鎖住後確認主線沒變），照程式碼的做法。清除、接著問、刪除都會鎖這條線，所以不需要主線的鎖。
3. **搬的是所有 `done` 的訊息**，不只 user / assistant：宿主系統訊息、卡片、標記（順口問上很少有）一起搬，免得留下指向已刪除訊息的支線。`error` 的不搬（同工單）。
4. **順口問底下的支線**（工單沒提）：直接子支線改掛到新支線、深度不變，事件多 `branch.changed{moved}`。
5. **錯誤碼**：`結束但沒有回答` 用既有的 `409 no_messages`（工單只說「必須是已回答」）；`kind` 給 `aside` 或不認得的值 → `400 kind_unsupported`；順口問在建背景包與上鎖之間被改掛 → `409 concurrent_change`；主線對 `keep` / `continue` 回 `404 branch_not_found`（同其他 `/branch` 路由）。
6. **整棵樹的上限不算被取代的順口問**（`tree_limit`）：一換一，數量沒變。`branch_limit`、深度照舊。
7. **刪除的事件多 `group.changed`**（群組少了成員或解散，`group` 開著時）；`link.changed` 只在 `relations` 或 `spinoff` 開著時發。接著問也會發被刪連結的 `link.changed` 與失效建議的 `suggestion.changed`。
8. **刪除不鎖父線**（照工單），所以也不 touch 父線；父線與主線各發一個 `line.updated`（支線數量變了）。
9. **`continue` 會問 `Config.HostMeta`**（op `branches.continue`）：新線的 `host_meta` 由宿主給，舊線的在 `InTx` 的 `Gone.LineHostMeta`。
10. **`DESIGN.md` §4 的「刪除只有 `DeleteTree`」改寫**：這是 B23 本身造成的契約變更，不是放寬 §5。
11. 工單 §4 的 smoke 沒有跑（見上）。

## 給前端（F18）

### 新的 JSON

- `BranchView.keptAt?: string`（RFC 3339）：只有保留的順口問有；沒保留的順口問與其他支線**沒有這個欄位**（不是 `null`）。大綱、`GET /branch`、匯出、所有帶 `BranchView` 的回應與事件都一樣。
- `POST /lines/{id}/branches` 本文多選填 `keep: boolean`（只對 `kind: "aside"`；其他種類給 `true` → `400 invalid_input`，`field: "keep"`）。
- `PUT /lines/{id}/branch/keep`，本文 `{"keep": boolean}`（必填）→ `200 {"branch": BranchView}`。
- `POST /lines/{id}/branch/continue`，本文可省略，`{"purpose"?, "kind"?: "investigate" | "alternative", "confirmDeeper"?}` → `201 {"branch": BranchView, "line": LineView, "replacedLineId": string}`。
  **`line.id` 是新的**；`replacedLineId` 那條線已經不存在（`GET /lines/{replacedLineId}` 是 404）。訊息的 `id` 與 `seq` 不變，`lineId` 變成新線。
- `DELETE /lines/{id}/branch` → `200 {"rootLineId": string, "lineIds": string[]}`（`rootLineId` 是還在的主線；`lineIds[0]` 是 `{id}`，之後是它底下的線）。
- 新錯誤碼 `branch_not_deletable`（409）。

### 錯誤（給對話框用）

| 路由 | 狀態 | code | 何時 |
|---|---|---|---|
| keep | 400 | `invalid_input`（`field: keep`） | 沒有 `keep` |
| keep | 400 | `kind_unsupported` | 不是順口問 |
| keep / continue | 404 | `branch_not_found` | 主線、不存在（已被清掉或已經接著問過） |
| keep / continue / delete | 409 | `archived` | 封存的樹 |
| keep / continue | 404 | `feature_disabled` | `aside` 沒開 |
| continue | 400 | `kind_unsupported` | 不是順口問，或 `kind` 不是 `investigate` / `alternative` |
| continue | 409 | `branch_busy` | 順口問還沒結束（沒答完） |
| continue | 409 | `no_messages` | 結束了但沒有回答 |
| continue | 409 | `parent_closed` / `branch_limit` / `tree_limit` / `depth_soft_limit`（可帶 `confirmDeeper` 再送）/ `depth_hard_limit` | 父線不能再開支線 |
| continue | 404 | `anchor_not_found` | 錨點已不在父線上 |
| continue | 409 | `concurrent_change` | 同時被改掛，重試 |
| delete | 400 | `invalid_input` | `{id}` 是主線（用 `DELETE /lines/{id}`） |
| delete | 404 | `line_not_found` | 不存在 |
| delete | 409 | `branch_not_deletable` | 進行中、`merged`、`promoted`、先前的主線、被合併進別的支線 |
| delete | 409 | `branch_busy` | 底下還有進行中的支線，或有線在回合中 |

### 事件順序（commit 之後）

- **保留 / 取消保留**：`branch.changed{change: "kept"}`（看 `branch.keptAt` 有沒有）。狀態沒變時什麼都不發。
- **建立時 `keep: true`**：和一般建立一樣（`line.created`、父線 `line.updated`、`branch.changed{created}`），`branch.keptAt` 已有值；答完時的 `branch.changed{discarded}` 也帶著 `keptAt`。
- **接著問**：
  1. `line.deleted`：信封 `lineId` = 順口問、`rootLineId` = 主線；`data = {rootLineId: 主線, lineIds: [順口問]}`
  2. `line.created`（新支線的線）
  3. `line.updated`（父線）
  4. `branch.changed{created}`（新支線）
  5. 改掛的子支線各一個 `branch.changed{moved}`（通常沒有）
  6. 被刪連結的 `link.changed{deleted: true}`、失效建議的 `suggestion.changed`（＋主線 `line.updated`）（通常沒有）

  **沒有訊息事件**：搬過去的訊息要重新讀新支線的 `GET /messages`（同 move）。
- **刪除支線**：`line.deleted`（信封 `lineId` = 被刪的支線、`rootLineId` = 主線，`data.lineIds` 第一個是它）→ `link.changed{deleted: true}`（各一）→ `group.changed`（各一）→ `suggestion.changed`（＋主線 `line.updated`）→ 父線 `line.updated` →（父線不是主線時）主線 `line.updated`。
- **注意 `line.deleted` 的兩種情形**：`data.rootLineId === data.lineIds[0]` 是整棵樹刪除；否則樹還在，只是少了 `lineIds` 這些線（順口問過期被清時原本就是這樣）。備忘沒有批次事件：被刪的線上的備忘 `lineId` 變 `""`，要重新讀 `GET /memos`。

### web client 契約測試預期會失敗的項目（沒有實際跑：這個 worktree 沒有 `node_modules`，也不改 `web/`）

依讀 `web/packages/client/src/` 的測試推斷，共 **6 個測試**（加上 mock 契約測試可能的連帶失敗）：

1. `contract.test.ts` › route samples › `route.branch.keep`：`no client call for PUT /lines/{id}/branch/keep`（`ROUTES` 沒有這條）。
2. 同上 › `route.branch.continue`：`no client call for POST /lines/{id}/branch/continue`。
3. 同上 › `route.branch.delete`：`no client call for DELETE /lines/{id}/branch`。
4. `contract.test.ts` › event samples › `event.branch.changed.kept`：`branch-normalize.ts` 不認得 `keptAt`（鍵集合不同）；`events.ts` 的 `BRANCH_CHANGES` 也沒有 `kept`。
5. `errors.test.ts` ›「lists exactly the codes domain/errors.go defines」：`DOMAIN_ERROR_CODES` 少 `branch_not_deletable`。
6. `testing/mock-contract.test.ts`：它對每個成功的路由樣本比對 mock 的回應，三條新路由 mock 還沒有（要實作或先列進 `NOT_SIMULATED`）。

既有樣本沒有變，所以既有的路由與事件測試不受影響（沒保留的支線沒有 `keptAt`）。`coverage` 的 `afterAll` 不會另外失敗（樣本在測試開頭就記為已讀）。

## 已知限制、沒有做的

- **用量不帶到新線**：接著問之後，新支線的 `usage` 從 0 開始（順口問那一輪的用量記在已刪除的線上；每則訊息的 `meta.usage` 還在）。未讀數也歸零。
- **只指向順口問那條線（不是它的訊息）的連結**在接著問時隨線刪除（端點在訊息上的會跟到新線）。寫在順口問上的備忘照工單留在樹上、不跟到新支線。
- **錨點不在父線上的順口問**（combine 把進行中的順口問改掛到新支線時，錨點留在舊支線上，DESIGN §12.1 的例外）接著問會回 `404 anchor_not_found`。
- **併發的邊角**：接著問刪掉順口問那條線時，另一個正要鎖「順口問底下的支線」的請求（它先讀到的父線是順口問）會得到 `404 branch_not_found` 而不是自動重試；清除順口問時本來就有同樣的情形。
- 比較表（`tangent_comparison`）的選項若包含被刪的支線，表裡的 id 會指向不存在的線（清除順口問時也一樣）；`decided_line_id` 由外鍵設成 NULL。
- 新支線的 `createdAt` 是接著問的時間，所以它在大綱裡排到最後。
- 幾個測試函式超過 50 行（一個情境一路驗到底，和既有的 `b18_test.go`、`b20_test.go` 同樣寫法）；產品程式的函式都在 50 行內，新檔都在 220 行內。

## 留給協調者

- 跑 `bash scripts/smoke.sh`（B23 段在「delete the conversation」之前；事件檢查多了 `kept`），把事件數補進這份紀錄。
- 重啟 :8120 之前要先跑 migration 017（參考伺服器啟動時會自己跑）；備份 `tangent`。
- HANDOFF / ROADMAP、提交、審查。
- 請特別看：鎖順序與併發（見報告）、契約樣本 4 份的決定、`DESIGN.md` §4 第 2 點的改寫。

## 數字

`go test ./... -count=1 -json`（最後一次，全部修改完成之後）：16 個套件全部 ok；**1,290 個測試通過、6 個跳過、0 個失敗**（含子測試）。

- 跳過的 6 個都是原本就要另外開啟的：`TestRealModelSmoke`、`TestRealCLISmoke`（真實模型／CLI，沒有設定就跳過，所以沒有付費呼叫）、`TestPromote_Explain`、`TestSearch_Explain`、`TestPerf_MemoryRecallWithinBudget`、`TestPerf_BranchTurnWithRebalance`。沒有任何 DB 測試因為連不到 :5444 而跳過。
- B23 新增的測試 20 個（domain 3、Engine 9、store 併發 5、httpapi 3），另外既有的表格測試（路由表、契約流程、InTx 表）多涵蓋三條新路由。
- `go test -race`（只跑 B23 與 aside 相關的測試：`.`、`./store/`、`./httpapi/`、`./domain/`）通過；`./store/ -run TestB23 -count=5` 沒有不穩定。
- `go vet ./...`、`gofmt -l .` 無輸出；`sqlc diff` 無差異。
