# F19 · 名詞表介面、空狀態收起、F18b 的小問題；「記下來」入口收斂的方案

> 2026-11-13。工單 的 §1（client 與 mock）、§2（名詞表介面 2.1–2.4）、§4（空狀態收起），加上協調者的追加項目 A（client 契約測試回到只剩 B25）與 B（F18b 留下的四個小問題）。
> **§3（「記下來」入口收斂）沒有實作**，只寫方案（本文件「§3 方案」一節），等使用者確認。
> 基線 `d0f6e10`，獨立 worktree 由一個實作 agent 完成，**未 commit、未 push**。
> 只改 `web/` 與 `docs/`；沒有改任何 Go 檔、`store/`、`httpapi/`（含契約樣本）。
> 零付費呼叫：只用 mock；沒有對 :8120、:5183 送請求；沒有讀或改 宿主；沒有啟動其他 agent。
> 檔名照指示用領域名稱（`glossary-*`、`term-*`），所以本文件是 `F19-glossary-ui.md`，不是工單 §6 寫的 `F19-glossary-and-capture.md`。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過（5 個專案） |
| `packages/fonts` `npx vitest run` | 1 檔 10 測試通過 |
| `packages/client` `npx vitest run` | 96 檔 1351 測試：1341 通過、**10 失敗，全部是 B25 的**（清單見「追加 A」）；基線是 23 筆失敗 |
| `packages/react` `npx vitest run` | 104 檔 1114 測試通過 |
| `apps/demo` `npx vitest run` | 53 檔 350 測試通過 |
| `pnpm -C web build`（mock） | 通過；主 JS gzip **159.70 → 161.30 kB**（上限 172） |
| `VITE_TANGENT_API=http pnpm -C web build` | 通過；主 JS gzip **171.80 → 173.62 kB**（上限 185；+1.82，在「盡量 +5 以內」之內） |
| Playwright 新增 `glossary.spec.ts`（7 支） | 7/7 通過 |
| Playwright 整個 mock project（`--workers=2`） | 三次完整執行：187 過／1 敗、186 過／2 敗、**188 過／0 敗**（各 4 skipped）。失敗的兩支單獨重跑都通過，細節見「數字」 |

## 做了什麼

### §1 client（`@tangent/client`）

- `glossary-routes.ts`：`Term`、`TermList`、`TermLimits`（`DEFAULT_TERM_LIMITS`）、`TermSearchHit`、`TermSearchPage`、`CreateTermInput`、`UpdateTermInput`、`TermWriteResult`（`{term, change, keptBranch?}`）、`TermResult`、`TermsChanged` 與各自的 normalizer。
  http 建置時 client 需要它，所以只放線路型別與讀取；畫面問的規則在別的檔。
- `client.listTerms(lineId)`、`createTerm(lineId, input)`、`updateTerm(termId, input)`、`deleteTerm(termId)`（204，沒有本文）、`searchTerms({q, limit, cursor})`。
- `events.ts` 多 `terms.changed`（讀取寫在 `events.ts` 裡，不 import `glossary-routes.ts`：事件流在每個 bundle，名詞表的讀取只在有 client 呼叫的地方）。
- `errors.ts` 多 `term_not_found`、`term_limit`、`term_exists`；`capabilities.ts` 的 `FEATURE_NAMES` 多 `glossary`（22 → 23，排在 `memo` 之後，和伺服器的順序一樣）。
- `TreeExport.terms`（`b14-routes.ts`）；閃卡多一種來源 `term`（正面名詞、背面解釋，排在其他卡之後；`flashcardCounts` 多 `term`）。匯出對話框的張數在有名詞時多一句「名詞表 n 張」。
- `glossary-rules.ts`（只有延遲載入的畫面與 mock 用）：`normalizeTermKey`（= `domain.NormalizeTermKey`）、`cleanTerm`、`cleanTermExplanation`、`termInputProblem`、
  `termPrefill`（對話框的預填，見 §2.1）、`classifyTermError`（`term_exists` 帶出既有那筆）、`filterTerms`、`rankTerms`、`isTermLookup`、`askedBefore`。
- `term-match.ts`（獨立檔，只在這棵樹有名詞時才載入；建置後在 `term-marks` 這個 chunk 裡）：`createTermMatcher`、`scanTerms`、`matchTermsInMarkdown`、`hasTermInMarkdown`、`markdownPlainRuns`。規則：
  - 依 `termKey` 比對：全形英數、大小寫視為同一個詞；名詞本身有空白的地方，文字裡可有可無（`write ahead log` 也認 `WriteAheadLog`），其他地方不跳空白，也不跨行。
  - 用空白分詞的文字（英文等）只認整個詞：`WAL` 不會標在 `WALL` 裡；中日文沒有這個限制，中文旁邊的英文詞也認得（「用MVCC來…」）。
  - 同一個位置多個名詞都符合時取最長的；同一個名詞只回報第一次出現（已經出現過的較長名詞，不會把位置讓給它裡面較短的名詞）；一段文字最多 20 處（`TERM_MARKS_PER_MESSAGE`）。
  - `matchTermsInMarkdown` 跳過圍欄程式碼、行內程式碼、連結（含連結文字）與網址；沒有關上的圍欄之後一律當程式碼。

### §1 mock（`testing/mock-glossary.ts`）

照 `docs/devlog/B24-glossary.md` 與 `store/terms.go`：

- 清理與正規化（名詞壓成一行、協定標記拿掉）、空白 `400 invalid_input{field}`、太長 `422 too_long{field, max}`、來源訊息不在那條線上 `404 message_not_found`、封存 `409 archived`、
  同 key 沒帶 `replace` → `409 term_exists{term}`（帶既有那筆）、帶 `replace` → 原地覆寫解釋與來源、**不改名詞原文**、`change: "updated"`；新增滿 300 筆 `409 term_limit{limit}`（覆寫不受上限影響）；列表上限 1,000。
