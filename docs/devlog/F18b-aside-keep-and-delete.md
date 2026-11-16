# F18b · 順口問的去留與接著問、刪除已結束的支線

> 2026-11-13。工單 的 §1（client 與 mock）、§2.1（收尾列）、§2.2（每篇對話的預設去留）、§2.3（刪除已結束的支線），
> 加上協調者補的追加項目 A（匯入分析送更多材料，對接 B26）與 B（「已合併到…」指向已刪除的支線）。§2.4 已在 F18a 完成，沒有重做，新的導覽都經過它。
> 基線 `f04c791`，獨立 worktree 由一個實作 agent 完成，**未 commit**。
> 只改 `web/` 與 `docs/`；沒有改任何 Go 檔、`store/`、`httpapi/`（含契約樣本）。沒有 rebase／pull（主線後來合併的 B24、B25 樣本不在這裡）。
> 零付費呼叫：只用 mock 與 fake runner；沒有對 :8120、:5183 送請求；沒有讀或改 宿主。
> 中途被 API 速率限制打斷一次，接續時先確認 typecheck 通過才繼續；沒有重做已完成的部分。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過（5 個專案） |
| `packages/fonts` `npx vitest run` | 1 檔 10 測試通過 |
| `packages/client` `npx vitest run` | 93 檔 1293 測試通過；基線上的 9 個失敗（B23 的路由還沒有 client 呼叫）現在是 0 |
| `packages/react` `npx vitest run` | 98 檔 1049 測試通過 |
| `apps/demo` `npx vitest run` | 52 檔 335 測試通過 |
| `pnpm -C web build`（mock） | 通過；主 JS gzip **158.57 → 159.77 kB** |
| `VITE_TANGENT_API=http pnpm -C web build` | 通過；主 JS gzip **170.57 → 171.87 kB**（上限 172，剩 0.13 kB） |
| Playwright `E2E_ONLY=mock npx playwright test --project=mock --workers=2`（在 `web/e2e`） | **181 passed、3 skipped、0 failed**（9.8 分鐘，第二次；第一次的情形見「數字」） |
| 匯出指紋（`docs/devlog/P0/exports.mjs`） | client、react 都**只有新增**，沒有移除或改名（清單見下） |

## 做了什麼

### §1 client（`@tangent/client`）

- `BranchView.keptAt?: string`（只有保留的順口問有；normalize 時空字串視為沒有）、`CreateBranchInput.keep?: boolean`。
- `client.keepBranch(lineId, keep)`、`continueAside(lineId, input?)`、`deleteBranch(lineId)`；`RequestOptions.keepalive`（只有 `DELETE` 會帶，給離開頁面時送出的刪除用）。
- `events.ts` 的 `BRANCH_CHANGES` 多 `kept`；`errors.ts` 多 `branch_not_deletable`。
- `aside-routes.ts`：三條路由的型別與 `normalizeContinueAsideResult`（http 建置時在主 chunk，所以只放 client 自己需要的）。
  保留的回應是 `{branch}`，沿用 `normalizeRenameBranchResult`；刪除支線的回應和刪除對話同形，沿用 `normalizeDeleteLineResult`。
- `aside-rules.ts`（只有延遲載入的畫面與 mock 用）：`canDeleteBranch`（= `domain.BranchDeletable`）、`branchDescendants`、`busyBranchUnder`、
  `classifyContinueError`、`classifyDeleteBranchError`（錯誤碼照 B23 devlog 的表，不是工單）。

### §1 mock（`testing/mock-aside.ts`）

照伺服器的順序實作拒絕與事件：

- 保留：功能關閉 `feature_disabled` → 不是支線 `branch_not_found` → 不是順口問 `kind_unsupported` → 封存 `archived`；狀態沒變不發事件。建立時 `keep: true`（非順口問 `400 invalid_input`，`field: keep`），答完時的 `discarded` 事件也帶 `keptAt`。
- 接著問：`kind_unsupported`、`archived`、`branch_busy`（還沒答完、子樹有線在回合中）、`no_messages`、`parent_closed`、`anchor_not_found`、`depth_hard_limit`、`branch_limit`、`tree_limit`（不算被取代的那條）、`depth_soft_limit`（可帶 `confirmDeeper`）。
  搬所有 `done` 的訊息（id、`seq` 不變）、子支線改掛並發 `moved`、端點在搬走訊息上的連結跟到新線、備忘的 `lineId` 變 `""`、新支線用量與未讀從 0 起算。
  事件順序 `line.deleted` → `line.created` → 父線 `line.updated` → `branch.changed{created}` →（`moved`、`link.changed{deleted}`、`group.changed`、`suggestion.changed`）。
