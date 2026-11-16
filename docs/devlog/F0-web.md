# F0 · 前端基礎

> 2026-10-15。依該階段工單：token v3、自架字體、基礎元件、版面外框、命令面板與快捷鍵框架、`StatusBanner`、
> mock 資料層、i18n、Playwright 冒煙與 axe。只動了 `web/` 與 `docs/devlog/`（本檔與 `screenshots/F0/`），沒有改 Go。未 commit。

## 驗收（在 repo 根目錄執行）

| 檢查 | 結果 |
|---|---|
| `pnpm -C web install` | 通過 |
| `pnpm -C web typecheck` | 通過（client、react、demo、e2e 四個專案） |
| `pnpm -C web test` | 通過：client 25 檔 228 個、react 15 檔 124 個、demo 1 檔 11 個，共 363 個（W0 後為 238） |
| `pnpm -C web build` | 通過：JS 443 kB / gzip 146 kB，CSS 621 kB / gzip 85 kB（其中字體 `@font-face` 約 67 kB gzip），961 個 woff2 檔（dist 共 25 MB，依 unicode-range 按需下載） |
| `pnpm -C web e2e`（Playwright 冒煙 + axe） | 通過：5 個測試（1440 淺色、1440 深色 + AI 錯誤、1440 只開核心、420 嵌入宿主主題、375 手機觸控），WCAG 2.2 AA 規則集無 serious / critical |

e2e 會自己用 `VITE_TANGENT_API=mock` 起 demo dev server（5183，已有就沿用），不需要後端。`pnpm test` 不含 e2e（另一個 script，需要瀏覽器）。

## 版本

catalog 新增（實際解析版本）：`@ibm/plex-sans` 1.1.0、`@ibm/plex-mono` 2.5.0、`@ibm/plex-sans-tc` 1.1.1、`@fontsource/source-serif-4` 5.3.1、
`@fontsource/noto-sans-tc` 5.3.1、`@fontsource/noto-serif-tc` 5.3.1、`@fontsource/geist-sans` 5.3.0、`@fontsource/geist-mono` 5.3.0、
`@testing-library/user-event` 14.6.8、`@playwright/test` **1.58.2（固定，對應本機快取的 Chromium 1208）**、`@axe-core/playwright` 4.13.0。
`@base-ui/react` 這次解析到 1.9.0（範圍不變）。`@tangent/react` 的 dependencies 加回 `@base-ui/react`、`lucide-react` 與 8 個字體套件。

IBM Plex 三個套件的 postinstall 會跑 `ibmtelemetry`（送安裝統計），在 `web/package.json` 用 `pnpm.neverBuiltDependencies` 關掉。

## 做了什麼

### 1. Token v3（`packages/react/src/styles.css`）
- 併入 `handoff/tokens.css`：原有名稱與值不變，新增收尾 5、論證 5、`primary-text`、`highlight`、`suggestion(-soft)`、`success-soft`、`warning-soft`、
  字級 7、閱讀寬度與行高、圓角 `sm/lg/full`、`shadow-overlay`；`data-theme="host"`（宿主 深色 + Geist）。
- **審查 §2 #1**：新增 `--tg-border-input`：淺色 `#8a8273`、深色 `#706d66`、宿主 `#646a82`，對 background / surface / sunken / raised 都 ≥ 3:1
  （最低 3.13）。所有表單元件（TextField、TextArea、Select、Checkbox、demo 的搜尋框與輸入框）都用它。