- 從順口問存：同一次寫入把它設成保留，回應帶 `keptBranch`，事件順序 `terms.changed` → `branch.changed{kept}`；已保留的不再回報；存檔被拒時順口問不會被保留。
- `PATCH` 兩個欄位都沒給 `400`、改名撞到另一筆 `409 term_exists`；`DELETE` 204；`GET /terms`：開頭相符在前、各自依 key、`limit` 1–100 預設 20、封存的對話不列、帶 `rootTitle`。
- 樹的搬動：刪除支線／清除順口問後名詞留著、來源變 `""`（標籤是快照，不變）；接著問把來源改到新支線；detach 帶走子樹的名詞；attach 撞名保留目標的；刪除整篇對話連名詞一起刪。
- 功能關閉時五個呼叫都是 `404 feature_disabled{feature: "glossary"}`，匯出的 `terms` 是 `[]`。
- `scenario.terms`（情境可以預先放名詞）；mock 的三組功能預設都加上 `glossary`（見「和工單不同的地方」5）。
- 沒有模擬的：預覽（`POST /preview`）的 `glossary` 尾段與預算份額（見「留下的項目」）。

### §1 React（`@tangent/react`）

- `query-keys.ts`：`terms(root)`、`termSearch(q)`、`termSearchAll()`。
- `data/glossary-query.ts`：`useTerms(rootLineId, enabled)`（主 chunk 只需要這個；`enabled` 是 false 時完全不發請求）。
- `data/glossary-hooks.ts`：`useSaveTerm`（結果立刻寫進那棵樹的列表並依 key 排好；有 `keptBranch` 就原地寫進大綱，不重讀支線列表）、`useUpdateTerm`、`useTermSearch`（4 秒逾時、不重試）、`writeTerm`、`forgetTerm`。
- `event-sync.ts`：`terms.changed` → invalidate 那棵樹的名詞表、跨對話搜尋與預覽（名詞在每一輪的 prompt 裡）。`tree-cache.ts` 的 `forgetLines` 也 invalidate `terms`（線被刪時來源會變）。

### §2.1 存進名詞表

- **對話框**（`glossary/term-dialog.tsx`，延遲載入）：名詞、解釋兩欄，說明「AI 之後會知道你懂這個詞（只帶名詞，不帶解釋）」。上限照伺服器回的 `limits` 即時檢查，空白在按下儲存後才提示。
  `409 term_exists`：欄位下方出現「這篇對話的名詞表已經有「…」」與**目前的解釋**，主按鈕換成「覆寫」（同一個請求加 `replace: true`），另一個是「取消」。把名詞改成別的詞，就回到一般的儲存。
  其他拒絕：已滿（`term_limit`）、來源不在了、已封存，各有一句話。
- **預填**（`termPrefill`，純函式、有測試）：
  - 順口問自己的「存進名詞表」：名詞＝當初框選的文字（`excerpt`；沒有就用順口問的目的），解釋＝回答的前段（上限 1,000 字，盡量切在句尾），來源訊息＝那則回答。
  - 框選工具列：選取 ≤ 60 字且單行 → 當作名詞，解釋預填那則回覆裡提到它的那一段；選取較長 → 當作解釋，名詞留白。
  - 訊息的「⋯」：解釋＝那則訊息的前段，名詞留白。
- **入口**：順口問原地卡片的頁尾、順口問完整畫面的收尾列（第一排，主要選項）、框選工具列、回覆與自己訊息的「⋯」選單（排在「記成備忘」之後）。存完的提示「已存進名詞表。」帶「查看」，按了打開側欄的名詞表並展開那個名詞。
- **存完的狀態**：卡片與收尾列的按鈕變成「已存進名詞表」（從這棵樹的名詞表讀出「有名詞的來源是這則順口問」，所以重新整理後還在）；伺服器同時把順口問設成保留，卡片立刻顯示「已保留」（用回應裡的 `keptBranch` 原地更新）。
- 經由既有的 flow 機制：`BranchFlow` 多 `saveTerm`、`askedBefore` 兩種，由延遲載入的 `apps/demo/src/frame/glossary-flow.tsx` 處理，主 chunk 只多兩個物件字面值。

### §2.2 查看與管理

- 側欄「紀要」分頁的切換變成「紀要｜名詞表｜備忘」（`notes-side.tsx`）：只列功能開著的；只剩一項時沒有切換；`glossary` 關閉時名稱與兩項切換都和以前一樣。只開 `glossary`（紀要、備忘都關）時分頁名稱是「名詞表」。
- 名詞表面板（`glossary/glossary-panel.tsx`，延遲載入）：依名詞排序；上方篩選框（名詞相符的在前，再來是解釋裡提到的）；每列展開看完整解釋、來源、編輯、刪除。
  來源可以點（跳到來源線與那則訊息）；來源線已刪時顯示快照的 `sourceLabel` 加「（已經不在）」，不是連結。編輯在原地（改名撞到另一筆時說是哪一筆）。唯讀身分與封存的對話沒有編輯與刪除。
- **刪除延後送出＋復原**（`glossary/pending-term-deletes.ts`）：按下後先隱藏、5 秒後才 `DELETE`；提示帶「復原」。等待放在模組裡而不是面板裡，所以切到別的分頁或關掉側欄不影響；離開頁面時立刻送（`keepalive`）。每筆只送一次或永不送。
  5 秒內刪第二個：提示合併成「已從名詞表刪除 2 個名詞。」，所有等待中的重新計時，一次「復原」全部回來（和追加 B.3 同一個做法）。被拒時名詞回到列表並說原因。
- 空狀態只有一行：「存進來的名詞和它的解釋會列在這裡。例如「MVCC：讀不擋寫」。」沒有插圖、沒有篩選框。

### §2.3 在對話中認出已知的名詞

