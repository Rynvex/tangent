# P0 · 基準數字、行為指紋、功能盤點與體檢現況

- **日期**：2026-11-13
- **工單**：工單
- **基線**：commit `99e7901`（工單文件以外沒有程式碼差異）
- **性質**：只量測、只寫文件。沒有改任何 `.go`、`web/` 原始碼、migration 或契約樣本；`git status --short` 只有 `docs/devlog/P0/` 與本檔。
- **邊界遵守**：沒有對 `:8120` 送任何請求；沒有啟動任何會呼叫模型的東西；開發資料庫（`:5444` 的 `tangent`）只用 `select count(*)` 之類的唯讀查詢；Go 測試用的是 `tangent_test`（每個測試一個新 schema）；沒有碰 宿主、`:5183`。

## 0. 摘要

| 項目 | 結果 |
|---|---|
| Go 靜態 | `go vet` 乾淨、`gofmt -l .` 無輸出、`sqlc diff` 無差異 |
| `go test ./... -count=1` | **通過**。16 個套件 ok；測試 1,270 個 PASS（含子測試；頂層 1,150）、0 FAIL、**6 SKIP**（原因見 §2.2）；DB 測試真的跑了；牆鐘 79 s |
| `pnpm -C web typecheck` | 通過（27 s） |
| vitest（逐一套件） | fonts **10**、client **1,252**、react **1,028**、demo **262**，合計 2,552，全部通過 |
| `pnpm -C web build` | 通過（21 s）。主 JS `index-BodfqNKx.js` **526.98 kB / gzip 170.07 kB**（170,067 B），上限 172 kB，餘裕 1.93 kB。JS chunk 184 個、CSS 4 個 |
| 效能（`go test -run TestPerf`） | 全部在預算內；BeginTurn p95 15.82 ms、CompleteTurn 9.94 ms、ListBranches 6.08 ms、MergeBranch 13.5 ms、MoveToBranch 13.8 ms、PromoteBranch 60.9 ms（預算 80 ms）、Search 14.55 ms、Fisheye 18.08 ms。**量測時機器有負載，僅供參考** |
| Playwright e2e、`scripts/smoke.sh` | **沒跑，待協調者補跑**（§6） |
| 487 則對話捲動實測 | **沒做，留給 F20 任務一**（§6） |
| 體檢 27 項 | 已處理 **7**、部分 **8**、未處理 **11**、未確認 **1** |
| 體檢 G1–G10 | 已處理 **4**、部分 **5**、未處理 **1** |

最需要注意的三件事：

1. **主 JS 是 170.07 kB，不是工單寫的 169.1 kB**（相差 +0.97 kB）；距離上限 172 kB 只剩 1.93 kB。往主 chunk 加任何功能都會很快碰頂（§2.5、§4.3）。
2. **網址完全不同步**：`web/apps/demo/src` 裡唯一的 `history.*` 呼叫是 `shell.tsx:109` 的 `replaceState`（只用來清掉 `?focus=`）；沒有 `pushState`、`popstate`。G8 與體檢 #22 都是「未處理」。
3. 功能軌要決定「預設關閉」的候選：開發資料庫裡有資料的只有 `leaf`（2）、`relations`（13）、匯入與資料夾（14 篇有資料夾，其中 14 篇的訊息時間戳完全相同，符合匯入特徵）；其餘功能都是 0 筆（§4）。

## 1. 環境與限制

- worktree：`<worktree>/t3-31df4807`；分支 `t3/31df4807`；Go 與 pnpm 版本用機器上現有的（未改動）。
- `web/node_modules` 原本不存在，執行了 `pnpm -C web install --frozen-lockfile`（306 個套件、2 s；lockfile 沒有變動，`git status` 乾淨）。
- 機器負載：本機同時有其他 agent 與其他專案的容器在跑。各階段開始時的 `uptime`：

  | 時間 | 階段 | load average（1 / 5 / 15 分） |
  |---|---|---|
  | 01:27 | 開工 | 2.12 / 1.38 / 2.55 |
  | 01:28 | `go test ./...` | 2.71 / 1.61 / 2.59 |
  | 01:29 | 前端 typecheck / vitest | 2.87 / 2.39 / 2.80 |
  | 01:31 | **perf 第一次** | **7.95 / 4.85 / 3.66** |
  | 01:32 | perf（`TANGENT_PERF_P3=1`） | 6.50 / 4.76 / 3.67 |
  | 01:42 | 收尾 | 14.44 / 14.19 / 9.39 |

  所以 §2.1–§2.4 的耗時、§2.6 的 p95 都受干擾，**只能當相對參考**；測試通過與否、數量、gzip 大小不受影響。
- 16 核、62 GB 記憶體。

## 2. 基準數字

### 2.1 Go 靜態

| 指令 | 結果 |
|---|---|
| `go vet ./...` | exit 0，無輸出 |
| `gofmt -l .` | 無輸出 |
| `~/go/bin/sqlc diff` | exit 0，無輸出（`store/db` 與查詢一致） |

### 2.2 Go 測試

指令：`go test ./... -count=1 -v`（加 `-v` 只為了計數；結果與不加相同）。exit 0，牆鐘 79 s。

| 套件 | 結果 | 耗時 |
|---|---|---|
| `tangent`（根） | ok | 76.2 s |
| `store` | ok | 45.9 s |
| `httpapi` | ok | 23.3 s |
| `cmd/tangent-eval` | ok | 11.7 s |
| `scripts/soak` | ok | 3.9 s |
| `examples/embedding` | ok | 3.6 s |
| `cmd/tangent-server` | ok | 2.5 s |
| `tangenttest/seed` | ok | 1.3 s |
| `examples/minimal-host` | ok | 1.2 s |
| `runner/cli` | ok | 1.2 s |
| `tangenttest` | ok | 0.6 s |
| `domain` | ok | 0.3 s |
| `runner/internal/httpstream` | ok | 0.15 s |
| `runner/openai` | ok | 0.09 s |
| `runner/fake` | ok | 0.08 s |
| `runner/anthropic` | ok | 0.03 s |
| `store/db` | 沒有測試檔 | — |

- `--- PASS` 共 **1,270** 行（頂層 1,150、其餘是子測試）、`--- FAIL` 0、`--- SKIP` **6**。`func Test*` 以 grep 數到 1,157 個（比 PASS＋SKIP 的頂層 1,156 多 1，來源沒有追；不影響結論）。
- **DB 測試真的跑了**：`tangenttest/db.go:35` 預設連 `localhost:5444/tangent_test`，`:5444` 可連（`pg_isready` accepting），6 個 SKIP 裡沒有任何「資料庫連不上」。根套件 76 s、`store` 46 s 也說明了這點。
- 6 個 SKIP 與原因（都是刻意的，需要環境變數才會跑）：

  | 測試 | 位置 | 啟用方式 |
  |---|---|---|
  | `TestPerf_MemoryRecallWithinBudget` | `perf_memory_test.go:34` | `TANGENT_PERF_MEMORY=1` |
  | `TestPerf_BranchTurnWithRebalance` | `perf_test.go:303` | `TANGENT_PERF_P1=1` 或 `TANGENT_PERF_P2=1` |
  | `TestSearch_Explain` | `store/search_explain_test.go:17` | `TANGENT_PERF_EXPLAIN=1`（印查詢計畫） |
  | `TestPromote_Explain` | `store/promote_explain_test.go:16` | `TANGENT_PERF_EXPLAIN=1` |
  | `TestRealModelSmoke` | `cmd/tangent-server/realsmoke_test.go:19` | `TANGENT_REAL_SMOKE=1`＋真 API key（**付費，沒有跑**） |
  | `TestRealCLISmoke` | `runner/cli/smoke_test.go:22` | `TANGENT_CLI_SMOKE=claude\|codex\|agy`（**會用訂閱額度，沒有跑**） |

