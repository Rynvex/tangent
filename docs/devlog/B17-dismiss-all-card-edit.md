# B17 · 一鍵忽略建議、結論卡編輯、從結論卡追問

> 2026-10-30。工單（後端）。前端 `F12` 由另一個 agent 平行做。
> 在獨立 worktree（`../tangent-b17`，分支 `b17`，從 `abf535b` 開）裡做，**沒有改 `web/`**。
> Go 測試用 `tangent_test`；smoke 用 :8121 與 `tangent_smoke`。沒有碰 :8120、:5183、使用者的 `tangent` 資料庫或 宿主，也沒有呼叫付費模型（只跑 `go test` 與 fake runner 的 smoke）。

## 驗收

| 檢查 | 結果 |
|---|---|
| `~/go/bin/sqlc diff` | 無差異（新增 3 個查詢後 `sqlc generate`） |
| `go vet ./...`、`gofmt -l .` | 通過、無輸出 |
| `go test ./... -count=1` | 全部 ok（含 `TestAPIDoc_*`、`TestInTx_TheGuideListsTheResultEveryWritePasses`、契約樣本） |
| `bash scripts/smoke.sh`（:8121） | `SMOKE PASSED (870 events)`。新增一步「B17: dismiss a whole inbox, edit a merged card (the next turn carries it again), a branch on the card」 |
| `web/` | 沒有變更 |

新增的測試（13 個）與改動：

| 檔案 | 內容 |
|---|---|
| `b17_test.go`（engine，fake runner） | 10 個：一鍵忽略（整棵樹兩筆 probe 建議從支線 id 呼叫一次全部 `dismissed`、新的在前、`decidedAt` 有值；事件 = 兩個 `suggestion.changed` + 主線 `line.updated`（`openSuggestions` 0）；沒開的功能的建議不動；InTx 失敗整筆回滾、不發事件；之後同一對象在冷卻內不再提；沒有 open 時回空切片（不是 nil）、不發事件）；拒絕（別的租戶、壞 id → `line_not_found`，沒有會提建議的功能 → `feature_disabled`）；編輯結論卡（內容 = 新卡的 Markdown、`meta.card`、`meta.delivered` 清掉而 `branchLineId` 保留、seq 不變、未讀不變、`conclusionLine`、merge 寫的收尾跟著改、事件 `message.updated` → `branch.changed{merged}` → `leaf.changed`、InTx 回滾）；**下一輪只帶一次改過的卡**（結論卡通知有新卡、整個 prompt 沒有舊結論、新結論只出現一次；那一輪標回 `delivered`；再下一輪沒有通知、歷史裡是新卡）；使用者改過的收尾保留；拒絕（open / discarded → `branch_closed`、主線 / 別的租戶 → `branch_not_found`、缺結論與引用不存在的訊息 → `invalid_card`、父線回合中 → `parent_busy`、封存 → `archived`）；放卡片的那條支線已結束 → `parent_closed`；promote 把卡片跟舊尾段搬到「先前的主線」而支線留在主線 → `parent_closed`；`leaf` 對租戶關閉時收尾不動、不發 `leaf.changed`；從結論卡開支線（預覽與建立的背景包最後一則是卡片、卡片之後的訊息不在包裡、支線第一輪的 prompt 帶到卡片內容；別條線的卡 → `anchor_not_found`；`spinoff` 的 `fresh` 仍拒絕卡片） |
| `httpapi/b17_routes_test.go` | 3 個 + 路由表 2 列：`dismiss-all`（唯讀 403、本文不是物件 400、`tenantOff` 404 `feature_disabled`、回應形狀、事件、`openSuggestions`、第二次回 `"suggestions":[]`）；`PATCH /branch/card`（回應只有 `{branch, message}`、`meta.delivered` 不出現、`branch.leaf.line`、事件順序、`422 invalid_card`（多餘欄位、空結論、沒有 `card`）、沒有本文 400、未知 / 主線 / 別的租戶 404 `branch_not_found`、open / discarded 409 `branch_closed`、封存 409 `archived`）；從結論卡預覽與開支線 |
| `httpapi/contract_b17_test.go` | 契約流程 `f.b17()`（自己一棵樹）：產生 `route.suggestions.dismiss.all.json`、`route.branch.card.update.json` |
| `httpapi/routes_test.go` | 路由數 83 → 85 |
| `httpapi/host_hooks_test.go` | `update card` 加進 `refusedBeforeHooks`（種子資料的支線還開著，引擎在交易前就拒絕） |
| `intx_doc_test.go` | 跑 `UpdateBranchCard`、`DismissAllSuggestions` |
| `b5_api_test.go`、`store/branches_test.go` | 原本斷言「結論卡不能當 anchor」：改成卡片可以、其他系統訊息（`branch_marker`）與別條線的卡仍拒絕 |

