# B24 · 名詞表（`glossary` 功能模組）

> 2026-11-13。工單（工單 31，後端）。基線 `3cfc76a`（含 B23）。
> 在獨立 worktree 由一個實作 agent 完成，**未 commit**。
> 只改 Go、`store/queries/`、`store/migrations/`（新增 018）、`docs/`、契約樣本、`scripts/smoke.sh`、`.env.example`；沒有改 `web/`。
> 沒有碰 宿主；沒有對 :8120 送請求、沒有動 :8120、:5183；沒有呼叫任何真實模型（全部 fake runner）；開發資料庫 `tangent` 沒有寫入。
> D1–D4 使用者已確認，照建議值實作，寫進 `DESIGN.md` §12.10 與 `DECISIONS_LOG.md`（表尾四列）。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 無輸出 |
| `gofmt -l .` | 無輸出 |
| `~/go/bin/sqlc diff` | 無差異（`store/db/` 由 `sqlc generate` 產生） |
| `go test ./... -count=1` | **全部 ok**：17 個 package，頂層測試 1219 pass、0 fail、6 skip。skip 的都是要環境變數才跑的：`TestRealModelSmoke`、`TestRealCLISmoke`（付費，沒跑）、`TestPerf_MemoryRecallWithinBudget`、`TestPerf_BranchTurnWithRebalance`、`TestSearch_Explain`、`TestPromote_Explain`。DB 測試實際執行（:5444 連得到，沒有因此 skip） |
| `go test -race`（新測試：`./store -run Glossary`、`. -run Glossary`、`./httpapi -run 'TermRoutes\|Contract\|Routes_'`、`./domain`） | 全部 ok |
| API 文件檢查（`apidoc_test.go`、`ops_doc_test.go`、`intx_doc_test.go`、`embedding_doc_internal_test.go`） | 通過（路由、op 表 73 列、事件、錯誤碼、樣本連結、InTx 表、EMBEDDING §2 功能表） |
| 路由表 | 100 條（原 95；名詞表 5 條加進 `routeTable`，所以唯讀、未登入、別的租戶、功能未設定、功能被政策關掉、輸入錯誤這些既有的表格測試都涵蓋新路由） |
| 既有契約樣本 | 只有允許的兩種變動，見下一節 |
| `bash scripts/smoke.sh` | **沒有跑**（固定的 `tangent_smoke` 與 :8121）。B24 的步驟已加進去；另外把 `smoke.sh` 的開頭（建置、啟動、`api`／`turn` 等函式、訂閱 `/events`）與 B24 那一段原樣取出，改成 :8138、資料庫 `tangent_b24_check`、`TANGENT_PROVIDER=fake` 跑一次：`B24 CHECK PASSED (28 events)`（含 `terms.changed` 與 `branch.changed{kept}`），跑完資料庫已刪除（確認 `pg_database` 沒有這個名字）。整份 smoke 的事件數要等協調者跑 |
| 效能 | 見「效能」 |

## 契約樣本的變動

`git status --short httpapi/testdata/`：

| 檔案 | 變動 | 允許的種類 |
|---|---|---|
| `route.capabilities.json` | `features` 在 `memo` 之後多 `{"enabled": true, "name": "glossary"}` | `/capabilities` 多一項 |
| `route.capabilities.viewer.json` | 同上（唯讀身分的 `/capabilities`） | `/capabilities` 多一項 |
| `route.lines.export.json` | `response` 多 `"terms": []`（那棵樹沒有名詞） | `export` 多 `terms` |
| 新增 `route.terms.create.json`、`route.terms.list.json`、`route.terms.update.json`、`route.terms.search.json` | 工單列的四份 | — |
| 新增 `event.terms.changed.json` | 見「和工單不同的地方」1 | — |

其他既有樣本沒有任何變動（`-update` 之後逐檔比對過；預覽的樣本沒有變，因為名詞表的流程在一棵自己的對話上、放在契約流程最後，沒有名詞的樹不產生區塊也不記預算份額）。

## 做了什麼

### 資料（migration `018_glossary`）

`tangent_term` 照工單的 SQL，另外加了 `CHECK (term <> '')`、`CHECK (term_key <> '')`、`CHECK (explanation <> '')`（同備忘的「只檢查非空、長度由 `Limits` 管」）。down 是 `DROP TABLE IF EXISTS tangent_term`。

### domain（`domain/glossary.go`）