- 另加 `--tg-control-height(-sm)`、`--tg-hit-target`：一般 32 / 28px，`data-density="compact"` 28 / 24px，`(pointer: coarse)` 一律 44px。
- 形狀、字體、字級也宣告在 `[data-theme]` 上，巢狀容器換成宿主主題時圓角等衍生值會重算。
- Tailwind `@theme inline` 對應全部顏色、`text-tg-*` 字級、`leading-tg-reading`、`max-w-tg-reading`、`rounded-tg-full`、`shadow-tg-overlay`、`ease-tg-out`。
- 測試（`styles.test.ts`）：淺 / 深 / 宿主三套的文字 4.5:1、ring 與 border-input 3:1；每個區塊 token 不重複、宿主區塊只覆寫已知 token；v2 值不變；
  每個顏色都有 Tailwind 對應；審查 #2 #3 的規則存在；`--tg-muted` 在 accent 與 `*-soft` 底色上 ≥ 4.5:1（見下方「發現」）。
- `token-guard.test.ts`：掃描套件所有 `.tsx`，不准出現 Tailwind 調色盤類別（`text-red-500`、`bg-white`…）或寫死的顏色值。

### 2. 字體（`@tangent/react/fonts.css`，可選）
- `scripts/build-fonts.mjs`（`pnpm --filter @tangent/react fonts`）讀各套件自己的 `@font-face`，產生 `src/fonts.css`：只留 woff2、只留用到的字重
  （Plex Sans 400/500/600、Plex Mono 400/500、Plex Sans TC 400/500/600、Source Serif 4 400/600、Noto Serif TC 400/600、Noto Sans TC 400、Geist 400/500/600、Geist Mono 400/500，
  都只有 normal），全部 `font-display: swap`、全部有 `unicode-range`（中文是 104–206 片的切片），url 指向套件（`@ibm/plex-sans/...`），由宿主 bundler 解析。
- 相同 unicode-range 的 face 排在一起，讓 gzip 能折疊重複的範圍清單：173 kB → 67 kB。
- Geist 的 fontsource 檔沒有 range，產生器補上 Latin 範圍；否則宿主主題的全形標點會被 Geist 搶走（420 截圖抓到「；」變半形）。
- `fonts.test.ts` 檢查家族、字重、swap、來源套件、每個 face 都有 range、中文家族確實切片。
- demo：`main.tsx` 匯入 `fonts.css`；`vite.config.ts` 的 `preloadFonts` 外掛只 preload Plex Sans Regular 與 SemiBold 的 Latin1 兩個檔；
  `assetsInlineLimit` 讓 woff2 不被 base64 內嵌進 CSS（否則 CSS gzip 85 → 150 kB）。

### 3. 基礎元件（`packages/react/src/components/`，Base UI + `--tg-*`）
`Button`（primary / secondary / ghost / destructive，`loading` 時保留寬度、`aria-busy` + `aria-disabled`、可聚焦但不觸發、文字換「處理中…」）、
`IconButton`（必填 label、預設帶 Tooltip、`pressed`、`variant="primary"`、`round`）、`Tooltip`、`Dialog` / `DialogContent`（標題、描述、footer、寬度 sm–xl；< 640px 全螢幕）、
`Popover`、`Menu`（`MenuItem` 含 destructive / shortcut、`MenuSeparator`、`MenuGroup`）、`Tabs` / `TabsList` / `Tab` / `TabsPanel`（選取 2px 底線）、
`TextField`、`TextArea`（Base UI Field：label、description、error 以 id 串起）、`Select`、`Checkbox`、`Kbd`（`hint` = 觸控隱藏）、`Badge`、`Skeleton`（`tg-shimmer`）。
- 通用狀態照 `components.md`：hover、2px ring offset 2 的 `:focus-visible`、停用 45% + `aria-disabled`、錯誤只用 destructive token。
- 動態效果都用 `--tg-duration-*`，減少動態時變 0ms；轉圈用 `motion-safe:`；`tg-shimmer` 在 reduce 時停。
- 彈出層都 portal 到 `TangentRoot` 裡的容器，所以會繼承 `data-theme`（測試有驗）。
- 元件用 `useUiT()`：有 `TangentProvider` 用它的翻譯，沒有就英文，所以宿主不用 client 也能單獨用這些元件。

