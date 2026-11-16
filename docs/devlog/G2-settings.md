# G2 · T3 Code 風格的完整 Settings 系統（Web UI）

> 2026-11-15。工單（§2 版面、§3 各分類與接線、§4 測試）。
> 基線 `70f0dae` 加上同一個 checkout 裡未 commit 的 G1／G3，**未 commit、未 push**。
> 零付費呼叫：只用 mock client 與 vitest／Playwright 的 mock project；沒有啟動參考伺服器，沒有呼叫任何模型或 CLI。
> 只改 `web/apps/demo/src/`、`web/packages/react/src/{markdown,conversation}/`、`web/e2e/tests/` 與這份 devlog；沒有動 Go、`web/packages/client/`、`docs/DESIGN.md`、`vite.config.ts`、`index.html`、`public/`。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過（5 個專案） |
| `packages/react` `npx vitest run` | 106 檔 **1130** 測試全過（基線 104 檔 1115） |
| `apps/demo` `npx vitest run` | 63 檔 **480** 測試全過（基線 55 檔 376） |
| `packages/client` `npx vitest run` | 98 檔 1359 測試：1349 過、**10 失敗，與基線完全相同**（B25 的 `route.imports.*`、`route.lines.import.batch`、`route.lines.list.pinned` 契約與 `DOMAIN_ERROR_CODES`）。這個套件沒有改任何檔案 |
| `pnpm -C web build`（mock） | 通過。主 JS `gzip -9`：**162,711 → 165,420 bytes**（+2,709；上限 172,000）。vite 自己報的數字是 166.08 kB |
| `VITE_TANGENT_API=http` build | 通過。主 JS `gzip -9` 177,824 bytes（G1 後 176.25 kB；上限 185 kB） |
| Settings chunk | `settings-host-*.js` 77.8 kB／gzip 24,266 bytes（整個設定頁、九個面板、搜尋索引、雙語字典）；`thread-notify-browser-*.js` 1.04 kB／gzip 596 bytes；`en.settings-*.js` 3.3 kB／gzip 1,271 bytes（既有）；`conversation-menu-*.js` gzip 5,095 bytes（多了確認對話框） |
| Playwright `mock` project：`tests/settings.spec.ts` | 7 支全過（原有 4 支改成新版面，新增 3 支 G2）。含 axe（moderate 以上）檢查設定對話框，1440／420 嵌入／375 手機 |
| Playwright `mock` project：`features.spec.ts`、`screens-f3.spec.ts` | 設定相關的都過。`features.spec.ts` 的「feature set: all／c1／core」3 支失敗，是 **G1 的模型 pill** 讓輸入框工具列多了一顆按鈕（斷言裡沒有），與 G2 無關，沒有改 |

主 chunk 多出來的 2.7 kB 是：`prefs.ts` 的 schema／store（約 1.3 kB）、`prefs-apply.tsx`、`thread-notify.ts`、兩個 context、`Composer` 的兩個 prop、`delete-host` 的直接刪除。設定頁本身、它的字典與搜尋索引都在 `settings-host` chunk，第一次按「設定」才下載。

## 設定結構

```
設定 / <分類>                                   ✕
┌──────────────┬──────────────────────────────────────────┐
│ 🔍 搜尋設定 / │                          [還原預設值]     │
│ 基本          │  卡片標題                                 │
│   一般        │  ┌──────────────────────────────────────┐ │
│   外觀        │  │ 名稱                     [控制項]    │ │
│   對話        │  │ 說明                                 │ │
│   快捷鍵      │  ├──────────────────────────────────────┤ │
│ 模型與對話    │  │ …                                    │ │
│   供應商      │  └──────────────────────────────────────┘ │
│   對話串      │                                           │
│ 系統與封存    │                                           │
│   維護 封存 關於                                          │
└──────────────┴──────────────────────────────────────────┘
```