- `Term`、`TermHit`（`Term` 加 `rootTitle`，JSON 攤平）、`GlossaryLimits{TermMaxRunes 60, ExplanationMaxRunes 1000, MaxPerTree 300, TokenBudget 300}`（`Limits.Glossary`，逐欄預設、`Validate` 檢查負數）。
- `NormalizeTermKey`：去掉所有空白（`unicode.IsSpace`，含全形空白）、全形英數符號（U+FF01–FF5E）轉半形、轉小寫。
- `CleanTerm`：`CleanSystemText` 之後壓成一行（連續空白變一個），1–60 字；`CleanTermExplanation`：`CleanSystemText`（可多行），1–1,000 字。空白 → `invalid_input`（`field: term` / `explanation`），太長 → `too_long`（`field`、`max`）。
- 錯誤：`ErrTermNotFound`、`ErrTermLimit`（extra `limit`，`errorExtraFor`）、`ErrTermExists` 與 `TermExists(existing)`（extra `term` 是已有的那筆）。
- prompt：`SectionGlossary = "glossary"`（內建保留的 key）、`PromptInput.GlossaryBlock`、`EstimateInputTokens` 算進去、`promptSections` 放在 `memory` 之後、`reply_lines` 之前；`BuildGlossaryBlock(recentFirst, budget, markers)`。

### store（`store/terms.go`、`store/terms_search.go`）

- `CreateTerm`：清理 → 交易：`lineRow` → `lockSeedRoot`（鎖主線、鎖住後確認那條線還在這棵樹、封存拒絕）→ `keepSourceAside` → 來源訊息（`messageOn`：必須在 `{id}` 那條線上）與 `source_label` 快照 → `saveTerm`（同 key：沒 `replace` 回 `TermExists`、有就 `ReplaceTermSource`；新增前數上限）。回 `TermChange{Term, Change, Kept}`。
- `keepSourceAside`：`{id}` 不是主線時，鎖那條線（主線之後）、重讀支線列（樹不對 → `errBranchMoved` 重試）；是順口問且還沒保留 → `SetBranchKept(true)`，回它的 `BranchView`。
- `UpdateTerm`（`TermPatch{Term, Explanation *string}`，都 nil → `invalid_input`；改名撞到另一筆 → `TermExists`）、`DeleteTerm`：都走 `lockTerm`（同 `lockMemo`：先讀、鎖主線、重讀，被搬到別棵樹 → 重試）。
- `ListTerms`（依 `term_key, id`，最多 `max(1000, MaxPerTree)`）、`RecentTermNames`（只取 `term` 欄，依 `updated_at DESC, id DESC`）、`SearchTerms`（keyset：`(rank, term_key, id)`，`rank` 0 = 開頭相符；游標是 base64url 的 JSON，解不開 → `invalid_input`；`limit` 預設 20、最多 100）。
- 樹的搬動：
  - detach（`store/spinoff.go` 的 `rehome`）：`RehomeTerms`（`source_line_id` 在搬走的線上的，改到新主線）。
  - attach（`store/attach_tree.go`）：`DropCollidingTerms`（來源樹裡 `term_key` 目標已有的刪掉）→ `MoveTreeTerms`；`AttachMoved` 多 `Terms`、`DroppedTerms`。
  - 刪除支線、清除順口問、刪除整棵：外鍵（`source_line_id` SET NULL、`root_line_id` CASCADE），不用改程式。
  - 接著問（`store/branch_continue.go`）：`RepointTermSources`（見「和工單不同的地方」3）。

### Engine（`feature_glossary.go`）

- `Glossary()`：沒有 AI（`onOff`），註冊一個 `ContextProvider`（`glossaryContext`）。`features.go` 的目錄、`AllFeatures()`（第七個）、`cmd/tangent-server` 的 `defaultFeatures` 與 `plain` 建構表、`.env.example` 都加上。
- `glossaryContext`：`RecentTermNames(主線, MaxPerTree)` → `BuildGlossaryBlock(…, min(Limits.Glossary.TokenBudget, 預算剩下的), markers)`。整棵樹每條線（含支線、順口問）都帶。
- `prompt.go` 的 `trailingSections` 加 `glossary`（漏掉時穩定段的測試會失敗，實作中真的發生過一次，被 `TestGlossary_TheStablePrefixIsTheSameWithTheFeatureOnOrOff` 抓到）。
- `ListTerms`、`CreateTerm`、`UpdateTerm`、`DeleteTerm`、`SearchTerms`；都先 `needScoped(FeatureGlossary)`。寫入在 commit 後發 `terms.changed`；`CreateTerm` 保留了順口問時接著發 `branch.changed{kept}`。InTx 收到 `store.TermChange`。
- 匯出：`TreeExport.Terms`（功能開著時 `ListTerms`，關著時 `[]`）。

