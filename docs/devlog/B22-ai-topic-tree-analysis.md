# B22 + F16.2 — AI 匯入預處理分析：跨段穿插主題縫合（A→B→A→C→A→B）與支線樹

日期：2026-11-04　工單：已歸檔（工單 25）

沒有 migration（仍 016）。分析端點不寫資料庫、不發事件。全程測試只用 `runner/fake`、`tangenttest.FakeRunner` 與 mock，**沒有任何付費模型呼叫**，也沒有執行 `claude` CLI。

## 1. 做了什麼

### 階段一：後端 B22

- **`domain/`**（全部純函式，只用標準函式庫）
  - [`import_analyze.go`](../../domain/import_analyze.go)：工單的型別與常數（`ImportAnalyzeMaxUnits` 200、`ImportAnalyzeTextRunes` 300，另加 key 200 字、標題 200 字、節點標題 60 字、結論 300 字、理由 200 字、摘要 300 字、每單元訊息數上限 100,000）；`NormalizeImportAnalyzeInput`（1–200 個單元、key 去空白後非空且不重複、`messageCount` 0–100,000、`startAt` RFC 3339；違反是 `invalid_input` 並帶 `field`，例如 `units[1].key`；文字清理後截斷，不算錯）；`AnalyzeImportDeterministic`。
  - [`import_analyze_terms.go`](../../domain/import_analyze_terms.go)：話題詞，照搬網頁 B21 的 `topicTerms`：decompose 的停用詞，加上 2 字母縮寫、英文提問與填充詞、回覆常見的泛用中文詞、純數字、含虛詞字的漢字雙字；延續開頭清單也一樣。
  - [`import_analyze_thread.go`](../../domain/import_analyze_thread.go)：縫合與角色（演算法見 §3）。
  - [`import_analyze_prompt.go`](../../domain/import_analyze_prompt.go)：`BuildImportAnalyzePrompt` 回傳 `domain.Prompt`。指示放在系統段；單元放在使用者訊息，以 `U1…` 編號，附訊息數、標題、問題、回答前 200 字，全部用 `branchQuote` 引用（協定標記拿掉、code fence 拆掉、每行加 `> `）。指示明說引用資料裡的指令不要照做，並且只能回 JSON。
  - [`import_analyze_parse.go`](../../domain/import_analyze_parse.go)、[`import_analyze_repair.go`](../../domain/import_analyze_repair.go)：`ParseImportAnalyzeOutput`，嚴格檢查並修補，規則見 §3。
- **根套件**
  - [`import_analyze.go`](../../import_analyze.go)：`Engine.AnalyzeImport(ctx, scope, in, r Runner)`、`ImportAnalyzeTimeout`（45 秒）、`OnceRunner` 介面、`RunnerFunc`。
  - [`dispatcher.go`](../../dispatcher.go)：`RunnerDispatcher.RunOnce`，同步跑一次、不存任何東西，以及 `WithMaxOnce`／`DefaultMaxOnce`（4）。
- **`httpapi`**
  - [`import_analyze.go`](../../httpapi/import_analyze.go)：route 是 `{pattern: "POST /lines/import-analyze", bigBody: true, serve: a.analyzeImport}`，加在 `b18Routes()`。它不是寫入、沒有 `op`，唯讀身分也能用。
  - API 的 `Dispatcher` 實作 `tangent.OnceRunner` 時，用 `RunnerFunc(once.RunOnce)` 當 runner；沒有的話傳 nil，直接用 heuristic。
  - 帶 `hostMeta` 回 `400`。
