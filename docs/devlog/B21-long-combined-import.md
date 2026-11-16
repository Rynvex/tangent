# B21 + F16 — 長對話與合併匯出檔（Combined JSON）智慧分篇與上限放寬

日期：2026-11-04　工單

## 1. 做了什麼

### 階段一：後端 B21（上限放寬，沒有 migration，仍在 016）

- [`domain/import.go`](../../domain/import.go)：`ImportMaxMessages` 200 → **2000**、`ImportMaxBranches` 20 → **50**、`ImportMaxBranchMessages` 100 → **500**。
- [`domain/import_assembly.go`](../../domain/import_assembly.go)：`ImportMaxChapterCuts` 20 → **50**（仍受 `Limits.Chapters.MilestoneMaxPerTree`，預設 200）。
- [`domain/decompose.go`](../../domain/decompose.go)：`DecomposeMaxMessages` 400 → **2000**（`store/decompose.go` 讀 `RowLimit: DecomposeMaxMessages + 1`，不用改）。
- 錯誤訊息字串跟著常數走（`an import has 1 to 2000 messages`、`a branch has 1 to 500 messages`、`an import has at most 50 branches`、`an import has at most 50 chapter cuts`），錯誤碼不變。
- 測試：
  - [`domain/b21_test.go`](../../domain/b21_test.go)：常數值；剛好等於每個上限（2,000 則主線、50 條支線、其中一條 500 則、50 個切點）通過；每個上限多 1 拒絕並斷言 `field` 與完整錯誤字串；`MilestoneMaxPerTree` 比 50 小時仍以它為準。
  - [`b21_test.go`](../../b21_test.go)：750 則主線＋一條 200 則已帶回支線＋25 個章節切點，先過 `domain.PlanImport`（帶 `DefaultLimits()`）再用 `Engine.ImportLine` 真的寫進 `tangent_test`：主線 751 則（含結論卡在錨點正後方）、支線 200 則、25 個切點、資料夾「雜談」，`Decompose` 不 `truncated`。
  - [`httpapi/b21_routes_test.go`](../../httpapi/b21_routes_test.go)：經 HTTP 匯入 2,000 則、每則 1,000 個中文字（約 6 MB）在預設 16 MiB 本文上限內成功；2,001 則回 `400 invalid_input` 與新字串。
  - 既有的 `domain/b18_test.go`、`domain/b19_test.go`、`b18_test.go` 本來就用常數（`ImportMaxBranches+1` 等），不必改。
- 文件：`docs/API.md`（`POST /lines/import`、`GET /lines/{id}/decompose` 的數字）、`docs/DESIGN.md` §12 與 `docs/design/DECISIONS_LOG.md` 各加一列 B21。

### 階段二：`@tangent/client`

