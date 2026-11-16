# F12 · 深度閱讀與多支線探索打磨（設計稿 S1～S7）

> 2026-10-30。工單（已歸檔），設計交付包。基線 `main` @ `ae6b12b`（已含後端 B17，見 `docs/devlog/B17-dismiss-all-card-edit.md`）。
> 純前端，只改 `web/`；沒有改 Go、schema 或 migration。在獨立 worktree（`../tangent-f12`，分支 `f12`）由一個實作 agent 完成（中途碰到用量上限，重置後接著做），協調者驗證、另開唯讀 TypeScript 審查 agent，兩輪修正後合併。
> 沒有碰 宿主；開發期間沒有動 :8120、:5183；沒有呼叫付費模型。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 5 個專案全部通過 |
| vitest（逐一套件） | fonts **10**、client **977**、react **984**、demo **189**（開工時 10、954＋5 個失敗、964、186） |
| `pnpm -C web build` | 通過。主 JS **約 161.7 kB gzip**（開工時 151.74，上限 172） |
| Playwright `e2e:mock --workers=4` | **148 passed、3 skipped、0 failed**（新增 `f12.spec.ts` 4 個測試） |
| client 契約測試 | B17 兩份樣本的 `no client call` 2 筆與 mock 契約 3 筆，開工時失敗，現在全過 |

client 開工時的 5 個失敗都是 B17 先合併留下的：`contract.test.ts` 找不到兩條新路由的 client 呼叫，`mock-contract.test.ts` 的 mock 也還沒實作。

## 做了什麼

### §1 對接 B17（`@tangent/client`、mock、hooks）
- `b17-routes.ts`：`dismissAllSuggestions(lineId)`（不送本文）、`updateBranchCard(lineId, {card})`。合併時的卡片本文抽成 `cardRequestBody`，merge 與編輯共用。
- `classifyCardEditError`：`invalid_card`（帶 `problems`）、`parent_busy`、`parent_closed`、`archived`、`branch_closed`，對話框各有友善訊息，失敗時表單內容保留。
- `canAnchorBranch`：`done` 的 user / assistant 訊息，或 `kind: "branch_card"` 的卡片，和後端 `domain.CanAnchorBranch` 一致。卡片仍是 `data-forkable=false`，在卡片裡選字不會開支線。
- mock：dismiss-all（一則 `line.updated`）；卡片編輯照 B17 的拒絕條件與事件順序（`message.updated` → `branch.changed{merged}` → `leaf.changed`）並移除 `delivered`；卡片當錨點時背景包最後引用那張卡。
- hooks：`useDismissAllSuggestions`、`useUpdateBranchCard`、`useCardEdits`。

### S1 順口問原地展開
- 秒問解釋、ForkMarker 的順口問列、順口問的字詞錨點，都在該則訊息下方插入 `AsideInlineCard`，不離開主線；使用者訊息也可以。
- 回答中有串流與「停止生成」，完成後收尾列「記進紀要」「記成備忘」按下變成已完成狀態、不會重複存；失敗顯示「重試」；已清除的順口問顯示清除後的文字。
- Esc 收合；只有刻意打開的才搶焦點。ForkMarker 列標「原地展開中」或「已回答・在這裡展開」，順口問另外計數「n 則順口問」。

### S2 已開支線的字詞錨點
- rehype 步驟（`markdown/marks.ts`）依支線 `excerpt` 標記內文，跳過 code、pre、連結、數學；長的先標，已標過的不重疊；串流中不標。
- 底線顏色看最新那條支線的狀態；同一段字有 2 條以上加數字。
- 桌面：滑過 300ms 或鍵盤 focus 立即顯示預覽；觸控：先開底部預覽表。預覽用 portal 加 fixed 定位，下方放不下就翻到上方。
- 已知限制：同一段字出現多次時只標第一次；跨粗體或段落的 excerpt 不標。

### S3 側欄寬度與地圖自動符合
- `SidePanelResizer`：拖拉、←/→ 16px、Shift 64px、Home/End、Enter 與雙擊重設 360；範圍 `280 ~ min(600, 視窗寬 − 清單寬 − 480)`。寬度存 `localStorage`（try/catch、延遲寫入）。
- `BranchMap` 第一次打開時寬或高超出就縮放置中（最低 50%），工具列顯示「初次打開，已自動符合」；手動縮放或平移後不再自動重設（專注模式不做）。

### S4 慢速回覆
- 階段膠囊：未滿 3 秒、3 到未滿 8 秒、8 秒起，從送出起算，第一個字出來就消失；螢幕閱讀器只念階段變化。
- 「停止生成」出字前在 AI 標籤列，串流後移到文字下方；出字前就停止顯示「已停止・沒有回答」（伺服器對取消的回合回 `nothing_to_retry`，所以沒有「重試」）。
- `BackgroundReplyToast` 只在一般模式、同一棵樹的其他線答完時出現，原地展開的順口問不算；多條合併為「「{title}」等 {n} 條」（數不重複的線），6 秒、滑過或 focus 暫停；失敗另外一則。

### S5 待處理
- 頂部單選膠囊「全部｜停車種子 (n)｜AI 建議 (n)」（兩個功能都開時才顯示），選擇存 sessionStorage，換對話重設。
- 「忽略全部」→「忽略中…」→ 列表上方暫留「已忽略 n 條 AI 建議」5 秒；忽略 0 條不顯示；這 5 秒內新來的建議照常顯示在下面。