### 2.3 前端型別與測試

| 關卡 | 指令 | 結果 |
|---|---|---|
| 型別 | `pnpm -C web typecheck` | 通過（4 個專案，27 s） |
| fonts | `cd web/packages/fonts && npx vitest run` | **10** 通過（1 檔，1 s） |
| client | `cd web/packages/client && npx vitest run` | **1,252** 通過（91 檔，3 s） |
| react | `cd web/packages/react && npx vitest run` | **1,028** 通過（96 檔，21 s） |
| demo | `cd web/apps/demo && npx vitest run` | **262** 通過（44 檔，19 s） |

合計 2,552 個測試、0 失敗、0 skip。（工單提到的 e2e 另計，見 §6。）

### 2.4 建置

`pnpm -C web build`（= 各套件 build；demo 是 `tsc --noEmit && vite build`）：exit 0，21 s（vite 本體 8.28 s），3,447 個模組。`dist` 28 MB，其中 981 個是字型切片（woff2）。

完整清單（184 個 JS＋4 個 CSS，依 gzip 大小）在 `docs/devlog/P0/build-chunks.txt`。重點：

| 檔案 | raw kB | gzip kB | 備註 |
|---|---:|---:|---|
| **`index-BodfqNKx.js`（主 JS，index.html 載入的唯一 script）** | 526.98 | **170.07** | 上限 172 kB |
| `index-oz4hy16K.css`（主 CSS） | 302.85 | 56.11 | |
| `import-dialog-CwgnS4pC.js` | 271.97 | 82.28 | 匯入對話框（含 f14 心智圖、解析器） |
| `katex-cpmb43yU.js` | 261.85 | 77.92 | 數學式，按需 |
| `markdown-impl-D16B-bgR.js` | 176.80 | 54.56 | Markdown 渲染，按需 |
| `index-BN6ulJq0.js` | 159.64 | 52.50 | mock 用戶端（`@tangent/client/testing`；只有 `VITE_TANGENT_API` 不是 `http` 時才載入，`main.tsx:34`） |
| `branch-flows-CvF49KNL.js` | 94.34 | 28.49 | 開支線／結論卡等流程對話框 |
| `f8-slots-Cquku8n_.js` | 38.47 | 13.58 | 搜尋列、匯出、快捷鍵說明 |
| `branch-map-FCjBkwaz.js` | 36.66 | 12.51 | 地圖 |
| `zh-TW-BmMJg8Rq.js` | 31.26 | 11.33 | 繁中字典（英文字典在主 chunk） |
| `focus-pane-5HKdhQAa.js` | 29.45 | 10.67 | 專注模式 |
| `f13-host-DXOAk5D7.js` | 30.02 | 10.32 | 匯入／拆解的宿主 |
| `conversation-list-QFyet7e8.js` | 28.88 | 9.45 | 對話清單 |
| `tc-CaCUGD30.css` | 476.69 | 71.62 | 中文字型 `@font-face`（延遲） |

- 三個「gzip」數字的關係：Vite 印的 170.07 kB＝Node `zlib.gzipSync` 預設等級的 170,067 B；`gzip -9` 是 169,823 B；brotli 是 143,017 B。HANDOFF／devlog 用的是 Vite 這個數字。
- **動態載入點**：`lazy()` / `import("…")` 在非測試的原始碼共 79 處；扣掉 highlight.js 語言（24）、katex、字型、mock/gallery、zh-TW 字典 後是 **49 處（42 個不同目標）**。工單寫的是 48，差 1，這裡以我的方法為準（清單：`grep -rEn "\blazy\(|[^a-zA-Z]import\(\"" web/packages web/apps --include=*.ts --include=*.tsx`）。

### 2.5 主 chunk 裡有什麼

用 source map 把主 chunk 的位元組對回原始檔（`docs/devlog/P0/main-chunk-attribution.mjs`；結果 `docs/devlog/P0/main-chunk-by-file.txt`）。單位是 minified 位元組（不是 gzip；gzip 約為 0.33 倍）。總計 518,084 B 可對應。

| 來源 | minified B | 比例 |
|---|---:|---:|
| `react-dom` | 180,852 | 34.9% |
| 第一方程式（共 142 個檔） | 242,574 | 46.8% |
| `@tanstack/query-core` | 33,167 | 6.4% |
| `@base-ui/react`（＋utils） | 24,777（＋4,219） | 4.8% |
| `lucide-react` | 15,986 | 3.1% |
| `react`、`scheduler`、`@floating-ui`、`react-query` | 8,268＋3,648＋2,324＋2,269 | 3.1% |

第一方程式裡最大的：`shell.tsx` 15,117、`i18n/en.ts` 12,672、`message-list.tsx` 12,361、`conversation-view.tsx` 9,978、`i18n/en.branch.ts` 8,268、`message-actions.tsx` 6,260、`event-sync.ts` 5,718、`main.tsx` 5,628、`side-resizer.tsx` 5,615。**英文字典全部在主 chunk**（`i18n/en*.ts` 合計 28,167 B，約佔第一方的 11.6%）；只有繁中字典是延遲載入。功能別的歸屬見 §4。

### 2.6 效能（`perf_test.go`）

入口：`go test -run 'TestPerf' -count=1 -v .`（`perf_test.go` 檔頭註解：預算樹是 2,000 則訊息的主線＋200 條支線，最深 6 層；預設只記錄數字，`TANGENT_PERF_ASSERT=1` 才會超標就失敗；`TANGENT_PERF_P1/P2/P3` 加開功能；`TANGENT_PERF_SCALE=1` 量 10 棵樹的搜尋）。第一次（預設功能）牆鐘 16.2 s；**量測時 load average 7.95**。

| 操作 | n | p50 | p90 | **p95** | 預算 p95 |
|---|---:|---:|---:|---:|---:|
| BeginTurn | 100 | 13.61 ms | 15.09 ms | **15.82 ms** | 60 ms |
| CompleteTurn | 100 | 7.49 ms | 8.86 ms | **9.94 ms** | 30 ms |
| ListBranches（200 支線） | 100 | 4.21 ms | 5.20 ms | **6.08 ms** | 30 ms |
| PreviewTurn | 100 | 11.20 ms | 13.14 ms | **14.66 ms** | — |
| MergeBranch | 30 | 10.43 ms | 13.37 ms | **13.50 ms** | 80 ms |
| MoveToBranch | 30 | 11.19 ms | 12.61 ms | **13.80 ms** | 80 ms |
| PromoteBranch | 20 | 36.19 ms | 51.61 ms | **60.90 ms** | 80 ms |
| Search（1 棵樹，7 種查詢合計） | 196 | 11.80 ms | 14.35 ms | **14.55 ms** | 80 ms |
| Fisheye（主線） | 100 | 15.23 ms | 17.24 ms | **18.08 ms** | 40 ms |
| Fisheye（深支線） | 100 | 7.62 ms | 8.55 ms | **8.95 ms** | 40 ms |
| BeginTurn（含 fisheye） | 100 | 17.88 ms | 19.79 ms | **20.62 ms** | 60 ms |

