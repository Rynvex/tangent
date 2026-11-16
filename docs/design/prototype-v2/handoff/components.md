# 元件規格

- **套件**：`@tangent/react`，會嵌進宿主 app，只能用 `--tg-*` token。
- **demo**：只在 Tangent 自己的 app 使用。
- 間距以 4px 為單位。視覺參考：`Tangent 元件規格.dc.html`。

## 通用狀態

| 狀態 | 規則 |
|---|---|
| 一般 | — |
| hover | 次要按鈕底色換 `--tg-surface-raised`；ghost 換 `--tg-accent`；主按鈕換 `--tg-primary-hover` |
| focus | 一律 2px `--tg-ring` 外框，offset 2px（`:focus-visible`） |
| 選取 | ghost 用 `--tg-primary-soft` 底 + `--tg-primary-text` 字；分頁用 2px 底線 |
| 停用 | 45% 不透明，移除 hover，`aria-disabled` |
| 錯誤 | 只用在破壞性動作與表單驗證：`--tg-destructive` / `--tg-destructive-soft` |
| 載入中 | 保留寬度，文字換「處理中…」或骨架（`tg-shimmer`）；減少動態效果時不動 |

## 元件清單

| 元件 | 程式名稱 | 歸屬 | 尺寸 | 間距 | 狀態 | 畫面 |
|---|---|---|---|---|---|---|
| 路徑麵包屑 | `Breadcrumb` | 套件 | h30・每段 max 320（嵌入 170、手機 120） | 段內 8／段間 2 | 一般、hover、目前頁、截斷 | A2 A4 |
| token 計量膠囊 | `UsageMeter` | 套件 | h28・r full | x10 | 一般、hover；只顯示 token | A11 |
| 訊息：使用者 | `UserMessage` | 套件 | max-w 86%・r lg（右上 sm） | p 10/14 | 一般、hover（動作）、高亮、論證標籤 | A2 D2 |
| 訊息：AI | `AssistantMessage` | 套件 | 閱讀寬 46rem・serif 17/1.75 | 區塊間 12 | 串流中、完成、已停止、錯誤、高亮、論證標籤 | A2 D2 |
| 訊息動作列 | `MessageActions` | 套件 | h28 按鈕 | gap 2 | hover／focus 才顯示；唯讀隱藏；容器 ≤ 480 只剩圖示 | A2 |
| 分岔點膠囊 | `ForkMarker` | 套件 | h28・r full | x 6/10 | 收合、展開、hover、有未讀 | A2 |
| 結論卡（主線） | `BranchCard` | 套件 | r lg・`--tg-card` | p 14 | 摺疊、展開、待告訴 AI、需要你決定、高亮 | A5 |
| 結論卡審閱 | `BranchCardReview` | 套件 | w 760（手機全螢幕） | 欄間 18 | 起草中、草稿、空白（失敗）、主線已往前、結論缺漏 | A5 |
| 支線條 | `BranchBar` | 套件 | 最小 h 88 | p 10/14 | 進行中、唯讀結果、樹平衡、背景展開、已獨立、分岔點預覽浮層、順口問保存列 | A4 B4 |
| 分岔點預覽浮層 | `ForkPeek` | 套件 | max-w 560・shadow-overlay | p 10/12 | 開、關；分岔點那則用 `--tg-highlight` 底 | A4 |
| 輸入框 | `Composer` | 套件 | r lg・min h 88 | p 12/14 | 一般、focus、有輸入（估算）、超過費用門檻（警告色金額）、串流中、停用 | A2 A11 |
| 選取工具列 | `SelectionToolbar` | 套件 | h36・深色 | gap 2 | 桌機在選取上方；手機在下方 | A2 |
| 開支線表單 | `OpenBranchDialog` | 套件 | w 560 | 欄間 16 | 一般、目的空白、層數警告、達上限、分岔點已不在、同處滿 8 條、記憶提示 | A3 D1 |
| 支線種類選項 | `KindRadio` | 套件 | min w 150 | p 10/12 | 一般、hover、選取、focus | A3 |
| 大綱列 | `OutlineRow` | 套件 | min h 36・縮排 18/層 | p 7/10 | 一般、hover、你在這裡、未帶回、未讀、多選 | A8 C2 |
| 地圖 | `BranchMap` | 套件 | 節點 188×60 | 欄距 236・列距 78 | 縮放 50–160%、全幅、圖層；窄寬不提供 | A8 C1–C3 D2 |
| 收尾 | `Leaf` | 套件 | 一行・圖示 12 | gap 4 | 五種類型、草稿（虛線）、已確認 | B1 |
| 紀要條目 | `NoteItem` | 套件 | p 8/10 | gap 4 | 有效、完成、被取代、新、編輯中 | A9 |
| 跨對話記憶區 | `MemoryFooter` | 套件 | 虛線框 | p 10/12 | 有帶入、沒有帶入 | A9 D1 |
| 停車場種子 | `SeedCard` | 套件 | p 10 | gap 6 | 待處理、已展開、已記進紀要、已丟掉 | B3 |
| 建議卡 | `SuggestionCard` | 套件 | 虛線 `--tg-suggestion` | p 10 | 待決定、已接受、已忽略 | B5 |
| 側欄分頁 | `SideTabs` | 套件 | h52 | gap 4 | 3 頁／只剩結構時換成標題；待處理數量常駐 | §9-1 |
| 送出前預覽 | `TurnPreview` | 套件 | w 400 抽屜 | 列 h 40 | 收合、展開、魚眼程度標籤、記憶區塊 | A11 C1 D1 |
| 全域狀態列 | `StatusBanner` | 套件 | 全寬・p 10/16 | gap 10 | 重連、AI 錯誤（倒數重試）、唯讀、上限 | A14 |
| 記憶提示 | `MemoryRecall` | 套件 | 虛線卡 | p 12 | 提示、已帶入、已忽略 | D1 |
| 發散標記 | `DivergeMarker` | 套件 | 虛線 `--tg-primary` | p 12 | 3 條狀態、可收斂 | D3 |
| 比較表 | `CompareTable` | 套件 | 最小欄 120 | p 8/10 | 草稿、決定草稿、已確認 | D3 |
| 折疊區塊 | `FoldBlock` | 套件 | r・p 10/12 | gap 10 | 收合、展開原文 | D4 |
| 論證類型標籤 | `ArgTag` | 套件 | h22 select | — | 五種類型；AI 標、可改 | D2 |
| 命令面板 | `CommandPalette` | 套件 | w 560 | 列 p 9/10 | 搜尋、方向鍵選取 | — |
| 對話清單 | `ConversationList` | demo | w 264；圖示列 56 | 列 p 8/10 | 一般、目前、搜尋結果、空、載入中、封存 | A1 |
| 設定頁 | `SettingsDialog` | demo | w 600 | 列 h 44 | 主題、費用門檻、功能模式、宿主鎖定 | A13 |
| 回顧畫面 | `ReviewBoard` | demo | 4 欄卡片 | gap 12 | 有待辦、全部處理完 | C5 |
| 記憶庫頁 | `MemoryLibrary` | demo | 主欄＋側欄 | gap 16 | 篩選、被取代歷史 | D1 |

## 寬度規則

| 寬度 | 情境 | 規則 |
|---|---|---|
| ≥ 1280 | 完整 app | 三欄：清單 264、對話彈性（閱讀寬 46rem）、側欄 360 |
| 1100–1279 | 筆電 | 清單收成 56px 圖示列；側欄仍為欄位 |
| 1024–1099 | 平板橫向 | 圖示列；側欄改覆蓋式（右側、shadow-overlay） |
| 768 | 平板直向 | 清單收合；側欄覆蓋式；目標膠囊隱藏 |
| 420 | 嵌入宿主側欄 | 對話＋支線條；大綱由頂端按鈕叫出、蓋住對話；無地圖；宿主主題 |
| 375 | 手機 | 對話全螢幕；側欄是底部抽屜；對話框與審閱全螢幕；觸控 ≥ 44px；選取工具列在下方；無地圖 |
