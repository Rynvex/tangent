# F17 — 匯入 Step 2 心智圖工作區（心智圖畫布＋460 px 節點問答明細欄）

日期：2026-11-04　工單：已歸檔（工單 26；測試手冊 只差 §0.2.4.1 的措辭）　設計：Claude Design 2026-11-04

只改前端（`@tangent/client` 的純函式與 demo 延遲載入的 `import-dialog` chunk）。沒有 Go、DB、migration（仍 016）或 API 變更，沒有呼叫任何模型（測試只用 mock 的 `analyzeImportLocal`）。DESIGN／DECISIONS_LOG 沒有契約變動，所以沒改。

## 1. 做了什麼

### 階段一：`@tangent/client`（純、無頂層副作用，由 `index.ts` 匯出）

- [`import-mindmap-layout.ts`](../../web/packages/client/src/import-mindmap-layout.ts)：`MINDMAP_METRICS`（照工單的數字）、`buildImportMindMapLayout(input)`。
  - 由左到右：根節點（196 × 148，x 24）→ 章節（240 × 114，x 270，章節之間至少 96 的主幹線＋箭頭）→ 支線（252 × 140，x 600，上方 24 的分岔錨點膠囊，支線之間 36）→ 底部獨立泳道（≥ y 462，卡片 240 × 86，樹下兩欄、批次時三欄從 x 24 開始）。
  - 排法：每個章節的支線疊成一欄並以章節中心置中；章節只往下推，直到 (a) 離上一章節 ≥ 96、(b) 這一疊與上一疊之間 ≥ 36。所以任何輸入都不重疊（測試逐對檢查方框，含分岔膠囊）。根節點置中於第一與最後一個章節之間。
  - 連線：`root-to-chapter`（三次貝茲，控制點在 245）、`chapter-spine`（x 390，3px，附 `M 384 y-9 L 390 y L 396 y-9` 箭頭）、`chapter-to-branch`（控制點 555）。
  - 輪次膠囊 28 × 20、間距 4；**只有輪次不連續的章節**（#1 #3 #5）才有「跨段整合 N 輪」並右移 100（#8 #9 不算跨段，與設計稿 §2 一致）。放不下時最後一顆變成「+k」，被收起的輪次的座標落在「+k」上。
  - 掛載章節不存在或不是章節時，支線掛在它之前最近的章節，標 `orphan`。
- [`import-mindmap-trace.ts`](../../web/packages/client/src/import-mindmap-trace.ts)：穿插順序。範圍是所有「輪次不連續」節點的最小～最大輪（九輪範例是 #1→#6），只畫跨節點的相鄰兩輪；二次貝茲 `M ax ay Q cx cy ex ey`＋箭頭，彎曲量 `(i%2?-1:1)*(40+((i/2)%4)*16)`（決定 #8 的公式，但每 4 段重新開始，避免 60 輪時弧線大到 500px）。標籤先放在曲線中點，與已放的標籤的方框（48 × 24）相碰就沿法線兩側各推 8px（最多 8 次），還不行就往下推，保證終止；畫布高度會包進最低的標籤。
- [`import-mindmap-fork.ts`](../../web/packages/client/src/import-mindmap-fork.ts)：決定 #6。`reanchorFork(章節輪次, 原分岔輪)`＝章節裡在它之前的最後一輪，否則章節第一輪；`reanchorMovedForks(移動前, 移動後, 被移的單元, units)` 把「原本掛在被移走那一輪之後、移動後仍掛同一章節」的支線改掛，回傳被改的支線 key。
- [`import-mindmap-rounds.ts`](../../web/packages/client/src/import-mindmap-rounds.ts)：`extractSessionRounds(session, removed?)`，每輪的 `n`、時間（含使用者設的時間位移）、提問、回覆、訊息 id 與支線要掛的那一則（最後一則回覆）。
- [`import-mindmap-fixtures.ts`](../../web/packages/client/src/import-mindmap-fixtures.ts)：設計稿的九輪（散熱 #1 #3 #5、Firebase／Supabase #2 #6、水冷 #4、翻譯 #7、機殼風道 #8 #9），每則都有時間（台北 13:42～15:41）。`@tangent/client/testing` 也匯出。**這份文字是調過的，讓內建規則（`analyzeImportLocal`，與伺服器相同）真的分析出 §1 [#1,#3,#5]、支線 [#2,#6] 掛 §1 #1 後、支線 [#4] 掛 §1 #3 後、獨立 [#7]、§2 [#8,#9]**；`import-mindmap-layout.test.ts` 第一個測試直接驗證這個計畫，之後的測試與 UI 測試都用分析出來的計畫（沒有手寫的計畫）。設計稿原文的 #3 以「那…」開頭，會被當成延續而併進 Firebase，所以拿掉「那」；#9 加了「機殼」讓它和 #8 縫合。