- 樣式：細的點狀底線（`decoration-dotted`、1px、`underline-offset-4`，沿用 F12 字詞錨點的底線，但沒有底色與圖示，比字詞錨點安靜）。滑鼠停 300 ms 或鍵盤 focus 顯示解釋（重用字詞錨點的浮層，跟著捲動）；點一下或 Enter 在側欄的名詞表打開那個名詞。觸控螢幕點一下開底部表（名詞、解釋、來源、「在名詞表查看」、「關閉」）。
- 只標已完成的 AI 回覆；串流中的回覆、使用者自己的訊息、程式碼、連結、數學式不標。字詞錨點（順口問的框選文字）先放，名詞標在剩下的文字裡。
- 做法：`Markdown` 多一個 `scanMarks`（`markdown/marks.ts` 的 rehype 步驟逐個文字節點呼叫掃描，同一次掃描跨段落計數，所以「每個名詞一次、最多 20 處」是整則回覆的）。比對本身是 `@tangent/client` 的純函式。
- **載入**：主 chunk 只有 `useTermMarking`（讀名詞表；`glossary` 關閉時不發請求；這棵樹沒有名詞時什麼都不載入）。有名詞才 `import("./term-marks")`（比對器＋底線元件，gzip 3.80 kB）。
- **不重算**（三層，量測見下）：
  1. 同一份名詞表、同一則訊息的文字：問第二次只是查表（`forMessage` 有測試確認第二次完全沒有比對）。
  2. 名詞表變了：每則訊息算「這則用到哪些名詞、各自最後修改時間」的簽章；簽章沒變的訊息拿回**同一個物件**，它的列不重繪、Markdown 不重新解析。所以新增一個名詞只影響用到它的回覆。
  3. 真的要換標記的回覆，只在**捲進畫面時**才重新解析 Markdown（`MarkdownContent` 用一個共用的 `IntersectionObserver`）；畫面外的先留著原本的標記。第一次顯示時直接帶著標記解析（本來就要解析）。
     另外 `react-markdown` 每次 render 都會重新解析，所以把解析結果用 `useMemo` 留住，只有文字或解析步驟變了才重來。

#### 效能量測（`web/e2e/tests/glossary-perf.spec.ts`，`GLOSSARY_PERF=1` 才跑）

用匯入功能在 mock 裡建一條 **440 則**的對話（220 輪；每則回覆約 400 字，有條列、連結、行內程式碼與圍欄程式碼，而且每則都用到全部 5 個名詞：這是最壞情況，一般對話裡新名詞只出現在少數幾則）。
1440×900、headless Chromium、機器 load 約 1–2。捲動是每一幀把訊息區往下捲 600px，從頭到尾。

| | 幀數 | 平均幀時間 | p95 | 最慢一幀 |
|---|---:|---:|---:|---:|
| 沒有名詞，第 1 輪 | 95 | 16.7 ms | 17.4 ms | 18.6 ms |
| 沒有名詞，第 2 輪 | 142 | 16.7 ms | 17.7 ms | 20.0 ms |
| 5 個名詞（1,100 處標記），第 1 輪 | 166 | 16.7 ms | 18.4 ms | 20.0 ms |
| 5 個名詞，第 2 輪 | 179 | 17.0 ms | 17.3 ms | **93.4 ms** |
| 5 個名詞，第 3 輪 | 182 | 16.7 ms | 17.2 ms | 17.6 ms |

- 幀數每一輪變多，是因為列是 `content-visibility: auto`，看過的列才有真正的高度，總高度一路變長；和名詞無關（對照組一樣）。
- 標記數 1,100 = 220 則回覆 × 5 個名詞，程式碼與連結裡 0 處。
- **如實記錄一個現象**：有名詞時，第 2 輪固定會有**一幀約 90–100 ms**（四次量測：103.3、87.3、101.3、93.4 ms，位置每次不同），第 3 輪沒有。對照組（同樣的操作但不存名詞，跑四輪）沒有這一幀（最慢 17.9–19.6 ms）。
  位置不固定、只出現一次，判斷是第 1 輪逐列重新解析後留下的垃圾被回收，不是穩定狀態的成本；沒有再往下追。
- **存名詞當下的主執行緒阻塞**（`longtask`，> 50 ms 的才會被記到）。這是量測中發現並修掉的問題：

  | 做法 | 存 5 個名詞期間的長任務（ms） |
  |---|---|
  | 第一版（名詞表一變，所有含名詞的回覆同步重新解析） | 每存一個就有一個約 0.6 秒：583、556、626、642、575（另有 90–210 的） |
  | 加上「簽章沒變的訊息不重繪」＋ `useDeferredValue` | 仍有 434、475、715（延遲更新被 query 的狀態變動打回同步；所以拿掉 `useDeferredValue`，改成下一列的做法） |
  | **現在**（簽章＋捲進畫面才重新解析） | 103、98、190、218、54、148、206、284、194、51、130、197、296（最長 296） |
  | 對照組：沒有名詞表，一樣開五次選單與對話框再取消 | 99、97、203、61、199、52、197、50、202、50、82（最長 203） |

  也就是說：在 440 則的對話裡，**開關一個對話框本身就有約 200 ms 的長任務（既有的成本，和名詞表無關，這次沒有動）**；最壞情況下存一個名詞現在比它多約 90 ms。
- 比對器本身（`term-match.test.ts` 裡的量測，Node）：487 則、每則 1,213 字、50 個名詞（其中 45 個是「名詞0號…名詞44號」這種同字開頭的最壞情況）：只問「有沒有名詞」約 **18 ms**，找出全部約 **59 ms**（每則約 0.12 ms）。
  第一版分別是 5 ms 與 350 ms：逐字嘗試每個同字開頭的名詞太慢，改成先把文字正規化一次（typed array）、每個名詞用一次原生的 `startsWith`。「有沒有」因此從 5 變成 18 ms（現在要先把整段正規化），換來「找出全部」從 350 降到 59 ms；名詞表變動時跑的是後者。

### §2.4 跨對話：「之前問過」