- Search 各查詢的 p95：「分岔」14.55、「龍貓」12.71（0 筆）、「分岔對話」11.66、「benchmark」14.68、「效能 latency」12.92、「deploy」14.53、「nowhere to be found」12.48 ms。
- 第二次加 `TANGENT_PERF_P3=1`（開 goal、relations、group、ibis、fold 等；load 6.50）：BeginTurn p95 15.92 ms、CompleteTurn 15.36 ms（vs 9.94）、MergeBranch 28.00 ms（vs 13.50）、MoveToBranch 14.48 ms、PromoteBranch 63.69 ms、Fisheye 20.53／10.52 ms、BeginTurn（fisheye）22.88 ms。**全部仍在預算內**，但 CompleteTurn 與 MergeBranch 在開滿功能時大約變成 1.5–2 倍（受負載干擾，量級僅供參考）。`TestPerf_BranchTurnWithRebalance` 與 `TestPerf_MemoryRecallWithinBudget` 在這兩次都是 SKIP：前者要 `TANGENT_PERF_P1=1` 或 `TANGENT_PERF_P2=1`（`perf_test.go:303`，只設 P3 不夠），後者要 `TANGENT_PERF_MEMORY=1`。
- 原始輸出沒有存進 repo；要重現請照上面的指令跑。

## 3. 三組行為不變的指紋

存放在 `docs/devlog/P0/`，一支腳本重產：

```bash
# 從 repo 根目錄；需要 Go 與 `pnpm -C web install`（為了 typescript）
bash docs/devlog/P0/fingerprint.sh                 # 覆寫 docs/devlog/P0/ 的基準檔
# 重構之後比對：
d=$(mktemp -d) && bash docs/devlog/P0/fingerprint.sh "$d" && diff -r docs/devlog/P0 "$d" | grep -v '^Only in docs/devlog/P0'
# 輸出為空＝三組指紋都沒變
```

| 檔案 | 內容 | 行數 |
|---|---|---:|
| `contract-sha256.txt` | `httpapi/testdata/contract/` 每個檔案的 SHA-256（路徑排序） | 210 |
| `go-api-tangent.txt` | `go doc -all github.com/Rynvex/tangent` | 2,552 |
| `go-api-domain.txt` | `go doc -all …/domain` | 4,007 |
| `go-api-store.txt` | `go doc -all …/store` | 2,387 |
| `go-api-httpapi.txt` | `go doc -all …/httpapi` | 253 |
| `web-exports-client.txt` | `web/packages/client/src/index.ts` 匯出的名稱，每行 `名稱<TAB>value\|type`，排序 | 1,030 |
| `web-exports-react.txt` | `web/packages/react/src/index.ts` 匯出的名稱 | 599 |

- 匯出清單用 TypeScript compiler API（`docs/devlog/P0/exports.mjs`）展開所有 `export *`，value／type 的分類看符號有沒有值的語意。
- **確認可重現**：連續跑兩次，`diff -r` 沒有任何差異（只有 repo 內多出的腳本檔）。
- 注意：`go doc -all` 的輸出也包含註解，所以只改註解也會讓指紋變；比對時要看差異是不是註解。要純簽名可以另加 `-short`（本次沒有做，維持工單寫的 `go doc -all`）。
- 其他存放在 `docs/devlog/P0/` 的量測檔：`build-chunks.txt`（§2.4）、`main-chunk-by-file.txt` 與 `main-chunk-attribution.mjs`（§2.5）。

## 4. 功能盤點表

### 4.1 怎麼讀這張表

- **預設**：參考伺服器的 `defaultFeatures`（`cmd/tangent-server/config.go:290-291`）：`notes,chapters,aside,summary:suggest,card_draft,branch_suggest:suggest,search,leaf:suggest,parking,spinoff,rebalance:suggest,goal:suggest,relations:suggest,open_loops,group:suggest,ibis:suggest,fold:suggest,diverge:manual,memo`；**不含 `memory`、`fisheye`**（註解 `config.go:283-286`）。（工單寫的 `:8120` 開了 `memory`、`fisheye`、embedder fake、`summary:manual`：因為不能對 `:8120` 送請求，**這點沒有重新確認**；開發資料庫的 `tangent_feature_migrations` 有 `memory`、`search` 兩筆，與「memory 在 `:8120` 開過」不矛盾。）
- **筆數**：開發資料庫 `tangent` 的 `select count(*)`（2026-11-13 查，唯讀）。總量：`tangent_line` 19（16 條主線＋3 條支線）、`tangent_message` 697（user 346、assistant 349、branch_card 2）、`tangent_branch` 3（`investigate` 類；2 merged、1 open）。`pg_stat_user_tables` 的 `n_live_tup` 全是 0（統計沒更新），所以一律用 `count(*)`。
- **入口**：在 `web/` 實際找到的位置（M＝訊息動作／選單、S＝側欄分頁、P＝命令面板、C＝對話選單／標頭、D＝對話框／其他位置）。命令面板共 18 條 `palette: true` 的命令（`packages/react/src/shortcuts/commands.ts`）。**設定頁**：每個啟用的功能在設定對話框都有一列，但在真 API 模式下只是顯示（模式由宿主決定，`settings-host.tsx:49` 只有 mock 才能切換），所以下表不把它算進入口。
- **主 chunk**：§2.5 的位元組對應，以檔名規則歸屬功能（`docs/devlog/P0/main-chunk-by-file.txt` 可自己再分）。單位是 minified B。**這只算「專屬檔案」**：`shell.tsx`、`conversation-view.tsx`、`message-list.tsx`、`message-actions.tsx` 這些把各功能接起來的共用檔不分配到功能（合計約 44 kB minified）；字典也另列。「lazy」＝元件在延遲載入的 chunk（括號內是 gzip kB，來自 `build-chunks.txt`）。
- **測試**：Go 是頂層 `func Test…` 名稱符合功能關鍵字的個數；web 是名稱符合關鍵字的測試檔內的 `it(`／`test(` 數。**關鍵字是啟發式**（例如 `memo` 排除 `memory`），可能多算少算幾個，只拿來比較量級。關鍵字寫在 `docs/devlog/P0-baseline-inventory.md` 本表之後的「測試關鍵字」。
- **每輪成本**：功能開啟時，一個**主線已完成的 AI 回合**多出的工作。依 `feature_*.go` 的掛勾讀出；「查詢」＝同一回合內多的資料庫讀取次數，「job」＝掛一個背景 AI 呼叫（付費）。數字來自 `domain/limits.go` 預設值。

### 4.2 表

