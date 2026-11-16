# F5 · P2 介面（階段 1）：目標與偏題、關聯線、釘選、回顧、「待處理」加開太久的支線

> 2026-10-16。依該階段工單，只做**階段 1**（魚眼、群組與合併等協調者通知）。
> 只動了 `web/` 與 `docs/devlog/`（本檔與 `screenshots/F5/`），沒有改 Go，沒有 commit。
> 後端 B9 階段 B 同時在改工作目錄的 Go 與樣本，所以：client 的契約測試以 HEAD（`a46f043`，樣本與 `785ede4` 相同，127 檔）為準，用 `TANGENT_CONTRACT_DIR` 指向 `git archive HEAD` 的副本；
> Playwright 的真 API 伺服器用 `TANGENT_E2E_SRC` 從同一份副本建置。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過（fonts、client、react、demo、e2e） |
| vitest（逐一套件） | fonts **9**、client **634**（開工前 599，其中 79 個紅燈）、react **658**（593）、demo **82**（73） |
| `pnpm -C web build` | 通過。主 JS **172.94 kB gzip**（開工時 179.64；騰出空間後 170.71；上限 180） |
| Playwright | 全套 **134 passed、35 skipped、0 failed**（共 169：mock 78、api 60、api-core 31；skip 都是刻意的：依伺服器的功能組合只跑對應的那一組）。F5 的漂移測試另外連跑 18 次都綠 |
| axe | 目標編輯（moderate+，1440）、偏題提示（moderate+）、建立關聯對話框（moderate+）、側欄的關聯清單與地圖關聯圖層（moderate+）、回顧（moderate+）、420 嵌入整頁（serious+）、375 手機回顧（serious+） |

client 對**工作目錄**的樣本（128 檔，階段 B 進行中）有 4 個紅燈：`route.preview` 與新的 `route.preview.fisheye`（client 與 mock 各 2）——魚眼是階段 2，等階段 B 完成再接。

## 先騰出空間

開工時主 JS 179.64 kB。用 sourcemap 把主程式的位元組歸到原始檔，最大的可拿掉的一塊是 **zh-TW 字典**（`zh-TW*.ts` 合計約 19.4 kB raw），英文使用者也在下載。

- `i18n/index.ts`：zh-TW 改成**用到才載入**的 chunk（`import("./zh-TW")`）；英文是退路，一直在主程式。新 API：`loadLocale(tag)`、`localeMessages(tag)`、`registerLocale(locale, messages)`（宿主自己打包字典時用）、`subscribeLocales`、`LOCALES`。拿掉 `BUNDLED_MESSAGES`。
- `TangentProvider`：用 `useSyncExternalStore` 看字典；還沒到時用英文翻譯，到了就換（有測試）。demo 的 `main.tsx` 在第一次 render 前 `loadLocale` 與建立 client 一起等，所以不會先閃英文。
- 測試的 setup 直接 `registerLocale("zh-TW", zhTW)`（react）或 `await loadLocale("zh-TW")`（demo）。

| 階段 | 主 JS（gzip） |
|---|---|
| 開工 | 179.64 kB |
| zh-TW 分出去（`zh-TW-*.js` 10.0 kB gzip，只在中文時下載） | **170.71 kB** |
| 加完 F5 階段 1 | 172.94 kB |

F5 留在主程式的只有：釘選（動作、標記、`usePinMessage`）、「關聯…」動作、四個錯誤碼的文字、事件同步、`useSuggestions`（搬到小模組 `suggestion-query.ts`，偏題提示要用）與 `driftByMessage`。目標膠囊、偏題提示、關聯（對話框、清單、地圖圖層）、回顧與它們的文字（`p2-messages.ts`、demo 的 `review-messages.ts`）都懶載入。
過程中抓到一次漏進主程式：`p2.ts` 為了 `MAP_ROOT_KEY` import 了 `branch-map-layout`，把地圖排版整包拉進主程式（+0.9 kB）；把地圖用的函式拆到 `p2-map.ts` 後回到 172.9。

## 做了什麼

### 1. `@tangent/client`
- 型別：`Message.pinned`、`LineView.staleBranches`、`Goal`／`GOAL_SOURCES`。
- `p2-routes.ts`：10 條路由的輸入與 normalizer（`getGoal`／`putGoal`／`deleteGoal`／`proposeGoal`、`listRelations`／`createRelation`／`deleteRelation`、`listOpenLoops`、`pinMessage`／`unpinMessage`）；`OpenLoops` 的四組（`staleBranches` 一定有，其他三組只在功能開著時有）。
- 事件：`goal.changed{rootLineId, goal|null}`、`link.changed` 的 `deleted`（只在 `true` 時出現）。錯誤碼 4 個進 `DOMAIN_ERROR_CODES`（`errors.test` 對 `domain/errors.go`）。
- `p2.ts`（純邏輯）：`goalLine`／`validateGoal`（一行、≤ 300）、`goalProposalOf`、`driftOf`、`driftByMessage`（每則回覆最多一則、取最新）、`relationSuggestionOf`、`idleDays`；`p2-map.ts`：`relationsOnMap`（地圖畫得出來的與其他）、`sameRelationEnds`。
- `inboxCount` 加 `staleBranches`（`open_loops` 開著才算）。
- mock（`mock-p2.ts`）：目標（讀寫、清除、`goal_not_found`、提案〔`draftMs` 後落在建議匣，auto 直接寫入〕、suggest／auto 在主線第 2 個回覆後自動提一次、PUT 讓 open 的提案過期）、偏題（見「決定」）、關聯（建立、跨對話、重複／上限／長度／端點檢查、刪除、`link.changed` 給碰到的每棵樹、訊息端點讀取時跟著訊息走、支線結束後建議關聯到最新的另一條支線）、`/links` 在 spinoff 或 relations 任一開著時列出開著的種類、未完成清單（範圍、`staleDays` 1–365、每組 50）、釘選（只有完成的聊天訊息與結論卡、狀態有變才發 `message.updated`）、預覽在規則後加目標區塊。
  情境 1：NAS 有原型的目標、`okr`（e2e 的「新對話」）也有一個；新增情境的「現在」（10/17 21:00）讓「改用雲端備份」開太久、硬碟價格那條不算（它的 `lastActivityAt` 改成 10/15）。目標與關聯的模式改成 suggest（同參考伺服器的預設）。