### 4. 版面外框
- 套件：`TangentRoot`（`theme`: system / light / dark / host、`density`、`data-tg-root` 的基本字體與顏色、popup 容器、共用 Tooltip delay）、
  `SidePanel`（`column` 360px、`overlay` 右側覆蓋 + shadow-overlay、開著時 Esc 從任何地方都能關、`sheet` 手機底部抽屜，用 Base UI Dialog：遮罩、focus trap、Esc）、
  `SideTabs` + `sideTabsFor(capabilities)`：結構永遠在；notes 開才有紀要；open_loops、parking 或任何 suggest 模式的 AI 功能開著才有待處理；
  只剩結構時沒有分頁列、改成標題「結構」；待處理數量常駐（含 0）；目前分頁被關掉時退回結構。
- demo：`frame/layout.ts` 的 `layoutFor(width, frame)`（有測試）——≥1280 三欄、1100–1279 圖示列 + 欄位側欄、1024–1099 圖示列 + 覆蓋側欄、
  768–1023 清單收成抽屜 + 覆蓋側欄、< 768 抽屜 + 底部抽屜、`?frame=embed` 無清單、大綱由頂端按鈕叫出蓋住對話、預設宿主主題。

### 5. 快捷鍵與 `CommandPalette`（`packages/react/src/shortcuts/`）
- `keys.ts`：`"Mod+Shift+S"` 字串格式；Mod 在 Apple 是 ⌘、其他是 Ctrl；修飾鍵要完全相符；`event.code` 後備，所以 Shift 或注音 / 其他鍵盤配置仍能對到；
  `isComposing`（含 React 合成事件的 `nativeEvent`）或 keyCode 229 時一律不觸發；顯示用 `⌘⇧S` / `Ctrl+Shift+S`。
- `commands.ts`：`shortcuts.md` 標「可用」的 10 個指令（id、名稱 key、預設按鍵、scope `global` / `composer`、是否列在面板）。
  `resolveBindings`：宿主覆寫優先、`null` 停用、宿主用到的鍵從預設指令拿走（衝突以宿主為準）、命令面板可以改鍵但不能停用、未知 id 忽略。
- `ShortcutsProvider`（`bindings`、`commands`、`platform`）：一個 window listener；元件用 `useCommand(id, handler)` 註冊動作；
  已被處理（defaultPrevented）的事件不碰；沒有 ⌘/Ctrl/Alt 的鍵不從輸入框觸發；在 dialog / menu / listbox 裡只有命令面板會觸發。
  `useShortcutMatcher` 給輸入框自己判斷 Enter / Shift+Enter；`useShortcutLabel` / `useShortcutText` / `<ShortcutKeys>` 顯示目前的鍵（停用就不顯示）。
- `CommandPalette`：⌘K / Ctrl+K 開關；combobox + listbox（`aria-activedescendant`）；↑↓ 循環、Enter 執行、Esc 關；多字詞比對名稱與 id；
  只列出有註冊動作的指令；關閉動畫結束後才執行，所以指令可以移動 focus 或開自己的對話框；組字中的 Enter 不執行。
- demo 的動作先接到 toast（「開支線：尚未接上（示範）」），側欄切換是真的。

### 6. `StatusBanner`
四種狀態：`reconnecting{attempt, nextRetryAt?}`、`aiError{attempt, maxAttempts, nextRetryAt, reason?}`（對應 DESIGN §12 的 `turn.retrying`）、
`readonly`、`limit{limit}`。文字照原型；有倒數時每秒更新，倒數到 0 換成「正在重試」。螢幕閱讀器只聽一次不含秒數的句子（倒數部分 `aria-hidden`）。
動作按鈕只在宿主給 `onAction` 時出現（重試 / 回顧開著的支線），唯讀沒有。demo 用 `?state=` 示範。

