# F20a · 主 JS 瘦身（F20 任務四第 2 點提前做）

> 2026-11-13。基線 commit `5b52d7d`，獨立 worktree。只改 `web/packages/client`、`web/packages/react` 與 `docs/`；沒有改任何 Go 檔、Vite 設定、`tsconfig`、相依套件或 `manualChunks`；`apps/demo` 的原始碼一行沒改。

## 結果

| | 前 | 後 | 差 |
|---|---:|---:|---:|
| 主 JS gzip（`pnpm -C web build` 印的，預設＝mock 模式） | **170.51 kB** | **158.57 kB** | **−11.94 kB** |
| 主 JS raw | 528.62 kB | 488.91 kB | −39.71 kB |
| 主 JS gzip（`VITE_TANGENT_API=http` 的建置，參考） | 175.83 kB | 170.57 kB | −5.26 kB |
| JS chunk 數（`dist/assets/*.js`） | 184 | 201 | +17 |
| source map 對得到的主 chunk minified 位元組（attribution 腳本） | 519,681 B | 479,793 B | −39,888 B |
| 其中第一方程式 | 244,176 B | 204,346 B | −39,830 B |

- 每檔的前後：`docs/devlog/F20a/main-chunk-by-file.before.txt`、`main-chunk-by-file.txt`（`docs/devlog/P0/main-chunk-attribution.mjs` 重跑；P0 的基線檔沒動）。
- http 模式之前就已經超過 172 kB（175.83），P0 量的是預設的 mock 建置，沒有發現這件事。這次兩種模式都降了，http 模式降得少，因為 `createTangentClient` 在 http 模式本來就要在主 chunk 帶齊所有讀回應的 normalizer（見「留下的」）。
- 新增的 17 個 chunk 都是幾百位元組到 2.2 kB 的共用 chunk（`line-normalize` 2.19、`b18-routes` 1.30、`suggested-tags` 1.22、`chapters` 0.80、`p2-hooks` 0.67、`p1` 0.67、`branch-view` 0.63、`p3-hooks` 0.55、`types` 0.53、`p2` 0.49、`branch-move` 0.48、`note-mutations` 0.47、`f8-turns` 0.46、`branch-tree` 0.41、`b17-routes` 0.39、`folds` 0.34、`wire` 0.31 kB gzip）。變大的既有 chunk：`branch-flows` 28.53 → 30.41（結論卡編輯器與草稿流程搬進來）、`import-dialog` 82.32 → 83.84（逐字稿解析）、`relation-dialog` 1.61 → 2.17、`stale-badge` 1.40 → 1.76、`memo-flows` 6.51 → 6.77。

## 主 chunk 為什麼帶著這些程式碼

Rollup 以「模組」為單位分 chunk：一個模組只要有任何一段程式碼留在主 chunk，**它被任何 lazy chunk 用到的其他 export 也全部跟著留在主 chunk**，而且那些程式碼引用到的模組也一路被拉進來。量法：把所有 `import()` 改成外部（只剩主程式自己需要的程式碼）再建一次，跟正常建置逐模組比。基線時這個「主程式自己需要」的下限是 150.05 kB，差的 20 kB 幾乎都是 lazy chunk 才用、卻因為上面的規則被帶進主 chunk 的程式碼。

所以這次的做法只有兩種，都不改邏輯：

1. **`/* @__PURE__ */`**：`@tangent/client` 沒有 `"sideEffects": false`，模組最上層有 `Array.from`、`[...].sort().map().join()`、`.flatMap()`、`new RegExp(...)` 的常數，Rollup 判斷不出沒有副作用，整個模組就留下。標上註記（`new Set(Array.from(...))` 裡外兩層都要標）。
2. **把主程式真正用到的那幾個 export 搬到一個小檔，原檔 `export { … } from` 轉出**。原檔變成只有 lazy chunk 用，就整個離開主 chunk。所有既有的 import 路徑（含測試的 `./xxx`）與兩個套件 `index.ts` 的匯出名稱都不變。

## 逐項（依實作順序；gzip 是每一步建置後的主 JS，minified 是 attribution 腳本的前後差）