- 契約：`contract.test` 的路由表加 10 條、`EXPECTED_SAMPLES` 加 B9 的 22 個；mock 契約測試走一遍所有 P2 路由。

### 2. `@tangent/react`
| 元件 / hook | 內容 |
|---|---|
| `GoalCapsule`＋`GoalEditor`（C4） | 路徑旁的虛線膠囊：目標一行或「設定目標」；窄寬只剩圖示（`compact`）。點開是 popover：全文、來源（手動／AI 提案；auto 模式 AI 寫的標「AI 做的」）、「目標每一輪都會給 AI。」；修改（Enter 存、Esc 只取消編輯、≤ 300 與必填）、清除、「讓 AI 提案」（任何模式都有；manual 只有這顆）。open 的 `goal_propose` 在 popover 裡以虛線框顯示，「採用／不用」。提案**只在膠囊上加一個點**（螢幕閱讀器念「AI 提了一個目標」），不開任何東西、不搶焦點。唯讀身分只看 |
| `DriftHint`（C4） | 在偏題的那則回覆下方，虛線 `--tg-suggestion`：「這段好像偏離目標（理由），要開成岔題嗎？」；開成順口問／查證（照 payload 與 `aside` 開關）、停車（`parking` 開；把岔題的目的停成種子並忽略這則）、不用。不彈窗、不搶焦點；唯讀只看 |
| `RelationDialog`（C3） | 不用拖曳的建立方式：起點已知（訊息或線），「連到」選這個對話的線或其他對話，說明選填（伺服器的 `labelMaxRunes`），伺服器的拒絕原樣顯示 |
| `RelationList` / `RelationsSection` | 大綱下的「關聯 n」：每條兩端都可跳（含其他對話、訊息端點跳到那則）、刪除後 5 秒內可復原（重建同一條）、AI 的建議虛線「確認／移除」、「新增關聯」 |
| `BranchMap` 關聯圖層 | 圖層開關「關聯」（`aria-pressed`）；實線＋說明、AI 建議虛線＋確認／移除；節點右緣 8px 圓點拖到另一個節點（自己與已有關聯的不吸附、拖到邊緣自動平移、放開在空白取消）；鍵盤：節點上按 R → 方向鍵（最近的優先）→ Enter → 寫說明 → Enter（Esc 不寫說明）；點說明選取 → 刪除（或 Delete 鍵）→ 復原；唯讀沒有圓點與刪除；拉線時的狀態念給螢幕閱讀器聽。`useMapRelationsData` 從伺服器餵資料 |
| 釘選 | 訊息動作「釘選／取消釘選」（`aria-pressed`），使用者與 AI 的完成訊息都有；訊息標籤旁「已釘選」；`usePinMessage`（每次按都 `mutateAsync`）|
| `InboxPanel` | 最上面「開太久的支線」（`open_loops` 開）：標題、「n 則・d 天沒有動」、繼續／結束並帶回；底部「回顧所有未完成的事 →」（`open_loops` 開且宿主給了 `onReview`） |
| `SuggestionCard` | 認得 `goal_propose`（目標：…）、`drift`（理由）、`relation`（A – B 與說明） |
| hooks | `p2-hooks.ts`（懶載入的部分用）：`useGoal`／`usePutGoal`／`useDeleteGoal`／`useProposeGoal`、`useRelations`／`useCreateRelation`／`useDeleteRelation`、`useOpenLoops`；`useAcceptSuggestion` 接受後把結果寫進快取（目標、新支線、關聯） |
| SSE | `goal.changed` 精準寫入目標並讓預覽重讀（目標在每一輪的 prompt）；`link.changed` invalidate 關聯與連結；`message.updated` 帶來釘選；seeds／suggestion／notes／branch 的事件讓未完成清單重讀 |
| 預覽 | `goal` 區塊叫「目標」（原本會顯示成「宿主區塊「goal」」） |
| 錯誤文字 | `goal_not_found`、`relation_not_found`、`relation_exists`、`relation_limit{limit}` |
| i18n | 主字典只加 9 個鍵（`en.p2.ts`／`zh-TW.p2.ts`）；其餘在懶載入的 `p2-messages.ts`（`HostMessages` 含 `P2MessageKey`） |

### 3. demo
- 頁首：路徑後的目標膠囊（`goal` 開才載入；< 1024 寬與 420 嵌入是圖示）。
- 對話：釘選、「關聯…」（開 `RelationDialog`，起點名稱「主線 #n」）、偏題提示（只在主線、`goal` 是 suggest／auto 且建議匣開、這棵樹有 open 的建議時才讀建議）。
- 待處理：開太久的支線的繼續（到那條支線）、結束並帶回（結論卡流程）；「回顧所有未完成的事」。
- `ReviewBoard`（C5，demo）：蓋住對話欄（手機全螢幕），「回顧：還沒收尾的事」、剩 n 項、範圍（這個對話／所有對話）、四欄（開著太久的支線、待確認的紀要、停車場的種子、未處理的建議）。每項：
  結束（支線→結論卡流程、紀要→「已確認」＝移到已確認的事實、種子→丟掉、建議→忽略）、暫存（一天，只存在這個瀏覽器，`snooze.ts`）、繼續（支線→前往、紀要→到來源、種子→展開成支線〔別的對話的種子則前往〕、建議→接受〔樹平衡則前往那條支線〕）。「顯示暫存的」可取消暫存。Esc 關閉。