- **測試**
  - [`domain/import_analyze_test.go`](../../domain/import_analyze_test.go)（11 個），涵蓋：
    - A→B→A→C→A→B 的縫合、角色、掛點與結論；
    - 延續開頭、線性主題與零星單問；
    - 上限；
    - 輸入檢查與截斷；
    - prompt 把單元當資料（注入文字只出現在 `> ` 之後、標記拿掉、不出現 key）；
    - 合法 JSON 與 code fence、修補（漏 key、捏造 key、重複、錯掛、未知角色）、不可用的回覆、上限；
    - 提示 id 優先於長得像 `U2` 的 key、attach-after 必須在支線之前、字串裡的 code fence。
  - [`b22_test.go`](../../b22_test.go)（6 個），涵蓋：
    - stub runner 回包在 code fence 裡的合法 JSON（`source: "model"`，用引擎的預設 provider／model、沒有串流）；
    - 降級：nil、fake、錯誤、panic、取消、只給一半、前後有散文；
    - 不合法的輸入不問 runner；
    - `RunOnce` 的佇列上限、`WithMaxOnce`、`Close` 取消。
  - [`httpapi/b22_routes_test.go`](../../httpapi/b22_routes_test.go)（5 個），涵蓋：
    - fake 的回覆不是計畫，改用 heuristic，不發事件；
    - 排入合法 JSON 時用模型的計畫；
    - runner 錯誤時降級；
    - 包過的 Dispatcher 不問 runner；
    - 400 的各種情況，`GET` 會進到 `{id}` 路由。
  - route 表：`b18_routes_test.go` 加一筆，`routes_test.go` 從 91 改成 92。
  - 契約：`contract_b22_test.go` 產生 `route.lines.import_analyze.json`。
- 文件：`docs/API.md` 新增一節，並在本文上限的慣例加上這個 route；`docs/DESIGN.md` 的 §6、§7、§12 與 `DECISIONS_LOG.md` 各加一列 B22。
- `scripts/smoke.sh` 加一步 B22：三個單元 t1／t2／t3，t1 與 t3 縫合成章節、t2 掛成支線；沒有單元時回 400。

### 階段二：`@tangent/client`

- [`import-topics.ts`](../../web/packages/client/src/import-topics.ts)
  - `threadUnits(units, {minMessages})` 是與 Go 相同的縫合；`threadByTopicShifts(messages, mode)` 回傳 `{messages, rounds}[]`。
  - [`import-parsers.ts`](../../web/packages/client/src/import-parsers.ts) 的合併匯出檔與無時間戳的長對話改用它。
  - 有跨段整合、且沒有被 500 則上限再切開的篇，記在 `ParsedConversation.threadedRounds`（例如 `[1, 3, 5]`）。
- [`import-analyze.ts`](../../web/packages/client/src/import-analyze.ts)：型別、常數、`normalizeImportAnalyzePlan`（`omitempty` 的欄位只在有值時保留）、`isBranchRole`。
- [`import-analyze-local.ts`](../../web/packages/client/src/import-analyze-local.ts)：`normalizeImportAnalyzeInput`（同樣的 `400 invalid_input` 與 `field`）、`analyzeImportLocal`。契約樣本（Go 的 heuristic 輸出）與它的結果用 `toEqual` 逐字比對。
- [`import-analyze-apply.ts`](../../web/packages/client/src/import-analyze-apply.ts)
  - `expandSessionsToTurnUnits`：key 是 `${key}#turn-${k}`；移除的訊息不放入、切換的角色與手動時間直接寫進訊息；`conversation.id` 沿用原本的，所以「已匯入過」照樣記住原對話。
  - `sessionsToUnits`：整篇當單元。
  - `applyAnalyzePlanToAssembly`：多單元的節點用 `addSessionMerge` 組成 `SessionMerge`，目標是最早的單元；回傳角色、掛點（原始語彙：`attachAfterUnitKey` 那個單元的最後一則回覆）、結論、理由、標題、`unitMap` 與 `order`。
