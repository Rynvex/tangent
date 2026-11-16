# B20 + F14.1 + F15 · 事後把既有對話併入另一條對話（`POST /lines/{id}/attach`）＋ F14 實測與設計收尾

> 2026-11-03。工單（工單 21，四階段）。基線 `main` @ `e432c7b`（F14）。
> 在獨立 worktree（`../tangent-b20`，分支 `b20`）由一個實作 agent 完成，未 commit。CHANGELOG / HANDOFF / ROADMAP、測試手冊與 HTML 指南、截圖複製到 NAS、合併、備份資料庫與重啟 :8120 由協調者做。
> 沒有碰 宿主；沒有動 :8120、:5183（e2e 自己挑 port）；沒有寫 dev 資料庫 `tangent`（Go 測試用 `tangent_test`，smoke 用 `tangent_smoke` / :8121）；沒有呼叫付費模型（全部是 fake / mock）。沒有新 migration。

## 驗收

| 檢查 | 開工時（`e432c7b`） | 完成時 |
|---|---|---|
| `~/go/bin/sqlc diff` | 無差異 | 無差異（新查詢檔 `store/queries/attach.sql`，`store/db/attach.sql.go` 由 `sqlc generate` 產生） |
| `go vet ./...`、`gofmt -s -l .` | 無輸出 | 無輸出 |
| `go test ./... -count=1` | 1,202 通過、6 跳過（含子測試） | **1,214 通過、6 跳過、0 失敗** |
| `bash scripts/smoke.sh`（:8121、`tangent_smoke`） | SMOKE PASSED（905 events） | **SMOKE PASSED（929 events）** |
| `pnpm -C web typecheck` | 5 個專案通過 | **5 個專案通過** |
| vitest（各套件分別 `npx vitest run`） | fonts 10、client 1,147、react 1,015、demo 218 | fonts **10**、client **1,165**、react **1,027**、demo **226** |
| `pnpm -C web build` 主入口 JS（gzip） | 167,696 bytes | **169,466 bytes**（上限 172 kB） |
| 延遲載入的併入對話框 | — | `attach-line-dialog-*.js` 6,664 bytes（gzip 2,851），只由拆解面板 `lazy()` 載入 |
| `pnpm -C web/e2e e2e:mock --workers=2` | 158 passed、3 skipped | **162 passed、3 skipped、0 failed**（審查修正前後各跑一次整套，都是 0 failed） |
| `git status --short` | — | 只有 Go / SQL / 契約樣本 / smoke / `web/` / `docs/`；工單 是 0644 |

主入口多出的約 1.8 kB：`MessageTime` 與訊息列、`BranchCard` 的匯入標記、章節列的判斷、`event-sync` 的 `dropAttached`、`useAttachLine`、i18n 三個鍵、`useF13Frame` 的復原（`last-import.ts`、`undo-words.ts`、`useDeleteLine` + `undoAssembly`）。

## 做了什麼

### 階段一：後端 B20 `POST /lines/{id}/attach`

**路由與型別**
- `httpapi/attach.go`：`attachBody`（`sourceLineId`、`anchorMessageId?`、`purpose?`、`kind?`、`status?`、`card?`、`confirmDeeper?`；`card` 照 merge 嚴格解碼，壞的是 `422 invalid_card`）、回應 `attachedBranch{targetLine, branch, branchLine, cardMessage (null), reparented[]}`，`200`。路由登記在 `httpapi/b18.go` 的 `b18Routes()`，op `lines.attach`（`httpapi/ops.go`）。
- `Engine.AttachLine(ctx, scope, lineID, AttachInput, ...TxOption)`（`attach.go`）：正規化 kind / status / purpose，交給 `store.AttachLine`；`InTx` 收到 `store.AttachedLine`（EMBEDDING §4.4 表與 `intx_doc_test.go` 都加了）。不跑任何功能掛勾、不開始 job（同 extract 帶卡）。
- `domain/attach.go`（純函式）：`CheckAttach`（深度 = 目標深度 + 1，來源樹最深的支線跟著加深：硬上限、`status: open` 才算目標的進行中支線數、目標樹支線數 + 1 + 來源樹支線數 > 每棵上限、軟上限要 `confirmDeeper`；順序同 `CheckBranchCreate`）、`NormalizeAttachStatus`、`NormalizeAttachKind`（aside 是 `kind_unsupported`）、`AttachPurpose`（給的 → 來源標題（截到 200 字）→ 第一則提問前 60 字 → 第一則訊息）、`PlanAttachCard`（merged 必須帶卡、open 不能帶，`field: card`；`question` 空的用 `purpose`；先查形狀）。錯誤 `ErrAttachSelf` / `ErrAttachNotMainLine` / `ErrAttachEmpty` 都是 `invalid_input`、`field: sourceLineId`。