- 地圖全幅也有關聯圖層；結構面板的關聯可跳到其他對話。
- **捲到底的修正**：`useStickToBottom` 只在讀者往上捲時才放開。原本任何讓距離底部 > 48px 的捲動事件都會放開，`content-visibility` 的列在捲動後才取得真正高度時會誤放開，晚到的偏題提示就停在畫面外（真 API 的 e2e 抓到，偶發）。

### 4. e2e（`f5.spec.ts`，mock 與真 API）
| 寬度 | 測試 | mock | 真 API |
|---|---|---|---|
| 1440 | 目標：第 2 則回覆後 AI 提案只在膠囊加點、焦點仍在輸入框、沒有對話框 → 採用 → 鍵盤修改（Enter）→ Esc 關閉、焦點回膠囊；重新載入仍在（只真 API）；axe | ✓ | ✓ |
| 1440 | 偏題：提示在偏題那則回覆下方、在畫面內、焦點仍在輸入框 → 開成查證 → 到新支線；axe | ✓ | ✓ |
| 1440 | 關聯：回覆的「關聯…」→ 對話框 → 大綱的關聯清單 → 地圖用鍵盤（R、方向鍵、Enter、說明）→ 選取刪除 → 復原；axe | ✓ | ✓ |
| 1440 | 關聯：支線結束後 AI 建議（虛線）→ 確認 | ✓ | ✓ |
| 1440 | 釘選：動作、標記、`aria-pressed`；重新載入仍在（只真 API）；取消 | ✓ | ✓ |
| 1440 | 回顧：從待處理底部進入、四欄、剩 n 項、暫存、Esc；axe | ✓ | ✓ |
| 1440 | 功能關閉：沒有膠囊、沒有「關聯…」、沒有關聯清單、沒有回顧入口；釘選還在 | C1 | api-core |
| 420 嵌入 | 圖示膠囊開編輯、偏題提示不超出寬度；axe | ✓ | ✓ |
| 375 | 觸控釘選（高 ≥ 44）、底部抽屜的待處理 → 回顧全螢幕（關閉鈕 ≥ 44）；axe | ✓ | ✓ |

其他 e2e 的調整：`playwright.config.ts` 的 `api` 伺服器加 `goal:suggest,relations:suggest,open_loops`（參考伺服器的新預設），兩個專案的 testMatch 加 `f5`；
`flows.freshConversation` 在 `api` 專案先 PUT 一個目標（`goal:suggest` 會在每個對話第 2 則回覆後自動提案，之前的 P1 測試以建議匣的數量為準；mock 的 `okr` 也有目標，同理）；
`features.spec` 的回覆動作多「關聯…」「釘選」（只開核心時是「從這則開支線、釘選、複製訊息」）；`smoke.spec` 的待處理數量 4 → 5（多一條開太久的支線）；`structure.spec` 的全幅地圖改成聚焦 `[data-tg-map-canvas]`（第一個 `role=group` 現在是圖層開關）。

截圖：`UPDATE_SCREENSHOTS=1 pnpm -C web/e2e e2e f5` → `screenshots/F5/`（goal-proposal、drift、relations-map、pin、review 1440；goal 420；review 375；mock 與真 API 各一）。與原型 C3–C5 對照：目標 popover 的「AI 提案」虛線框與「採用」、偏題提示的位置與三顆按鈕、回顧的四欄與「結束／暫存／繼續」、地圖關聯線的實線＋說明與虛線建議都相符。

## TDD 紀錄

先寫測試、確認紅燈再實作：
- client：開工時 79 個紅燈（契約 44、mock 契約 34、`errors.test` 1）；`p2-routes.test`（模組不存在）、`p2.test`（模組不存在）。
- react：`lazy-locale.test`（5 紅）、`event-sync` 的 B9（3 紅）、`p2-hooks.test`（模組不存在）、`error-text`（1 紅）、`message-list` 的釘選／關聯／附加內容（4 紅）、`drift.test`、`relations.test`（模組不存在）、`relation-layer.test`（8 紅）、`structure-panel` 的關聯（2 紅）、`inbox` 的 B9（3 紅）、`models` 的目標區塊（1 紅）。
- demo：`snooze.test`、`review-board.test`（模組不存在）、`stick-to-bottom.test`（2 紅，由 e2e 的偶發失敗引出）。
- 沒有紅燈紀錄：`goal.test`（先寫好但實作前沒有跑）、`mock-p2.test`（mock 寫完後才寫，一次通過）、`motion.test`（減少動態的檢查，後補）、e2e。

## 與設計的差異、決定

1. **只載入使用中語言的字典**：英文一直在主程式（退路）；宿主若不想先閃英文，render 前 `await loadLocale(locale)`，或自己打包後 `registerLocale`。`BUNDLED_MESSAGES` 拿掉（公開 API 變動）。
2. **目標膠囊在窄寬是圖示**（< 1024 與 420 嵌入），不是寬度規則的「768 隱藏」：手機與嵌入也要能看到、改目標。
3. **釘選是核心**（DESIGN §12 B9），所以「只開核心」的回覆動作是開支線、釘選、複製（handoff §9-8 原本只有開支線、複製）。
4. **結論卡沒有釘選**：伺服器允許，階段 1 只在聊天訊息上（卡片的動作列要另外設計）。
5. **關聯在寫完說明（或 Esc）時才建立**，不是放開時：沒有改說明的路由（見後端缺口 1），先建立再補說明做不到。放開後點別處（blur）也會建立、不寫說明。互動規格的「改說明」沒有做。
6. **地圖只畫兩端都在這棵樹（且是看得到的節點）的關聯**；訊息端點畫在它那條線的節點上；跨對話的關聯在大綱下的清單裡，可跳轉。
7. **說明上限用伺服器的 `labelMaxRunes`（200）**，不是互動規格的 120。
8. **偏題的接受**：照 payload 的種類開（`aside` 關閉時一律查證），開好後切到新支線；「停車」＝把岔題的目的停成種子並忽略這則提示。
9. **「讓 AI 提案」的等待**：提案 job 失敗沒有事件，popover 顯示「AI 正在提出目標…」並每秒重讀建議（與目標），最多 60 秒（見後端缺口 2）。
10. **回顧**：範圍預設「這個對話」，可切「所有對話」；暫存一天、只存在這個瀏覽器（DESIGN §12 B9）；各欄「結束／暫存／繼續」的意思見上面「demo」。
11. **開太久的支線不會因為時間經過而自己更新**（同伺服器：讀取時計算）；`useOpenLoops` 在重新掛上時重讀，相關事件也會讓它重讀。
12. **mock 的簡化**（只影響測試）：`[fake:drift]` 在主線的任何一輪就提偏題（伺服器每 4 個回覆檢查一次），種類同 fake runner 是查證；目標提案在 `draftMs` 後落地。
13. **偏題提示只讀需要的資料**：只在主線、`goal` 是 suggest／auto、建議匣開、而且這棵樹有 open 的建議時才讀 `GET /suggestions`。