- 刪除：主線 `400 invalid_input`、不存在 `line_not_found`、封存 `archived`、`branch_not_deletable`、`branch_busy`；連子樹一起刪，備忘留下，群組少一個成員（剩不到 2 個就解散）。
  被合併進已刪支線的支線，`mergedIntoLineId` 清成 `""`（伺服器是 `ON DELETE SET NULL`，見「追加 B」）。

### §1 React（`@tangent/react`）

- `data/aside-hooks.ts`：`useKeepBranch`（結果原地寫進大綱與支線明細，不重讀清單）、`useContinueAside`（見下）、`useDeleteBranch`。
- `data/tree-cache.ts` 的 `forgetLines(target, rootLineId, lineIds)`：樹還在、只少了幾條線時，大綱原地拿掉那幾條、移除它們自己的 query，並 invalidate 大綱、備忘、紀要、章節、連結、關聯、待辦。
  `rootLineId === lineIds[0]`（整棵樹）仍走原本的 `forgetTree`。結果與事件誰先到都只做一次（沿用 `live.forgetLines`）。
- `event-sync.ts`：`line.deleted` 改呼叫 `forgetLines`（以前順口問過期被清時大綱不會更新，現在會）；`branch.changed{kept}` 只 invalidate 大綱與那條支線的明細，不動兩條線的 view 與訊息。
- 接著問不閃「已清除」：`useContinueAside` 在送出前先記下順口問已讀到的訊息；成功後把它們（`lineId` 換成新線）先放進新線的訊息快取、寫入新線的 view，再重讀一次。
  畫面上開著那則順口問時由 demo 的 `expectedGone` 擋住「這條線不見了」的處理（見 §2.1）。
- 大綱多一個「待刪除先隱藏」的機制：`LiveStore.hidden` 與 `setHidden`，`useBranches` 用 `select` 濾掉（快取本身不動，所以復原只要取消隱藏）。

### §2.1 收尾列與原地展開卡片

- `apps/demo/src/frame/aside-wrap-up.tsx`（完整畫面）：標題旁一行寫明去留（「已保留，不會被清除。」／「沒有保留的話，n 天後清除。」）；
  第一排是順口問本身的去留：**保留／取消保留**、**接著問**、**丟掉**；第二排是把回答帶走：記進紀要並回上一層、記成備忘並回上一層、直接回上一層。
  記進紀要／記成備忘成功後另外 `keepBranch(id, true)`（失敗不吵，回答已經存好）。
- `packages/react/src/conversation/aside-inline-card.tsx`（原地展開）：頁尾多 保留／取消保留、接著問、丟掉；「n 天後清除」保留後換成「已保留」。
  接著問與丟掉經由新的 `MessageList.onAsideAction` 交給宿主。
- 「已保留」也出現在：支線列（`branch-bar`）、結束列（`branch-result-bar`：「已回答，已保留。」）、專注模式的節點面板、大綱列（小圖示＋無障礙名稱）。
- **接著問**（`continue-aside-flow.tsx`，延遲載入）：成功時沒有對話框，直接進新支線、焦點在輸入框。被拒時用小對話框說原因：
  `depth_soft_limit` 可以「還是要接著問」；`concurrent_change`／`branch_busy` 可以「再試一次」；其餘（`branch_limit`、`tree_limit`、`parent_closed`、`anchor_not_found`、`no_messages`…）保留舊入口「改開一條查證支線」。
  順口問已經不在（`branch_not_found`）只給一句提示。`aside` 功能關閉時收尾列顯示舊的「還想追問（從這裡開查證支線）」，沒有保留與接著問。
- **丟掉與復原**（`pending-deletes.ts` ＋ `branch-delete-host.tsx`，延遲載入）：按下後先離開那條線（若它在畫面上）、從大綱隱藏，提示「已丟掉順口問。」加「復原」5 秒；5 秒後才呼叫 `deleteBranch`。
  立刻送出的時機：`pagehide`（帶 `keepalive`）、畫面換到別篇對話（`rootId` 變了）、宿主卸載。每筆只送一次；復原後不送。被拒時取消隱藏並說原因（已經不在視為成功）。
