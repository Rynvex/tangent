# F3 · 紀要、設定、功能開關呈現、嵌入示範

> 2026-10-16。依該階段工單。只動了 `web/` 與 `docs/devlog/`（本檔與 `screenshots/F3/`），沒有改 Go，沒有 commit。
> 後端 B5 同時進行；結束前重新讀了 `httpapi/testdata/contract/`（71 檔）與 `B4-contract-diff.md` 的「B5 增補」，能接的都接上了（見「B5 契約」）。

## 驗收（在 repo 根目錄執行）

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過（fonts、client、react、demo、e2e） |
| vitest（逐一套件執行並確認） | fonts **9**、client **440**（F2 後 404）、react **498**（452）、demo **43**（26），共 990 |
| `pnpm -C web build` | 通過。主 JS **177.5 kB gzip**（F3 開工時 194.2 kB） |
| Playwright | 全套 **81 passed、7 skipped**（連跑兩次；mock 50＋1 skip、api 30＋3 skip、api-core 1＋3 skip）。skip 都是刻意的：只跑真 API 的預覽測試、`features.spec` 依伺服器的功能組合只跑對應的那一組 |
| axe | 紀要分頁（moderate+）、設定對話框（moderate+，三種寬度）、三種功能組合整頁（serious+）、嵌入頁整頁與大綱、未讀分隔線頁、手機紀要抽屜 |

真 API 的 e2e 用工作目錄的 Go 程式建置參考伺服器；這次每次建置都成功，沒有等 B5。

## 做了什麼

### 1. `@tangent/client`
- `notes-page.ts`：`noteSectionGroups`（四區、先有效後完成、被取代另列）、`isNewNote`（依 `createdAt` 與上次檢視時間，比較時間點不比字串，第一次造訪不標）、
  `notesLeftOut`（從 `POST /preview` 的 `notes` 區塊找出沒帶上的有效紀要：伺服器每條紀要是一行 `- text`，存的文字已是同一形式）、`noteFromText`（120 字）、`noteSource`。
- `unread.ts`：`firstUnreadId`：伺服器每完成一輪 +1 未讀，所以第一則未讀是最後 n 則完成回覆中最舊的那則（依 seq）。
- `Note.sourceLabel?`（DESIGN §12 的來源快照；伺服器有送才有這個鍵，契約樣本目前沒有）。
- `NoteProposal.ai?` 與 `proposalsFromDraft`（B5 草稿的紀要提案）。
- B5：`capabilities.models` 與 `modelChoices`、功能 `search`、`renameBranch`、`previewBranch`、`search`、`JobStarted.provider/model`、`BranchDraft.noteChanges`、`branch.changed{renamed}`（`b5-routes.ts`）。
- mock：
  - 預覽的紀要區塊照 `domain.BuildNotesBlock`（標題、新的在前、超過預算依序丟待確認→待辦→事實、結尾的省略行），預算 `scenario.notesTokenBudget`（預設 2000）。
  - 紀要路由在 `notes` 關閉時回 404 `feature_disabled`；來源訊息決定來源線，不在這棵樹回 `note_source_not_found`（同 `store.resolveNoteSource`）；情境資料的訊息來源補上 `sourceLineId`。
  - `mock.setFeatures()`（demo 的設定頁在 mock 模式改模式用）；`capabilities.models`；B5 的改名、背景預覽、搜尋、草稿提案、job 的模型，錯誤碼依 B5 增補。