- [`import-analyze-move.ts`](../../web/packages/client/src/import-analyze-move.ts)：`moveUnitBetweenNodes`（`NEW_BRANCH`／`NEW_STANDALONE`）與 `syncAnalyzePlan`。修補規則同伺服器：節點以第一個單元為 key、依序排列；至少一個章節；支線一定掛在章節，掛點在支線之前；首個單元換掉的節點，其支線的 `attachToKey` 跟著改名。
- `TangentClient.analyzeImport` 走 HTTP。mock 的 `analyzeImport` 呼叫 `analyzeImportLocal`，不連網。兩者都由 `index.ts` 匯出，`@tangent/client/testing` 另外匯出 `analyzeImportLocal` 與 B22 樣本。
- 樣本 `INTERLEAVED_ROUNDS`、`interleavedConversation()`、`interleavedCombinedExport()` 和 Go 測試的文字相同。
- 測試：
  - [`import-analyze.test.ts`](../../web/packages/client/src/import-analyze.test.ts)（6 個）；
  - [`import-analyze-apply.test.ts`](../../web/packages/client/src/import-analyze-apply.test.ts)（11 個）：展開、套用後的 blueprint（`§1` 6 則、兩條支線掛在 `§1` 的 #2 與 #4 並帶結論、0 個問題）、無損拆回、移動與同步；
  - `import-topics.test.ts` 新增 4 個；
  - `contract.test.ts` 與 `mock-contract.test.ts` 加上新 route。

### 階段三：F16.2（`web/apps/demo/src/frame/f14/`，全部在延遲載入的 `import-dialog` chunk）

- [`ai-tree-bar.tsx`](../../web/apps/demo/src/frame/f14/ai-tree-bar.tsx)，第 2 步頂端：
  - `data-tg-ai-analyze`：「✨ AI 智慧分析並畫出支線樹」，分析後變成「✨ 重新分析」。
  - `data-tg-ai-expand`：「拆解對話內部的穿插問答輪次」。勾選 1～3 篇、共 6 則以上時出現，預設勾選；超過 200 輪時停用並說明。
  - 分析中顯示「AI 正在分析跨段話題並建構支線樹…」。
  - `data-tg-ai-summary`：章節、支線、獨立對話數，與跨段整合的主題數（照目前的樹即時計算）。它照實說出是誰做的：「由 AI 模型分析。」或「由內建規則分析（伺服器這次沒有使用 AI 模型，或模型的結果無法使用）。」（`data-tg-ai-source`）。
  - `data-tg-ai-reset`：「還原分析前狀態」。
  - 失敗時以 `role=alert` 說明原因，排列不變，可「再試一次」。
  - 手機上提示只給讀屏讀，分析後縮成一行摘要。
- [`use-ai-tree.ts`](../../web/apps/demo/src/frame/f14/use-ai-tree.ts)
  - `useAiSessions`：拆輪次時，把輪次與 plan 的標題交給 `useAssembly`；輪次的手動時間存在這一步。
  - `useAiTree`：送出請求（`withRateLimitRetry` 處理 429，可中止），每次都從**第一次分析前**的排列出發；套用前先記住那個排列，供「還原」使用。
  - 回答到達時排列已被改過，就不套用，並提示「分析期間排列有了變動…」。
  - 超過 200 個單元時，不送出就先說明。
- [`use-ai-fine-tune.ts`](../../web/apps/demo/src/frame/f14/use-ai-fine-tune.ts)：
  - 移動單輪：先用 `currentPlan` 從 assembly 讀回目前的樹，包括 F16.1 工具做的修改，再 `moveUnitBetweenNodes`，然後套用一次。
  - 換掛章節、一鍵角色、展開狀態。