1. **常數同步**（[`b18-routes.ts`](../../web/packages/client/src/b18-routes.ts)）：`IMPORT_MAX_MESSAGES = 2000`、`IMPORT_MAX_BRANCHES = 50`、`IMPORT_MAX_BRANCH_MESSAGES = 500`、`IMPORT_MAX_CHAPTER_CUTS = 50`；mock decompose 的 `MAX_MESSAGES` 400 → 2000。`import-plan.ts`、`api.ts`、`import-assembly*.ts` 註解裡的舊數字一併更新。
2. **共用詞彙抽取**（新檔 [`text-terms.ts`](../../web/packages/client/src/text-terms.ts)）：`orderedTerms` 與 decompose 停用詞從 `testing/mock-decompose.ts` 搬出來，加上選項（`minAsciiRunes`、`isStopword`、`scanRunes`）；mock decompose 改 import 它，預設值完全不變（仍是 3 個字母以上、原停用詞），`orderedTerms` 照樣從 mock-decompose 匯出。
3. **依話題轉換分篇**（新檔 [`import-topics.ts`](../../web/packages/client/src/import-topics.ts)，`import-parsers.ts` 已 622 行所以另開檔）：
   - `topicTerms`：`orderedTerms` 加 2 字母縮寫（ui、db、ai、os…），停用詞再加：英文 2 字停用詞（工單那串＋`ok hi`）、一些英文提問與填充詞、AI 回覆常見的中文泛用詞（說明、建議、例如、主要、包括…）、`果是 果有…`，以及**純數字**與**含虛詞字的漢字雙字**（的、是、什、麼、一、這、那、我、你、還、為、如、但、可、以…）。所以 `firebase是什麼?` → `[firebase]`、`PRD一般是對內還對外的?` → `[prd, 對內, 對外]`。
   - `groupTurns`：一輪 = 一則 user 加後面的 assistant；第一則 user 前的回覆併進第一輪。
   - `splitByTopicShifts(messages, "combined" | "long")`：維護目前篇章的詞（每輪提問＋回覆前 300 字）與上一輪的詞（提問＋回覆前 600 字）；下一輪在以下全部成立時切開：目前篇章已經有回覆、`long` 模式時已累積 ≥ 20 則、提問不是延續開頭（工單的清單＋簡體與 `所以 但是 可是 然後 這 它 so but then why what if`）、提問至少有 1 個話題詞、且**沒有任何**話題詞出現在目前篇章或上一輪。
   - `splitOverLimit`：再以 500 則（`IMPORT_MAX_BRANCH_MESSAGES`）在提問邊界保底切開，取代原本的 `splitOverLimitGroup`（200 則、只往前退一則）；單一輪就超過上限時在輪內硬切。
   - 啟用條件（`import-parsers.ts` 的 `topicMode`）：`exportType: "combined"` 一律 `combined`；檔名含 `combined` 且這組訊息都沒有時間時也 `combined`；其他沒有逐則時間、超過 500 則的群組 `long`。
   - 多篇時（`buildGenericConversations`）：標題是各篇第一則提問（`titleOf`），沒有提問才退回 `${meta.title} (${g+1})`；資料夾、標籤繼承；所有訊息都沒時間且檔案有日期時，第 g 篇的 `createdAt = updatedAt = 檔案日期 + g 分鐘`。只有 1 篇時行為不變（標題仍取檔案的 `projectName` 等）。
4. **主幹＋支線樹的預設角色防呆**（[`import-assembly.ts`](../../web/packages/client/src/import-assembly.ts)）：`defaultRoles("tree")` 先照原規則（有時間重疊用 `overlapRoles`、沒有用 `fitRoles`）定出想要的角色，再依序經 `withinTreeLimits`：第一篇永遠是章節；想當支線但超過 500 則或已滿 50 條 → 主線放得下（累計 ≤ 2,000 則且章節 < 50）改章節，否則獨立對話；想當章節但放不下 → 支線放得下改支線，否則獨立對話。`effectiveRoles` 的使用者選擇照舊覆蓋，所以手動把 600 則選成支線仍出 `branchTooLong`。
5. **測試樣本**（新檔 [`import-combined-fixtures.ts`](../../web/packages/client/src/import-combined-fixtures.ts)，也從 `@tangent/client/testing` 匯出）：照使用者給的片段做的 `Gemini-Combined_雜談-2026-11-03.json`（4 輪：CPU 散熱、Firebase、PRD、PRD＋algorithm 追問；提問是「你說了 X  X」、回覆是「Gemini 說了…」、有「編輯影像」尾綴、回覆內容寫成 Gemini 的長度與格式），以及 25 個話題 × 15 輪 = 750 則的長檔（追問有的帶話題名、有的用「那…」開頭）。真實檔案沒有拿到。
6. **測試**：
   - 新的 [`import-topics.test.ts`](../../web/packages/client/src/import-topics.test.ts)（14 個）：話題詞、延續開頭、分輪、各種切與不切、`long` 的 20 則門檻、500 則保底、使用者的樣本切成 3 篇（2／2／4 則、標題、資料夾「雜談」、00:00／00:01／00:02、id 不重複）、只靠檔名的 combined（有時間的訊息不切）、750 則切成 25 篇、非 combined 的長檔。
   - [`import-assembly.test.ts`](../../web/packages/client/src/import-assembly.test.ts)：舊的超限測試改用新常數；`branchTooLong`／`tooManyBranches` 改成在使用者手動選角色時才出現；新增 B21 預設角色 4 個（超過 500 則改章節、50 條支線後改章節再改獨立對話、重疊路徑的章節放不下改支線、手動選擇不被改）；750 則合併檔在 `timeline`、`tree`、`batch` 三種模式都 **0 個 problems**，時間軸的 25 個章節順序就是檔案順序。
   - [`import-parsers.test.ts`](../../web/packages/client/src/import-parsers.test.ts)：原本 4 則的 Gemini-Combined 測試（期待 1 篇「雜談」）改用完整樣本，檢查第一篇的清理結果。
   - [`import-plan.test.ts`](../../web/packages/client/src/import-plan.test.ts)、[`testing/mock-import.test.ts`](../../web/packages/client/src/testing/mock-import.test.ts)：數字改用常數。