契約樣本：只新增兩個（`route.suggestions.dismiss.all`、`route.branch.card.update`），其他樣本沒有變（新流程放在 B15 之後、自己一棵樹，事件樣本只取每種的第一個）。

## 實作

| 項目 | 做法 |
|---|---|
| SQL | `suggestions.sql` `DismissOpenSuggestions`（`root_line_id`、`feature = ANY(...)`、`status='open'` → `dismissed`、`decided_at = clock_timestamp()`）；`messages.sql` `UpdateCardMessage`（`content`、`meta = (meta || {card}) - 'delivered'`，只改 `kind='branch_card' AND status='done'`）；`branches.sql` `SetBranchConclusionLine`（只改 `merged`） |
| store | `DismissOpenSuggestions(ctx, SuggestionQuery, hooks...)`：解析根、鎖主線（同 `DecideSuggestion` 的鎖），一次更新，Go 端排成 `created_at DESC, id`（`UPDATE … RETURNING` 不保證順序），沒有時空切片。新檔 `store/card_edit.go`：`UpdateBranchCard` 用 merge 的 `lockBranch(…, true)`（root → parent → branch），檢查 `merged` + `card_message_id`、支線封存；`lockCardHolder` 讀卡片訊息：不在父線上（見下）→ `parent_closed`；父線要能接受回合（`requireWritable`：封存 → `archived`，已結束 → `parent_closed`）且沒有 pending 回合（`parent_busy`）；改訊息、改 `conclusion_line`、`FollowLeaf` 時 `followCardLeaf`、交易內讀 `BranchView`。不多鎖任何線 |
| engine | `feature_suggestions.go` `DismissAllSuggestions`（`needScoped(FeatureSuggestions)`、`producers(modes)`、commit 後 `suggestionEvents`）；新檔 `card_edit.go` `UpdateBranchCard`（`GetBranch` → 不是 merged 就 `ErrCardNotEditable` → `checkedCard` → `RenderBranchCardMarkdown(card, purpose)` → store → 事件）；`UpdatedCard = store.UpdatedCard` |
| anchor | `domain.CanAnchorBranch(role, kind, status)`（`done` 且 user / assistant，或 `branch_card`），`store.requireAnchor` 與 `requirePreviewAnchor` 共用。`BranchPackInput.CardAnchor`：`Check` 接受卡片 anchor，`packConversation` = 卡片之前的對話 + 卡片；`packBlockHeader` 對卡片寫 `branch conclusion card` 而不是 `system`。只有 `Engine.buildPack` 打開它 |
| httpapi | 新檔 `b17.go`：兩條路由（`dismiss-all` 掛在 `suggestions` 功能下；`PATCH /branch/card` 是核心）；`cardBody{card json.RawMessage}` 用 `DecodeBranchCardJSON` 嚴格解碼（同 merge）；回應 `updatedCard{branch, message}`、`suggestionList`（`list()` 保證 `[]`）。`ops.go` 另一個 const 區塊放兩個新 op（不讓 gofmt 重排整張表） |
| 文件 | `docs/API.md`（兩個路由段落、建立 / 預覽支線的 anchor 說明、op 表兩列、`branch.changed{merged}` 的新意思、`anchor_not_found` 說明）；`docs/EMBEDDING.md` §4.4 兩列；`docs/DESIGN.md` §5 anchor 與送達、§6 支線方法與事件表、§7 路由表、§12.10 三列（同時追加到 `docs/design/DECISIONS_LOG.md`） |
| smoke | B17 一步：兩筆 probe 建議一次忽略、第二次沒有 probe、merge → 一輪 → 編輯（`delivered` 清掉、`conclusionLine`、`leaf.line`）、沒有結論 422、下一輪標回 `delivered`、從卡片預覽與開支線 |