### 階段二：demo（`web/apps/demo/src/frame/f14/`，全部在 `import-dialog` chunk）

- 對話框：第 2 步 `sm:max-w-[min(94vw,83.75rem)]! sm:h-[min(92dvh,52.5rem)]!`（1440 下是 1340 × 828，900 高的視窗放不下 840），第 1 步仍 880。
- [`view-switch.tsx`](../../web/apps/demo/src/frame/f14/view-switch.tsx)：AiTreeBar 第一列右側 `role="radiogroup" aria-label="檢視"`：「心智圖工作區」（`data-tg-view-mindmap`）｜「雙欄時間序清單」（`data-tg-view-list`），左右鍵切換；全幅鈕（`data-tg-mindmap-fullscreen`，Maximize2／Minimize2，名稱與 title 照設計稿，清單時停用）。**第 2 步預設仍是清單**；清單的結構欄頂端有「切換至心智圖工作區（檢視分岔位置與穿插順序）」入口（`MindMapEntry`），分析完成的摘要旁有「在心智圖工作區檢視這棵樹」。手機上切換鈕是「心智圖｜清單」兩格（44px），沒有全幅鈕。
- [`ai-tree-bar.tsx`](../../web/apps/demo/src/frame/f14/ai-tree-bar.tsx)：
  - 決定 #8：分析後又手動改過（`useAiTree().adjusted`：目前的排列和分析畫出的那份不是同一份 `order/edits/merges/mode`）再按「✨ 重新分析」，先出現「重新分析會取代目前的調整，確定重新分析？」＋「確定重新分析」（`data-tg-ai-confirm-reanalyze`，自動聚焦）／「取消」；取消或確定後焦點回分析鈕。「還原分析前狀態」一律回到第一次分析前（沿用 F16.2）。
  - 心智圖檢視時（桌面）AiTreeBar 收成一列：提示與說明只給讀屏，摘要與「由內建規則分析」同一行，畫布多 50px。