| 功能（EXTENSIONS 順序） | 預設 | 開發 DB 筆數（表） | 介面入口 | 主 chunk 專屬位元組／元件所在 | 測試 Go／web | 每輪成本（功能開啟時） |
|---|---|---|---|---|---|---|
| `notes` 紀要 | 開 | **0**（`tangent_note`）；`notes_revision>0` 的線 0 | 6：M「記進紀要」、S「紀要」分頁（`side-tabs-model.ts:15`）、P `notes.add`、結論卡的紀要提案（`note-proposals.tsx`）、順口問「留為紀要」（`branch-header.tsx:68`）、專注模式節點面板 | **2,939 B**（`note-mutations.ts` 1,490、`notes-page.ts` 948、`note-actions.ts` 501）；面板 lazy `notes-side`（3.40）；字典 `en.notes.ts` 2,715 | 37／74 | 1 查詢（`ActiveNotes`，`feature_notes.go:27`）＋回合寫入時 1 次更新（`MarkNotesRevisionSent`）；0 job；prompt 加紀要區塊，上限 **2,000 token**（`Notes.TokenBudget`），0 筆時為空 |
| `chapters` 章節 | 開 | **0**（`tangent_chapter_cut`）；章節切點多半由閒置間隔推導，不存表 | 3：轉錄裡的章節分隔線（`chapter-divider.tsx`）、結構頁章節清單（`structure/chapter-list.tsx`）、拆解／匯入時的章節（`f13/decompose-sections.tsx`）；無 P／設定入口 | **7,881 B**（`chapters.ts` 2,648、`chapter-strip.tsx` 1,923、`chapter-divider.tsx` 1,123、`time-gaps.ts` 1,046、`chapter-hooks.ts` 597、`time-gap-divider.tsx` 544）——**全在主 chunk，沒有延遲載入** | 29／31 | 主線每回合 1 查詢（`ReplyCount`）；回覆數 ≥ `ChapterCutMinMessages/2` 後再 1 查詢（`ListChapters`）；回覆帶 `[CHAPTER]`／`[TOPIC]` 時 1 次寫入（`RecordTopicCut`）；0 job；prompt 在需要切章時多一條 `[CHAPTER]` 規則 |
| `aside` 順口問 | 開 | **0**（`tangent_branch` 全是 `investigate`，aside 0 條） | 4：選取文字的「順口問」（`quick-ask.ts`／`selection-toolbar.tsx`）、開支線對話框的種類（`open-branch-dialog.tsx`）、行內卡片（`aside-inline-card.tsx`）、偏題提示（`drift-hint.tsx`） | **3,067 B**（`ask-templates.ts`×2 共 2,174、`aside-note.ts` 405、`quick-ask.ts` 283、`aside-leaf.ts` 205）；行內卡片 lazy（2.47） | 14／9 | 0（只有維護任務清除過期的順口問） |
| `summary` 滾動摘要 | `suggest` | **0**（`tangent_line.summary` 全為空） | 2：「摘要到期」提示（`summary-due-host.tsx`，lazy 0.68）、手動 `StartSummary`（壓縮） | **1,453 B**（`topic-summary.ts`）；字典另計 | 53／15 | prompt 帶摘要（讀線上欄位，**0 查詢**）；每回合 1 次「是否到期」判斷（`summaryDue`，歷史超過 16,000 token 觸發）；`suggest` 只發事件，`auto` 才起 1 個 job |
| `card_draft` 結論卡草稿 | 開 | **0**（`tangent_branch.draft_status` 3 筆都是 `none`） | 1：結論卡審閱對話框的「請 AI 濃縮結論草稿」（`review.askAi`） | 0（卡片審閱 lazy：`branch-card` 3.04、`branch-flows` 28.49） | 1／44 | 0（只在使用者按鈕時 1 個 job） |
| `branch_suggest` | `suggest` | **0**（沒有訊息帶 `meta.suggestions`） | 1：回覆下方的建議支線（`branch-suggestions.tsx`） | 0 專屬（元件在 `assistant-message`／`message-list` 共用檔內） | 5／0（有 5 個測試檔提到它） | **0 查詢、0 job**；prompt 多一條 `[BRANCH-SUGGEST]` 規則（`prompt_build.go:215`，約一小段固定文字）；回覆多一次解析 |
| `leaf` 收尾 | `suggest` | **2**（`tangent_leaf`，都是 `conclusion`） | 3：捨棄支線對話框的收尾（`discard-branch-dialog.tsx`）、結構頁的收尾列（`outline-row.tsx`）、`branch-leaf` 卡 | **359 B**（`leaf-cache.ts`）；`branch-leaf` lazy 2.44 | 20／11 | 0（關支線時：捨棄或升主線 → 1 個起草 job） |
| `spinoff` 獨立成新對話 | 開 | **0**（`tangent_link` 沒有 spinoff 類；`origin_capsule` 全空） | 3：M「從這裡開新對話」、專注模式節點面板、支線標頭（`branch-header.tsx:52`）；對話框 `spinoff-dialog.tsx` | **934 B**（`spinoff-origin.tsx`）；流程在 `branch-flows` lazy | 12／32 | 0 |
| `parking` 念頭停車場 | 開 | **0**（`tangent_seed`） | 6：輸入框的停車鍵（`composer.tsx`）、M「停車」、P `composer.park`、待處理分頁的種子區、批次種子（`listToSeeds`）、支線標頭 | **925 B**（`park-actions.ts` 666、`park-hooks.ts` 259）；`seed-expand` lazy 2.99 | 20／7 | 0 |
| `memo` 備忘 | 開 | **0**（`tangent_memo`） | 4：M「備忘」、專注模式節點面板、S「備忘」分頁（紀要關時）、順口問收尾 | **1,442 B**（`memo-hooks.ts` 573、`memo-routes.ts` 538、`memo-host.ts` 331）；`memo-flows` lazy 6.48 | 16／11 | 0（不進 prompt、預覽與背景工作） |
| `rebalance` 樹平衡提示 | `suggest` | **0**（`tangent_suggestion` 全表 0） | 1：支線標頭的提示條（`branch-header.tsx:26`） | 0 專屬 | 10／0（5 個測試檔提到） | **支線**每回合 1 查詢（`RebalanceSignals`）；達門檻才寫 1 筆建議；0 job；主線與順口問為 0 |
| `fisheye` 魚眼脈絡 | **關** | **0**（無專屬表；derived） | 2：送出前預覽的魚眼區（`preview-fisheye.tsx`）、地圖的魚眼資料（`map-fisheye-data.ts`）；另 `pinned-mark.tsx` | **516 B**（`pinned-mark.tsx` 303、`pin-hooks.ts` 213） | 18／9 | **取代預設歷史挑選**：≥3 次查詢（訊息、`FisheyeTree`、引用；有 `ibis`／`group` 時再加）；0 job；實測 BeginTurn p95 20.62 ms vs 預設 15.82 ms（+約 4.8 ms，§2.6） |
| `group` 群組摘要 | `suggest` | **0**（`tangent_group`、`_member`） | 4：結構頁群組清單（`group-list.tsx`）、地圖群組（`map-groups-data.tsx`）、多選動作（`selection-actions.tsx`）、建立群組對話框（`use-group-form`，lazy 1.98） | 0 專屬（`group-list` 隨結構面板 lazy） | 22／69 | 0（關支線時 → 1 個分群建議 job） |
| `relations` 關聯線 | `suggest` | **13**（`tangent_link`，全是 `relation`／`related`） | 5：M「關聯」、結構頁關聯區（`relations-section`，lazy 3.41）、地圖關聯圖層（`relation-layer.tsx`）、專注模式節點面板、匯入組裝步驟 | **3,623 B**（`p2-hooks.ts` 1,699、`p2.ts` 1,216、`en.p2.ts` 708，與 goal 共用） | 32／22 | 0（關支線時：1 次 `FisheyeTree` 查詢＋最多 1 個關聯建議 job） |
| `goal` 對話目標 | `suggest` | **0**（`tangent_goal`） | 2：標頭的目標膠囊（`shell.tsx:489`→`goal-host`，lazy 3.03）、偏題提示（`drift-hint.tsx`，host lazy 1.19）；無 P 入口 | 0 專屬（在 `p2-hooks.ts` 內，見 relations） | 19／16 | **每回合 1 查詢**（`GoalOfRoot` 進 prompt，`feature_goal.go:59`）；prompt 多目標一行（≤300 字元）；主線第 2 則回覆（無目標時）與之後每 **4** 則回覆：多 1 次 `ReplyCount`＋`GoalOfRoot` 並起 **1 個 job**（提議目標／偏題檢查） |
| `open_loops` 未完成清單 | 開 | **0**（無專屬表；只讀查詢） | 3：待處理分頁（`inbox-panel.tsx`）、回顧畫面（`review-host`，lazy 4.35）、P `review.open` | 0 專屬（`p1.ts` 1,377＋`suggestion-query.ts` 172 與收件匣共用） | 4／34 | 0 |
| `memory` 跨對話記憶 | **關** | **0**（`tangent_memory`） | 4：紀要分頁底部（`memory-footer`，lazy 0.75）、記憶庫（`memory-library`，lazy 4.27；P `memory.open`）、輸入框上的記憶提示（`memory-recall`，lazy 0.76）、支線的記憶提示 | **484 B**（`memory/slots.tsx`） | 36／30 | **每回合 1 次 embedding 呼叫**（`embedOne`，`:8120` 是 fake；真 embedder 要付費）＋1 次候選查詢（`Candidates` 50、`TopK` 5）；prompt 加記憶區塊，上限 **1,500 token**；收尾／卡片時再起 1 個抽取 job |
| `ibis` 論證類型 | `suggest` | **0**（`tangent_message_tag`） | 5：M「標論證類型」子選單、訊息上的類型徽章（`arg-tag`，lazy 1.36）、待處理最上面的 `ArgReviewCard`、地圖類型圖層（`map-tags-data.ts`）、專注模式節點面板 | **1,496 B**（`p3-hooks.ts` 1,337、`tag-normalize.ts` 159）；外殼 `p3-slots.tsx` 893（與 fold／diverge 共用） | 10／0（6 個測試檔提到） | 每第 **3** 則回覆（`Every:3`）：1 查詢（`IbisCandidates`）＋**1 個 job**（一批 ≤12 則、每則 ≤800 字元）；prompt 不變 |
| `diverge` 發散／收斂 | `manual` | **0**（`tangent_comparison`） | 3：M「給我幾個方向」、P `diverge.models`、分岔標記與比較表（`diverge-marker`，lazy 2.86） | 0 專屬（外殼見 `p3-slots`） | 22／14 | 0（使用者操作時才起 diverge／converge job） |
| `fold` 折疊 | `suggest` | **0**（`tangent_fold`） | 3：M「從這則起折疊」、折疊區塊（`fold-block`，lazy 1.89）、送出前預覽的折疊區（`preview-folds.tsx`） | **841 B**（`client/folds.ts`）；外殼見 `p3-slots` | 39／11 | **每回合 1 查詢**（`LiveFolds`）；有折疊時歷史改用摘要（**減少** token）；每第 **10** 則回覆多 1 個建議 job（還要通過 `SuggestMinMessages 8`、`SuggestMinTokens 1000`） |
| **`search`**（B5） | 開 | 無專屬表；索引 `idx_tangent_message_content_trgm`（`pg_trgm`），可搜 **697** 則 | 3：對話清單的伺服器搜尋（`conversation-list.tsx:248`）、對話內搜尋 ⌘F（`in-tree-search.tsx`，P `search.inTree`，標頭按鈕）、對話選單（手機） | 0 專屬（清單 lazy 9.45；搜尋列隨 `f8-slots` lazy 13.58） | 30／18 | 0（純使用者觸發；寫入時多維護 trigram 索引，非每輪查詢） |
| **匯入**（B18–B22、F13–F17） | 核心 | 無標記欄位；**14 條對話的訊息 `created_at` 全部相同**（含 487 則那條），符合匯入特徵——**推測**，資料庫沒有專用的匯入標記 | 3：清單的匯入鈕（`f13-frame.ts` → `import-dialog`，lazy **82.28**）、拆解面板（`decompose-panel`）、對話選單的拆解（`onDecompose`）；無 P 入口 | **13,619 B**（`import-transcript.ts` 3,818、`f13-frame.ts` 2,827、`b18-routes.ts` 2,686、`b17-routes.ts` 1,195、`last-import.ts` 858、`f13-slots.tsx` 830、`undo-words.ts` 727、`range-highlight.tsx` 678）；`import-parsers.ts` 在 `import-dialog` 內 | 58／187 | 0（客戶端解析；伺服器端只在使用者匯入時一次性寫入。AI 分析是使用者按鈕觸發的付費 job，不在回合內） |
| **資料夾與標籤**（B18） | 核心 | **14** 條對話有 `folder`（全是「雜談」）、**0** 條有標籤 | 3：清單的資料夾／標籤篩選與整理（`list-organize.tsx`）、`folder-tags-popover`（lazy 2.81）、對話選單 | **1,901 B**（`suggested-tags.ts`） | 21／24 | 0 |