## 送達（delivered）怎麼運作，為什麼清掉它就夠

查了 `store/turns.go`、`prompt.go`、`domain/prompt_build.go`、`domain/summary.go`、`feature_summary.go`：

- `BeginTurn` 在鎖住那條線時用 `ListUndeliveredCards`（`meta->>'delivered' <> 'true'`，依 seq，最多 `NoticeMaxPerTurn`）選出這一輪要帶的卡，id 記在 pending 訊息的 `meta.deliversCards`；成功完成時 `MarkCardsDelivered` 只標這些 id，並發卡片的 `message.updated`。
- 歷史（一般、魚眼、折疊、摘要輸入、主題判斷）全部經 `historyShowsMessage`：**沒送達的卡不進歷史**，只在通知裡出現一次；送達後歷史用 `meta.card` 重新算卡片內容。
- 所以編輯時拿掉 `delivered`：下一輪用通知帶新卡一次、歷史同時不顯示（不會新舊並列），那一輪成功後標回 `delivered`，之後歷史在原來的位置顯示新卡。測試 `TestCardEdit_TheNextTurnCarriesTheEditedCardOnce` 驗證。
- 會出問題的只有「回合已經開始、帶著舊卡（或卡還沒送達時已被選進 `deliversCards`）」：完成時會把改過的卡標成已送達，模型卻只看過舊的。因此**放卡片的線有 pending 回合時拒絕編輯**（`409 parent_busy`，訊息是自己的 `ErrCardHolderBusy`）。
- 摘要：`GetUnsummarizedSize` / `summarizable` 在第一張未送達的卡前停下。卡片在摘要游標之前時，下一輪送達前「該摘要了」暫時算不到（之後恢復），不會把卡摘要掉；已寫進滾動摘要的舊結論不改（見下）。

## 卡片派生的其他東西（決定）

| 東西 | 決定 |
|---|---|
| `tangent_branch.conclusion_line` | 同交易改。大綱、地圖、魚眼、群組、合併、關聯建議都即時讀它，所以跟著對 |
| 收尾（`tangent_leaf`） | merge 時寫的是 `domain.LeafFromCard(card)`（`kind: conclusion`、`line` = 結論、`body` = 問題 + 證據說明 + 未解決項目），不是工單說的 `BranchConclusionLine`。編輯時**只有在收尾仍等於 `LeafFromCard(舊卡)`（正規化後比 kind/line/body，且不是 job 寫的）**才用 `LeafFromCard(新卡)` 重寫（狀態保留、`created_by` = 編輯者）；使用者 `PUT /leaf` 改過或 AI 草稿的收尾不動。`leaf` 對這個租戶關閉時不動（merge 也只在開著時寫，`UpdateBranchCardInput.FollowLeaf`）。改了就發 `leaf.changed` |
| 卡片訊息的搜尋 | 搜尋直接讀 `content`，跟著新內容 |
| 記憶（`memory`） | merge 後從卡萃取的記憶**不重做**（那是 AI job，會花錢；記憶有自己的編輯與取代）。記錄為已接受的限制 |
| 父線的滾動摘要、群組摘要 | 不重算（快照；同 B13 改名的規則）。已經摘要到舊卡、或編輯時正在跑的摘要 job 會留著舊結論（接受的限制） |
| 內容完全相同的編輯 | 照樣寫入、清 `delivered`、發事件（下一輪重送一次；不另外比對） |
| 線的 `last_activity_at` | 不動（編輯不是對話活動，也不算未讀） |
| 從這張卡開出的支線的背景包 | 不改（背景包是開支線當時的快照） |
| 紀要（merge 的 `noteChanges`） | 不動（使用者確認過的紀要，只是引用卡片 id） |
| 匯出 | 即時讀，跟著新內容 |
| 未讀 | 不加（不是新訊息）；父線不發 `line.updated`（`LineView` 沒變） |