- 唯讀身分：收尾列本來就不顯示；卡片的寫入動作跟著 `readOnly` 隱藏；`onAsideAction` 只在可寫時傳入。

### §2.2 每篇對話的預設去留

- `aside-default.ts`（主 chunk 只需要的讀取：`keepsAsides(rootId)`）與 `aside-default-store.ts`（選單用的 store，同 `pinned-roots.ts` 的做法）。鍵 `tangent:aside-default:v1`，只存設成「保留」的主線 id（最多 200 筆）。
- 對話選單多一組「順口問預設」：「用完即丟」｜「保留」兩個單選項，說明「只記在這個瀏覽器」。`aside` 功能關閉或對話已封存時不出現。
- 設成保留時，秒問解釋（`useQuickAsk` 的新選項 `keepAside`，送出當下才讀）與開支線對話框選順口問（`OpenBranchRequest.keepAside`）都帶 `keep: true`。

### §2.3 刪除已結束的支線

- 大綱列：可刪的支線（`canDeleteBranch`）列尾有垃圾桶按鈕（滑鼠移上或觸控時顯示），鍵盤是在該列按 `Delete`（列上有 `aria-keyshortcuts`）。
- 專注模式的節點面板：可刪的支線多一個「刪除支線…」動作（地圖節點的入口）。
- 沒有子支線：同 §2.1 的延後送出＋復原（提示「已刪除支線「…」。」）。有子支線：先跳確認框（會一起刪掉幾條、無法復原、紀要與備忘會留下），確認後立刻刪。
- `409 branch_busy`：確認框裡顯示「底下還有進行中的支線。」並提供「前往「…」」（大綱看得到是哪一條時）。
- 父線上指向已刪支線的標記（`branch_marker`）：顯示「（支線已刪除）」、沒有「看支線」。判斷方式見「和工單不同的地方」第 4 點。
- 別的分頁刪掉（或順口問過期被清）而你正在看那條線：留在同一篇對話、回到還在的上一層，提示「你正在看的支線已經不在了（已刪除或已清除）。」

### 追加 A：匯入分析送更多材料（對接 B26）

- `import-analyze-apply.ts` 的 `unitOf`：問題最多 600 字、回答最多 2,000 字（`IMPORT_ANALYZE_QUESTION_RUNES`、`IMPORT_ANALYZE_ANSWER_RUNES`），
  單元第一則訊息有真實時間（且是伺服器接受的 RFC 3339）時帶 `startAt`；沒有時間就不帶，不捏造。
- 本機的確定性分析沒有改：`normalizeImportAnalyzeInput` 仍把問題與回答截成 300 字（`cut(cut(x, N), 300) === cut(x, 300)`，所以 mock 收到較長的輸入時結果相同）。
  新增 `analyzeExcerpts(units)`（對應 Go 的 `analyzeExcerpts`），`use-ai-tree.ts` 把它的結果存成 `analysis.units`，之後本機的搬移、修補、節點標題讀到的仍是 300 字摘錄。
- 契約測試與 `analyzeImportLocal` 的既有測試都沒有改斷言就通過；新測試確認「送出 600／2,000 字與 `startAt`」與「本機的計畫與改之前逐字相同」。

### 追加 B：「已合併到…」指向已刪除的支線

- **後端的實際行為**（讀 `store/migrations/011_p2_group.up.sql`，沒有改）：`merged_into_line_id … ON DELETE SET NULL`。B 被刪除後，A 的 `mergedIntoLineId` 會變成 `""`，
  之後 A 就是一條一般的「未帶回」支線（也變成可以刪除）。**所以穩定狀態下前端無從得知 A 曾經合併到一條已刪除的支線**，介面不會壞，但也不會顯示「已刪除」；要保留這個資訊得由後端另外記（沒有改後端）。
- 前端能遇到懸空 id 的情形：刪除事件到了、大綱還沒重讀的那一瞬間；或 B 被「獨立成新對話」移出這棵樹（這時線還在，只是不在這篇對話的大綱裡）。
  這兩種都顯示「已合併到的支線已刪除或移出」，不是連結：大綱列、地圖節點、結束列（`BranchResultBar` 的新 prop `mergedIntoGone`，只有大綱已載入且找不到目標時才成立，載入中仍顯示原本的結果）。
  用語沒有寫成單純的「已刪除」，因為實際會長時間停在這個狀態的是「移出」那一種。