| # | 做法 | 主 JS gzip | 離開主 chunk 的（minified B） |
|---|---|---:|---|
| 1 | `import-transcript.ts` 四個 RegExp 與 `LABEL_WORDS`、`suggested-tags.ts` 的 `FUNCTION_CHARS` 標 `@__PURE__` | 170.51 → 167.00（−3.51） | `import-transcript` 3,818、`b18-routes` 2,686、`suggested-tags` 1,901 |
| 2 | `DRAFT_*` 三個常數搬到 `branch-draft-timing.ts`（主 chunk 的 `branch-queries.ts` 只用 `DRAFT_POLL_MS`，卻把草稿流程與整個結論卡 reducer 拉進來） | → 165.67（−1.33） | `branch-card` 3,563、`branch-draft-flow` 1,590 |
| 3 | B17 的卡片狀態與後續支線規則（`cardState`、`isoMicros`、`canAnchorBranch`、`editedCardSource` 等）搬到 `b17-card-state.ts`（`b17-routes.ts` 的卡片編輯結果 normalizer 把 `branch-normalize`、`line-normalize` 拉進來） | → 163.68（−1.99） | `branch-normalize` 3,433、`line-normalize` 3,208、`b17-routes` 1,195、`tag-normalize` 159 |
| 4 | `useFolds` → `react/data/fold-query.ts`；`useCreateBranch`（＋`invalidator`）→ `create-branch.ts`；章節的顯示函式（`chapterTitle`、`chapterRange`、`chaptersByStart` 與兩個私有 helper）→ `client/chapter-display.ts` | → 162.30（−1.38） | `p2-hooks` 1,699、`p3-hooks` 1,337、`branch-mutations` 2,399、`chapters` 2,648 |
| 5 | `cutChars` → `cut-chars.ts`；`seedFromText`、`hasInbox`、`inboxCount`、`SEED_TEXT_MAX`、`SEED_FROM_MESSAGE_CHARS` → `p1-inbox.ts`；`isHostNotice`、`asideDaysLeft`、`ASIDE_RETENTION_DAYS`、`classifyOpenBranchError` → `branch-notice.ts` | → 161.32（−0.98） | `f8-turns` 792、`p1` 1,377、`branch-view` 2,060 |
| 6 | `card-text.ts` 的 `PROTOCOL_MARKERS` 標 `@__PURE__`；`noteFromText` → `note-from-text.ts`；`branchPath` → `branch-path.ts`；`cardEditReasons` → `card-edit-reasons.ts`；偏題提示（`driftOf`、`driftByMessage`）→ `p2-drift.ts`；`canTag`、`foldSpans` → `fold-spans.ts`；`DEFAULT_MEMO_LIMITS` → `memo-limits.ts` | → 159.37（−1.95） | `card-text` 522、`notes-page` 948、`branch-tree` 899、`stale-reasons` 1,089、`p2` 1,216、`folds` 841、`memo-routes` 538、`types` 865 |
| 7 | `normalizeCapabilities`（＋三個私有 helper）→ `capabilities-normalize.ts`，`capabilities.ts` 轉出 | → 159.03（−0.34） | `capabilities` 698、`wire` 666 |
| 8 | `BRANCH_MOVE_MAX` → `branch-move-limit.ts`；`useCreateNote`（＋兩個快取 helper）→ `react/data/create-note.ts` | → 158.57（−0.46） | `branch-move` 728、`note-mutations` 1,490 |

新檔加起來在主 chunk 佔 5,571 B minified（它們本來就在主 chunk，只是換了檔名）。每個新檔開頭都有一段註解說明為什麼獨立出來、由哪個原檔轉出。

`main.tsx` 在 attribution 裡少了 1,203 B：這是 Vite 的 `__vitePreload` 依賴表算在 `main.tsx` 頭上，mock 用戶端的依賴改成新的共用 chunk 後表的內容變了；`main.tsx` 本身沒有改。

## 行為不變的依據

- 只是搬移宣告（連同原本的註解）與加 `@__PURE__` 註記，沒有改任何函式本體。被 `@__PURE__` 標的運算式都是純計算（字串陣列排序、建 RegExp／Set），結果不變。
- 兩個套件的匯出名稱：`node docs/devlog/P0/exports.mjs` 重跑（`bash docs/devlog/P0/fingerprint.sh <暫存目錄>`），`web-exports-client.txt`、`web-exports-react.txt` 與版本庫的**完全相同**；`contract-sha256.txt` 也相同。指紋輸出放在暫存目錄，版本庫裡的基線檔沒有動。（`go-api-domain.txt` 與基線不同，是 B26 `4b24c30` 改了 domain 的文件，P0 的基線早於它；這次沒有改 Go。）
- 沒有新增任何 `lazy()`、Suspense 或 fallback，也沒有改任何元件：DOM、`aria-*`、`data-*`、class、i18n key、`localStorage` 鍵、快捷鍵都不受影響；不會有新的版面跳動或焦點變化。
- 首屏請求：http 模式下這些程式碼仍在主 chunk（`createTangentClient` 需要）。mock 模式下 normalizer 改放在 mock 用戶端 chunk 的共用依賴裡，由 Vite 的 preload 與 mock chunk **平行**下載（mock chunk 本來就是首屏前的那一次動態載入，`main.tsx` 的 `Promise.all`），沒有多一層瀑布。其他搬出去的程式碼只在對應的 lazy chunk 用到，原本就要等那個 chunk。
- **沒有改任何測試**（也沒有改等待方式）。