- 框選工具列多一個 `hint` 插槽；`glossary` 開著時放 `LazyAskedBefore`（`glossary/asked-before.tsx`，延遲載入）。
- 只在選取 ≤ 60 字、單行時查；選取停 300 ms 才送 `GET /terms?q=…&limit=20`；4 秒逾時；失敗、逾時、功能關閉都只是不顯示，不丟錯。
  「秒問解釋」等按鈕一開始就在，提示是查到之後才出現在按鈕下方的一列，所以不會擋到它。
- 只認「同一個 key、而且不是這篇對話」的名詞（有好幾篇時取最近更新的）：「之前問過：{對話標題}」。
- 點了開對話框：「之前問過「…」」、「在「{對話}」」、當時的解釋與來源，「複製到這篇的名詞表」（從畫面上這條線存，來源是選取所在的訊息）。這篇已經有同一個名詞時不給複製，只說「這篇的名詞表已經有了。」；唯讀與封存也不給。

### §4 空狀態收起（體檢 #11）

- 大綱底下的**群組**：0 筆時整個區塊不顯示（以前是「群組 0／還沒有群組。」）。建立群組的入口本來就在大綱與地圖的多選動作，沒有東西要搬。
- 大綱底下的**關聯**：沒有關聯也沒有 AI 提案時整個區塊不顯示（以前是「關聯 0／還沒有關聯。／新增關聯」）。入口：命令面板多一個「建立關聯…」（`relation.add`，只在面板裡，沒有快捷鍵；唯讀身分沒有），訊息「⋯」的「關聯…」與地圖的拖拉照舊。有了第一筆關聯，區塊（含「新增關聯」）就回來。
  專注模式節點面板裡的關聯區沒有改（那裡本來就只列這條線的）。
- **地圖的操作說明**（「從節點右緣的圓點拖到另一個節點；鍵盤：…」）：只在這個瀏覽器第一次打開地圖時顯示（那一次開著的期間都在），之後不再出現。記在 `localStorage` 的 `tangent:map-relation-hint:v1`；沒有 storage 時維持一直顯示。
- **章節膠囊列**：確認過本來就只在有兩個以上章節（且有人設的里程碑）時才出現，沒有改。
- 新增 `useOptionalCommand`（沒有 `ShortcutsProvider` 時不註冊、不丟錯），因為 `StructurePanel` 也會在沒有 provider 的地方被用到。
- 順帶：框選工具列多了「存進名詞表」之後是六個按鈕。它是 `position: fixed` 的盒子，寬度原本會縮到「錨點右邊剩下的空間」，選取在畫面右半時連 1440 寬都折成兩行；改成依內容寬度（`w-max`，仍不超過螢幕），1440 是一行、375 是兩行各三個，「之前問過」在按鈕下方自己一列。
  按鈕數量本身要等 §3 收斂。

### 追加 A：client 契約測試回到「只剩 B25」

動手前在基線上跑 `packages/client` 的 vitest：93 檔、1310 測試、**23 筆失敗**（存檔比對過）。做完後**10 筆失敗，逐一如下，全部是 B25 的**：

| # | 測試 | 失敗原因（都是 B25） |
|---|---|---|
| 1 | `contract.test.ts` › `route.imports.delete` | `no client call for DELETE /imports/{id}` |
| 2 | `contract.test.ts` › `route.imports.list` | `no client call for GET /imports` |
| 3 | `contract.test.ts` › `route.lines.import.batch` | 回應少 `line.importBatchId` |
| 4 | `contract.test.ts` › `route.lines.list.pinned` | 請求路徑少 `?pinned=true` |
| 5 | `errors.test.ts` › 「lists exactly the codes domain/errors.go defines」 | 只差 `import_batch_not_found` 一個碼（`term_*` 三個已加）。照指示讓它維持失敗，沒有加 B25 的碼、沒有改斷言 |
| 6 | `mock-contract.test.ts` › 「simulates every route a successful sample shows…」 | 只剩 `DELETE /imports/{id}`、`GET /imports` 兩條（名詞表四條已補） |
| 7 | `mock-contract.test.ts` › `route.imports.delete` | mock 沒有這條路由 |
| 8 | `mock-contract.test.ts` › `route.imports.list` | mock 沒有這條路由 |
| 9 | `mock-contract.test.ts` › `route.lines.import.batch` | `$.line.importBatchId: missing` |
| 10 | `mock-contract.test.ts` › `route.lines.list.pinned` | `$.lines[0].importBatchId`、`$.lines[0].pinnedAt` missing |

補上的（B24）：`ROUTES` 五條（`GET/POST /lines/{id}/terms`、`PATCH/DELETE /terms/{id}`、`GET /terms`）、`EXPECTED_SAMPLES` 五份（`route.terms.create/list/update/search`、`event.terms.changed`）、
`MOCK_ROUTES` 五條與 `exerciseGlossary`、`route.capabilities*` 的 `glossary`、`route.lines.export` 的 `terms`、三個錯誤碼。`OPTIONAL_KEYS` 沒有動。

### 追加 B：F18b 留下的小問題

1. **封存的對話不顯示「刪除支線」**：`structure-host.tsx` 在主線封存時不把 `onDeleteBranch` 交給大綱，列尾的垃圾桶與列上的 `Delete` 鍵都沒有了。地圖（專注模式的節點面板）本來就在封存時沒有任何寫入動作，確認過沒有問題。
   順手修了同一類：封存的對話裡，原地展開的順口問卡片不再顯示「接著問」「丟掉」「存進名詞表」（伺服器都會拒絕）。
2. **順口問原地卡片的頁尾收斂**（`aside-inline-card.tsx`）：以前最多 7 個按鈕（記進紀要、記成備忘、保留、接著問、丟掉、展開完整畫面、收合）。
   現在留在外面的是順口問本身的去留：**保留／取消保留、接著問、存進名詞表、丟掉**，右邊是去留的文字與一個「⋯」；「⋯」裡是記進紀要、記成備忘、展開完整畫面、收合（後兩個在卡片標題列也有圖示按鈕）。
   1440 與 375 用同一個版面（1440 加上名詞表後也會是 8 個，一併收斂）。375 寬時「丟掉」只留圖示（無障礙名稱還在），實測 5 個按鈕在兩行以內、不超出螢幕（e2e ⑥）。唯讀身分與已清除的順口問維持原本的兩個按鈕。