## 契約

- 對 HEAD（127 檔）：B9 的 22 個新樣本都列入 `EXPECTED_SAMPLES`，client 與 mock 的契約測試全綠。
- 工作目錄（階段 B 進行中，128 檔）：`route.preview` 變了、多了 `route.preview.fisheye`，client 讀不懂預覽的新欄位（魚眼），留到階段 2。

## 後端缺口與問題（給協調者 / 後端）

1. **關聯沒有改說明的路由**（`PATCH /lines/{id}/relations/{rid}` 之類）。互動規格有「改說明」；現在只能刪掉重建，所以前端在寫完說明時才建立關聯。
2. **`goal_propose`／`drift_check`／`relation_suggest` 的 job 失敗沒有事件**（同 F4 的收尾草稿缺口）。「讓 AI 提案」只能輪詢、最多等 60 秒；要不要比照 B8.1 的 `draftError` 給一個失敗通知？
3. **關聯的訊息端點沒有「#n」**：`fromTitle`／`toTitle` 是線的標題，前端只顯示線名、跳到那則訊息。要不要帶訊息的序號或摘要？
4. **偏題建議的 payload 沒有 `anchorLineId`**：偏題只看主線所以目前沒問題；若之後支線也偵測，前端需要知道那則回覆在哪條線。
5. **未完成清單的「開太久」與 `LineView.staleBranches` 都是讀取時計算**，前端沒有事件可聽；目前在重新掛上與相關事件時重讀，這樣可以嗎？
6. 問題：結論卡要不要也能釘選（伺服器已允許）？要的話卡片的動作列放哪裡？

## 協調者的回覆（階段 1）

階段 1 已 commit 為 `7c200b2`。結論卡暫不釘選；語系 API 的變動、窄寬的目標圖示，以及回報的 10 點差異都接受。關聯改說明的路由與通用的 `job.failed` 事件在 B9 階段 C 補；其他缺口照現狀。

### 給宿主的遷移說明（語系字典改成用到才載入）

- `BUNDLED_MESSAGES` 拿掉了。要讀字典用 `localeMessages(tag)`（還沒載入的語言回 `undefined`；英文一直都有）。
- 非英文的字典（目前只有 zh-TW）是獨立的 chunk。`TangentProvider` 會自己去載；**在載到之前用英文**。不想先閃英文：在第一次 render 前 `await loadLocale(locale)`（可以跟建立 client 一起等，demo 的 `main.tsx` 就是這樣）。
- 宿主若要把字典打進自己的 bundle（不多一個請求）：`import` 字典後 `registerLocale("zh-TW", messages)`；provider 會用同一份。
- `TangentProvider messages` 的覆寫不受影響（先看宿主的字，再看語言字典，再看英文）。
- 測試環境：在 setup 檔 `await loadLocale("zh-TW")` 或 `registerLocale(...)`，元件第一次 render 就是中文。

---

# 階段 2（2026-10-17）：魚眼的可視化（C1）

> 依協調者的通知做（B9 階段 B 已 commit 為 `212abc5`，128 個樣本）。只動了 `web/` 與本檔；沒有改 Go，沒有 commit。
> 後端 B9 階段 C 同時在改工作目錄的 Go，所以契約與錯誤碼的測試對 HEAD（`d87f866`）的副本跑，真 API 的 e2e 伺服器也從那份副本建置。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過 |
| vitest（逐一套件） | fonts **9**、client **645**、react **670**、demo **82** |
| `pnpm -C web build` | 通過。主 JS **173.02 kB gzip**（階段 1 結束時 172.94） |
| Playwright | 全套 **140 passed、38 skipped、0 failed**（共 178：mock 81、api 63、api-core 34；skip 都是刻意的） |
| axe | 送出前預覽的魚眼與預算（moderate+，1440）、地圖的魚眼圖層（側欄 moderate+）、375 手機的預覽抽屜（serious+） |

client 對 HEAD 的樣本與錯誤碼全綠。對**工作目錄**：樣本與 HEAD 相同；`errors.test` 有 1 個紅燈，因為階段 C 正在 `domain/errors.go` 加群組的錯誤碼（`group_not_found` 等），那是階段 3 的範圍。`errors.test` 多了 `TANGENT_DOMAIN_ERRORS_GO`（同 `TANGENT_CONTRACT_DIR`）可以指向某個 commit 的副本。

## 做了什麼

### client
- `fisheye.ts`：`PromptBudget`（`total`、`shares[{owner, tokens}]`、`history`、`used`）、`FisheyeItem`／`FisheyeReport`、`FISHEYE_LEVELS`（`full`／`summary`／`leaf_only`／`hidden`，不認得的當 `hidden`）、`fisheyeMessages`、`fisheyeLevelOf`。
  `PreviewTurnResult.budget` 一定有（舊伺服器是 0），`fisheye` 只在伺服器送了時有。
