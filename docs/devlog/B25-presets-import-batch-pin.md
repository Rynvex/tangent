# B25 · 功能預設組、匯入批次紀錄、對話釘選

> 2026-11-13。工單（工單 33，後端）。基線 `a0ca8f6`（含 B23 的 017、B24 的 018 與 `glossary`）。
> 在獨立 worktree 由一個實作 agent 完成，**未 commit**。
> 只改 Go、`store/queries/`、`store/migrations/`（新增 019）、`docs/`、契約樣本（只新增）、`scripts/smoke.sh`、`.env.example`、`CHANGELOG.md`；沒有改 `web/`。
> 沒有碰 宿主；沒有對 :8120 送請求、沒有動 :8120、:5183；沒有呼叫任何真實模型（全部 fake runner）；開發資料庫 `tangent` 沒有寫入。
> 決定 D1–D3 照工單 §1 的「已確認」版本：**D1 預設值不改**（沒設 `TANGENT_FEATURES` = `standard`），只加預設組的名稱；寫進 `DESIGN.md` §12.10 與 `DECISIONS_LOG.md` 表尾（四列）。
> 三個任務互相獨立，檔案與測試分開（見「檔案，依任務分組」），協調者可以分開 commit；只有文件（`API.md`、`DESIGN.md`、`CHANGELOG.md`）與 migration 019 是任務二、三共用的。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 通過 |
| `gofmt -l .` | 無輸出 |
| `~/go/bin/sqlc diff` | 乾淨（改完 `store/queries/` 後跑 `sqlc generate`，`store/db/` 沒手改） |
| `go test ./... -count=1` | 17 個套件全部 ok；**1,363 PASS、0 FAIL、6 SKIP**（同 P0 的 6 個刻意 SKIP：`TestRealModelSmoke`、`TestRealCLISmoke`、`TestPromote_Explain`、`TestSearch_Explain`、`TestPerf_MemoryRecallWithinBudget`、`TestPerf_BranchTurnWithRebalance`，都要環境變數）；DB 測試真的跑了（:5444 可連，沒有「資料庫連不上」的 SKIP） |
| `go test -race -run 'ImportBatch\|LinePin' .` | 通過 |
| 既有契約樣本 | `git status` 只多四個 `??` 檔，沒有任何 `M`／`D`；`-update` 之後再跑三次 `TestContract_*` 都通過（id 是隨機的，樣本穩定） |
| `bash scripts/smoke.sh` | **沒有跑**（固定的 `tangent_smoke` 與 :8121，工單禁止）。B25 那一段另外驗證：把 smoke.sh 的前段（helper）抽到 scratch，`DB=tangent_b25_check`、`PORT=8139`、fake runner，先建一條有回合的主線，再跑 B25 段落 → **通過**，server log 有一行 memory/fake embedder 的 WARN；跑完 `DROP DATABASE`（已確認不存在） |
| 效能 | 見「效能」：查詢計畫不變；`TestPerf_TurnProtocol` 與 ListLines 計時和基線輪流各跑三次，差異在雜訊內 |

## 契約樣本

新增四份（工單列的四份；契約測試機制沒有額外要求）：

- `route.lines.import.batch.json`（`POST /lines/import` 帶 `batchId`、`batchLabel`；回應的 `line.importBatchId`）
- `route.imports.list.json`（`GET /imports?limit=20`）
- `route.imports.delete.json`（`DELETE /imports/{bid}`：一棵刪掉、一棵 `changed` 留下）
- `route.lines.list.pinned.json`（`GET /lines?pinned=true`；那條線同時有 `importBatchId` 與 `pinnedAt`）

既有樣本一份都沒變：新欄位 `importBatchId`、`pinnedAt` 都是 `omitempty`；新的流程 `f.importsAndPins()` 放在契約流程的最後（`glossary` 之後），不會搶到任何「第一個事件」樣本。

## 做了什麼

### 任務一：功能預設組（`cmd/tangent-server/presets.go`）

