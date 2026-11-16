# F2 · 支線、結論卡、大綱與地圖

> 2026-10-15。依該階段工單。分兩階段，中間由協調者審查；本檔目前只有**階段一（支線流程）**。
> 只動了 `web/` 與 `docs/devlog/`（本檔與 `screenshots/F2/`），沒有改 Go，沒有 commit。

## 階段一：支線流程

### 驗收（在 repo 根目錄執行）

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過（fonts、client、react、demo、e2e） |
| vitest（逐一套件） | fonts 9、client **385**（F1 後 354）、react **385**（314）、demo **18**（16），共 797 |
| `pnpm -C web build` | 通過。主 JS 175.5 kB gzip（F1 156）；支線對話框另成 `branch-flows` chunk 11.6 kB gzip（第一次開對話框才載入） |
| Playwright | **38 passed**：mock 26（F1 的 18 + 支線流程 6 + 支線畫面 2）、真 API 12（F1 的 6 + 支線流程 6）。`branches` 另以 `--repeat-each=4` 連跑 56/56 |
| axe | 每條支線流程：開支線、審閱、不帶回、升為主線、搬移的對話框 moderate+；支線頁、主線結論卡整頁 serious+。元件總覽（三套主題）新增「支線元件」區與分岔點預覽浮層，moderate+ |

e2e：`branches.spec.ts` 在 mock 與真 API（fake runner）都跑；`screens-branches.spec.ts` 只在 mock（情境一資料）跑，負責截圖與 axe。
截圖：`UPDATE_SCREENSHOTS=1 pnpm -C web/e2e e2e branches screens-branches`，再
`node web/e2e/scripts/compare-shots.mjs <原型 URL> F2`（腳本新增 F2 的點擊步驟：分岔點膠囊 → 支線、預覽分岔點、結束並帶回、升為主線）。

### 做了什麼

#### 1. `@tangent/client`（純邏輯，先寫測試）
- `branch-view.ts`：`chatNumbers`（「#n」）、`forkContext`（分岔點與前後各一則）、`messagesSince`（草稿後主線多了幾則）、`branchLoad`（同一條線進行中的支線數、整棵數）、
  `promotePlan`（升為主線的前後對照：分岔點 #n、被收起的尾段、會擋住的進行中支線〔含其下層〕、會往上提一層的子支線）、`asideDaysLeft`、`cardDelivery`、
  `classifyOpenBranchError`（depth_soft_limit / branch_limit / tree_limit / anchor_not_found / too_long(purpose) / model_not_allowed / feature_disabled）。
- `branch-pack-estimate.ts`：開支線前的背景估算（目的、選取文字、分岔點前最後 8 則、分岔點之後），CJK 一字約 1 token、其他約 4 字元 1 token；標為粗估。
- `branch-input.ts`：`withSuggestion`：只有目的與種類都沒改時才帶 `suggestionMessageId`（同 宿主）。
- **mock**：不再有未模擬的路由。
  - 新增 `mock-branch-moves.ts`：搬移（驗證順序同 `domain/branch_move.go`，留下 `branch_marker`、改掛從被搬訊息岔出的支線並調整深度）與升為主線（同 `store/branch_promote.go`：主線 id 不變、尾段變成已結束的「Previous main line」支線、子支線上提、尾段有進行中支線時 `open_branches_on_old_tail{lineIds}`）。
  - 開支線的拒絕依 Engine 順序：aside 功能關閉、上層已結束、分岔點不在、深度（軟 3 / 硬 6）、同一條線進行中 8 條、整棵 200 條；`suggestionMessageId` → origin `suggestion`；`includeLater` 寫進 pack。
  - 起草需要支線有訊息（`no_messages`）、草稿記下 `parentTipMessageId`；merge 檢查 tip（`parent_moved{movedMessages}`，`confirmParentMoved` 可略過）。
  - 一輪的 pending 回覆帶 `deliversCards`，成功完成後把卡片標為 `delivered`；順口問答完自動結束（discarded）並發 `branch.changed`。
  - mock 契約測試改為連 move 與 promote 一起比對樣本形狀（`NOT_SIMULATED` 清空）。