- `p2-map.ts` 的 `mapFisheyeLevels`：地圖每個節點的程度——畫面上的線與它的祖先送完整（報告不列它們），報告列出的支線照報告，其他看不到。
- 契約：`route.preview.fisheye` 進 `EXPECTED_SAMPLES`；預覽的 4 個紅燈修好。
- mock（`mock-preview.ts`，從 `mock-turns.ts` 搬出來）：每次預覽都有預算（功能的區塊各算一份，歷史最後）；`fisheye` 開時有報告並照它組 prompt（完整的進歷史、摘要的併成「較早的訊息」、其他支線的收尾進 `branch_conclusions`）。
  分數同伺服器（釘選 +100、結論卡 +6、減往前第幾個來回；支線＝收尾種類分數 − 樹上距離，≥ −3、最多 20 條、不列自己與祖先）。
  **mock 的簡化**：最近 **2** 個來回原文（伺服器 4 個），情境不長也看得到每種程度。
  mock 契約測試：`fisheye`、`prompt.trailing`、`estimatedCostUsd` 是有時才有的欄位，另外單獨比對魚眼報告的形狀。

### react
| 元件 | 內容 |
|---|---|
| 送出前預覽（`TurnPreview`） | 區塊列表下多兩段：「預算分配」（已用 / 總額、用量條、每個花用者的 token，依花用順序；最近訊息的上限）與「這一輪 AI 看得到什麼」（`fisheye` 開時）：這條線的每則訊息（#n 你／AI、摘錄）與其他支線（種類・目的、收尾），每項有**程度的字**（完整／摘要／只有一句收尾／看不到）、分數、token；釘選的那則標「釘選・一定送出」。程度一律有字，不只靠顏色 |
| 預覽區塊名稱 | `branch_conclusions` 叫「其他支線的結論」 |
| 地圖的「魚眼」圖層 | 圖層開關多「魚眼」（`fisheye` 開時才有，預設關；打開才送 `POST /preview`，與輸入框空白時的預覽同一個查詢）；每個節點的**外框（底色、邊框、圖示）用透明度**表示程度（100／75／55／30），第二行印出「AI 看到：…」，節點名稱也念出來；圖例。地圖全幅同樣有 |
| 釘選標記 | `fisheye` 開時是「已釘選・一定送出」，關時只說「已釘選」（那時釘選不影響 prompt） |
| 圖層開關 | 抽成 `map-layers.tsx`（`LayerSwitch` 吃一組圖層），階段 3 的群組加在同一列 |

### e2e（`f5.spec.ts`；真 API 的伺服器加 `fisheye`）
| 寬度 | 測試 | mock | 真 API |
|---|---|---|---|
| 1440 | 長一點的對話、釘選第一則回覆（「已釘選・一定送出」）→ 預覽：那則「完整」且「一定送出」、較早的「摘要」、預算分配；axe | ✓ | ✓ |
| 1440 | 支線不帶回並寫原因 → 地圖開「魚眼」：支線「AI 看到：只有一句收尾」、主線「完整」、圖例；axe | ✓ | ✓ |
| 1440 | 功能關閉：釘選只說「已釘選」、預覽沒有魚眼段（有預算段） | C1 | api-core |
| 375 | 預覽抽屜裡的魚眼；axe | ✓ | ✓ |

其他：`p1.spec` 的「收尾：帶回、不帶回、修改」與 `p2.spec` 的「樹平衡：維持、獨立」加 `test.slow()`。這兩個測試對真伺服器各跑十幾輪，整套 8 個 worker 一起跑時在 29–31 秒之間（關掉 `fisheye` 再跑一次也一樣，所以不是魚眼造成的），偶爾超過 30 秒的上限。

截圖：`screenshots/F5/fisheye-preview-1440`、`fisheye-map-1440`、`fisheye-preview-375`（mock 與真 API）。與原型 C1 對照：每項的程度字與 token、釘選「一定送出」那一行、地圖的程度都相符；原型把預覽做成「規則與目標／紀要／…」的分組表，這裡沿用既有的區塊列表，另外加逐項的魚眼清單（工作單要求逐項）。

## TDD 紀錄

先寫、看到紅燈：client 契約的 2 個與 mock 契約的 2 個（開工時就紅）、`fisheye.test`（模組不存在）、`mock-p2.test` 的預算與魚眼（3 紅）；react `turn-preview` 的預算與魚眼（3 紅）、`message-list` 的「一定送出」（1 紅）、`map-fisheye.test`（2 紅）、`structure-panel` 的魚眼圖層（1 紅）。
沒有紅燈紀錄：減少動態的檢查加上魚眼圖層（後補）、e2e。

## 決定

1. **地圖的透明度只用在外框**（底色、邊框、圖示），字維持原本的對比：整個節點變淡時，標題在「看不到」（30%）的對比遠低於 4.5:1，axe 會擋。程度另外印成字、念進節點名稱。
2. **魚眼圖層預設關閉**：打開才多一個 `POST /preview`；畫面上的線與它的祖先視為「完整」（報告不列，背景包整段帶上）。
3. 預算的花用者：`core`、`host`、`history`、`fisheye`（其他支線的結論）有自己的名稱，其他用功能名稱（例如 `goal` →「目標與偏題提示」）。
4. 釘選的標記只在 `fisheye` 開時說「一定送出」（B9 的問題 3：關閉時釘選不影響 AI 看到的內容）。

## 後端缺口與問題

沒有新的缺口。一個小問題：魚眼報告列的是**這條線**的訊息；從支線看時，主線上分岔點之前的訊息由背景包帶，報告不列，所以預覽與地圖把它們算「完整」（背景包的內容另外在「背景」那一列）。這樣解讀可以嗎？

# 階段 3（2026-10-17）：群組與合併（C2）