3. **連續丟掉兩則時的復原**：選了「合併」。`pending-deletes.ts` 多 `restart(lineId)`；第二次丟掉時，這篇對話裡還在等的刪除全部重新計時，提示變成「已丟掉 2 則順口問。」（混了一般支線時是「已刪除 2 條支線。」），它的「復原」把還在等的全部帶回來並說「已復原 2 則。」。有測試：兩則一起復原且永不送出、不復原則兩則各送一次、第一則提示留下的復原仍只復原它自己那一則。
4. **「已保留」圖示統一**：結束列（`branch-result-bar.tsx`）從圖釘改成和大綱、卡片、對話選單一樣的書籤打勾（`BookmarkCheck`）。全站只剩這一種。

## 和工單不同的地方、自己的設計決定

1. **後端行為以 `docs/devlog/B24-glossary.md` 為準**：`POST` 的回應是 `{term, change, keptBranch?}`、列表上限 1,000、`limit` 1–100、`replace` 不改名詞原文、`DELETE` 是 204 沒有本文。
2. **e2e 檔名是 `glossary.spec.ts`**（協調者的指示），不是工單的 `f19.spec.ts`。
3. **名詞比對在 Markdown 的 rehype 步驟裡逐個文字節點做**，不是先在原始文字上找位置再去對。原因：整詞邊界（`WAL`／`WALL`）、「已出現過的較長名詞」這些規則要在同一次掃描裡判斷才不會標錯位置；程式碼與連結由 rehype 步驟天然跳過。
   原始文字上的 `matchTermsInMarkdown` 仍然存在並有測試（中英文、重疊取最長、程式碼與連結不標、上限），用來回答「這則訊息用到哪些名詞」。
4. **只標 AI 的回覆**，不標使用者自己的訊息（工單寫「回覆文字裡」）。順口問原地卡片裡的回答也沒有標（見「留下的項目」）。
5. **mock 的三組功能預設（標準推薦／深度研究與決策／輕量學習筆記）與設定頁顯示的 `TANGENT_FEATURES` 那一行都加上 `glossary`**。原因：參考伺服器的預設功能從 B24 起含 `glossary`，設定頁用「功能清單完全相同」判斷目前是哪一組；不加的話，接真伺服器時設定頁不會再標出任何一組。這會動到三個既有測試的字串（列在下面）。
   B25 的伺服器端預設組（essential／standard／full）和設定頁這三組的對應是 F20 的範圍，沒有碰。
6. **`AsideAction` 多一個 `"term"`**：卡片把「存進名詞表」交給宿主開對話框（和接著問、丟掉同一條路），不在卡片裡自己存。`MessageList` 多 `terms`、`asideTerms`、`onTerm` 三個選填 props。
7. **名詞被點時的行為**：桌面是「在側欄的名詞表打開那個名詞」，不是另開浮層。浮層（tooltip）只用來看，裡面不放按鈕。
8. **名詞表變動後，畫面外的回覆要等捲進畫面才換上新的底線**（效能的取捨，見 §2.3）。例外是被刪掉的名詞：它的底線在刪除送出、列表重讀後立刻消失（不需要重新解析）。刪除等待的 5 秒內底線還在（那時只從側欄隱藏）。
9. **側欄在「紀要關、備忘開」時仍然先顯示備忘**（分頁名稱那時是「備忘」），名詞表排在旁邊；沒有照「第一個開著的」變成先顯示名詞表。
10. **TDD**：純函式與 mock 多數是先寫測試；介面元件有一部分是實作後才補測試（先讓型別檢查通過、再寫測試），如實說明。量測中發現的兩個效能問題（存名詞時的阻塞、比對器的最壞情況）都是先有數字、再改、再量。

## 主 JS

| | 基線 | 現在 | 差 |
|---|---:|---:|---:|
| mock 建置（`pnpm -C web build`）主 JS gzip | 159.70 kB | **161.30 kB** | +1.60 |
| mock 建置主 JS raw | 492.16 kB | 497.35 kB | +5.19 |
| http 建置（`VITE_TANGENT_API=http`）主 JS gzip | 171.80 kB | **173.62 kB** | +1.82 |
| http 建置主 JS raw | 536.30 kB | 542.68 kB | +6.38 |

主 chunk 多出來的：`conversation-view.tsx`（名詞表的三個入口與「之前問過」的插槽）、`shell.tsx`（`showTerm`、側欄的 `focusTerm`）、`message-list.tsx`（`terms`、`onTerm`、合併兩種標記）、`selection-toolbar.tsx`（一個按鈕與 `hint`）、
`glossary/use-term-marking.ts` 與 `glossary/slots.tsx`、`data/glossary-query.ts`、`event-sync.ts` 的一個 case、`useOptionalCommand`、`relation.add` 命令、三個主字典字串（各兩種語言）。http 建置另外多 `api.ts` 的五個方法與 `glossary-routes.ts`。

延遲載入的新 chunk（http 建置，gzip）：`term-marks` 3.80（比對器＋底線＋底部表）、`glossary-panel` 2.60、`glossary-hooks` 1.90（含 `glossary-rules`）、`glossary-messages` 1.86、`asked-before` 1.73、`term-dialog` 1.69、`pending-term-deletes` 0.65、`glossary-flow` 0.49、`term-fields` 0.44 kB。

## 改過的既有測試

都是介面依工單（或追加項目、或 B24 的契約）改變而必須更新的；沒有為了通過而放寬斷言。

