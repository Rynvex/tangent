# B14 · 樹內搜尋、整棵匯出、跨模型發散、批次種子（後端）

> 2026-10-25。工作單（交接包 `5_BACKEND_B14.md`，含協調者指出、使用者更新過的三點：數量錯誤 `400 invalid_input`、匯出每線 500 則＋`truncated`、`defaultDivergePurposeRunes = 40`）。
> 使用者指定由協調者自己做。在獨立 worktree（`../tangent-b14`，分支 `b14`）裡做，**沒有改 `web/`**（前端 F8 平行在做）。
> Go 測試用 `tangent_test`，smoke 用 :8121 與 `tangent_smoke`；沒有碰 :8120、:5183，沒有呼叫付費模型。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...`、`gofmt -l .` | 通過、無輸出 |
| `make sqlc` 後 `sqlc diff` | 無差異 |
| `go test ./... -count=1` | 全部 ok |
| `scripts/smoke.sh`（:8121） | `SMOKE PASSED (723 events)`；新增 B14 一步（樹內搜尋、跨模型發散含 400、批次種子、匯出） |
| `git diff main -- web/` | 空 |

新的測試：`b14_test.go` 7 個（樹內搜尋、匯出兩個、跨模型發散兩個、批次種子、併發批次守住上限），`domain/diverge_models_test.go` 3 個，
`httpapi/b14_routes_test.go`（路由表 79 → 82：三條新路由跑過讀者、跨租戶、功能關閉、host hook、驗證失敗的共用測試；加一個形狀測試），
契約樣本 4 個，`intx_doc_test.go` 加 `CreateSeeds`、`DivergeModels`。

## 實作

| 路由 | Engine | 做法 |
|---|---|---|
| `GET /search?root=` | `Search`（`SearchInput.Root`） | `root` 先查是這個租戶的主線（不是 → `line_not_found`），store 走另一組 SQL：標題只看那條主線、目的看 `root_line_id`、訊息看那棵樹的線（`line_id IN (root ∪ 支線)`），取最新 200 筆候選，不用全租戶的 4,000 則視窗；忽略 `archived`。折疊不改訊息，所以折疊起來的訊息照樣搜得到（有測試） |
| `GET /lines/{id}/export` | `ExportTree` | 核心唯讀。主線、大綱（`ListBranches(includeAside)`）、訊息、各功能各一個查詢：訊息用 `row_number() OVER (PARTITION BY line_id ORDER BY seq)` 取每條線前 501 則，超過 500 就 `truncated` 並丟掉第 501 則；標籤與 spin-off 標記照 `ListMessages` 一次補上。折疊、比較表新增整棵樹的查詢（`ListTreeFolds`、`ListTreeComparisons`）；紀要、備忘、章節、目標、連結用現有的整棵樹查詢。功能用 `modesFor` 判斷，關著給 `[]` / `null` / `{}` |
| `POST /lines/{id}/diverge/models` | `DivergeModels` | 鎖外：數量（`CheckDivergeCount`）、每個 target 的 provider / model（空白 `invalid_input`，`branchModel` → `model_not_allowed`）、共用目的長度、錨點（這條線上完成的 chat 訊息）、每條的目的與背景包。鎖內：`store.OpenDivergeBranches`（主線 → 父線，同 `CreateDivergeBranches` 但沒有 job），每條走 `createInParent`（上限、深度、錨點、父線狀態），全開或全不開。commit 後沿用 `publishDiverged` |
| `POST /lines/{id}/seeds/batch` | `CreateSeeds` | `domain.NormalizeSeedTexts`（1–20、每筆同單筆）；交易內 `lockSeedRoot`（含 B13 的 detach 重新檢查）→ 現有 open 數＋整批 ≤ 上限 → 錨點與來源標籤算一次 → 依序插入（`created_at` 是 `clock_timestamp()`，順序保留） |

**鎖**：搜尋與匯出只讀不鎖。跨模型發散：主線 → 父線（`lockParent`），和建支線一樣。批次種子：只鎖主線，和單筆種子一樣；`TestB14_ConcurrentSeedBatchesKeepTheCap` 兩批同時送、各自單獨放得下、合起來超過上限 → 剛好一批成功。事件都在 commit 之後發。

## 和工作單不同的地方

- **契約樣本檔名**：照 repo 的慣例加 `route.` 前綴：`route.lines.export.json`、`route.diverge.models.json`、`route.seeds.batch.json`，另加 `route.search.root.json`。內容就是工作單的形狀。
- **`b70_test.go`**：裡面沒有 InTx 的測試表；檢查「每個寫入的 InTx 型別」的是 `intx_doc_test.go`，改的是那個。
- **背景包的說明**：沒有用 `BuildDivergeNote`（它的文字是「AI 為這則訊息提出的幾個方向之一」，跨模型時不對），新增 `domain.BuildDivergeTargetsNote`：「平行回答」、這條由哪個模型回答、其他平行支線的目的與模型。
- **目的太長**：`「{purpose} · {model}」` 超過 200 字時截短前段、保留 ` · {model}`（工作單只寫「截斷」）；目標自己的目的太長、共用目的太長 → `400 invalid_input`（`ErrInvalidPurpose`）。
- **發散支線的功能掛勾**：和 job 開的發散一樣（DESIGN §12.6「發散開的支線不跑功能的支線掛勾」），交易內不跑功能的 `onBranchCreated`，commit 後的 AfterCommit 掛勾照跑。
- **`foldsByLine`**：工作單寫「active fold」，實作和 `GET /lines/{id}/folds` 一樣，是沒有收回的折疊（含草稿中、失敗的），讓兩邊一致。
- **匯出不是快照**：各部分依序讀，讀取途中的寫入可能只出現在其中一部分（寫進 API.md 與 §12.10）。
- **`truncated` 不只看訊息**：比較表最多 500 筆（工作單沒有寫上限），超過時也設 `truncated`；大綱 `ListBranches` 原本就最多 500 條，到了上限也設 `truncated`（預設每棵樹 200 條支線，只有宿主調高才會碰到）。
- 跨模型發散允許同一個模型出現多次（寫進 API.md）。
- **契約樣本工具**：匯出的 `messagesByLine` / `foldsByLine` 用線的 id 當 key，原本的正規化只換值不換 key，樣本每次都不同。`contract_samples_test.go` 改成 key 是 id 時也換成佔位符，並依已經給過的佔位符排序（匯出的 `branches` 先出現），其他樣本沒有變。

## 審查

寫完請一個唯讀 Go 審查 agent 看整個 commit：沒有 CRITICAL / HIGH。採納的：大綱或比較表到上限時 `truncated` 沒有設（已修）；匯出大小沒有寫清楚（API.md 寫上上限）；
store 的三個整棵樹查詢只用線的 id 過濾（engine 傳進來的一定是這個租戶的線，但 store 是公開的 API，已加上 `tenant_id` 條件並測試）；樹內搜尋的 `$4` 改成一律 `::uuid`；
允許重複的模型寫進文件。沒有改的：樹內搜尋訊息沒有視窗（受樹的大小限制，現在沒有問題）。

## 給前端與使用者

- 跨模型發散的模型要宿主允許：參考伺服器 `allowModel` 裡 fake 接受任何模型，其他 provider 只接受設定裡允許的模型。使用者的 :8120（claude-cli）用不在清單上的模型會得到 `422 model_not_allowed`；前端應該從 `/capabilities` 的 `models` 挑。
- 發散開好的支線還沒有回覆（不呼叫模型）；要比較，前端在每條支線各送一輪（會各自用那條線的模型，付費）。
- 參考伺服器沒有新的設定；`/export`、`/search?root=` 不需要重啟以外的動作。:8120 要用新的二進位重啟才有這些路由。