- [`mindmap-workspace.tsx`](../../web/apps/demo/src/frame/f14/mindmap-workspace.tsx)：畫布 flex＋明細欄固定 460（決定 #3）；全幅時收起明細欄（決定 #4），點任何節點（滑鼠或 Enter）就展開，方向鍵瀏覽不會展開。
- [`use-mindmap.ts`](../../web/apps/demo/src/frame/f14/use-mindmap.ts)＋[`mindmap-model.ts`](../../web/apps/demo/src/frame/f14/mindmap-model.ts)：心智圖只是同一個 assembly 的另一個檢視。模型從 `assembly.blueprint`、`byKey`、`orderedOriginal`、`merges` 與 `AiTreeView`（`unitsOfNode`、`planNodeOf`）讀出每個節點的角色、標題、時間、輪次 #n、掛載章節、分岔輪（分析後是全域 #n；分析前是章節自己的第 k 輪）、結論卡與理由。選取的節點換 key（移動輪次會改 key）時，跟著單元重疊最多的節點走。
- [`mindmap-canvas.tsx`](../../web/apps/demo/src/frame/f14/mindmap-canvas.tsx)、[`mindmap-node.tsx`](../../web/apps/demo/src/frame/f14/mindmap-node.tsx)、[`mindmap-controls.tsx`](../../web/apps/demo/src/frame/f14/mindmap-controls.tsx)：
  - `role="tree" aria-label="結構心智圖" data-tg-mindmap-canvas`，點陣背景，可捲動；縮放是單一 CSS `transform: scale()`（25%～200%，每次 ×1.25，`縮小`／百分比／`放大`／`置中適應`）。瀏覽器的命中測試跟著 transform，所以放置區在任何縮放都正確（e2e 在 80% 拖放）。
  - 根節點、章節、支線、獨立對話卡都是 `treeitem`（`aria-level` 1/2/3，roving tabindex，選取 `aria-selected`）；方向鍵上下依序、右到第一個子節點、左回父節點、Home／End，選取跟著焦點；Enter 把焦點移到明細欄標題。連線、膠囊、穿插標籤、放置區、泳道都是 `aria-hidden`，treeitem 裡沒有任何可聚焦的東西（axe 的 nested-interactive）。
  - 分岔錨點膠囊「自 §1 的 #3 後分岔」；`forkMoved` 時改警告色與 TriangleAlert，文字「分岔點已移動・自 §1 的 #1 後分岔」。
  - 左下圖例（開穿插時多「穿插順序」）；右下控制列：「顯示穿插順序 #a→#b」（`aria-pressed`；沒有穿插的輪次時 `aria-disabled` 並以 `aria-describedby` 說明「還沒有穿插的輪次：先用 AI 分析並拆解輪次。」）。開啟時主樹連線 35%，琥珀虛線箭頭＋「n→n+1」標籤，參與的輪次膠囊變警告色。
  - 全幅時右上提示膠囊「點一個節點，在右側看問答明細」。
- [`mindmap-drop.tsx`](../../web/apps/demo/src/frame/f14/mindmap-drop.tsx)（決定 #5、S5）：
  - 拖節點（沿用 F16.1 的 `AssemblyDnd`，所以放下的效果與清單完全相同）：章節上浮出 1fr 1fr 兩個放置區「掛在 §k 下當支線」（`data-tg-mindmap-drop-branch`）｜「合併進 §k」（`data-tg-mindmap-drop-merge`），泳道整片高亮「放到這裡：另存為獨立對話」。
  - 從明細欄拖單一輪：其他節點出現虛線外框與「將第 #n 輪併入此節點」（`data-tg-mindmap-drop-turn`），放開即 `moveUnit`；拖到泳道＝拆成獨立對話。
  - 鍵盤／不拖曳的對應：明細欄的四種角色、「掛載於」章節＋輪次、「合併進…」、每輪的「移至其他節點」（把手 focus 後 Enter／Space 也打開這個選單）。
- [`mindmap-inspector.tsx`](../../web/apps/demo/src/frame/f14/mindmap-inspector.tsx)、[`mindmap-turns.tsx`](../../web/apps/demo/src/frame/f14/mindmap-turns.tsx)（S4）：`<aside aria-label="節點問答明細" data-tg-mindmap-inspector>`。
  - 身分列（角色膠囊、時間・輪・則）、標題（h3）、角色 radiogroup「設為主幹 §｜掛為支線｜開放支線｜獨立對話」（桌面 4 欄、手機 2×2 每格 44px；唯一的章節不能改，說明「主線至少要有 1 個章節。」）。
  - 支線：「掛載於」章節選單＋「第 #n 輪之後」（只列那個章節的輪次）；分岔點被移動時顯示警告與「確認分岔點」。「合併進…」選單。
  - AI 歸納理由（suggestion 虛線框）、「主線留下的結論卡」（唯讀問題＋直接編輯的 textarea，空白時錯誤）、「包含的問答輪次 共 N 輪」：每輪一張卡，#n、時間、「移至其他節點」（桌面 popover、手機底部表「把第 #n 輪移到…」，每列 44px，含「拆成新支線」「拆成獨立對話」），內文「提問：」完整、「回覆：」桌面 3 行／手機 2 行與「展開完整回覆」。一次顯示 40 輪，「再顯示 n 輪」。
  - 選根節點時是主線的設定：組裝方式、時間穿插提示、主線標題／資料夾／標籤（清單右欄的那些，心智圖檢視也改得到）。
  - 手機開「顯示穿插順序」時，明細區改成「原對話的穿插順序」清單（[`mindmap-trace-list.tsx`](../../web/apps/demo/src/frame/f14/mindmap-trace-list.tsx)），點一列就選取那個節點。