### 2. `@tangent/react`
| 元件 / hook | 內容 |
|---|---|
| `NotesPanel` | A9：頂端「這頁每一輪都會給 AI・約 n token」（token 來自預覽的紀要區塊）＋新增；超過預算時說明幾條、哪幾條這輪不會給 AI（條目標「這一輪不會給 AI」）；四區各有標題與有效數；被取代的每區收合在「顯示被取代的 n 條」（`aria-expanded`）；底部「n / maxActive 條有效」，到上限擋下新增。載入骨架、讀取失敗重試；唯讀身分只能看 |
| `NoteItem` | 有效、完成（劃掉，待辦用勾選框）、新、編輯中（點文字修改：Enter 存、Esc 取消且不讓側欄收到、離開輸入框存；伺服器拒絕時帶原因重新打開）、取代（hover／focus 出現的圖示鈕，表單有儲存與取消）；來源可點（主線 #n、`查證・目的`、`結論卡・目的`、已清除的來源只顯示文字） |
| `SupersededNoteItem`、`NoteEditor`、`NoteAddForm`（區塊選擇＋一行文字，Enter 加入，關閉後焦點回「新增」） | |
| `SegmentedControl` | 原型的膠囊單選：radiogroup、單一 tab 停駐、方向鍵／Home／End 移動即選取、觸控 44px |
| `UnreadDivider` ＋ `MessageList unread` | 「n 則未讀」分隔線（`role="separator"`），放在第一則未讀前 |
| `useUpdateNote`（樂觀、失敗回滾）、`useSupersedeNote`、`useCreateNote`（結果直接寫進快取） | 寫入後 invalidate 紀要與所有預覽；`notes.changed` 也 invalidate 所有預覽（紀要區塊在整棵樹每條線的 prompt 裡） |
| `useNotesBlock`、`useNotesSeen`（`NotesSeenStore`，預設 localStorage、讀寫失敗不影響畫面，依 `scopeKey` 分開） | |
| `useRenameBranch`、`useBranchPreview` | B5 |
| 命令 `notes.add`（⌘⇧N） | shortcuts.md 的「記進紀要（選取文字）」 |
| `StructurePanel` | 地圖改成懶載入（`React.lazy`）；大綱的 F2 改名接上 `PATCH /branch` |
| 開支線對話框的 `PackEstimate` | 改用 `POST /branches/preview`（目的停止輸入 350 ms 後重問）；載入中或伺服器沒有這條路由時退回原本的粗估並照舊標示 |
| 結論卡審閱 | 草稿的紀要提案自動列入、預設勾選、虛線並標「AI 提議」；起草的 202 帶的 provider / model 直接顯示 |

### 3. demo
- **紀要分頁**（懶載入）：取代 F2 的占位；來源連結切換線並高亮那則訊息。
- **記進紀要**：AI 回覆的訊息動作、選取工具列、⌘⇧N（有選取用選取，否則最後一則回覆）都寫入「待確認」並帶來源訊息（同原型 `noteFrom`），提示「已記進紀要的「待確認」。」，之後在紀要頁修改。`notes` 關閉時三個入口都不出現。順口問的「記進紀要」沿用 F2 的對話框（預設「已確認的事實」，來源是該順口問）。
- **設定**（`SettingsDialog`，懶載入，600 寬、列高 44）：
  - 這條線的 provider / model：`/capabilities.models` 有列出時是下拉選單，改了用 `PATCH /lines/{id}`；沒有列出時只顯示目前的值並說明（退路）。線沒有 model 時顯示「伺服器預設」。
  - 外觀：淺色／深色／跟隨系統（嵌入時說明由宿主決定，不提供選擇）。
  - 費用提示門檻：US$0.02／0.05／0.10，預設 0.05。主題與門檻存在這個瀏覽器（`frame/prefs.ts`，讀寫失敗退回預設）；網址有 `?theme=` 時網址優先（截圖用）。
  - 功能：核心三項「核心・一定開啟」，再依 `/capabilities` 列出開著的功能；有模式的顯示模式。真伺服器的模式由伺服器決定（全部唯讀「由宿主決定：建議」）；mock 可以改（記憶鎖定，同原型），也可以切換三種功能組合（全開／C1／只有核心，會重新載入）。有功能被關掉時說「其他功能已由宿主關閉。」