- `TANGENT_FEATURES` 由左到右讀（`expandFeatures`）：預設組名稱（不分大小寫）展開成它的清單；同一個功能後面再出現時**取代前面那一項、位置不變**（`mergeFeatures`）；`none` 清掉前面全部（`none` 單獨用時和以前一樣 = 沒有功能）。預設組不能帶模式（`essential:auto` 回錯）；空的項目（`a,,b`）回錯；未知名稱的錯誤訊息列出 `essential, standard, full or none`。
- `essential` = D2 的清單；`standard` = `defaultFeatures`（**沒設時的預設，D1 不改**）；`full` = `defaultFeatures + ",fisheye,memory"`（`memory` 沒給模式 = `suggest`，embedder 照原本的 `readEmbedder` 規則：fake provider 預設 fake，其他沒設 `TANGENT_EMBEDDER` 回錯）。
- `readFeatures` 從 `config.go` 搬到 `presets.go`；`FeatureNames`（啟動 log）改成正規化過的 `name[:mode]`（以前是原字串去頭尾空白；`"summary : auto"` 現在記成 `summary:auto`）。
- `logStartupWarnings(log, cfg)`：原本 `newApp` 裡的「http base URL」WARN 搬進來，加上 `cfg.Embedder == "fake"`（= `memory` 開著且用 fake embedder）的一行 WARN。不擋啟動。
- 測試 `presets_test.go`：三個預設組的展開（`standard` 與沒設時逐項相同）、混用與覆寫（`essential,goal:manual,relations:manual,leaf:auto` → 13 個、`leaf:auto` 取代原位置；預設組在後時覆寫前面的單項；`full,none,notes` 只剩 notes 且沒有建 embedder；重複的功能只列一次）、四種錯誤（未知名稱、預設組帶模式、空項目、`full` 在非 fake provider 又沒有 embedder）、WARN（只有 memory + fake 時一行；沒 memory、openai embedder、預設設定都不記）。

### 任務二、三的資料（migration `019_import_batch_pin`）

```sql
CREATE TABLE tangent_import_batch (id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX tangent_import_batch_tenant ON tangent_import_batch (tenant_id, created_at DESC, id DESC);
ALTER TABLE tangent_line ADD COLUMN import_batch_id UUID, ADD COLUMN import_seq BIGINT,
  ADD COLUMN import_activity_at TIMESTAMPTZ, ADD COLUMN pinned_at TIMESTAMPTZ;   -- 都可為 NULL、沒有 default：不改寫既有列
CREATE INDEX tangent_line_import_batch ON tangent_line (tenant_id, import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX tangent_line_pinned ON tangent_line (tenant_id, pinned_at DESC, id DESC) WHERE pinned_at IS NOT NULL;
```

`import_seq`、`import_activity_at` 是工單沒有的兩欄，理由見「和工單不同的地方 1」。

### 任務二：匯入批次

- **domain**（`domain/import_batch.go`）：`ImportBatch`、`KeptImportLine`、`ImportBatchDeletion`、原因常數 `ImportKeptAttached/Busy/Changed`、`ImportBatchLabelMaxRunes = 120`、`ErrImportBatchNotFound`（新錯誤碼 `import_batch_not_found`，404）、`PlanImportBatch(id, label)`：`id` 空 = 沒有批次（這時給 `label` 是 `invalid_input{field: batchLabel}`）；不是 UUID 或全 0 → `invalid_input{field: batchId}`；`label` 用 `FlattenUntrusted` 壓成一行、去頭尾空白，超過 120 字 `invalid_input{field: batchLabel, max}`。`ImportInput` 多 `BatchID`、`BatchLabel`。
- **匯入**（`store/import.go`、`store/import_batches.go`）：交易一開始 `UpsertImportBatch`：
  `INSERT … ON CONFLICT (id) DO UPDATE SET label = tangent_import_batch.label WHERE tangent_import_batch.tenant_id = EXCLUDED.tenant_id RETURNING id`。
  同租戶：沿用（標籤、建立者以第一次為準），而且這一列被鎖到 commit；別的租戶：不更新、沒有回傳列 → `ErrImportBatchNotFound`，整筆 rollback（什麼都沒寫）。併發用同一個新 id：後到的在唯一索引上等先到的 commit，然後走 `DO UPDATE` 那條路，不會 unique violation（`TestImportBatch_ConcurrentImportsOfANewBatchAllLand` 8 個 goroutine）。交易最後（在 B19 的 `dateImportedLine` 之後）`MarkImportedLine` 寫 `import_batch_id`、`import_seq`（樹上最新訊息的全域 seq）、`import_activity_at`（主線此刻的 `last_activity_at`）；然後才讀 `LineView`，所以回應就帶 `importBatchId`。