> 依協調者的通知做（B9 階段 C 為 `a1f2f9e`，144 個樣本；途中 B9.1 commit 為 `bc26d13`）。只動了 `web/` 與本檔；沒有改 Go，沒有 commit。
> B9.1 進行中時契約與錯誤碼的測試對 `a1f2f9e` 的副本跑；B9.1 commit 後改對工作目錄（Go 已與 HEAD 相同）跑，真 API 的 e2e 伺服器從 HEAD 的副本建置。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過 |
| vitest（逐一套件） | fonts **9**、client **703**、react **708**、demo **82** |
| `pnpm -C web build` | 通過。主 JS **173.68 kB gzip**（階段 2 結束時 173.02）。群組的畫面都在既有的延遲載入塊裡（地圖、結構、待處理、預覽） |
| Playwright | 全套 **156 passed、46 skipped、0 failed**（共 202：mock 89、api 71、api-core 42；skip 都是刻意的） |
| axe | 建立群組與合併的對話框（moderate+，1440）、地圖的群組圖層（側欄 moderate+）、群組建議的對話框（moderate+）、420 嵌入的合併對話框與 375 手機的建立群組（serious+） |

## 做了什麼

### client
- `group-routes.ts`：`Group`（`summaryStatus` drafting／ready／failed、`status` active／dissolved）、`Conflict`（`branch`／`other` 各有 `lineId` 與 `claim`，`choice` 是 `adoptBranch`／`adoptOther`／`keepBoth`）、`GroupWrite`、`CombineResult`（`reparented` 一定有，B9.1）與各自的 normalizer；`job.failed` 的 `JobFailed`（錯誤碼不認得的當 `failed`）。
- `api.ts`：`listGroups`、`createGroup`、`getGroup`、`renameGroup`、`dissolveGroup`、`summarizeGroup`、`combineBranches`、`updateRelation`（`PATCH` 關聯說明）。
- 事件：`group.changed`、`job.failed`；錯誤碼加 `group_not_found`、`group_not_active`、`invalid_group`、`group_limit`；`BranchView.mergedIntoLineId`、`origin: merge`；魚眼的項目種類加 `group`。
- 純邏輯：`groups.ts` 的 `selectionAction`（選取能做什麼：2–12 條**已結束且有收尾、不在別的群組**→建群組；2–12 條**進行中、同一條線底下、不是順口問**→合併；不然說明原因）、`groupSuggestionOf`、`suggestedAction`（同伺服器：兩條以上已結束→群組，否則合併）；`group-frames.ts` 的 `groupFrames`（地圖上的外框、XMind 摘要括號、摘要框的位置，重疊時往下疊、地圖跟著變高）；`mapFisheyeLevels` 收 `groups`：群組項目的程度給每個成員。
- `TANGENT_CONTRACT_DIR` 有沒有結尾的 `/` 都可以。
- mock（`mock-groups.ts`）：群組的建立／改名／解散／重寫摘要（`draftMs` 後寫好；成員收尾有 `[fake:job-error]` 時摘要失敗並發 `job.failed`）、合併（新支線從最晚的分岔點開；舊支線放棄並記 `mergedIntoLineId`；B9.1：進行中的子支線改掛到新支線，`anchorMessageId` 不變，先 `branch.changed{moved}` 再舊支線的 `line.updated`；改掛超過 8 條 → `branch_limit`，整筆不做）、支線結束後的群組建議（候選 3 條以上；最新兩條已結束的一組帶一個矛盾、最新兩條同層進行中的一組，與假 runner 相同）、接受建議、魚眼的群組項目（就緒的群組代表成員）；`proposeGoal` 在主線有 `[fake:job-error]` 時發 `job.failed`。

### react
| 元件 | 內容 |
|---|---|
| `GroupFormDialog`（建立群組／合併成一條支線） | 群組名稱或新支線的目的、成員與它們的收尾（合併時寫「會結束」）、AI 建議的**每個矛盾一組單選**（採用「A」／採用「B」／都保留；都保留只在 `notes` 開時有，寫進待確認）；沒選完不送出（「每個矛盾都要選一個」）。從建議來的走 `POST /suggestions/{id}/accept`（`action`、`title`／`purpose`、`choices`），自己選的走 `POST /groups` 或 `/branches/combine`。合併完進入新支線 |
| `SelectionActions` | 多選下面的動作：建立群組或合併成一條支線，做不到時說原因；功能關或唯讀時沒有 |
| 大綱 | 選取列放 `SelectionActions`；多選中按 **G** 執行選取允許的動作（interactions.md：multiselect → G → focused）；動作後結束多選。「已合併到「…」」寫在列上並念出 |
| `GroupList`（大綱下方「群組」） | 每個群組：名稱、共同摘要（正在寫／沒寫成（上一次的保留）／還沒有）、成員（點了前往）、改名（Enter 存、Esc 取消）、摘要失敗時「重新寫共同摘要」、解散；唯讀只看 |
| 地圖的「群組」圖層 | `group` 開時圖層列多「群組」（預設開）：成員外框（實線，§9-7 的「外框＝群組」）、右邊的 XMind 摘要括號、連到樹右邊一欄的摘要框「群組・名稱」（摘要的狀態同上；收合掉的成員寫「另有 n 條收合中」）。「多選」開關：開著時點節點（或 Enter／Space）是選取（`aria-pressed`、勾勾），地圖下方是已選幾條與動作；Esc 結束；主線不能選；唯讀沒有 |
| 待處理的群組建議 | 「建議：群組」寫出「把「A」、「B」圈成「名稱」」（或合併）與「n 個矛盾待決定」；宿主給 `onGroupSuggestion` 時按鈕是「檢視…」（打開上面的對話框），沒給時是一般的接受。不會自己彈出或搶焦點 |
| 結果列 | 被合併的支線：「已合併到「…」。」與「前往「…」」 |
| 對話裡的分岔點 | B9.1：合併出來的支線（`origin: merge`）底下、分岔的那則訊息不在這條線上的子支線，畫在這條線的第一則訊息上 |
| 關聯 | 拉完（或鍵盤選好另一端）就建立，再寫說明（`PATCH`）；Esc 不寫說明但關聯留著。地圖的關聯與大綱的關聯列表都有「改說明」 |
| 目標 | 「讓 AI 提案」不再輪詢：等 `job.failed`（「AI 沒能提出目標（執行失敗）。」）或建議進來；60 秒上限保留 |
| 送出前預覽 | 魚眼清單的群組項目寫「群組・名稱」與共同摘要；地圖的魚眼圖層裡，成員的程度跟群組項目 |
| 資料層 | `useGroups` 等 hooks、`useUpdateRelation`；`group.changed` 讓群組與預覽重載；`job.failed` 進 live store（`useJobFailure(jobId)`）；接受建議的結果有群組或合併時重載對應查詢 |