**交易（`store/attach.go`、`store/attach_tree.go`、新查詢 `store/queries/attach.sql`）**
1. 不加鎖先讀：兩條線都要是這個租戶的（`line_not_found`）；同一條、來源是支線、目標所在的樹的主線就是來源 → `invalid_input`（來源是支線時不能把它當主線鎖，所以這一步在加鎖前）。
2. 鎖：兩條主線依 id 排序（`lockRootRows`）→ 目標線（不是主線時）→ 來源樹的支線依 id 排序（`lockLines`）。鎖住後重查：來源還是主線（不是就 `errBranchMoved`，重試時第 1 步拒絕）、目標還在原本那棵樹（`rootOf` 對不上就 `errBranchMoved`；目標原本是主線而剛被別人併走時也是這裡擋下，見審查）。
3. 拒絕：任一邊封存 `archived`；目標 `thinking` 或有 pending `source_busy`；來源樹任一條線回答中 `branch_busy`、有支線起草中 `branch_drafting`；來源沒有完成的 user / assistant 一般訊息 `invalid_input`；上限（`CheckAttach`）。
4. 錨點：給了就用 `requireAnchor`（`anchor_not_found`）；沒給時 `AttachAnchorCandidate`：目標線上可掛支線的訊息裡，`created_at <= 來源線 created_at` 的最後一則（依 `seq`），都比較晚就挑最新的；沒有任何可掛的 `move_no_anchor`。背景包用 `extractAnchor`（同 extract：錨點以前的訊息，摘要只在它涵蓋不超過錨點時帶），`origin: move`。
5. 寫入：`InsertBranch`（`line_id = 來源`、`parent = 目標`、`root = 目標的主線`、深度、背景包）；`MakeLineBranch` 把來源線的標題改成 `purpose`、清掉資料夾、標籤與 spinoff 的起源膠囊（`prompt.go` 對任何線都會帶膠囊，支線不該有）；子支線 `RehomeBranches(root, shift = -depth)`（SQL 是 `depth - shift`）。
6. 樹的附屬資料（逐表決定見下）；`status: merged` 時在目標線最後插一張 `system` / `branch_card` / `meta.delivered: true` / `meta.branchLineId` 的卡，`CloseBranch(merged, card_message_id, conclusion_line)`，`leaf` 開著時同交易寫 `confirmed` 收尾。卡片照 merge 的規則檢查：支線端的引用必須是來源線上完成的 user / assistant 訊息，父線端的必須是錨點之後的相關訊息。
7. `touch(目標)`，讀回三個 view。

**逐表決定（整棵來源樹一起走，所以依舊主線整批改，舊主線底下不留任何列；detach 是依線一條條搬，因為它只帶走一部分）**

| 資料表 | attach 做什麼 | 理由 / 對應 detach |
|---|---|---|
| `tangent_branch` | 新增來源的列；來源樹的支線 `RehomeBranches`（root 改、depth 加深） | detach 的反向（刪列、上提） |
| `tangent_leaf` | `MoveTreeLeaves`（依 root） | detach 用 `RehomeLeaves`（依線） |
| `tangent_chapter_cut` | `MoveTreeChapterCuts`（依 root） | detach 用 `RehomeChapterCuts` |
| `tangent_seed` | `MoveTreeSeeds`（依 root） | detach 依錨點訊息所在的線；種子的錨點沒有外鍵（aside 被清掉時錨點會不見），依線會漏 |
| `tangent_memo` | `MoveTreeMemos`（依 root，含節點已刪、`line_id` 是 NULL 的） | detach 用 `RehomeMemos`（依線，NULL 的會留下） |
| `tangent_note` | `MoveTreeNotes`（**搬**，不是複製）；有搬時目標的 `notes_revision` +1 | detach 是 `copyNotes`（舊樹留著）；併入後來源不再是主線，複製會留下孤兒。來源標籤（`labelMovingSources`）不需要：筆記的來源線跟著一起過來，仍在同一棵樹 |
| `tangent_suggestion` | 先 `ExpireCollidingSuggestions`（來源開著、目標也開著同一個 feature / kind / target_key 的 → `expired`，避免撞 `idx_tangent_suggestion_one_open`），再 `MoveTreeSuggestions`（依 root） | detach 依 `line_id` 搬子樹的；被 detach 過的舊樹裡可能有 `line_id` 已在別棵樹的建議，依線會漏 |
| `tangent_group`（＋ member） | `MoveTreeGroups`（依 root，狀態不變）；成員都在來源樹，群組照樣成立 | detach 會拆開群組所以解散；attach 沒拆開任何東西 |
| `tangent_goal` | 刪掉來源的目標（`DeleteGoal`），目標對話保留自己的 | 一棵樹一個目標（PK 是 root）；detach 出來的新主線也沒有目標 |
| `tangent_message`、`tangent_message_tag`、`tangent_fold` | 不動 | 訊息不換線、`seq` 不變；標籤跟訊息、折疊跟線 |
| `tangent_comparison` | 不動 | 指向 parent line，線的 id 不變 |
| `tangent_job` | 不動 | 只指向線；起草中的已經被拒絕 |
| `tangent_link`（spinoff / relation） | 不動 | 指向線或訊息的 id；兩邊的關聯變成同一棵樹裡的關聯（`ListLinks` 依樹的線找，會出現） |
| `tangent_line` 的 `notes_revision*`、`summary` | 不動 | 只有主線的 revision 有意義；來源線的滾動摘要仍是它自己的 |