**測試關鍵字**（Go 用 `grep -P` 比對頂層測試函式名；web 比對測試檔路徑，不分大小寫）：

| 功能 | Go | web 檔路徑 |
|---|---|---|
| notes | `Note` | `note` |
| chapters | `Chapter` | `chapter` |
| aside | `Aside` | `aside` |
| summary | `Summary\|Compact` | `summary` |
| card_draft | `CardDraft` | `card-draft\|card-review\|branch-card` |
| branch_suggest | `BranchSuggest` | `branch-suggest` |
| leaf | `Leaf` | `leaf` |
| spinoff | `Spinoff` | `spinoff` |
| parking | `Park\|Seed` | `park\|seed` |
| memo | `Memo(?!ry)` | `memo(?!ry)` |
| rebalance | `Rebalance` | `rebalance` |
| fisheye | `Fisheye` | `fisheye` |
| group | `Group` | `group` |
| relations | `Relation\|Link` | `relation` |
| goal | `Goal\|Drift` | `goal\|drift` |
| open_loops | `OpenLoop` | `open-loop\|inbox\|review-` |
| memory | `Memory\|Embed\|Recall` | `memory` |
| ibis | `Ibis` | `ibis\|arg-` |
| diverge | `Diverge\|Converge\|Comparison` | `diverge\|compar` |
| fold | `Fold` | `fold` |
| search | `Search` | `search` |
| 匯入 | `Import` | `import` |
| 資料夾與標籤 | `Folder\|LineTag\|Tags` | `folder\|tag` |

### 4.3 從表看出來的事

- **沒有資料的功能**（開發資料庫 0 筆）：`notes`、`chapters`、`aside`、`summary`、`card_draft`、`branch_suggest`、`spinoff`、`parking`、`memo`、`rebalance`、`fisheye`、`group`、`goal`、`open_loops`、`memory`、`ibis`、`diverge`、`fold`；另外標籤 0。有資料的只有 `leaf`（2）、`relations`（13，全是 `related`）、匯入（推測）與資料夾（14）。**這 18 個「0 筆」多半是因為開發資料庫的 16 條對話幾乎都是匯入來的「雜談」**，不代表功能沒人用，但代表**這份資料沒辦法驗證它們的 UI 在真資料上的樣子**。
- **每輪都要付成本的功能**（主線回合一定多查詢或多 prompt）：`notes`（1 查詢＋≤2,000 token）、`goal`（1 查詢＋目標一行；每 4 則回覆 1 個 job）、`fold`（1 查詢）、`chapters`（1–2 查詢）、`branch_suggest`（固定 prompt 一段）、`summary`（到期判斷）。**每輪會多花錢（job）的**：`goal`（每第 4 則）、`ibis`（每第 3 則）、`fold`（每第 10 則，有條件）、`summary` 在 `auto`（預設是 `suggest`，不會自動花錢）、`memory`（embedding，另外收尾時 1 個 job）。預設伺服器設定下（`ibis:suggest`、`goal:suggest`、`fold:suggest` 都開著），**一條 40 則回覆的主線大約會多出 10＋13＋4 ≈ 27 個背景 AI 呼叫**（goal 約 40÷4＝10 次、ibis 約 40÷3＝13 次、fold 約 40÷10＝4 次；只是粗估，沒有量過；fold 與 goal 還有前置條件，實際會少一些）。這是功能軌決定「預設關閉」時最需要的一個數字。
- **留在主 chunk 的專屬程式碼**（minified B）：匯入 13,619、章節 7,881、`relations/goal` 3,623、順口問 3,067、紀要 2,939、資料夾標籤 1,901、論證類型 1,496、摘要 1,453、備忘 1,442、停車 925＋spinoff 934、折疊 841、魚眼／釘選 516、記憶 484、收尾 359。加起來約 **41.5 kB minified（約 13.7 kB gzip 量級）**，另有英文字典 28.2 kB、`p3-slots` 外殼 0.9 kB。**最大的單項是匯入（13.6 kB）與章節（7.9 kB）**——它們是核心行為，但程式碼不在延遲載入的 chunk 裡；匯入的對話框本身是 82 kB gzip 的 lazy chunk，只有 `f13-frame.ts`、`import-transcript.ts`、`b17/b18-routes.ts` 這些膠水在主 chunk。
- **缺少測試的點**：`rebalance`（web 0、5 個檔案提到）、`ibis`（web 專屬 0）、`branch_suggest`（web 0）。

