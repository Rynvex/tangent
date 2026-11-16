# 嵌入指南

> 怎麼把 tangent 放進你自己的 Go + Postgres 服務。契約見 `docs/DESIGN.md`（§3–§7、§9、§11、§12）；HTTP 路由、錯誤碼與事件見 `docs/API.md`。
>
> 本文的每段 Go 程式碼都是 `examples/embedding/` 裡真的會編譯、有測試的程式碼，原樣引用（`<!-- snippet: 檔案#名稱 -->` 標出來源）；
> `examples/embedding/snippets_test.go` 會在兩邊不一致時失敗。完整可執行的範例服務在 `examples/minimal-host/`。

## 目錄

0. [取得 tangent](#0-取得-tangent)
1. [最小嵌入](#1-最小嵌入)
2. [選功能](#2-選功能)
3. [執行 AI](#3-執行-ai)
4. [宿主掛勾](#4-宿主掛勾)
5. [認證、租戶與即時通道](#5-認證租戶與即時通道)
6. [遷移策略](#6-遷移策略)
7. [維護迴圈](#7-維護迴圈)
8. [升級規則](#8-升級規則)

套件一覽：

| 套件 | 用途 |
|---|---|
| `github.com/Rynvex/tangent/tangent` | `Engine`：turn 協定、支線、功能模組、事件、掛勾 |
| `.../store` | migrations（`Migrate`、`MigrationsFS`）與交易；宿主通常只用到遷移與 `store.Tx` |
| `.../domain` | 純型別與邏輯（`LineView`、`Message`、`Prompt`、錯誤碼、`QuoteUntrusted`） |
| `.../httpapi` | 可掛載的 `http.Handler` 與 SSE `Hub` |
| `.../runner/openai`、`.../runner/anthropic`、`.../runner/fake` | 現成的 `Runner`（API 與假模型） |
| `.../runner/cli` | 現成的 `Runner`：用訂閱登入的命令列 AI 工具（Claude Code、Codex、Antigravity CLI），見 §3.5 |
| `.../tangenttest` | 測試工具：每個測試一個乾淨 schema、假 Runner、事件收集器 |

## 0. 取得 tangent

tangent 是 Go module `github.com/Rynvex/tangent`，版本是 git 標籤（第一個是 `v0.1.0`），每個版本的內容見 [CHANGELOG.md](../CHANGELOG.md)。
需要 Go 1.26.1 以上（`go.mod` 的 `go` 指令）與 Postgres（`search` 要 `pg_trgm`、`memory` 要 `vector` 擴充，見[第 2 節](#2-選功能)）。

**安裝 Go module**：可直接透過公開的 Go module proxy 取得指定版本：

```bash
go get github.com/Rynvex/tangent@v0.1.0
```

**從 `replace` 換成版本**：本機開發若曾使用 `replace` 指到當地工作目錄：

```bash
go mod edit -dropreplace github.com/Rynvex/tangent
go get github.com/Rynvex/tangent@v0.1.0
go mod tidy
```

`go.mod` 之後會是 `require github.com/Rynvex/tangent v0.1.0`、沒有 `replace`，`go.sum` 也會補上 tangent 的雜湊。
本機要同時改 tangent 時可以暫時用 `replace` 指到自己的工作目錄，但不要 commit。
Web 套件（`web/packages/client`、`react`、`fonts`）不發布到 npm，版本號跟 Go module 相同；要用的話從同一個標籤取用（例如 `git archive` 或直接自 repo 複製／子模組引入）。

**版本政策**：

- 版本號依語意化版本。**0.x 期間次版號（`v0.1` → `v0.2`）可能有不相容的變更**，都會寫在 CHANGELOG 該版的「變更」或「移除」；
  修訂號（`v0.1.0` → `v0.1.1`）只修錯誤，不改 API。
- 升級前先讀 CHANGELOG，再 `go get github.com/Rynvex/tangent@<新版本>`；每個版本附帶它需要的 migration，照[第 8 節](#8-升級規則)先遷移再換程式。

## 1. 最小嵌入

開 pool → `store.Migrate` → `tangent.New` → 選一個 Dispatcher → `httpapi.New` → 掛到你的路由：

<!-- snippet: examples/embedding/minimal.go#minimal -->
```go
func Mount(ctx context.Context, mux *http.ServeMux, pool *pgxpool.Pool) (*tangent.RunnerDispatcher, error) {
	if err := store.Migrate(ctx, pool); err != nil {
		return nil, err
	}
	engine, err := tangent.New(pool, tangent.WithFeatures(tangent.AllFeatures()...))
	if err != nil {
		return nil, err
	}
	dispatcher := tangent.NewRunnerDispatcher(engine, fake.New(fake.Config{}))
	api, err := httpapi.New(httpapi.Config{
		Engine: engine, Dispatcher: dispatcher,
		Scope: func(*http.Request) (tangent.Scope, error) { return tangent.Scope{Tenant: "demo"}, nil },
	})
	if err != nil {
		return nil, err
	}
	mux.Handle("/api/", http.StripPrefix("/api", api))
	return dispatcher, nil
}
```

`Scope` 回傳固定租戶只適合示範；正式的認證見[第 5 節](#5-認證租戶與即時通道)。`fake.New` 是不連網的假模型，
換成 `openai.New(openai.Config{…})` 或 `anthropic.New(anthropic.Config{APIKey: …})` 就是真的 AI。
回傳的 `RunnerDispatcher` 在關機時要 `Shutdown`，讓執行中的回合把結果寫回去：

<!-- snippet: examples/embedding/minimal.go#minimal-serve -->
```go
func Serve(ctx context.Context, databaseURL, addr string) error {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	mux := http.NewServeMux()
	dispatcher, err := Mount(ctx, mux, pool)
	if err != nil {
		return err
	}
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- srv.ListenAndServe() }()
	select {
	case err := <-served: // the listener failed (for example the port is taken)
		return errors.Join(err, dispatcher.Close())
	case <-ctx.Done():
	}
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownBudget)
	defer cancel()
	// Requests drain first, then running turns and jobs write their outcome back.
	return errors.Join(srv.Shutdown(stopCtx), dispatcher.Shutdown(stopCtx))
}
```

最小嵌入還少三件正式環境要有的事，`examples/minimal-host/` 都做了：

- **維護迴圈**：定期呼叫 `Engine.Maintain`（[第 7 節](#7-維護迴圈)），否則行程當掉留下的 pending 回合不會結束。
- **SSE**：`httpapi.NewHub()` 同時傳給 `tangent.WithPublisher(hub)` 與 `httpapi.Config{Hub: hub}`，才有 `GET /events`。
- **孤兒 job**：`engine.SetJobDispatcher(dispatcher)`，讓「在 `BeginTurn` 裡失敗的回合」啟動的背景工作也有人執行。

## 2. 選功能

核心（線、訊息、回合、支線、結論卡 merge / discard、promote、move、背景包、封存與刪除、`PreviewTurn`）永遠開著。
其他都是內建、可選的功能模組，用 `tangent.WithFeatures(...)` 挑選；沒挑的功能不會被呼叫，路由也不會掛上。

| 功能 | 建構 | AI | 加了什麼 |
|---|---|---|---|
| `notes` | `Notes()` | 否 | 整棵樹共用的紀要、merge 時一起寫入、prompt 帶入；`/notes` 路由 |
| `chapters` | `Chapters()` | 否 | 章節與 milestone；`/chapters` 路由 |
| `aside` | `Aside()` | 否 | `kind: aside` 的岔題（一問一答後自動結束，7 天後清除） |
| `summary` | `Summary(mode, opts...)` | 是 | 滾動摘要 job；`POST /compact`；suggest 模式下該摘要時回 `CompletedTurn.SummaryDue` 並發 `summary.due` 事件 |
| `card_draft` | `CardDraft(opts...)` | 是 | AI 起草結論卡；`POST /branch/draft` |
| `branch_suggest` | `BranchSuggest(mode, opts...)` | 是 | AI 在回覆裡提議支線（`[BRANCH-SUGGEST]`），存在 `meta.suggestions` |
| `search` | `Search()` | 否 | `GET /search`；**需要資料庫擴充**（`pg_trgm`），見下 |
| `leaf` | `Leaf(mode, opts...)` | 是 | 支線的收尾（`/leaf`）：merge 由結論卡產生、discard 可帶死路原因；suggest / auto 時放棄的支線與 promote 後的前主線由 `leaf_draft` job 起草。不進 prompt |
| `parking` | `Parking()` | 否 | 停車場種子（`/seeds`）：不開支線、不呼叫 AI；展開成支線、記進紀要（需要 `notes`）或丟掉 |
| `memo` | `Memo()` | 否 | 備忘（`/memos`，B13）：寫在節點上、**不給 AI**（不進 prompt、預覽與背景工作）；讀得到對話的人都讀得到，不是私人的。每棵樹 500 則 |
| `glossary` | `Glossary()` | 否 | 名詞表（`/lines/{id}/terms`、`/terms`，B24）：一棵樹一份「名詞 → 解釋」，可以全租戶查（`GET /terms`）。**進 prompt 的只有名詞本身**：每一輪的尾段區塊 `glossary`（記憶之後、回覆行規則之前，不在快取段），最多 `Limits.Glossary.TokenBudget`（300）token、超過時留最近更新的，要模型不必再解釋；解釋不進 prompt。從順口問存名詞會在同一個交易把順口問設成保留（B23）。每棵樹 300 筆。在 `AllFeatures()` |
| `spinoff` | `Spinoff()` | 否 | 獨立成新對話（`POST /spinoff`：detach 或 fresh）與 `GET /links`；新主線帶起始膠囊 |
| `rebalance` | `Rebalance(mode, opts...)` | 是 | 樹平衡提示：支線佔滿對話時提出「升為主線 / 獨立成新對話」的建議（**需要 `leaf`**；manual 不提，auto 等同 suggest） |
| `goal` | `Goal(mode, opts...)` | 是 | 對話目標（`/goal`）：一句目標放在 prompt 規則之後（穩定區塊）；`POST /goal/propose` 請 AI 從前幾輪提出（`goal_propose` job → 建議匣）；suggest / auto 時主線第 2 輪後沒有目標會自己提，並每 `Limits.Goal.DriftEvery`（4）輪排 `drift_check` job，偏題時建議開支線或岔題（`drift`）。auto 直接寫入目標（不覆蓋已有的） |
| `relations` | `Relations(mode, opts...)` | 是 | 關聯線（`/relations`，`GET /links` 也列出）：兩端是線或訊息，同一棵樹或跨樹（同租戶），說明 ≤ 200 字，每棵樹上限 `Limits.Relations.MaxPerTree`（200）；suggest 時支線 merge / discard 後由 `relation_suggest` job 提出關聯（建議匣，kind `relation`；auto 等同 suggest） |
| `open_loops` | `OpenLoops()` | 否 | 未完成清單（`GET /open-loops`）：開太久的支線（預設 3 天沒有活動）、待確認的紀要、open 的種子與建議（只列開著的功能），依租戶或單一對話；只讀 |
| `fisheye` | `Fisheye()` | 否 | 魚眼脈絡：取代預設的「最近訊息」（`HistorySelector`），每則訊息與每條其他支線依「先天重要性 − 距離」得分、分成 `full / summary / leaf_only / hidden`，其他支線的收尾放進「其他支線的結論」區塊；`PreviewTurn` 的 `fisheye.items` 逐項回報。**需要 `leaf`**；參考伺服器預設關閉 |
| `group` | `Group(mode, opts...)` | 是 | 群組與合併支線（`/groups`、`POST /branches/combine`）：已結束的支線圈成群組，`group_summary` job 寫共同摘要，魚眼裡以摘要取代成員的收尾；進行中的兄弟支線合併成一條新支線（`origin: merge`，舊的 discarded + `mergedIntoLineId`）；矛盾的選擇 `adoptBranch / adoptOther / keepBoth`（keepBoth 寫進紀要「待確認」，需要 `notes`）。suggest 時支線結束後 `group_suggest` job 提出群組（建議匣，kind `group`；auto 等同 suggest）。**需要 `leaf`** |
| `ibis` | `Ibis(mode, opts...)` | 是 | 論證類型（`PUT/DELETE /messages/{mid}/tag`）：訊息標成 `question / idea / pro / con / decision`；`Message.tag`、大綱的 `BranchView.anchorTag` 帶出。suggest / auto 每 `Limits.Ibis.Every`（3）則回覆（岔題除外）排 `ibis_tag` job，便宜模型一次標這條線上次之後還沒標的訊息（至多 `Limits.Ibis.BatchMax` 12 則）：suggest 寫成 `draft`（使用者 PUT 即確認），auto 寫成 `confirmed`。AI 不覆蓋任何已有的標記（使用者的尤其）。`fisheye` 開著時確認的 `decision` 標記是先天重要性 +4 |
| `fold` | `Fold(mode, opts...)` | 是 | 折疊（`/lines/{id}/folds`、`PATCH / DELETE /folds/{fid}`）：一段訊息在之後的 prompt 以摘要取代（在 `HistorySelector` 之前套用，魚眼把它當一項）；不給摘要時 `fold_summary` job 起草。move / promote 時跟著訊息走。`PreviewTurn` 的 `folds` 列出套用的折疊。suggest 時每 `Limits.Fold.SuggestEvery`（10）個回覆找最舊的已結束章節，`fold_suggest` job 起草摘要 → 建議匣（kind `fold`，忽略後不再提；auto 等同 suggest） |
| `diverge` | `Diverge(mode, opts...)` | 是 | 發散 / 收斂 / 決定（`POST /lines/{id}/diverge`、`/converge`、`/comparisons`）：`diverge` job 從一則訊息提出 2–5 個方向，各開成兄弟支線（`kind: alternative`、`origin: diverge`，背景包寫明方向與其他方向）；`converge` job 對 2–5 條進行中的兄弟支線做「條件 × 選項」比較表與建議（`tangent_comparison`）；`decide` 一個交易內替選定的支線寫 `decision` 收尾、其他比較的支線放棄 + `dead_end` 收尾。都是使用者按了才做（任何模式相同）。**需要 `leaf`** |
| `memory` | `Memory(mode, MemoryConfig{Embedder, NoTurnRecall}, opts...)` | 是 | 跨對話記憶（`/memories`）：事實 / 決定 / 偏好 / 教訓，各帶出處，只能取代、不刪除。召回 = 相關性（`Embedder` 的 cosine）× 近期 × 重要性：每一輪 prompt 帶最相關的幾筆（trailing 區塊 `memory`，只在 `PreviewTurn` 看得到；`NoTurnRecall` 關掉），`POST /memories/search` 給開新對話 / 開支線時的提示。suggest / auto 在 merge、確認的收尾、決定的紀要之後由 `memory_extract` job 提出（建議匣 kind `memory` / 直接寫入）；維護迴圈 `memory.consolidate` 找近似重複的記憶 → `memory_consolidate` job → 建議匣（合併或矛盾）。**需要 `notes`、`Embedder`、`vector` 擴充與功能 migration**（`store.MigrateFeatures(ctx, pool, "memory")`）；不在 `AllFeatures()`，參考伺服器預設關閉 |
| `suggestions` | （不是建構函式） | — | 建議匣（`/suggestions`）：不是獨立的功能，有會提建議的功能（`rebalance`、`goal`、`relations`、`group`、`fold`、`memory`）開著時才存在，`/capabilities` 列為 `{name: "suggestions", enabled}` |

`tangent.AllFeatures()` = 前六個（`notes`、`chapters`、`aside`、`summary`、`card_draft`、`branch_suggest`；`Summary` 與 `BranchSuggest` 為 `ModeSuggest`）加上 B24 的 `glossary`。
**不含** `search`（要資料庫擴充，要你明確開啟），也**不含** P1 的 `leaf`、`parking`、`spinoff`、`rebalance`、P2 的 `goal`、`relations`、`open_loops`、P3 的 `ibis`、`fold`、`diverge` 與 B13 的 `memo`（要用就自己加進 `WithFeatures`；
`rebalance` 需要 `leaf`，缺了 `New` 回錯）。參考伺服器的預設多開了 `search`、`leaf:suggest`、`parking`、`spinoff`、`rebalance:suggest`、`goal:suggest`、`relations:suggest`、`open_loops`、`group:suggest`、`ibis:suggest`、`fold:suggest`、`diverge:manual`、`memo`（`fisheye` 預設關閉，用 `TANGENT_FEATURES=…,fisheye` 開；`memory` 也預設關閉，用 `TANGENT_FEATURES=…,memory:suggest` 開，`TANGENT_EMBEDDER=fake`（fake provider 的預設，沒有網路）或 `openai`（`OPENAI_API_KEY`、`TANGENT_EMBEDDING_MODEL` 預設 `text-embedding-3-small`、`TANGENT_EMBEDDING_DIM` 預設 1536），資料庫要有 `vector` 擴充）。

**參考伺服器的預設組（B25）**：`TANGENT_FEATURES` 除了逐一列功能，也接受三個預設組的名稱（不分大小寫），可以和個別功能混用，由左到右讀、後面的覆寫前面的
（同一個功能後面再出現時取代前面那一項、位置不變；`none` 清掉前面全部）：

| 預設組 | 內容 |
|---|---|
| 精簡 `essential` | `notes, chapters, aside, summary:suggest, card_draft, leaf:manual, parking, spinoff, search, memo, glossary`：主迴圈（對話、順口問、支線與結論卡）加上不會自己呼叫模型的小幫手 |
| 標準 `standard` | 上面那一長串預設（`defaultFeatures`）；**沒設 `TANGENT_FEATURES` 時就是它** |
| 完整 `full` | `standard` 加 `fisheye`、`memory`（`memory` 仍需要 `TANGENT_EMBEDDER`；fake provider 預設用 fake embedder） |

例：`TANGENT_FEATURES=essential,goal:manual,relations:manual`（精簡組再加兩個手動的）、`TANGENT_FEATURES=standard,ibis:off`（模式 `off` 等同不開）。
未知的名稱回錯並列出預設組。`memory` 開著而 embedder 是 `fake` 時，啟動記一行 WARN（召回結果沒有意義，只適合測試流程），不擋啟動。
預設組只是參考伺服器的設定；函式庫的 `AllFeatures()` 不變，嵌入時照樣用 `WithFeatures` 自己挑。

每一輪 prompt 的區塊共用一個 token 預算 `Limits.Context.TokenBudget`（預設 40,000）：背景包 / 起始膠囊 / 結論卡通知先算，再依 `WithFeatures` 順序算各功能的區塊（紀要只取剩下的），再算宿主區塊，歷史拿剩下的（最多 `Limits.History.TokenBudget`）；`PreviewTurn` 的 `budget` 逐項回報。
訊息釘選（`POST /messages/{mid}/pin`）是核心，不需要功能。
`tangent.SuggestionProbe()` 只給測試、smoke 與 e2e 用（回覆含 `[probe:suggest]` 時提一筆測試建議），不是產品功能，不在 `AllFeatures()`、也不在 `/capabilities`。

**模式**（用到 AI 的功能）：`ModeOff`（關）/ `ModeManual`（使用者按了才做）/ `ModeSuggest`（AI 提出、使用者確認）/ `ModeAuto`（AI 直接做）。
`JobModel(provider, model)` 讓該功能的背景工作用另一個（通常較便宜的）模型。`card_draft` 只有開 / 關，何時起草由客戶端決定。

<!-- snippet: examples/embedding/features.go#features -->
```go
func NewEngine(ctx context.Context, pool *pgxpool.Pool, tiers TierLookup) (*tangent.Engine, error) {
	if err := store.Migrate(ctx, pool); err != nil {
		return nil, fmt.Errorf("migrate tangent: %w", err)
	}
	// search needs pg_trgm: install it (or check it) and the feature's indexes.
	if err := store.MigrateFeatures(ctx, pool, tangent.FeatureSearch); err != nil {
		return nil, fmt.Errorf("migrate tangent search: %w", err)
	}
	return tangent.New(pool,
		tangent.WithFeatures(
			tangent.Notes(),
			tangent.Chapters(),
			tangent.Aside(),
			// Summaries and card drafts run on a cheaper model than the conversation.
			tangent.Summary(tangent.ModeAuto, tangent.JobModel("anthropic", "claude-haiku-4-5")),
			tangent.CardDraft(tangent.JobModel("anthropic", "claude-haiku-4-5")),
			tangent.BranchSuggest(tangent.ModeSuggest),
			tangent.Search(),
		),
		tangent.WithFeaturePolicy(TierPolicy{Tiers: tiers}),
	)
}
```

**需要資料庫擴充的功能**：先 `store.Migrate`，再 `store.MigrateFeatures(ctx, pool, "search")`，最後 `tangent.New`。
`MigrateFeatures` 會 `CREATE EXTENSION IF NOT EXISTS pg_trgm`（要有建立擴充的權限），擴充裝在連線 `search_path` 的**第一個** schema
（跟 tangent 的資料表一樣）。想把擴充放在共用 schema（例如 `extensions`）的宿主，事先自己 `CREATE EXTENSION pg_trgm SCHEMA extensions`，
並確認那個 schema 在 `search_path` 上；之後 `MigrateFeatures` 只檢查它看得到（DESIGN §12 R4）。
`tangent.New` 對有 migration 的功能會呼叫 `store.CheckFeatures`：擴充不在、不在 `search_path` 或 migration 沒跑，`New` 直接回錯並寫出要執行什麼。

**`memory`**（B10）同樣需要擴充（`vector`，pgvector；開發資料庫的映像是 `pgvector/pgvector:pg17`）：`store.MigrateFeatures(ctx, pool, "memory")`。
另外要給 `MemoryConfig.Embedder`（`tangent.Embedder`：`Embed(ctx, texts) ([][]float32, error)`、`Dim() int`），沒給 `New` 直接回錯：

```go
embedder, err := openai.NewEmbedder(openai.EmbedderConfig{APIKey: key, Model: "text-embedding-3-small", Dim: 1536})
// …
tangent.WithFeatures(tangent.Notes(), tangent.Memory(tangent.ModeSuggest, tangent.MemoryConfig{Embedder: embedder},
	tangent.JobModel("openai", "gpt-4.1-mini")))
```

向量欄位不固定維度（`vector`，另存 `embedding_dim`）：換 Embedder 的模型或維度後，舊記憶不會被召回（只比同一維度的），要重新嵌入就取代它們。
每一輪召回會呼叫一次 Embedder（在 `BeginTurn` 的交易之外，失敗只記 log、這一輪不帶記憶）；不想每輪呼叫就設 `NoTurnRecall`。
測試與 fake 模式用 `runner/fake.NewEmbedder(0)`（決定性的雜湊，不連網）。
`dead_end` 等函式庫自己寫的收尾文字用伺服器語言：`tangent.WithLeafTexts(domain.EnglishLeafTexts())`（預設繁中，同 `WithNoteSourceLabels`）。

**執行期政策** `FeaturePolicy`：依租戶或對話**收窄**設定（只能關或降級，不能打開沒設定的功能；有效模式 = 設定與政策取小）。
Engine 在每次呼叫的交易**之前**問一次，所以政策要快（有需要就自己快取）。

<!-- snippet: examples/embedding/features.go#policy -->
```go
// TierLookup is the host's own answer to "which plan is this tenant on".
type TierLookup func(ctx context.Context, tenant string) string

// TierPolicy narrows the configured features for tenants on the free plan.
// A policy can only narrow: returning ModeAuto keeps what was configured.
type TierPolicy struct{ Tiers TierLookup }

func (p TierPolicy) Mode(ctx context.Context, scope tangent.Scope, feature string) tangent.Mode {
	if p.Tiers(ctx, scope.Tenant) != "free" {
		return tangent.ModeAuto
	}
	switch feature {
	case tangent.FeatureSummary:
		return tangent.ModeManual // only when the operator presses "compact"
	case tangent.FeatureBranchSuggest, tangent.FeatureSearch:
		return tangent.ModeOff // capabilities say disabled; the routes answer 404 feature_disabled
	}
	return tangent.ModeAuto
}
```

功能被關掉之後資料保留不刪；讀取回 `404 feature_disabled`、prompt 不再帶入；重新打開就恢復。
`Engine.Capabilities(scope)` 與 `GET /capabilities` 回傳每個功能對這個租戶的有效狀態，前端依此顯示 UI。

## 3. 執行 AI

函式庫從不決定一輪 AI 怎麼跑。契約只有兩半：

- **開始**（客戶端那一側，httpapi 會呼叫）：`BeginTurn(ctx, scope, lineID, TurnInput)` → 檢查能否開始 → `TurnGate` → 存使用者訊息與一則
  pending 的助理訊息、線改 `thinking` → commit → 組好 prompt，回傳 `Turn{ID, Scope, LineID, RootLineID, UserMessage, Pending, Prompt, Provider, Model}`。
  `Turn.ID` 就是 pending 訊息的 id。
- **完成**（執行端）：`CompleteTurn(ctx, turnID, TurnResult{Content | Error, Usage, …})`。冪等：已經不是 pending（被取消、被判逾時）就回
  `domain.ErrTurnNotPending` 而不寫入。完成時解析 `[BRANCH-SUGGEST]`、標記卡片送達、結束已回答的岔題，回傳 `CompletedTurn`
  （其中 `Jobs` 是這一輪啟動的背景工作，例如 auto 模式的摘要，**呼叫者要負責執行**）。
  回覆裡的 `[TOPIC]` / `[CHAPTER]` 行一律拿掉；它們的標題（第一輪改名、主線切章，B16）只在**組這一輪 prompt 的同一個 Engine**
  （`BeginTurn` / `RetryTurn` / `LoadTurn`）呼叫 `CompleteTurn` 時才用：在別的程序完成，先在那裡 `LoadTurn`。
- 串流（執行端，可選）：`AppendDelta(ctx, turnID, Delta)` 把一段文字放進緩衝（`GET /stream`）並發 `message.delta`。
- 背景工作：`StartDraft` / `StartSummary` / 功能自己啟動的 `Job{ID, Kind, Prompt, Provider, Model}`，執行完用
  `FinishJob(ctx, jobID, raw, runErr)` 回報；`raw` 是模型的原始輸出，由擁有該 kind 的功能解析。

`CompleteTurn`、`AppendDelta`、`FinishJob` 只拿 id 當憑證、不檢查租戶，**只給執行端用**；httpapi 絕不把它們開放給客戶端，你的路由也不要。

`Turn.Prompt` 是結構化的 `domain.Prompt`：`Chat()` 給 API 型 runner（system + messages），`ChatBlocks()` 再把 system 分成穩定段與變動段
（prompt 快取用），`Text()` 給 CLI 型的代理（一整段文字）。

現成的 runner：

| runner | 用途 | 適合 |
|---|---|---|
| `runner/anthropic` | Anthropic Messages API（穩定段標 prompt 快取） | 正式環境、背景工作 |
| `runner/openai` | OpenAI 相容的 chat completions（OpenAI、DeepSeek、OpenRouter、Ollama…） | 正式環境、背景工作、本機模型 |
| `runner/cli` | 命令列 AI 工具（`claude`、`codex`、`agy`），用機器上已登入的訂閱 | 個人、單機使用主對話（§3.5） |
| `runner/fake` | 不連網的假模型 | 測試、smoke、e2e |

### 3.1 同步：`RunTurn`

`RunTurn(ctx, turn, runner)` 是便利函式：`Prompt` → `Runner.Run`（串流 delta、發 `turn.retrying`）→ `CompleteTurn`。
runner 失敗或 panic 時，這一輪以固定文字標成失敗（細節只寫 log）。適合 CLI、測試、或想等回覆再回應的 handler：

<!-- snippet: examples/embedding/turns.go#run-turn -->
```go
// AskSync runs one turn in the caller's goroutine: a CLI, a test or a
// handler that wants the reply before it answers.
func AskSync(ctx context.Context, engine *tangent.Engine, model tangent.Runner, scope tangent.Scope, lineID, text string) (domain.Message, error) {
	turn, err := engine.BeginTurn(ctx, scope, lineID, tangent.TurnInput{Content: text})
	if err != nil {
		return domain.Message{}, err // turn_pending, archived, branch_closed, a TurnGate refusal…
	}
	done, err := engine.RunTurn(ctx, turn, model) // streams deltas, then CompleteTurn
	if err != nil {
		return domain.Message{}, err
	}
	// Jobs the turn started (the summary feature in auto mode) are the caller's to run.
	for _, job := range done.Jobs {
		runJobInline(ctx, engine, model, job)
	}
	return done.Message, nil
}
```

### 3.2 現成的：`NewRunnerDispatcher`

httpapi 需要一個 `Dispatcher`（`DispatchTurn` + `DispatchJob`）。`tangent.NewRunnerDispatcher(engine, runner, opts...)` 在本行程用 goroutine
執行每一輪與每個 job，一定寫回結果（錯誤、panic、逾時都會讓這一輪失敗），也會派發 `CompletedTurn.Jobs`。

| 選項 | 預設 |
|---|---|
| `WithTurnTimeout(d)` | 10 分鐘 |
| `WithJobTimeout(d)` | 3 分鐘 |
| `WithMaxConcurrent(n)` | 不限（同時執行的上限，其他排隊） |
| `WithMaxQueue(n)` | 64（再多就回 `ErrDispatcherBusy`，httpapi 回 503） |
| `WithMaxTenantTurns(n)` | 16（每個租戶同時持有的回合） |

關機：`Shutdown(ctx)` 停止收件並等執行中的工作寫回；`ctx` 先到期就取消它們（它們會寫回失敗）。`Close()` = 立刻取消並等寫回。

### 3.3 自訂 Dispatcher（自己的佇列）

想用自己的佇列、worker 池或遠端執行器時，實作 `Dispatcher`，執行端自己跑協定。runner 請求用 `tangent.ChatRequest(prompt, provider, model)`
（或簡寫 `turn.Request()`、`job.Request()`）組：跟 `RunTurn` 一樣把 system 分成穩定段與變動段，`runner/anthropic` 才能把快取斷點放在穩定段之後。
CLI 型的代理改用 `Prompt.Text()`。

一輪的執行端：串流每一段給 `AppendDelta`，結束時 `CompleteTurn`：

<!-- snippet: examples/embedding/turns.go#manual-turn -->
```go
// RunManually is the runner side of the turn protocol without RunTurn: the
// host calls its own model client and reports every piece back.
func RunManually(ctx context.Context, engine *tangent.Engine, model tangent.Runner, turn tangent.Turn) (tangent.CompletedTurn, error) {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	req := turn.Request() // tangent.ChatRequest of the prompt; or Prompt.Text() for a CLI agent
	req.OnDelta = func(d domain.Delta) {
		// Buffers the piece for GET /stream and publishes message.delta. A turn
		// the operator cancelled answers turn_not_pending: stop the model.
		if err := engine.AppendDelta(runCtx, turn.ID, d); errors.Is(err, domain.ErrTurnNotPending) {
			cancel()
		}
	}
	result, runErr := model.Run(runCtx, req)
	outcome := tangent.TurnResult{Content: result.Content, Usage: &result.Usage, Model: result.Model}
	if runErr != nil {
		outcome = tangent.TurnResult{Error: failedRunText}
	}
	// The write-back must happen even when ctx is gone, or the turn stays pending
	// until Maintain fails it as stale.
	return engine.CompleteTurn(context.WithoutCancel(ctx), turn.ID, outcome)
}
```

一個有上限的行程內佇列，固定數量的 worker：

<!-- snippet: examples/embedding/queue.go#queue -->
```go
// QueueDispatcher is a host-owned work queue: DispatchTurn and DispatchJob
// only enqueue (they run inside the HTTP request, so they must not block),
// and a fixed set of workers runs the protocol's runner side.
type QueueDispatcher struct {
	engine *tangent.Engine
	model  tangent.Runner
	log    *slog.Logger

	mu     sync.Mutex
	closed bool
	work   chan func(context.Context)
	stop   context.CancelFunc
	ctx    context.Context
	wg     sync.WaitGroup
}

func NewQueueDispatcher(engine *tangent.Engine, model tangent.Runner, workers, depth int, log *slog.Logger) *QueueDispatcher {
	ctx, stop := context.WithCancel(context.Background())
	q := &QueueDispatcher{engine: engine, model: model, log: log, work: make(chan func(context.Context), depth), ctx: ctx, stop: stop}
	for range workers {
		q.wg.Add(1)
		go func() {
			defer q.wg.Done()
			for run := range q.work {
				run(q.ctx)
			}
		}()
	}
	return q
}

func (q *QueueDispatcher) DispatchTurn(_ context.Context, t tangent.Turn) error {
	return q.enqueue(func(ctx context.Context) { q.runTurn(ctx, t) })
}

func (q *QueueDispatcher) DispatchJob(_ context.Context, j tangent.Job) error {
	return q.enqueue(func(ctx context.Context) { q.runJob(ctx, j) })
}

func (q *QueueDispatcher) enqueue(run func(context.Context)) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return ErrQueueClosed
	}
	select {
	case q.work <- run:
		return nil
	default:
		return ErrQueueFull
	}
}

func (q *QueueDispatcher) runTurn(ctx context.Context, t tangent.Turn) {
	done, err := RunManually(ctx, q.engine, q.model, t) // AppendDelta + CompleteTurn
	switch {
	case errors.Is(err, domain.ErrTurnNotPending):
		return // cancelled (or failed as stale) meanwhile: nothing to write
	case err != nil:
		q.log.Error("turn not completed", "turn", t.ID, "error", err)
		return
	}
	// A completed turn may start jobs (an automatic summary); they are ours to run.
	for _, job := range done.Jobs {
		if err := q.DispatchJob(ctx, job); err != nil {
			_ = q.engine.FinishJob(context.WithoutCancel(ctx), job.ID, "", err)
		}
	}
}

func (q *QueueDispatcher) runJob(ctx context.Context, j tangent.Job) {
	// A job is one call without tools or streaming.
	result, runErr := q.model.Run(ctx, j.Request())
	// FinishJob hands the raw output to the feature that owns the job kind; a job
	// that was superseded or timed out meanwhile writes nothing (job_not_pending).
	if err := q.engine.FinishJob(context.WithoutCancel(ctx), j.ID, result.Content, runErr); err != nil && domain.CodeOf(err) == "" {
		q.log.Error("job result not recorded", "job", j.ID, "error", err)
	}
}

// Close stops taking work, cancels the runs and waits until every queued
// turn and job has written its outcome back (as a failure).
func (q *QueueDispatcher) Close() {
	q.mu.Lock()
	if !q.closed {
		q.closed = true
		close(q.work)
	}
	q.mu.Unlock()
	q.stop()
	q.wg.Wait()
}
```

自訂 Dispatcher 的規則：

1. **`DispatchTurn` / `DispatchJob` 不能阻塞**：httpapi 在請求裡呼叫它們。滿了就回錯；httpapi 會把那一輪（或 job）立刻標成失敗並回 `503 unavailable`。
2. **一定要寫回**：每一輪最後都要 `CompleteTurn`（成功或 `Error`），每個 job 都要 `FinishJob`，即使 `ctx` 已取消（用 `context.WithoutCancel`）。
   沒寫回的回合會停在 pending，直到 `Maintain` 依 `WithStaleTurnAge`（預設 15 分鐘）把它判為逾時。
3. **`CompletedTurn.Jobs` 是你的**：完成一輪後把它們派發出去，派不出去就 `FinishJob(id, "", err)` 讓它失敗。
4. **取消**：`CancelTurn` 只會直接停掉本行程 `RunTurn` 的執行；自己的 worker 是從 `AppendDelta` / `CompleteTurn` 回傳
   `turn_not_pending` 得知，要在那時停下模型。不串流的模型要自己問：`engine.TurnPending(ctx, scope, turnID)` 回 `false` 就停；
   別的行程的 worker 見 §3.4（`Observe` 收到取消會直接停掉該行程的 `RunTurn`）。
5. **`TurnResult.Error` 會存起來並發佈給使用者看**：放給人看的固定文字，不要放上游的原始錯誤。
6. **跨行程**：`AppendDelta` 的緩衝與 `Publisher` 屬於呼叫它的那個 `Engine`。worker 在另一個行程時照 §3.4 接線。

### 3.4 跨行程的 worker

worker 在另一個行程（有自己的 `Engine`、連同一個資料庫）時，**API 行程仍是唯一編 delta 序號的地方**：它的緩衝（`GET /stream`）、
`message.delta`、pending 訊息存的 `streamSeq` 都在同一個編號空間，客戶端的補抓規則不變。分工：

| | API 行程（客戶端連的） | worker 行程 |
|---|---|---|
| 開始 | httpapi 的 `turns.send` 在同一交易排入 turn id（`Config.TxOptions`），`DispatchTurn` 只喚醒 worker | 認領 id → `LoadTurn(ctx, scope, id)` 重建 `Turn`（含 prompt） |
| 串流 | 收到的 delta 交給 `AppendDelta(ctx, turnID, delta)`：行過濾、緩衝、`message.delta`、存 partial | `tangent.WithDeltaSink(sink)`：`AppendDelta` / `RunTurn` 的 delta 都交給 sink，本行程不緩衝、不發 `message.delta` |
| 完成 | 收到 worker 的事件：先 `Observe(ctx, ev)`、再交給自己的 Hub | `RunTurn`（或 `CompleteTurn`）照常寫資料庫、發事件 |
| 取消 | `CancelTurn` 寫資料庫並發 `message.updated`；這個事件送給 worker | 收到後 `Observe` 停掉本行程的 `RunTurn`；沒有事件通道就輪詢 `TurnPending` |

`Observe` 只更新本行程記憶體裡的狀態：不再是 pending 的回覆 → 把行過濾還壓著的尾巴當 delta 送出（跟單一行程的 `CompleteTurn` 一樣，
在那則 `message.updated` 之前）、停掉本行程正在跑的那一輪；`line.deleted` → 丟掉那些線的緩衝。它**不會**再發佈收到的事件。
`Data` 可以是原型別或它的 JSON（經過傳輸解碼成 `map` 也可以）。

排入佇列（API 行程；`QueueTurns` 就是 `httpapi.Config.TxOptions`）：

<!-- snippet: examples/embedding/remote.go#remote-queue -->
```go
// QueueTurns is httpapi.Config.TxOptions for a durable turn queue: a sent or
// retried message writes its turn id into the host's queue in the same
// transaction, so a crash right after the commit loses nothing. Only the id
// is queued; the worker rebuilds the turn with LoadTurn.
func QueueTurns(_ *http.Request, op string) []tangent.TxOption {
	if op != httpapi.OpTurnsSend && op != httpapi.OpTurnsRetry {
		return nil
	}
	return []tangent.TxOption{tangent.InTx(func(ctx context.Context, tx store.Tx, result any) error {
		begun, ok := result.(store.BegunTurn)
		if !ok {
			return fmt.Errorf("queue hook: unexpected result %T", result)
		}
		_, err := tx.Exec(ctx, `INSERT INTO host_turn_queue (turn_id, tenant) VALUES ($1, $2)`, begun.Pending.ID, begun.Line.TenantID)
		return err
	})}
}

// QueuedDispatcher is the API process's Dispatcher when turns run in workers:
// the turn is already queued (QueueTurns), so DispatchTurn only wakes a
// worker (a NOTIFY, say). Jobs run where Jobs says.
type QueuedDispatcher struct {
	Wake func()
	Jobs tangent.Dispatcher
}

func (d QueuedDispatcher) DispatchTurn(context.Context, tangent.Turn) error {
	d.Wake()
	return nil
}

func (d QueuedDispatcher) DispatchJob(ctx context.Context, j tangent.Job) error {
	return d.Jobs.DispatchJob(ctx, j)
}
```

兩個行程之間的通道（這裡的 `Send` 換成你的 HTTP / NATS / Postgres NOTIFY）：

<!-- snippet: examples/embedding/remote.go#remote-wire -->
```go
// DeltaSender is a worker's DeltaSink (tangent.WithDeltaSink): every delta
// goes to the API process over the host's channel (HTTP, NATS, Postgres
// NOTIFY…), Send here. The API process numbers it.
type DeltaSender struct {
	Send func(ctx context.Context, payload []byte) error
}

func (s DeltaSender) SendDelta(ctx context.Context, d tangent.RemoteDelta) error {
	payload, err := json.Marshal(d)
	if err != nil {
		return err
	}
	return s.Send(ctx, payload)
}

// ReceiveDelta is the API process's end: the delta joins its buffer (GET
// /stream) and goes out as message.delta, as if the turn ran there.
func ReceiveDelta(ctx context.Context, api *tangent.Engine, payload []byte) error {
	var d tangent.RemoteDelta
	if err := json.Unmarshal(payload, &d); err != nil {
		return err
	}
	return api.AppendDelta(ctx, d.TurnID, d.Delta)
}

// EventSender is a Publisher that forwards one process's own events to the
// other process.
type EventSender struct {
	Send func(ctx context.Context, payload []byte) error
	Log  *slog.Logger
}

func (s EventSender) Publish(ctx context.Context, ev tangent.Event) {
	payload, err := json.Marshal(ev)
	if err == nil {
		err = s.Send(ctx, payload)
	}
	if err != nil {
		s.Log.Warn("event not forwarded", "type", ev.Type, "error", err)
	}
}

// ReceiveEvent is the other end: the Engine catches up first (a turn that
// ended over there stops here, its last held text is streamed), then this
// process's own hub, if it has one, gets the event. It is never forwarded
// back.
func ReceiveEvent(ctx context.Context, engine *tangent.Engine, hub tangent.Publisher, payload []byte) error {
	var ev tangent.Event
	if err := json.Unmarshal(payload, &ev); err != nil {
		return err
	}
	engine.Observe(ctx, ev)
	if hub != nil {
		hub.Publish(ctx, ev)
	}
	return nil
}
```

worker：

<!-- snippet: examples/embedding/remote.go#remote-worker -->
```go
// Worker runs turns in another process: its own Engine over the same
// database, built WithDeltaSink(DeltaSender{…}) and publishing through an
// EventSender, claims queued turn ids, rebuilds each turn and runs it.
type Worker struct {
	Engine *tangent.Engine
	Model  tangent.Runner
	Pool   *pgxpool.Pool
}

// RunOne claims one queued turn and runs it; false when the queue is empty.
// (A production queue marks a row claimed and deletes it after the run; a
// turn lost in a crash is failed as stale by Maintain either way.)
func (w Worker) RunOne(ctx context.Context) (bool, error) {
	var tenant, turnID string
	err := w.Pool.QueryRow(ctx, `DELETE FROM host_turn_queue WHERE turn_id = (
		SELECT turn_id FROM host_turn_queue ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1
	) RETURNING tenant, turn_id::text`).Scan(&tenant, &turnID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	turn, err := w.Engine.LoadTurn(ctx, tangent.Scope{Tenant: tenant}, turnID)
	if errors.Is(err, domain.ErrTurnNotPending) {
		return true, nil // cancelled or failed meanwhile: nothing to run
	}
	if err != nil {
		return true, err
	}
	// Deltas go through the sink; a cancel in the API process reaches this
	// run through ReceiveEvent (or poll TurnPending without an event channel).
	done, err := w.Engine.RunTurn(ctx, turn, w.Model)
	if err != nil && !errors.Is(err, domain.ErrTurnNotPending) {
		return true, err
	}
	for _, job := range done.Jobs {
		runJobInline(ctx, w.Engine, w.Model, job)
	}
	return true, nil
}
```

接線（`examples/embedding/remote_test.go` 用兩個 `Engine` 共用一個資料庫實際跑過）：API 行程
`WithPublisher(Publishers(hub, EventSender{送給 worker 的 ReceiveEvent(worker, nil)}))`；worker
`WithPublisher(EventSender{送給 API 的 ReceiveEvent(api, hub)})`、`WithDeltaSink(DeltaSender{送給 API 的 ReceiveDelta(api)})`。

規則：

1. **每個行程只轉送自己的事件**（`Publisher` 收到的那些）；`ReceiveEvent` 收到的不要再轉出去，否則兩邊互相轉送。
2. **同一條線的 delta 送到同一個 API 行程。** 多個 API 行程各自編號；客戶端換到另一個行程時 `/stream` 回 `truncated`，照規則重新載入訊息即可。
3. **順序**：delta 與事件最好走同一條有序的通道。順序亂了也安全：turn 結束之後才到的 delta 會得到 `turn_not_pending` 而被丟掉。
4. **`LoadTurn` 看的是現在的資料**：期間別處改了筆記，新 prompt 帶較新的筆記但記錄的是開始時的版本，下一輪會再送一次（保守）。
   `PromptContributor` 會再被問一次。已結束、不存在或別的租戶的 turn 回 `turn_not_pending`；組不出 prompt 只回錯，不改那一輪。
5. **`AppendDelta` 只給內部通道用**：它只拿 turn id 當憑證、不檢查租戶，接收 delta 的端點不能讓客戶端碰到。
6. worker 完成時的 `CompletedTurn.Jobs` 跟以前一樣由它負責執行（或排回佇列）。

### 3.5 命令列 AI 工具：`runner/cli`

`cli.New(cli.Config{Backend: cli.Claude | cli.Codex | cli.Agy, Path, Model, MaxConcurrent, Timeout, Env})` 回傳一個 `Runner`，
每次 `Run` 啟動一個非互動的 CLI 程序（只用 `os/exec`），讓已用訂閱登入的 Claude Code、Codex 或 Antigravity CLI（`agy`）跑一輪對話。
參考伺服器的 provider 是 `claude-cli`、`codex-cli`、`agy-cli`（`.env.example` 的 `TANGENT_<NAME>_CLI_PATH`、`_MODEL`、`_MAX_CONCURRENT`），
可以和 API provider 混用，例如主對話 `TANGENT_PROVIDER=claude-cli`、`TANGENT_JOB_MODEL=anthropic:claude-haiku-4-5`。
G1 起參考伺服器新增兩個環境變數與對應能力：

- `TANGENT_CLI_AUTODETECT`（`1/true/on/yes` 或 `0/false/off/no`，未設定時跟著 `TANGENT_DEV`）：啟動時找得到的 CLI 自動註冊 runner 並帶入內建 preset 模型與別名（設了 `TANGENT_ALLOWED_MODELS` 仍是嚴格白名單）；找不到不擋啟動，`ModelGroup.Ready`／`Reason` 會標示尚未就緒。
- `TANGENT_FALLBACK_MODEL=provider:model`：回合遇到用量或速率上限（CLI `ErrUsageLimit` 或 HTTP 429）且**尚未串出任何 delta** 時，記 WARN 後用它重跑一次。
- **思考深度**：`RunRequest.ReasoningEffort`（`low`/`medium`/`high`/`xhigh`/`max`）與 `cli.EffortLevels(Backend)`：`claude` 傳 `--effort <level>`（`xhigh` 視為 `max`）、`codex` 傳 `-c model_reasoning_effort="<level>"`（`max` 視為 `xhigh`）、`agy` 忽略；不支援的模型不帶參數。

它怎麼保護主機：

- **prompt 走 stdin**，不放在命令列參數（`ps` 看得到、也有長度上限）。Claude Code 的 system prompt 寫在私有檔案用 `--system-prompt-file` 給；
  Codex、agy 沒有能從 stdin 分開收的 system prompt，就把 system 與對話組成一段文字（版面同 `Prompt.Text()`；agy 是 stdin 上的一則 NDJSON 訊息）。
- **只聊天**：各 CLI 用自己的旗標關掉工具（Claude Code `--tools "" --safe-mode --strict-mcp-config`、Codex 唯讀沙箱加關閉 shell 與網搜）。
  agy 沒有關掉工具的旗標：靠 print 模式拒絕所有需要核准的動作（沒有人能核准）、`--mode=plan`（不會是 accept-edits / auto）、`--sandbox`、空的工作目錄。
  串流裡仍出現工具（Claude 的 init 列出工具、Codex 的指令 / 檔案 / MCP / 網搜項目、agy 的 `tool` 步驟）就立刻殺掉程序、回 `cli.ErrToolUse`。
- **工作目錄**是每次新建的空暫存目錄，用完刪掉。
- **環境變數白名單**：只給 `PATH`、`HOME`、語系、代理與憑證設定、該 CLI 自己的設定目錄變數（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、agy 的 `AGY_ADC_AUTH`、`GOOGLE_CLOUD_PROJECT`）；
  `Config.Env` 可多給幾個名字，但 `TANGENT_*`、`*DATABASE_URL*`、`*API_KEY*` 一律拒絕。API key 不給也是為了讓 CLI 用訂閱、不會改成按 token 計費。
- **取消與逾時**：CLI 在自己的程序群組裡跑，`ctx` 結束（取消、逾時、這一輪被取消）就殺掉整個群組，不留子程序。
- **並行上限**：`MaxConcurrent`（預設 2），多的排隊等，排隊時也看 `ctx`。

錯誤：沒裝（`cli.ErrNotInstalled`）、沒登入（`ErrNotLoggedIn`）、訂閱額度用完（`ErrUsageLimit`，不自動重試）、其他失敗（`ErrFailed`）各自是一個
`RunnerError`，公開文字不含 CLI 的輸出；log 裡只留 stderr 最後幾行、截短並遮掉像金鑰的字串。

何時適合、限制：

- 適合個人在自己的機器上用訂閱跑主對話。**訂閱只限個人使用**：不要把用 CLI provider 的伺服器開給其他人用。
- **每輪都要啟動一個程序**（數秒），沒有 API 的 prompt 快取可以接續；每一輪都把整段 prompt 重送一次。
- **用量不精確**：只記 CLI 回報的 token 數，不記費用（訂閱不按 token 計費）；`MaxTokens` 沒有對應的旗標。
- **agy 會留下對話**：每次呼叫都是 agy 自己歷史裡（`~/.gemini/antigravity-cli`）的一則新對話，沒有關掉的旗標；不會建新的 project（不用 `--new-project`）。
- **背景工作（摘要、卡片草稿、各功能的 job）建議用 API 模型**（`TANGENT_JOB_MODEL`），不要讓它們佔用 CLI 的並行名額與訂閱額度。
- 各 CLI 的旗標與串流格式依它們的 `--help` 與官方文件；版本更新可能改格式（各旗標的出處與驗證狀態見 `docs/devlog/B12-cli-runner.md`）。
  真的跑一次：`TANGENT_CLI_SMOKE=claude go test ./runner/cli -run TestRealCLISmoke -v`（會用掉一次訂閱額度）。

## 4. 宿主掛勾

擴充的方式只有這四個掛勾加上 `host_meta`；功能模組是封閉集合，不開放第三方模組（DESIGN §11）。

### 4.1 `PromptContributor`：在 prompt 裡加自己的區塊

每一輪（以及 `PreviewTurn`）組 prompt 時呼叫，在回合存好、commit **之後**；回錯會讓這一輪失敗（存成「prompt 無法組成」），
所以沒有內容時回空就好。**它不是拒絕回合的地方**：回合已經存好了，回錯只會留下一則失敗的回覆；要在開始前乾淨地拒絕（不寫任何東西），用 [`TurnGate`](#42-turngate開始前的檢查)。區塊預設排在「宿主區塊」的位置（規則 → 背景包 → 紀要 → **宿主區塊** → 摘要 → 卡片通知 → 歷史），屬於穩定段，
內容要穩定才不會打破 prompt 快取。`Key` 用自己的命名空間（內建的 key 保留，撞到會被改名）。

**每一輪都會變的宿主資料放尾段**（B7.1）：`PromptSection.Trailing: true` 的區塊改排在摘要之後的尾段（和卡片通知、其他支線的結論、召回的記憶、名詞表一起，保持回傳的順序），
不在 `Prompt.ChatBlocks()` 的穩定段裡，所以它變了也不會讓前面的快取失效。判斷方式：內容只在使用者改設定時才變（工具清單、角色說明）→ 預設的穩定段；
每一輪或每幾輪就變（計畫的進度、blackboard、即時狀態、時間）→ `Trailing`。放在穩定段的區塊一變，它之後的所有內容（摘要、尾段、歷史）都用不到快取。
兩種都算在預算的 `host` 份額、都出現在 `PreviewTurn` 的 `blocks`（尾段的排在 `summary` 之後），`LoadTurn` 重組時也一樣（`Contribute` 會再被呼叫一次，回傳要跟 `BeginTurn` 時相同才會得到相同的 prompt）。
`ResumeText`（續接的 provider session）照舊不重送宿主區塊。沒有設 `Trailing` 的宿主行為完全不變。

```go
return []domain.PromptSection{
	{Key: "host.tools", Title: "Tools", Body: tools},                                          // rarely changes: cached prefix
	{Key: "host.blackboard", Title: "Blackboard", Body: domain.QuoteUntrusted(board), Trailing: true}, // every turn: trailing
}, nil
```

`Body` 是**可信的** prompt 文字；放使用者輸入或外部資料時，用 `domain.QuoteUntrusted`（多行，去掉協定標記、每行加 `> `）
或 `domain.FlattenUntrusted`（單行）包起來：

<!-- snippet: examples/embedding/hooks.go#contributor -->
```go
// PlanContributor adds the host's "plan" (kept in the main line's host_meta)
// to every turn prompt of the conversation.
type PlanContributor struct {
	Plans func(ctx context.Context, tenant, rootLineID string) (string, error)
}

func (p PlanContributor) Contribute(ctx context.Context, scope tangent.Scope, line domain.LineView) ([]domain.PromptSection, error) {
	root := line.ID
	if line.ConversationBranch != nil {
		root = line.ConversationBranch.RootLineID
	}
	plan, err := p.Plans(ctx, scope.Tenant, root)
	if err != nil || plan == "" {
		// The prompt is built after the turn was stored: an error fails the turn.
		return nil, err
	}
	// The plan was typed by a user: quote it so it reads as data, not instructions.
	return []domain.PromptSection{{Key: "host.plan", Title: "Plan", Body: domain.QuoteUntrusted(plan)}}, nil
}
```

### 4.2 `TurnGate`：開始前的檢查

`BeginTurn` 與 `RetryTurn` 在交易**之前**呼叫（建議性檢查，例如「daemon 在線嗎」「額度夠嗎」），回錯就不開始。
回 `*domain.Error` 時錯誤碼原樣傳給客戶端；httpapi 不認得的碼用 `Config.StatusFor` 對應 HTTP 狀態（沒對應就是 409）：

<!-- snippet: examples/embedding/hooks.go#gate -->
```go
// QuotaGate refuses a turn when the tenant used up its monthly tokens. It
// runs before the turn's transaction: an advisory check, not a lock.
type QuotaGate struct {
	Remaining func(ctx context.Context, tenant string) (int64, error)
}

func (g QuotaGate) AllowTurn(ctx context.Context, scope tangent.Scope, _ domain.LineView) error {
	left, err := g.Remaining(ctx, scope.Tenant)
	if err != nil {
		return err // not a domain error: httpapi answers 500 and logs it
	}
	if left <= 0 {
		return domain.NewError(CodeQuotaExceeded, "this month's token quota is used up", map[string]any{"remaining": 0})
	}
	return nil
}

// QuotaStatus maps the host's codes for httpapi.Config.StatusFor; codes it
// does not know stay 409.
func QuotaStatus(code string) (int, bool) {
	if code == CodeQuotaExceeded {
		return http.StatusPaymentRequired, true
	}
	return 0, false
}
```

### 4.3 `Publisher`：接收事件

每個寫入 commit **之後**，在寫入者的 goroutine 上同步呼叫 `Publish`（依序），所以它不能阻塞、不能回頭呼叫 Engine；panic 會被接住並記 log。
事件名稱與 payload 見 `docs/API.md` 的「事件」。`httpapi.Hub` 本身就是一個 Publisher；要同時送到別處，用 `tangent.Publishers(hub, relay)` 扇出（依序送給每一個；其中一個 panic 不影響其他的，之後才把 panic 往外丟，由 Engine 照常記 log）。轉送到自己通道的 Publisher 例如：

<!-- snippet: examples/embedding/hooks.go#publisher -->
```go
// Relay forwards events to the host's own realtime channel under the host's
// event names. Publish runs on the writer's goroutine after the commit, so
// it hands the event over and returns; it never blocks or calls back into
// the engine.
type Relay struct {
	Send func(tenant, name string, payload []byte) // must not block
}

func (r Relay) Publish(_ context.Context, ev tangent.Event) {
	payload, err := json.Marshal(ev.Data)
	if err != nil {
		return
	}
	r.Send(ev.Tenant, "conversation:"+ev.Type, payload)
}
```

### 4.4 `InTx`：在同一個交易裡寫自己的資料

大多數寫入都接受 `tangent.InTx(hook)`：hook 在函式庫自己的寫入之後、commit 之前執行（`DeleteTree` 與 `DeleteBranch` 例外：在刪除之前，資料還讀得到），
回錯就整筆 rollback（錯誤包成 `tx hook: …`）。

- 經 httpapi 的寫入也能帶：`httpapi.Config.TxOptions(r, op)` 回傳的選項會傳給那個路由的 Engine 寫入；`op` 是穩定的操作名稱
  （`httpapi.OpTurnsSend` 等，`docs/API.md`「宿主的操作名稱」列出每個 op 對應的方法，`result` 型別照下表）。例子見 §3.4 的 `QueueTurns`。
- `tx` 只有 `Exec` / `Query` / `QueryRow`，不能 commit 或 rollback。
- `result` 是這次寫入在 store 層的結果，看得到新產生的 id（下表；`TestInTx_TheGuideListsTheResultEveryWritePasses` 會實際跑每個方法核對）。用型別斷言並對意外的型別回錯。
| 方法 | hook 的 `result` |
|---|---|
| `CreateLine` | `domain.LineView` |
| `UpdateLine` | `domain.LineView`（B25：釘選也走這裡，`PinnedAt`） |
| `MarkRead` | `domain.LineView` |
| `ArchiveTree` | `[]domain.LineView`（主線在前） |
| `RenameFolder` | `store.RenamedFolder`（B18：改名或解散資料夾；`LineIDs` 是改到的主線，依 id 排序；`from` 與 `to` 相同時 hook 照樣執行、`LineIDs` 是空切片） |
| `ImportLine` | `store.ImportedLine`（B25：帶 `BatchID` 時 `Line.ImportBatchID` 是批次；B18：匯入的主線、支線（照輸入的順序）、主線訊息數與來源標籤 `Source`，資料表不存 `Source`，要留就在這裡寫）；B19 多了寫入的章節切點 `Cuts` 與已帶回支線的收尾 `Leaves`） |
| `DeleteTree` | `store.DeletedTree`（刪除**之前**） |
| `DeleteImportBatch` | 每棵刪掉的樹各一次 `store.DeletedTree`（各自的交易、刪除**之前**，同 `DeleteTree`），批次列被刪時再一次 `store.RemovedImportBatch`（B25：`BatchID`、`Removed`；有線留下時批次列不刪、這一次不跑） |
| `BeginTurn` | `store.BegunTurn` |
| `RetryTurn` | `store.BegunTurn` |
| `CompleteTurn` | `store.CompletedTurn` |
| `CancelTurn` | `store.CancelledTurn` |
| `AppendSystemMessage` | `store.AppendedSystemMessage`（`SkipRepeat` 略過重複時不寫入、hook 不執行） |
| `CreateBranch` | `store.CreatedBranch` |
| `RenameBranch` | `domain.BranchView` |
| `KeepBranch` | `store.KeptBranch`（B23：保留或取消保留順口問；`Branch` 是現在的樣子，`Changed` 是這次有沒有改到——重複設定時 hook 照樣執行、`Changed` 是 false） |
| `ContinueAside` | `store.ContinuedAside`（B23：順口問換成一般支線；新支線的 `Line`、`Branch`，被取代的 `ReplacedLineID`，搬過去的 `MovedMessageIDs`、改掛的 `Reparented`，`Gone` 是跟著順口問那條線刪掉的宿主資料（`LineHostMeta`、沒搬走的訊息的 `Messages`、`PendingJobIDs`）與失效的建議、被刪的連結、受影響的群組；這時那條線已經刪除） |
| `DeleteBranch` | `store.DeletedBranch`（B23，刪除**之前**：`LineID`、`ParentLineID`、還在的 `RootLineID`，`LineIDs`（第一個是被刪的支線）、每條線與每則訊息非空的 `host_meta`、`PendingJobIDs`、失效的建議、被刪的連結、受影響的群組） |
| `MoveToBranch` | `store.MovedBranch` |
| `ExtractToBranch` | `store.ExtractedBranch`（B18：任意一段抽成支線；`Marker` 是標記或帶卡時的結論卡，另有改變的折疊、移到標記上的章節切點數與帶卡寫的收尾） |
| `AttachLine` | `store.AttachedLine`（B20：另一條主線連同整棵樹併入成支線；`TargetLine`、`Branch`、`BranchLine`、帶卡時的 `CardMessage`、跟著過來的子支線 `Reparented`，以及搬過來的列數 `Moved`、群組、失效的建議、被移除的目標） |
| `MergeBranch` | `store.MergedBranch` |
| `UpdateBranchCard` | `store.UpdatedCard`（B17：編輯已帶回支線的結論卡） |
| `DiscardBranch` | `domain.BranchView` |
| `DiscardBranchWith` | `domain.BranchView` |
| `PromoteBranch` | `store.PromotedBranch` |
| `StartDraft` | `store.DraftClaim` |
| `StartSummary` | `store.Job` |
| `ApplyNoteChanges` | `store.NotesWrite` |
| `SupersedeNote` | `store.NotesWrite` |
| `UpdateNote` | `store.NoteUpdate` |
| `AddMilestone` | `store.ChapterChange` |
| `DeleteMilestone` | `string`（被刪的 milestone id） |
| `PutLeaf` | `domain.Leaf` |
| `DeleteLeaf` | `domain.Leaf`（被刪的收尾） |
| `StartLeafDraft` | `store.Job` |
| `CreateSeed` | `domain.Seed` |
| `DropSeed` | `domain.Seed` |
| `NoteSeed` | `store.NotedSeed` |
| `ExpandSeed` | `store.ExpandedSeed` |
| `CreateSeeds` | `store.CreatedSeeds` |
| `AcceptSuggestion` | 依建議的動作：沒有動作的種類 `domain.Suggestion`；樹平衡 promote `store.PromotedBranch`、spinoff `store.SpunOff`；目標 `domain.Goal`；偏題 `store.CreatedBranch`；關聯 `store.RelationChange`；群組 `store.GroupWrite`（group）或 `store.CombinedBranches`（combine）；折疊 `store.FoldWrite`；記憶 `domain.Memory`（新增）或 `store.SupersededMemories`（更新、合併） |
| `DismissSuggestion` | `domain.Suggestion` |
| `DismissAllSuggestions` | `store.SuggestionList`（B17：一次忽略整棵樹的開放建議；沒有時 `Suggestions` 是空切片） |
| `Spinoff` | `store.SpunOff` |
| `PutGoal` | `domain.Goal` |
| `DeleteGoal` | `domain.Goal`（被刪的目標） |
| `ProposeGoal` | `store.Job` |
| `CreateRelation` | `store.RelationChange` |
| `DeleteRelation` | `store.RelationChange`（被刪的關聯） |
| `PinMessage` | `store.PinnedMessage` |
| `UpdateRelation` | `store.RelationChange` |
| `EditRelation` | `store.RelationChange` |
| `CreateGroup` | `store.GroupWrite` |
| `RenameGroup` | `domain.Group` |
| `DissolveGroup` | `domain.Group` |
| `SummarizeGroup` | `store.GroupSummaryClaim` |
| `CombineBranches` | `store.CombinedBranches` |
| `TagMessage` | `store.TaggedMessage` |
| `SetMessageTag` | `store.TaggedMessage` |
| `UntagMessage` | `store.TaggedMessage` |
| `CreateFold` | `store.FoldWrite` |
| `UpdateFold` | `store.FoldWrite` |
| `RemoveFold` | `store.FoldWrite`（被收回的折疊） |
| `StartDiverge` | `store.Job` |
| `DivergeModels` | `store.DivergedBranches`（`Job` 是零值） |
| `Converge` | `store.ComparisonWrite` |
| `DecideComparison` | `store.DecidedComparison` |
| `CreateMemory` | `domain.Memory` |
| `UpdateMemory` | `domain.Memory` |
| `SupersedeMemory` | `store.SupersededMemories` |
| `CreateMemo` | `domain.Memo` |
| `UpdateMemo` | `domain.Memo` |
| `DeleteMemo` | `domain.Memo`（刪掉前的樣子） |
| `CreateTerm` | `store.TermChange`（B24：`Term`、`Change`（`created`，`replace` 覆寫時 `updated`）、`Kept`（這次把順口問設成保留時是它的 `BranchView`，否則 nil）） |
| `UpdateTerm` | `store.TermChange` |
| `DeleteTerm` | `store.TermChange`（`Term` 是刪掉前的樣子） |

- 交易遇到序列化衝突會整筆重試，hook 也會再跑一次（前一次的寫入已 rollback）。
- 批次清理（`FailStaleTurns`、`FailStaleJobs`、`PurgeExpiredAsides`、`Maintain`）不接受 hook。
- httpapi 的路由不帶宿主的 hook；需要 hook（或 `host_meta`）的動作，寫自己的路由直接呼叫 Engine，再交給 Dispatcher：

<!-- snippet: examples/embedding/hooks.go#intx -->
```go
// Attachment is what the host keeps in a message's host_meta.
type Attachment struct {
	FileID string `json:"fileId"`
}

// SendWithAttachments starts a turn whose user message carries host data,
// and records an audit row in the same transaction: if the audit insert
// fails, no turn exists. The host then hands the turn to its dispatcher.
func SendWithAttachments(ctx context.Context, engine *tangent.Engine, d tangent.Dispatcher, scope tangent.Scope, lineID, text string, files []Attachment) (tangent.Turn, error) {
	meta, err := json.Marshal(map[string]any{"attachments": files})
	if err != nil {
		return tangent.Turn{}, err
	}
	audit := tangent.InTx(func(ctx context.Context, tx store.Tx, result any) error {
		begun, ok := result.(store.BegunTurn) // the ids this write created
		if !ok {
			return fmt.Errorf("audit hook: unexpected result %T", result)
		}
		_, err := tx.Exec(ctx, `INSERT INTO host_turn_audit (tenant, turn_id, actor) VALUES ($1, $2, $3)`,
			scope.Tenant, begun.Pending.ID, scope.Actor)
		return err
	})
	turn, err := engine.BeginTurn(ctx, scope, lineID, tangent.TurnInput{Content: text, HostMeta: meta}, audit)
	if err != nil {
		return tangent.Turn{}, err
	}
	if err := d.DispatchTurn(ctx, turn); err != nil {
		// Nobody will run it: fail it now instead of leaving it pending.
		_, _ = engine.CompleteTurn(context.WithoutCancel(ctx), turn.ID, tangent.TurnResult{Error: "the turn could not be started"})
		return tangent.Turn{}, fmt.Errorf("dispatch turn: %w", err)
	}
	return turn, nil
}

// DeleteWithFiles deletes a conversation and, in the same transaction,
// queues the host's files for removal. The hook runs before the rows go, and
// the result already lists the host data of every deleted line and message.
func DeleteWithFiles(ctx context.Context, engine *tangent.Engine, scope tangent.Scope, rootLineID string) error {
	cleanup := tangent.InTx(func(ctx context.Context, tx store.Tx, result any) error {
		deleted, ok := result.(store.DeletedTree)
		if !ok {
			return fmt.Errorf("cleanup hook: unexpected result %T", result)
		}
		for _, m := range deleted.Messages {
			var meta struct{ Attachments []Attachment }
			if json.Unmarshal(m.HostMeta, &meta) != nil {
				continue
			}
			for _, f := range meta.Attachments {
				if _, err := tx.Exec(ctx, `INSERT INTO host_file_gc (tenant, file_id) VALUES ($1, $2)`, scope.Tenant, f.FileID); err != nil {
					return err
				}
			}
		}
		return nil
	})
	_, err := engine.DeleteTree(ctx, scope, rootLineID, cleanup)
	return err
}
```

### 4.5 `host_meta`

`LineInput.HostMeta`、`LinePatch.HostMeta`（整個取代）、`TurnInput.HostMeta`、`BranchInput.HostMeta`、`MoveInput.HostMeta` 是宿主自己的 JSON，函式庫原樣保存（`tangent_line.host_meta`、
`tangent_message.host_meta`），在 `LineView.hostMeta` / `Message.hostMeta` 讀回來。客戶端不能透過 httpapi 寫（`400 invalid_input`）；
經 httpapi 建立的線、訊息、支線由宿主的 `httpapi.Config.HostMeta(r, op)` 給（`lines.create`、`turns.send`、`branches.create`、
`branches.move` 會問；`lines.update` 也會問，回的物件整個取代那條線的 `hostMeta`，nil 表示不變；回 `*domain.Error` 就用它的碼拒絕那次寫入）。callback 可以再讀一次 `r.Body`，客戶端放在其他欄位的資料
（例如 `"attachments": [...]`，API 會忽略）就從那裡取。`HostMeta` 與 `TxOptions` 都讀也沒關係：每次呼叫 callback 之前本文都會重新放回完整的一份。
附件、引用、外部系統的 id 都放這裡；`DeleteTree` 的結果（與 hook 的 `result`）會列出整棵樹所有非空的 `host_meta`，方便清理。
`Turn.Request()` 會在 `Turn.UserMessage.HostMeta` 非空（不是 `{}`）時原樣複製進 `RunRequest.HostMeta`（函式庫不讀內容，參考伺服器藉此傳遞 `reasoningEffort`，跨行程與重試皆保留同一份設定；`Job.Request()` 不帶 `HostMeta`）。另外 `WithModelCatalog` 傳入的 `ModelGroup` 支援選填 `Ready`、`Reason`、`Details`（全部 `omitempty`），`GET /capabilities` 直接照該目錄輸出。
`SystemNotice.HostMeta`（§4.6）存成系統訊息的 `hostMeta`。
B18 的寫入不問 `HostMeta`：`lines.import`（匯入的主線、支線與訊息的 `hostMeta` 都是 `{}`）、`branches.extract`（新支線 `{}`；`ExtractInput.HostMeta` 給嵌入者自己傳）、
`lines.rename_folder`；要寫自己的資料用 `InTx`（`store.ImportedLine` 帶著每個新 id 與來源標籤 `Source`）。

**B18 的組織與匯入（嵌入者要知道的）**：`LineView` 多了 `folder` / `tags`（主線才有；支線永遠 `""` / `[]`），`LineInput`、`LinePatch`、`LineQuery`
多了對應欄位（`LineQuery.Folder` 用 `domain.FolderUnfiled` 篩未分類）；`Engine.RenameFolder`、`Engine.ImportLine`、`Engine.ExtractToBranch`、
`Engine.Decompose`，B18.1 再加唯讀的 `Engine.TenantOrganization`（`GET /lines/organization`：全租戶資料夾與標籤的篇數）。B19 的 `ImportLine` 可以保留來源時間（`createdAt`）、一次寫入章節切點（milestone）與已帶回、主線留結論卡的支線；直接呼叫 `domain.PlanImport` 的嵌入者要多傳一個 `now time.Time`。`ImportLine` 只寫資料：不跑任何功能掛勾或背景工作（摘要、建議、收尾草稿、記憶都不會因為匯入而開始），匯入的訊息沒有 `usage` / `model`；
`ExtractToBranch` 跑建立支線的功能掛勾（同 `MoveToBranch`，`result` 是 `store.ExtractedBranch`），帶卡時不跑結束支線的掛勾（只有 `leaf` 開著時直接寫結論收尾），所以也不會開始背景工作。
B20 的 `Engine.AttachLine`（`POST /lines/{id}/attach`，op `lines.attach`）是 detach 的反向：另一條主線連同整棵樹掛成支線，主線的 id 變成支線的 id、訊息不動；
宿主在主線上記的東西（`hostMeta`）跟著留在那條線上，要知道它不再是主線就看 `InTx` 的 `store.AttachedLine`（`OldRootLineID` 是它自己的 id）或事件裡的 `conversationBranch`。不跑任何功能掛勾、不開始背景工作。
B23 的三個寫入（migration `017_branch_keep`：`tangent_branch.kept_at`，可為 NULL、沒有預設值，不重寫資料列，對前一版程式相容）：
`Engine.KeepBranch`（`PUT /branch/keep`，op `branches.keep`）保留順口問，維護工作的清除會跳過它；`Engine.ContinueAside`（`POST /branch/continue`，op `branches.continue`）
把答完的順口問換成一條新的一般支線——**線的 id 會換**（訊息的 id 與 `seq` 不變），宿主記在順口問那條線 `host_meta` 的東西在 `Gone.LineHostMeta`，新線的 `host_meta` 由 `Config.HostMeta(r, "branches.continue")` 給；
`Engine.DeleteBranch`（`DELETE /branch`，op `branches.delete`）刪除一條已結束的支線與它底下的線，hook 在刪除之前執行（同 `DeleteTree`），可以先讀出要清的 `host_meta`。
`ContinueAside` 跑建立支線的功能掛勾（同 `CreateBranch`），不跑結束支線的掛勾；`DeleteBranch` 與 `KeepBranch` 不跑功能掛勾。三者都不呼叫模型、不開始背景工作。
`POST /lines/import` 的本文上限是 `httpapi.Config.MaxImportBodyBytes`（預設 16 MiB）。核心 migration `016_line_organization` 只新增兩個有常數預設值的欄位
（不重寫資料列）與兩個索引，並讓 `tangent_branch.origin` 多接受 `import`；對前一版程式相容。

**`hostMeta` 不是私密的**：`GET /lines`、`GET /lines/{id}/messages` 與事件都把它原樣交給這個租戶的每個讀者（包括 `CanWrite` 為 false 的唯讀成員）。
只該給部分讀者看的資料（指令、路徑、token）放在宿主自己的表，`hostMeta` 只放 id 或可以公開的標籤。

### 4.6 系統訊息：宿主自己的紀錄

不是對話的訊息（runner 回報的狀態、同步紀錄、shell audit、審核結果）寫成**宿主系統訊息**：`role=system`、`kind=chat`。
函式庫自己只寫 `kind` 為 `branch_card` / `branch_marker` 的系統訊息，所以 `system` + `chat` 一定是宿主的。**不要直接改寫 `tangent_message`**
（例如刪掉回覆再重新插入讓它排到通知後面）：seq 一變，客戶端的游標、摘要與草稿的範圍、折疊與群組的範圍都會錯（DESIGN §5）。兩條正規的路：

- **跟著回覆**：`TurnResult.Notices []tangent.SystemNotice`。`CompleteTurn` 在**同一個交易**、依序寫在回覆之後（seq 比回覆大；失敗的回覆也寫）；
  事件在 commit 後依序是回覆的 `message.updated`、每則通知的 `message.created`、送達卡片的 `message.updated`、`line.updated`。
  `CompletedTurn.Notices`（與 hook 的 `store.CompletedTurn.Notices`）是寫進去的訊息。空白的通知略過；超過 16 則、太長或 `HostMeta` 不是 JSON 物件時整個
  `CompleteTurn` 回 `invalid_input` / `too_long`，**那一輪仍是 pending**，修正後再呼叫一次。
- **單獨寫**：`engine.AppendSystemMessage(ctx, scope, lineID, tangent.SystemNotice{…}, opts...)`。只鎖那條線（跟 `BeginTurn` 一樣），
  租戶不對、線不存在或整棵樹剛被刪 → `line_not_found`；封存的線 → `archived`；已結束的支線（或在已結束的支線底下） → `branch_closed`；
  清理後是空的 → `invalid_input`。發 `message.created` 與 `line.updated`（最後活動時間會更新；未讀數不變）。

兩者的內容都先經過 `domain.CleanSystemText`（換行統一成 `\n`、移除雙向控制字元與緊鄰 ASCII 的零寬字元、其他控制字元換成空白、移除所有協定標記（含 `WithExtraMarkers` 的）、去掉前後空白；
code fence 保留，因為它是給人看的），上限 `Limits.Text.MessageMaxRunes`（預設 32k 字）。`SkipRepeat: true`：這條線最近 30 則訊息裡最新的一則宿主系統訊息內容相同就不寫
（`AppendSystemMessage` 回 `Written: false`、不發事件、hook 不執行；同一批通知裡也逐則比較）。

**對顯示與 prompt 的影響**

- 排序永遠依 seq。回合進行中呼叫 `AppendSystemMessage`，通知排在 pending 回覆**之後**；回覆完成時 seq 不變，所以畫面上是「回覆、通知」。
  前端把 `role=system` 顯示成置中的小字。
- 宿主系統訊息**會進之後的 prompt 歷史**，以 `system: <內容>` 的 system 項目出現；摘要、折疊、魚眼也把它當一般訊息算
  （魚眼的「幾輪前」會多算它）。正在進行的那一輪不會看到（它的 prompt 已經組好）；`LoadTurn` 重組時會看到期間寫入的通知（排在歷史最後），
  跟 §3.4 記的「期間資料變了」同一類。
- 它不算一輪：失敗回覆後面跟著通知仍然可以 `RetryTurn`；不會讓支線的 `parentTipMessageId` 前進（merge 不會因此回 `parent_moved`）；
  不能當支線的 anchor；`search` 不搜它。move 的範圍可以包含它（第一則仍必須是使用者訊息）。
- 被取消的回合：`CompleteTurn` 回 `turn_not_pending`、通知沒有寫入；要保留就改用 `AppendSystemMessage`（下例）。

<!-- snippet: examples/embedding/system.go#system-notices -->
```go
// FinishRemoteTurn records what a remote runner (a daemon) reported for a
// turn: the reply, and the status lines it produced along the way as host
// system messages right after the reply, in the same transaction. A status
// the daemon reports on every turn is written once (SkipRepeat). When the
// turn ended meanwhile (the operator cancelled it), the reply is gone but
// the statuses are still recorded on the line.
func FinishRemoteTurn(ctx context.Context, engine *tangent.Engine, scope tangent.Scope, lineID, turnID, content string, statuses []string) error {
	notices := make([]tangent.SystemNotice, 0, len(statuses))
	for _, status := range statuses {
		notices = append(notices, tangent.SystemNotice{
			Content: status, HostMeta: json.RawMessage(`{"source":"daemon"}`), SkipRepeat: true,
		})
	}
	_, err := engine.CompleteTurn(ctx, turnID, tangent.TurnResult{Content: content, Notices: notices})
	if !errors.Is(err, domain.ErrTurnNotPending) {
		return err
	}
	for _, notice := range notices {
		_, err := engine.AppendSystemMessage(ctx, scope, lineID, notice)
		// A status that cleans to nothing is skipped, as CompleteTurn skips it.
		if err != nil && domain.CodeOf(err) != domain.CodeInvalidInput {
			return err
		}
	}
	return nil
}
```

## 5. 認證、租戶與即時通道

函式庫**不做認證**、不做帳號與角色、不做速率限制。宿主在 `httpapi.Config` 給兩個函式：

- `Scope(r) (tangent.Scope, error)`：這個請求是誰。`Tenant`（必填）是隔離的單位，所有讀寫都檢查它，別的租戶的資料一律 404；
  `Actor` 寫進 `created_by`。回 `*domain.Error` 時照它的碼回答，其他錯誤一律 `401 unauthorized`。
- `CanWrite(r) bool`：nil = 都可寫；回 false 時寫入的路由回 `403 forbidden`，`/capabilities` 的 `permissions.canWrite` 也會是 false。

<!-- snippet: examples/embedding/auth.go#auth -->
```go
// UserScope maps the host's signed-in user to a tangent.Scope: the workspace
// is the tenant (every read and write is checked against it), the user is
// the actor (written into created_by). Any non-domain error is a 401.
func UserScope(r *http.Request) (tangent.Scope, error) {
	u, ok := r.Context().Value(userKey{}).(User)
	if !ok || u.WorkspaceID == "" {
		return tangent.Scope{}, errSignedOut
	}
	return tangent.Scope{Tenant: u.WorkspaceID, Actor: u.ID}, nil
}

// UserCanWrite lets read-only members read everything (and preview) but not
// change anything: writes answer 403 forbidden and /capabilities says so.
func UserCanWrite(r *http.Request) bool {
	u, _ := r.Context().Value(userKey{}).(User)
	return !u.ReadOnly
}

// MountForUsers mounts the API behind the host's authentication. hub is
// nil when the host delivers events over its own channel (a Publisher).
func MountForUsers(mux *http.ServeMux, auth func(http.Handler) http.Handler, engine *tangent.Engine, d tangent.Dispatcher, hub *httpapi.Hub, log *slog.Logger) error {
	api, err := httpapi.New(httpapi.Config{
		Engine: engine, Dispatcher: d, Hub: hub, Logger: log,
		Scope: UserScope, CanWrite: UserCanWrite,
		StatusFor:    QuotaStatus, // the TurnGate's own codes
		MaxBodyBytes: 256 << 10,
	})
	if err != nil {
		return err
	}
	mux.Handle("/chat/api/", auth(http.StripPrefix("/chat/api", api)))
	return nil
}
```

**依讀者過濾串流**：`httpapi.Config.DeltaFilter(r, lineID, delta) (delta, keep)` 對 `GET /lines/{id}/stream` 回的每一則 delta、
`GET /events` 送的每一則 `message.delta` 各問一次（帶讀者自己的請求）：回 false 就不給這個讀者，也可以改寫 `kind` / `text`；`turnId` 與 `seq` 一律保持原值，
游標照常前進（被濾掉的 delta 不會讓補抓變成 `truncated`）。`/events` 在每個訂閱者自己的 goroutine 上判斷，其他事件仍然只編碼一次；
nil 時行為不變。它要快、可以同時被呼叫。

<!-- snippet: examples/embedding/system.go#delta-filter -->
```go
// OperatorDeltas is httpapi.Config.DeltaFilter: tool deltas (a runner's
// tool input: commands, paths) reach only members who may write; read-only
// members still see the reply's text and reasoning. It runs for every delta
// of GET /stream and every message.delta of GET /events, so it only looks
// at the request.
func OperatorDeltas(r *http.Request, _ string, d domain.Delta) (domain.Delta, bool) {
	return d, d.Kind != domain.DeltaTool || UserCanWrite(r)
}
```

delta 還會從這些地方流出去，掛勾**管不到**：

| 去處 | 內容 | 宿主要做的 |
|---|---|---|
| 進行中回覆的部分文字（`WithPartialFlush`，`GET /messages` 的 pending `content`） | 只有 `text` delta（標記行除外） | 敏感內容不要放進 `text`；`tool` / `reasoning` 不會存 |
| 完成的回覆 `content` | runner 回的 `Content`（不是 delta 拼起來的） | 不要把工具輸入寫進 `Content` |
| 取消時保留的文字 | 只有 `text` delta | 同上 |
| 宿主自己的 `Publisher`（`tangent.Publishers(hub, relay)` 的 relay） | 原始的 `message.delta` | 自己的通道自己過濾（依權限範圍分送的事件） |
| `WithDeltaSink` / `Observe` / 直接呼叫 `Engine.StreamSince` | 原始 delta | 都是宿主的內部通道，不要直接交給客戶端 |
| `hostMeta`（§4.5） | 原樣給每個讀者 | 不要把敏感內容移到這裡 |

事件本身（`message.*`、`line.*`…）沒有依讀者過濾：同樣的物件在 REST 讀取也拿得到，只過濾事件擋不住任何東西。只該給部分讀者的資料就不要放進函式庫的物件。

其他要宿主自己處理的：速率限制（參考伺服器的閘道回 `429 rate_limited`）、CORS。httpapi 要求有本文的請求都是
`application/json`（否則 415），跨站的表單 POST 因此無法直接打進來；用 cookie 認證時仍建議加上 CSRF 保護。

**即時通道二選一（或都要）**：

- **用 httpapi 的 SSE**：`hub := httpapi.NewHub(...)`，`tangent.WithPublisher(hub)` 加 `httpapi.Config{Hub: hub}`，路由 `GET /events`。
  Hub 依租戶分送、慢客戶端會收到 `stream.lagged`、每 25 秒 keepalive；`WithMaxStreams`、`WithClientBuffer`、`WithMaxLag` 等可調。
  關機時呼叫 `hub.Close()`（例如 `http.Server.RegisterOnShutdown(hub.Close)`），否則串流不會結束。
- **用自己的通道**（WebSocket、既有的 SSE、訊息佇列）：`Config.Hub` 留 nil（不掛 `/events`），用自己的 `Publisher`（例如上面的 `Relay`）轉送。
- 兩者都要：`tangent.WithPublisher(tangent.Publishers(hub, relay))`。

## 6. 遷移策略

tangent 的資料表都以 `tangent_` 開頭、不指定 schema，建在連線 `search_path` 的第一個 schema。建議給 tangent 一個專用的 schema
（pool 的 `search_path` 設成它），跟宿主自己的表分開。

**自動**：啟動時呼叫 `store.Migrate(ctx, pool)`（再加需要的 `store.MigrateFeatures`）。每個步驟一個交易，記在 `tangent_schema_migrations`
（功能的記在 `tangent_feature_migrations`），跟宿主自己的 migration 表不衝突；advisory lock 讓多個行程同時啟動時依序等待。

**自己的 migrator**：核心 migration 在 `store.MigrationsFS` 的 `migrations/NNN_name.up.sql` / `.down.sql`，功能的在
`store.FeatureMigrationsFS` 的 `features/<feature>/NNN_name.up.sql`。依編號套用 `.up.sql` 即可，但要注意：

- 功能的擴充（`search` 的 `pg_trgm`）由你事先安裝在 `search_path` 上的 schema。
- **`tangent.New` 會檢查 `tangent_feature_migrations`**：套用功能 migration 時要在同一個交易呼叫 `store.RecordFeatureMigration(ctx, tx, feature, version)`，否則 `New` 會說功能沒遷移。
- 核心步驟同樣用 `store.RecordCoreMigration(ctx, tx, version)` 記到 `tangent_schema_migrations`，之後改用 `store.Migrate` 也不會重跑。兩者都會在版本表不存在時建立它，回傳 `recorded`（之前記過就是 false），所以可以先記錄、只有新的步驟才執行。

<!-- snippet: examples/embedding/migrate.go#own-migrator -->
```go
// TangentSteps lists the up migrations of an embedded tangent FS directory
// in order: "migrations" in store.MigrationsFS, or "features/<name>" in
// store.FeatureMigrationsFS. File names are NNN_name.up.sql.
func TangentSteps(fsys fs.FS, dir string) ([]Step, error) {
	names, err := fs.Glob(fsys, path.Join(dir, "*.up.sql"))
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	steps := make([]Step, 0, len(names))
	for _, name := range names {
		base := path.Base(name)
		version, err := strconv.Atoi(strings.SplitN(base, "_", 2)[0])
		if err != nil {
			return nil, fmt.Errorf("%s: no version prefix", name)
		}
		sql, err := fs.ReadFile(fsys, name)
		if err != nil {
			return nil, err
		}
		steps = append(steps, Step{Version: version, Name: base, SQL: string(sql)})
	}
	return steps, nil
}

// ApplyWithOwnMigrator applies tangent's core steps (and the search
// feature's) the way a host migrator would, each step in its own
// transaction. It records each step with store.RecordCoreMigration /
// store.RecordFeatureMigration in the step's transaction: tangent.New
// checks tangent_feature_migrations for features with migrations, and
// keeping tangent_schema_migrations right lets the host switch to
// store.Migrate later without replaying anything.
func ApplyWithOwnMigrator(ctx context.Context, pool *pgxpool.Pool) error {
	core, err := TangentSteps(store.MigrationsFS, "migrations")
	if err != nil {
		return err
	}
	search, err := TangentSteps(store.FeatureMigrationsFS, "features/search")
	if err != nil {
		return err
	}
	for _, s := range core {
		record := func(tx pgx.Tx) (bool, error) { return store.RecordCoreMigration(ctx, tx, s.Version) }
		if err := applyOnce(ctx, pool, s, record); err != nil {
			return err
		}
	}
	// The feature's extension (pg_trgm) is installed beforehand by whoever may
	// create extensions, in a schema on the connection's search_path.
	for _, s := range search {
		record := func(tx pgx.Tx) (bool, error) {
			return store.RecordFeatureMigration(ctx, tx, tangent.FeatureSearch, s.Version)
		}
		if err := applyOnce(ctx, pool, s, record); err != nil {
			return err
		}
	}
	return nil
}
```

（範例沒有處理多個行程同時遷移；用你的 migrator 自己的鎖。）

**回退**：`store.MigrateDown(ctx, pool, target)` 回退比 `target` 新的核心步驟（`target` 0 = 刪掉所有核心表，版本表保留）。
功能 migration 建在核心表上，所以**只要回退任何核心步驟，就先回退所有已套用的功能 migration**；之後要再 `MigrateFeatures`。
只回退功能用 `store.MigrateFeaturesDown(ctx, pool, features...)`（擴充保留）。

## 7. 維護迴圈

函式庫不自己開計時器。宿主定期呼叫 `engine.Maintain(ctx)`（參考伺服器與 `examples/minimal-host` 每分鐘一次，啟動時先跑一次）：

- pending 超過 `WithStaleTurnAge`（預設 15 分鐘）的回合標成失敗（行程當掉留下的）；
- 超過該 kind 逾時的 job 標成失敗（`card_draft` 3 分鐘、`summary` 5 分鐘）；
- 功能的清理工作（`aside`：清除到期的岔題）；
- 清掉過期的 delta 緩衝。

每一項都會跑，即使前一項失敗；錯誤合併回傳。回傳的 `MaintenanceReport` 可以記 log。

## 8. 升級規則

- **同步點之後 API 只新增**（`docs/plan/BACKEND_PLAN.md` 的 C0–C4；核心 API 在 C1 凍結）：新增欄位、路由、事件、選項可以；
  改名、刪除或改語意要先記進 `docs/DESIGN.md` §12 並通知前端。客戶端要忽略不認得的 JSON 欄位與事件。
- **版本**：每個版本的變更（含不相容的變更）寫在 [CHANGELOG.md](../CHANGELOG.md)，版本政策見[第 0 節](#0-取得-tangent)。
- **版本與 migration**：每個版本附帶它需要的 migration（嵌在 `store.MigrationsFS`）。升級時先跑 migration 再啟動新版本；
  `store.Migrate` 只往前套用沒跑過的步驟，已套用的步驟不會改內容（要改就新增一個步驟）。新功能的資料表一律走核心 migration
  （空表沒有成本，之後開功能不用再遷移）；只有需要資料庫擴充的功能另附功能 migration。
- **多個行程滾動升級**：規則是 migration 對前一版程式相容（只新增欄位與表），這樣可以先遷移、再逐一換掉行程；
  不相容的步驟會在該步的 devlog 與 DESIGN §12 註明，那一版要停機升級。
- **錯誤碼**維持穩定；新增的碼列在 `docs/API.md` 的錯誤碼表（`httpapi/apidoc_test.go` 會檢查每個碼都在表上）。