- 測試：mock（刪除 B 後 A 的欄位變 `""`）、hook（大綱重讀後 A 不再帶欄位）、元件（大綱列與結束列顯示文字、沒有按鈕）。

## 和工單不同的地方、自己的設計決定

1. **錯誤碼與行為以 B23 devlog 為準**（`no_messages`、`kind_unsupported`、`concurrent_change`、`branch_not_found`、`branch_not_deletable`、`branch_busy`），不是工單裡的描述。
2. **e2e 的第 1 項沒有「重新整理後還在」**：mock 活在頁面裡，重新整理會重來。改成「到別篇對話再回來仍是已保留」；另外加一支真的重新整理的測試，驗證存在瀏覽器的預設（設成保留 → 重新整理 → 秒問解釋直接是已保留）。
   「伺服器重新整理後仍保留」要在 `api` project 驗，這次沒有跑那個 project。
3. **「順口問預設」做成兩個單選項（`menuitemradio`），不是一個會切換的選單項目**。兩個值的選擇用單選比較貼切；另一個原因要明講：
   `conversation-list-f8.test.tsx` 逐一列出選單裡所有 `menuitem`，多一個 `menuitem` 就得改那個斷言，而這張工單不允許為了通過而改既有斷言。新增的 `MenuRadioGroup`／`MenuRadioItem` 放在獨立的 `components/menu-radio.tsx`。
   若協調者比較想要單一項目，改回去要同時更新那個測試的清單。
4. **標記「已刪除」是查出來的，不是從大綱推斷**：標記指向的支線不在已載入的大綱裡時，才對那條線發一次 `GET /lines/{id}`；`line_not_found` 才顯示「已刪除」。
   只看大綱會把「獨立成新對話」的支線誤標成已刪除。`MessageList` 多一個 `branchesLoaded` prop（沒傳就完全不查）。
5. **分岔膠囊沒有「已刪除」的狀態**：膠囊是從大綱算出來的，支線刪掉（或待刪除被隱藏）後它就不再算進去；留在父線上、會指向已刪支線的只有 `branch_marker`。
6. **`kept` 事件用 invalidate，不是原地寫入**：原地寫入的程式要放進主 chunk（約 0.16 kB gzip），http 建置放不下。自己按的那一下仍是原地更新（mutation 的結果），事件只會多一次大綱重讀。
7. **待刪除只隱藏那一條線，不含子樹**：有子支線的一律先走確認框、立刻刪，不會進入等待，所以不需要連子樹一起隱藏。
8. **第一次刪除在 React StrictMode（開發模式）下會立刻送出**：宿主是「第一次用到才掛載」，StrictMode 會模擬一次卸載，卸載時的「把等待中的送出」就把剛排進去的刪除送掉了。
   改成卸載後下一個 microtask 仍是卸載狀態才送；有專門的測試（拿掉修正會失敗）。正式建置沒有 StrictMode 的雙重掛載，但這個時序本來就不該依賴它。
9. **結束列的「已保留」圖示用 `Pin`**（主 chunk 已有），不是 `BookmarkCheck`：為了不讓主 chunk 多一個圖示。卡片、收尾列、選單（都是延遲載入）用書籤圖示。
10. **畫面上的線被刪時的去處**：`shell.tsx` 的 `leave` 多一段——樹還在時回到最近一層還在的線（找不到就回主線），不再跳到清單的下一篇。
    連帶改變一個既有情形：點到一篇其實已被刪除的對話（清單還沒更新）而原本有別篇開著時，現在回到原本那篇，以前是跳到清單裡的下一篇。初次載入（網址指向不存在的線）不變，仍回清單第一篇。
11. 一次只有一個提示：5 秒內連續丟掉兩則，第一則的「復原」會被第二則的提示蓋掉（第一則照常在 5 秒後送出）。

## 主 JS

| | 基線 | 現在 | 差 |
|---|---:|---:|---:|
| mock 建置（`pnpm -C web build`）主 JS gzip | 158.57 kB | **159.77 kB** | +1.20 |
| mock 建置主 JS raw | 488.91 kB | 492.39 kB | +3.48 |
| http 建置（`VITE_TANGENT_API=http`）主 JS gzip | 170.57 kB | **171.87 kB** | +1.30 |
| http 建置主 JS raw | — | 536.54 kB | |
| JS chunk 數（mock） | 201 | 208 | +7 |