- **功能開關的呈現**：關閉＝不渲染；`branch_suggest` 只在「建議」「自動」時顯示 AI 建議（手動＝沒有 AI 提案，只剩使用者自己的開支線）。只有核心時：側欄只有「結構」標題、AI 回覆的動作只剩「從這則開支線」「複製訊息」、輸入框只剩開支線、預覽、送出，按鈕在同一列（e2e 檢查垂直置中差 ≤ 1px）。
- **420 嵌入示範頁**（`?frame=embed`，視窗 ≥ 720 時）：左邊是模擬的深色開發者工具（Elements／Console／Network／Tangent），右邊 420px 的 Tangent，整頁都用宿主主題；大綱由頂端按鈕叫出、蓋住對話（420 寬）；沒有地圖。視窗窄於 720 時只有面板（沿用 F1、F2 的 420 e2e）。
- **支線的未讀分隔線**：進入支線時記下當時的未讀數，標成已讀後分隔線仍保留到離開。
- **懶載入**：結構分頁、紀要分頁、全幅地圖、送出前預覽、設定、支線條、命令面板都改成按需載入的 chunk（`BranchHeader` 的快捷鍵 hook 拆到 `branch-commands.ts`，否則不會被拆出）。

### 4. e2e
新檔：`flows.ts`（共用步驟）、`notes.spec.ts`、`settings.spec.ts`、`features.spec.ts`、`embed.spec.ts`、`screens-f3.spec.ts`（只跑 mock，截圖與 axe）。

| 寬度 | 測試 | mock | 真 API |
|---|---|---|---|
| 1440 | 紀要：新增、點文字修改、取代（舊的劃掉收合）、待辦勾選完成、重新載入後仍在（只真 API） | ✓ | ✓ |
| 1440 | 從回覆的動作記進紀要（提示、待確認、來源「主線 #2」）、選取文字＋⌘⇧N（來源「主線 #4」）、點來源捲回那則 | ✓ | ✓ |
| 1440 | 順口問：開支線→回答→「記進紀要」→已確認的事實，來源「順口問・目的」 | ✓ | ✓ |
| 420 嵌入 / 375 | 紀要在覆蓋側欄／底部抽屜裡新增；手機觸控目標 ≥ 44 | ✓ | ✓ |
| 1440 | 設定：深色、門檻 US$0.02 後長草稿顯示金額、重新載入保留、跟隨系統；真 API 另外從伺服器的模型清單選 `fake-1`（B5） | ✓ | ✓ |
| 1440 | 設定：這個對話、功能清單（mock 可改、伺服器唯讀） | ✓ | ✓ |
| 420 / 375 | 設定：嵌入不能選主題；手機選項 44px | ✓ | ✓ |
| 1440 | 功能組合：全開 / C1 / 只有核心（mock 用 `?features=`；真 API 的預設伺服器＝C1 那組；`api-core` 專案是 `TANGENT_FEATURES=none` 的第二台伺服器） | 三組 | C1、核心 |
| 1440 | mock：設定改「建議開支線」為手動→建議消失→改回；切換到「只有核心」 | ✓ | — |
| 1440 視窗 | 嵌入頁：宿主外框、面板寬 420 靠右、所有 root 都是 host 主題、大綱蓋住對話且沒有地圖 | ✓ | ✓ |
| 1440 | 支線未讀分隔線「2 則未讀」在第一則未讀回覆前，標成已讀後仍在（真 API：五輪中第三輪後標已讀） | ✓ | ✓ |

設定上的改動：`playwright.config.ts` 新增 `api-core` 專案（自己的伺服器與 demo，跑 `features.spec`）；`start-api.sh` 每台伺服器各自一個二進位檔（兩台同時建置），清理舊資料庫與舊二進位檔時保留這次兩台的（`TANGENT_E2E_KEEP_PORTS`）；`isApi` 也認 `api-core`。

截圖：`UPDATE_SCREENSHOTS=1 pnpm -C web/e2e e2e screens-f3 notes settings features embed`，再 `node web/e2e/scripts/compare-shots.mjs <原型 URL> F3`（新增 F3 的五組）。