### 7. 全域樣式修正
- §2 #2：`[data-tg-root] pre { overflow-x: auto }`（基本層，不影響宿主頁面）。複製按鈕屬於程式碼區塊元件，留給 F1。
- §2 #3：`(hover: none)` 時 `.tg-kbd-hint` 隱藏；`Kbd hint`、`ShortcutKeys hint`、demo 輸入框提示與命令面板的按鍵都用它（e2e 在 375 觸控模擬下驗證）。

### 8. Mock 資料層（`@tangent/client/testing`）
- `createMockTangentClient(options)` 回傳的型別是 `TangentClient & { mock }`，介面與真 client 完全相同（typecheck 保證）。
  回應經過與真 client 相同的正規化函式（fixture 用 `fixture.line/message/branch/note/card/chapters` 從部分 JSON 補齊），錯誤是帶 domain code 的 `TangentError`。
- 事件：`subscribe()` 回報 connecting → open → closed；`sendMessage` 依 Engine 的順序發 `message.created`×2、`line.updated(thinking)`、
  一連串 `message.delta`、`message.updated(done)`、`line.updated(idle)`；`getStream` 回目前的 delta；`cancelTurn` 保留已串流的部分並標 cancelled。
  也模擬 createBranch、getBranch、startDraft（drafting → ready）、merge（父線新增 branch_card 訊息）、discard、紀要（新增 / 修改 / 取代，revision 遞增）、
  里程碑、刪除整棵樹、封存、已讀。`moveToBranch`、`promoteBranch` 回 `mock_unsupported`（501）；`compact` 只回 jobId。
- 狀態全部不可變更新；`seq` 全域遞增，排序一律用 seq。
- 情境一（`nasScenario()`）：原型的 NAS 對話（主線 #16–#40 的可見訊息、ZFS 結論卡、6 條支線含順口問、b3 的草稿卡、紀要 7 條含被取代的一條、4 個章節），
  另有大阪、Rust、OKR 三個對話與 2 個封存。所有功能開啟，AI 功能模式照原型設定頁。
- demo：`VITE_TANGENT_API=http` 用真 client（`/api`），其他（預設）用 mock（120ms 延遲）。
- 原本 client 內部的測試工具 `src/testing.ts` 改名 `src/test-helpers.ts`，讓出 `testing` 這個入口。

### 9. i18n
新增 `ui.*`、`sideTabs.*`、`sidePanel.*`、`banner.*`、`palette.*`、`command.*`（en、zh-TW），用語照 UI_DESIGN_BRIEF §3（紀要、待處理、支線、主線、停車）。
demo 的 `shell.*` 重寫（舊的分頁 key 刪掉）。網址可加 `?lang=zh-TW`。

### 10. E2E 與視覺檢查
`web/e2e`（`@tangent/e2e`）：Playwright + `@axe-core/playwright`，locale zh-TW、時區 Asia/Taipei。
每種寬度都檢查地標、主要互動（命令面板 → 切換側欄、Ctrl+. 、Ctrl+B 的 toast、420 大綱開關與 Esc、375 底部抽屜）與 axe，並存截圖。

## 截圖對照（`docs/devlog/screenshots/F0/`）

`prototype-*.png` 是原型同寬度同狀態的截圖，`demo-*.png` 是 e2e 產生的，`compare-*.png` 左右並排（1440 淺色、1440 深色 AI 錯誤、420 宿主、375）。

相符：三欄寬度（264 / 彈性 / 360）、52px 頂列與分頁列、閱讀寬度 46rem、清單底色與目前列、token 膠囊、分頁 2px 底線與待處理數量、
狀態列的顏色與文字、宿主主題的顏色與 Geist、輸入框的圓角與按鈕位置、手機的頂列與觸控尺寸、AI 文字用襯線字（宿主為無襯線）、中文用 Plex Sans TC。