- [`ai-tree-plan.ts`](../../web/apps/demo/src/frame/f14/ai-tree-plan.ts)：純函式的膠合層。
- [`use-assembly.ts`](../../web/apps/demo/src/frame/f14/use-assembly.ts) 新增 `state`、`restore`、`orderedOriginal`、`say`。
- [`ai-node-panel.tsx`](../../web/apps/demo/src/frame/f14/ai-node-panel.tsx)，掛在 `blueprint-preview.tsx` 的 `NodeBox` 裡，經 `AiTreeContext` 取得資料：
  - `data-tg-ai-units-badge`：「跨段整合 N 輪（#1, #3, #5）」，取代「已合併 n 篇」。
  - `data-tg-ai-reason`：理由。
  - 一鍵角色（`data-tg-ai-role`：升為主幹章節 §、改為支線 ↳、改為獨立對話）。
  - 支線的「掛在：[§ ▾]」（`data-tg-ai-hang-on`）。
  - `data-tg-node-units-toggle`：「查看／微調各輪問答（n）」。展開後每輪一列「#n 問：…」，旁邊是原生 `<select data-tg-move-unit={unitKey}>`，選項有移到其他節點（§n／↳／獨立對話）、拆出成為獨立支線 ↳、拆出成為獨立對話。
  - 移動後焦點跟著那一輪到新節點；Base UI 對話框的焦點陷阱會先把焦點拿回自己，所以 120 ms 後會再確認一次。
- 文案在 [`f162-messages.ts`](../../web/apps/demo/src/frame/f14/f162-messages.ts)（en、zh-TW）。
- 測試：
  - [`f16-2-dialog.test.tsx`](../../web/apps/demo/src/frame/f14/f16-2-dialog.test.tsx)（6 個）：
    - 單篇六輪分析：自動切樹狀、§1 跨段整合 3 輪、B 與 C 掛 §1 帶結論卡、確認列「1 條主線」；
    - `#5` 經選單拆成獨立對話（徽章、摘要、確認列「2 條主線」、狀態列都更新），再移回 §1，「還原」回到 1 篇時間軸；
    - C 升章節、B 換掛 §2、B 改獨立對話；
    - 10 篇整篇分析，分析前合併過的那一篇在還原後仍是合併的；
    - 分析期間改了模式就不套用；
    - 網路失敗後再試一次。
  - [`web/e2e/tests/f16-2.spec.ts`](../../web/e2e/tests/f16-2.spec.ts)（mock）：
    - 1440：分析、axe、鍵盤展開各輪並 Tab 到 #5 的選單、拆出後焦點跟到新節點、移回、還原。
    - 375：分析列與各節點的按鈕和選單都在框內，沒有橫向捲動，分析完自動切到「結構圖」。
  - 截圖在 `docs/devlog/screenshots/F16.2/`：`step2-ai-bar-1440`、`step2-ai-tree-1440`、`step2-ai-units-1440`、`step2-ai-tree-375`、`step2-ai-units-375`。

## 2. 和工單不同的地方

1. **prompt 裡用 `U1…` 編號，不放客戶端給的 key**：key 來自檔名或 session，可能帶任何文字，也可能剛好看起來像指令。解析時先認 `U<n>`，再認 key，所以 key 是 `U2` 的單元搶不走 `U2`。
2. **`domain.ErrInvalidInput` 不存在**：改用 `NewError(CodeInvalidInput, …, {field})`，與匯入的錯誤一致。
3. **模型呼叫的接法**：
   - 只有 API 的 Dispatcher 實作 `tangent.OnceRunner` 時才問模型。參考伺服器的 `RunnerDispatcher` 有實作；宿主自己的佇列沒有，就一律用 heuristic。`httpapi.Config` 沒有加新欄位。
   - 只替可以寫入的呼叫者問模型（`Config.CanWrite` 為 nil 或回 true，協調者審查時要求）。路由仍是讀、沒有 op；唯讀身分（viewer token）一律拿到 heuristic，不會花模型預算（viewer 也不能匯入）。測試：`TestB22Routes_AViewerNeverReachesTheModel` 用一個會回合法計畫的 OnceRunner stub，viewer 得到 `heuristic`、stub 沒被呼叫；寫入者得到 `model`。
   - `RunOnce` 算進 `WithMaxQueue`，另有自己的 `WithMaxOnce`（預設 4，code review 建議的），避免分析請求塞滿 turn 與 job 的佇列；超過就降級為 heuristic。
   - 45 秒包含等名額的時間。
   - 沒有 runner 與客戶端離開時只記 Debug，其他原因記 Warn，且只記固定字串。