## 從結論卡開支線

- 工單 §1.3 說「`ListDoneMessagesUpToSeq` 會撈出卡片、`BuildBranchPack` 天生會把卡片納入」——**不對**：`conversationOnly` 丟掉所有系統訊息，`BranchPackInput.Check()` 會拒絕卡片 anchor（`anchor_not_found`），包裡也沒有卡片。所以加了 `BranchPackInput.CardAnchor`：卡片當最後一則被引用（內容是卡片的 Markdown，當資料用 `> ` 引用；卡片自己的引用行因此是 `> > `），之前的對話照常。
- 只有 `Engine.buildPack` 打開它：`POST /branches`、`/branches/preview`、合併支線（`combine` 的 anchor 是來源支線最新的 anchor，可能是卡片）、種子展開（`usableFork` 往上找到的 anchor 可能是卡片）都一致。發散（`diverge`、`diverge/models` 自己檢查 `kind = chat`）與 `spinoff` 的 `fresh`（`Check` 沒開 `CardAnchor`）仍只接受 user / assistant，範圍不擴大。
- 其他假設 anchor 是對話訊息的地方都查過：promote（`MoveMessagesAfterSeq` 依 anchor seq，卡片留在主線，OK）、move（卡片本來就不能搬，`move_protected`）、`parentAfterAnchor` / 起草的「anchor 之後」（依 seq，OK）、`ListBranchesAnchoredIn*`（依 id，OK）、支線的 prompt（只用存好的包）。anchor 必須在父線上（`messageOn(parent.ID)`），別條線（含別的租戶）的卡 → `anchor_not_found`；封存的父線照舊由 `CheckBranchCreate` 擋。

## 審查（唯讀 go-reviewer agent，沒有 CRITICAL / HIGH）

| 發現 | 處理 |
|---|---|
| MEDIUM：卡片不在父線上時在 child 之後再鎖放卡片的線，違反鎖順序 | 改成不鎖、直接 `parent_closed`（那條線只可能是已結束的「先前的主線」），加測試 |
| MEDIUM：`leaf` 關閉時仍改收尾、發 `leaf.changed` | 加 `FollowLeaf`（引擎依租戶模式），加測試 |
| MEDIUM：下一輪前卡片不在歷史、摘要停在它之前；已摘要 / 摘要 job 中的舊結論 | 接受，寫進 API.md 與本 devlog |
| LOW：open 支線也回 `branch_closed` | 照工單契約保留（訊息是 `ErrCardNotEditable` 自己的） |
| LOW：相同內容也重送、不 `touch`、引擎在交易前讀 / 驗卡（同 merge）、卡片開的支線背景包是快照、`dismiss-all` 依功能而非種類過濾 | 接受（見上表）；`dismiss-all` 的範圍刻意與 `GET /suggestions` 一致 |

## 和工單不同的地方