### HTTP（`httpapi/terms.go`）

五條路由（`termRoutes()`），op `terms.create/update/delete`（`httpapi/ops.go`），錯誤碼狀態（`term_not_found` 404、`term_limit` 409、`term_exists` 409）。

### 文件

`API.md`（目錄、匯出、預覽的區塊順序與預算 owner、「名詞表」一節與五條路由、op 表、錯誤碼表、`terms.changed`）、`EMBEDDING.md`（§2 功能表一列與 `AllFeatures()` 說明、§4.1 尾段的列舉、§4.4 三列）、`DESIGN.md`（§4 資料表、§5 鎖的一條、§6 Engine API 與事件表、§7 路由表、§12.3 尾段順序、§12.10 四列）、`DECISIONS_LOG.md`（同四列）、`design/EXTENSIONS.md`（總表一列、`glossary` 一節）、`CHANGELOG.md`（B23 之後一項；標題改成 B13–B24）。

## 測試

| 檔案 | 內容 |
|---|---|
| `domain/glossary_test.go`（9 個） | 正規化（空白、全形、大小寫）、清理與上限（一行、標記、`field`）、解釋可多行、`Limits` 預設與驗證、錯誤碼與 extra、區塊只列名詞且依 key 排序、超過預算留最近的（400 個名詞、300 token 內）、名詞裡的換行與標記被壓平、`BuildPrompt` 的順序 `memory → glossary → reply_lines`、宿主同名區塊被改名 |
| `store/terms_test.go`（8 個） | 從順口問存 → 同一個交易保留（掛勾拒絕時兩者都沒寫入；已保留的不再回 `Kept`）；**存名詞 對 清除**的併發（10 輪：存先 → 順口問被保留、清除跳過；清除先 → `line_not_found`、沒有名詞）；**存名詞 對 接著問**的併發（10 輪：存先 → 來源跟到新支線；接著問先 → `line_not_found`）；detach 帶走子樹的名詞；attach 撞名保留目標的；刪除支線與清除順口問後名詞還在、來源 `""`、標籤不變；全租戶搜尋（開頭相符在前、分頁、封存不列、不跨租戶、壞游標）；接著問把來源改到新支線 |
| `glossary_test.go`（13 個） | 在 `AllFeatures()` 且沒有 AI；CRUD、事件信封、標籤、來源訊息不在那條線上 → `message_not_found`、改名撞名、空 patch、別的租戶；重複與 `replace`；上限、長度、封存（讀可以、寫不行、搜尋不列）；從順口問存 → 保留、事件 `terms.changed` 然後 `branch.changed{kept}`、過了保留期不被清；搜尋；**prompt 只帶名詞**（主線與支線都在 `Trailing`、不在 `Sections`；解釋不在預覽 JSON 也不在 fake runner 收到的 system；預算有 `glossary` 份額且 ≤ 300）；尾段順序 `glossary → reply_lines`；預算 60 token 時留最新的；**穩定前段在功能開或關時逐字相同**（`ChatBlocks()` 的 stable 比對，主線與支線）；功能關閉時五個呼叫都 `feature_disabled`、prompt 沒有區塊也沒有份額、匯出 `[]`、重新打開資料都在；fresh spinoff 不複製；掛勾 rollback 與型別 |
| `httpapi/terms_routes_test.go`（3 個）＋ 路由表 5 列 | 狀態碼（201 / 200 replace / 204）、`term_exists` 帶已有的那筆、`message_not_found`、`limits`、搜尋與壞游標、事件；從順口問存的回應帶 `keptBranch`；預覽的尾段第一個是 `glossary` 且沒有解釋 |
| `httpapi/contract_glossary_test.go` | 契約流程 `f.glossary()`（在 `f.b23()` 之後） |
| `intx_doc_test.go` | `CreateTerm`、`UpdateTerm`、`DeleteTerm` 的 InTx 型別 |
| 改了期望值的既有測試 | `features_test.go` 的 `TestPolicy_OnlyNarrows`（能力字串多 `glossary=off`）、`cmd/tangent-server/config_test.go`（預設功能 19 → 20） |