## 試過但放棄的

| 做法 | 結果／原因 |
|---|---|
| `api.ts` 的 `normalizeBaseUrl` 搬到獨立檔 | 主 JS 0 變化（`api.ts` 留在主 chunk 的只有這個函式，它本身沒有把 normalizer 拉進來），還原 |
| 反過來把 lazy 的部分搬出去、主程式那一半留在原檔並轉出 | 第一次試 `branch-view.ts` 時沒有效果，原因是 `p1.ts`、`f8-turns.ts` 的 lazy 函式還引用它；先拆 `p1`、`f8-turns` 之後就能用。第 7 項（capabilities）就是這個方向，確認 `export { … } from` 本身不會把目標模組拉進主 chunk |
| 給 `@tangent/client` 加 `"sideEffects": false` | 用 Rollup 的 `moduleSideEffects` 模擬，效果與第 1 項的 PURE 註記相同（166.99 vs 167.00），但改的是套件的建置語意，影響所有宿主；照 B21 的慣例用註記 |
| 英文字典的功能專屬字串跟著 lazy chunk 走 | 沒做：要逐 key 搬到 `MessageBundle` 並改使用處的 translator，會動到之後的前端工單要改的元件；而這次不碰字典就已經達標 |
| `BackgroundReplyToast`、`SelectionToolbar` 改延遲載入 | 沒做：各約 0.5 kB gzip，第一次出現會晚一點，而且要改 `shell.tsx`／`conversation-view.tsx` |
| `EmbedFrame` 延遲載入 | 不做：`?frame=embed` 的首屏會多一次瀑布式請求 |
| `@floating-ui/utils` 的 DOM 工具（主 chunk 只用 714 B，lazy 的 popover 用其餘約 4.8 kB 未壓縮） | node_modules 的單一模組，不改套件就拆不開 |

## 留下的

- **http 模式的主 JS 是 170.57 kB**，離 172 只剩 1.43 kB。`createTangentClient` 是一個大工廠，靜態 import 所有路由的 normalizer；要再降得讓各路由的 normalizer 延遲載入（改 client 的結構），或讓 http 模式的用戶端也像 mock 一樣動態 import。建議之後的工單量 bundle 時兩種模式都量。
- 量測工具：主程式真正需要的下限（所有 `import()` 外部化）mock 模式約 150.1 kB、http 模式約 161.4 kB（皆基線時量）。目前 mock 模式 158.57，剩下的差距大多是 0.1–0.3 kB 的小塊：`branch-input`、`models.ts` 的 `groupPreviewBlocks`、`memo-hooks`、`branch-queries`、`chapter-hooks`、`aside-note`、`memory/slots`、`queries.ts` 的 `useSearch`、`stale-dismissed`，以及 Base UI／floating-ui／react-query 內部。量法（暫存的 Vite 設定，不在版本庫）：加一個 `resolveDynamicImport` 回傳 external 的 plugin 建一次，再用 `generateBundle` 把每個模組的 `renderedLength` 寫出來比對。
- `capabilities.ts` ↔ `capabilities-normalize.ts` 是循環 import（後者讀前者的常數，前者轉出後者的函式）。只在函式內使用，ESM 與 Rollup 都沒問題，vitest 也全綠；若之後覺得不好讀，可以把 `FEATURE_NAMES` 等常數再拆一個檔。
- 之後新增程式碼的注意事項：主 chunk 用到的模組裡，不要再放只有對話框或側欄才用、而且會 import 大型 normalizer 的 export；最上層用 `Array.from`、`.map()`、`new RegExp(...)` 算出來的常數要標 `/* @__PURE__ */`。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過 |
| `npx vitest run`（各套件分別執行） | fonts 10/10、client 1252/1252（91 檔）、react 1028/1028（96 檔）、demo 292/292（47 檔） |
| `pnpm -C web build` | 通過；主 JS `index-L_yQUyLv.js` 488.91 kB／**gzip 158.57 kB**；JS 201 個 |
| 匯出指紋 | client、react 兩份與基線相同 |
| Playwright `E2E_ONLY=mock npx playwright test --project=mock --workers=2`（在 `web/e2e`） | **175 passed、3 skipped、0 failed**（9.9 分鐘，一次跑完，沒有重跑）。注意：mock project 跑的是 Vite dev server，不是建置後的 chunk，所以它驗的是行為，不是分 chunk 的結果 |