### 階段三：`web/apps/demo`

- **文案帶入上限**：[`f14-messages.ts`](../../web/apps/demo/src/frame/f14/f14-messages.ts)（`assembly.over200`、`problem.over200`、`problem.branchTooLong`、`problem.sessionTooLong`、`problem.tooManyBranches`、`problem.tooManyChapters`、`problem.droppedVersions`）與 [`f13-import-messages.ts`](../../web/apps/demo/src/frame/f13-import-messages.ts)（`import.restoreCapped`、`import.restoreCut`、`import.parts`）的英文與繁中都改成 `{limit}`，[`assembly-notices.tsx`](../../web/apps/demo/src/frame/f14/assembly-notices.tsx) 與 [`import-form.tsx`](../../web/apps/demo/src/frame/import-form.tsx) 從 client 常數傳入（`toLocaleString("en-US")`，顯示「2,000」）。demo 只有 en 與 zh-TW 兩種語言；沒有測試斷言舊字串。
- **資料夾預填**（[`use-assembly.ts`](../../web/apps/demo/src/frame/f14/use-assembly.ts) 的 `useOrganize`、[`organize-fields.tsx`](../../web/apps/demo/src/frame/f14/organize-fields.tsx) 的 `sourceFolderOf`／`withFolder`）：勾選的對話只帶一個資料夾（例如 `projectName: "雜談"`）時，F14 第 2 步的資料夾一開始就是它；是租戶既有的資料夾就選它，否則填進「新資料夾名稱」。使用者一改資料夾欄位（包含清空）就不再自動帶入；還沒改過時，回到第 1 步換了勾選，自動帶入的資料夾跟著換（或清掉）。租戶資料夾清單晚到時，自動帶入的值會改成選單上的那一項。
  - 測試（[`f14-dialog.test.tsx`](../../web/apps/demo/src/frame/f14/f14-dialog.test.tsx)，3 個）：上傳 Gemini-Combined 檔 →「Gemini・3 篇」→ 勾 3 篇 → 第 2 步「新資料夾名稱」是「雜談」；改成「閒聊」再清空後保持空白；沒有資料夾的五篇（既有樣本）不預填。

## 2. 和工單不同的地方