4. **縫合先比「問題」詞**（協調者實測後改，見 §6 前的追加）：延續開頭、上一節點沒有回覆、沒有話題詞時留在上一節點；否則把這一輪的問題詞和**每個**節點（含上一個）的問題詞比，只算這時只出現在一個節點問題裡的詞（每個話題都問的「設定」「點要」不算），最多的勝出，同分時上一個節點優先、其次最近的。沒有任何節點共用時才照 B21：與上一節點的問題＋回覆前 300 字、或上一輪回覆前 600 字共用話題詞就留下，否則開新節點。第一版是「先看相鄰（含回覆）、不共用才比較早節點的問題」，回覆裡的詞會把別的話題拉走並一路連鎖。
5. **「核心主題」的定義**：2 個以上單元或 4 則以上訊息。整篇當單元時，一篇有兩輪以上就算。
6. **確定性的 `mode` 一律是 `tree`**。理由與摘要是繁體中文的固定句子，伺服器與 mock 相同。介面上的摘要列由 i18n 依目前的樹計算，所以 en 介面只有節點理由是中文。
7. **樣本設計**：第 4 輪「水冷排要裝在機殼上方還是前方?」的問題，和 A 的問題與回覆都沒有共同話題詞（A 的回覆刻意沒提水冷），所以成為獨立的 C，再因為落在 A 的跨度內而成為 A 的支線。如果 A 的前文提過「水冷」或「冷排」，第 4 輪會被併進 A。規則分辨不了「同主題的子話題」，這是確定性演算法的限制，模型可以分。
8. **B（#2、#6）跨過 A 的跨度**：角色只看節點的**第一個**單元。#2 落在 A（#1～#5）之內，所以 B 是 A 的支線，掛在 #1 之後；#6 在 A 結束之後，仍屬於 B。匯入時 B 的兩輪一起成為那條支線。
9. **`threadByTopicShifts` 用在分篇**：B21 的測試全部照舊通過，包括 750 則切成 25 篇與使用者樣本切成 3 篇，因為那些樣本沒有回頭的話題。新行為只在問題重複先前某篇的問題詞時出現。`long` 模式仍要累積 20 則才離開目前話題（也不會跨段回頭）。`splitByTopicShifts` 保留並繼續測試。
10. **函式簽名比工單多一點**：
    - `applyAnalyzePlanToAssembly` 多一個選填的 `baseMerges`，把分析前的合併摺進來；回傳值另外多 `order` 與 `titles`。
    - `moveUnitBetweenNodes` 多一個選填的 `{units}`，用來決定順序與新節點的標題和結論。
    - 新增 `syncAnalyzePlan` 與 `sessionsToUnits`。
    - 移動之後，有變動的兩個節點拿掉舊理由（舊理由描述的是移動前的單元）。
11. **移動選單用原生 `<select>`**：鍵盤與手機都能用，而且輕量；不是自訂的 popover 選單。
12. **整合測試另開 `f16-2-dialog.test.tsx`**：`f14-dialog.test.tsx` 已 375 行，另開比較清楚。
13. **移動單輪會把節點順序重設為 plan 的順序**：手動拖過的順序不保留。角色、掛點與結論會先從 assembly 同步回 plan，所以會保留。
14. **工單 §4.3 沒有做**：合併回 main、備份資料庫、重啟 :8120／:5183 都依協調者指示留給協調者。沒有 commit。

## 3. 演算法與修補（Go 與 TS 相同）