- 決定 #6 的接法（[`use-ai-fine-tune.ts`](../../web/apps/demo/src/frame/f14/use-ai-fine-tune.ts)、[`ai-tree-plan.ts`](../../web/apps/demo/src/frame/f14/ai-tree-plan.ts)）：`movedPlan` 在 `moveUnitBetweenNodes` 之後跑 `reanchorMovedForks`；被改掛的支線記下它被放到的掛點，**只要它還是支線、還掛在那一點**就標 `forkMoved`。所以「確認分岔點」、改輪次、換章節、拖到別的章節、清單的選單、改角色，任何一種改法都會讓警告消失；狀態列也會說「支線「…」的分岔點已移動，改掛在 #n 之後；請在明細欄確認或重新指定。」清單檢視的各輪選單移動也一樣。
- 文案：[`f17-messages.ts`](../../web/apps/demo/src/frame/f14/f17-messages.ts)（zh-TW 與 en 各 97 個 key）。明細欄用「提問：」「回覆：」，沒有「問：」。

### 分析前、時間軸、批次與大量匯入

- **分析前**（任何模式）：每篇（或合併後的段落）就是一個節點，沒有 #n 膠囊，改顯示「9 輪・18 則」；明細欄列出該篇的每一輪（「第 k 輪」不能移動，提示要先分析拆輪），角色、掛載於（章節＋該章節的第 k 輪）、合併進、結論卡都能用。穿插順序鈕停用並說明。
- **時間軸**：全部是章節串在主幹上（加上獨立對話泳道）。
- **批次**：沒有主線，沒有根節點與連線，全部放在泳道，三欄，標題「批次匯入：每篇各自成為一條主線」；treeitem 都是 level 1。批次時沒有根節點可選，組裝方式要回清單改（見 §4）。
- **120 篇**（F16.1 的規模）：版面測試 120 個節點時間軸與樹都不重疊、< 500 ms；e2e 匯入 120 篇 Claude 對話，畫出 121 個 treeitem，置中適應到 25%，點最後一篇看到它的提問，整篇分析（120 個單元）後仍是 120 張卡、不重疊。

## 2. 和工單／設計稿不同的地方（與理由）

1. **對話框高度**：`sm:h-[min(92dvh,52.5rem)]!`，1440 × 900 下是 828 而不是 840（工單給的 class 本身就是這樣）。設計稿的 AiTreeBar 比我們的矮，所以心智圖檢視時把 AiTreeBar 收成一列。
2. **進入方式**：照 §0.2.4.1，第 2 步預設是清單（舊測試看的就是它），從檢視切換、清單頂端的入口或摘要旁的連結進入心智圖。分析完不會自動切到心智圖。手機上的「結構圖」分頁一樣先是清單，切到「心智圖」才是畫布＋明細。
3. **手機版排法**：設計稿的手機明細面板固定 300／380px，但我們的 AiTreeBar（含檢視切換）與底部三顆按鈕佔掉太多高度，固定高度會讓畫布剩 0。改成「結構圖」分頁整頁捲動：上方 44px 控制列（穿插順序、縮小、%、放大、置中適應），畫布 `clamp(13rem,45dvh,22rem)`，明細接在下面。手機一開始自動縮到整個寬度（約 41%）。
4. **根節點標題**：沒填主線標題時，根節點顯示第一個章節的標題（匯入時主線就會用這個名字），不是設計稿的原對話標題「電腦散熱與硬體維護雜談」；分析拆輪之後原對話標題已不在 assembly 裡。
5. **「跨段整合」只標在輪次不連續的章節**（§2 的 #8 #9 沒有），與設計稿一致；工單寫的是 `nTurns > 1`。
6. **彎曲量每 4 段重來**、標籤避讓用方框（48 × 24）而不是 28px 圓：工單說「例如」；方框保證「任兩個中心 ≥ 22px」，而且長標籤（「10→11」）也不會相碰。
7. **「拆成新支線」的選項沒有寫「（掛在 §1 #3 之後）」**：新支線掛在哪裡由 `moveUnitBetweenNodes` 的修補規則決定，選單上先算出來容易和實際不同，所以只寫「拆成新支線」。
8. **明細欄多了「合併進…」選單**：拖節點的「合併進 §k」需要不拖曳的對應。
9. **輪次的鍵盤拖放**：設計稿寫「Enter 拿起、方向鍵移動、Enter 放下」。這裡改成把手上按 Enter／Space 打開同一個「移至其他節點」選單，選單可以到任何節點與兩種拆出方式，比模擬拖曳簡單且可讀屏。
10. **拖曳影像**：用瀏覽器原生的拖曳影像，沒有做設計稿的傾斜卡片。
11. **工單 §4.2.3**（合併回 main、重新整理 :5183）依協調者指示沒做；沒有 commit。