差異（多數是範圍外）：
1. 訊息、大綱、紀要、目標膠囊、匯出列是 F1–F5 的內容，demo 以說明文字佔位。
2. 對話清單沒有「今天 / 本週」分組與搜尋結果（ConversationList 屬 F1）；1440 時清單標題列少了「收合清單」按鈕（只在圖示列展開時出現）。
3. 搜尋框的按鍵提示畫成兩個 `Kbd`（Ctrl、K），原型是無框的「⌘K」文字。
4. 輸入框的鍵盤提示在 demo 靠右，原型緊接在 placeholder 後。
5. 側欄切換按鈕開著時有 pressed 底色（原型沒有）。
6. 手機頂列多一個開對話清單的按鈕（原型手機沒有切換對話的入口）。
7. 時間顯示：今天以外 demo 顯示日期，原型顯示「週二」。

## 與設計的差異、決定

- **基本樣式只套在 `[data-tg-root]` 內、放在 `@layer base`**：tokens.css 的 `* {box-sizing}`、`body {margin}`、全域 `:focus-visible`、`a`、`::selection`
  不能直接進可嵌入的套件（會改到宿主頁面），改成在 `TangentRoot` 範圍內生效。
- **`--tg-subtle` 只能用在 background / surface / sunken / raised**：深色下在 `--tg-accent` 上只有 4.17:1、在 `--tg-primary-soft` 上 3.44:1（淺色 4.38 / 4.47）。
  axe 在 demo 選取列的時間抓到這點。沒有改 token 值（工作單要求保留），改成規則：accent 與 `*-soft` 底色上用 `--tg-muted`（三套主題都 ≥ 4.7:1），已寫進 styles.css 註解並有測試。F1 起的 hover / 選取列請遵守。
- 次要按鈕邊框維持 `--tg-border-strong`（有文字標籤，不靠邊框辨識）；只有表單控制項用 `--tg-border-input`。
- destructive 按鈕用 soft 底 + destructive 字與框（hover 反轉），因為宿主主題沒有能在 `#f87171` 上達 4.5:1 的前景 token。
- Noto Sans TC 只帶 400（Plex Sans TC 已有需要的字重，Noto 只補缺字）；不帶斜體。
- 375 手機的命令面板與對話框全螢幕；420 嵌入的對話框也全螢幕（< 640px 規則）。
- 快捷鍵：沒有修飾鍵的指令（Esc 回上一層）不從輸入框觸發；F1 的「串流中 Esc 停止回覆」應由輸入框用 `useShortcutMatcher` 自己處理。
- 停用（`null`）只關鍵盤，指令仍在命令面板裡可執行。

## 留給 F1 的問題

1. **`turn.retrying` 事件**還不在 `TangentEventDataMap`（events.ts）；B4 定案後加入，`StatusBanner` 的 `aiError` 已照它的欄位設計。
2. **Line 的累計 token / 費用**（DESIGN §12 已決定保留）不在 `LineView` 型別，demo 的「38k token」是寫死的佔位；C1 的契約樣本要帶這些欄位。
3. **「待處理」數量**目前是 demo 常數 6；來源（open_loops、停車場、建議匣）在 B8 / B9，前端要一個彙總 API 還是自己加總？
4. **用語**：zh-TW 既有的 `branch.errorNoteLimit` 寫「筆記」（W0 依 DESIGN §2），新元件照 UI_DESIGN_BRIEF §3 用「紀要」。要統一成哪一個？
5. 手機上切換對話的入口：原型沒有，demo 先放清單按鈕；F1 做 ConversationList 時請設計確認。
6. mock 的 `listBranches` 回傳整棵樹的支線（不只直接子支線）；真 API 的範圍要在 C1 確認。
7. 程式碼區塊的複製按鈕（審查 §2 #2 後半）留給 F1 的 Markdown 元件。
8. 字體 CSS 約 67 kB gzip（render-blocking），主要是三個中文家族的切片範圍；若嫌大，可以考慮宿主只載 Plex Sans TC、拿掉 Noto Sans TC 後備。

## Review fixes（2026-10-15，F0 已提交為 06c1c35 之後）