TDD：每一層先寫測試（第一次紅都是編譯不過）。變異檢查：把 `keepSourceAside` 改成永遠不保留 → `TestGlossary_SavingFromAnAsideKeepsItInTheSameTransaction` 與 `…RacingThePurge` 都失敗（後者在清除先刪掉順口問後讀不到支線）→ 還原。

## 鎖順序與併發

- 寫入只鎖主線；從順口問存時是 **主線 → 順口問那條線**，之後才碰 `tangent_term` 的列。
- 和其他操作：清除（主線 → 順口問 → 子樹）、接著問（主線 → 父線 → 順口問 → 子樹）、刪除支線（主線 → 這條線 → 子樹）都先拿主線，所以和存名詞只會排隊、不會反向等待。`KeepBranch` 只鎖順口問那條線、不等主線，所以也沒有環。
- 清除在鎖下重讀 `kept_at`（B23），存名詞在同一個交易設 `kept_at`，兩者都持有主線的鎖，所以「清除列出之後才被存成名詞」的順口問不會被刪。
- 接著問搬走順口問時，`RepointTermSources` 在接著問的交易裡（主線鎖下）改名詞的來源；存名詞若排在後面，會因為順口問那條線已不在而重試、最後回 `line_not_found`。

## 效能

工單 28 的基準（`docs/devlog/P0-baseline-inventory.md` §2.6）BeginTurn p95 15.82 ms，量的時候 load 7.95。這次機器 load 約 12，所以另外用暫時的 worktree 檢出 `3cfc76a`，與這個分支輪流各跑 3 次 `TestPerf_TurnProtocolAndOutlineWithinBudget`（`AllFeatures()` 現在含 `glossary`，所以每一輪多一個名詞查詢）：

| | BeginTurn p50 | BeginTurn p95 | PreviewTurn p95 |
|---|---|---|---|
| 基線 `3cfc76a` | 15.93 / 16.48 / 16.13 ms | 21.31 / 20.75 / 22.61 ms | 16.35 / 18.58 / 17.17 ms |
| B24 | 16.42 / 16.10 / 16.11 ms | 20.65 / 21.45 / 23.33 ms | 18.16 / 16.99 / 19.24 ms |

差異在雜訊範圍內，沒有明顯退步。暫時的 worktree 已移除（`git worktree remove` + `prune`）。全套 `TestPerf` 也跑過一次，全部在預算內（PromoteBranch p95 84 ms 那一次超過 80 ms 的參考預算；預設不 assert，P0 時是 60.9 ms，這次沒有碰 promote，屬於負載雜訊）。

## 和工單不同的地方

1. **多一份事件樣本 `event.terms.changed.json`**：契約測試對每個事件型別記一份樣本（同 B23 多了 `event.branch.changed.kept.json`），並列進必備清單、`API.md` 引用。工單只列四份路由樣本。
2. **`DELETE /terms/{tid}` 沒有樣本**：回 204、沒有本文（照工單）。備忘的刪除回 `200 {memo}`，這裡照工單的 204。
3. **接著問（B23）會把名詞的來源改到新支線**：工單 §5 沒提接著問。照備忘的做法會讓 `sourceLineId` 變成 `""`；但接著問把順口問的訊息（id 不變）整個搬到新支線，名詞的來源訊息還在，指向新支線比較正確。動到 `store/branch_continue.go` 一行查詢（`RepointTermSources`），有測試。
4. **`POST` 回 `{term, change, keptBranch?}`**，不是只有 `{term}`：`change` 讓前端分辨新增（201）與覆寫（200）；`keptBranch` 是這次被設成保留的順口問（沒有就不出現），省掉一次 `GET /branch`。`PATCH` 回 `{term}`。
5. **「規則區塊要求模型不必重新解釋」寫在名詞表自己的尾段區塊裡**，沒有改穩定段的規則（`rules`）：改了規則，開或關功能時穩定段就不同，prompt 快取會失效，違反「穩定前段逐字相同」。
6. **detach 時不會撞名**：新樹的主線就是被搬走的支線，原本沒有名詞，而搬過去的名詞來自同一棵樹（key 本來就不重複），所以「重複時保留新樹的」不會發生；查詢就是單純的 `UPDATE`，註解寫明。
7. **attach 撞名的判斷用 `term_key`**，被刪的是來源那筆；不發 `terms.changed`（同備忘：樹搬動不發這類事件），前端在 attach 後本來就會重讀。
8. **`replace` 不改名詞原文**（工單：「原地覆寫解釋與來源」）。
9. **名詞表的列表上限 1,000**（不是 300）：attach 可能讓一棵樹超過 300 筆，列表若只取 300 會看不到一部分；新增仍以 300 為上限。
10. **`GET /terms` 的 `limit` 是 1–100、預設 20**（工單沒寫數字）；`q` 空白時列出全部；排序是「開頭相符 → 包含」，各自依 `term_key`。
11. **`glossary` 成為內建保留的 prompt section key**：宿主若有 key 是 `glossary` 的區塊，會被改名 `host:glossary`（同 `memory` 等內建 key 的既有規則）。寫進 CHANGELOG 的「嵌入者注意」。
12. **`created_at` / `updated_at` 的預設照工單用 `now()`**；修改時 `updated_at = clock_timestamp()`（同備忘）。另外加了三個「非空」的 CHECK（見「資料」）。
13. 檔名照協調者的指示用領域名稱（`glossary_test.go`、`httpapi/terms_routes_test.go`），不是工單 §6 的 `b24_test.go`。
14. `bash scripts/smoke.sh` 沒有跑（見驗收）。