## 3. 測試

- client `import-mindmap-layout.test.ts`（18 個）：九輪的內建分析結果、尺寸與欄位、不重疊、根節點置中、跨段整合膠囊與座標、三種連線的路徑、#1→#6 五條曲線與標籤、分岔輪被移走（往前一輪／章節第一輪／章節 key 改變／不是分岔輪時不動）、`reanchorFork`；30／41／52／60 輪 × 12 個種子的隨機穿插（不重疊、標籤中心 ≥ 22、方框不相碰、標籤在畫布內、膠囊在自己的卡片上）、「+k」、孤兒支線、批次、120 篇時間軸與樹、`extractSessionRounds`。
- demo `f17-mindmap.test.tsx`（15 個）：S1／S2（預設清單、切換、6 個 treeitem、根節點統計、膠囊、分岔膠囊、泳道、460 明細欄、全幅收合與點節點展開、回清單、清單入口與摘要連結、方向鍵／End／Enter、根節點的主線設定）；S3（穿插、分析前停用與說明）；S4（支線明細、掛載選單、理由、結論卡、提問／回覆、展開、改結論同步到畫布、改分岔輪、一鍵角色）；S5（選單移動、分岔點移動警告與確認、用換章節清掉警告、拖輪次到節點、拖節點到「合併進 §2」、拖到泳道）；決定 #8（沒改過直接重跑、改過先問、取消、確定、還原）；分析前、批次、手機（穿插清單、底部表）。
- e2e [`web/e2e/tests/f17.spec.ts`](../../web/e2e/tests/f17.spec.ts)（5 個，mock）：1440 的 1340 寬、畫布 880＋明細 460、6 張卡都在畫布寬度內且不重疊、axe（淺色）、穿插標籤中心距離 ≥ 22、全幅 1340、明細欄、拖輪次與 80% 下拖節點、分岔點移動、重新分析確認；深色主題的鍵盤操作與 axe；120 篇；375 的 axe、無水平捲動、穿插清單、底部表每列 ≥ 44px。
- 既有測試一行都沒改：`f14-dialog.test.tsx`、`f16-2-dialog.test.tsx`、`f14.spec.ts`、`f16-1.spec.ts`、`f16-2.spec.ts` 全過。
- 截圖 `docs/devlog/screenshots/F17/`：`mindmap-canvas-1440`、`mindmap-trace-1440`、`mindmap-full-1440`、`mindmap-branch-1440`、`mindmap-dropped-80-1440`、`mindmap-fork-moved-1440`、`mindmap-reanalyze-confirm-1440`、`mindmap-trace-dark-1440`、`mindmap-120-fit-1440`、`mindmap-375`、`mindmap-trace-list-375`、`mindmap-move-sheet-375`；設計稿對照 `design-ref-canvas-1440`、`design-ref-trace-1440`、`design-ref-move-sheet-375`（在 scratch 用 Chromium 開 `F17Frame.dc.html` 的 scene 截的，NAS 的檔案沒動）。

## 4. 留給下一步