- 對話框用 `DialogContent width="page"`（72rem），高度固定 `min(44rem, 100dvh − 8rem)`，換分類不會跳動。`md` 以下變成單欄：搜尋在最上面，分類變成一列可橫向捲動的按鈕，內容在下面（同一份 DOM，只靠 CSS）。
- 標題就是路徑「設定 / 一般」（也是對話框的無障礙名稱）。`還原預設值` 在內容上方（`DialogContent` 的標題列沒有放按鈕的位置，而 `packages/react/src/components/` 不在這張工單的範圍）。
- 搜尋：`/` 從對話框任何地方（文字欄位除外）聚焦；比對每一列的名稱、說明、卡片、分類與中英關鍵字，每個字都要符合；點結果（或 Enter 取第一筆）會切到那個分類、捲到那一列並高亮 2.4 秒。Esc 先清搜尋，再按才關對話框。
- 焦點：開啟時在目前分類的按鈕上（不在搜尋框，手機不會彈鍵盤）；每個開關是 `role="switch"`，用所在列的名稱與說明命名；選項是既有的 `SegmentedControl`（radio 語意）；二次確認都在原地、焦點在「取消」、Esc 只退回問題。

### 檔案

| 檔案 | 內容 | chunk |
|---|---|---|
| `frame/prefs.ts` | v2 偏好 store（schema、遷移、驗證、`usePrefs`、`bindingOverrides`、`hour12For`、`localeFor`、`costThresholdFor`、`CHAT_WIDTH_CLASSES`） | 主 |
| `frame/prefs-apply.tsx` | `PrefsProviders`（把偏好交給 `ShortcutsProvider`／`MarkdownOptionsProvider`／`ConversationOptionsProvider`）、`useComposerHint` | 主 |
| `frame/thread-notify.ts` | 對話通知的判斷與 hook | 主 |
| `frame/thread-notify-browser.ts` | Notification API 與 Web Audio 提示音 | lazy（自己一個） |
| `frame/confirm-action.tsx` | 取消置頂／封存的二次確認 | lazy（跟 `conversation-menu`） |
| `frame/settings-dialog.tsx` | 版面、導覽、搜尋、還原預設值 | lazy（settings） |
| `frame/settings-index.ts` | 分類、每一列的定義、搜尋 | lazy |
| `frame/settings-messages.ts` | 設定頁的雙語字典（232 個 key） | lazy |
| `frame/settings-controls.tsx` | 卡片、列、Switch、`ConfirmButton` | lazy |
| `frame/settings-prefs-panel.tsx` | 一般／外觀／對話（由 index 資料驅動） | lazy |
| `frame/settings-keybindings.tsx`、`frame/keybinding-record.ts` | 快捷鍵頁、錄製與衝突判斷 | lazy |
| `frame/settings-providers.tsx` | 供應商頁 | lazy |
| `frame/settings-threads.tsx` | 對話串頁（這個對話的模型、新對話預設、功能清單） | lazy |
| `frame/settings-archive.tsx` | 封存頁 | lazy |
| `frame/settings-system.tsx`、`frame/prefs-transfer.ts` | 維護、關於；匯出／匯入／重設／清除 | lazy |
| `react/markdown/markdown-options.tsx` | `MarkdownOptionsProvider`（`codeWrap`、`codeFontSize`、`renderMath`） | 主（很小） |
| `react/conversation/view-options.tsx` | `ConversationOptionsProvider`（`hour12`、`streamText`、`expandCards`） | 主（很小） |

一般／外觀／對話三頁沒有手寫的列：`settings-index.ts` 宣告每一列對應 `prefs.ts` 的哪個欄位，面板照著畫。測試檢查「每個偏好欄位剛好有一列」，所以不會有存了卻沒有控制項、或有控制項卻沒有欄位的設定。

## 偏好 store（`tangent:prefs`，version 2）

```json
{ "version": 2, "theme": "system", "language": "auto", "timeFormat": "24h", "threadNotifications": "off",
  "chatWidth": "reading", "readingFont": "sans", "codeFontSize": "md", "costThreshold": 0.05,
  "sendShortcut": "enter", "followUp": "block", "asideDefault": "discard",
  "inAppNotifications": true, "activityBadges": true, "confirmUnpin": false, "confirmArchive": false,
  "confirmDelete": true, "codeWrap": false, "renderMath": true, "streamResponses": true, "expandCards": false,
  "keybindings": {} }
```