- **列表**（`ListImportBatches`）：keyset `(created_at DESC, id DESC)`，`limit` 預設 50、最多 200；每筆兩個子查詢數 `lineCount`（`tenant_id + import_batch_id`，走新的部分索引）與 `standaloneCount`（再加 `NOT EXISTS tangent_branch`）。
- **復原**（`Engine.DeleteImportBatch`，`import_batch.go`）：
  1. `ImportBatchLines`：批次不屬於這個租戶（或不存在、id 不是 UUID）→ `404 import_batch_not_found`；否則依 `import_seq, id`（= 匯入的順序）列出線與「現在是不是支線」。
  2. 是支線的 → `kept{attached}`，不碰。
  3. 其他逐條 `store.DeleteImportedTree` → `s.deleteTree(…, guard, hooks)`：這就是 `DeleteTree` 的同一個函式（`DeleteTree` 現在是 `deleteTree(…, nil, hooks)`），只多一個在**鎖之下、busy 檢查之後、TxHook 之前**執行的 guard：線還在這個批次（不然當作已經不在，略過）、沒有 `force` 時 `ImportedTreeChanged` 為真就回 `ErrImportedTreeChanged`。各自一個交易、各自的鎖（主線 → 子樹依 id）、各自的 TxHook（收到 `store.DeletedTree`）、commit 後走 `Engine.treeDeleted`（從 `DeleteTree` 抽出的同一段：停掉跟著刪的 job、發 `line.deleted`）。錯誤對應：`ErrDeleteBusy` → `busy`；`ErrImportedTreeChanged` → `changed`；`ErrDeleteNotMainLine`（列出之後才被 attach）→ `attached`；`ErrLineNotFound`（中途被刪、或被 spinoff 拿掉批次）→ 不列；其他錯誤 → 整個呼叫回錯（前面刪掉的不回來，「不要求整批原子」）。
  4. `kept` 是空的 → `RemoveImportBatch`：`SELECT … FOR UPDATE` 鎖批次列（進行中的同批匯入持有它，會等那筆 commit），再用新的 statement 數線（READ COMMITTED，看得到剛 commit 的線），還有線就不刪（`Removed: false`），沒有才刪。TxHook 收到 `store.RemovedImportBatch`。
- **其他樹的操作**：`DeleteTree` 不動批次列（`lineCount` 自然變少，可能是 0，再 `DELETE /imports/{bid}` 就只刪批次列）；attach（`MakeLineBranch`）保留 `import_batch_id`（還算在 `lineCount`，不算 `standaloneCount`）；spinoff 的新主線（`SetLineCapsule`，fresh 與 detach 都經過它）清掉 `import_batch_id`、`import_seq`、`import_activity_at` 與 `pinned_at`。
- **HTTP**（`httpapi/imports.go`、`b18.go`、`import_body.go`）：`importBody` 多 `batchId`、`batchLabel`；`GET /imports`（讀、核心）、`DELETE /imports/{bid}?force=`（寫、`OpImportsDelete = "imports.delete"`）。`{bid}` 不是 UUID → 404（同其他 path id）；`force` 不是布林 → 400。

### 任務三：釘選

- `store.LinePatch.Pinned *bool`；`UpdateLine` 在同一把行鎖下 `patchPin`：支線 + `true` → `invalid_input{field: pinned}`，支線 + `false` → 不做事；主線 → `SetLinePinned`（`CASE WHEN pinned THEN coalesce(pinned_at, clock_timestamp()) ELSE NULL END`），然後照舊 `UpdateLineFields`（只動 `updated_at`，不動 `last_activity_at`）。發 `line.updated`（`UpdateLine` 原本的事件）。
- `store.ListLinesInput.Pinned`：`true` 時 `ListLines` 一開始就轉到 `listPinnedLines`（新查詢 `ListPinnedMainLines`：`pinned_at IS NOT NULL`、`archived` 照用、`folder` / `tag` 用 `ListFilteredMainLines` 同樣的 narg 寫法，`ORDER BY pinned_at DESC, id DESC`，`LIMIT` = `limit`（預設與上限 200））；帶 `cursor` → `invalid_input{field: cursor}`。**`Pinned` 是 false 時走的程式路徑、SQL 與參數和之前逐字相同**（`ListLines` 後半段沒動）。
- `domain.Line` 多 `ImportBatchID string \`json:"importBatchId,omitempty"\``、`PinnedAt *time.Time \`json:"pinnedAt,omitempty"\``（放在 `SpunOffFrom` 之後），`lineFromRow` 填入。
- HTTP：`lineBody.Pinned *bool`；`PATCH` 的「沒有要改的」檢查加上 `pinned`（訊息改成 `…, tags or pinned`；沒有任何樣本或測試用到這段文字）；`POST /lines` 帶 `pinned` 回 `400 invalid_input`（只能用 PATCH 設，避免靜悄悄被忽略）；`GET /lines?pinned=` 用 `queryBool`。
- attach：`MakeLineBranch` 加 `pinned_at = NULL`（目標保留自己的釘選）。