## 截圖對照（`docs/devlog/screenshots/F3/`）

`compare-1440-a9-notes / a13-settings / a4-unread / embed`、`compare-375-a9-notes`（左原型、右 demo），以及 e2e 產生的 `notes-*`、`settings-*`、`features-*`、`embed-*`、`unread-*`（mock 與真 API 各一）。

相符：紀要頂端的灰底說明列與新增鈕、四區標題與數量、條目的白底卡片與來源、被取代的「顯示被取代的 1 條」、待辦勾選框；設定的段落順序、主題三選一、門檻膠囊、功能列的「核心・一定開啟」與模式膠囊；嵌入頁的宿主外框與說明文字；未讀分隔線的主色線與文字。

差異：
1. 紀要頁沒有「跨對話記憶」區（D1，F6）。
2. 「新」：原型只標剛加的那條；demo 依上次造訪時間標，第一次造訪不標。
3. 紀要 token 是伺服器預覽的實際數（mock 約 221），原型寫死 420。
4. 來源「主線 #n」用 demo 的編號（這條線的第幾則對話訊息，F1 差異 1）；mock 情境裡指向不存在訊息的來源只顯示「主線」。
5. 設定的「這個對話」在有模型清單時是下拉選單（原型是兩個唯讀膠囊）；原型的功能清單比較長（P1–P3 的功能 demo 還沒有，伺服器也不會回報），demo 只列伺服器開著的。原型的「紀要：建議」「章節：自動」在 demo 是「開啟」：這兩個功能沒有模式（DESIGN §11 規則 3）。
6. 取代鈕是 hover／focus 才出現的圖示鈕（原型沒有畫取代的入口）。

## 與設計的差異、決定

- **哪些紀要會被省略**：`/notes` 的 `limits` 只有 `maxActive / maxTotal / maxRunes / maxChangesPerMerge`，沒有紀要區塊的 token 預算。所以「超過上限時哪些會被省略」改用伺服器實際組出的區塊：`POST /preview`（空草稿）的 `notes` 區塊沒帶到的有效紀要＝這輪省略的（同一個 query 也給 token 數）。`maxActive` 用於「n / max 條有效」與擋下新增，`maxRunes` 用於輸入檢查。
- **記進紀要**直接寫「待確認」不先開對話框（同原型）；順口問維持 F2 的對話框（預設「已確認的事實」）。
- **完成**只給待辦（勾選框，同原型）；其他區塊要改狀態用取代或修改。
- **「新」的上次檢視時間**存在瀏覽器（`NotesSeenStore`，宿主可換成自己的存放處）；同一次造訪中標記不會消失。
- **功能模式**：設定頁不能改伺服器的模式（沒有這種 API，而且模式影響的是伺服器行為）；只有 mock 能改，用來示範呈現規則。
- **修正 F2 的問題（有回歸 e2e）**：順口問頁沒有支線條也沒有結果列／輸入框——大綱查詢不含順口問，所以 `branchView` 一直是 null。現在順口問改讀 `GET /branch`；標頭路徑也改用含順口問的大綱。回歸測試是 `notes.spec` 的順口問測試（修正前找不到「記進紀要」）。
- **F1 的 e2e 修正**：`conversation.spec` 用 `getByText(QUESTION)` 找使用者訊息；fake 回覆（「Fake reply to: …」）也包含問題，回覆完成得快時會撞上 strict mode（第一次全套跑時真 API 失敗一次，重複 6 次重現 2 次）。改成 `exact: true`。
- 主 JS 從 194.2 降到 177.5 kB gzip：地圖 −3.8、結構分頁 −4.3（含 Base UI Field）、支線條 −3、預覽 −1.8、命令面板 −1.7；F3 自己加的紀要分頁（4.5）與設定（2.3）都在獨立 chunk。

## B5 契約