| 檔案 | 改了什麼 | 理由 |
|---|---|---|
| `client/src/capabilities.test.ts` | `FEATURE_NAMES` 長度 22 → 23 | B24 多 `glossary`（B24 devlog 已預告） |
| `client/src/events.test.ts` | `EVENT_TYPES` 長度 23 → 24，並檢查含 `terms.changed` | B24 多一種事件 |
| `client/src/tree-export.test.ts` | `flashcardCounts` 的期望值多 `term: 0` | 閃卡多一種來源（工單 §1） |
| `client/src/contract.test.ts`、`testing/mock-contract.test.ts` | 只有新增（路由、樣本名、`exerciseGlossary`），沒有改斷言 | 追加 A |
| `react/src/conversation/aside-fate.test.tsx` | 「記進紀要」改成先開卡片的「⋯」再選；唯讀那一支多檢查「存進名詞表」「⋯」也不在 | 追加 B.2 |
| `react/src/conversation/f12.test.tsx` | 同上：記進紀要在「⋯」裡；「已記進紀要」從 `aria-pressed` 的按鈕變成停用的選單項目；「只存一次」的斷言保留 | 追加 B.2 |
| `react/src/structure/structure-panel.test.tsx` | 原本等「No groups yet.」出現，改成確認沒有「群組」區塊 | §4 |
| `demo/src/frame/notes-side.test.tsx` | 切換的名稱「Notes or memos」→「Notes, glossary or memos」（功能全開時）；「只剩備忘／只剩紀要」那一支改成也關掉 `glossary`（它現在是切換的一項） | §2.2 |
| `demo/src/frame/settings-dialog.test.tsx`、`settings-presets.test.ts` | `TANGENT_FEATURES=…` 那一行與「學習」組的功能列多 `glossary` | 見「和工單不同的地方」5 |
| `e2e/tests/f8.spec.ts`、`features.spec.ts` | 回覆「⋯」選單的項目清單多「存進名詞表」（在「記成備忘」之後） | §2.1 |
| `e2e/tests/f8.spec.ts`（S12） | 原本按大綱下的「新增關聯」，改成確認它不在、再從命令面板執行「建立關聯…」 | §4（NAS 情境一開始沒有關聯） |
| `e2e/tests/f12.spec.ts` | 卡片的「記進紀要」改成從「⋯」選；「已記進紀要」是停用的選單項目 | 追加 B.2 |

## §3 方案：「記下來」入口收斂（**沒有實作，請使用者確認**）

### 現況（逐一對過程式碼）

| 位置 | 「寫下來」的動作 | 其他動作 | 檔案 |
|---|---|---|---|
| AI 回覆的動作列（常駐） | **停車**（停車關閉時這一格是釘選） | 開支線、複製 | `conversation/message-actions.tsx` `messageActionModel` |
| AI 回覆的「⋯」 | **記進紀要、記成備忘、存進名詞表、將清單存入停車場（n 項）** | 分岔重答、給我幾個方向、抽成支線、開新對話、關聯、折疊、釘選、標論證類型 | 同上＋`message-menu.tsx` |
| 自己訊息的「⋯」 | **記成備忘、存進名詞表** | 抽成支線、移到支線、開新對話、關聯、折疊（常駐：修改並分岔、複製、釘選） | 同上 |
| 框選工具列 | **停車、記進紀要、記成備忘、存進名詞表**（6 個按鈕裡的 4 個） | 秒問解釋、從這段開支線；下方「之前問過」 | `branch/selection-toolbar.tsx` |
| 輸入框 | **停車**（⌘⇧S）、有字時的**存成備忘** | 開支線、預覽 | `conversation/composer.tsx` |
| 命令面板／快捷鍵 | `notes.add`（⌘⇧N 把選取的文字記進紀要）、`composer.park`（⌘⇧S 停車輸入框的內容） | — | `shortcuts/commands.ts` |
| 順口問收尾列／原地卡片 | 記進紀要、記成備忘、存進名詞表（卡片的前兩個這次已收進「⋯」） | 保留、接著問、丟掉 | `aside-wrap-up.tsx`、`aside-inline-card.tsx` |

一則回覆上，同一件事（把這段留下來）有四個去處、分散在常駐列與「⋯」兩處；框選工具列在 375 寬會折成兩到三行。

### 收斂後

1. **訊息動作列**：常駐變成「開支線、**記下來**、複製」。「⋯」只留不是寫下來的動作。
2. **框選工具列**：「秒問解釋、從這段開支線、**記下來**」三個（375 寬一行放得下）；「之前問過」仍在下方。
3. 「記下來」點了展開四列，每列是圖示＋去處＋一行說明：
   - 紀要：AI 之後每一輪都看得到
   - 名詞表：AI 知道你懂這個詞
   - 備忘：只給自己看，AI 看不到
   - 停車場：之後再處理
4. **記住上一次選的去處**（只記在這個瀏覽器，例如 `tangent:capture-target:v1`），下一次它排第一列。
5. **功能關閉的去處不出現；只剩一個去處時不展開**：按鈕直接用那個去處原本的名稱與圖示（例如只開紀要時仍是「記進紀要」），按了直接執行。這樣只開單一功能的畫面與測試不變。
6. 快捷鍵維持原樣（⌘⇧N 直接記進紀要、⌘⇧S 直接停車），不經過選單。

實作上會新增一個純函式（依功能開關與情境列出去處、把上次的排第一）與一個延遲載入的選單；常駐列與工具列各少三個按鈕、多一個觸發，主 JS 預估持平或略降。

### 「回顧」與「待處理」合一

現況是兩套元件、兩套字串：

- 側欄「待處理」：`packages/react/src/inbox/inbox-panel.tsx`（300 行）＋`inbox-section.tsx`、`inbox-filter.tsx`。停車場的種子（展開成支線／直接問／記進紀要／丟掉）、建議（接受／忽略、忽略全部）、論證類型待確認、開太久的支線（**繼續／結束並帶回**）。
- 全螢幕「回顧」：`apps/demo/src/frame/review-board.tsx`（185 行）＋`review-cards.tsx`（149 行）＋`review-messages.ts`。四組（開著太久的支線、待確認的紀要、停車場的種子、未處理的建議），動作是**結束／繼續**、展開成支線、接受、忽略、丟掉，另外有「暫存一天」（只記在瀏覽器）與「全部對話」的範圍。