1. **封存的錯誤碼是 `archived`**（`domain.ErrLineArchived` 的碼），不是工單寫的 `line_archived`（沒有這個碼）。
2. **非 merged 用 `branch_closed`，但訊息是新的** `domain.ErrCardNotEditable`（"only a merged branch has a conclusion card to edit"）；`ErrBranchClosed` 的訊息是「this branch is closed」，對 open 的支線不對。
3. **多兩個拒絕**：放卡片的線在回合中 → `409 parent_busy`（`ErrCardHolderBusy`，理由見「送達」）；那條線已結束 → `409 parent_closed`（`ErrCardHolderClosed`；卡片再也不會送給任何模型，且已結束的線是唯讀的）。
4. **卡片可能不在父線上**：promote 時，anchor 在升級點之前、卡片在之後的已帶回支線留在主線上，卡片卻跟舊尾段搬到「先前的主線」（`discarded`，永遠不再接受回合）。這種卡直接 `parent_closed`，不去鎖那條線（第一版會在 child 之後再鎖它，審查指出這破壞 root → parent → child 的鎖順序，改掉）。`UpdatedCard.ParentLineID` 因此一定是父線。
5. **收尾**：照 `LeafFromCard` 重算（`line` 與 `body`），而且只在它仍是 merge 寫的那份時改（見上表），不是「`kind = conclusion` 就把 `line` 改成 `BranchConclusionLine`」。
6. **`meta.delivered` 是拿掉這個鍵**（`meta - 'delivered'`），不是寫 `false`：和剛 merge 時的 JSON 一樣（`MessageMeta.Delivered` 是 `omitempty`），所有判斷都是 `<> 'true'`。API 回應裡 `delivered` 不出現。
7. **本文**：`dismiss-all` 用 `c.body(&struct{}{}, false)`，空本文或任何物件都可以，不是物件 → `400 invalid_input`。`PATCH /branch/card` 本文必填（沒有 → `400 invalid_input`），`card` 缺或不是物件 → `422 invalid_card`。不是 UUID 的 `{id}` → `404 line_not_found`（同 merge 的 `c.lineID()`）；是 UUID 但不是支線 → `404 branch_not_found`。
8. **工單 §1.3 的假設不成立**（見「從結論卡開支線」），多改了 `domain/branch_pack.go`。
9. **契約樣本**用 `httpapi/contract_b17_test.go` 的 `f.b17()` 產生（契約流程的一部分，`-update` 統一寫），不是另寫一個驗證測試。
10. **smoke** 只數 probe 建議：smoke 開了很多 suggest 模式的功能，背景 job 可能在任何時候提出自己的建議。
11. 工單 §2.4「合併進 main、重啟 :8120」是協調者的事，這裡沒做。

## 給前端（F12）

- `POST /api/lines/{id}/suggestions/dismiss-all`（功能 `suggestions`；`{id}` 可以是樹上任一條線；本文可省略或 `{}`）
  → `200 {rootLineId, suggestions: Suggestion[]}`（`status: "dismissed"`、有 `decidedAt`，新的在前；沒有時 `[]`）。
  事件：每筆 `suggestion.changed {rootLineId, suggestion}`，最後主線 `line.updated`（`openSuggestions: 0`）；沒有東西可忽略時不發事件。
  錯誤：`404 line_not_found`、`404 feature_disabled`、`403 forbidden`（唯讀）。
- `PATCH /api/lines/{branchLineId}/branch/card`，本文 `{card: {question, conclusion, evidence?, impact?, needsDecision?, openItems?, excerpts?}}`（同 merge 的 `card`，嚴格解碼）
  → `200 {branch: BranchView, message: Message}`。`message` 是同一則卡片訊息（同 `id`、`seq`、`lineId` = 父線），`content` 與 `meta.card` 是新的，`meta.delivered` 不出現（= false）；`branch.conclusionLine` 與（merge 寫的）`branch.leaf.line` 已更新。
  事件順序：`message.updated`（卡片）→ `branch.changed {change: "merged", branch}`（同一條支線再一次 `merged` = 卡片被編輯，沒有新的 change 值，`BRANCH_CHANGES` 不用改）→ 收尾有跟著改時 `leaf.changed`。父線下一輪完成後卡片會再收到一次 `message.updated`（`meta.delivered: true`）。
  錯誤：`422 invalid_card {problems[]}`、`404 branch_not_found`（主線、未知、別的租戶）、`404 line_not_found`（不是 UUID）、`409 branch_closed`（支線不是 merged）、`409 archived`、`409 parent_busy`（父線正在回合中：等它完成再存）、`409 parent_closed`（放卡片的線已結束）、`400 invalid_input`（沒有本文）。
- 從結論卡追問：`POST /lines/{parentLineId}/branches` 與 `/branches/preview` 的 `anchorMessageId` 可以是父線上 `kind: "branch_card"` 的訊息 id（`role: "system"`）。預覽的 `pack.recent` 最後一筆就是卡片（`role: "system"`），`text` 裡卡片的標頭是 `[main-line message <id> · branch conclusion card]`。新支線的 `branch.anchorMessageId` 是卡片 id。別條線的卡 → `404 anchor_not_found`。
- 沒有改任何既有回應的欄位；`web/` 的型別與測試不需要後端這邊改。