- **驗證**：`parsePrefs` 逐欄檢查，不在選項裡的值、型別不對的值各自回到預設，其他欄位照留。`keybindings` 只留 `canonicalKeys` 接受的字串或 `null`，最多 100 筆。整段不是 JSON → 全部預設。`set`／`update` 寫入前跑同一個驗證。
- **遷移**：沒有 `tangent:prefs` 時讀舊的 `tangent-demo.prefs`（theme、costThreshold）與 `tg.readingFont`，第一次讀到就寫成 v2。舊 key 不刪（舊版程式還讀得到），之後不再讀。
- **store**：`createPrefsStore`（`get`／`set`／`update`／`reset`／`subscribe`，監聽其他分頁的 `storage` 事件）；頁面用 `prefsStore` 與 `usePrefs()`。寫不進 storage 時這一頁仍然生效。
- **模型偏好**沿用 G1 的 `model-prefs.ts`（`tangent:model-prefs`），沒有改它，也沒有複製它的資料；匯出／匯入／還原預設值都把兩個 store 一起處理。
- **匯出檔**：`{ kind: "tangent-settings", version: 1, exportedAt, prefs: {version: 2, …}, modelPrefs: {version: 1, …} }`。匯入時不是 JSON、不是我們的檔、或檔案格式版本比較新 → 拒絕且不改任何東西；接受的檔案裡每個值再跑一次各 store 的驗證。
- 其他本機狀態（面板寬度、收合的資料夾、專注模式、置頂、各對話的順口問選擇、已讀紀要時間…）是畫面狀態，不是設定，仍在各自的 key。「維護 → 清除本機暫存」會清掉它們（`tangent:`／`tangent.`／`tangent-demo.`／`tg.` 開頭、兩個設定 key 除外）。

## 每一項設定接到哪裡

### 一般

| 設定 | 欄位 | 接線 |
|---|---|---|
| 對話通知（關閉／靜音／有提示音） | `threadNotifications` | `shell.tsx` 的 `useThreadNotifications` 聽事件串流：看過 pending 的回覆完成（或失敗）時，那條線不在畫面上、或分頁在背景／沒有焦點，就 `new Notification(...)`（瀏覽器已授權時；`tag` 固定，新的取代舊的；點了回到那條線）。「有提示音」另外用 Web Audio 播兩個短音，沒有音檔。選「靜音／有提示音」的那一下會向瀏覽器要權限；列的下方顯示權限狀態、「允許通知」與「測試」。被停止的回覆不通知 |
| 應用程式內通知 | `inAppNotifications` | `useReplyToast({ enabled })`：關閉後不產生背景回覆的 toast，正在顯示的立刻消失 |
| 顯示活動標記 | `activityBadges` | `conversation-list.tsx` 的 `Activity`：隱藏「n 條進行中／未讀／等你」與藍點，標籤照留 |
| 取消置頂前確認（預設關） | `confirmUnpin` | `conversation-menu.tsx`：取消置頂先開 `ConfirmAction`；置頂不問 |
| 封存前確認（預設關） | `confirmArchive` | `conversation-menu.tsx`：封存先開 `ConfirmAction`；解除封存不問 |
| 刪除前確認（預設開） | `confirmDelete` | `delete-host.ts` 的 `useConversationDeletion({ confirm })`：關閉後「刪除對話…」直接 `DELETE /lines/{id}`，離開該對話並 toast；伺服器拒絕（回覆還在跑）時說明原因並退回確認對話框 |
| 時間格式（依語言慣例／12／24） | `timeFormat` | 清單：`timeLabel(..., hour12)`；訊息：`ConversationOptionsProvider hour12` → `MessageTime` |
| 介面語言（跟隨瀏覽器／繁體中文／English） | `language` | `main.tsx`：`TangentProvider locale`、`<html lang>`、中文字型載入；不用重新整理。網址有 `?lang=` 時以網址為準，列下方會說明 |

### 外觀