每棵樹的筆記、備忘、種子、里程碑、關聯、群組上限只在新增時檢查；併入可能讓目標對話超過它們（之後的新增被擋到降回上限以下）。

**事件**：來源線 `line.updated`（帶 `conversationBranch`）、帶卡時 `message.created`、目標線（與它的主線）`line.updated`、`branch.changed{created}`（帶卡時再一個 `{merged}`）、每條跟過來的子支線 `branch.changed{moved}`、`leaf.changed`、`notes.changed`、`seeds.changed`、`chapters.changed`（`chapters` 開著）、每個群組 `group.changed`、每個失效的建議 `suggestion.changed`。備忘沒有批次事件（`memo.changed` 要帶一則備忘），客戶端事後重新讀。

**順帶修的競態**：`lockParent`（開支線、move、extract、diverge、比較…）與 `lockNoteRoot`（筆記、里程碑）原本「先讀 root、鎖 root、再鎖線」之後沒有重查 root；detach 或 attach 在中間把線搬到別棵樹時，新支線列會寫成舊的 `root_line_id`、筆記會寫到已經不是主線的線底下。兩處都改成鎖住後重查，對不上就 `errBranchMoved`（交易自動重試）。`lockSeedRoot` 從 B13 起就有同樣的重查；審查後這些都改用共用的 `lockRootOf`（見「審查與修正」）。新的 store 測試（`TestAttach_WritesRacingTheAttachLandInTheRightTree`）沒有這個修正時大約三次失敗一次。

**測試**：`domain/attach_test.go`（上限、狀態、kind、目的、卡片）；`b20_test.go`（整棵樹併入：錨點依時間、深度、每張表沒有留下舊 root 的列、目標保留自己的目標、筆記搬過去、主線清單拿掉、事件、併入後可以照常開一輪；帶卡：已送達、下一輪不再通知、收尾；拒絕 22 種；上限算進來源樹；rollback）；`store/attach_test.go`（交叉併入 A→B、B→A、B→A 的支線同時跑不死鎖且只有一個成功、深度一致；併入與開回合同時；併入與在來源開支線、寫筆記同時）；`httpapi/b20_routes_test.go`（open / merged、拒絕的狀態碼與 `field`、卡片重複鍵）、路由表（91 條）、契約樣本 `route.lines.attach.json`；smoke 加 B20 段（依時間挑錨點、子支線加深、離開主線清單、訊息不變、帶卡已送達、刪除新對話時一起刪）。

### 階段二：`@tangent/client`