做法：以側欄「待處理」的清單與動作為準，把它拆成「清單＋動作」與「版面」兩層；回顧改成同一份清單的全螢幕版面（多欄），不再有自己的卡片與動詞。
影響範圍：`review-board.tsx`、`review-cards.tsx`、`review-messages.ts` 約 415 行大多會刪掉或變成薄殼；`inbox-panel.tsx` 要拆出共用的清單；回顧獨有的三樣（暫存、待確認的紀要那一組、跨對話範圍）要決定去留（見下面的問題 4）。

### 會改到的既有測試與 i18n key（估計；以下數字是各檔裡提到這些動作名稱的行數，用來估影響範圍）

- vitest：`branch/selection-toolbar.test.tsx`（12）、`conversation/message-memo.test.tsx`（17）、`conversation/composer.test.tsx`（16，若輸入框也收斂）、`conversation/message-list.test.tsx`（3）、`conversation/messages.test.tsx`（1）、
  `f8/f8-parts.test.tsx`（4）、`demo/conversation-view-aside.test.tsx`（3）、`demo/glossary-view.test.tsx`（這次新增的）、`demo/review-board.test.tsx` 與 `inbox/inbox.test.tsx`（合一那部分）。
- e2e：`p1.spec.ts`（15）、`features.spec.ts`（8，逐項列出選單內容）、`f8.spec.ts`（8，同上）、`notes.spec.ts`（6）、`f12.spec.ts`（5）、`f5.spec.ts`（3）、`focus.spec.ts`（3）、`f10.spec.ts`（2）、`f13.spec.ts`（2）、`glossary.spec.ts`、`p2.spec.ts`／`f5.spec.ts` 的回顧段落。
- i18n：新增 `capture.*`（按鈕「記下來」、四個去處與四句說明，兩種語言）。既有的 `message.notes`、`message.memo`、`message.term`、`composer.park`、`asideNote.save`、`selection.memo`、`selection.term`、`composer.memo` **保留**（選單列的名稱、只剩一個去處時的按鈕名稱都用它們；宿主若覆寫過這些 key 也不會失效）。合一後 `review.end`、`review.continue` 等回顧自己的動詞可以刪。

### 需要使用者決定的問題

1. **常駐的「停車」要不要收進「記下來」**？工單的方案是收進去。但停車是目前回覆上唯一一鍵完成的寫下來動作，收進去會多一步。兩個選項：
   (a) 照方案收進去，靠「記住上次的去處」讓常用的排第一（仍是兩步）；
   (b) 做成「主按鈕直接執行上次的去處＋旁邊小箭頭展開四列」（常用的仍是一步，按鈕文字會跟著上次的去處變）。**建議 (b)**。
2. **輸入框的「停車」與「存成備忘」要不要一起收斂**？工單只寫訊息動作列與框選工具列。建議這一輪不動輸入框。
3. **「將清單存入停車場（n 項）」算不算一個去處**？建議留在「⋯」（它是批次動作，而且只在回覆有清單時出現）。
4. **回顧獨有的「暫存一天」「待確認的紀要」「全部對話」**：合一後 (a) 只在全螢幕回顧出現、側欄維持現在的內容；(b) 兩邊都有。建議 (a)。
5. 開太久的支線的動詞以側欄的「繼續／結束並帶回」為準（工單已指定），回顧的「結束」會跟著改成「結束並帶回」。確認即可。
6. 示意圖：這次沒有做 §3 的畫面草稿（沒有實作）。若要先看樣子，可以拿這次的「順口問卡片頁尾收斂後」截圖（`aside-card-footer-1440`、`-375`）當作「主要動作留在外面、其餘進選單」的參考；正式的示意等上面的問題 1 定了再做比較準。

## 截圖（`docs/devlog/screenshots/F19/`）

`UPDATE_SCREENSHOTS=1` 跑 `glossary.spec.ts` 產生：

| 1440 | 375 |
|---|---|
| `save-term-dialog-1440`（存進名詞表的對話框）、`save-term-exists-1440`（名詞已存在：目前的解釋＋覆寫） | `save-term-dialog-375` |
| `glossary-panel-1440`（側欄：紀要｜名詞表｜備忘） | `glossary-panel-375` |
| `term-underline-1440`（對話中的底線與浮出的解釋） | `term-sheet-375`（點名詞開的底部表） |
| `asked-before-1440`、`asked-before-dialog-1440` | `asked-before-375` |
| `aside-card-footer-1440`（順口問卡片頁尾收斂後） | `aside-card-footer-375` |

## 留下的項目

- **`api` project 沒有跑**：真實伺服器上的名詞表（含「事件比回應早到」的時序、`keptBranch`）只有契約測試與 mock 驗過。
- **440 則的對話裡，開關任何對話框都有約 200 ms 的長任務**（量測時發現的既有成本，不是這次造成的；見效能一節的對照組）。值得另外查（多半是外框重繪時 440 列的對帳）。
- 有名詞時第 2 輪捲動固定有一幀約 90–100 ms（見效能一節），判斷是垃圾回收，沒有再追。
- **mock 的預覽沒有 `glossary` 尾段與預算份額**：伺服器在有名詞時 `prompt.trailing` 多一段、`budget.shares` 多 `glossary`；mock 的 `previewTurn` 沒有模擬，所以 mock 模式下「上下文明細」看不到名詞表那一份。真 API 會有（前端照 key 顯示，沒有專屬的名稱字串，會顯示成 `glossary`；要好看得再加一個標籤）。
- **順口問原地卡片與完整畫面裡的回答沒有標名詞**（只標主畫面訊息列表裡的 AI 回覆）。
- 英文複數、動詞變化不認（名詞是 `transaction` 時 `transactions` 不會被標）。
- 名詞很多、而且大量同字開頭時，比對是每則約 0.12 ms（見量測）；真的到幾百個同開頭的名詞才需要改成 trie。
- 匯出對話框的格式名稱仍是既有的「詞彙表與閃卡」（F8 取的名字），和這次的「名詞表」不是同一個詞；沒有改（改了會動到既有測試與使用者已經看慣的名稱），建議 §3 一起定。
- 側欄名詞表沒有「新增名詞」的按鈕（只能從對話裡存），也沒有跨對話的名詞總表；工單沒有要求。
- `UI_DESIGN_BRIEF.md` §3 的用語表加了「名詞表」「名詞」兩列；`CHANGELOG.md`、`HANDOFF.md`、`ROADMAP.md` 沒有動，留給協調者。
- `glossary-perf.spec.ts` 留在 `web/e2e/tests/`：平常跑會被跳過（mock project 多一筆 skipped），`GLOSSARY_PERF=1` 才量；`GLOSSARY_PERF_CONTROL=1` 是不存名詞的對照組。