已接上：
- `/capabilities.models` → 設定頁的模型下拉與開支線對話框的模型選項（demo 原本寫死的 mock 模型拿掉，mock 也改由 capabilities 提供）。
- `POST /branches/preview` → 開支線對話框的背景（伺服器的數字，標示「伺服器依主線目前的內容整理」）。
- `PATCH /branch` → 大綱 F2 改名；`branch.changed{renamed}` 由既有的 invalidate 處理（有測試）。
- 草稿的 `noteChanges` → 審閱的 AI 紀要提案；起草 202 的 provider / model → 起草中顯示。
- `/compact` 的 provider / model、功能 `search`（設定頁列出）。
- `GET /search` 的 client 方法、型別與 mock 都有，契約與 mock 契約測試通過。

還沒接：
1. **搜尋的介面**：對話清單的搜尋仍是 client 端只搜標題與摘要主題（F1）。改用 `/search`（含支線目的與訊息內容、命中標示）不在 F3 範圍。
2. **卡片本身的 `message.updated`**：前端維持依回覆的 `meta.deliversCards` 自己標記（B5 說可以保留）；新事件到了也會照一般的訊息更新寫進快取，兩者不衝突。

## TDD 說明

先寫測試、確認失敗再實作：`notes-page`、`unread`、`proposalsFromDraft`、`capabilities.models`、`Note.sourceLabel`、mock 的 `setFeatures`／紀要開關／來源解析／預算省略、紀要 hooks、`NoteItem`、`NotesPanel`、`MessageList` 未讀分隔線與記進紀要、`notes.add` 綁定、`prefs`、`settings-model`、`SettingsDialog`、審閱的 AI 提案、對話框的伺服器背景、大綱改名。
沒有留下紅燈紀錄的：`SegmentedControl` 與 mock 的紀要區塊（測試與實作同時寫完才第一次執行）；B5 的 mock 路由與 `event-sync` 的 renamed／預覽 invalidate（先實作，契約測試是紅燈，單元測試是補寫的）。
demo 的 vitest 新增 jsdom（`// @vitest-environment jsdom`），元件測試放在 demo。

## 契約缺口與問題（給協調者 / 後端）

1. `/notes` 的 `limits` 可以加 `tokenBudget` 嗎？現在靠預覽的紀要區塊判斷省略了哪些，多一次 `POST /preview`。
2. fake provider 建的線 `model` 是空字串，`/preview` 因此沒有 `estimatedCostUsd`（F1 問題 2 仍在）；e2e 先在設定頁把線改成 `fake-1` 才看得到費用提示。要不要讓 fake 的預設模型是 `fake-1`？
3. 紀要的「完成」要不要開放給所有區塊（現在只有待辦）？
4. 搜尋介面排在哪個階段？
5. 設定頁的功能模式：宿主若要讓使用者自己調模式（例如每人關掉 AI 建議），需要一個「使用者偏好 → FeaturePolicy」的路由；目前一律唯讀。

## F3 追加：搜尋介面與協調者回覆（2026-10-16，未 commit）

協調者回覆了上面的問題（DESIGN §12 的「F3 問題」列），並把搜尋介面加進 F3。

### 依回覆調整
- **`tokenBudget`**：B5 的 `/notes` 樣本已帶 `limits.tokenBudget`。client 有送才保留這個鍵。紀要頂端改成「約 221 / 2k token」。mock 的 `MOCK_NOTE_LIMITS.tokenBudget` 也是紀要區塊的預算（取代先前的 `scenario.notesTokenBudget`）。
- **fake 預設 `fake-1`**：設定 e2e 在真 API 只在線不是 `fake-1` 時才換模型。
- **功能模式唯讀**：拿掉 mock 模式下改模式的功能（`mock.setFeatures`、設定頁的模式膠囊、記憶鎖定），所有模式都顯示「由宿主決定：…」。mock 仍可切換三種功能組合（F3 範圍 3 要求的示範）。
- **「完成」只用在待辦**：維持不變。