- 第一版量到 mock 160.27、http **172.29（超過）**。用 `docs/devlog/P0/main-chunk-attribution.mjs` 逐檔比對後瘦了一輪才到現在的數字：
  `kept` 事件改 invalidate（−約 480 B minified）、隱藏改成單純的 filter 並拿掉 `branch-hidden.ts`（−約 400）、`forgetLines` 縮短（−約 250）、
  `aside-default.ts` 只留最小的讀取（−約 150）、結束列不引入新圖示（−261）、合併兩個相同意思的字串。
- 現在主 chunk 多出來的（mock，minified）：`shell.tsx` 約 690（延遲載入宿主的掛載、`onFlow` 分流、樹還在時的去處）、`tree-cache.ts` 約 450、`message-list.tsx` 約 480（卡片動作的傳遞、標記的查詢）、
  `live-store.ts`＋`queries.ts` 約 400（隱藏）、`aside-default.ts` 約 200、`delete-host.ts` 約 170、`branch-result-bar.tsx` 約 200、英文字串約 350。http 建置另外多 `api.ts` 的三個方法與 `aside-routes.ts`。
- **http 建置只剩 0.13 kB**（兩次建置之間會有 ±0.01 的差，看檔名雜湊）。下一張會動到主 chunk 的前端工單，幾乎一定要先做 F20a「留下的」那一項（讓各路由的 normalizer 或 http client 延遲載入）。
- 延遲載入的新 chunk：`branch-delete-host`、`continue-aside-flow`、`aside-messages`、`aside-rules`、`aside-hooks`、`menu-radio` 等；`aside-wrap-up` 與 `aside-inline-card` 變大。

## 改過的既有測試

只有工單明確取代的那一個選項：

| 檔案 | 改了什麼 | 理由 |
|---|---|---|
| `apps/demo/src/frame/aside-wrap-up.test.tsx` | 第三個測試原本按「Ask more (an investigate branch from here)」並檢查開支線的流程；改成檢查這個按鈕不在、按「Keep asking」會送出 `continueAside`。`show()` 多一個可關掉 `aside` 的參數 | F18 §2.1 用「接著問」取代「還想追問」。原本的斷言沒有丟掉：搬到新的「asides off」測試裡（功能關閉時舊入口還在） |

只有新增、沒有改斷言的既有測試檔：`contract.test.ts`（`ROUTES` 三條、`EXPECTED_SAMPLES` 四份）、`testing/mock-contract.test.ts`（`MOCK_ROUTES` 三條、`exerciseB23`）、
`import-analyze-apply.test.ts`（新的 describe）、`delete-host.test.tsx`（新的 describe）。`OPTIONAL_KEYS` 沒有動。

## 新增的匯出（都只有新增）

- `@tangent/client`：`ContinueAsideInput`、`ContinueAsideResult`、`KeepBranchResult`、`DeleteBranchResult`、`ContinueAsideFailure`、`DeleteBranchFailure`、`normalizeContinueAsideResult`、
  `canDeleteBranch`、`branchDescendants`、`busyBranchUnder`、`classifyContinueError`、`classifyDeleteBranchError`、`analyzeExcerpts`、`IMPORT_ANALYZE_QUESTION_RUNES`、`IMPORT_ANALYZE_ANSWER_RUNES`。
- `@tangent/react`：`useKeepBranch`、`useContinueAside`、`useDeleteBranch`、`forgetLines`、`writeBranch`、`MenuRadioGroup`、`MenuRadioItem`（與兩個 props 型別）。
- 既有元件新增的選填 props：`MessageList.onAsideAction`、`MessageList.branchesLoaded`、`AsideInlineCard.onAction`、`OutlineTree.onDelete`、`StructurePanel.onDeleteBranch`、
  `BranchResultBar.mergedIntoGone`、`OpenBranchRequest.keepAside`、`useQuickAsk(lineId, { keepAside })`、`NodePanelAction` 多 `deleteBranch`、`RequestOptions.keepalive`。

## 截圖（`docs/devlog/screenshots/F18b/`）