1. **話題詞門檻 `userTerms.size >= 2` 改成 `>= 1`**：`firebase是什麼?` 去掉停用詞後只剩 `firebase` 1 個詞，照字面規則不會切開，就得不到工單要求的 3 篇。沒有任何話題詞的提問（「為什麼?」「好的謝謝」）仍然不切。
2. **漢字雙字的停用規則比工單多**：只列 `是什`、`什麼`、`一般`、`如果` 這類雙字詞擋不完跨詞界的碎片（`般是`、`外的`、`果有`、`的話`…），而且這些碎片很容易和上一則回覆意外重疊、讓該切的地方不切。改成「含一個虛詞字就不算話題詞」，再加一小串 AI 回覆常見的泛用詞（說明、建議、例如…）與純數字（`24`、`2026` 會在很多回覆裡出現）。這只用在分篇；decompose（Go 與 mock）的規則沒改。
3. **延續開頭多了幾個**：工單的清單之外加了簡體寫法與 `所以`、`但是`、`可是`、`然後`、`這`、`它`、`so `、`but `、`then `、`why `、`what if`。效果只會讓切點變少（保守）。
4. **「至少 1 輪完整問答」解讀成「目前篇章已有回覆」**：連續兩則 user 不會在中間切。
5. **只看檔名的 combined 要求訊息沒有時間**：工單寫「或檔名含 combined」；審查指出 `combined-notes.json` 這種一般長對話會被誤切並配上假時間，所以只有 `exportType: "combined"` 一律分篇，只靠檔名時要整組訊息都沒有時間。
6. **`defaultRoles` 的防呆也套在預設為章節的篇**：工單只要求「原本會是支線的篇」超限時改章節或獨立對話。預設是章節卻放不下（主線超過 2,000 則或第 51 個章節，例如有時間重疊的路徑）時，同樣改支線、再不行改獨立對話，讓樹狀模式的預設永遠不出現上限問題。
7. **基底時間**：`updatedAt` 也設成同一個時間（`createdAt == updatedAt`），否則每篇的結束時間都是檔案日期，會和下一篇「重疊」而被樹狀模式當成支線。
8. **`PlanImportWithLimits` 不存在**：Go 只有 `domain.PlanImport(in, limits, markers, now)`；長對話測試帶 `DefaultLimits()` 呼叫它，再走 `Engine.ImportLine` 寫入。
9. **問題種類名稱 `over200` 沒改名**：它已經是 client 公開型別的一部分，demo 也在用；註解說明它現在代表 `IMPORT_MAX_MESSAGES`（2,000）。
10. **時間軸模式沒有自動避開 50 個章節**：維持設計決定 #2（超過上限只提示、不自己切換模式）。話題很多的真實檔（例如切出 100 篇）在時間軸模式會看到「章節有 100 個，一次匯入最多 50 個章節切點」，要改用樹狀或批次。
11. 工單 §4.2 的第 3、4 步（commit、合併、備份資料庫、重啟 :8120）照協調者指示沒有做，留給協調者。

## 3. 其他上限盤點（2,000 則匯入會不會被別的地方擋）

- `httpapi.DefaultMaxImportBodyBytes` 16 MiB（client 的 `IMPORT_MAX_BODY_BYTES` 一致）：2,000 則每則 1,000 個中文字約 6 MB，測試通過；但 2,000 則的平均長度超過約 2,800 個中文字（UTF-8 每字 3 bytes＋JSON）就會超過，前端會先顯示 `bodyTooLarge`，宿主可調 `Config.MaxImportBodyBytes`。
- 一則訊息 `Limits.Text.MessageMaxRunes` 32,000 字：沒變。
- `Limits.Branch.MaxPerTree` 200、`MaxOpenPerParent` 8（只算 `open` 的支線）、`Chapters.MilestoneMaxPerTree` 200、`Chapters.MaxMessages` 20,000：都不擋 2,000 則／50 條／50 個切點。
- decompose 仍然只回最多 8 個章節切點、8 段岔題、8 顆種子（`DecomposeMaxCuts` 等沒改）；2,000 則的掃描是線性的。
- 前端檔案上限 20 MB（`IMPORT_MAX_FILE_BYTES`）沒變；1 MiB 以上在 Web Worker 解析。

## 4. 主入口大小（§6 追加之前）

- 第一次 build 主入口 gzip 變成 171,311 B：`text-terms.ts`、`import-topics.ts` 最上層的 `new Set("…".split(" "))`／`Array.from(…)` 被 Rollup 當成有副作用，經 `@tangent/client` 的 barrel 被留在主入口。改成 `/* @__PURE__ */ (() => …)()` 之後，話題分篇的程式與停用詞表只在 `import-dialog`（gzip 46,147 B）與 `import-worker`（13,332 B）chunk 裡。
- 最後：`assets/index-B_EbG9Zc.js` gzip **169,468 B**（上限 172,000；B20.1 是 169,431）。

## 5. 驗收結果（§6 追加之前；追加後重跑的數字在 §6）