- 批次模式沒有根節點，心智圖裡改不到組裝方式／資料夾／標籤，要回清單改。
- 選取跟隨用的是「選取當下」的單元，連續好幾次改 key 的移動後可能跟到別的節點（不會壞，只是選取跳走）。
- 拆輪的節點標題來自計畫（第一輪的提問），根節點沒有原對話的標題（§2 第 4 點）。
- 手機上 AiTreeBar 加上檢視切換約 170px 高，畫布在 812 高的手機上約 230px；要更大需要把 AiTreeBar 收進「結構圖」分頁（設計稿的做法），會動到 F16.2 的手機版面與測試，這次沒做。
- 只用合成資料（九輪範例、120 篇）測過，沒有用使用者真實的大檔在瀏覽器裡操作。

## 5. Code review（code-reviewer 子代理）

沒有 CRITICAL／HIGH。處理了：

- MEDIUM：`forkMoved` 只在三個地方清掉，拖到章節、清單選單等其他改法不會清 → 改成記下改掛的掛點，只在「還是支線且仍掛在那裡」時成立（§1 決定 #6 的接法）。
- MEDIUM：在心智圖拖節點會把清單裡看不到的勾選一起拖走 → 切到心智圖時清掉勾選。
- MEDIUM：重新分析確認取消後焦點掉到對話框 → 回到分析鈕。
- MEDIUM：心智圖檢視改不到組裝方式、標題、資料夾、標籤，也看不到上方提示 → 放到根節點的明細欄（批次見 §4）。
- LOW：標籤避讓改用方框並把畫布撐到最低的標籤；`id` 改用 `useId`；明細欄的輪次清單 `useMemo`；卸載時清掉拖曳計時器；方向鍵不再展開全幅；分岔警告不再是 `role="status"`（狀態列已經說過）。
- 沒處理：選取跟隨不回寫（§4）；檢視切換時清單欄的「改資料夾與標籤」展開狀態會重設（小事）。

## 6. 關卡（實作 agent）

| # | 關卡 | 結果 |
|---|---|---|
| 1 | `~/go/bin/sqlc diff && go vet ./... && test -z "$(gofmt -s -l .)"` | 無輸出（沒有 Go 變更） |
| 2 | `go test ./... -count=1` | 16 個套件 ok（`store/db` 沒有測試檔） |
| 3 | `TANGENT_SMOKE_PORT=8123 bash scripts/smoke.sh` | `SMOKE PASSED (929 events)` |
| 4 | `pnpm -C web typecheck` | 5 個專案通過 |
| 5 | vitest（各套件分開，`--maxWorkers=2`） | fonts 10、client 1,247（+18）、react 1,028、demo 259（+15） |
| 6 | `pnpm -C web build`，主入口 gzip | `assets/index-D2CBv4VU.js` = **169,140 B**（`gzip -c`；上限 172,000；之前 169,143）；`import-dialog` chunk gzip 80.5 kB（之前 62.4） |
| 7 | `E2E_ONLY=mock pnpm -C web/e2e e2e:mock --workers=2` | 第一次完整跑：169 通過、2 失敗、3 跳過（9.3 分鐘，load average 約 3～4）。失敗的是 `f5.spec.ts` 375「pin by touch…」（等「已釘選」逾時）與 `screens.spec.ts` 1440「table, code, card…」（等送出前預覽的「規則」鈕逾時），都是對話流程、本步沒有改到。這兩個檔單獨重跑：15 通過（48.6 秒）。`f14`、`f16-1`、`f16-2`、`f17`（5 個）在完整跑時都通過 |

## 7. 協調者驗收

2026-11-04，協調者在實作 agent 的 worktree 重跑全部關卡並在瀏覽器實測，通過後合併。

**關卡**