## 5. 體檢現況（`docs/design/UI_AUDIT_2026-10.md`）

判定以**現在的程式碼**（HEAD `99e7901`）為準；devlog（`F8-web.md`、`B15-F9-polish.md`、`F10-simple-ux.md`、`F12-ux-polish.md`）只當線索。**沒有開瀏覽器實測**（沒有跑 Playwright、沒有截圖），所以標「視覺結果」的地方是由程式碼推斷，會寫明「未實測」。檔案路徑都相對於 `web/`。

### 5.1 27 項

| # | 項目 | 狀態 | 依據（我實際看過的檔案與行號） |
|---|---|---|---|
| 1 | 論證類型下拉每則都有 | **已處理**（F8 S1） | `packages/react/src/p3/arg-tag.tsx:41` `if (!current) return null;`，元件註解（:25-31）：沒有類型就不顯示、從「⋯」設定；AI 草稿是虛線徽章＋「待確認」，確認動作在 hover／focus（:45-61）；觸控改在動作表（`conversation/message-menu.tsx:199` `SheetTagRow`） |
| 2 | 訊息動作列太多 | **已處理**（F8 S1） | `packages/react/src/conversation/message-actions.tsx:147-160` `messageActionModel`：回覆固定 3 個（開支線、停車或釘選、複製），其餘進「⋯」；觸控是 `message-menu.tsx:268` 的底部動作表；`:102`、`:193` 的按鈕 `tabIndex={-1}`、`:165` 的 `onToolbarKey` 是方向鍵工具列 |
| 3 | 頂列（375 觸控、支線）溢出與優先權 | **部分** | `apps/demo/src/frame/center.tsx:60-86`：窄螢幕下仍是獨立按鈕（專注、動作選單、大綱、設定各一顆）；已做的只有：窄螢幕且有動作選單時把「對話內搜尋」收進選單（:67）、目標膠囊在窄寬給 `compact`（`shell.tsx:492`）、路徑 `min-w-12`（:63）。**沒有**把「⋯／設定／大綱」合併成一個選單，也沒有「路徑優先於目標」的明確規則；375 是否仍溢出：未實測 |
| 4 | 結論卡審閱底部列（420／375） | **未處理**（依 flex 規則推斷，未實測） | `packages/react/src/branch/card-review/branch-card-review.tsx:72-90` `Footer`：仍是單一 `flex flex-wrap` 一列，說明文字是 `min-w-2 flex-1`（basis 0，不會觸發換行就被擠窄），主按鈕在最右（DOM 最後）但沒有「窄寬時說明移到按鈕上方」的處理；「改成不帶回…」仍是第一顆 |
| 5 | 失敗訊息與重試 | **未處理** | `conversation/assistant-message.tsx:150` `<Failed reason={message.meta.error ?? ""}>`、`:50-60` 顯示 `message.failed {reason}`＝伺服器原文；`error-text.ts:15-44` 的錯誤碼對照只用在「請求失敗」，不用在失敗的回覆；`message-list.tsx:341` 只有最後一則可重試，舊失敗卡沒有合併成「第 n 次嘗試」 |
| 6 | 文案小修（a 唯讀支線空狀態／b 0 天後清除／c 停止） | **部分**（只做了 c） | (c) `assistant-message.tsx:40` `StoppedEmpty`＋`i18n/zh-TW.ts:135` `reply.stopped`「已停止・沒有回答」；(a) `apps/demo/src/frame/conversation-view.tsx:316` 仍用 `message.empty`（`i18n/zh-TW.ts:148`「還沒有訊息。在下方輸入第一則。」），不分是否可寫；(b) `i18n/f12-messages.ts:116`、`zh-TW.branch.ts:113` 仍是「{days} 天後清除」，`client/src/branch-view.ts:126` 會夾成 0 → 仍顯示「0 天後清除」 |
| 7 | AI 草稿的用語不一致 | **部分** | 論證類型已改成短版「待確認」（`i18n/f8-messages.ts:156` `ai.draftShort`、`p3/arg-tag.tsx:47`）；但仍有四種說法：「AI 草稿・待你確認」（`i18n/dialog-messages.ts:114`、`p1-messages.ts:133` 收尾）、「AI 建議・待確認」（`p2-messages.ts:257` 關聯）、「AI 提議」（`dialog-messages.ts:161`，使用處 `note-proposals.tsx:29`）、`p3-messages.ts:95` 的 `tag.aiDraft`「AI 標・待確認」已沒有使用處 |
| 8 | 命令面板與快捷鍵說明 | **已處理**（F8） | `packages/react/src/shortcuts/commands.ts`：18 條 `palette: true`（新對話 `conversation.new`、跳到支線 `nav.toBranch`、匯出 `export.open`、主題 `theme.toggle`、回顧 `review.open`、記憶庫 `memory.open`、對話內搜尋、`shortcuts.help` 等）；`Shift+?` 開快捷鍵說明（`commands.ts:42`、`apps/demo/src/frame/f8-frame.tsx:48`、`shortcuts-dialog.tsx`）。觸控時隱藏鍵位提示：未確認 |
| 9 | 對話與支線改名 | **部分** | 對話：`apps/demo/src/frame/conversation-menu.tsx:21-23, 67`＋`rename-conversation.tsx`（選單的「改名…」）已有。支線：只有大綱的 F2（`structure/outline-tree.tsx:27, 125`）與專注模式節點標題雙擊（`focus/node-title.tsx:141`）；一般模式的大綱列或支線條上**沒有看得見的入口** |
| 10 | 側欄地圖沒有符合畫面 | **已處理** | `structure/branch-map.tsx:202`「Decision #10: on first open only — fit when the tree is wider or taller than the canvas」，`:233` `fit`、`:417` 的 `map.fit` 按鈕與 `autoFitted` 標記 |
| 11 | 大綱底部「群組 0／關聯 0」一直顯示 | **未處理** | `structure/structure-panel.tsx:174` 無條件渲染 `GroupList`、`:175` 在 `relationsOn` 時渲染 `RelationsSection`；`groups/group-list.tsx:119` 的「0 筆就隱藏」只在傳了 `lineId` 時成立，這裡沒傳，所以 `:127` 顯示 `groups.empty`；`p2/relation-list.tsx:189` 同理。地圖操作說明是否仍一直顯示：未確認 |
| 12 | 送出前預覽擠壓對話欄 | **未處理** | `apps/demo/src/shell.tsx:355-361`（`previewDocked` 在 ≥ tablet、非專注時為 true）、`:561-564` 停靠面板；全檔對 `previewOpen` 沒有任何收起側欄的動作（`setSideOpen` 只在 `:268, 306, 317, 325, 337, 416, 473-474` 被呼叫，都與預覽無關） |
| 13 | 支線條（375）太高 | **未處理** | `branch/branch-bar.tsx:114-123`（按鈕仍是 `flex flex-wrap` 排開）、`:157-183`（標題、狀態、分岔點仍多行）；沒有「窄寬只留主按鈕」或「捲動時縮成一行」。高度是否仍約 250 px：未實測 |
| 14 | 狀態列蓋到內容 | **已處理**（依程式碼；未實測） | `apps/demo/src/frame/conversation-view.tsx:294-296`：`StatusBanner` 是 `flex-col` 區段的第一個子元素（文件流內），`layout/status-banner.tsx:78-85` 的 `Bar` 是普通區塊（`border-b`），不是浮層 |
| 15 | 章節分隔線資訊太長 | **未處理** | `client/src/chapters.ts:79` 起的 `formatStamp` 仍帶 `year: "numeric"`，`:101-106` `chapterRange` 仍是「起 - 迄」；`conversation/chapter-divider.tsx:30-31` 的 `meta` 仍是 `#a–b・起 - 迄`；沒有隱藏年份、沒有窄寬簡化 |
| 16 | 只開核心時側欄標題貼邊 | **已處理** | `layout/side-tabs.tsx:19` `BAR = "flex h-13 …"`，`:44-48` 單分頁時標題用同一個 `BAR`（`h-13`、`px-4`、`items-center`），與標頭 `h-13`（`center.tsx:61`）對齊 |
| 17 | 回顧與待處理動作不一致 | **部分** | 入口補上了：待處理分頁 `inbox/inbox-panel.tsx:294`（`review.open`）、命令 `review.open`（`commands.ts:47`）。種子動詞已一致（`p1-messages.ts:174, 178` 與 `review-messages.ts:64-65`：展開成支線／丟掉）。但開太久的支線仍不同：收件匣 `p2-messages.ts:280-281`「繼續／結束並帶回」，回顧 `apps/demo/src/frame/review-messages.ts:57, 64`「結束／繼續」。打開回顧時側欄是否切換：未確認 |
| 18 | 發散與比較的設定區 | **未處理** | `p3/diverge-marker.tsx:98-102`：只要可寫就一直顯示勾選＋條件輸入，`<textarea rows={2}>`（:102）；沒有「已有比較表就收成重新比較」 |
| 19 | 記憶庫卡片一直是編輯狀態 | **未處理** | `apps/demo/src/frame/memory-card.tsx:74`、`:84` 兩個 `<select>`、`:94` `<input type="date">` 常駐；沒有閱讀／修改兩態 |
| 20 | 搜尋結果摘錄顯示 Markdown 原文 | **未處理** | `apps/demo/src/frame/conversation-search.tsx:14-18`、`packages/react/src/f8/in-tree-search.tsx:65-73` 直接用 `hit.snippet`；在 `store/search*.go`、`domain/search*.go` 也沒有找到去 Markdown 的處理（`grep -i markdown\|strip` 無結果） |
| 21 | Tab 巡覽停駐點過多、↑↓ 移動 | **部分** | 訊息動作列改成單一停駐點：按鈕 `tabIndex={-1}`（`message-actions.tsx:102, 193`）＋方向鍵工具列（`:165` `onToolbarKey`，註解「Tab stops once」）。**沒有**「↑↓ 在訊息之間移動」（`conversation/*.tsx` 無方向鍵處理）、**沒有** skip link／「跳到輸入框」（全 `packages`、`apps` 搜 `skip.?link`、`跳到輸入框` 無結果；只有 `shell.tsx:365` 的 `focusComposer`，由大綱 Esc 觸發）、F6 區域切換：未找到 |
| 22 | 網址與上一頁（demo） | **未處理** | `grep -rn "pushState\|popstate\|hashchange"` 在 `web/packages`、`web/apps`（排除測試）**無結果**；`apps/demo/src` 唯一的 `history.*` 是 `shell.tsx:109` `replaceState`（只清 `?focus=`）。`navigate`（`shell.tsx:171`）不寫網址 |
| 23 | mock 的情境二（學習 Rust）是空的 | **未處理** | `packages/client/src/testing/scenario-nas.ts:277` 只有 `mainLine("rust", …)` 的線資料；`:423` `messages: [...MAIN_MESSAGES, ...BRANCH_MESSAGES]` 只有 NAS 的訊息；沒有 Rust 的論證類型、折疊、發散、比較表、記憶資料 |
| 24 | 首屏與字型 | **部分** | 主 JS 從體檢時的 177 kB 降到 **170.07 kB**（§2.4）。字型：`packages/fonts/scripts/build.mjs:74-75` 先用系統字（PingFang、Heiti、Songti、Noto CJK 的 `local()`）、`:121-122` Noto Sans TC 只保留單一字重當字形後備、`apps/demo/src/frame/fonts.ts:23` 延遲載入；但 `dist` 裡仍有 **981 個 woff2**，其中 IBM Plex Sans TC 三個字重各約 177–188 片、Noto Serif TC 另有；實際首屏請求數、輸入框出現時間：未量（需要瀏覽器與節流） |
| 25 | 長對話 | **部分** | 有 `content-visibility:auto`＋`contain-intrinsic-size`（`conversation/message-list.tsx:652`）、列的 memo（`:573`）、選單延遲載入（`message-actions.tsx:80`）、2,000 列串流 500 個 delta 的效能測試（`message-list.perf.test.tsx:23-24`）。**沒有列表虛擬化**（全 `packages`、`apps` 搜 `virtual` 只有 `conversation-list.tsx:19` 的 floating 虛擬錨點，與列表無關）。487 則實測：**沒做，留給 F20 任務一** |
| 26 | 輸入框長草稿 | **已處理** | `conversation/composer.tsx:140`：`max-h-[40vh] … [field-sizing:content]`，超過在框內捲動 |
| 27 | 支線 token 膠囊顯示 0 | **未確認** | 這是 mock 種子資料的問題（體檢自己也標「推測」）。`scenario-nas.ts` 的線資料只有主線設了 `usage`（:271, 276-278），支線線資料我沒有逐一看；真 API 的支線用量要連真資料庫才能確認，本次不能對 `:8120` 送請求。膠囊本體：`apps/demo/src/frame/usage-control.tsx:67` |

