# F20b · 接真 API 建置的主 JS 瘦身

> 2026-11-13。基線 `a4a0aed`（F18），獨立 worktree。只改 `web/apps/demo/src/main.tsx`、`web/packages/client/src` 的五個檔（搬移宣告）、三個新檔與一個 demo 新檔，加上 `docs/` 與 `CHANGELOG.md`。沒有改 Go、Vite 設定、`tsconfig`、相依套件、lockfile、任何測試或 `docs/devlog/P0/`。

> **決定（2026-11-14，使用者）：採用 C，並把接真 API 建置的主 JS 上限改為 185 kB（mock 建置維持 172 kB）。** 協調者已還原 `apps/demo/src/main.tsx` 並刪除 `apps/demo/src/frame/http-client.ts`；合併的只有三個拆檔（`base-url.ts`、`error-response.ts`、`note-draft.ts`）。合併後的數字：接真 API 171.80 kB、mock 159.70 kB。下面的內容是 agent 交付時（方案 A 的狀態）的紀錄，保留作為量測依據。

> **⚠ 需要協調者決定（見「首屏實測」與「三條路」）**：主 JS 達標（159.72 kB），但做法是把首屏一定要用的用戶端程式碼移到主 JS 之後才下載的 chunk；在有延遲的網路上首屏變慢（HTTP/2 下中文介面幾乎不變、英文介面慢約 0.4 秒；HTTP/1.1 下兩種語言都慢約 0.9 秒）。工單的另一個方向（`createTangentClient` 首屏核心＋其餘延遲）實測上限是 168.23 kB，達不到 165。

## 結果

| | 前 | 後 | 差 |
|---|---:|---:|---:|
| 主 JS gzip，接真 API（`VITE_TANGENT_API=http pnpm -C web build` 印的） | **171.87 kB** | **159.72 kB** | **−12.15 kB** |
| 主 JS gzip，mock（`pnpm -C web build` 印的） | 159.77 kB | 159.74 kB | −0.03 kB |
| 主 JS raw，接真 API | 536.4 kB | 492.14 kB | −44.3 kB |
| JS chunk 數，接真 API（`dist/assets/*.js`） | 190 | 208 | +18 |
| JS chunk 數，mock | 208 | 209 | +1（`aside-note`） |

- 接真 API 建置新增的 chunk（gzip）：`http-client` 5.74 kB（`api.ts`、`events.ts`、`sse.ts`、`branch-normalize`、`p1/p2/b5-routes` 等只有它用的模組）、`line-normalize` 2.20、`result-normalize` 1.49、`b18-routes` 1.30、`comparison-routes` 1.27、`b14-routes` 1.16、`group-routes` 0.89、`chapters` 0.80、`memory-routes` 0.67、`spinoff-routes` 0.61、`fold-routes` 0.55、`types` 0.53、`b20-routes` 0.52、`import-analyze` 0.45、`b17-routes` 0.40、`b15-routes` 0.32、`wire` 0.31、`aside-note` 0.29。除了 `http-client`，其餘都是 mock 建置本來就有的共用 chunk（它們同時被 lazy 的對話框用）。
- 量測：每一步用含 sourcemap 的暫存建置量主 JS 與 `docs/devlog/P0/main-chunk-attribution.mjs` 的逐檔歸屬（含 sourcemap 註解的數字比正式建置多約 0.04 kB）；最後的數字是正式的 `pnpm -C web build` 兩種模式各一次。建置都輸出到暫存目錄或被 git 忽略的 `dist/`。

## 主 chunk 裡原本有什麼

http 建置的主 chunk 比 mock 多 44,733 B minified（≈ 12 kB gzip），幾乎全部是 `@tangent/client` 的 HTTP 用戶端：`api.ts` 8,081、`events.ts` 3,765、`branch-normalize` 3,485、`result-normalize` 3,288、`line-normalize` 3,197、`b18-routes` 2,663、`chapters` 1,867、`p1-routes` 1,866、`group-routes` 1,847、`comparison-routes` 1,443、`memory-routes` 1,280，以及其餘十幾個路由檔各 0.1–1.1 kB。mock 建置的主 chunk 一個都沒有：mock 用戶端由 `main.tsx` 動態載入，這些 normalizer 跟著它放進共用 chunk。

## 首屏會呼叫哪些方法（決定了做法）