### 文件

`API.md`（LineView 兩個欄位、`GET /lines` 的 `pinned`、`POST`／`PATCH /lines` 的釘選、`POST /lines/import` 的批次欄位、新的 `GET /imports` 與 `DELETE /imports/{bid}` 段落、op 表一列、錯誤碼一列、四份樣本都被引用）、`EMBEDDING.md`（§2 預設組的說明與表；§4.4 `DeleteImportBatch` 一列，`ImportLine`、`UpdateLine` 兩列補註）、`DESIGN.md`（§4 新欄位與表、§7 路由表三列、§12.5 參考伺服器預設那列、§12.10 四列）、`DECISIONS_LOG.md`（表尾同樣四列）、`.env.example`（預設組說明，範例改成 `essential,goal:manual,relations:manual`）、`CHANGELOG.md`（B25 一段，標題改成 B13–B25）、`scripts/smoke.sh`（B25 一段）。

## 測試

| 檔案 | 測什麼 |
|---|---|
| `cmd/tangent-server/presets_test.go` | 見任務一 |
| `domain/import_batch_test.go` | `PlanImportBatch` 的清理、上限邊界與四種拒絕的 `field`；錯誤碼字串 |
| `import_batch_test.go` | 建立與沿用（標籤以第一次為準、批次列只寫一次、沒帶的匯入沒有批次）；跨租戶（匯入 404 且什麼都沒寫、列表看不到、刪除 404）；四種輸入錯誤；**併發匯入同一個新 id**；列表分頁與壞游標；被 attach 的線算 `lineCount`、不算 `standaloneCount`；**刪除**：沒用過的兩棵都刪（其中一棵是 B19 的歷史時間匯入；兩棵分別先被釘選、改資料夾、標已讀，都不算用過）、`line.deleted` 各一、批次列跟著刪、再刪一次 404；**`attached`、`busy`、`changed` 三種留下**（`changed` 有四種來源：主線上的新回合、新支線、存了名詞、未來時間匯入的支線裡的新回合——最後這個證明「不和現在比」），批次列保留且計數正確；**`force=true`** 刪掉四個 `changed`，`attached`、`busy` 仍留下，事件剛好四個 `line.deleted`；TxHook 失敗時那棵樹與批次都還在；`DeleteTree` 不動批次列、之後復原只刪空批次 |
| `line_pin_test.go` | 釘選 / 再釘選保留第一次時間 / 取消，`last_activity_at` 不變、發 `line.updated`；支線 `true` 回 `invalid_input{field: pinned}`、`false` 是 no-op；釘選前後一般列表的順序逐項相同（D3）、`Pinned` 依釘選時間、封存照 `Archived`、別的租戶看不到、帶游標 400；attach 清掉被併線的釘選（目標保留）、spinoff detach 一條「被 attach 過的匯入線」→ 新主線沒有釘選也沒有批次、批次 `lineCount` 變 0；釘選主線底下的支線 spinoff 出來沒有釘選 |
| `httpapi/imports_routes_test.go` | 路由層：匯入回應的 `importBatchId`（沒批次時欄位不出現）、跨租戶 404、非 UUID / 太長的標籤 400、`GET /imports` 的形狀與跨租戶、用過的被留下、`force` 不是布林 400、`force=true`、再刪 404；釘選的 PATCH / 支線 400 / 非布林 400 / `POST /lines` 帶 `pinned` 400 / `pinned=true` 列表 / `pinned=false` 不過濾 / 非布林 400 / 取消後欄位不出現 |
| `httpapi/routes_test.go` | 路由表 100 → 102（`GET /imports`、`DELETE /imports/{bid}`），種子多一個批次；唯讀身分對 DELETE 回 403、匿名 401、租戶 B 對 DELETE 回 404 都自動涵蓋 |
| `httpapi/contract_imports_test.go` | 四份新樣本 |
| `intx_doc_test.go` | `DeleteImportBatch` 實際跑一次，核對 EMBEDDING §4.4 的型別 |