依 typescript-reviewer 的意見與 DESIGN §12 的 F0 決定修正，每一項都有回歸測試（能測的）。未 commit。

### 閘門

| 檢查 | 結果 |
|---|---|
| `pnpm -C web install` / `typecheck` | 通過（fonts、client、react、demo、e2e 五個專案） |
| `pnpm -C web test` | 通過：fonts 9、client 236、react 157、demo 11，共 413 個（修正前 363） |
| `pnpm -C web build` | 通過。**render-blocking CSS：85.2 kB → 48.4 kB gzip**（Tailwind + `latin.css` + `serif.css`）；`tc.css` 70.9 kB 與 `host.css` 0.4 kB 改成按需載入的獨立樣式表。主 JS 145.7 → 138.3 kB gzip（mock 13.3 kB、元件總覽 34.1 kB 拆成動態載入的 chunk） |
| `pnpm -C web e2e` | 通過：9 個（原 5 個 + 「C2 之前沒有待處理」+ 元件總覽在淺色 / 深色 / 宿主三套主題各一） |

### HIGH

- **H1 樣式外洩**：`styles.css` 的每條規則都改在 `[data-tg-root]` 之下（token、color-scheme、密度、觸控與減少動態的 media 規則、`.tg-kbd-hint`、`.tg-shimmer`）；
  屬性改名 `data-tg-theme`、`data-tg-density`；拿掉 `:root` 後備（彈出層都 portal 在 root 裡）。全域只剩 `tg-*` keyframes 與 Tailwind `@theme`。
  測試：解析 styles.css，所有 style rule 的每個 selector 都以 `[data-tg-root]` 開頭；不得出現 `:root`、`[data-theme`、`[data-density`。
- **H2 其他鍵盤配置被劫持**：字母與數字只比對 `key`；`code` 只在 `key` 是非拉丁字元（注音、俄文、macOS Alt 符號）或標點被 Shift / Alt 改掉時才用。
  測試：Dvorak（Ctrl+X 不觸發 branch.open、Ctrl+B 在 QWERTY N 位置觸發）、Colemak、注音、俄文、Mod+Alt、Shift 改過的 `{`、另一個拉丁配置的 `/`。
- **H3 監聽在 window**：`ShortcutsProvider` 預設監聽所在 `TangentRoot` 的元素（`useTangentRootElement()`），只有焦點在 root 內才觸發；
  `target="window"` 為選用（demo 是整頁 app，用它）。測試：root 外的按鍵不觸發、兩個嵌入實例只觸發一個、window 模式、卸載後移除監聽。

### MEDIUM

- **M4** 命令面板的鍵不會被搶：其他指令的覆寫若用到面板的鍵（預設或改過的）就作廢並警告。
- **M5** 綁定字串錯誤不再在 render 時丟例外：`resolveBindings(commands, overrides, warn)` 回報並略過（保留預設）；未知 id、兩個覆寫用同一組鍵（先到先得）也會警告。
  警告走 `ShortcutsProvider onWarning`，預設 `console.warn`。**差異**：沒有做「只在 dev 警告」——函式庫不能可靠判斷 dev（不用 `process.env`），而警告只在宿主設定錯誤時出現，所以一律送出，宿主可用 `onWarning` 關掉。
- **M6** Esc 只有一個擁有者：provider 依優先序處理 Esc（`useEscapeLayer`，overlay 200 > panel 100，同級後註冊的先），沒有圖層才輪到 `nav.back`；
  dialog / menu 內的 Esc 由 Base UI 處理。`SidePanel` overlay 改用圖層（沒有 provider 時退回 panel 內的 Esc）。