### S6 結論卡編輯與繼續追問
- 可寫入時才顯示「編輯結論」「繼續追問」；「編輯結論」只在支線仍是已帶回時出現。
- `BranchCardEditDialog`：寬 600、focus 在結論、驗證、沒有實質變更（含只改空白）時「儲存」停用。
- 「繼續追問」以卡片訊息為錨點打開 `OpenBranchDialog`，顯示「會從主線這張結論卡開一條新支線；「{title}」維持已帶回。」，引用結論；快選晶片是 4 個通用句型加每一項 `openItems`，預選第一項。不另送 excerpt，因為卡片已在背景包裡。建好後卡片下方的 ForkMarker 顯示「從這張結論卡追問」。

### S7 頂列 Token 膠囊
- `UsageMeter` 改成可按的按鈕（Gauge、ChevronDown、`aria-pressed`）；下一輪預算的 80% 用 warning 加 TriangleAlert、95% 用 destructive。
- Tooltip「查看上下文組成與 Token 明細（⌘⇧P）」，Firefox 改提示命令面板 ⌘K；Tooltip 延遲載入，Base UI 不進主程式。
- 點了打開延遲載入的 `UsageBreakdown`（窄螢幕是底部表）：各部分 token 長條、總量／預算／百分比、模型、「送出前預覽完整內容」。⌘⇧P 仍直接開完整預覽。

### i18n
- 設計稿約 50 條用語加進中英文字典；場景元件延遲載入的放在 `f12-messages.ts`、`f12-shell-messages.ts`。
- 全部用 lucide 圖示，沒有系統表情符號。

## 和工單不同的地方

1. **「已修改・下一輪帶入」只看這個瀏覽器實際看到的編輯。** B17 沒有存編輯時間，只是拿掉 `delivered`；剛帶回還沒送達的卡也是同樣狀態。所以只有「自己存的」或「收到內容和快取不同的 `message.updated`」才算編輯過，記在 `localStorage`（`tangent:card-edits:v2`），其他分頁透過 `storage` 事件同步。
   - 第一版還用「卡片之後已經有完成的回覆、卡片卻仍未送達」推測編輯過。審查指出伺服器每輪最多帶 `NoticeMaxPerTurn`（預設 10）張卡，一次帶回 12 條時第 11、12 張會被誤標，所以拿掉了。
   - 限制：在別的裝置、或這個頁面關著時改的卡，這裡不知道。
2. **「前提已更新」（#6）不比時間，比 id。** 看到編輯時，把當下大綱裡從這張卡開出的追問支線 id 記下來（`before`）；只有這些支線會標記。不用客戶端時鐘去比伺服器時間。標記的是進行中與已帶回的追問，捨棄與升級的不標（沿用 F8 規則）。每次編輯編號遞增，關掉標記後再編輯會重新出現。
3. **⌘⇧P** 仍開完整的送出前預覽；按 Token 膠囊才開明細面板。
4. **Token 膠囊的數字**仍是這條線的累計用量（意思沒變）；80%／95% 的警示來自背景 `POST /preview`（空草稿，不呼叫模型）跟 `budget.total` 比。回合進行中不打，`staleTime` 60 秒。
5. **收尾與卡片**：使用者自己寫過的收尾在編輯卡片後保留（B17 的行為），卡片上另外顯示自己的結論行，讓編輯看得出來。
6. 工單寫的卡片長度（問題 ≤ 500、結論 ≤ 1000）和伺服器不同；實際照伺服器的每欄 2000 字。

## 審查與修正

唯讀 TypeScript 審查 agent：沒有 CRITICAL。修掉的：
- HIGH：上面第 1 點的誤標。
- MEDIUM：客戶端時鐘比伺服器時間（改成比 id）、追問支線沒有依狀態過濾、其他分頁不同步、只改空白也能儲存、Token 膠囊的背景預覽打太頻繁。
- LOW：忽略 0 條的列、暫留期間新建議被蓋掉、通知「等 n 條」重複計數。

協調者看截圖後再修兩個畫面問題：
- 背景回答通知和一般通知疊在同一個位置、文字重疊 → 兩者放進同一個底部容器，上下排列、間距 8px。
- 字詞預覽卡被裁掉下半 → 訊息列有 `content-visibility:auto`，絕對定位的預覽被裁切；改成 portal 加 fixed 定位，放不下就翻到上方。

留著的 LOW：順口問卡片「已記過」用模組層級的 map；`shell.tsx` 的清單寬度 264／56 寫死；待解問題輸入框用 index 當 key；卡片沒載入時 `cardEdit` 流程不做事。

## 建議的後續（需要改後端）

> 已在 B17.1 完成（`docs/devlog/B17.1-card-edited-at.md`）：上面「和工單不同」第 1、2 點的 `localStorage` 紀錄與 id 比對都已拿掉，改看伺服器的 `editedAt` / `cardEditedAt`。

讓「已修改」與「前提已更新」跨裝置、重新整理後仍正確：在 `branch_card` 訊息加 `meta.editedAt`（或 `BranchView.cardEditedAt`），追問支線在 `editedAt > branch.createdAt` 時就是前提已更新，前端可以拿掉 `localStorage` 的紀錄。

## 截圖

`docs/devlog/screenshots/F12/`（`UPDATE_SCREENSHOTS=1` 跑 `f12.spec.ts` 產生）：
- `aside-inline-1440.png`：S1 順口問原地展開與收尾列
- `excerpt-preview-1440.png`：S2 字詞錨點預覽
- `side-resize-480-1440.png`、`map-auto-fit-1440.png`：S3
- `reply-stage-1440.png`：S4 階段膠囊
- `inbox-filter-1440.png`：S5
- `card-edit-1440.png`、`card-follow-up-1440.png`、`card-forks-1440.png`：S6
- `usage-breakdown-1440.png`：S7