## 鎖順序與併發

- 匯入：批次列（upsert，鎖到 commit）→ 新的線（不需要鎖，都是新列）。復原的每一棵：主線 → 子樹依 id（同 `DeleteTree`），**不碰批次列**；最後刪批次列的交易只鎖批次列、不鎖線。沒有任何交易同時以相反順序持有「批次列」與「某條線」，所以沒有新的死結路徑。
- 匯入和復原同時進行：匯入持有批次列 → `RemoveImportBatch` 等它 commit，再數線時看得到剛寫的線 → 不刪批次列（回應裡沒有那條新線：它在列出之後才出現；`kept` 是空的但批次列還在，見「希望協調者特別檢查 3」）。若復原先刪了批次列，之後的匯入 `INSERT` 走新建的那條路，重新建立批次（同租戶），不會留下指向不存在批次的線之外的狀態——**線本來就允許批次列不存在**（沒有 FK），只是那個批次在 `GET /imports` 會以新的 `createdAt` 重新出現。
- 「用過了沒」在那棵樹的鎖之下判斷，和刪除同一個交易：判斷之後才開始的回合會被 `CountBusyLines` 擋（回合需要那把行鎖），不會出現「判斷沒用過、刪除前剛好有人送出訊息」的空窗。

## 效能

- `GET /lines`（沒帶 `pinned`）的查詢文字一個字都沒改；`SELECT l.*` 多四個 NULL 欄位（只佔 null bitmap）。2,000 條主線、`ANALYZE` 後的 `EXPLAIN` 仍是 `Limit → Nested Loop Anti Join → Index Scan using idx_tangent_line_active`（新的兩個部分索引條件不符合，不會被選）。
- 機器負載 4.9–5.1，所以照 B24 的做法和基線輪流跑。基線是 `git archive HEAD` 解到 scratch 的一份（沒有動 git 狀態）。
  - ListLines（2,000 條主線、limit 50、200 次，每 4 頁回到第一頁；臨時測試檔，跑完已刪）p95：基線 2.71 / 2.65 / 2.77 ms，B25 2.60 / 2.67 / 3.30 ms。
  - `TestPerf_TurnProtocolAndOutlineWithinBudget` p95（BeginTurn / CompleteTurn / ListBranches）：基線 14.33/24.89/5.15、16.91/20.15/5.03、14.08/24.66/5.19 ms；B25 15.93/18.25/4.86、14.68/20.32/5.01、15.88/24.50/5.31 ms。
  - 全部 `TestPerf` 一次（load 5.1）都在預算內。
- 新增的查詢：`GET /imports` 每筆兩個子查詢（走 `tangent_line_import_batch`）；匯入多一個 upsert 與一個 `UPDATE`（`import_seq` 的子查詢走 `idx_tangent_message_line`）；復原每棵多一個 `ImportedTreeChanged`（訊息走 `idx_tangent_message_line`，notes / memos / terms / seeds 都有 `root_line_id` 開頭的索引）。

## 和工單不同的地方