## B17.1 追記：結論卡的編輯時間（`meta.editedAt` / `BranchView.cardEditedAt`）

> 2026-10-30。F12 devlog「建議的後續」那一項：讓「已修改・下一輪帶入」與追問支線的「前提已更新」只靠伺服器資料，換裝置、重新整理後一樣。

- **後端**：`UpdateCardMessage` 在 `meta` 寫 `editedAt`（`clock_timestamp() AT TIME ZONE 'UTC'`，`YYYY-MM-DDTHH:MM:SS.ffffffZ`），`delivered` 照舊拿掉；`MarkCardsDelivered` 的 `jsonb_set` 只改 `delivered`，`editedAt` 留著。`domain.MessageMeta.EditedAt`、`domain.BranchView.CardEditedAt` 都是 `*time.Time` + `omitempty`：沒編輯過的卡與支線 JSON 完全不變（契約樣本只有 `route.branch.card.update.json` 多兩個欄位）。不加欄位、不加 migration。`messageFromRow` 把 `EditedAt` 正規化成 UTC。
- **大綱查詢**：`GetBranchView`、`ListBranchViewsByRoot`、`ListBranchViewsByLineIDs`（這三個是所有 `BranchView` 的來源，`open_loops` 的停滯支線也走最後一個）都 `LEFT JOIN tangent_message cm ON cm.id = b.card_message_id`，投影 `card_edited_at`。**和工單不同**：工單的 `(SELECT (meta->>'editedAt')::timestamptz …)` 被 sqlc 1.30 當成 NOT NULL 的 `time.Time`（cast 一律推成非空；子查詢、`NULLIF`、`max()`、`LEFT JOIN LATERAL` 都試過，不是非空就是型別錯），掃到 NULL 會失敗；改成 `CASE WHEN cm.meta->>'editedAt' IS NOT NULL THEN (cm.meta->>'editedAt')::timestamptz END`，sqlc 產生 `interface{}`，pgx 對 `timestamptz` 給 `time.Time`、NULL 給 `nil`，`store/convert.go` 的 `anyTimePtr` 轉成 `*time.Time`（UTC）。
- **測試**：`b17_test.go` `TestCardEdit_RecordsWhenTheCardWasEdited`（merge 後兩邊都是 nil；編輯後卡片、`UpdatedCard.Branch`、`ListBranches`、`GetBranch` 同一個 UTC 時間；之前從卡片開的追問支線 `CreatedAt` 早於它；下一輪送達後 `Delivered` 且 `EditedAt` 不變；再編輯一次時間往後）。`httpapi/b17_routes_test.go` `TestB17Routes_TheCardEditTime`（同樣的事走 HTTP：`meta.editedAt` 是 RFC3339Nano、以 `Z` 結尾、等於 `branch.cardEditedAt`、`GET /branches` 與 `GET /branch` 一致、晚於追問支線的 `createdAt`、送達後保留）。smoke 的 B17 一步多斷言 `message.meta.editedAt` / `branch.cardEditedAt`、送達後仍有 `editedAt`、大綱有 `cardEditedAt`。
- **網頁**：`cardState(card)` 只看 `meta.delivered` 與 `meta.editedAt`；「前提已更新」是 `editedCardSource(branch, outline)`：來源支線的 `cardEditedAt` 晚於追問支線的 `createdAt`（兩者都是資料庫時鐘；用 `isoMicros` 比到微秒，`Date.parse` 只到毫秒）。理由 id 是 `card:<anchorMessageId>:<cardEditedAt>`，所以「知道了」只忽略那一次編輯。F12 的 `localStorage` 紀錄（`card-edits.ts`、`useCardEdits`、`recordCardEdit`、`storage` 事件、`tangent:card-edits:v2`）與 `CardEdit`、`followUpsOfEditedCards` 整個刪掉。mock 的 `updateBranchCard` 同時設兩個欄位，時間保證晚於這棵樹所有支線的 `createdAt` 與上一次編輯（mock 時鐘不動時也成立）。