- **M7** overlay 側欄關閉時把焦點還給打開它的元素（焦點原本在側欄內或已遺失時）。
- **M8** context 變動：處理器改放 `registry.ts`（每個 id 一個堆疊；可用 id 的 Set 沒變就回同一個物件，只在變時通知）；context 拆成 state 與 actions（actions 永遠穩定，`useCommand` 不會因 state 重繪）；
  可用指令用 `useSyncExternalStore` 讀；行內的 `bindings` / `commands` 用 `useShallowStable`（移到 `lib/`，與 `TangentProvider` 共用）。
- **M9** 嵌入時的彈出層：root 加 `isolation: isolate`；portal 容器改成延遲建立的元素，由 root 的第一個子元素的 ref 掛上（早於任何子元件的 layout effect），
  所以第一次 commit 就 `defaultOpen` 的對話框也在 root 裡（測試）。限制（祖先有 transform / filter / contain / will-change 時，fixed 定位的彈出層以該祖先為基準）寫在下方與 `packages/react/README.md`。
- **M10** 鍵盤高亮：Menu、Select、命令面板的高亮列除了 accent 底色，再加 3px `--tg-ring` 左側標記；ring 對 accent 與 raised 都 ≥ 3:1（淺色 3.06、深色 10.2、宿主 8.4，有測試）。
- **M11** `StatusBanner`：兩個 live region（polite `role=status`、assertive `role=alert`）不論狀態都常駐，只換文字；`aiError` 進 alert，其他進 status；`state={null}` 時不顯示橫條但 region 仍在。
  可見的橫條改用 `data-tg-banner`（e2e 用它）。
- **M12** `Checkbox`：`before:` 偽元素做出 `--tg-hit-target` 大小的點擊區（桌機 32px、觸控 44px），方框仍是 16px。
- **M13** 字體改成獨立套件 **`@tangent/fonts`**（`web/packages/fonts`）：`latin.css`（Plex Sans / Mono）、`tc.css`（Plex Sans TC + Noto Sans TC 後備）、`serif.css`（Source Serif 4 + Noto Serif TC）、`host.css`（Geist）。
  `@tangent/react` 不再依賴任何字體套件（測試）。`scripts/build.mjs [outDir]` 讀每個字體套件的 `license` 欄位與 LICENSE 開頭的版權行，產生 `NOTICES`。
  測試：重新產生到暫存目錄並與提交的檔案逐字比對；每個 url 都解析到存在的 woff2；字重、swap、unicode-range、中文切片、NOTICES 內容。
  demo 的載入方式（`apps/demo/src/frame/fonts.ts`）：`latin.css`、`serif.css` 直接匯入；`tc.css` 在語系是中文時立刻、否則在頁面第一次出現中日韓字元時（MutationObserver，觸發後就斷開）以動態 `import()` 載入；
  宿主主題才載 `host.css`。e2e 檢查 zh-TW 下 Plex Sans TC 確實載入（`document.fonts.check`）。

### LOW