1. **「匯入後有沒有被改過」多記了兩欄**：工單寫「`last_activity_at` 晚於匯入時寫入的值，或樹上有匯入之後建立的支線」，但 (a) 匯入的支線的 `created_at` 也可能是來源的歷史時間或**未來 24 小時內**（B19 的 `ImportFutureSlack`），(b) 支線裡的新回合只動那條支線的 `last_activity_at`，主線的不變，(c) 未來時間的匯入之後，新的活動時間 `now()` 反而**早於**匯入寫入的值，「晚於」抓不到。所以改成在匯入當下記下樹的狀態，比對是否**不同**，不和「現在」比：
   - `import_activity_at`：主線 `last_activity_at` 的匯入值，比對用 `IS DISTINCT FROM`（不是「晚於」）。
   - `import_seq`：樹上最新訊息的 seq。seq 是全域 identity，訊息搬動也不變，所以「樹上有 seq 更大的訊息」= 匯入之後有人寫了訊息（回合、重試、開支線的標記、系統訊息……），不受任何時間戳影響。
   - 其他：`origin <> 'import'` 的支線（新開的、搬進來的、attach 進來的；匯入的支線都是 `import`）、`meta.editedAt` 的結論卡（B17 改卡片不寫新訊息）、樹上有 notes / 備忘 / 名詞 / 停車場種子（匯入一個都不寫，所以有就是使用者加的）。
   - 不算用過：釘選、資料夾、標籤、已讀、封存、改標題（都不動上面任何一項；釘選、資料夾、已讀有測試）。刪掉一條匯入的支線也不算（沒有新增使用者的東西，整棵刪掉不會丟資料）。
2. **migration 名稱是 `019_import_batch_pin`**（工單寫 `019_import_batch`），因為同一步也加 `pinned_at`（工單 §4 的要求）。
3. **`GET /lines?pinned=true` 的細節**（工單只寫「不分頁，最多 200 筆」）：`limit` 有給時取它（1–200），帶 `cursor` 回 `400 invalid_input`，`archived` / `folder` / `tag` 照樣適用；`pinned=false` 等於不給（不是「只列沒釘選的」）。
4. **`POST /lines` 帶 `pinned` 回 400**：`lineBody` 是 POST 與 PATCH 共用的，不擋的話會被靜悄悄忽略。
5. **spinoff 清掉批次**：工單寫「新主線不繼承」。fresh 的新主線本來就沒有；detach 會把**原本那條支線的列**變成主線，只有「被 attach 過的匯入線」會帶著批次，所以在 `SetLineCapsule`（兩種 spinoff 都經過）一律清掉。結果是那條線離開批次（`lineCount` 少 1），有測試。
6. **復原時中途消失的線**（被刪、或被 spinoff 拿掉批次）既不在 `deleted` 也不在 `kept`；工單只定義了三種 `reason`，所以沒有新增第四種。
7. 預設組多了兩個小規則（工單沒寫）：`none` 可以混用（清掉前面的），同一個功能出現兩次不再讓 `tangent.New` 因重複而失敗，而是後面的取代前面的。

## 給前端（F20）

### 物件

- `LineView` 多兩個**選填**欄位（沒有時鍵不存在，不是 `null`）：
  - `importBatchId?: string`：這條主線是哪個匯入批次寫的；被 attach 併走的線（現在是支線）保留；spinoff 產生的主線沒有。
  - `pinnedAt?: string`（UTC RFC3339，微秒）：釘選時間；只會出現在主線。
- `ImportBatch`：`{id, label, createdAt, lineCount, standaloneCount}`（全部必有）。
- `ImportBatchDeletion`：`{deleted: string[], kept: {lineId: string, reason: "attached" | "busy" | "changed"}[]}`（兩個陣列必有，可能是 `[]`）。

### 路由

| 路由 | 請求 | 回應 | 錯誤 |
|---|---|---|---|
| `POST /lines/import` | 多 `batchId?`（客戶端產生的 UUID，例如 `crypto.randomUUID()`，一次多檔匯入共用一個）、`batchLabel?`（≤ 120 字，例如檔名；同一批以第一次的為準） | 同前，`line.importBatchId` 有值 | `404 import_batch_not_found`（別的租戶的 id）、`400 invalid_input`（`field: batchId` / `batchLabel`） |
| `GET /imports?limit=&cursor=` | — | `200 {imports: ImportBatch[], nextCursor}` | `400 invalid_input`（壞游標、limit） |
| `DELETE /imports/{bid}?force=true` | 無本文 | `200 ImportBatchDeletion` | `404 import_batch_not_found`、`400 invalid_input`（`force` 不是布林）、唯讀身分 `403` |
| `PATCH /lines/{id}` | 多 `pinned?: boolean` | `200 LineView` | 支線 `pinned: true` → `400 invalid_input{field: "pinned"}` |
| `GET /lines?pinned=true` | `archived`、`folder`、`tag`、`limit` 照用；**不要帶 `cursor`** | `200 {lines, nextCursor: ""}`，依 `pinnedAt` 新的在前，最多 200 | 帶 `cursor` → `400 invalid_input{field: "cursor"}` |