`aside-inline-kept-1440`、`aside-wrap-up-kept-1440`、`aside-default-menu-1440`、`aside-discard-undo-1440`、`aside-continued-1440`、`outline-delete-1440`、`aside-wrap-up-375`、`aside-inline-375`。
（`UPDATE_SCREENSHOTS=1` 跑 `aside-keep.spec.ts` 產生。375 的收尾列用情境裡既有的順口問，它是十月答完的，所以畫面上是「0 天後清除」。）

## 留下的項目

- **`api` project 沒有跑**：真實伺服器上的保留、接著問、刪除（含「重新整理後仍保留」與事件比回應早到的時序）沒有 e2e 驗過，只有契約測試與 mock。
- **事件比回應早到時的短暫骨架**：在順口問的完整畫面按「接著問」，若 `line.deleted` 比 HTTP 回應早到，那條線的 query 會先被清掉，訊息區會短暫變成載入骨架，回應到了才換到新支線。
  不會出現「已清除」或跳到別處，但會閃一下；要完全消除得讓 `event-sync` 知道這條線正在被取代（要再往主 chunk 放程式）。
- **別的分頁做接著問**：你若正開著那則順口問，會回到上一層並看到「你正在看的支線已經不在了」，不會自動跟到新支線。
- **線讀不到（`line_not_found`）而不是收到事件時**，提示仍是既有的「你正在看的對話已被刪除…」（既有測試固定了這句），但現在會留在同一篇對話。
- **封存的對話**：大綱仍會顯示刪除按鈕，按了 5 秒後伺服器回 `archived`，支線回到大綱並提示「這篇對話已封存」。應該直接不顯示（`StructurePanel` 目前不知道封存狀態）。
- 偏題提示（`drift-hint`）與停車場種子展開成順口問時不帶 `keep`（那兩條路徑是伺服器建立支線，沒有這個參數）。
- 沒有做「取消保留」以外的批次操作（一次丟掉所有順口問）。
- `CHANGELOG.md`、`HANDOFF.md`、`ROADMAP.md` 沒有動，留給協調者。

## 數字

（最後一輪，全部修改完成之後。）

| 套件 | 基線（F20a） | 現在 |
|---|---|---|
| `packages/fonts` | 1 檔 10 測試 | 1 檔 10 測試 |
| `packages/client` | 91 檔 1250 通過＋9 個因 B23 失敗（在這個 worktree 的基線上實際跑的） | 93 檔 1293 測試，0 失敗 |
| `packages/react` | 96 檔 1028 | 98 檔 1049 測試 |
| `apps/demo` | 47 檔 292 | 52 檔 335 測試 |
| Playwright mock project | 175 passed、3 skipped | 181 passed、3 skipped、0 failed（新增 `aside-keep.spec.ts` 6 支） |

Playwright 跑了兩次整個 mock project，如實記錄：

- **第一次：179 passed、3 skipped、2 failed**。失敗的是 `branches.spec.ts` 的兩支「420 embedded in a host」（逾時 30 秒）。
  原因是我自己：測試跑到一半時改了 `packages/client/src/aside-rules.ts`（移除一個沒用到的函式），Vite dev server 看到檔案變更讓正在測試的頁面整頁重載，mock 的狀態歸零，測試等不到支線列。
  錯誤畫面是空的 `okr` 對話，和這個原因吻合。
- 單獨重跑 `branches.spec.ts`：6/6 通過。
- **第二次（原始碼定稿後，期間沒有動任何檔案）：181 passed、3 skipped、0 failed**，9.8 分鐘。

新測試（依測試總數的差）：client +34（1259 → 1293，另外原本失敗的 9 個現在通過；新檔 `aside-rules.test.ts`、`testing/mock-aside.test.ts`，`import-analyze-apply.test.ts` 多 3 個）、
react +21（1028 → 1049；新檔 `data/aside-hooks.test.tsx` 9 個、`conversation/aside-fate.test.tsx` 11 個）、
demo +43（292 → 335：`pending-deletes` 8、`branch-delete-host` 15、`continue-aside-flow` 5、`aside-default` 4、`aside-default-menu` 3、`delete-host` 多 4、`aside-wrap-up` 多 4）。
延後送出用假計時器測到的路徑：等滿 5 秒才送且只送一次、復原後永遠不送、送出後按復原沒有作用、換對話立刻送、同一篇對話內換線繼續等、卸載立刻送、`pagehide` 立刻送並帶 `keepalive`、
同一條重複要求只有一次、StrictMode 下第一次仍會等、被拒時取消隱藏、已經不在視為成功。