- `b20-routes.ts`：`AttachLineInput`、`AttachLineResult`、`normalizeAttachResult`、`classifyAttachError`（對話框用）。`TangentClient.attachLine(targetLineId, input)` → `POST /lines/{id}/attach`。
- `testing/mock-attach.ts`：照 `store/attach.go` 的檢查順序與錯誤碼；`attachPurpose`、`attachAnchor`（依時間）、`moveTree`（同上表：建議先過期再搬、筆記搬過去並 revision +1、里程碑併進目標的 `chaptersByLine`、目標刪除、種子／備忘／群組／收尾改 root）、來源線變支線（清資料夾、標籤、`spunOffFrom`）、子支線加深、帶卡時卡片接在最後並 `merged`；事件同 Engine。`mock-client.ts` 接上，`mock-contract.test.ts` 加 `exerciseB20`，`contract.test.ts` 加路由與 `route.lines.attach`。
- **mock 的閒置章節（F14 實測差異 #2）**：`testing/mock-chapters.ts` 在沒有預設章節的線上改成照 `domain/chapters.go` 算：開頭、相鄰兩則相差**超過** 30 分鐘的 `idle`、里程碑；距離不到 3 則（`MinMessages`）的切點只留等級高的（同等級留早的，開頭旁邊只有里程碑留得下）；最多 60 章（最短的併進鄰居）。跟伺服器一樣讀線上所有完成的訊息（含卡片與標記），`cardMessageIds` 也照填。場景裡已經寫好章節的線（NAS）維持原本的切分。
- 測試：`mock-attach.test.ts`（5）、`mock-chapters.test.ts`（6，案例同 `domain/chapters_test.go`，加一個匯入有 8 小時空檔的對話）。

### 階段三：`@tangent/react`

- **章節列日期去重（F14 實測差異 #1）**：`ChapterStrip` 在章節以時間命名（`titleSource: time` 或沒有標題）時不再加尾端的 `08/12`，`§2 2026/08/12 17:35` 只出現一次日期。
- **單則訊息時間（設計 S4b）**：新的 `MessageTime`（`<time dateTime>`，今天只有 `14:52`、其他日子 `08/12 14:52`；分隔符號 zh-TW `・`、en ` · `，螢幕閱讀器也會念出，免得「#3」和「14:52」連在一起）接在 `UserMessage` / `AssistantMessage` 的標籤後面（傳送中的與回答中的不顯示）。`actionsOf({ who })` 與按鈕名稱不變。
- **結論卡「匯入時建立」**：`BranchCard` 在 `branch.origin === "import"` 且卡片已送達時，把「已告訴 AI」換成 `Import` 圖示 +「匯入時建立・08/12 15:22」（時間在 `<time dateTime>` 裡）（en: `From import · …`；卡片被編輯過而等待送達時仍顯示那個狀態）。
- **`useAttachLine(targetLineId)`**（`data/b18-hooks.ts`）與 `settleAfterAttach`：寫入兩條線的 view、把來源從每個快取的清單拿掉，失效目標樹的大綱、章節、筆記、備忘、種子、建議、群組、目標線的訊息、主線 view、跟過來的子支線、清單與資料夾篇數。`event-sync` 的 `line.updated` 遇到帶 `conversationBranch` 的線，也從快取的清單拿掉（別的分頁併入時）。
- **拆解面板 ④（F15）**：`RelatedCard` 移到新檔 `f13/related-card.tsx`：每筆相關對話多「併為支線…」（`GitBranchPlus`）；併入後該列顯示「已併為支線」與「前往支線」，建立關聯與併入兩個動作只保留一個；卡片底部「併入其他既有對話…」（有寫入權限就出現，即使沒有任何相關對話）。`AttachLineDialog`（`f13/attach-line-dialog.tsx`，延遲載入的獨立 chunk）：來源（已知時顯示標題，否則從已載入的主線清單挑，排除本對話與封存的）、掛在哪一則之後（預設「依時間自動挑選」，或 `#n 你／AI／結論卡：摘要`）、支線目的（空著用來源標題）、兩種方式（原生 radio：「掛為支線並留結論卡（已帶回）」預設、必填結論；「掛為進行中支線」）、錯誤（`classifyAttachError`，深度超過軟上限時有「仍要開」）。用語在 `i18n/attach-messages.ts`（只跟延遲載入的部分走）。
- 測試：`conversation/f14.test.tsx`（日期不重複、單則時間與標籤不變）、`branch/branch-card.test.tsx`（en 與 zh-TW 的匯入標記）、`f13/attach.test.tsx`（相關對話併入帶卡、挑選其他對話併為進行中、檢視者看不到、對話框的拒絕訊息、`useAttachLine` 清單、別的分頁的 `line.updated`）。

### 階段四：demo、e2e、文件