統計：**已處理 7**（#1、#2、#8、#10、#14、#16、#26）、**部分 8**（#3、#6、#7、#9、#17、#21、#24、#25）、**未處理 11**（#4、#5、#11、#12、#13、#15、#18、#19、#20、#22、#23）、**未確認 1**（#27）。

### 5.2 G1–G10

| # | 建議 | 狀態 | 依據 |
|---|---|---|---|
| G1 | 編輯已送出的訊息、重新產生回覆 | **已處理**（F8 S6／S7） | `conversation/message-actions.tsx:151`（`editBranch`）、`:157`（`regenerate`、`diverge`）；`packages/react/src/f8/edit-branch-dialog.tsx`、`f8/regenerate-dialog.tsx`；流程在 `apps/demo/src/frame/branch-flows.tsx`。做法是從前一則開「另一條路」支線，與體檢建議一致（不覆蓋原本那段） |
| G2 | 完整匯出 | **已處理**（F8） | `apps/demo/src/frame/export-dialog.tsx:202`；`packages/client/src/tree-export.ts:231`（完整報告 Markdown）、`:254`（備份 JSON）、`:265`（ADR）、`:343`（閃卡）；P `export.open`（`commands.ts:45`） |
| G3 | 對話改名、釘選對話 | **部分** | 改名：`conversation-menu.tsx:21-23`＋`rename-conversation.tsx`。釘選：`apps/demo/src/frame/pinned-roots.ts:9` `PINNED_ROOTS_KEY = "tangent:pinned-roots:v1"`，**只存在瀏覽器 localStorage**，不跨裝置、不在後端 |
| G4 | 快捷鍵說明、命令面板當導覽器 | **已處理** | 同 #8（18 條命令、`shortcuts-dialog.tsx`、`nav.toBranch` 跳到支線）；「跳到紀要條目」未見 |
| G5 | 對話內搜尋（含折疊與支線） | **已處理**（F8 S3） | `packages/react/src/f8/in-tree-search.tsx`、`apps/demo/src/frame/f8-slots.tsx:7, 26`；P `search.inTree`（`Mod+F`）；`FoldBlock.forceOpen` 讓命中折疊內時展開（F8 devlog 所述，我看到 `fold-block.tsx` 存在，未逐行驗證 `forceOpen`） |
| G6 | 第一次使用的引導 | **部分** | `apps/demo/src/frame/empty-guide.tsx:1-25`：空對話下方有三張靜態提示卡（選取發問、備忘、停車）；沒有「可以點的示範」 |
| G7 | 一次確認 AI 草稿 | **部分** | 論證類型有：`inbox/inbox-panel.tsx:281` 的 `ArgReviewCard`（全部確認、逐一看，`f8-messages.ts:34-37` 的 `inbox.undo`）；收尾草稿、紀要提案沒有批次（`note-proposals.tsx` 逐條） |
| G8 | 網址同步與深連結 | **未處理** | 同 #22：沒有 `pushState`／`popstate`；套件也沒有 `onNavigate` 讓宿主接路由（`HeaderProps.onNavigate` 只是麵包屑點擊，`center.tsx:42`） |
| G9 | 可以復原的操作 | **部分** | 有復原：備忘（`focus-messages.ts:215` `memo.undo`）、拆解／匯入（`f13-messages.ts:162` `decompose.undo`、`f14/undo-run`）、論證類型批次確認（`f8-messages.ts:163-166`）、關聯刪除（`p2-messages.ts:256` `relation.undo`）。沒有復原：不帶回支線、丟掉種子、取消折疊、刪除對話（`delete-messages.ts:28`「刪除後不能復原」） |
| G10 | 入口的可發現性 | **部分** | 回顧：待處理分頁與命令面板都有了（`inbox-panel.tsx:294`、`commands.ts:47`）；記憶庫：紀要分頁底部（`notes-side.tsx:79`）＋命令 `memory.open`（`commands.ts:48`）；支線改名仍沒有看得見的按鈕（見 #9） |