用暫存的 Playwright 設定接 e2e 的 `api` 伺服器（fake runner、全功能、獨立資料庫與 port），開一條有一輪問答的對話，記錄載入後 4 秒內的 `/api` 請求（基線程式，dev server）。`?line=<id>` 與不帶參數兩種開法都會呼叫這 16 個方法：

`getLine`、`listMessages`、`getCapabilities`、`listLines`（含 `archived=true`）、`subscribe`（`/events`）、`listFolds`、`getLineOrganization`、`previewTurn`、`listBranches`、`listChapters`、`markRead`、`getGoal`、`listGroups`、`listRelations`、`listSuggestions`、`listNotes`。

它們橫跨 `result-normalize`、`line-normalize`、`chapters`、`capabilities-normalize`、`fold-routes`、`p2-routes`、`group-routes`、`p1-routes`、`b18-routes`、`events`／`sse` 等大部分的 normalizer 模組。工單建議的「核心＋依領域延遲載入」若要守住「首屏一定會呼叫的方法不能拆出去」，能拆走的只剩比較、記憶、獨立成新對話、B14／B17／B20／B15、匯入分析、搜尋與預覽支線、備忘，以及 B18／P1／群組的一部分：依 attribution 估計約 16 kB minified、≈ 5 kB gzip，http 主 JS 約 167 kB，到不了 165（這是依歸屬數字的估計，沒有實作量測）。

## 做法

1. **demo 的 http 模式也動態載入用戶端**（`main.tsx`）：`makeClient` 在 http 分支 `await import("./frame/http-client")`，那個檔只有 `export { createTangentClient } from "@tangent/client"`。mock 分支本來就是這樣（`import("@tangent/client/testing")`），兩個分支現在對稱。`createTangentClient` 本身、它的型別與回傳的 client 都沒有變；`main.tsx` 仍在建好 client 之後才 render，所以 `TangentProvider` 拿到的是同一個完整、同步的 client 物件，hooks 不需要任何改動。
2. **`normalizeBaseUrl` 搬到 `client/src/base-url.ts`**，`api.ts` 轉出。只做第 1 步時主 JS **0 變化**（171.91 → 172.00）：`@tangent/react` 的 query key（主 chunk）用 `api.ts` 的 `normalizeBaseUrl`，Rollup 以模組為單位分 chunk，整個 `api.ts`（連同 `createTangentClient` 與它 import 的所有 normalizer）就留在主 chunk。搬走後 → 159.99。
3. **`errorFromResponse`（＋`ERROR_TEXT_MAX` 與兩個私有 helper）搬到 `client/src/error-response.ts`**，`errors.ts` 轉出；`api.ts`、`events.ts` 直接從新檔 import。主 chunk 的 UI 只用 `TangentError`、`hasErrorCode`、`extraNumber`，`errorFromResponse` 只有 HTTP 用戶端與 SSE 用。→ http 159.72（mock 不變）。
4. **用戶端載入失敗的處理**：`main.tsx` 最後的 `Promise.all(...).then(render)` 加上 rejection handler，用戶端的 chunk 下載失敗時 `console.error("tangent: the client did not load; reload the page", error)`，不再是未處理的 rejection（mock 的 chunk 失敗也一樣受惠）。只接 `Promise.all` 的 rejection，`render` 本身的例外照舊往外丟。
5. **補回第 4 步讓 mock 多出的 37 B gzip**（工單要求 mock 不得變大）：`aside-note.ts` 的 `noteDraft` 與 `NOTE_TEXT_MAX` 搬到 `client/src/note-draft.ts`，`aside-note.ts` 轉出；`note-from-text.ts` 改從新檔 import。主 chunk 只用 `noteDraft`（對話的「存成紀要」），`aside-note.ts` 其餘的（`NOTE_SECTIONS`、`asideAnswer`、`validateNote`）只有對話框與側欄用，整個檔離開主 chunk。→ mock 159.74（比基線少 0.03）。

每個新檔開頭都有註解說明為什麼獨立、由哪個原檔轉出。函式本體逐字搬移，沒有改任何邏輯。

### 逐步數字（含 sourcemap 的量測建置；最後一列是正式建置）