宿主用：`useGroupForm(rootLineId, onDone)`（對話框）、`useSelectionActions`、`useMapGroups`（地圖圖層）。demo：結構側欄、全幅地圖、待處理都接上；結果列接「已合併到」。

### e2e（新檔 `f5-c2.spec.ts`；真 API 的伺服器加 `group:suggest`）
| 寬度 | 測試 | mock | 真 API |
|---|---|---|---|
| 1440 | 大綱 Shift 點兩條已結束的支線 → 建立群組 → 群組列表有共同摘要；地圖：群組圖層開著、一個外框一個括號、摘要框；axe | ✓ | ✓ |
| 1440 | 兩條進行中的同層支線 → 合併（axe）→ 進入新支線；舊支線列「已合併到…」、結果列與「前往」；真 API 另外驗 B9.1：子支線改掛到新支線下一層 | ✓ | ✓ |
| 1440 | 三條支線不帶回 → 待處理的群組建議（不彈出）→ 檢視… → 沒選矛盾不送出 → 方向鍵選「都保留」→ 建立；建議「已接受」、紀要有待確認、群組列表有它；axe | ✓ | ✓ |
| 1440 | 地圖上鍵盤拉關聯：Enter 就建立、Esc 不寫說明 → 改說明 → 新說明（真 API 重載後還在） | ✓ | ✓ |
| 1440 | 主線有 `[fake:job-error]` → 讓 AI 提案 → 「AI 沒能提出目標（…）」、按鈕可以再按 | ✓ | ✓ |
| 1440 | 群組功能關：多選沒有建立群組／合併、沒有群組列表、地圖沒有群組圖層與多選 | C1 | api-core |
| 420 | 嵌入：大綱「多選」→ 合併對話框不超出 420；axe → 合併 | ✓ | ✓ |
| 375 | 手機：「多選」（≥44px）點兩列 → 建立群組；axe | ✓ | ✓ |

`f5.spec.ts` 的共用步驟（開支線、回主線、切分頁）搬到 `f5-flows.ts`。

截圖：`screenshots/F5/group-map-1440`（全幅地圖、只開群組圖層、按 0 符合大小）、`combine-dialog-1440`、`group-suggestion-1440`、`combine-420`、`group-375`（mock 與真 API）。與原型 C2 對照：大綱多選列的「已選 n 條・建立群組・合併」、建議匣的「把「…」和「…」圈成「…」」、合併對話框的「被合併的支線→會結束」都相符；差異見下。

## TDD 紀錄

先寫、看到紅燈：client 契約（16 個新樣本）、`group-routes.test`、`groups.test`、`group-frames.test`（模組不存在）、`fisheye.test` 的群組程度（1 紅）、`mock-groups.test` 的 B9.1 事件順序（1 紅）；react `groups.test`（3 個模組不存在）、`map-groups.test`（5 紅）、`outline-tree.test` 的選取動作與 G（1 紅）、`structure-panel.test` 的群組（1 紅）、`inbox.test` 的群組建議（2 紅）、`turn-preview.test` 的群組項目（1 紅）、`models.test` 的 B9.1 分岔點、`merged-into.test`、`goal.test` 的 `job.failed`、`relation-layer.test`／`relations.test` 的「先建立再寫說明」。
沒有紅燈紀錄：`mock-groups.test` 的前 11 個（mock 先寫）、e2e。

## 決定

1. **群組名稱在摘要框裡**，不在外框左上：外框只比成員多 6px，列與列只差 18px，左上的字會蓋到上一列的節點。摘要框放在樹右邊另一欄（像關聯說明的位置），用括號與一條細線連過去；框不會蓋到任何節點。
2. **外框用實線**：原型的群組外框是虛線，但 §9-7 說虛線是關聯／待確認，所以改實線、淡底。
3. 外框包住看得到的成員的範圍；成員不相鄰時，中間的非成員節點也會在框裡（XMind 的外框也是包一段）。
4. 多選後執行動作（按鈕或 G）就結束多選；對話框取消要重選。
5. 群組建議的「檢視…」由宿主決定（`onGroupSuggestion`）；沒接的宿主仍是一般的接受（有矛盾時伺服器會回 `invalid_group`，卡片顯示錯誤）。
6. 關聯「拉完就建立」：之前要寫完說明才建立；現在 Esc 只是不寫說明。
7. 魚眼裡群組項目的程度覆蓋成員自己的項目（伺服器列群組時不列成員）。
8. B9.1 的分岔點只在 `origin: merge` 的線上改畫在第一則訊息；其他線的訊息可能分頁，不能用「找不到」判斷。
9. 已知的擠：群組與關聯兩個圖層同時開、而關聯連的是同一欄的兩個節點時，關聯的弧與說明會落在群組括號旁邊（兩者都畫在節點右側）。不重疊任何節點與文字框的底，只是線多；要分開可以把關聯的弧改到左側，先不做。側欄的地圖窄，最小 50% 也看不到右邊的摘要欄，截圖用全幅地圖。

## 後端缺口與問題

沒有新的缺口。B9.1 的 `reparented` 已改成必有（`OPTIONAL_KEYS` 移除）。

# R9 修正（2026-10-17）