- 「復原這次匯入」可以改成存 `batchId`（例如 localStorage），之後隨時 `DELETE /imports/{bid}`；`kept` 非空時批次列保留，可以給「仍要刪除（force）」的選項；`busy` 要等回合結束；`attached` 永遠不會被這條路由刪。
- 一般列表的排序**不受**釘選影響（D3）：要把釘選的放最上面，前端另外打 `GET /lines?pinned=true` 再合併、去重。
- 釘選從 `tangent:pinned-roots:v1` 搬到伺服器：可以在第一次載入時把 localStorage 裡的 id 逐一 `PATCH {pinned: true}`（已釘選的再釘一次不會改時間），之後清掉 localStorage。

### 事件

沒有新的事件類型。釘選 / 取消發 `line.updated`（payload 是 `LineView`，有 `pinnedAt` 或沒有）；匯入照舊 `line.created`（主線的 `LineView` 帶 `importBatchId`）；復原每刪一棵發一個 `line.deleted`（同 `DELETE /lines/{id}`）。批次本身沒有事件（`GET /imports` 要重新讀）。

### 錯誤碼

新增 `import_batch_not_found`（404）。

### web client 契約測試預期會失敗的項目（沒有在這個 worktree 跑 vitest：不改 `web/`；以下依 `contract.test.ts` 與 `line-normalize.ts` 推斷）

| 測試 | 原因 |
|---|---|
| `contract.test.ts` › `route.imports.list`、`route.imports.delete` | `ROUTES` 沒有 `GET /imports`、`DELETE /imports/{id}`（"no client call for …"） |
| `contract.test.ts` › `route.lines.import.batch` | 請求本文多 `batchId`、`batchLabel`（client 的 import 輸入若只送已知欄位會不一致）；回應的 `line.importBatchId` 被 `normalizeLine` 丟掉 → 嚴格比對失敗 |
| `contract.test.ts` › `route.lines.list.pinned` | 路徑 `/lines?pinned=true`：client 的 list 參數沒有 `pinned` → 送出的 path 不同；回應裡的 `importBatchId`、`pinnedAt` 被 `normalizeLine` 丟掉 |
| `packages/client/src/errors.test.ts` › "lists exactly the codes domain/errors.go defines" | `domain/errors.go` 多 `import_batch_not_found` |

`normalizeLine` 要對這兩個欄位做「有才放」（`omitempty`）——如果一律補 `null`，既有樣本（沒有這兩個鍵）就會反過來失敗。

## 希望協調者特別檢查

1. **「用過了沒」的定義**（`store/queries/import_batches.sql` 的 `ImportedTreeChanged`，「和工單不同的地方 1」）：是否接受多記 `import_seq`、`import_activity_at` 兩欄，以及 notes / 備忘 / 名詞 / 種子也算「用過」。
2. **`deleteTree` 的 guard**（`store/tree.go`）：位置在 `lockLines`（busy 檢查）之後、`readDeletedTree` 與 TxHook 之前；`DeleteTree` 自己傳 `nil`，行為不變。
3. **`kept` 是空的但批次列還在**的競爭情況：復原列出線之後，另一個同批匯入才 commit，`RemoveImportBatch` 數到它就不刪批次列，但回應裡不會提到那條線。是否需要回應多一個 `batchDeleted`（工單沒有，我沒加）。
4. **attach 之後的批次**：被併走的線永遠是 `attached`，所以只要批次裡有一條被 attach 的線，批次列就永遠刪不掉（`kept` 永遠非空，工單的規則）。`GET /imports` 會一直顯示 `standaloneCount: 0` 的那筆。前端可能要把 `standaloneCount == 0` 的批次藏起來。
5. **預設組的覆寫語意**（`mergeFeatures`）：取代在原位置，順序會影響功能的掛勾順序（`WithFeatures` 的順序）；`standard,ibis:off` 這種寫法讓 `ibis` 仍在清單上、模式 off。
6. `FeatureNames`（啟動 log 的 `features=`）改成正規化過的字串。