| 步驟 | http 主 JS gzip | mock 主 JS gzip |
|---|---:|---:|
| 基線 | 171.91 | 159.80 |
| 只有第 1 步 | 172.00 | 159.80 |
| ＋第 2 步 | 159.99 | 159.80 |
| ＋第 4 步（第一版訊息） | 160.03 | 159.85 |
| ＋第 5 步 | 159.91 | 159.74 |
| ＋第 3 步 | **159.72**（正式建置 159.72） | **159.74**（正式建置 159.74） |

## 首屏請求有沒有多一輪

- **之前**（http）：`index.html` → 主 JS（171.87 kB）→ 執行後 `Promise.all([createTangentClient(...)（同步）, loadLocale(locale)])`；zh-TW 時 `loadLocale` 動態載入 `zh-TW` 字典 chunk（11.2 kB gzip），**render 本來就要等這一輪**；英文字典在主 chunk 裡，`loadLocale` 立即 resolve。
- **之後**：主 JS（159.72 kB）→ 執行後同時開始 `import("./frame/http-client")`（Vite 的 `__vitePreload` 同時抓它與 16 個共用 chunk，共 17 個檔、19.2 kB gzip，見建置產物主 JS 的 `__vite__mapDeps` 清單）與字典 chunk。
  - **zh-TW（使用者實際用的）**：用戶端與字典在同一輪平行下載，render 等兩者都到，**沒有多一輪**；主 JS 少 12 kB，這一輪多下載 19 kB（拆成 17 個小檔，HTTP/2 下同一輪）。
  - **英文**（`?lang=en` 或瀏覽器語言非中文）：之前不需要等任何 chunk，**現在多一輪**（主 JS 執行後才開始抓用戶端）。mock 模式一直都是這樣。若之後要消掉，可以在 `index.html` 對 `http-client` chunk 加 `modulepreload`（要動 Vite 設定或 plugin，這次沒做）。
- API 請求的種類、順序與次數不變：用戶端建好之前本來就不會發任何請求。

### 首屏實測（建置產物、模擬 100 ms 延遲、5 Mbps）

暫存的 Playwright 設定（不在版本庫）：e2e 的 `api` 伺服器（fake runner），基線與本次的 http 建置各用兩種伺服器提供——`vite preview`（HTTP/1.1，每個主機 6 條連線）與一個暫存的 Node HTTP/2 靜態伺服器（自簽憑證，`/api` 轉給同一個 API 伺服器並加 token）。Chrome 以 CDP 模擬 100 ms 延遲、5 Mbps，開 `/?lang=…&line=<id>`，每組 3 次（3 次幾乎相同，下表取中間值）。「首個 /api」是第一個 API 請求開始的時間，「輸入框」是輸入框可見的時間（都從 `goto` 起算）。

| 情境 | 基線 首個 /api | 本次 首個 /api | 基線 輸入框 | 本次 輸入框 |
|---|---:|---:|---:|---:|
| zh-TW、HTTP/2 | 1,910 ms | 1,934 ms（+24） | 3,779 ms | 3,783 ms（≈ 0） |
| en、HTTP/2 | 1,700 ms | 1,822 ms（+122） | 2,063 ms | 2,460 ms（**+397**） |
| zh-TW、HTTP/1.1 | 861 ms | 1,146 ms（+285） | 1,869 ms | 2,800 ms（**+931**） |
| en、HTTP/1.1 | 712 ms | 1,028 ms（+316） | 1,578 ms | 2,536 ms（**+958**） |

（暫存的 HTTP/2 伺服器傳主 JS 比 `vite preview` 慢，兩欄的絕對值不能互比，只比同一列的前後。）

原因：
- 用戶端程式碼在 http 模式的首屏**本來就一定要用**（首屏的 16 個方法與 SSE），所以這個做法並沒有少下載，而是把它從主 JS 移到主 JS 執行後才開始的一輪；而且拆成 17 個檔（`http-client` 與 16 個被 lazy 對話框共用的 normalizer chunk），分開壓縮後首屏要下載的總量反而多了約 7 kB（主 JS 159.72 ＋ 用戶端 19.18 ＝ 178.9 kB，基線 171.87 kB）。
- HTTP/1.1 每個主機只有 6 條連線，17 個小檔排隊，把字典與之後的 lazy chunk、API 請求一起往後推。
- 英文字典在主 JS 裡，原本不用等任何 chunk；現在要等用戶端那一輪。