> 依該階段工單 的「交給實作 agent 的修正」（G1–G5）。只動了 `web/` 與本檔；沒有改 Go，沒有 commit。
> 後端同時在改 R8 的 Go，所以一開始契約與錯誤碼的測試、真 API 的 e2e 伺服器都用 HEAD（`6c78403`）的 `git archive` 副本；R8 commit（`9f14c0e`）之後最後一輪改對工作目錄跑（樣本沒變）。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過 |
| vitest（逐一套件） | fonts **9**、client **706**、react **718**、demo **82** |
| `pnpm -C web build` | 通過。主 JS **173.84 kB gzip**（階段 3 結束時 173.68） |
| Playwright | 全套 **156 passed、46 skipped、0 failed**（202；最後一輪對 R8 之後的工作目錄）。對 HEAD 副本的前兩次全套各有 1 個紅燈：`conversation.spec` 的「new conversation, stream…」（api）等不到「停止回覆」——假 runner 的回覆在按鈕畫出來之前就串完了；單獨重跑 3 次都過，第三次全套也過。與這次的修正無關（那段沒有動），是負載下的時序問題，建議那個測試用 `[fake:wait=…]` 讓回覆慢一點 |

## 做了什麼

| 項目 | 修正 |
|---|---|
| G1 目標 | `GoalCapsule` 在元件內依 `rootLineId` 加 `key`：開關、編輯中的草稿、「讓 AI 提案」的等待與錯誤都屬於一個對話，換對話就重來；舊對話的 `job.failed` 不會出現在新對話 |
| G1 同類清查 | `RelationDialog` 依（對話、起點）加 `key`；`useGroupForm` 記住是哪個對話開的表單，換對話就不顯示；`StructurePanel` 的大綱、關聯列表、群組列表、地圖依對話加 `key`（多選、收合、圖層、刪除後的復原都重來），章節依目前的線；demo 的全幅地圖與回顧（範圍、顯示暫存）也依對話加 `key` |
| G2 多選 | 大綱只有在宿主給了 `selectionActions` 時才有多選：沒有「多選」鈕，Shift＋方向鍵只移動、Shift 點擊與長按就是進入那條線。`StructurePanel` 在 `group` 關閉或唯讀時不給（與地圖一致） |
| G3 關聯刪除 | 另一端在別的對話時，不論是起點還是終點都算（`farEnd`，大綱列表與地圖共用）；那一端可能是別棵樹的支線、不知道它的根，所以刪除後把所有已載入的關聯／連結列表標成過期（只有顯示中的會重抓） |
| G4 `failedJobs` | 最多留最新 50 筆（`FAILED_JOBS_KEPT`）；`resync` 清空；刪除的線一併忘掉 |
| G5 語系 | provider 接住 `loadLocale` 的失敗（維持英文、在 console 警告）；失敗的下載不留快取，換到別的語言再換回來（或重新掛上）會再試。demo 的開頁也不再因為字典載入失敗而整頁不出來 |

## TDD 紀錄

先寫、看到紅燈：`goal.test` 的換對話（2 紅）、`relations.test` 的對話框重來與從遠端刪除（各 1 紅）、`structure-panel.test` 的換對話丟掉表單與多選（1 紅；過程中發現同層三個元件用同一個 `key`，改成各自的前綴）、`outline-tree.test` 的沒有選取動作就沒有多選（1 紅）、`live-store.test` 的上限與清除（2 紅）、`lazy-locale.test` 的下載失敗（1 紅，未處理的 rejection）。
後補（實作先完成）：`structure-panel.test` 的 `group` 關閉與唯讀沒有多選。e2e：`f5-c2.spec` 的「群組功能關」改成驗沒有多選、Shift 點擊只是進入。

## 跟上 R8（`9f14c0e`）

協調者通知的三個行為變動，便宜的都跟上了（先寫測試、看到紅燈）：
- 群組不收已升為主線的支線：`selectionAction` 多一個原因 `promoted`（「升為主線的支線不能放進群組。」）；mock 的建立與建議候選也擋。
- detach 帶走成員時群組解散並發 `group.changed`：mock 的 detach 也這樣做（畫面本來就靠 `group.changed` 重載群組）。
- 合併的錨點退回：mock 在來源的分岔點都不在父線上時改用父線最新一則完成的訊息，還沒有就 `anchor_not_found`（訊息說要先在這裡回覆）；解散後的摘要逾時只發 `job.failed`。
- 從本樹刪除連到已封存對話的關聯：介面本來就沒擋，不用改；改說明仍可能回 `archived`，照錯誤顯示。

## 決定

1. 依對話重設寫在元件庫裡（內部 `key`），宿主不用自己記得加。
2. G3 不去猜另一棵樹的根，改成讓所有關聯列表過期：這種刪除很少，顯示中的列表通常只有一兩個。
3. G4 在 `resync` 時清空：漏掉事件之後，留著的失敗可能已經過時；等待中的元件靠自己的 60 秒上限結束。

## 後續：穩定 `conversation.spec` 的串流測試

「new conversation, stream…」（api）偶爾等不到「停止回覆」：假 runner 的回覆在按鈕畫出來之前就串完了（負載下）。
`sendAndWatchStream` 在真 API 上給問題加 `[fake:wait=1s]`（runner 先等一秒才開始回答），停止鈕一定有時間出現；串流本身（每段 60ms）照舊，所以「先看到文字再完成」的檢查不變。mock 本來就串得慢，不加。三個寬度的同一個測試共用這個步驟，每個多約 1 秒。
其他 spec 找過同類的「等一個短暫狀態出現」：取消回覆用 `[fake:slow]`（已經會等 3 秒）、目標的「AI 正在提出目標…」只驗它消失、關聯的「正在從…拉關聯」是使用者自己控制的狀態，都不受影響。

驗證：全套 Playwright 連跑三次，每次都是 156 passed、46 skipped、0 failed（2.7–2.8 分鐘，與之前相同）。