| # | 關卡 | 結果 |
|---|---|---|
| 1 | `~/go/bin/sqlc diff && go vet ./... && test -z "$(gofmt -s -l .)"` | 無輸出 |
| 2 | `go test ./... -count=1` | 16 個套件全部通過（`store/db` 沒有測試檔） |
| 3 | `bash scripts/smoke.sh`（:8121、`tangent_smoke`） | SMOKE PASSED（929 events） |
| 4 | `pnpm -C web typecheck` | 5 個專案全部通過 |
| 5 | vitest（各套件分開跑） | fonts 10、client 1,189（87 檔；B20.1 是 1,165）、react 1,028、demo 229（B20.1 是 226） |
| 6 | `pnpm -C web build` 主入口 gzip | `assets/index-B_EbG9Zc.js` 169,468 B |
| 7 | `E2E_ONLY=mock pnpm -C web/e2e exec playwright test tests/f14.spec.ts tests/f15.spec.ts --project=mock --workers=2` | 7 passed |

Playwright 加了 `E2E_ONLY=mock`：不加的話設定檔也會啟動 api 那一側的伺服器（`--project=mock` 只選測試，不選要啟動的伺服器）。

## 6. 追加：伺服器限流（協調者驗收時發現）

協調者用預設限流（`TANGENT_RATE_LIMIT` 600／分、`TANGENT_RATE_BURST` 60）的暫時伺服器 :8122 測：連續 120 次 `POST /lines/import` 有 57 次 `429`；63 個並行 `DELETE /lines/{id}` 有 62 次 `429`（`Retry-After: 1`、`{"code":"rate_limited"}`）。話題分篇後一個真實檔可能是幾十到幾百篇，批次匯入（每篇一次匯入＋一次關聯）、樹狀模式的獨立對話與「復原這次匯入」都會部分失敗。

- 新檔 [`rate-limit-retry.ts`](../../web/packages/client/src/rate-limit-retry.ts)（從 `@tangent/client` 匯出）：
  - `withRateLimitRetry(request, { maxAttempts, sleep, onWait })`：遇到 `TangentError` 且 `code === "rate_limited"` 時等 `extra.retryAfterSeconds`（沒有或不合理時 1 秒，最多 10 秒）再送，總共最多 `RATE_LIMIT_MAX_ATTEMPTS` = 6 次；其他錯誤原樣丟出、不重試；`sleep` 可注入給測試。
  - `settleBounded(items, limit, task)`：最多 `limit` 個同時進行，結果照原順序（`PromiseSettledResult`）。
- [`import-assembly-run.ts`](../../web/packages/client/src/import-assembly-run.ts)：`runAssembly` 的每次匯入與每個關聯都經 `withRateLimitRetry`（`options.retry`）；`undoAssembly(client, lineIds, { concurrency, retry })` 的刪除改成一次最多 `UNDO_CONCURRENCY` = 4 個、每個都會等限流，第二輪（`branch_not_main_line` 再試一次）也一樣。`{deleted, kept, failed}` 與 `line_not_found`／`branch_not_main_line` 的判斷不變；重試用完還是 429 的算 `failed`（匯入則列在 `failures`，照舊可「只重試這一篇」）。
- demo：[`use-assembly-import.ts`](../../web/apps/demo/src/frame/f14/use-assembly-import.ts) 傳 `retry.onWait`，等待時確認列的按鈕從「匯入中…（i / n）」變成「伺服器忙碌，稍候重試…（i / n）」（`summary.waiting`，en `Server busy, retrying… (i of n)`），下一篇完成就回到原本的文字。橫幅的「復原這次匯入」（[`f13-frame.ts`](../../web/apps/demo/src/frame/f13-frame.ts)）改成按下時才載入 [`f14/undo-run.ts`](../../web/apps/demo/src/frame/f14/undo-run.ts)，`import-assembly-run` 與重試程式因此離開主入口（新的共用 chunk `import-assembly-run`，gzip 1,082 B）。
- 測試：
  - [`rate-limit-retry.test.ts`](../../web/packages/client/src/rate-limit-retry.test.ts)（5 個）：照 `Retry-After` 等待後成功；用完 6 次丟出原本的 429；其他錯誤（409、網路錯誤）不重試；過長／0／NaN 的 `Retry-After`；`settleBounded` 的同時數上限與順序。
  - [`import-assembly-run.test.ts`](../../web/packages/client/src/import-assembly-run.test.ts)（3 個）：模擬伺服器的令牌桶（60 個，429 時 `Retry-After: 1`，等待後補滿）：對 mock 批次匯入 70 篇＋69 個關聯全部成功；一直 429 的那一篇在 6 次後列為失敗、其他照常；復原 70 條全部刪除，同時最多 4 個。
  - [`summary-bar.test.tsx`](../../web/apps/demo/src/frame/f14/summary-bar.test.tsx)（1 個）：等待中的文字。