試過用 Vite 的 `manualChunks` 把用戶端的模組併成一個 chunk 來減少請求數（暫存設定）：規則會把主 chunk 也用到的模組一起併進去，結果主 JS 反而靜態 import 那個 chunk（`index.html` 多一個 `modulepreload`）——這只是把主 JS 拆成兩個平行的檔，首屏成本沒變，放棄。逐一把 16 個共用 chunk 併回用戶端（F20a 的拆檔法）需要拆 `wire.ts`、`line-normalize.ts`、`branch-normalize.ts` 等被幾十個 lazy chunk 共用的模組，工程大且仍會留下幾個共用 chunk，沒有做。

## 三條路（請協調者選）

| | http 主 JS | mock 主 JS | 首屏 | 變更量 |
|---|---:|---:|---|---|
| **A. 現在 worktree 裡的狀態**（demo 動態載入 HTTP 用戶端） | **159.72** | 159.74 | 見上表：中文 HTTP/2 不變，其餘慢 0.4–0.96 秒 | 小（`main.tsx`＋4 個搬移檔） |
| **B. 工單的方向**：`createTangentClient` 首屏核心（27 個方法）＋其餘 76 個方法延遲載入 | 理想上限 **168.23**（實測：直接把 76 個方法從 `createTangentClient` 刪掉、不留任何延遲載入的殼，建置一次）；實際會更高：延遲方法的殼約 76 × 25 B，且 F20a 的模組規則會讓與首屏 normalizer 同檔的其他 normalizer 留在主 chunk，要再拆十幾個檔 | 不變 | 不變（首屏方法都在主 chunk） | 大（約 100 個方法改寫、十幾個檔拆分） |
| **C. 退回 A 的 `main.tsx` 部分，只留拆檔** | 171.80 | 159.70 | 不變 | 極小 |

B 達不到 165 的原因：首屏會呼叫的方法已經涵蓋大部分 normalizer（見「首屏會呼叫哪些方法」），http 主 JS 比 mock 多的 12 kB 裡，非首屏的部分最多約 3.6 kB。要再降，得從主 chunk 的其他部分找（mock 與 http 共同）：用「所有 `import()` 外部化」量到的下限，主 chunk 目前還有約 8.4 kB gzip 只有 lazy chunk 才用的程式碼（`@floating-ui/utils` 的 DOM 工具 4.7 kB minified 拆不開；第一方的 `branch-input`、`conversation/models`、`memo-hooks`、`branch-queries`、`capabilities`、`chapter-hooks`、`memory/slots`、`queries`、`stale-dismissed`、`aside-leaf`、`ask-templates` 合計約 7.5 kB minified，F20a 的拆檔法估計可省約 2–2.5 kB gzip）。B＋這些拆檔估計約 166–167 kB。

退回成 C 的指令：`git checkout web/apps/demo/src/main.tsx && rm web/apps/demo/src/frame/http-client.ts`（其餘拆檔可留可退，留著 http 171.80、mock 159.70；CHANGELOG 的 F20b 一段要跟著改）。

## 行為不變的依據

- `createTangentClient` 的程式碼、`TangentClient` 型別、方法名稱、參數、回傳型別與錯誤行為都沒有動；`api.ts` 的差異只有 import 來源與 `normalizeBaseUrl` 的位置。
- `client`、`react` 兩個套件 `index.ts` 的匯出名稱：`node docs/devlog/P0/exports.mjs` 在基線與完成後各輸出一次（暫存目錄），**完全相同**（client 1045 列、react 608 列）。
- client 的 vitest：基線 1310 支、23 支預期失敗（B24／B25 的契約樣本：`route.terms.*`、`event.terms.changed`、`route.imports.*`、`route.lines.import.batch`、`route.lines.list.pinned`、`route.capabilities*`、`route.lines.export`、`errors.test.ts` 的錯誤碼清單、mock 契約的對應項目）；完成後一樣 1310 支、23 支失敗，**失敗清單逐行相同**（`diff` 無輸出）。`contract.test.ts` 其餘每條路由的請求（method、path、headers、body）與回應比對照舊通過。
- 沒有改任何測試、元件、DOM、`aria-*`、i18n key、`localStorage` 鍵；沒有新增 Suspense 或載入中的畫面（`main.tsx` 在 render 之前就等用戶端，和 mock 模式一樣）。