## 數字

（全部修改完成之後的最後一輪；vitest 與建置在最後一次改動原始碼之後跑，Playwright 的三次完整執行也都在那之後。）

| 套件 | 基線（`d0f6e10`，這個 worktree 實際跑的） | 現在 |
|---|---|---|
| `packages/fonts` | 1 檔 10 測試 | 1 檔 10 測試，全過 |
| `packages/client` | 93 檔 1310 測試：1287 過、**23 失敗**（B24＋B25） | 96 檔 1351 測試：1341 過、**10 失敗（全是 B25，清單見「追加 A」）** |
| `packages/react` | 98 檔 1049 測試 | 104 檔 1114 測試，全過 |
| `apps/demo` | 52 檔 335 測試 | 53 檔 350 測試，全過 |
| `pnpm -C web typecheck` | — | 通過 |
| 主 JS gzip（mock／http） | 159.70／171.80 kB | 161.30／173.62 kB |

新測試檔：client `glossary-rules.test.ts`、`term-match.test.ts`、`testing/mock-glossary.test.ts`；react `data/glossary-hooks.test.tsx`、`glossary/term-dialog.test.tsx`、`glossary/glossary-panel.test.tsx`、`glossary/term-marks.test.tsx`、`glossary/asked-before.test.tsx`、`markdown/scan-marks.test.tsx`；demo `frame/glossary-view.test.tsx`。
既有檔裡新增的：`tree-export.test.ts`（匯出的 `terms` 與名詞卡）、`event-sync.test.ts`（`terms.changed`）、`i18n.test.ts`（名詞表字典兩種語言對稱）、`selection-toolbar.test.tsx`、`message-memo.test.tsx`、`aside-fate.test.tsx`、`structure-panel.test.tsx`（§4 三支）、`notes-side.test.tsx`（四支）、`pending-deletes.test.ts`、`branch-delete-host.test.tsx`（追加 B.3 三支）。

### Playwright

**新的 `glossary.spec.ts`（7 支）**：單獨跑 7/7 通過（最後一次 34.9 秒；產生截圖那一次也是 7/7）。
開發過程中的失敗都是測試步驟本身的問題，如實列出：第一次 6/7，第 ⑤ 支沒有先把訊息捲進畫面，框選工具列在視窗外點不到；修正後第二次那一支又失敗一次，原因是我用無障礙名稱去找大綱的刪除按鈕（它只有 `title`），改用 `data-tg-delete` 後通過。

**整個 mock project**（`E2E_ONLY=mock npx playwright test --project=mock --workers=2`，在 `web/e2e`）完整跑了三次，如實記錄：

| 次 | 時機 | 結果 |
|---|---|---|
| 1 | 功能完成、三個版面修正之前 | 187 passed、4 skipped、**1 failed**：`f7.spec.ts:83`（9.8 分鐘） |
| 2 | 最後一次改動原始碼之後 | 186 passed、4 skipped、**2 failed**：`f7.spec.ts:83`、`f5.spec.ts:316`（9.9 分鐘） |
| 3 | 同一份原始碼，沒有任何改動 | **188 passed、4 skipped、0 failed**（10.0 分鐘） |

另外為了重現，只跑 `f5`、`f6`、`f7` 三個檔的組合一次：33 passed、1 skipped。

- 4 筆 skipped：原有的 3 筆，加上只在 `GLOSSARY_PERF=1` 才跑的 `glossary-perf.spec.ts`。
- **`f7.spec.ts:83`**（「from a row's menu: … 刪除對話 deletes and the next conversation shows」）：兩次都失敗在測試最後的 `expectAccessible(page)`，axe 回報 `color-contrast`，對象是訊息 hover 工具列裡「從這則開支線」「停車」兩個按鈕的文字。
  那個工具列是 `opacity-0` → hover 時用 150 ms 淡入；刪除對話後滑鼠停在下一篇對話的某一則回覆上，如果 axe 剛好在淡入中取樣，就會算出不足的對比。也就是測試裡「axe 對上淡入動畫」的時間差。
  單獨重跑的結果：`f7.spec.ts` 整檔 3 次都是 10 passed、1 skipped；只跑這一支、`--repeat-each=10 --workers=2` 是 10/10；第三次完整執行通過。
  **我沒有改這個測試，也沒有改工具列的樣式。** 它在 F18b、F20a 的紀錄裡沒有失敗過，而這次三次完整執行裡失敗兩次，所以我不能排除這次的變更讓那個時間差比較容易對上（例如下一篇對話載入時多一次名詞表的讀取與重繪）；沒有做基線的對照執行，這一點請協調者留意。
- **`f5.spec.ts:316`**（375 phone「pin by touch, then the review full screen…」）：第 2 次失敗在一開始的 `page.goto` 之後 5 秒內輸入框還沒出現（頁面載入逾時）。單獨重跑 `f5.spec.ts` 12/12 通過；第 1、3 次完整執行也通過。
- Playwright 執行期間沒有改任何 `web/` 下的檔案（只改了 `docs/`）。