| # | 關卡 | 結果 |
|---|---|---|
| 1 | sqlc diff、go vet、gofmt -s -l | 無輸出 |
| 2 | `go test ./... -count=1` | 16 個套件 ok |
| 3 | `TANGENT_SMOKE_PORT=8123 bash scripts/smoke.sh` | `SMOKE PASSED (929 events)` |
| 4 | `pnpm -C web typecheck` | 5 個專案通過 |
| 5 | vitest（各套件分開） | fonts 10、client 1,247、react 1,028、demo 259 |
| 6 | build，主入口 gzip | `index-D2CBv4VU.js` **169,140 B**（上限 172,000） |
| 7 | 完整 mock e2e | 169 通過、2 失敗、3 跳過（10.2 分鐘，與下面的實測同時跑）。失敗的是 `f8.spec.ts`「修改並分岔」與 `smoke.spec.ts` 元件庫深色 axe，都和本步無關；這兩個檔單獨重跑 25 通過。`f14`、`f16-1`、`f16-2`、`f17` 全過 |

既有測試 `f14-dialog.test.tsx`、`f16-2-dialog.test.tsx`、`f14.spec.ts`、`f16-1.spec.ts`、`f16-2.spec.ts` 的 `git diff` 是空的。沒有 Go、migration 或 npm 相依的變更。

**實測**（暫時伺服器 :8122，fake provider＝內建規則，臨時資料庫 `tangent_probe`；`vite preview` :5184 走 HTTP；全程沒有付費模型呼叫）

- 用 12 輪的「週末雜問」（不是設計稿的九輪樣本，NAS／asyncio／咖啡／簽證穿插），1440 × 900：
  - 第 2 步預設是清單；切到心智圖：對話框 1340 × 828、畫布 880、明細欄 460。分析前 2 個 treeitem（根＋整篇「12 輪・24 則」），穿插順序鈕停用。
  - 分析（0.1 秒）後留在心智圖：§1 NAS「跨段整合 6 輪 #1 #3 +4」，支線 asyncio（#2 #5 #10 #11）自 #1、咖啡（#4）自 #3、簽證（#8）自 #7；5 個節點不重疊。
  - 顯示穿插順序：9 個 `n→n+1` 標籤，任兩個中心最近 25 px（≥ 22）。
  - 從明細欄把 NAS 的 #3 移到 asyncio：咖啡支線的膠囊變成「分岔點已移動・自 §1 的 #1 後分岔」，狀態列說明改掛在 #1 之後，選咖啡時明細欄有警告與「確認分岔點」。
  - 這時按「✨ 重新分析」先出現確認（焦點在「確定重新分析」）；取消後警告仍在，確定後回到分析結果（三個分岔點都沒有警告）。
  - 全幅：畫布 1340、明細欄收起、右上「點一個節點，在右側看問答明細」。縮小兩次 64%、置中適應 65%。
  - 從心智圖檢視匯入：4 條主線、27 則訊息、3 條支線（NAS 主線 15 則）；「復原這次匯入」後 0 條。
- 120 話題、720 則的合併檔：切到心智圖 0.13 秒、121 個 treeitem 不重疊；分析加重畫 0.46 秒，1 章節＋114 篇獨立，不重疊，置中適應 25%；方向鍵 20 次 128 ms。這份檔沒有拆輪，所以沒有穿插順序（按鈕停用）。
- 375 × 812（觸控）：結構圖分頁切到心智圖，畫布 307 px 高、明細接在下面；`scrollWidth` 375，沒有超出畫面的按鈕；節點不可拖曳；穿插順序變成 12 列的「原對話的穿插順序」清單；「把第 #1 輪移到…」底部表每列 44 px。
- 全程沒有 pageerror 或 console error。

**和設計稿比對**：看了 `design-ref-canvas-1440`／`design-ref-trace-1440`／`design-ref-move-sheet-375` 與實作截圖。版面、卡片尺寸、膠囊、連線、圖例與控制列一致；穿插標籤在實作裡比設計稿分得更開（設計稿本身的 `1`、`2→3`、`5→6` 有重疊）。差別在 AiTreeBar 比設計稿高，1440 × 900 下獨立對話泳道要往下捲才看得到；手機畫布偏矮（§4）。

**接受的偏差**：§2 全部接受。其中「拆成新支線」沒寫掛點、輪次的鍵盤操作用選單代替拿起／放下，都是為了不顯示可能和實際不一致的資訊，可讀屏也比較清楚。

**留下的**：§4 四項；另外 :8120 是 claude-cli，真實模型分析後的心智圖還沒看過（要付費，需先問使用者）。