| 設定 | 欄位 | 接線 |
|---|---|---|
| 主題 | `theme` | `themeFor` → `TangentRoot theme`（既有）；嵌入時顯示「由宿主決定」；網址有 `?theme=` 時列下方說明 |
| 對話寬度（閱讀／寬／全寬） | `chatWidth` | `conversation-view.tsx`：訊息欄、記憶提示、提示條與 `Composer` 的 `max-w-tg-reading`／`max-w-5xl`（64rem）／`max-w-none` |
| 閱讀字體 | `readingFont` | `<html data-tg-reading-font>`（既有邏輯，改由 store 驅動；舊 key 自動遷移） |
| 程式碼字級（小／中／大） | `codeFontSize` | `MarkdownOptionsProvider` → `CodeBlock` 的 `text-tg-xs`／`text-tg-sm`／`text-tg-md`（都是 `--tg-text-*` token） |
| 程式碼區塊自動換行 | `codeWrap` | `MarkdownOptionsProvider` → `CodeBlock` 的 `<pre>` 加 `whitespace-pre-wrap break-words` 與 `data-tg-code-wrap` |
| 渲染數學公式 | `renderMath` | `MarkdownOptionsProvider` → `markdown-impl`：關閉時不掛 `remark-math`、不跑金額跳脫、```` ```math ```` 當一般程式碼 |
| 費用提醒門檻（0.02／0.05／0.10／關閉） | `costThreshold` | `TangentProvider costThreshold`；「關閉」傳 `Infinity` |

### 對話

| 設定 | 欄位 | 接線 |
|---|---|---|
| 送出鍵（Enter／⌘·Ctrl+Enter） | `sendShortcut` | `bindingOverrides` → `ShortcutsProvider bindings`：`composer.send = Mod+Enter`、`composer.newline = Enter`。`Composer` 的提示文字改成目前的按鍵（新的 `hint` prop，由 `useComposerHint` 依實際綁定組出來）。快捷鍵頁自訂的 `composer.send` 優先，列下方會提醒 |
| 串流顯示回覆 | `streamResponses` | `ConversationOptionsProvider streamText` → `AssistantMessage`：關閉時 pending 的回覆只顯示階段與停止鈕，完成後才出現全文 |
| 回覆中再送出（等回覆／停止並送出） | `followUp` | `Composer` 新的 `sendWhileStreaming` prop：有草稿時按鈕維持「送出」、送出鍵有效；`conversation-view` 先 `cancelTurn` 再送，伺服器回 `turn_pending` 時每 150 ms 重試、最多 10 次。沒有草稿時按鈕仍是「停止」，Esc 仍停止 |
| 順口問預設（用完即丟／保留） | `asideDefault` | `useQuickAsk({ keepAside })`：設成「保留」時所有對話的順口問都從一開始保留，各對話選單裡的「順口問預設」收起來（已經沒有可選的）；「用完即丟」時維持各對話自己的選擇（F18） |
| 自動展開結論卡 | `expandCards` | `ConversationOptionsProvider expandCards` → `MessageList` 給 `BranchCard defaultExpanded`；切換時畫面上的卡片一起換成新的預設 |

### 快捷鍵

列出 `ShortcutsProvider` 的所有指令（含目前只有命令面板的），依既有的四組排列，可篩選。每列：名稱、預設按鍵、目前按鍵（按一下開始錄製）、重設。

- 錄製：按下組合鍵立即寫入；只按修飾鍵會繼續等；Esc 取消（不會關掉對話框）；離開按鈕也取消。錄製中的按鍵不會觸發任何指令。
- 會吃掉打字的按鍵不收（單獨的字母、數字、Tab、空白…；標點要有 Shift，例如 `Shift+?`）；輸入框自己的指令（送出、換行）可以單獨用 Enter。另一個平台的修飾鍵（Apple 上的 Ctrl、其他平台的 ⌘／Win）無法寫成綁定，也不收。
- 衝突：按鍵已經屬於另一個指令時不寫入，並說出是哪一個。
- 持久化：`prefs.keybindings`（只存真的改過的；錄回預設按鍵等於取消自訂），經 `bindingOverrides` 進 `ShortcutsProvider`，立刻生效。
- 既有的 `?` 快捷鍵說明（`shortcuts-dialog.tsx`）不用改：它本來就讀 provider 的綁定，會顯示自訂後的按鍵。

### 供應商

讀 `GET /capabilities`（G1 的 `ready`／`reason`／`details`）。固定列出 `claude-cli`、`codex-cli`、`agy-cli`、`openai`、`anthropic`、`fake`，加上伺服器另外列出的。狀態：就緒／未就緒（附原因與設定引導）／已啟用（API provider 不回報就緒）／這台伺服器沒有啟用（附設定引導）。每個模型有「常用」與「隱藏」兩個切換（`aria-pressed`），寫進 `model-prefs.ts`。

生效的地方：輸入框的模型 pill（G1 已接）、設定頁「這個對話」與「新對話的預設模型」、開支線表單（`shell.tsx` 把 `modelOptions` 用 `arrangeModelChoices` 排過）。**Diverge／Regenerate 沒有接**，見下節。

### 對話串

- 這個對話：模型下拉（既有功能搬過來，選項改成排過、去掉隱藏的）。
- 新對話：預設模型（「伺服器預設」＋清單；伺服器不再列出的預設仍顯示並標明）與預設思考深度（只列該模型接受的等級；模型不接受時停用）。寫 `model-prefs.ts`，`useNewConversation` 照舊讀它。
- Tangent 樹狀功能：既有的功能清單與預設組（四個標題、唯讀模式）。mock 保留預設組與功能組切換；對伺服器時多一行說明功能由 `TANGENT_FEATURES` 決定，預設組仍給現成的設定行。

### 封存

`useLines({ archived: true })`：搜尋（標題與主題）、點標題開啟、解除封存一鍵完成、永久刪除要在該列再答一次。結果在 `role="status"` 說明。唯讀身分只能看。

### 維護、關於

- 匯出設定 JSON（下載 `tangent-settings-YYYY-MM-DD.json`，或複製）、匯入設定 JSON。
- 重設本機偏好（等同還原預設值）、清除本機暫存（列出筆數，確認後清除並重新載入）。
- 連線：`baseUrl` 或「瀏覽器內的 mock」、事件串流狀態（`useLiveState`）、可讀寫／唯讀。
- 關於：Tangent、`v0.1.0`、MIT、GitHub（`github.com/Rynvex/tangent`，取自 `go.mod`）、文件、嵌入指南、回報問題。

## `@tangent/react` 的新介面（都是選填，預設等於原本的行為）

```ts
// markdown/
<MarkdownOptionsProvider codeWrap? codeFontSize? renderMath?>   // useMarkdownOptions()
// conversation/
<ConversationOptionsProvider hour12? streamText? expandCards?>  // useConversationOptions()
<Composer hint? sendWhileStreaming? />
```

沒有 provider 時既有元件的輸出一個 class 都沒有變（`CodeBlock`、`Composer`、`MessageList`、Markdown 的既有測試全部不改就過）。`CodeBlock` 的 `<pre>` 多一個只在換行時才有的 `data-tg-code-wrap`。套件的 `index.ts` 沒有改：兩個資料夾本來就是 `export *`。

## 沒有做的與原因

| 項目 | 原因 |
|---|---|
| **Sidebar thread order**（手動／最近活動） | 清單的順序來自伺服器的 `lastActivityAt` 加上時間分組、資料夾與置頂。要做「手動排序」需要拖放與一份新的順序資料；要做「依標題」得改寫 `conversation-list.tsx` 的分組段落，而那個檔有使用者未提交的修改，只允許最小增量。工單對這一項也給了「保留既有排序控制」的選項，所以沒有放開關（不放假開關）。既有的置頂、資料夾收合照舊 |
| **Diverge／Regenerate 的模型清單** 不套用隱藏與常用 | 兩個元件在 `packages/react/src/f8/`，自己呼叫 `modelChoices(capabilities)`，不在這張工單可改的資料夾。要接需要在 `@tangent/react` 給它們一個過濾／排序的入口（例如一個 `ModelChoicesProvider`），請協調者決定。供應商頁的說明文字只列出已經接上的三個地方 |
| **草稿快取** | 輸入框草稿只存在頁面的 React state，本來就沒有寫進 `localStorage`，所以沒有「清除草稿快取」可做；「清除本機暫存」的說明寫明這一點，它清的是其他本機狀態並重新載入（草稿也跟著清掉） |
| 伺服器端的通知（Web Push） | 需要後端。現在的通知只在這個分頁還開著時有效 |

## 與工單不同的地方

1. **時間格式的預設是「24 小時制」，不是「依語言慣例」**。app 一直用 24 小時制（`clockTime` 寫死 `14:52`），而 zh-TW 的語言慣例是「下午2:52」；預設改成 auto 會讓現有使用者的畫面與一批 e2e 斷言一起變。三個選項都有，只是預設值是 24h。
2. **「還原預設值」是全部設定**（設定、快捷鍵、模型偏好），不是只有目前分類；按下去先問一次。
3. **⌘/Ctrl+Enter 當送出鍵時，「結束並帶回」會失去它原本的 ⌘/Ctrl+Enter**（`resolveBindings` 的規則：覆寫優先，被占用的預設按鍵讓出）。對話頁的列下方與快捷鍵頁都會說明，可以在快捷鍵頁另外給它按鍵，或用命令面板。
4. **程式碼換行、字級、數學用 Context，不是 CSS 變數**：三個設定都要到達 lazy 載入的 Markdown renderer（數學是 remark 外掛，CSS 做不到），用同一個 context 比較一致，也能直接在 DOM 上測。字級仍然是 `--tg-text-*` token 的 class。`styles.css` 沒有改。
5. `SettingsDialog` 的 props 變了（不再收 `prefs`／`onPrefsChange`／`readingFont`，改讀 store），`SettingsHost` 多一個 `onSelect`（封存頁開啟對話）。兩者只有 demo 自己用。
6. `prefs.ts` 的 `DemoPrefs` 從兩個欄位變成完整的設定；`loadPrefs`／`savePrefs`／`browserStorage`／`themeFor`／`COST_THRESHOLDS` 仍然匯出。舊的 `prefs.test.ts` 改寫成 v2 的測試。
7. `reading-font.ts` 的 `loadReadingFont`／`saveReadingFont` 還在（它自己的測試照過），但頁面不再呼叫；字體改存在 v2 偏好裡，舊 key 只在遷移時讀一次。

## 測試

### vitest（demo 淨增 104 支：下列 10 檔共 119 支，取代原本 `prefs.test.ts` 4 支與 `settings-dialog.test.tsx` 11 支；react 增 15 支：下列 13 支，加上 `token-guard.test.ts` 對兩個新元件檔各 1 支）

| 檔案 | 內容 |
|---|---|
| `frame/prefs.test.ts`（改寫，17） | v2 預設值、key 與版本、壞值逐欄 fallback、壞 JSON、keybindings 驗證與上限、storage 丟例外、**v1 遷移**（三個欄位、只遷一次、舊 key 留著）、store（更新／通知／持久化／reset／寫入時驗證）、`themeFor`／`costThresholdFor`／`localeFor`／`hour12For`／`bindingOverrides`／寬度 class |
| `frame/prefs-transfer.test.ts`（5） | **匯出→匯入**到另一個瀏覽器完全相同且寫入 storage、拒絕非 JSON／非本檔／較新格式且不改任何東西、損壞檔案的有效值照進、**還原預設值**、清除本機暫存只清自己的 key 且不清設定 |
| `frame/settings-index.test.ts`（8） | 九個分類三組、沒有 T3 Code 專屬分類、每個偏好欄位剛好一列、選項齊全、雙語字串齊全且兩邊 key 相同、**搜尋**（名稱／說明／卡片／分類／關鍵字、每個字都要中、大小寫、空字串、中文介面、英文介面下打中文） |
| `frame/keybinding-record.test.ts`（8） | 按鍵→綁定字串（Mod 跨平台）、修飾鍵等待、Esc 取消、拒絕會吃掉打字或寫不出來的鍵、輸入框指令可單獨 Enter、Alt／非拉丁鍵盤取實體鍵、錄出來的字串 `resolveBindings` 接受、**衝突**、只存真的變更 |
| `frame/settings-dialog.test.tsx`（改寫，15） | 版面與導覽、**搜尋過濾與分類跳轉＋高亮**、`/` 聚焦、Enter 取第一筆、無結果、Esc 先清搜尋；外觀／一般／對話各列寫進 store 並存進 `localStorage`；嵌入時主題由宿主決定；Switch 的名稱、說明與鍵盤操作；開啟通知時向瀏覽器要權限；**還原預設值**（先問、取消不動、確認後兩個 store 都回預設並宣告）、Esc 只退回問題 |
| `frame/settings-pages.test.tsx`（17） | 供應商狀態／原因／引導／未啟用、**常用與隱藏**寫入 `model-prefs` 並反映在 `arrangeModelChoices` 與對話串頁的預設模型清單、伺服器沒列模型；預設模型與只列該模型接受的思考深度、`newLineInput` 帶出；原本 A13／F9 的功能清單與預設組測試（搬到對話串頁）；封存頁列出／搜尋／開啟／解除封存／二次確認後永久刪除／唯讀 |
| `frame/settings-keybindings.test.tsx`（13） | 列表與分組、篩選、**錄製後立即生效（舊鍵失效、新鍵觸發指令）並寫進 `localStorage`、重新建立 store 仍在**、給沒有按鍵的指令按鍵、**衝突拒絕並指名**、無效鍵、Esc 取消且對話框不關、重設單項與全部、錄回預設不算自訂；**送出鍵**：預設 Enter 送出、選 Ctrl+Enter 後 Enter 不送出而 Ctrl+Enter 送出、提示文字與快捷鍵頁跟著變、切回立即生效、自訂的送出鍵優先 |
| `frame/prefs-wiring.test.tsx`（18） | **程式碼換行**與字級套到畫面上的 `<pre>` 並可還原、**渲染數學**開關、費用門檻關閉；**對話寬度**套到訊息欄與輸入框；**停止並送出**（先 `cancelTurn` 再 `sendMessage`）與預設的等待；**封存／取消置頂確認**（預設直接做、開啟後先問、取消不做）、順口問預設「保留」時選單收起；**刪除確認**開（只開對話框）／關（直接刪、離開、toast）／關且伺服器拒絕（說明並退回對話框）；活動標記隱藏而標籤照留、清單時間格式；應用程式內通知開關 |
| `frame/thread-notify.test.ts`（8） | 判斷規則、不在畫面上的線才通知、分頁在背景時連畫面上的線也通知、關閉不通知、提示音、失敗的說法、只算看過 pending 的回覆、被停止的不通知；Notification 的建立／點擊／無權限、提示音兩個音、權限查詢與請求 |
| `frame/settings-system.test.tsx`（10） | 匯出檔名與內容、複製、匯入後兩個 store 與 storage、拒絕的三種說法、重設要二次確認、清除本機暫存的筆數／保留設定／重新載入、沒有可清除時、連線三列、唯讀、關於 |
| `react/markdown/markdown-options.test.tsx`（6） | 沒有 provider 時照舊、換行開關不重新解析、三種字級、數學關閉時 `$` 原樣、```` ```math ```` 變程式碼、再開啟後渲染 |
| `react/conversation/view-options.test.tsx`（7） | 串流關閉時 pending 只有階段與停止鈕、完成後全文；12／24 小時制；結論卡預設展開與切換；`Composer` 的 `hint` 與 `sendWhileStreaming`（有草稿送出、沒草稿停止、Esc 仍停止、不開時照舊） |