## 試過但放棄的

| 做法 | 結果／原因 |
|---|---|
| 只改 `main.tsx` 動態載入 | 0 變化（172.00）：`normalizeBaseUrl` 把 `api.ts` 留在主 chunk，見第 2 步 |
| 直接 `await import("@tangent/client")` | 不會分 chunk：`@tangent/client` 的 `index.ts` 本來就在主 chunk，動態 import 它只會拿到主 chunk 的 namespace。所以需要 `frame/http-client.ts` 這個只轉出 `createTangentClient` 的小檔 |
| 把 `createTangentClient` 拆成「首屏核心＋依領域延遲載入」 | 沒有實作。首屏會呼叫的 16 個方法已涵蓋大部分 normalizer，估計只能降到約 167 kB（見上），達不到 165；而且要讓約 70 個方法改成先等 chunk 再送請求（`fetch` 晚一個 chunk 才發、`keepalive` 的刪除在頁面關閉時可能來不及載入、chunk 失敗要轉成錯誤）。工單允許量測後改用更簡單、風險更低的做法 |
| 失敗訊息用較長的句子 | mock +37 B gzip；縮短到 `"Tangent: no client"` 仍 +13 B。最後保留可讀的訊息，改用第 5 步補回 |

## 留下的

- **首屏變慢**（見「首屏實測」）：英文介面多一輪；HTTP/1.1 下兩種語言都受 17 個小檔排隊影響。這是選 A 的代價，需要協調者決定。
- **用戶端 chunk 下載失敗時頁面是空白的**，console 有說明，重新整理即可；這和主 JS 本身下載失敗、或 mock 模式的用戶端失敗相同。沒有加錯誤畫面（工單不允許新增畫面）。
- `errors.ts` ↔ `error-response.ts` 是循環 import（後者用前者的 `TangentError`，前者轉出後者），只在函式內使用，ESM 與 Rollup 都沒問題，與 F20a 的 `capabilities.ts` ↔ `capabilities-normalize.ts` 同型。
- 嵌入者：`@tangent/client` 的 API 沒有變；想要同樣的效果可照 demo 的做法（見 `CHANGELOG.md` 的 F20b「嵌入者注意」）。用 `import()` 對 Vite、Rollup、webpack、esbuild 都是標準做法。
- 之後的工單：主 chunk 用到的模組不要再 import `createTangentClient` 所在的 `api.ts`，也不要把只有 HTTP 用戶端用的 helper 放進主 chunk 用到的模組（否則 http 建置的主 JS 會一次回升約 12 kB）；量 bundle 時兩種模式都量。

## 驗收（A 的狀態）

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過（fonts、e2e、client、react、demo） |
| `npx vitest run`（各套件分別執行） | fonts 10/10（1 檔）、react 1049/1049（98 檔）、demo 335/335（52 檔）；client 1310 支、1287 通過、23 失敗，**失敗清單與基線逐行相同** |
| 匯出名稱（`node docs/devlog/P0/exports.mjs`，輸出到暫存目錄比對） | client、react 與基線相同 |
| `pnpm -C web build`（mock） | 通過；主 JS `index--ZEOauP4.js` 492.23 kB／**gzip 159.74 kB**；JS 209 個 |
| `VITE_TANGENT_API=http pnpm -C web build` | 通過；主 JS `index-Du5NOVir.js` 492.14 kB／**gzip 159.72 kB**；JS 208 個 |
| Playwright `E2E_ONLY=mock npx playwright test --project=mock --workers=2` | **181 passed、3 skipped、0 failed**（9.4 分鐘，一次跑完）。mock project 跑 Vite dev server，驗的是行為 |
| Playwright `E2E_ONLY=api npx playwright test --project=api --project=api-core --workers=2` | 92 passed、61 skipped、4 failed（5.8 分鐘）。4 支單獨重跑（`--workers=1`）：`f6.spec.ts:77`、`f7.spec.ts:186`、`notes.spec.ts:120` 通過（第一次是 5 秒逾時：`article[data-tg-message]` 數量、刪除對話框）；`f5-c2.spec.ts:69` 仍失敗——axe `target-size`（`.gap-1 > …bg-tg-primary` 的按鈕），**在基線程式（暫時還原本次所有檔案）上同樣失敗**，與本次無關 |