- **10 分鐘跨重新整理的「復原這次匯入」**：`frame/f14/last-import.ts`（`sessionStorage` key `tangent.f14.lastImport`：`{lineIds, focusLineId, beforeLineId, messageCount, assembled, importedAt, dismissed?}`，讀的時候驗證形狀、過期或壞的就刪掉）。`useF13Frame` 的 `useImportUndo`：匯入時寫紀錄；載入時讀回，停在這次匯入的任一條主線上就恢復橫幅（使用者關過橫幅就不恢復）；10 分鐘到了用 timer 收起復原鈕；toast 與橫幅的復原是同一個函式（清掉紀錄、畫面在要刪的線上才回到 `beforeLineId`、刪除、完成 toast），第二次按什麼都不做。重新整理後沒有對話框的 outcome，改用 `useDeleteLine` + `undoAssembly` 刪除。`ImportedBanner` 多 `onUndo` / `undoLabel`（`RotateCcw`「復原這次匯入」，在「打開建議」旁邊），橫幅可換行。用語 `done.undo*` 從 `f14-messages.ts` 移到小的 `f14/undo-words.ts`（主入口要用，對話框也改用它）。
- toast 上的動作按鈕加 `inline-flex min-h-6`（axe 的 `target-size`，F14 起就有，這次的 e2e 在 toast 還在時跑 axe 才抓到）。
- e2e：新 `f15.spec.ts`（4：F14.1 的章節日期、單則時間、匯入卡標記與 toast 消失後從橫幅復原；相關對話併為支線並留卡、主線出現卡片、大綱出現支線、清單少一條；從「併入其他既有對話…」挑一條併為進行中；375 的橫幅與對話框）；`f14.spec.ts` 跟著 mock 的閒置章節改（§2 是 `2026/08/12 17:35` 的閒置章，最後一章是 §5；原本 17:35 的時間空檔分隔改由閒置章節的分隔線取代，同伺服器），復原改按 toast 裡的那顆（現在橫幅也有一顆）；共用步驟移到 `f14-flows.ts`。
- 文件：`docs/API.md`（新路由一節、op 表）、`docs/DESIGN.md`（§5 attach 不變條件、§6 Engine API、§7 路由表、§12.10 決定列）、`docs/design/DECISIONS_LOG.md`（同一列）、`docs/EMBEDDING.md`（§4.4 InTx 表、B20 說明）。

## 和工單不同的地方

1. **錯誤碼**：工單列的 `line_archived`、`branch_source_busy`、`branch_tree_limit`、`branch_depth_limit`、`branch_confirm_deeper` 不存在。實際沿用的是 `archived`、`source_busy`（目標回合中）、`branch_busy`（來源樹回合中）、`tree_limit`、`depth_hard_limit`、`depth_soft_limit`（就是「要 confirmDeeper」）；另外用到既有的 `branch_drafting`、`parent_closed`、`kind_unsupported`、`anchor_not_found`。`move_no_anchor` 在 httpapi 是 **400**（工單寫 409），照既有對照表。
2. **沒有 `RehomeMemos` 在 spinoff.sql**：它在 `store/queries/memos.sql`。但整棵樹一起走時依線搬會漏掉節點已刪（`line_id` NULL）的備忘，所以 attach 用新的 `MoveTreeMemos`（依舊主線）。同理建議、種子、收尾、章節切點、群組都用依 root 的新查詢（理由見上表），只有支線列沿用 `RehomeBranches`。
3. **筆記是搬不是複製**（新查詢 `MoveTreeNotes`），`labelMovingSources` 不需要（來源線一起過來）。
4. **目標、群組**：工單沒提。來源的目標刪除（一棵樹一個），群組搬過去保留（detach 會解散是因為拆開了）。
5. **`origin` 用 `move`**，不是 `import`：結論卡是併入時寫的，不是匯入時建立的；用 `import` 會讓卡片顯示「匯入時建立」。
6. **結論卡位置**：照工單用 `InsertMessage` 接在目標線最後（`delivered: true`，時間是現在），不是 B19 那樣插在錨點後。
7. **`sourceLineId` 是空字串**：`400 invalid_input`（`field: sourceLineId`），不是 404。
8. **來源線的標題改成 `purpose`、清掉起源膠囊、`notes_revision_sent` 歸零**：工單只說清資料夾與標籤；膠囊不清的話支線的每一輪 prompt 都會帶它（`prompt.go` 不分主線支線），`notes_revision_sent` 是對舊主線算的（審查 MEDIUM）。
9. **mock 閒置章節的規則照 `domain/chapters.go`**：間隔**超過** 30 分鐘（工單寫 ≥）、最小間距 3 則（工單寫 4）；時間章節的 `title` 照伺服器是 UTC 的 `2006-01-02 15:04`（工單寫 `""`；client 的 `chapterTitle` 本來就忽略它），`branchIds` 也照填（審查 MEDIUM）。只套在場景沒有預設章節的線上。
10. **`useAttachLine(targetLineId)`** 沒有 `rootLineId` 參數（主線從回應的 `branch.rootLineId` 拿）。**不失效 `decompose`**：拆解建議是「一次打開一份快照」（`staleTime: Infinity`），重抓會讓剛併入的那一列消失；面板關掉再開就是新的。
11. **用語與檔案**：`AttachLineInput` 等放在新檔 `b20-routes.ts`（`b18-routes.ts` 已 379 行），`RelatedCard` 移到 `f13/related-card.tsx`；對話框用語在 `i18n/attach-messages.ts`。路由的 handler 在 `httpapi/attach.go`，登記仍在 `b18Routes()`。
12. **「併入其他既有對話…」** 只列已載入的主線清單（第一頁），沒有分頁或搜尋；有寫入權限就顯示，即使沒有相關對話（這時拆解面板仍顯示「沒有建議」）。
13. **10 分鐘復原**：橫幅出現在這次匯入的任何一條主線上（工單 `lineIds.includes(selected)`），10 分鐘到了只收起復原鈕，橫幅留到使用者關掉；同一頁裡 toast 的復原仍用對話框給的 `outcome.undo.run`，重新整理後改用 frame 自己的 `useDeleteLine`（兩條路做的事與用語相同）。用語 `done.undo*` 搬到 `f14/undo-words.ts`。
14. **e2e 的 mock 不會跨重新整理保留資料**，所以「toast 關掉後從橫幅復原」是等 15 秒 toast 消失後再按；跨重新整理的恢復由 demo 的單元測試（`f14-frame.test.tsx`）覆蓋。`f14.spec.ts` 跟著 mock 的閒置章節改（見上）。
15. **工單 4.2 要求的截圖複製到 NAS、4.3 的 CHANGELOG / HANDOFF / ROADMAP / NAS 文件、合併與重啟 :8120** 留給協調者。