- **縫合**（依序處理每個單元）。單元的詞是標題、問題與回答前 300 字；「問題詞」是標題加問題。
  - 上一個節點還沒有回覆、問題是延續開頭、或問題沒有話題詞時，留在上一個節點。
  - 否則比問題詞：只算這時只出現在一個節點問題裡的詞，與某節點（含上一個）共用最多的勝出；同分時上一個節點優先，其次最近活動的。
  - 沒有任何節點共用時，問題與上一個節點的詞、或與上一單元（回答前 600 字）共用話題詞就留下，否則開新節點。
- **角色**（依節點第一個單元的順序）：
  - 第一個節點是章節。
  - 第一個單元**嚴格**落在某章節的第一與最後單元之間時，是最內層那個章節的 `merged_branch`：
    - `attachToKey` 是那個章節；
    - `attachAfterUnitKey` 是那個章節在它之前的最後一個單元；
    - 結論是最後一個回答的第一句，最多 120 字。
  - 其餘的核心主題是章節，剩下的是 `standalone`。
  - 放不下時照 B21 的 `withinTreeLimits` 移動：支線超過 500 則或已有 50 條時改章節，再不行改獨立對話；章節會超過 2,000 則或已有 50 個時改支線，再不行改獨立對話。
- **修補模型的回覆**：
  - 回覆可以包在 json code fence 裡，或是一個開頭就是 `{` 的物件；物件後面不能再有內容；上限 256 KiB。
  - 未知與重複的單元丟掉。漏掉的單元併入前一個單元的節點，沒有前一個就併入後一個。漏掉超過一半或沒有可用節點時，回覆不可用。
  - 未知角色當章節。沒有章節時，第一個節點當章節。
  - 先照上限移動角色。之後若仍沒有任何章節，支線改為獨立對話。
  - `attachToKey` 不是章節時，依序改掛：它所在跨度的章節、它之前最近的章節、第一個章節。
  - `attachAfterUnitKey` 必須是那個章節裡、在支線之前的單元，否則改用那個章節在支線之前的最後一個單元。
  - 文字壓成一行並截斷。有支線時 `mode` 一定是 `tree`。

## 4. 留給下一步

- **沒有用真的模型跑過**：遵守零付費呼叫，這次沒有實測 `claude-cli` 的 prompt 品質，也沒實測 CLI runner 處理這個系統段的情形。協調者在 :8120 實測時，第一次請使用者自己按一次，再看伺服器 log 有沒有 `fell back` 與原因。
- **heuristic 會誤併**：問題剛好共用泛用詞（例如「設定」）時，會被併進較早的主題。B21 的停用詞擋掉大部分，沒擋的可以在介面上移出。
- **兩邊的文字清理不完全一樣**：伺服器另外拿掉協定標記、控制字元、零寬字元與 code fence；mock 只修剪空白。含這些字元的文字，兩邊的詞或標題可能不同，已寫在 `import-analyze-local.ts` 的註解。
- 單元上限 200；超過 200 輪時改以整篇分析，選項會停用並說明。
- 左欄卡片沒有跨段整合的徽章，仍顯示「已合併 n 篇」。
- 理由句只有中文。
- 分析請求最多會卡住 45 秒（多次 429 重送時更久）。參考伺服器的 `WriteTimeout` 是 2 分鐘，夠用；宿主的伺服器若更短，要調整。前端在等待時會顯示提示，沒有另外的逾時。
- 嵌入的宿主若要用模型，Dispatcher 要實作 `RunOnce`，或之後在 `httpapi.Config` 加一個 runner 欄位。

## 5. 驗收結果（實作 agent）