#### 2. 資料層（`@tangent/react/src/data/`）
- `branch-queries.ts`：`useBranchDetail(lineId, {poll})`（起草中以 4 秒輪詢做備援，主要靠 `branch.changed`）、`useNotes`。
- `branch-mutations.ts`：`useCreateBranch`、`useMoveToBranch`、`useStartDraft`、`useMergeBranch`（結論卡立刻寫進父線的訊息快取）、`useDiscardBranch`、`usePromoteBranch`。
  這些是伺服器驗證的狀態轉換（上限、tip、尾段），所以不做樂觀更新：結果寫入快取並 invalidate 受影響的 query。`note-mutations.ts`：`useCreateNote`。
- `event-sync`：
  - 回覆以 `done`（非取消）完成時，把它 `deliversCards` 裡的卡片標成 delivered（伺服器不為卡片另發事件，見契約缺口 5）。
  - `branch.changed` 的 `moved` / `promoted` 另外 invalidate 根線、該支線、父線的訊息。

#### 3. 元件（`@tangent/react/src/branch/`，只用 `--tg-*`）
| 元件 | 內容 |
|---|---|
| `KindRadio` | radiogroup、單一 tab 停駐點、方向鍵／Home／End 移動即選取；只列給它的種類（aside 功能關閉時不出現） |
| `OpenBranchDialog` | A3：選取文字引文、目的（必填，計數，上限隨 `too_long.max` 調整）、種類、provider / model（宿主給的選項，否則只顯示「同主線」）、「也帶上分岔點之後的發展」（之後有訊息才出現）、背景估算；錯誤：深度再確認（「仍要開」→ `confirmDeeper`）、同一條線滿 8 條（送出前就提示並擋下）、整棵上限、分岔點已不在（「改掛在最後一則」）、模型不允許、功能關閉；AI 建議時標「AI 建議」 |
| `SelectionToolbar` + `readMessageSelection` | 一則訊息內的選取才出現；桌機在選取上方、觸控在下方；按下不清掉選取；⌘B 也讀同一個選取 |
| `ForkMarker`（改） | 有 `onSelect` 時是 disclosure，展開內嵌清單（種類圖示依狀態上色、目的、狀態、一句結論、未讀），點了進入支線 |
| `Breadcrumb` | 主線 › 支線 › 子支線；目前層 `aria-current="page"`；寬度 320 / 170（嵌入）/ 120（手機）；窄框三層以上中間折成「…」（回上一層） |
| `BranchBar` | A4：回主線／回上一層、種類、狀態、「你在支線裡」、目的、「從主線 #n 岔出」（回父線並高亮）、預覽分岔點、選取文字、背景（展開看引用則數、摘要、濃縮、之後的發展、完整背景與 token）、起草中／草稿待審、順口問「n 天後清除」與「想留下來：記進紀要」；進行中才有「結束並帶回」「不帶回」「升為主線」（只限主線上的直屬支線；順口問沒有帶回與升為主線） |
| `ForkPeek` | 分岔點與前後各一則（分岔點用 `--tg-highlight`），「到那則訊息 →」 |
| `BranchResultBar` | 取代結束支線的輸入框：已帶回（看結論卡）、未帶回、已升為主線、原本的主線、順口問已回答與清除天數、封存；「唯讀」 |
| `BranchCard` | 主線裡的結論卡：摺疊時目的、結論、需要你決定（主線那一邊可點回該訊息）；展開所有欄位；「下一輪才會告訴 AI」／「已告訴 AI」；依據連到支線的那則訊息；分岔點 #n、看支線 |
| `BranchCardReview` | A5：先重新讀 branch，草稿已好就直接審、起草中就接著等、否則開始起草；`card_draft` 關閉直接手寫。起草中可「不等了，自己寫」或取消（關閉）。所有欄位可改：依據（選訊息、說明、看原文，原文中選取的文字可加為原文片段，逐字比對）、還沒解決的、需要你決定、原文片段；紀要提案（`notes` 開啟時；新增或取代，勾選）；「草稿產生後主線多了 n 則」與送出時 `parent_moved` 都提供「重新起草／照樣帶回」；`parent_busy`、`invalid_parent_tip`（重新讀 tip）、`invalid_card`（逐欄標示）、413 等錯誤；主按鈕「全部接受並帶回」套用所有提案、次按鈕「依勾選帶回」；結論或問題空白不送出 |
| `DiscardBranchDialog`、`PromoteBranchDialog`、`MoveBranchDialog`、`AsideNoteDialog` | 不帶回；升為主線（前後對照圖、四點說明、會擋住的支線可直接點過去、伺服器回 `open_branches_on_old_tail` 時列出、焦點先在取消）；搬成支線（預覽被搬的訊息、不能搬的原因先擋、目的與種類〔不含順口問〕、代價說明、深度再確認）；順口問的答案記進紀要（預設「已確認的事實」，來源記為該順口問） |

