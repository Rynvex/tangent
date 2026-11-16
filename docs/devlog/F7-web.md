# F7 · 刪除對話

> 2026-10-23。工作單（`4f3784d`）。只動了 `web/` 與本檔；沒有改 Go，沒有 commit。
> 後端（soak、B7.2 之後的修改）同時有人在改 Go，真 API 的 e2e 伺服器從 HEAD 的 `git archive` 副本建置（`TANGENT_E2E_SRC`；先是 `0e3137e`，B7.2 進來後改用 `043b418`）；之後 Go 都已 commit（HEAD `c6df638`），最後的全套直接從工作目錄建置；Playwright 自己挑空的 port，沒有碰 :8120、:8122、:5183。
> 工作中協調者追加了 B7.2 的兩個前端修正（宿主系統訊息），一起放在本步，見最後一節。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck`（含 e2e） | 通過 |
| vitest（逐一套件） | fonts **9**、client **831**、react **794**、demo **103** |
| `pnpm -C web build` | 通過。主 JS **176.91 kB gzip**（開工時 175.63；F7 本身 176.80，B7.2 的修正 +0.11）。選單（`conversation-menu`，0.86 kB）與確認對話框（`delete-conversation`，含文字，2.03 kB）都是延遲載入塊；主程式只多了 `useDeleteLine`、共用的快取清除、刪除後的導向與 6 個主字典的字 |
| Playwright | 全套（最後一次，真 API 伺服器從工作目錄 `c6df638` 建置，`--workers=3`）：**204 passed、64 skipped、0 failed**。其中 `f7.spec.ts` **26 passed、7 skipped**（mock 10＋1、api 10＋1、api-core 6＋5；skip 都是刻意的）。機器上有別人的 Python 工作把 load average 推到 20–40，預設 worker 數的全套會有 3–16 個 30 秒逾時（每次不同的 spec），`--last-failed` 重跑全過；見「過程」 |
| axe | 確認對話框（1440，moderate+）、刪除被拒時的對話框（1440，moderate+）、刪除後的頁面（1440、375，serious+）、420 嵌入與 375 手機的對話框（serious+） |

## 做了什麼

### client（mock）
- `mock-delete.ts`：`DELETE /lines/{id}` 照 `store.DeleteTree`：支線 → `409 branch_not_main_line`；樹上任何一條線在回覆（`thinking` 或有 pending 訊息）→ `409 session_busy`；主線排第一個；整棵樹掛著的資料一起拿掉（訊息、支線、紀要、章節、收尾、種子、建議、群組、折疊、比較、目標、串流），**別棵樹指向它的連結也拿掉**（伺服器是 `ON DELETE CASCADE`）。封存的樹照樣能刪。

### react
| 項目 | 內容 |
|---|---|
| `useDeleteLine()` | `mutationFn: deleteLine(lineId)`；成功後呼叫共用的 `forgetTree` |
| `forgetTree`（新檔 `data/tree-cache.ts`） | 刪除的結果與 `line.deleted` 事件**走同一個函式**：從兩個對話列表（一般、封存）拿掉、移除每條線底下所有 query、清掉 live store 的串流與重試；跨對話的讀取標成過期：未完成清單（`openLoops`）、搜尋、各棵樹的連結與關聯、`spunOffFrom` 指向它的那條線（`available` 會變 false） |
| 不重複、不衝突 | live store 記住刪掉的線 id（id 不會重用），`forgetLines` 回傳「是不是新的」；第二個到的（結果或事件，哪個先都一樣）什麼都不做，不會再 invalidate 一次 |
| `event-sync` | `line.deleted` 改成呼叫 `forgetTree`（原本只拿掉列表與 query） |
| `DialogContent.finalFocus` | 新的選填 prop（Base UI 的 `finalFocus`）：觸發的按鈕跟著對話一起不見時，關閉後焦點要有地方去 |
| 匯出 `ErrorAlert` | 對話框裡的拒絕訊息（demo 的確認對話框用） |
| 主字典 | `shell.actions`（「「…」的動作」）、`shell.archiveItem`、`shell.unarchiveItem`、`shell.deleteItem`（「刪除對話…」）、`shell.deleted`（「已刪除「…」。」）、`shell.deletedElsewhere`；拿掉不再用的 `shell.archive` |

### demo
| 項目 | 內容 |
|---|---|
| `ConversationMenu`（「「標題」的動作」，⋯ 圖示） | 選單（既有的 `Menu`）：「封存對話」／「解除封存」、分隔線、「刪除對話…」（危險色）。對話列表每一列（**取代原本的封存圖示鈕**；一般、搜尋結果、封存區的列都有）與對話標頭（**只在主線**；支線沒有，因為只能整棵刪）。唯讀身分兩處都沒有。列上的按鈕平常隱藏，hover、焦點在列內或選單開著時出現，觸控裝置一直顯示；觸控時列至少 44px 高、按鈕置中，不會伸進下一列 |
| `DeleteConversationDialog`（延遲載入，文字在自己的 `delete-messages`） | 標題「刪除「…」？」、說明「刪除後不能復原。」（`aria-describedby`）；內容：「會刪掉整棵對話：主線、N 條支線（不論開著或已結束），以及其中所有訊息、紀要與章節。」（N 是含旁註的整棵樹，讀 `GET /branches?includeAside`；沒有支線、還沒讀到各有一句）、「只是不想在清單上看到它？改用封存，之後還能解除封存。」（封存的對話改成「它已封存；刪除後就不能再解除封存。」）。按鈕：取消（**預設焦點**）、改為封存（封存的對話沒有）、刪除對話（`destructive`）。Esc 取消。拒絕留在對話框裡：`session_busy` →「這段對話裡還有正在回覆的回合。等它結束（或先停止）再刪除。」，其他用 `describeError`。依對話 id 重設 |
| 刪除之後（`frame/delete-host.ts`） | 刪掉的是畫面上的對話（主線或它的任何支線）時，**明確地換到下一段**：列表裡排在它後面的那段，沒有就前面那段（封存的對話在畫面上時是列表的第一段）；一段都不剩就顯示「選一段對話，或開始新對話。」。同時關掉這棵樹的支線對話框、回顧與全幅地圖，記住的 root 清掉（不會再去讀被刪的樹）；toast「已刪除「…」。」。焦點移到列表裡現在的那一列，沒有列表就到輸入框、列表的第一個按鈕或標頭 |
| 別處刪除 | `useTangentEvents({ onEvent })` 收到 `line.deleted`：畫面上的那棵就同樣離開，toast「你正在看的對話已被刪除（在別的分頁或裝置上）。」；別棵只更新列表，不打擾。自己刪的事件可能比 HTTP 結果先到：對話框開著、是同一棵 → 當成自己的（關對話框、只出一次「已刪除」）。每棵樹只處理一次 |
| 找不到 | 畫面上那條線讀回 `line_not_found`（例如斷線重連後錯過了事件）時也同樣離開，不留下壞掉的畫面 |
| 列表抽屜開著時 | `main` 設 `inert`：抽屜後面被遮住的對話不在 Tab 順序與輔助技術裡（見過程） |

### e2e（新檔 `f7.spec.ts`，`api` 與 `api-core` 都跑；這個檔裡的測試依序在同一個 worker 跑）
| 寬度 | 測試 | mock | 真 API |
|---|---|---|---|
| 1440 | 列的選單 → 對話框的說明（1 條支線、不能復原、建議封存）、焦點在取消、axe → Esc 取消、焦點回到選單鈕 → 再開 → 刪除 → toast、列表沒有它、顯示下一段、焦點在現在的那一列；真 API 再確認 `GET /lines/{id}` 是 404 | ✓ | ✓（含 core） |
| 1440 | 標頭的選單只在主線（進支線就沒有）→ 從標頭刪掉正在看的對話 → 離開 | ✓ | ✓（含 core） |
| 1440 | `[fake:slow]` 回覆中刪除 → 對話框裡的 `session_busy` 句子、axe → 回覆結束後再按就刪掉 | ✓ | ✓（含 core） |
| 1440 | 封存區的對話從它的列刪除（沒有「改為封存」、寫「它已封存…」「它沒有支線」） | ✓ | ✓（含 core） |
| 1440 | 對話框的「改為封存」 | ✓ | ✓（含 core） |
| 1440 | 另一個分頁刪掉正在看的對話（`line.deleted`）→ 這頁離開並說明 | 略（mock 只在一頁裡） | ✓（含 core） |
| 1440 | 唯讀身分（`as=viewer`）列與標頭都沒有選單 | ✓ | ✓ |
| 420 | 嵌入：標頭的選單、對話框不超出 420、頁面不橫向捲、axe → 刪除後顯示下一段 | ✓ | ✓ |
| 375 | 手機：列表抽屜裡的選單鈕與「刪除對話」≥ 44px、觸控操作、頁面不橫向捲、axe（對話框與刪除後）；標頭的選單鈕 ≥ 44px | ✓ | ✓ |

截圖：`shoot(page, "F7", …)` 已寫在測試裡（confirm-1440、busy-1440、confirm-420、confirm-375），但這次沒有用 `UPDATE_SCREENSHOTS=1` 產生——工作單只允許動 `web/` 與本檔，`docs/devlog/screenshots/F7/` 留給協調者決定。

## TDD 紀錄

先寫、看到紅燈：client `mock-delete.test`（`session_busy` 與別棵樹的連結 2 紅；其他 3 條原本的 mock 就過）；react `delete-line.test`（`useDeleteLine` 不存在，6 紅）。
沒有紅燈紀錄（實作同時或之後寫）：`live-store.test` 的 `forgetLines` 回傳值、demo 的 `delete-conversation.test`（選單與對話框 8 條）與 `delete-host.test`（刪除後的行為 7 條）、e2e。改了既有測試：`conversation-search.test` 的 `ConversationList` 多一個必填的 `onDelete`。

## 過程

- e2e 第一版：(1) 用「頁面上沒有 `role=alert`」判斷沒有壞掉，但狀態橫幅的 live region 一直在（空的）→ 改成「沒有任何有字的 alert」；(2) 進支線用了不存在的按鈕名稱 → 改點大綱的 treeitem。
- 375 刪除後的 axe 抓到 `target-size`：抽屜開著時，標頭多了選單鈕，「設定」鈕剛好跨在抽屜邊上、被遮住一半。這是抽屜一直有的問題（背景沒有 inert），選單鈕讓它現形 → 抽屜開著時 `main` 設 `inert`。同時發現觸控時列的高度可能小於 44px 的按鈕 → 列至少 44px、按鈕置中。
- 真 API 第一次跑，「刪除後焦點在現在的那一列」紅：這次的資料庫裡只有那一段對話，刪掉後沒有下一段 → 焦點的備案加上列表的第一個按鈕（「新對話」）；測試先建一段較舊的對話當「下一段」。另外刪除後列表的「目前」在下一段的線還沒載入前用 `selected`（原本等 root 讀到才標），焦點才有地方落。
- 真 API 平行跑時，A 測試刪掉後顯示的「下一段」可能是 B 測試的對話，B 隨即刪掉它 → A 收到「已被刪除」的 toast 而不是自己的 → `f7.spec` 改成依序在同一個 worker 跑（其他 spec 都不刪對話）。
- 全套第一次：刪除後「焦點在現在的那一列」在真 API 上紅——別的 spec 一直在開新對話，畫面「回到預設＝最新的一段」就一直換，焦點留在舊的那一列 → 改成刪除後**指名**下一段（`nextConversation`，有單元測試）。`session_busy` 的測試在負載下也紅過一次：`[fake:slow]` 的 3 秒在打開選單與對話框的時間裡就過完了 → 真 API 改成先打開對話框、再用 API 送出慢的回覆。
- e2e 的「已刪除」toast（2.8 秒）在高負載下會在對話框的離場動畫結束前就消失 → 測試改成先等 toast、再等對話框關掉。
- 全套有一次在我同時跑 vitest 與 build 時多了 7 個 mock 的逾時（branches、conversation、search、screens 等，全是 30 秒的逾時），沒有同時跑別的東西時就沒有；`smoke` 的 gallery axe（Base UI focus guard 的 `aria-hidden-focus`）在第一次全套紅過、單獨跑與之後的全套都過——負載下的時序，沒有改。

## 與工作單 / 設計的差異、決定

1. **列上的封存圖示鈕換成選單**（封存、刪除在一起），封存從一下變兩下；換來的是列上只有一個按鈕、標題不會被擠得更短。
2. **刪除後顯示「下一段」**（列表裡它的下一段，依活動時間），各種寬度都一樣；手機不自動打開列表抽屜。指名那一段而不是「回到預設」：預設是「最新的一段」，別處一開新對話畫面就會跟著跳。
3. 標頭的選單**只在主線**；在支線上要刪整棵樹，先回主線（或用列表）。工作單說支線「入口不出現」，所以支線的標頭沒有選單（也沒有封存）。
4. 支線數用整棵樹（含旁註）的 `GET /branches`；`LineView.branchCounts` 只數直接的子支線，不夠。讀到之前用不帶數字的句子。
5. 「改為封存」放在對話框裡（工作單：建議改用封存）。
6. 別棵樹的 `spunOffFrom` 指向被刪的樹時，那條線的 `LineView` 只是標成過期（重讀後 `available: false`）；**記憶的出處**指向被刪的線時不處理（跨對話記憶屬於整個租戶，點出處會讀到 `line_not_found`，這時畫面同樣會離開並說明）。
7. 列表的 rail（1024–1279 的圖示列）沒有選單；要刪就展開列表或用標頭。

## 後端缺口與問題

沒有缺口。一個觀察：刪除時伺服器不會對別棵樹發 `link.changed`（連結是 cascade 掉的），前端是自己把各棵樹的連結與關聯標成過期；若之後想精準一點，可以考慮刪除時對被連到的樹發 `link.changed{deleted: true}`。

# B7.2 的前端修正（協調者追加，2026-10-23）

> 依 B7.2（`043b418`，宿主系統訊息規格）：宿主可以寫系統訊息（`role=system`、`kind=chat`），在回覆之後（失敗的回覆也會）、也可以在回覆還在串流時寫，排在 pending 回覆之後。契約樣本沒有變。

| 項目 | 改了什麼 | 測試（都先紅） |
|---|---|---|
| 重試按鈕 | `MessageList` 的 `lastId` 跳過宿主系統訊息（`messages.findLast(m => !isHostNotice(m))`）：失敗的回覆後面有通知時仍然有「重試」（後端 `RetryTurn` 也跳過它們） | `message-list.test`：失敗回覆＋通知 → 重試在回覆上 |
| 串流泡泡不假設自己是最後一則 | `visibleMessages` 一律依 seq 排（呼叫端已經排好時保留同一個陣列，列表的 memo 不受影響；樂觀的訊息仍排最後）；`MessageList` 因此不依賴傳進來的順序 | `message-list.test`：通知在 pending 之後、陣列順序顛倒也照 seq 顯示、回覆照常串流；`message-cache.test` |
| 事件 | `message.created` 是宿主通知時，那條線的預覽標成過期（下一輪的歷史裡有它，B7.2）；不碰串流與回合狀態 | `event-sync.test`：串流中的通知排在後面、串流文字不受影響、預覽過期 |
| 其他「最後一則」 | `client` 新增 `isHostNotice`；⌘B 開支線的 anchor（demo 的 `lastId`）與結構面板的 anchor 跳過通知（通知不能當 anchor）；新對話的記憶回想不因為有通知就關掉 | `branch-view.test` 的 `isHostNotice` |
| mock | `mock.appendSystemMessage(lineId, text)`（同 `Engine.AppendSystemMessage`：下一個 seq、發 `message.created`、封存或已結束的支線拒絕）；**mock 專用**的指令 `[fake:notice]`：pending 回覆一建立就寫一則「Host notice (fake runner)」，所以它排在仍在串流（或之後失敗）的回覆後面；`retry` 跳過通知 | `mock-notices.test`（3 紅） |
| e2e（mock） | `f7.spec` 的「a host's notices (B7.2)」：`[fake:error] [fake:notice]` → 失敗的回覆有「重試」、按了會再跑；`[fake:slow] [fake:notice]` → 串流中的回覆在上、通知在下，回覆完成後位置不變；axe。真 API 略過：參考伺服器沒有宿主寫通知 | — |

差異：mock 的送出前預覽仍不把宿主通知放進歷史（伺服器會放）；只影響 mock 預覽的 token 數，沒有改。