## 給前端（F19）

### 能力與功能名

- `GET /capabilities` 多 `{name: "glossary", enabled}`（沒有 `mode`），排在 `memo` 之後、`suggestions` 之前。`FEATURE_NAMES` 要加 `glossary`（目前 22 → 23；`capabilities.test.ts` 的數量與描述要跟著改）。

### 物件

```ts
interface Term {
  id: string; rootLineId: string;
  term: string;            // 原文（一行，≤ 60 字）
  termKey: string;         // 正規化：去空白、全形轉半形、小寫；同一棵樹唯一
  explanation: string;     // ≤ 1,000 字，可多行
  sourceLineId: string;    // 來源線；那條線被刪除或清除後是 ""
  sourceMessageId: string; // 沒給是 ""
  sourceLabel: string;     // 寫入時的來源名稱快照（主線 #3、順口問・目的…）
  createdBy: string; createdAt: string; updatedAt: string;
}
type TermHit = Term & { rootTitle: string };
```

### 路由

| 路由 | 本文 | 成功 | 錯誤 |
|---|---|---|---|
| `GET /lines/{id}/terms` | — | `200 {rootLineId, terms: Term[]（依 termKey）, limits: {maxTotal: 300, termMaxRunes: 60, explanationMaxRunes: 1000}}` | `404 line_not_found`、`404 feature_disabled` |
| `POST /lines/{id}/terms`（`{id}` = 來源線） | `{term, explanation, sourceMessageId?, replace?}` | 新增 `201`、覆寫 `200`：`{term: Term, change: "created" \| "updated", keptBranch?: BranchView}` | `400 invalid_input`（`field: term / explanation`）、`422 too_long`（`field`、`max`）、`404 line_not_found`、`404 message_not_found`（訊息不在 `{id}` 上）、`409 term_exists`（extra `term: Term`，已有的那筆；帶 `replace: true` 再送就覆寫）、`409 term_limit{limit}`、`409 archived`、`404 feature_disabled` |
| `PATCH /terms/{tid}` | `{term?, explanation?}`（至少一個） | `200 {term: Term}` | `400 invalid_input`（兩個都沒給）、`422 too_long`、`409 term_exists`（改名撞到另一筆）、`404 term_not_found`、`409 archived`、`404 feature_disabled` |
| `DELETE /terms/{tid}` | — | `204`（沒有本文） | `404 term_not_found`、`409 archived`、`404 feature_disabled` |
| `GET /terms?q=&limit=&cursor=` | — | `200 {terms: TermHit[], nextCursor}`（`""` = 沒有下一頁）；開頭相符的在前；封存的對話不列 | `400 invalid_input`（`limit` 不在 1–100、壞游標）、`404 feature_disabled` |

`term` 與 `explanation` 存的是伺服器清理過的文字（去頭尾空白、名詞壓成一行），前端顯示時以回應為準。

### 事件（commit 之後）