- 主入口 gzip：169,468 → **169,136 B**（復原移出主入口，比 B20.1 的 169,431 還小）。
- 驗收（追加後重跑）：`pnpm -C web typecheck` 5 個專案通過；vitest client 1,197（88 檔）、demo 230（41 檔）；build 主入口 `assets/index-BGC3C3hh.js` 169,136 B；Playwright f14＋f15（mock）7 passed。Go 沒有變更。
- 沒做的：伺服器本身的限流沒改；`importConversation` 以外的一般寫入（例如 F13 單篇匯入、拆解面板的動作）沒有加重試，它們一次只送一個請求。

## 7. 留給下一步

- 話題分篇是固定規則，沒有拿真實的 723 則檔案驗證過。短的追問如果沒有延續開頭、也沒重複前文的詞（例如「可以舉例嗎」），會被切成新的一篇；在時間軸或樹狀模式裡它會變成一個章節或支線，可以在第 2 步手動調整，但沒有「把兩篇合併」的操作。
- 話題很多的檔案在時間軸模式可能超過 50 個章節（見上面第 10 點）。
- `@tangent/client` 的 `package.json` 沒有 `"sideEffects": false`，tree-shaking 全靠 PURE 標註；以後在 client 最上層新增 `new Set(…)` 等表格時要記得標註，或另外評估加這個旗標。
- 預填資料夾用完全相同的字串比對租戶資料夾（`雜談 ` 與 `雜談` 不同）；伺服器會正規化，影響只是選單上顯示成「新資料夾」。

## 8. 協調者驗收（2026-11-04）

- 在 worktree 重跑 7 道關卡，數字與上面一致：sqlc diff／vet／gofmt 無輸出；`go test ./... -count=1` 16 個套件通過；smoke 929 個事件；typecheck 5 個專案；vitest fonts 10、client 1,197、react 1,028、demo 230；主入口 `assets/index-BGC3C3hh.js` gzip 169,136 B；Playwright 完整 mock 套件 162 通過、3 個依設計跳過（8.8 分鐘）。
- 真實介面實測（不碰 :8120／:5183）：暫時伺服器 :8122（`tangent_smoke`、fake runner、預設限流 600／分、burst 60）＋ worktree 的 `vite preview` :5184（`VITE_TANGENT_API=http`）。測試檔是產生的 `Gemini-Combined_雜談探測-2026-11-03.json`：`exportType: "combined"`、120 個互不相關的話題、每個 3 輪（含「你說了 …」重複提問與「Gemini 說了」前綴），共 720 則。
  - 解析：「已勾選 120 篇・共 720 則訊息」，每篇 6 則（同話題的 3 輪留在一起），標題是各篇首問（例如「qubbon是什麼?」），時間 11/03 08:00、08:01…依檔案順序。
  - 時間軸章節圖：「章節有 120 個，一次匯入最多 50 個章節切點。」（照決定 #2 只提示）；主幹＋支線樹：0 個問題；批次獨立匯入：資料夾預填「雜談探測」。
  - 批次匯入：44 秒，期間 179 次 `429`，確認列顯示「伺服器忙碌，稍候重試…（29 / 120）」，最後 120 篇全部建立、都在「雜談探測」。
  - 橫幅「復原這次匯入」：「已復原：這次匯入的 120 條主線已刪除」，伺服器上 120 條全刪。
  - 瀏覽器 console 的錯誤只有 `429` 資源載入訊息（瀏覽器對每個 4xx 回應都會記），沒有程式錯誤。