| # | 關卡 | 結果 |
|---|---|---|
| 1 | `~/go/bin/sqlc diff && go vet ./... && test -z "$(gofmt -s -l .)"` | 無輸出 |
| 2 | `go test ./... -count=1` | 16 個套件通過（`store/db` 沒有測試檔） |
| 3 | `TANGENT_SMOKE_PORT=8123 bash scripts/smoke.sh` | `SMOKE PASSED (929 events)`（含新的 B22 步驟；沒有用 :8120） |
| 4 | `pnpm -C web typecheck` | 5 個專案通過 |
| 5 | vitest（各套件分開跑，`--maxWorkers=2`） | fonts 10、client 1,228（90 檔；F16.1 是 1,205）、react 1,028、demo 244（43 檔；F16.1 是 238） |
| 6 | `pnpm -C web build` 主入口 gzip | `assets/index-CZCNiScD.js` = **169,148 B**（上限 172,000；F16.1 是 169,142）；`import-dialog` chunk gzip 62.4 kB |
| 7 | `E2E_ONLY=mock pnpm -C web/e2e e2e:mock --workers=2` | 第一次完整跑：160 通過、6 失敗、3 跳過（13.2 分鐘，機器負載 load average 約 15）。失敗的是 `f6.spec.ts` 4 個、`f8.spec.ts` S6、`p2.spec.ts` 樹平衡，都是本步沒改到的對話流程，在 `freshConversation` 等回覆時逾時。只重跑這三個檔案：34 通過、1 跳過（2.8 分鐘）。`f16-2.spec.ts` 2 個都通過。建議協調者在負載低時重跑整套 |

### Code review（code-reviewer 子代理）

沒有 CRITICAL／HIGH。處理了以下 MEDIUM 與 LOW：

- 「掛在」選單的值改成持有掛點那一篇的章節，合併過的章節也找得到。
- `attachAfterUnitKey` 必須在支線之前。
- 提示 id 優先於 key。
- `RunOnce` 有自己的上限 `WithMaxOnce`。
- TS 的 RFC 3339 改成區分大小寫，並記下文字清理的差異。
- 開頭就是物件的回覆不剝 code fence。
- 預期內的降級（沒有 runner、客戶端離開）只記 Debug。
- `useAiTree` 拆出 `useAiFineTune`。
- 分析期間排列有變動時不套用；超過 200 個單元時先擋下。
- 「再試一次」有 busy 防護。

協調者實測追加（縫合連鎖）：12 輪「週末雜問」（NAS 備份、asyncio、咖啡、日本簽證交錯）原本得到 NAS＝[r1, r3]、asyncio＝[r2, r5, r6, r7, r9, r10, r11, r12]。原因是 r6 的問題和 r5 的**回覆**共用「排程」，相鄰規則先把 r6 留在 asyncio，之後每一輪又和前一輪共用詞，一路連鎖。改成先比各節點的問題詞（§2 第 4 點），Go 與網頁同步修改。另外發現：只比問題詞時，每個話題都會問的泛用詞（750 則樣本的「設定」「點要」）會把 Rust 的追問拉進 Nginx，所以只算「這時只出現在一個節點問題裡」的詞。新計畫：NAS＝[r1, r3, r6, r7, r9, r12] 章節；asyncio＝[r2, r5, r10, r11]（掛在 NAS 的 r1 之後）；r4 咖啡（掛在 r3 之後）與 r8 簽證（掛在 r7 之後）各自成為 NAS 的支線，因為它們都落在 NAS 的跨度內。回歸測試：`domain/import_analyze_weekend_test.go`（計畫存在 `domain/testdata/import_analyze_weekend.plan.json`，網頁的 `import-analyze.test.ts` 逐字比對同一份，並檢查 `threadByTopicShifts` 對同一份訊息得到同樣的輪次），以及「每個話題都問的詞不縫合」。既有的 B21、B22 測試都不用改預期。修正後重跑：關卡 1 無輸出；`go test ./domain ./httpapi ./` 通過；typecheck 5 個專案通過；vitest client 1,229、demo 244。e2e f14＋f15＋f16-1＋f16-2 跑了三次：第一次 7 通過、4 失敗（f14 與 f15 各 2 個）；第二次 9 通過、2 失敗（f15 的 2 個）；f15 用 1 個 worker 單獨跑 4 個全過。這幾次機器負載很高（load average 20～42）。f14 第一次的失敗是在對話框出現前就逾時（快照裡沒有對話框）。f15 的兩個失敗沒有看錯誤內容，只推測是負載造成的，因為它匯入的都是有時間的一般檔，不會經過縫合。