統計：**已處理 4**（G1、G2、G4、G5）、**部分 5**（G3、G6、G7、G9、G10）、**未處理 1**（G8）、未確認 0。

### 5.3 未處理項目清單（給下一步排序用）

27 項裡：#4 結論卡底部列、#5 失敗訊息與重試、#11 空的群組／關聯區、#12 預覽擠壓、#13 支線條（窄寬）、#15 章節分隔線、#18 比較設定區、#19 記憶庫卡片、#20 搜尋摘錄、#22 網址與上一頁、#23 mock 情境二。
G 項：G8 網址同步與深連結。
（#22 與 G8 是同一件事。#27 是未確認，不在這個清單。）

### 5.4 與工單「已知線索」的對照

- G8：**確認**。連 `line` 參數的同步也沒有（體檢當時還有 `?line=` 的 `replaceState`，現在 `shell.tsx` 只剩清 `?focus=` 那一處）。
- #25：**確認有 `content-visibility`**（`message-list.tsx:652` 與註解 `:573, :645`）；沒有虛擬化；實測留給 F20。四個提到的檔我找到的是 `message-list.tsx`、`message-actions.tsx`、`excerpt-anchor.tsx`（:78）、`apps/demo/src/frame/hooks.ts`（:89）。
- G3 釘選：**確認**只存瀏覽器（`pinned-roots.ts:9`）。

## 6. 沒做的項目與原因

| 項目 | 狀態 | 原因 |
|---|---|---|
| `bash scripts/smoke.sh`（事件數，B20.1 時是 929） | **待協調者補跑** | 此刻有其他 agent 在別的 worktree 平行工作，機器負載高；smoke 用固定的資料庫 `tangent_smoke` 與 port `:8121`，可能與別人撞 |
| Playwright e2e（mock project） | **待協調者補跑** | 同上（負載高）；e2e 會自己起伺服器並佔 port。目前 `web/e2e/tests` 有 170 個 `test(`（grep 計數），專案有 `mock`、`api`、`api-core`；高負載時建議 `--workers=2` |
| 487 則對話的捲動與切換實測（工單 §4） | **留給 F20 任務一** | 依任務指示不做。開發資料庫裡那條是 `120cf28d-e3a7-41d6-8a6f-2ccc4a35a963`（「Firebase 與 PRD 產品開發相關」，487 則，訊息 `created_at` 全相同）；要實測請匯出後匯入 e2e 的臨時資料庫，不要在 `:8120` 操作 |
| 對 `:8120` 的啟動設定重新確認（`memory`、`fisheye`、`summary:manual`、embedder fake） | 沒做 | 不能對 `:8120` 送請求；只能引用 `config.go` 的預設值與資料庫的 `tangent_feature_migrations` |
| `TANGENT_PERF_P1/P2`、`TANGENT_PERF_MEMORY`、`TANGENT_PERF_SCALE` | 沒跑 | 工單沒要求；`TestPerf_BranchTurnWithRebalance` 與 `TestPerf_MemoryRecallWithinBudget` 因此仍是 SKIP |
| 真模型煙霧測試（`TestRealModelSmoke`、`TestRealCLISmoke`） | 沒跑 | 付費或用訂閱額度 |
| 瀏覽器實測的視覺項目（#3、#4、#13、#14、#24 的實際畫面／請求數） | 沒做 | 這個任務是唯讀盤點，沒有開瀏覽器；上表已標「未實測」 |

## 7. 對照工單「2026-11-13 已經量到的」起點

| 工單寫的 | 重新確認 |
|---|---|
| 16 篇對話、最長一條 487 則 | ✔ 16 條主線（`tangent_line` 共 19，含 3 條支線）；最長 487 ✔ |
| 3 條支線（2 條已帶回） | ✔ 3 條，2 merged、1 open |
| 13 筆連結 | ✔ `tangent_link` 13，全是 `relation`／`related` |
| 2 筆收尾 | ✔ `tangent_leaf` 2，都是 `conclusion` |
| 14 篇有資料夾或標籤 | ✔ 14 篇有資料夾（全是「雜談」），**標籤 0 篇**（所以「或」都是資料夾） |
| 紀要、章節切點、種子、備忘、目標、群組、折疊、論證類型、比較表、建議匣、背景工作、滾動摘要都是 0 | ✔ 全部 0（`tangent_note`、`_chapter_cut`、`_seed`、`_memo`、`_goal`、`_group`、`_group_member`、`_fold`、`_message_tag`、`_comparison`、`_suggestion`、`_job`；滾動摘要 `tangent_line.summary` 全空）；另 `tangent_memory` 也是 0 |
| 預設 `summary:suggest`、不含 `memory`／`fisheye` | ✔ `config.go:290-291`；`:8120` 自己的設定未重新確認（§6） |
| 主 JS 169.1 kB、上限 172 kB、延遲載入點 48 個 | ✘ **主 JS 170.07 kB**（餘裕 1.93 kB）；延遲載入點我數到 49 個（§2.4） |

## 8. 檔案清單（本任務新增，全在 `docs/` 下）

- `docs/devlog/P0-baseline-inventory.md`（本檔）
- `docs/devlog/P0/fingerprint.sh`、`exports.mjs`
- `docs/devlog/P0/contract-sha256.txt`
- `docs/devlog/P0/go-api-tangent.txt`、`go-api-domain.txt`、`go-api-store.txt`、`go-api-httpapi.txt`
- `docs/devlog/P0/web-exports-client.txt`、`web-exports-react.txt`
- `docs/devlog/P0/build-chunks.txt`、`main-chunk-by-file.txt`、`main-chunk-attribution.mjs`