- `terms.changed`：`data = {rootLineId, termId, change: "created" | "updated" | "deleted"}`；信封 `lineId` = 名詞的來源線（可能是 `""`）、`rootLineId` = 主線。收到就重讀那棵樹的 `/terms`（與全租戶搜尋）。
- 從順口問新增（且那條順口問還沒保留）：先 `terms.changed{created}`，再 `branch.changed{kept}`（`branch.keptAt` 有值）。`replace` 覆寫時同樣規則（`change: "updated"`）。
- detach / attach、刪除支線、清除順口問、接著問造成的名詞變動**不發** `terms.changed`（attach / detach 之後前端本來就會重讀樹）。

### Prompt 與預覽

- `POST /lines/{id}/preview`：有名詞時 `prompt.trailing[]` 多一個 `{key: "glossary", body}`（在 `memory` 之後、`reply_lines` 之前）；`blocks` 同樣有 `key: "glossary"`；`budget.shares` 多 `{owner: "glossary", tokens}`。解釋從不出現在預覽裡。
- 匯出 `GET /lines/{id}/export` 多 `terms: Term[]`（依 `termKey`；功能關著時 `[]`）。

### web client 契約測試預期會失敗的項目（沒有在這個 worktree 跑 vitest：沒有 `node_modules`，也不改 `web/`；以下依測試程式碼推斷）

| 測試 | 原因 |
|---|---|
| `packages/client/src/contract.test.ts` › `route.terms.create` / `route.terms.list` / `route.terms.update` / `route.terms.search` | `ROUTES` 沒有 `POST /lines/{id}/terms`、`GET /lines/{id}/terms`、`PATCH /terms/{id}`、`GET /terms` 的 client 呼叫（"no client call for …"） |
| `contract.test.ts` › `event.terms.changed` | `parseEvent` 不認得 `terms.changed`（很可能失敗；要加型別與解析） |
| `contract.test.ts` › `route.capabilities`、`route.capabilities.viewer` | `normalizeCapabilities` 只留已知功能，`glossary` 被丟掉 → 回傳值與樣本不同（很可能失敗） |
| `contract.test.ts` › `route.lines.export` | 匯出的正規化若只留已知欄位，`terms` 會被丟掉（很可能失敗） |
| `packages/client/src/errors.test.ts` › "lists exactly the codes domain/errors.go defines" | `domain/errors.go` 多 `term_not_found`、`term_limit`、`term_exists` |
| `contract.test.ts` 的 `ALL_ERROR_CODES` | 這次沒有錯誤樣本用到新碼，所以不會因此失敗；但 F19 要把三個碼加進去（`term_exists` 的 extra `term` 是一個 `Term` 物件，不是數字） |

`capabilities.test.ts` 的 `FEATURE_NAMES` 長度 22 現在**不會**失敗（它檢查的是前端自己的清單），F19 加 `glossary` 時要改成 23。

## 希望協調者特別檢查

1. **鎖順序**：`store/terms.go` 的 `CreateTerm`（`lockSeedRoot` → `keepSourceAside` → 名詞列）。`keepSourceAside` 在主線之後鎖順口問那條線，然後才 `SetBranchKept`；請對照 B23 的 `purgeAside`、`replaceAside`、`DeleteBranch` 確認沒有反向的路徑。
2. **併發測試的覆蓋**：`TestGlossary_SavingFromAnAsideRacingThePurge` / `…RacingItsContinue` 各跑 10 輪，兩種結果都有分支檢查；沒有強制兩種結果都一定出現（同 B23 的測試寫法）。
3. **prompt 的位置**：`prompt.go` 的 `trailingSections` 與 `domain/prompt_build.go` 的 `promptSections` 兩處都要有 `glossary`；穩定前段的測試在主線與支線各比一次。
4. **預算**：`min(Limits.Glossary.TokenBudget, pc.budget.remaining())`；`BuildGlossaryBlock` 先依最近更新累加估算，再用整個區塊的 `EstimateTokens` 確認不超過（逐個丟掉最舊的）。區塊內依 `termKey` 排序，所以名詞沒變時區塊逐字不變。
5. **`AllFeatures()` 多了 `glossary`**：所有用 `AllFeatures()` 的測試環境、`httpapi` 的 harness 與參考伺服器都會多一個每輪的名詞查詢（一個走 `UNIQUE (root_line_id, term_key)` 索引的查詢；空表時沒有區塊、沒有預算份額）。
6. **接著問改來源**（和工單不同的地方 3）是否接受。