協調者審查追加：viewer 也能觸發模型呼叫（路由是讀）。已改成只替可以寫入的呼叫者傳 runner，viewer 一律用 heuristic，並加了測試（見 §2 第 3 點）。

## 6. 協調者驗收


協調者在 worktree 自己重跑（2026-11-04，修完縫合連鎖與 viewer 之後）：

| 關卡 | 結果 |
|---|---|
| 1 `sqlc diff`、`go vet`、`gofmt -s -l` | 無輸出 |
| 2 `go test ./... -count=1` | 16 個套件 ok |
| 3 `TANGENT_SMOKE_PORT=8123 bash scripts/smoke.sh` | SMOKE PASSED（929 events，含 B22 一步） |
| 4 `pnpm -C web typecheck` | 5 個專案通過 |
| 5 vitest（各套件分開） | fonts 10、client 1,229、react 1,028、demo 244 |
| 6 build，主入口 gzip | `assets/index-BwCyAoov.js` = 169,143 B（上限 172,000） |
| 7 完整 mock e2e | 162 通過、4 失敗、3 跳過；失敗的 f5（375 釘選）、f7（axe 掃到過場中的按鈕對比）、smoke、structure 都和匯入無關，負載降下來後這 4 個檔單獨重跑 36 通過、1 跳過。修正前的第一次完整執行是 165 通過、1 失敗（f5-c2 手機群組逾時，重跑通過） |

真實介面實測（臨時伺服器 :8122，`TANGENT_PROVIDER=fake`，資料庫 `tangent_probe`；預覽 :5184 用 `VITE_TANGENT_API=http` 建置；沒碰 :8120／:5183）：

- 測試檔是協調者另寫的 1 篇 24 則「週末雜問」（12 輪：NAS 備份 #1、#3、#6、#7、#9、#12；asyncio #2、#5、#10、#11；手沖咖啡 #4；日本簽證 #8），措辭和 agent 的固定資料不同。
- 第一次實測抓到縫合連鎖（見 §5 協調者實測追加）；修正後：
  - 第 2 步預設勾選「拆解對話內部的穿插問答輪次」（12 輪），按「✨ AI 智慧分析並畫出支線樹」約 0.1 秒完成，自動切到「主幹＋支線樹」。
  - 結果：§1 NAS 跨段整合 6 輪（#1, #3, #6, #7, #9, #12）；asyncio 跨段整合 4 輪掛在 §1 #2 之後；咖啡掛在 §1 #4 之後；簽證掛在 §1 #8 之後；三條支線都有結論卡。摘要照實寫「由內建規則分析」，伺服器記下 `reason="the reply is not a usable plan"`（fake runner 的回覆），沒有對話內容。
  - 展開「查看／微調各輪問答」，把 #12 移成獨立對話：節點變 5 個、摘要變「3 條支線、1 篇獨立對話」；「還原分析前狀態」回到 1 張卡、摘要消失。
  - 再分析一次後「確認並純匯入」：資料庫 4 條線、27 則訊息（24 則＋3 張結論卡）、3 條支線，主線 15 則（12 則＋3 張卡）；「復原這次匯入」後剩 0 條。
  - 375：分析後 `scrollWidth` 375，沒有按鈕或選單超出畫面；沒有頁面錯誤。
- 審查追加：viewer token 原本也能觸發模型呼叫，已改為只有可寫入的呼叫者會問模型（§2 第 3 點）。

沒有驗證的：:8120 的 claude-cli 真實模型提示品質與 45 秒內能否完成（會付費，要使用者同意才試）；使用者真實的長對話檔。