### 搜尋介面（對話清單的搜尋框）
- `search` 功能開啟時（mock 全開；參考伺服器預設，`defaultFeatures` 已含 `search`）：
  - 輸入框變成 combobox，停止輸入 250 ms 後呼叫 `GET /search`（`useSearch`，每次 30 筆，15 秒內同一查詢不重問）。
  - 結果分三組：對話標題、支線目的、訊息。每組內維持伺服器的排序。
  - 每筆顯示摘錄，命中範圍依回傳的 UTF-16 offset 用 `<mark>` 標出，全部是 React 文字節點，不當 HTML 渲染（`highlightParts` 會夾住、排序並合併 offset）。
  - 摘錄開頭太長時，只保留命中前 24 字，前面加「…」，讓命中處留在畫面內（`leadToHit`）。
  - 下一行標出所在對話；訊息另外標支線目的與「你 / AI」。
- 鍵盤：焦點一直在輸入框。↑ ↓ 移動（`aria-activedescendant`，頭尾循環），Enter 開啟目前那筆（沒選時開第一筆），Esc 清除。Esc 不會讓抽屜或「回上一層」也收到。本機搜尋的 Esc 同樣是清除。
- 點一筆結果：開那條線，有 `messageId` 就捲到那則並高亮（沿用 `navigate(lineId, messageId)`）。
- 狀態：少於 2 字顯示「至少輸入 2 個字。」；查詢中「搜尋中…」；沒有結果「沒有符合「q」的結果。」；伺服器錯誤顯示原因與「再試一次」。
- `search` 關閉時（mock C1、`api-core`）：維持 F1 的本機標題搜尋，不呼叫伺服器。
- 範圍：預設只搜進行中的對話（伺服器預設）。「包含封存」見下一段。
- 對話清單整個改成懶載入，主 JS 回到 **175.8 kB gzip**。加了搜尋之後一度是 179.4。

### 測試
- demo：`search-model.test.ts`（offset 夾住、合併、emoji、分組、2 字門檻、↑↓ 循環、摘錄前導）。
- demo：`conversation-search.test.tsx`（jsdom，mock）。內容：
  - 分組，`<mark>` 只包住命中文字；
  - 鍵盤、Enter 開啟、Esc 清除；
  - 點擊開啟訊息；
  - 太短、沒有結果、伺服器錯誤；
  - 功能關閉時用本機搜尋，且不呼叫伺服器。
- mock 已有的測試：租戶隔離與功能關閉回 `feature_disabled`。
- react：`useSearch`。
- e2e `search.spec.ts`：
  - mock 與真 API：分組、`<mark>`、↓ Enter 開到那則訊息並在畫面內、Esc 清除，含 axe。真 API 用 API 建一個帶唯一字詞的對話。
  - mock C1 與 `api-core`：本機搜尋。
  - `api-core` 的 testMatch 加上 `search`。

### 閘門
- typecheck 通過。
- vitest：fonts 9、client 439、react 499、demo 53。client 少 1 是因為拿掉了 `setFeatures` 的測試。
- build 通過，主 JS 175.8 kB gzip。
- Playwright 全套連跑兩次都是 **85 passed、9 skipped**：
  - mock：53 個，1 個刻意 skip；
  - api：35 個，4 個刻意 skip；
  - api-core：6 個，4 個刻意 skip。
- 結束前重新跑了契約與 mock 契約測試（120 個，樣本 71 檔），都通過。

### 包含封存（協調者追加）
- 結果區上方有「包含封存」切換鈕（`aria-pressed`），預設關，狀態存在這個瀏覽器（`tangent-demo.searchArchived`，讀寫失敗當成關）。
- 按下時焦點留在搜尋框，↑ ↓ 仍可用。
- 開啟時多問一次 `GET /search?archived=true`，因為伺服器每次只搜進行中或只搜封存。兩邊的結果依分數合併（同分新的在前，`mergeHits`），封存的命中標「已封存」。任一邊失敗就顯示錯誤與重試。
- 測試：
  - `search-model`：合併、偏好預設關、保存、儲存失敗。
  - `useSearch(q, enabled, archived)`。
  - `conversation-search.test.tsx`：關時沒有結果；開了出現 Proxmox 並標 Archived，請求帶 `archived: true`，焦點留在搜尋框；重新掛載後仍是開。
  - e2e：mock 與真 API。真 API 先用 API 建一個帶唯一字詞的對話並封存，預設搜不到；開啟後出現並標「已封存」；重新載入仍是開，並跑 axe。