其他：`MessageList` 每列加 `data-message-id`；使用者訊息有「從這則起搬成支線」；搬移標記有「看支線」；新增快捷鍵命令 `branch.bringBack`（⌘Enter，在支線裡）；i18n 拆成 `en.branch.ts` / `zh-TW.branch.ts`。

#### 4. demo
- `shell.tsx`：導覽狀態（目前的線 + 要捲到並高亮的訊息）、標頭改成 `Breadcrumb`、`BranchFlows`（lazy）集中所有支線對話框。
- `conversation-view.tsx`：主線與支線同一個畫面；支線時上方 `BranchHeader`，結束後換 `BranchResultBar`；選取工具列；⌘B（有選取就從選取開，否則最後一則）、⌘[、Esc（回上一層，焦點在輸入框時不觸發）、⌘Enter。
- 帶回後切回父線並高亮結論卡；搬移後留在原線並高亮搬移標記；升為主線後到主線；開支線後進入新支線。
- mock 模式另給一個「claude-haiku-4-5（較便宜）」的 model 選項示範；HTTP 模式沒有（見契約缺口 1）。
- 元件總覽新增「支線元件」區（axe）。

### E2E（`web/e2e/tests/branches.spec.ts`）

| 寬度 | 測試 | mock | 真 API |
|---|---|---|---|
| 1440 | 新對話 → 一輪 → 訊息動作開支線（axe）→ 支線一輪 → 結束並帶回 → 草稿（AI 草稿・待你確認，axe）→ 全部接受並帶回 → 主線結論卡「下一輪才會告訴 AI」→ 下一輪後「已告訴 AI」 | ✓ | ✓ |
| 1440 | 兩輪後從第二則使用者訊息「從這則起搬成支線」→ 預覽 → 目的 → 主線出現標記、訊息消失 → 「看支線」進入 | ✓ | ✓ |
| 420 嵌入（宿主主題） | 同主流程（mock 用空的「週報」對話，真 API 先用 API 建線） | ✓ | ✓ |
| 420 嵌入 | 開支線 → 不帶回 → 結果列「已結束，未帶回。」、沒有輸入框 → 回主線 | ✓ | ✓ |
| 375 手機（觸控） | 同主流程（從抽屜開新對話） | ✓ | ✓ |
| 375 手機 | 兩輪後從第一則回覆開「另一條路」→ 一輪 → 升為主線（前後對照「原本的主線 #3」）→ 主線換成支線內容、分岔點清單有「原本的主線」 | ✓ | ✓ |

真 API 也驗證了：卡片在下一輪完成後變成 delivered（`message.updated` 的 `deliversCards` 有保留）。

### 截圖對照（`docs/devlog/screenshots/F2/`）

`compare-*.png`（左原型、右 demo）：1440 開支線、支線頁、分岔點預覽、審閱、升為主線；420 與 375 支線頁。另有 `demo-1440-a5-card.png`，以及 e2e 的 `branch-*`、`review-*`、`card-*`（mock 與真 API 各一）。

相符：支線條的 `--tg-primary-soft` 底、回主線鈕、種類與狀態、目的、分岔點連結與預覽分岔點、選取文字、背景 token；分岔點膠囊與內嵌清單；預覽浮層的三則與高亮；審閱對話框的 AI 草稿標記、問題 / 結論（襯線）/ 依據 / 影響 / 還沒解決的 / 需要你決定；升為主線的前後對照與四點；主線結論卡的樣式。

差異：
1. 支線頁沒有「n 則未讀」分隔線（原型有）。
2. 「獨立成新對話」（B2）、樹平衡提示（B4）、順口問「停車」（P1）、記憶提示（D1）沒有做。
3. 標頭的 token 膠囊顯示**這條支線自己的**累計（新支線是 0），原型顯示 6.1k。
4. 審閱的「依勾選帶回」只在有紀要提案時出現（沒有提案時與主按鈕相同）。
5. 依據列用下拉選訊息（`#n・開頭文字`）加說明欄，原型是「#n ↗」按鈕；原文在對話框內展開，也用來加原文片段。
6. 問題也標「（必填）」：伺服器要求問題（`domain/branch_card.go`），原型只標結論。
7. 狀態文字用前景色、只有圓點帶狀態色：`--tg-branch-*` 在支線條底色上不到 4.5:1（axe 抓到）。分岔點預覽高亮那則的標籤同理改用前景色。
8. 「結束並帶回」的快捷鍵放在 `title`（按鈕裡的 Kbd 在主色底上對比不足）。
9. 原型「這個分岔點已有 n 條」改為「這條線已有 n 條」：伺服器的上限是每條父線（`MaxOpenPerParent`），不是每個分岔點。
10. 標頭的 `h1`「主線」換成路徑；F0 的 smoke 測試改為檢查路徑的目前層。

### 與設計的差異、決定

- **不帶回的原因**：沒有欄位。`POST /branch/discard` 沒有 body，「死路收尾」屬於 leaf 功能（B 階段）；先不顯示會被丟掉的輸入。
- **紀要提案**：草稿不提供提案，所以提案列由使用者新增／取代（同 宿主），預設勾選、區塊「已決定」；「全部接受」套用全部，「依勾選」只套用勾選的。
- **背景預覽**：沒有不寫入的 pack 預覽路由，對話框用 client 端粗估並註明；開出支線後，支線條顯示伺服器的實際 token。
- **mutation 不樂觀**：開支線、帶回、搬移、升為主線都需要伺服器判斷（上限、tip、尾段），失敗時要顯示原因；成功時把結果寫入快取並 invalidate。
- **搬移後**留在原線並高亮標記（可點「看支線」）；開支線後直接進入新支線。
- **起草開始前**（讀取 branch 期間）只顯示骨架，不說「AI 正在起草」，因為 `card_draft` 關閉或草稿已好時不會起草。
- **支線對話框 lazy 載入**（demo）：Base UI 的 Select / Checkbox / Field 只有對話框用，主 bundle 因此從 205 kB 降到 175.5 kB gzip。
- 新增命令 `branch.bringBack`（⌘Enter，shortcuts.md 標為「規格」），宿主可改鍵或停用。

### TDD 說明

client 的 `branch-view`、`withSuggestion`、mock 的支線流程（10 個測試）、event-sync 的卡片送達與 moved / promoted、資料 hooks、`KindRadio`、`ForkMarker` 清單、`Breadcrumb`、`BranchBar`、`BranchResultBar`、`SelectionToolbar`、`MessageList` 的新動作、`OpenBranchDialog`、四個結束對話框、`BranchCardReview` 都是先寫測試、確認失敗再實作。
`branch-pack-estimate` 與 `BranchCard` 是測試與實作接連寫完才第一次執行（沒有記錄到失敗的那一次）。demo 的 `pathItems` 測試是補寫的。
過程中修正的測試錯誤：選取工具列在動作後應該消失；審閱測試要掛事件串流（草稿完成靠 `branch.changed`）；「不等了」的測試改用很慢的草稿以免競態；e2e 先等空白對話出現再數回覆。

### 契約缺口（給後端 / 協調者）

1. **可選的 provider / model**：`/capabilities` 沒有列出伺服器允許的組合（`TANGENT_ALLOWED_MODELS`）。UI 只能顯示「同主線」或由宿主傳 `modelOptions`。建議 `/capabilities` 加 `models: [{provider, model, label?}]`。
2. **背景預覽**：沒有不寫入的 pack 預覽（例如 `POST /lines/{id}/branches/preview` 回 pack 與 `tokenEstimate`），A3 的「背景會帶哪些內容」只能粗估。
3. **紀要提案**：結論卡草稿（`BranchDraft`）沒有 `noteChanges` 提案，設計的「AI 提出的紀要修改」無從顯示。
4. **不帶回的原因**：`POST /branch/discard` 不收 body；設計的原因（→ 死路收尾）要等 leaf 或另加欄位。
5. **卡片送達沒有事件**：`CompleteTurn` 標記 `delivered` 後只發回覆的 `message.updated`，卡片本身不發。前端依回覆的 `meta.deliversCards` 自己標記（真 API 已驗證可行）；若希望其他來源也能更新，請考慮對卡片發 `message.updated`。
6. `POST /branch/draft` 的回應沒有 provider / model（起草面板無法立刻顯示用哪個模型），要等讀到 detail。

### 留給協調者的問題

1. 契約缺口 1–4 要在 B5 補，還是前端先維持現在的退路？
2. 搬移後應該留在原線（現在）還是直接進入新支線？
3. 結論卡的「問題」伺服器必填，原型只標結論；要不要伺服器放寬，或維持 UI 兩者都必填？
4. 「依勾選帶回」在沒有提案時隱藏，是否接受？

### R1 fixes（2026-10-15，4a67d91 之後，未 commit）

外部審查 R1（9a55735）留下的三項前端問題。每一項都有回歸測試，見 `react/src/conversation/stream-text.test.ts`。

1. **MEDIUM：串流文字的計算量**
   - `StreamState` 新增 `textStarts`：每個 delta 的文字在 `text` 裡的起點。
   - `base` 之後的文字改由 `streamTextAfter` 取得：對已排序的 delta 做二分搜尋，再切一次字串。不再每次 render 都 filter / map / join 全部 delta。
   - `mergeDeltas` 依序到達的 delta 改成每批只複製一次陣列，原本是每個 delta 複製一次。舊寫法一次合併 2 萬個 delta 約要 1.3 秒。
   - 效能斷言：2 萬個 delta 時，`pendingText` 讀取 delta 的次數少於 40 次（以 Proxy 計數，不依賴時間）。另測慢路徑（晚到 / 重排）的 `textStarts`。
2. **LOW：沒有 `streamSeq` 時內容重複**
   - pending 訊息有 `content` 但沒有 `meta.streamSeq` 時（其他宿主），若串流文字以 `content` 開頭，就只接上多出的部分。
   - 若 `content` 已經涵蓋整段串流，就不再接上。
   - 兩者都不成立時照舊接在後面。
3. **HIGH（hasHole）的驗證：確認是誤判，沒有改程式**
   - 依據 `delta.go`：delta seq 來自整個行程共用的計數器（起點是啟動時間的微秒數），所以同一條線的 seq 本來就不連續。`since()` 只在下列情況回 `truncated`：
     - 沒有 buffer 且 `afterSeq > 0`；
     - 游標早於目前 buffer 的起點（較早的 buffer 被清掉）；
     - 游標之後有 delta 被丟掉（`afterSeq < lostUpTo`）。
   - 因此「`firstSeq > baseSeq + 1` 就算有洞」是錯的。前端照舊只看 `/stream` 的 `truncated`。
   - 新測試：`truncated=false` 的尾段即使從 base 之後很遠的 seq 開始（1000 → 1007）也不顯示「…」；`truncated=true` 時顯示。
   - 已知的極小邊界：新 base 的 `streamSeq` 剛好等於最後一個被丟掉的 delta 時，仍會顯示「…」，直到下一個 base 蓋過串流的開頭。原因是伺服器沒有回報 `lostUpTo`，前端無法分辨。這不是 R1 指的問題，記錄備查。

閘門：
- typecheck 通過。
- vitest：fonts 9、client 385、react **391**（+6）、demo 18。
- build 通過，主 JS 175.7 kB gzip。
- Playwright 38/38（mock 26、真 API 12，含 axe）。

### R2 fixes（2026-10-16，948dfc5 之後，未 commit）

每一項都先補回歸測試。

1. **HIGH：結論卡子欄位錯誤沒有顯示**
   - `card-review/card-errors.ts`：`rowError(errors, list, i)` 依 `needsDecision[i].branchClaim / mainLineClaim`、`evidence[i].messageId`、`excerpts[i].text ?? excerpts[i]` 取出錯誤。`strayErrors` 收集對不上任何欄位的 key，顯示在卡片頂端，不會被吞掉。
   - DecisionsList、EvidenceList、ExcerptsList 都接上 `errors`，並設定 `aria-invalid` / `aria-describedby`。
   - 本機 `validateCard` 和伺服器 `invalid_card` 的錯誤走同一條路。
   - 送出失敗後先 focus 第一個 `aria-invalid` 欄位；若沒有，就捲到第一個 `[data-card-error]`。
   - 測試 `card-errors.test.tsx` 逐一走過所有欄位路徑（含陣列 index 與舊式字串摘錄），確認每個 key 都有看得見的訊息。
2. **MEDIUM：mock 檢查順序**
   - 改為：硬深度 → 每個 parent 的開啟數 → 每棵樹 → 軟深度，與 Go 端一致。
   - 測試：parent 已有 8 條、深度為 4 時回 `branch_limit`。
3. **MEDIUM：摘錄清理**
   - 新增 `client/src/card-text.ts`，對應 `domain/sanitize.go` 的 `CleanCardText`：協定標記、``` 改為 '''、行分隔字元改為 `\n`、移除 bidi 控制字元、其他控制字元改成空白、trim。
   - 清理後內容會改變時，`checkExcerptSelection` 拒絕並回 `unclean`，介面顯示原因。
4. **MEDIUM：事件與 `lineView`**
   - `branch.changed` 會 invalidate 該支線和它 parent 的 `lineView`；moved / promoted 時連 root、line、parent 一起 invalidate。
   - 新增雙分頁測試（兩個 QueryClient 共用一個 mock）。
5. **LOW**：只有 chat 的 user / assistant 訊息帶 `data-forkable`，其他訊息上 `resolveMessageSelection` 回 null。
6. **LOW**：選取工具列在捲動（capture、passive）和視窗縮放時會跟著移動。有測試。

### 階段二：結構面板（A8、A10、A11）

#### 做了什麼

- **client（純邏輯，先寫測試）**
  - `outline-tree.ts`：攤平成樹列，預設隱藏順口問及其子樹；處理焦點移動（next / prev / first / last / parent / firstChild）、typeahead、範圍選取（不含主線與順口問）。
  - `branch-export.ts`：Markdown、Mermaid mindmap（id 只留 `\w`，文字跳脫 `#35; #quot; #91; #93;`）、OPML 2.0（`_status`、`_conclusion`、`_line`）。
  - `branch-map-layout.ts`：`BRANCH_MAP_METRICS`，188×60 的節點，深度間距 236，列間距 78。
  - `testing/mock-chapters.ts`：依里程碑切章。
- **react `structure/`**
  - `OutlineTree`：A8 的完整鍵盤表。
    - ↑↓、Home / End；→ 展開，或移到第一個子項；← 收合，或移到 parent。
    - Enter / Space 進入；`*` 展開同層；F2 改名；⌘A；Esc 先清選取，再回 composer。
    - 500 ms 內連打的 typeahead；Shift+↑↓ 多選。
    - 長按進入多選；「顯示順口問」開關。
    - ARIA：roving tabindex、level / setsize / posinset、`aria-current="location"`。
  - `BranchMap`：
    - 縮放 50–160 %，用按鈕或 + − 0（0 = 適合）；拖曳空白處平移；全幅。
    - 目前路徑的節點加粗、邊線用 `stroke-tg-primary`；目前節點不在畫面內時捲過去。
  - `ChapterList`：章節清單，可跳到章節；新增 / 刪除里程碑。
  - `ExportBar`：三種匯出。
  - `StructurePanel`：「檢視方式」radiogroup，可用方向鍵切換；`allowMap`；`chapters` 關閉時不出現章節。
  - `MessageList`：兩章以上時，在每章第一則前插入 `ChapterDivider`（h2）；唯讀時沒有刪除。
  - `TurnPreview` 新增 `mode="panel"`：非 modal 的 section，Esc 關閉。手機與 420 仍是全螢幕 dialog。
  - `SideTabs`：core 模式只顯示「結構」標題；紀要是 placeholder。
- **demo**
  - `frame/structure-host.tsx`；⌘⇧M 切換大綱 / 地圖。
  - 420 與手機不提供地圖。
  - 地圖全幅時覆蓋在對話欄上。
  - 桌面（app 且 ≥ tablet）的預覽固定在對話欄旁。

#### E2E（`web/e2e/tests/structure.spec.ts`，mock + 真 API）

真 API 用 `page.request` 建一棵三層的樹。

| 測試 | 驗證 |
|---|---|
| 1440 outline keyboard | End / Home、typeahead、← 收合、→→ 到子項（level 3）、← 回 parent、Enter 進入且焦點留在大綱、Shift+↓ 多選（順口問不會被選）、Esc 兩次、axe |
| 1440 map | ⌘⇧M、主線 `aria-current`、按鈕和 + − 0 縮放、全幅開關（Esc 關閉）、點節點進入支線、axe |
| 1440 chapters | 加里程碑 → 清單和分隔線都出現 → 跳到該章，分隔線在畫面內、axe |
| 1440 export | 三個下載檔的檔名與內容（標題、支線、`mindmap`、`<opml version="2.0">`） |
| 420 embed | 大綱覆蓋在對話上、沒有地圖、點一列進入支線、axe |

另外，`conversation.spec` 和 `screens.spec` 的預覽改成接受 dialog 或 region；`screens-branches.spec` 加了階段二的截圖。

#### 截圖對照（`compare-1440-a8-outline / a8-map / a10-chapters / a11-preview.png`）

- **大綱**：
  - 結構與原型一致。
  - 主線列的「你在這裡」放在第二行，原型放在同一行。
  - 主線則數是 mock 已載入的 8 則，原型寫死 33。
- **地圖**：
  - 節點、路徑與摺疊和原型一致。
  - 原型的圖層篩選（群組 / 鬧聊 / 魚眼）、群組標籤、死路的虛線邊都沒做，留給 F5，因為群組要等 `G` 動作。
  - 縮放列放在畫布下方，原型浮在畫布內左下。
- **章節**：
  - 里程碑名稱欄一直顯示，原型只有按鈕。
  - 訊息編號與時間來自 mock 資料，所以範圍不同。
- **預覽**：
  - 原型是蓋在對話欄右側的浮層；demo 是固定的一欄，對話欄跟著變窄。
  - mock 的 pack 只有 4 段（規則 / 紀要 / 最近訊息 / 你的訊息），原型有 7 段。

#### 跑閘門時順手修的兩個問題（有回歸測試）

1. **線還沒載入就顯示 composer**：`conversation-view` 原本在 `line.data` 尚未載入時把 `ended` 當成 false，已帶回的支線會短暫出現 composer。從大綱按 Esc 時，焦點可能先落到它上面，接著它被移除，焦點掉回 body（outline e2e 約一半次數失敗）。現在線載入前不顯示 composer；唯讀的線上 Esc 讓焦點留在大綱。回歸測試是 structure e2e，mock 跑 `--repeat-each=6` 共 30/30。
2. **預覽固定成一欄時的 debounce**：原本打開預覽時拿到的是 400 ms 前的草稿，之後更新會讓預覽的展開狀態重置（conversation e2e 偶發失敗）。現在只在預覽開著時 debounce；打開時一律用當下的草稿（`useDebounced` 的 ms 為 0 時直接跟隨）。

#### 與設計的差異、決定

- 地圖縮放低於 75 % 時不提供摺疊鈕，只顯示「+n」：鈕會貼到下一欄，不符合 24 px target size。摺疊鈕放在節點外側，並以 `1/zoom` 反向縮放。
- 地圖會畫出順口問；大綱預設隱藏順口問。
- `G`（群組）動作留給 F5。
- mock 的章節是簡化版：只依里程碑切章，沒有自動話題切換。
- F2 改名只透過 `onRename` prop 提供，demo 沒有接上（見契約缺口）。
- 主 JS gzip 從 175.7 kB 增加到 193.7 kB（結構面板）。若要壓回來，地圖可以 lazy load。

#### TDD 說明

client 的 `outline-tree`、`branch-export`、`branch-map-layout`、`mock-chapters` 都先寫測試。react 的 `chapter-hooks`、`OutlineTree`、`BranchMap`、`StructurePanel` 有部分是先寫實作再補測試，沒有留下紅燈紀錄。上面兩個閘門修正以 e2e 當回歸測試，因為 demo 的 vitest 是 node 環境，沒有 jsdom。

#### 契約缺口

1. **沒有改支線 purpose 的路由**：沒有 `PATCH /lines/{id}/branch` 之類可以改 purpose 的端點，所以大綱的 F2 改名在 demo 裡沒有作用。
2. 章節沒有「話題切換」的自動來源，只能依里程碑切章。

#### 留給協調者的問題

1. 地圖的圖層篩選與群組，要在 F5 一起做嗎？
2. 預覽要維持固定一欄（現在），還是改成原型的浮層？
3. 地圖要不要 lazy load，把主 JS 壓回 180 kB 以下？

閘門（2026-10-16）：
- typecheck 通過。
- vitest：fonts 9、client **403**、react **450**、demo 18。
- build 通過，主 JS 193.7 kB gzip。
- Playwright 49/49（mock 32、真 API 17，含 axe），全套連跑兩次都通過；structure 在 mock 上 `--repeat-each=6`、在真 API 上 `--repeat-each=3` 都通過。

### R3 fixes（2026-10-16，ede5f4d 之後，未 commit）

外部審查 R3 的六項都修了，每一項都有回歸測試。HIGH 1 與 LOW 6 的 e2e 先在舊程式上確認會失敗。

1. **HIGH：固定在旁的預覽把上一條線的草稿送給新的線**
   - 新增 `frame/hooks.ts` 的 `useKeyedDebounced(key, value, ms)`：settled 值和它所屬的 key（line id）綁在一起。key 一換，就立刻改用新線當下的草稿（`settledFor`）。`useDebounced` 改成它的無 key 版本。
   - 固定在旁的 `TurnPreview` 另外以 `preview-${selected}` 作為 key，換線時展開狀態也重設。
   - 這裡不能直接用 `selected` 當 key：它和 `ConversationView` 是兄弟元素，同一個 key 會讓舊的對話不卸載，畫面同時出現兩個 composer。
   - 測試：`keyed-debounce.test.ts`（node）；`conversation.spec`「the docked preview never sends one line's draft to another line」（只跑真 API，用 `page.on("request")` 檢查每一個 `/lines/{id}/preview` 的 body）。mock 的預覽在頁面內處理，看不到請求，所以 mock 跳過。
2. **HIGH：載入中的值落到 composer**
   - 新增 `frame/composer-slot.ts`，對話下方顯示什麼由 `composerSlot` 決定：
     - 權限（`/capabilities`）或線還沒載入 → 什麼都不顯示；
     - 支線已結束 → 結果列；branchView 還在載入時什麼都不顯示，絕不顯示 composer；
     - 已封存 → 封存列；
     - 其他 → composer。
   - 照協調者要求 grep 其他載入中的落點，找到並一併修正：
     - 選取工具列、MessageList 的開支線按鈕、⌘B（`useBranchCommands`）原本只看 `readOnly || ended`，載入中仍可操作。現在都改看 `writable`。
     - `useReadOnly()` 在 capabilities 載入前回 false，viewer 會短暫看到 composer。這次在 demo 的 slot 加上 `permissionsLoaded` 處理，沒有改套件的 `useReadOnly`；改它會讓「唯讀」banner 在每次載入時閃一下。
   - 測試：`composer-slot.test.ts` 逐一走過所有載入中的組合。
3. **MEDIUM：大綱的 tab stop 沒有跟著目前的線**：焦點不在樹裡時，`currentKey` 一變（而且該列有顯示），tab stop 就移到「你在這裡」；焦點在樹裡時不動。測試在 `outline-tree.test.tsx`。
4. **MEDIUM：多選時有子項的列沒有勾選框**：收合鈕和勾選框分成兩個 slot。多選時 grid 多一欄，說明列跟著右移一欄。測試在 `outline-tree.test.tsx`。
5. **MEDIUM：Mermaid id**：加上 `b_` 前綴（數字開頭的 UUID 不再破壞語法，也不會撞到 `root`）。清理後相同的 id 會補 `_2`、`_3` 保持唯一。測試在 `branch-export.test.ts`，ExportBar 的測試也一併更新。
6. **LOW：離開全幅地圖後焦點掉到 body**
   - 打開全幅時，側欄的全幅鈕會換成說明文字。所以打開時焦點移到全幅地圖的畫布；關閉時（Esc、收回鈕或點節點）焦點回到側欄重新出現的全幅鈕（`data-tg-map-full`）。
   - 測試：`structure.spec` 的 map 測試涵蓋 Esc 與收回鈕兩條路。

閘門：
- typecheck 通過。
- vitest：fonts 9、client **404**、react **452**、demo **26**。
- build 通過，主 JS 194.2 kB gzip。
- Playwright 全套連跑兩次，都是 50 passed、1 skipped（mock 跳過上面那個只跑真 API 的測試），含 axe。