## 審查與修正

唯讀的 go-reviewer、typescript-reviewer、a11y-architect 三個 agent，都沒有 CRITICAL。修掉的：

- Go HIGH：`lockBranch` 鎖住後只比對 parent，attach 讓深度 1 的子支線 parent 不變、root 變了 → 也比對 `root_line_id`，不同就 `errBranchMoved`。`ProposeSuggestion`、`DismissOpenSuggestions`、`lockFreshSource`（fresh spinoff）同樣「讀 root、鎖、不重查」→ 新 helper `lockRootOf`（鎖住後重查），`lockNoteRoot`、`lockSeedRoot`、這三處都改用它；備忘與種子在 root 被換掉時從 `concurrent_change` 改成自動重試。新 store 測試：併入與「丟棄來源的子支線」「在子支線提出建議」同時跑。
- Go MEDIUM：來源樹各線的 `notes_revision_sent` 是對舊主線算的 → 新查詢 `ResetNotesRevisionSent` 歸零（測試先設 9 再檢查）。`attach.go` 兩處把 `err != nil || isBranch` 拆開，拿掉 `cmpErr`。
- TS MEDIUM：mock 章節的 `branchIds` 與時間標題照伺服器。復原失敗時沒有 `.catch` → 失敗 toast（有測試）；toast 的動作是匯入那次 render 的 closure → `navigate` / `toast` / 用語 / delete 從 latest ref 讀。
- TS LOW：`last-import` 的驗證更嚴（`lineIds` 不能空、整數的 `messageCount`、`importedAt` 有限、`dismissed` 是布林，有測試）；對話框的 `picked!` 與重複 `find`；`mutateAsync().then(…).catch`；`settleAfterAttach` 也失效來源線原本當主線時的整個 `line(id)` 前綴；`event-sync` 在這個分頁原本知道它是主線時才重抓資料夾篇數。
- a11y HIGH：從相關對話併入後觸發鈕消失、焦點掉到 body → 面板在對話框卸載後把焦點移到該列的「前往支線」（取消時回到開啟它的按鈕，有測試）。
- a11y MEDIUM：「仍要開」按下後警示消失 → 先把焦點移到送出鈕。沒選來源時按送出沒有任何回應 → 顯示 `role=alert` 的「選一條對話」；結論空白、目的過長時把焦點移到那個欄位；伺服器的 `invalid_card` 也掛到結論欄位。標籤與時間連在一起念（「#314:52」）→ 分隔符號不再 `aria-hidden`。toast 的焦點框在深色主題對比 1.36:1 → `outline-current`，觸控時 `min-h-10`。
- 協調者追加：匯入後把其中一條併到別處，10 分鐘內按「復原這次匯入」會被 `DELETE` 拒絕（`branch_not_main_line`）而顯示失敗 → `undoAssembly` 第一輪照舊平行刪除，被拒為支線的等其他都結束後逐一再刪一次：`line_not_found` 表示它跟著併入的那條（同一次匯入的）一起刪了、算已刪除，仍是支線表示併到匯入以外的對話、放進新的 `kept`；第一輪就 `line_not_found` 也算已刪除。用語新增「已復原：這次匯入的 n 條主線已刪除；m 條已併入其他對話，保留在那裡」（`undoText`，對話框與 frame 的復原共用）。測試：client 4 個（含 mock 上併入後復原 0 失敗；mock 對支線的刪除回 `branch_not_main_line` 同伺服器）、demo 2 個。
- a11y LOW：radio 的名稱只有標題，說明用 `aria-describedby`；固定的來源用 `<dl>`；送出中顯示「併入中…」（`loadingText`）；匯入標記用 `<time dateTime>` 並和文字放在同一段。