### Playwright（`web/e2e/tests/settings.spec.ts`，mock project 實際跑過）

- 原有 4 支改成新版面（主題與費用門檻在「外觀」，模型與功能清單在「對話串」；「費用門檻」的名稱現在是「費用提醒門檻」）。`features.spec.ts` 的「設定對話框切換 mock 功能組」多一步點「對話串」。
- 新增「G2 settings page」3 支：`/` 搜尋「對話寬度」→ 跳到外觀並高亮；全寬、深色、Ctrl+Enter 送出立即生效（Enter 換行、Ctrl+Enter 送出），重新整理後三者都還在，還原預設值後都回來；介面語言切成 English 不用重新整理、重新整理後仍是英文；375 寬單欄、分類在內容上方、沒有橫向溢出、axe 通過。

## 留給協調者

1. `features.spec.ts` 的「feature set: all／c1／core」在 mock project 失敗，原因是 G1 的模型 pill（輸入框工具列第一顆按鈕「模型：…」）不在斷言的清單裡；G1 的 devlog 註明沒有跑 Playwright。這三支不是 G2 造成的，沒有動。
2. Diverge／Regenerate 要套用隱藏與常用，需要 `packages/react/src/f8/` 的改動（見上）。
3. `packages/react/README.md` 可以補上兩個 provider 與 `Composer` 的兩個 prop（README 不在這張工單的範圍）。
4. 只跑了 Playwright 的 mock project 中與設定有關的三個 spec；`api`／`api-core` project（要起參考伺服器與資料庫）沒有跑。`settings.spec.ts` 也在 `api` project 的清單裡，它的前 4 支在那邊要協調者驗證。
5. 「停止並送出」對真的伺服器只用 mock 驗證過流程；真的伺服器在 `cancel` 回來後多久才接受下一輪，取決於 runner 何時收尾，所以有 `turn_pending` 的重試（最多約 1.5 秒），超過會把草稿放回輸入框並顯示錯誤。