- `@tangent/react`、`@tangent/fonts` 的 package.json 加 `"sideEffects": ["*.css"]`（測試）。
- 平台偵測改用 `useSyncExternalStore`，server snapshot 為 `false`（非 Apple），hydration 後才換成真值。
- 按住不放的重複 keydown（`event.repeat`）只 preventDefault、不執行，切換類指令不會閃（測試）。
- 瀏覽器保留的組合（Firefox：Ctrl+Shift+P 無痕視窗、Ctrl+Shift+M 響應式設計模式、Ctrl+Shift+S 截圖；⌘[ 上一頁、Ctrl+B 書籤側欄）寫在 `packages/react/README.md` 的快捷鍵段落；宿主可用 `bindings` 改鍵，命令面板永遠列出這些指令。
- 命令面板：重新打開時清掉殘留的待執行指令；高亮列自動捲進可見範圍。
- `ref.current = handler` 改在 layout effect 裡更新（`useCommand`、`useEscapeLayer`、`onWarning`）；SidePanel 不再在 render 裡寫 ref。
- `useNow` 依 `state.kind` 與 `nextRetryAt`，不再依整個 state 物件。
- SidePanel 的後備 Esc 用共用的 `isComposing()`（含 keyCode 229）。
- 手機底部抽屜加上看得到的關閉按鈕（測試、e2e）；`SideTabs` 用 `isSideTabId` 驗證 Base UI 回傳的值，不再轉型。
- 同一 id 重複註冊：後註冊的生效，卸載後恢復前一個（測試）。
- demo：mock client 只在 mock 模式以動態 import 載入；字體 preload 外掛依 Vite 的 `base` 產生路徑；元件總覽（`?view=gallery`）也是動態載入。
- mock 與真 client 對齊：尊重 `signal`（latency 前或期間中止都回 `AbortError`，中止的寫入不會執行）；回傳 `structuredClone`；
  經過與真 client 相同的正規化函式；`updateLine` / `updateNote` 去掉值為 `undefined` 的欄位；`dispose()` 也取消還在等 latency 的請求（測試）。

### 測試補強

- 快捷鍵：焦點在輸入框時（⌘/Ctrl 組合會觸發、純按鍵不會、組字中不會）、在 dialog 內只有面板會觸發、`composer` scope 不被全域監聽、卸載移除監聽、面板鍵衝突、非拉丁鍵盤配置、重複鍵、Esc 圖層。
- 焦點歸還：Popover、Menu（選取後與 Esc 後）、命令面板、SidePanel overlay；e2e 也檢查 Dialog、Menu。
- StatusBanner 的 live region 常駐與換字。
- e2e 只有在 `UPDATE_SCREENSHOTS=1` 時才寫 `docs/devlog/screenshots/F0/`；一般執行不碰 docs。
- e2e 新增元件總覽頁（`?view=gallery`）：在三套主題下打開 Dialog、Menu、Popover、Select 各跑一次 axe，套件元件以 moderate 以上即失敗（demo 外框仍是 serious 以上）。
- token guard 也掃 styles.css：token 宣告以外的宣告不得有寫死的顏色。

### DESIGN §12（F0 列）的落實

- `LineView.usage{inputTokens, outputTokens, costUsd}`（暫定，C1 前以 0 補）：型別、正規化、SSE 測試；mock 每條對話帶用量，回合完成時累加；
  新增套件元件 **`UsageMeter`**（h28 膠囊、只顯示 token，`38k token`；有 `onClick` 時是按鈕，開送出前預覽），demo 頂列改用它，不再寫死。
- `turn.retrying{turnId, attempt, maxAttempts, nextRetryAt}` 加進事件型別與正規化（`TurnRetrying`）。
- 「待處理」只在 P1 功能（parking、open_loops、或任何 suggest 模式的 AI 功能 = 建議匣）開啟時出現：邏輯本來就如此，註解改寫；
  mock 新增功能組 `nasScenario({ features: "all" | "c1" | "core" })`，`c1`（C2 之前：notes、chapters、aside、summary、card_draft）沒有待處理；
  client 測試與 e2e（`?features=c1`）兩種情況都驗證。
- zh-TW 的「筆記」全部改成「紀要」（`branch.errorNoteLimit`），i18n 測試禁止再出現「筆記」。
- 手機切換對話：頂端左側的選單鈕打開清單抽屜，維持原實作。
- `/branches` 回整棵樹：mock 原本就是。

### 截圖

`UPDATE_SCREENSHOTS=1 pnpm -C web e2e` 重新產生 demo 截圖並更新 `compare-*.png`。變化：頂列的 token 膠囊來自 `usage`；420 宿主主題的全形標點正確
（Geist 有 Latin range 後，「；」交給中文字體）；手機底部抽屜有關閉鈕。其他對照結論同上。

### 其他

- 在搬移字體腳本時我執行了 `git reset -q`（整個 index），目的是取消 `git mv` 造成的暫存；如果另一個 agent 當時有已暫存（staged）的變更，會被取消暫存（工作目錄內容不受影響）。