- 閘門：
  - typecheck 通過。
  - vitest：fonts 9、client 439、react 500、demo 56。
  - build：主 JS 175.8 kB gzip。
  - Playwright 全套 **87 passed、10 skipped**（都是刻意 skip）。
  - 契約與 mock 契約測試重跑通過（120 個，樣本 71 檔）。

## R5 修正（2026-10-16，未 commit）

依該階段工單 的 B1–B8 與 DESIGN §12 的 R5 兩列。

### 變更
- **B1 取代可以換區塊**：`NoteItem` 的取代表單加上區塊選擇（沿用 `SegmentedControl`，四區）。預設值由 client 的 `replacementSection` 決定：「待確認」預設「已確認的事實」，其他區塊預設原區塊。`onSupersede(text, section)`，`NotesPanel` 把 `section` 帶給 `PATCH …/supersede`。被拒絕時重新打開表單，保留文字、選的區塊與原因。mock 的 supersede 原本就支援 `section`（沒帶時沿用舊區塊，同 `store/notes.go`），補了測試鎖住。
- **B2 摘錄前段**：`leadToHit` 的切點落在低位代理時多取一個 code unit，開頭不會是半個 emoji。
- **B3 條目不跳動**：`writeResult` 改成快取裡已有的條目原地替換（修改、被取代的那條），只有新條目放最前（新增、取代產生的新條目）。
- **B4 懶載入**：react 新增 `LazyRegion`（ErrorBoundary + Suspense）。chunk 載入失敗時，只有那一區顯示「這一區載入失敗。」與「重新載入」（重新整理頁面；被拒絕的 lazy import 會一直是拒絕，所以不做原地重試）。文字走 i18n（`ui.loadFailed`、`ui.reload`），樣式只用 `--tg-*` token。`onReload`、`onError` 可由宿主覆寫。
  - 對話清單（欄、窄欄、抽屜）的 fallback 是同寬的占位（`w-66`／`w-14`，同底色與邊線），首次載入時中欄不再橫移。
  - 支線列（`BranchHeader`）的 fallback 佔住 `min-h-22`，訊息不會被往下推。
  - 側欄的結構與紀要分頁在固定寬度的側欄裡，不會造成位移，只加錯誤邊界。
  - 預覽、地圖全螢幕、開支線等對話框、設定、命令面板：都是使用者打開的覆蓋層，不需要占位。失敗時錯誤框浮在頁面上方。
  - 結構面板裡的地圖（`BranchMap`）也改用 `LazyRegion`，保留原本的 Skeleton。
  - `main.tsx` 的 gallery 不包：它只給 e2e 的 axe 用，而且在 `TangentRoot` 外，token 不生效。
- **B5 結論卡內的選取**：`resolveMessageSelection` 對 `data-forkable="false"` 的列也回傳選取，多帶 `forkable: false`。新增 `hasSelectedText`（client）與 `hasTextSelection`（react）。
  - 選取工具列在這種列上只顯示「記進紀要」；沒有接紀要時不出現。
  - ⌘B（與輸入框的開支線按鈕）改走 demo 的 `useBranchHere`（`branch-commands.ts`），規則見下面「⌘B 的追加決定」。
  - ⌘⇧N 的順序：選取在同一則訊息內（含結論卡），就存選取的文字、來源是那則訊息；有選取但用不了（跨訊息、在對話外），就不存，並提示「請在同一則訊息內選取。」；完全沒有選取，才存最後一則回覆。