沒有改的：
- Go MEDIUM：`attach()` 的步驟與 `insertAttachedBranch` 的參數個數（沒有再抽 struct）；`AttachAnchorCandidate` 用 `created_at` 挑錨點是刻意的，DESIGN §12.10 有寫。
- Go LOW：沒有給舊主線的「消失」事件（hub 是全租戶的，來源線的 `line.updated` 已帶 `conversationBranch`，客戶端從清單拿掉）；沒有發舊主線的 `goal.changed`；目標是支線時不 touch 它的主線（同 `CreateBranch`）。
- TS LOW：兩條復原路徑沒合成一條；`beforeLineId` 是 null 時不導到別處；10 分鐘到了橫幅不收；picker 沒分頁；f13 的 barrel 靜態匯出 `AttachLineDialog`（同 `ExtractBranchDialog`，建置結果確認仍是獨立 chunk）。
- a11y：橫幅「復原這次匯入」按下後橫幅卸載、焦點掉到 body（已有完成 toast 念出；沒有找好的穩定目標）；套用狀態的 live region 是跟著文字一起插入的（既有 `ItemStatus` 的做法，這次用焦點移動補上）；同名按鈕沒有 `aria-describedby` 到各列標題；錨點說明沒接到 Select（`Select` 元件沒有 description）；`--tg-primary-text` 在 hover 底上 4.47:1（既有）。

## 留著的

- 協調者：CHANGELOG / HANDOFF / ROADMAP、測試手冊與 HTML 指南、把 `docs/devlog/screenshots/B20/` 歸檔截圖、合併、備份 `tangent` 後重啟 :8120 實測（新路由要新的二進位；沒有 migration）。
- 檢查其他「讀 root → 鎖 root」的寫入（例如 `chapters.go` 的 topic cut、`tags.go`、`folds.go`、`pins.go`、`comparisons.go`）是否也要用 `lockRootOf`；這次只改了審查點名與共用的鎖。
- 併入可能讓目標對話超過筆記、備忘、種子、里程碑、關聯、群組的每棵上限（只擋之後的新增）。
- 備忘沒有批次事件；別的分頁看到併入時要自己重新讀目標對話的備忘。
- toast 會蓋住對話框底部的按鈕、在 375 寬時超出畫面（既有，見截圖 `f15-attach-dialog-*`）。
- 「併入其他既有對話…」只看已載入的第一頁主線。
- 橫幅復原後的焦點、相關對話列的同名按鈕（見審查）。
- mock 仍沒有 topic 章節（伺服器有，從摘要的 `[TOPIC]` 來）。

## 截圖（`docs/devlog/screenshots/B20/`，淺色、mock、由 `f15.spec.ts` 以 `UPDATE_SCREENSHOTS=1` 產生）

| 檔案 | 內容 |
|---|---|
| `f14-1-chapters-times-card-1440.png` | 組裝匯入後：章節列 §2 閒置章節只有一次日期、每則訊息標籤後的時間、結論卡「匯入時建立・08/12 14:58」、橫幅的「復原這次匯入」、拆解面板 |
| `f14-1-banner-undo-1440.png` | toast 消失後，橫幅仍有「復原這次匯入」 |
| `f15-related-card-1440.png` | 批次匯入到同一資料夾後，拆解面板 ④ 每列的「併為支線…」與底部「併入其他既有對話…」 |
| `f15-attach-dialog-1440.png` | 併入對話框：來源、依時間自動挑選錨點、目的、兩種方式、結論 |
| `f15-attached-card-1440.png` | 併入後主線最後的結論卡，該列「已併為支線」「前往支線」 |
| `f15-outline-1440.png` | 關掉面板後大綱樹出現併入的支線，清單裡少了那條對話 |
| `f15-attach-picker-1440.png` | 「併入其他既有對話…」挑一條、選「掛為進行中支線」 |
| `f14-1-banner-undo-375.png` | 手機批次匯入後的橫幅（查看、復原這次匯入，可換行） |
| `f15-attach-dialog-375.png` | 手機全螢幕的併入對話框 |

## 協調者驗收（2026-11-03）

在 worktree 自己重跑最終關卡：`sqlc diff`、`go vet`、`gofmt -s -l` 無輸出；`go test ./... -count=1` 全過；smoke PASSED（929 events）；typecheck 5 個專案；vitest fonts 10、client 1,165、react 1,027、demo 226；主入口 JS gzip 169,466 bytes（上限 172 kB），`attach-line-dialog` 是獨立 chunk、只由 `f13-host` 引用；`e2e:mock --workers=2` 162 passed、3 skipped、0 failed（修正前後各一次）。沒有新 migration，工單 是 0644。

審查重點：
- 鎖的順序：兩條主線依 id、再目標線、再來源樹的支線（id 序），符合 DESIGN §5 的 root → parent → child。
- 逐表檢查：有 `root_line_id` 的表（suggestion、leaf、seed、note、chapter_cut、memo、group、goal、branch）都處理了；fold、comparison、job、link、group_member、message_tag 只指向線或訊息，不用搬。關聯（link）在併入後可能變成同一棵樹裡的關聯，`ListLinks` 會列出，可以接受。
- 協調者補的一個邊角：批次匯入後把其中一篇併為支線，再按「復原這次匯入」，`DELETE` 支線會回 `branch_not_main_line`，原本被算成失敗。改成第二輪重刪：404 算已刪除（跟著併入的那篇一起刪掉了），仍是支線就列為「保留」並在提示說明（`undoAssembly` 回傳多了 `kept`）。

### 真實 :8120 實測（合併、備份 `tangent-db-backup-202611031402-pre-b20.sql`、重啟之後）

- `POST /api/lines/{id}/attach`：空的 `sourceLineId` 回 `400 invalid_input`（`field: sourceLineId`）。批次匯入 5 篇到同一資料夾後，從 ④ 把「PgBouncer transaction mode 的限制」併為支線並留卡（`origin: move`、`merged`、depth 1），再用「併入其他既有對話…」把「最終設定檔」掛成進行中支線（`open`）。主線最後出現結論卡，清單少了這兩篇，大綱出現支線。
- 刪除語意與復原修正一致：`DELETE` 併入的支線回 `409 branch_not_main_line`，刪掉它的主線後再刪回 `404 line_not_found`。UI 上「批次匯入 → 併為支線 → 復原這次匯入」顯示「已復原：這次匯入的 5 條主線已刪除」（6 個 DELETE，含第二輪那一個）；樹狀匯入後重新整理、回到那條主線，橫幅的「復原這次匯入」仍在，按下刪除成功。
- 章節膠囊：閒置章節只寫一次日期（`§2 2026/08/12 17:35`、`§4 2026/08/15 11:29`），沒有一顆重複日期；訊息時間「・08/12 14:20」；卡片「匯入時建立・08/12 14:58」。
- 觀察到、沒有改的：
  - 併入的結論卡時間是「現在」，和目標線最後一則相隔超過 30 分鐘時，伺服器在卡片前切一個閒置章節（「2026/11/03 13:08 … 閒置後」，章節裡只有那張卡）。要不要讓章節略過系統卡片，留給之後決定。
  - 批次匯入 5 篇時，事件觸發的清單重抓很多（`GET /lines` 19 次、`/lines/organization` 9 次），參考伺服器的每位址限流（每分鐘 600、瞬間 60）會回幾個 429；匯入本身成功，React Query 之後重抓會補上。探測腳本連續做兩次大匯入時，429 會擋到復原的 DELETE（顯示「有 n 條主線沒有刪掉」）；正常操作速度沒有遇到。F14 的批次匯入就有，不是 B20 新增的。
  - :5183 的 Vite 監看在 fast-forward 後沒有更新 `packages/client/src/index.ts`（仍是舊的轉換結果，缺 `b20-routes` 的匯出，頁面載入失敗）；`touch` 與寫入再還原都沒有觸發。實測改用 `vite preview` 在 :5184 接同一個 :8120；:5183 要重啟才會恢復。