- **B6 搜尋框的無障礙**：`aria-controls` 只在 listbox 存在時輸出。「搜尋中…」與「沒有符合…」共用一個常駐的 `role="status"`，搜尋期間一直掛著，沒有內容時是 `sr-only`。
- **B7 重試**：「再試一次」會對所有失敗的查詢都 `refetch`；錯誤訊息仍然顯示第一個失敗的原因。
- **B8 勾選失敗**：`onToggleDone` 改用 `mutateAsync`。失敗時仍由 hook 回滾，`NoteItem` 在條目下方用 `role="alert"` 顯示「沒有存下：原因」，下次勾選時清掉。

### 測試（先寫、確認紅燈再實作）
- client：
  - `replacementSection`（紅：不是函式）；
  - `resolveMessageSelection` 的 `forkable` 與 `hasSelectedText`（紅：4 個）；
  - mock 換區塊取代（綠：mock 原本就支援，當作回歸測試）。
- react：
  - `NoteItem`：待確認預設已確認的事實、其他區塊預設不換、可以改選、被拒絕時保留選擇、勾選失敗顯示原因（紅：5 個，包含原本的取代測試改成帶 section）；
  - `NotesPanel`：待確認取代後出現在「已確認的事實」，舊的在「待確認」收合為被取代；勾選被拒絕時看得到原因且回滾（紅：2 個）；
  - note hooks：修改第 3 條時快取的順序始終不變；取代時新條目在最前、被取代的原地（紅：2 個，收到的順序是 `n2` 跳到最前）；
  - `SelectionToolbar`：卡片內只有「記進紀要」、沒接紀要時不出現（紅：3 個）；
  - `LazyRegion`：lazy 丟錯時只有那一區顯示錯誤，旁邊的內容還在，重新載入會呼叫；載入中顯示占位（紅：模組不存在）。
- demo：
  - `branch-commands.test.tsx`（新，⌘B，見下面「偏離與說明」）；
  - `note-actions.test.tsx`（新）：結論卡內選字按 ⌘⇧N，存的是選取的文字、來源 `nas-c1`；跨訊息與對話外的選取不存並提示；沒選取時存最後一則回覆（紅：前 2 個）；
  - `search-model`：emoji 剛好跨在切點上（紅）；
  - `conversation-search`：`aria-controls` 只指向存在的 listbox、沒有結果是 `role="status"`；兩個都失敗時按一次重試，兩個請求都再發一次（紅：2 個）。
- e2e `notes.spec.ts`：1440 的流程加上「待確認」取代後到「已確認的事實」，舊的在原區塊被取代；真 API 重新載入後仍在。

### 閘門
- typecheck 通過。
- vitest：fonts 9、client 443、react 513、demo 66（含 ⌘B 追加的 4 個）。
- build 通過，主 JS 176.4 kB gzip（原本 175.8）。
- Playwright 全套 **87 passed、10 skipped**（都是刻意 skip）。

### 偏離與說明
- ⌘B 的追加決定（協調者，2026-10-16）：和 ⌘⇧N 同一條規則，有選取但用不了時不再默默改用最後一則。
  - 在同一則可開支線的訊息內：從選取開支線。
  - 在結論卡或搬移標記內：不開，提示「結論卡或搬移標記不能開支線。」（`selection.notForkable`）。
  - 跨訊息或在對話外：不開，提示「請在同一則訊息內選取。」。
  - 沒有選取：照舊從最後一則開。
  - 提示文字的鍵由 `notes.selectOneMessage` 改名為 `selection.oneMessage`，⌘⇧N 與 ⌘B 共用。
  - 測試：`apps/demo/src/frame/branch-commands.test.tsx`，4 個，紅燈的原因是 hook 還不存在。
- emoji 只處理 surrogate pair（工作單的範圍）。由多個 code point 組成的字（ZWJ 序列、膚色修飾）在切點上仍可能被切開，但只影響「…」後面的第一個字。
