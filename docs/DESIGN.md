# Tangent · 設計（契約）

> 樹狀分支對話引擎：從主線任一則訊息岔出支線、在支線裡跟 AI 討論、帶著結論卡回到主線。
> 這份文件是契約：實作、測試、Web UI 與宿主整合都以這份為準。改契約要先改這份文件。

## 1. 目標與非目標

**目標**
1. 一個可嵌入的 Go 函式庫：宿主服務 `import` 後，拿自己的 `pgxpool.Pool` 就能用。
2. 執行 AI 的方式由宿主決定（佇列、daemon、直接呼叫 API 都行），函式庫只定義「開始一輪 / 完成一輪」。
3. 一個參考伺服器（`cmd/tangent-server`）加 Web UI，讓它可以單獨使用，也給非 Go 的服務用 HTTP 接。
4. 便於嵌入宿主服務：宿主的對話 ID 與 tangent 的 line 可共用同一個 UUID（§9）。

**非目標**
- 不做登入、角色、帳號。宿主傳 `Scope`，函式庫只檢查租戶有沒有對上。
- 不做 git worktree、ask/edit 模式、shell、ACP 權限請求、「支線讀主線 worktree」。這些屬於宿主的執行環境，留在宿主服務。
- 不做附件儲存。宿主把附件參照放在 `host_meta`。
- 不支援 Postgres 以外的資料庫（KISS；非 Postgres 的宿主用 HTTP 模式）。

## 2. 名詞

| 產品用語 | 程式名稱 | 說明 |
|---|---|---|
| 對話 / 主線 | `Line`（沒有 branch 記錄的） | 一棵樹的根 |
| 支線 | `Line` + `Branch` | 掛在父線某一則訊息（anchor）上 |
| 岔題 | `Branch.Kind = aside` | 一問一答，答完自動結束，保留 7 天後清除；可以保留（`kept_at`，不清除）、接著問（換成一般支線）或立刻刪除（B23） |
| 背景包 | `Pack` | 開支線時把父線脈絡壓成有 token 預算的文字，之後每輪都帶給 AI |
| 結論卡 | `Card` | 支線返回時插進父線的結構化 system 訊息，下一輪才送給 AI |
| 筆記 | `Note` | 整棵樹共用一頁：decided / fact / to_confirm / todo |
| 章節 | `Chapter` | 讀取時計算：閒置間隔（預設 30 分鐘）+ topic 切點（摘要、主線回覆的 `[CHAPTER]` 行、第一輪的 `[TOPIC]`）+ 手動 milestone |
| 一輪 | `Turn` | 一則使用者訊息 + 一則 pending 的助理訊息，直到完成 |

## 3. 套件結構

```
github.com/Rynvex/tangent
├── domain/        純邏輯與型別，不做 IO，只依賴標準函式庫與 google/uuid
├── store/         Postgres：migrations（embed）、sqlc 查詢、所有交易
│   ├── migrations/   NNN_name.up.sql / .down.sql
│   ├── queries/      sqlc 查詢
│   └── db/           sqlc 產生（不要手改）
├── tangent/       Engine：組合 store + domain + 宿主掛勾；turn 協定、事件、delta 緩衝
├── httpapi/       可掛載的 http.Handler（標準函式庫 ServeMux），SSE hub
├── runner/        Runner 實作：fake、openai（相容端點）、anthropic；只用 net/http
├── tangenttest/   測試工具：每個測試一個乾淨 schema、假 Runner、事件收集器
├── cmd/tangent-server/  參考伺服器
└── web/           pnpm workspace：packages/client、packages/react、apps/demo
```

依賴方向：`domain` ← `store` ← `tangent` ← `httpapi` ← `cmd`。`runner/*` 只依賴 `tangent` 的 Runner 型別。
`domain` 不得 import 其他內部套件。

## 4. 資料表（`store/migrations`）

全部表名前綴 `tangent_`，不指定 schema（測試靠 `search_path` 隔離）。
版本表 `tangent_schema_migrations(version int primary key, applied_at timestamptz)`，跟宿主自己的 migration 不衝突。
宿主若有自己的 migrator，可以改用匯出的 `store.MigrationsFS`。

```sql
CREATE TABLE tangent_line (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- 宿主可以指定既有的對話 ID
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','thinking','error')),
  status_detail TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',               -- Runner 提示，可空
  model TEXT NOT NULL DEFAULT '',
  unread INT NOT NULL DEFAULT 0,
  summary JSONB,                                   -- 滾動摘要
  summary_upto_seq BIGINT,                         -- 摘要涵蓋到哪個 seq
  notes_revision INT NOT NULL DEFAULT 0,           -- 只在主線有意義
  notes_revision_sent INT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,          -- 這條線累計用量（token 計量用）
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  host_meta JSONB NOT NULL DEFAULT '{}',           -- 宿主資料，函式庫原樣保存
  folder TEXT NOT NULL DEFAULT '',                 -- B18（016）：主線的資料夾，'' = 未分類；支線永遠 ''
  tags TEXT[] NOT NULL DEFAULT '{}',               -- B18（016）：主線的標籤（正規化過）；支線永遠 '{}'
  import_batch_id UUID,                            -- B25（019）：匯入批次（沒有 FK：批次列刪了線照常存在）；attach 後保留，spinoff 的新主線 NULL
  import_seq BIGINT,                               -- B25（019）：匯入完成時這棵樹最新訊息的 seq（判斷匯入後有沒有用過）
  import_activity_at TIMESTAMPTZ,                  -- B25（019）：匯入完成時主線的 last_activity_at（B19 可能是來源的歷史時間）
  pinned_at TIMESTAMPTZ,                           -- B25（019）：釘選的時間，只有主線；attach 時清掉；不算活動
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tangent_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,  -- 全域遞增；線內排序一律用 seq
  line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','branch_card','branch_marker')),
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending','done','error')),
  meta JSONB NOT NULL DEFAULT '{}',                -- 函式庫的：card、delivered、editedAt、suggestions、usage、error、deliversCards…
  host_meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- index (line_id, seq)

CREATE TABLE tangent_branch (
  line_id UUID PRIMARY KEY REFERENCES tangent_line(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  parent_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
  root_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
  anchor_message_id UUID NOT NULL,                 -- 沒有 FK：訊息會在線之間搬動
  excerpt TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('aside','investigate','alternative')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','merged','discarded','promoted')),
  depth INT NOT NULL CHECK (depth >= 1),
  origin TEXT NOT NULL CHECK (origin IN ('selection','button','move','suggestion','previous_main_line')),
  pack JSONB NOT NULL DEFAULT '{}',
  draft_status TEXT NOT NULL DEFAULT 'none' CHECK (draft_status IN ('none','drafting','ready','failed')),
  draft JSONB NOT NULL DEFAULT '{}',
  draft_job_id TEXT NOT NULL DEFAULT '',
  draft_started_at TIMESTAMPTZ,
  draft_upto_seq BIGINT,
  draft_parent_tip_message_id UUID,
  conclusion_line TEXT NOT NULL DEFAULT '',
  card_message_id UUID,
  closed_at TIMESTAMPTZ,
  kept_at TIMESTAMPTZ,                             -- B23（017）：保留的順口問，清除時跳過；NULL = 沒保留
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- index (parent_line_id, status), (root_line_id, created_at)

CREATE TABLE tangent_note (...);         -- tenant_id + root_line_id
CREATE TABLE tangent_chapter_cut (...);  -- message_id 不加 FK
CREATE TABLE tangent_memo (...);         -- 備忘（memo，B13）：不給 AI；root_line_id CASCADE、line_id SET NULL、source_label 快照
CREATE TABLE tangent_term (...);         -- 名詞表（glossary，B24，018）：root_line_id CASCADE、source_line_id SET NULL、source_message_id 無 FK、
                                         -- source_label 快照、UNIQUE (root_line_id, term_key)、index (tenant_id, term_key)
CREATE TABLE tangent_import_batch (      -- 匯入批次（B25，019）：id 由客戶端產生；index (tenant_id, created_at DESC, id DESC)
  id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- tangent_line 的部分索引：(tenant_id, import_batch_id) WHERE import_batch_id IS NOT NULL；(tenant_id, pinned_at DESC, id DESC) WHERE pinned_at IS NOT NULL

-- 背景工作（結論卡草稿、滾動摘要、功能模組工作）。宿主執行，Engine 用它做冪等與逾時判斷。
CREATE TABLE tangent_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,                              -- card_draft | summary | 功能模組自己的 kind
  feature TEXT NOT NULL DEFAULT 'core',
  line_id UUID REFERENCES tangent_line(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','superseded')),
  input JSONB NOT NULL DEFAULT '{}',               -- 開工當下的游標等，FinishJob 用來判斷是否過期
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
-- index (line_id, kind, status)
```

**設計取捨與關鍵修正**
1. 訊息排序用全域 `seq`，不再依賴 `created_at`。搬移訊息時 seq 不變，所以 move / promote 不需要重新編號，也沒有時間戳同值的風險。summary 與 draft 的游標改存 seq。
2. 刪除整棵用 `DeleteTree`（主線才能刪）。單獨刪除只限已結束的順口問與 `discarded` 的支線，連同它底下的子樹一起刪（`DeleteBranch`，B23），所以不會留下孤兒資料；其他的線不能單獨刪。
3. promote：任何「直接掛在主線下」的支線都能升級，不限 `kind`。
4. 角色採用 `user` / `assistant` / `system`；`meta.kind` 升為 `kind` 欄位。
5. 不含 `awaiting_input` 狀態、`turnQueued`、`readsFrom`、`hasPendingPermission`（都屬於宿主執行環境）。

## 5. 不變條件（不得放寬）

- **加鎖順序**：root → parent → child；一組 line 依 id 排序後加鎖。所有交易都遵守，避免死鎖。
- **上限**（`domain.Limits` 預設值）：軟深度 3（超過要 `confirmDeeper`）、硬深度 6、每個父線 open 支線 8、每棵樹 200、purpose 200 字、excerpt 1500 字、move 1..40 則。
- **anchor** 必須是父線上 `done` 的 user 或 assistant 訊息，或父線上的結論卡（`branch_card`，從帶回的結論繼續追問，B17；發散與 `fresh` 獨立仍只接受 user / assistant）。
- **狀態機**：`open → merged | discarded | promoted`，單向、終態；用 `WHERE status='open'` 守住。
- **可否開始一輪**（`requireBranchAcceptsTurn`）：沿祖先鏈往上，任何祖先已關閉、已封存、aside 已回答、支線正在起草 → 拒絕。同一條線同時只能有一個 pending turn。
- **merge**：鎖 root/parent/child；父線或支線有 pending turn → `parent_busy`；父線最新訊息不是呼叫者看到的 `parentTipMessageId` → `ParentMovedError`（除非 `confirmParentMoved`）；插入 `branch_card` 訊息、關閉支線、可選地在同一交易套用筆記變更。
- **結論卡送達**：卡片在父線下一輪的 prompt 裡帶出，該輪「成功完成」才標記 `delivered`。編輯已帶回的卡（B17）清掉 `delivered`，下一輪再帶一次，並記下 `meta.editedAt`（B17.1，資料庫時鐘，送達後保留）；放卡片的線在回合中時拒絕編輯（`parent_busy`）。
- **move**：來源線不能 thinking 或有 pending；尾段第一則必須是 user；不能包含 card / marker；掛在被搬走訊息上的支線改掛到新支線，子樹 depth +1 並檢查硬深度；來源線留 `branch_marker`；摘要游標落在被搬走範圍時重設。
- **extract**（B18，move 的一般化：任意連續區間）：同 move 的規則，區間只能是完成的 user / assistant 一般訊息；新支線掛在區間之前最近可掛支線的訊息上。
  標記（或帶卡時已送達的結論卡）寫在區間最後一則空出來的 `seq`（那一則換一個新的 `seq`，仍是支線裡最新的），所以標記在線內的位置就是區間原本的位置；
  這是唯一會改訊息 `seq` 的操作，只改被搬走的那一則，線內順序不變。
- **attach**（B20，detach 的反向）：鎖兩條主線（依 id）→ 目標線 → 來源樹的支線（依 id）；來源必須是同租戶的獨立主線、不在目標的樹裡；兩邊都不能封存、在回合中，來源樹不能起草；
  深度與每棵上限把來源整棵樹算進去；來源線的訊息與 `seq` 不變，整棵樹的附屬資料改到目標的主線底下，舊主線底下不留任何列。
- **promote**：只有主線的直接子支線；所有相關線不能 thinking / pending / drafting；舊尾段（anchor 之後）搬到新的「前主線」支線（origin `previous_main_line`，直接 `discarded`）；舊尾段上的子支線必須都已關閉；升級支線的子支線提升到主線並檢查 open 上限。主線 id 不變。
- **順口問的去留**（B23）：保留只寫 `kept_at`（鎖順口問那條線），不改狀態；清除在鎖下再確認沒被保留。**接著問**不重開已結束的順口問：鎖 root → parent → 順口問 → 子樹，
  在同一個錨點開新的 `open` 支線（上限照建立支線檢查），完成的訊息搬過去（`seq` 不變）、子支線改掛（深度不變），再刪掉順口問那條線。
- **刪除支線**（B23）：鎖 root → 這條線 → 子樹（依 id）；只有已結束的順口問、或 `discarded` 且不是先前的主線、沒被合併進別的支線的可以刪；子樹有 `open` 支線或有線在回合中就拒絕；
  父線上的標記不動，掛勾在刪除前執行。
- **名詞表**（B24）：寫入鎖主線；從順口問存名詞時接著鎖順口問那條線（主線 → 順口問，同清除、接著問、刪除支線的順序）並在同一個交易設 `kept_at`。
- **起草**：`none → drafting → ready | failed`；起草超過 3 分鐘視為失敗；`FinishDraft` 對不上 job id / 已逾時 / 已關閉時不寫入。只存清洗過的卡，不存模型原始輸出。
- **事件只在 commit 之後發出。**

## 6. Engine API（root 套件 `tangent`）

```go
type Scope struct {
    Tenant string // 必填
    Actor  string // 寫進 created_by
}

func New(pool *pgxpool.Pool, opts ...Option) (*Engine, error)
// Options: WithFeatures, WithFeaturePolicy（§11）, WithPublisher, WithPromptContributor, WithTurnGate,
//          WithLimits, WithExtraMarkers, WithClock, WithLogger

// 交易掛勾：在同一個交易裡、commit 前執行；回傳錯誤就整筆 rollback。
// Tx 只有 Exec / Query / QueryRow（不能 Commit / Rollback）；result 是這次寫入將回傳的值（新 id 看得到）。
type TxHook = store.TxHook // func(ctx context.Context, tx store.Tx, result any) error
func InTx(h TxHook) TxOption
```

**Lines**：`CreateLine`、`GetLine`、`ListLines`（只列主線；B18 可依 `folder` / `tag` 篩選）、`UpdateLine`、`MarkRead`、`ArchiveTree`、`DeleteTree(… TxOption)`、
`RenameFolder`（B18）、`ImportLine`（B18：外部對話一個交易寫入，不呼叫模型；B19 保留來源時間、寫章節切點與已帶回的支線）、`Decompose`（B18：唯讀的整理建議）、
`TenantOrganization`（B18.1：全租戶資料夾與標籤的篇數）。
`DeleteTree` 的掛勾在刪除前執行，宿主可以先讀出要清的 `host_meta`（例如附件）。

**Turn 協定**（核心）：

```go
func (e *Engine) BeginTurn(ctx, scope, lineID string, in TurnInput, opts ...TxOption) (Turn, error)
// 鎖線 → 檢查可否開始 → TurnGate → 插入 user + pending assistant → status=thinking → 組 prompt
type Turn struct {
    ID          string          // = pending assistant 訊息 id
    LineID      string
    UserMessage domain.Message
    Pending     domain.Message
    Prompt      domain.Prompt   // 結構化：Sections + Summary + History
    Provider, Model string
}
func (e *Engine) AppendDelta(ctx, turnID string, d domain.Delta) error      // 緩衝 + 發 message.delta
func (e *Engine) StreamSince(ctx, scope, lineID string, afterSeq int64) ([]domain.Delta, error)
func (e *Engine) CompleteTurn(ctx, turnID string, r TurnResult, opts ...TxOption) (CompletedTurn, error)
// 冪等：訊息不是 pending 就回 ErrTurnNotPending。解析 [BRANCH-SUGGEST]、標記卡片送達、
// 記錄 notes_revision_sent、結束已回答的 aside、status=idle、回報 SummaryDue。
// 一律拿掉 [TOPIC] / [CHAPTER] 行；prompt 有要時，commit 後用 [TOPIC] 改名
// （主線 UpdateLine、支線 RenameBranch），chapters 開著時用 [CHAPTER] 記 topic 切點。
func (e *Engine) CancelTurn(ctx, scope, lineID string) error
func (e *Engine) FailStaleTurns(ctx, olderThan time.Time) ([]StaleTurn, error)

// 同步便利函式：Prompt.Chat() → runner.Run（串流 delta）→ CompleteTurn
func (e *Engine) RunTurn(ctx, t Turn, r Runner) (CompletedTurn, error)
```

`domain.Prompt` 有兩種輸出：`Chat() (system string, msgs []ChatMessage)` 給 API 型 runner；
`Text() string` 給 CLI 型宿主（單一文字格式）。

**支線**：`CreateBranch`、`ListBranches(includeAside)`、`GetBranch`（含 pack、draft、`parentTipMessageId`）、
`MoveToBranch`、`ExtractToBranch`（B18：任意一段抽成支線，可帶結論卡）、`AttachLine`（B20：另一條主線連同整棵樹併入成支線，detach 的反向）、`StartDraft → Job`、`Merge(… TxOption)`、`UpdateBranchCard(… TxOption)`（編輯已帶回的結論卡，B17）、`Discard`、`Promote`、
`KeepBranch`（B23：保留順口問）、`ContinueAside`（B23：順口問換成一般支線接著問）、`DeleteBranch(… TxOption)`（B23：刪除已結束的支線與它的子樹，掛勾在刪除前執行）。新支線預設繼承父線的 provider/model，可覆寫。

**背景工作**：所有單次 AI 工作（結論卡草稿、滾動摘要、功能模組的工作）都是 `Job`，記在 `tangent_job`：

```go
type Job struct {
    ID, Kind, Feature string
    Scope           Scope
    LineID          string
    Prompt          domain.Prompt // 不帶工具的單次呼叫
    Provider, Model string        // 功能設定的模型提示（例如便宜模型），可空
}
func (e *Engine) FinishJob(ctx, jobID, raw string, runErr error) error
// 依 Kind 交給對應的處理者；job 已不是 pending、已逾時或已被取代時不寫入。
```

**摘要**：`StartSummary(lineID) → Job`（kind `summary`）；完成時同時記錄 topic 切點。

**預覽**：`PreviewTurn(lineID, content) → domain.Prompt + token 估計`，不寫入任何東西（token 計量與「送出前預覽」用）。

**筆記 / 章節**：`ListNotes`、`ApplyNoteChanges`、`UpdateNote`、`SupersedeNote`、`ListChapters`、`AddMilestone`、`DeleteMilestone`。

**維護**：`PurgeExpiredAsides(now)`（保留的順口問不清，B23）。

**名詞表**（`glossary`，B24）：`ListTerms`、`CreateTerm`（從順口問存會保留它）、`UpdateTerm`、`DeleteTerm`、`SearchTerms`；InTx 收到 `store.TermChange`。

### 宿主掛勾

```go
type Publisher interface { Publish(ctx context.Context, ev Event) }
type PromptContributor interface { // 宿主用來加自訂上下文區塊（如 plan / blackboard）
    Contribute(ctx context.Context, scope Scope, line domain.LineView) ([]domain.PromptSection, error)
}
type TurnGate interface { // 宿主用來擋執行器離線等條件
    AllowTurn(ctx context.Context, scope Scope, line domain.LineView) error
}

type Runner interface {
    Run(ctx context.Context, req RunRequest) (RunResult, error)
}
type RunRequest struct {
    Provider, Model string
    System          string
    SystemBlocks    []SystemBlock
    Messages        []domain.ChatMessage
    MaxTokens       int
    OnDelta         func(domain.Delta) // 可為 nil
    ReasoningEffort string             // 思考深度ヒント（low/medium/high/xhigh/max），空值由 runner 決定；不支援的 runner 忽略（G1）
    HostMeta        json.RawMessage    // Turn.Request() 原樣帶入使用者訊息非空的 host_meta；函式庫不讀（G1）
}
type RunResult struct { Content string; Usage domain.Usage; StopReason string }

// Engine.ModelCatalog() 回傳 []ModelGroup（{Provider, Models, Ready?, Reason?, Details[{Model, DisplayName?, Status?, EffortLevels?}]?}），
// 未填的選填欄位不輸出到 JSON（G1）。

// httpapi 與參考伺服器透過 Dispatcher 執行工作；宿主可以換成自己的佇列。
type Dispatcher interface {
    DispatchTurn(ctx context.Context, t Turn) error
    DispatchJob(ctx context.Context, j Job) error
}
func NewRunnerDispatcher(e *Engine, r Runner, opts ...DispatcherOption) Dispatcher // goroutine + timeout
// B22：RunnerDispatcher.RunOnce(ctx, RunRequest) 同步跑一次、不存任何東西（算進 WithMaxQueue、等 WithMaxConcurrent）；
// httpapi 對實作 OnceRunner 的 Dispatcher 用它做 Engine.AnalyzeImport 的模型呼叫。
```

### 事件

```go
type Event struct {
    Type       string // 見下表
    Tenant     string
    RootLineID string
    LineID     string
    Data       any    // JSON 可序列化
}
```

| Type | Data |
|---|---|
| `line.created` / `line.updated` | `LineView` |
| `line.deleted` | `{rootLineId, lineIds[]}`（整棵樹，或樹還在時被刪的支線與它底下的線：清除、接著問、刪除支線，B23） |
| `message.created` / `message.updated` | `Message` |
| `message.delta` | `{turnId, seq, kind, text}` |
| `branch.changed` | `{change: created\|moved\|promoted\|draft\|merged\|discarded\|renamed\|detached\|kept, branch: BranchView}`（已帶回的支線再發一次 `merged` = 結論卡被編輯，B17） |
| `notes.changed` | `{rootLineId, revision}` |
| `chapters.changed` | `{rootLineId}` |
| `suggestion.changed` | `{rootLineId, suggestion}`（建議匣，B8） |
| `leaf.changed` | `{lineId, rootLineId, leaf \| null}`（`leaf`，B8） |
| `seeds.changed` | `{rootLineId}`（`parking`，B8） |
| `link.changed` | `{rootLineId, link}`（`spinoff`、`relations`） |
| `goal.changed` | `{rootLineId, goal \| null}`（`goal`，B9） |
| `memo.changed` | `{rootLineId, memoId, change: created\|updated\|deleted}`（`memo`，B13） |
| `terms.changed` | `{rootLineId, termId, change: created\|updated\|deleted}`（`glossary`，B24） |
| `summary.due` | `{lineId, rootLineId}`（`summary` suggest 模式，B6.1） |

### 錯誤

`domain.Error{Code, Message, Extra map[string]any}`。錯誤碼字串維持穩定（例如 `parent_moved`、`parent_busy`、
`branch_closed`、`depth_soft_limit`、`open_branches_on_old_tail`），讓前端與既有整合不用改。httpapi 依 Code 對應 HTTP 狀態碼。

未知的錯誤碼（例如宿主的 `TurnGate` 回傳自己的碼）：httpapi 用 `Config.StatusFor(code) (int, bool)` 查，
查不到時 `domain.Error` 回 409、其他錯誤回 500（訊息不外洩）。

## 7. HTTP API（`httpapi`，掛在宿主選的前綴下，例如 `/api`）

JSON 一律 camelCase。錯誤格式 `{ "error": "訊息", "code": "代碼", ...extra }`。

| Method | Path | 說明 |
|---|---|---|
| GET | `/lines?archived=&limit=&cursor=&folder=&tag=&pinned=` | 主線列表（`folder` / `tag` 篩選，B18；`pinned=true` 只列釘選的、依釘選時間、不分頁，B25） |
| POST | `/lines` | 建立主線（可帶 `folder`、`tags`，B18） |
| POST | `/lines/import` | 匯入外部對話（主線、訊息與一階支線，一個交易、不呼叫模型，B18；B19 可帶歷史時間、章節切點與已帶回結論卡的支線；B25 可帶 `batchId` / `batchLabel`） |
| GET | `/imports?limit=&cursor=` | 這個租戶的匯入批次 `{id, label, createdAt, lineCount, standaloneCount}`，新的在前（核心、唯讀，B25） |
| DELETE | `/imports/{bid}?force=` | 復原匯入批次：逐棵刪掉仍獨立的樹 → `{deleted, kept[{lineId, reason}]}`（B25） |
| POST | `/lines/folders/rename` | 資料夾改名或解散 → `{updated}`（B18） |
| GET / PATCH / DELETE | `/lines/{id}` | 讀取 / 改標題、provider/model、資料夾、標籤或釘選（B25） / 刪整棵（主線） |
| POST | `/lines/{id}/archive`、`/unarchive`、`/read` | 封存整棵 / 解除 / 清除未讀 |
| GET | `/lines/{id}/messages?afterSeq=&limit=` | 訊息 |
| GET | `/lines/{id}/export` | 整棵樹一次讀回（核心、唯讀可用；每條線最多 500 則，超過時 `truncated`，B14） |
| POST | `/lines/{id}/messages` | 開始一輪 → 202 `{turnId, userMessage, pendingMessage}`，交給 Dispatcher |
| GET | `/lines/{id}/stream?afterSeq=` | 補抓串流 delta |
| POST | `/lines/{id}/cancel`、`/compact` | 取消這一輪 / 強制摘要 |
| GET / POST | `/lines/{id}/branches` | 整棵樹的大綱（`includeAside`） / 建立支線 |
| POST | `/lines/{id}/branches/move` | 把最後 N 則搬成支線 |
| POST | `/lines/{id}/branches/extract` | 把任意一段連續訊息抽成支線（可帶結論卡直接帶回，B18） |
| POST | `/lines/{id}/attach` | 把另一條獨立主線連同整棵樹併入成這條線的支線（可帶結論卡直接帶回；detach 的反向，B20） |
| GET | `/lines/{id}/decompose` | 整理建議：標籤、章節切點、岔題區段、停車場候選、相關對話（核心、唯讀、不呼叫模型，B18） |
| GET | `/lines/organization` | 全租戶的資料夾（未封存／封存分開數）與未封存主線的標籤篇數（核心、唯讀，B18.1） |
| POST | `/lines/import-analyze` | 匯入前的預處理分析：1–200 個單元縫合成主幹＋支線樹的提案（核心、讀、不寫入；模型不可用時用確定性演算法，B22） |
| POST | `/lines/{id}/branches/preview` | 預覽新支線的背景（含 token），不寫入 |
| GET / PATCH | `/lines/{id}/branch` | 支線標頭、pack、draft、parentTipMessageId / 改支線目的（回 `{branch}`；進行中與已結束的支線，B13） |
| POST | `/lines/{id}/branch/draft`、`/merge`、`/discard`、`/promote` | 起草結論卡 / 返回 / 放棄 / 升為主線 |
| PATCH | `/lines/{id}/branch/card` | 編輯已帶回支線的結論卡 → `{branch, message}`（核心，B17） |
| PUT | `/lines/{id}/branch/keep` | 保留或取消保留順口問 `{keep}` → `{branch}`（`aside`，B23） |
| POST | `/lines/{id}/branch/continue` | 接著問：順口問換成一條新的進行中支線，訊息搬過去 → 201 `{branch, line, replacedLineId}`（`aside`，B23） |
| DELETE | `/lines/{id}/branch` | 刪除已結束的支線（已結束的順口問、`discarded` 的支線）與它的子樹 → `{rootLineId, lineIds}`（核心，B23） |
| GET / POST | `/lines/{id}/notes` | 筆記 |
| PATCH | `/lines/{id}/notes/{nid}` | 改筆記 |
| POST | `/lines/{id}/notes/{nid}/supersede` | 取代筆記 |
| GET | `/lines/{id}/chapters` | 章節 |
| POST / DELETE | `/lines/{id}/chapters/milestones[/{mid}]` | 新增 / 刪除 milestone |
| GET | `/events` | SSE（選用；宿主可以用自己的即時通道） |
| GET | `/capabilities` | 已開啟的功能模組與模式（§11）、`permissions` 與可選模型（含選填 `ready` / `reason` / `details`，G1），前端據此決定顯示哪些 UI |
| POST | `/lines/{id}/preview` | 預覽這一輪會送出的 prompt 與 token 估計 |
| GET | `/lines/{id}/suggestions?status=` | 整棵樹的建議（建議匣，B8） |
| POST | `/suggestions/{sid}/accept`、`/dismiss` | 接受（執行對應動作）/ 忽略 |
| POST | `/lines/{id}/suggestions/dismiss-all` | 一次忽略整棵樹 open 的建議 → `{rootLineId, suggestions}`（B17） |
| GET / PUT / DELETE | `/lines/{id}/leaf` | 支線的收尾（`leaf`） |
| POST | `/lines/{id}/leaf/draft` | AI 起草收尾 → 202 |
| GET / POST | `/lines/{id}/seeds?status=` | 停車場種子（`parking`） |
| POST | `/lines/{id}/seeds/batch` | 一次停 1–20 顆種子，全建或全不建（B14） |
| POST | `/seeds/{sid}/expand`、`/to-note`、`/drop` | 展開成支線 / 記進紀要 / 丟掉 |
| GET / POST | `/lines/{id}/memos?lineId=` | 備忘（`memo`，不給 AI） |
| PATCH / DELETE | `/memos/{mid}` | 改 / 刪備忘 |
| GET / POST | `/lines/{id}/terms` | 名詞表（`glossary`，B24；POST 的 `{id}` 是來源，順口問會被保留） |
| PATCH / DELETE | `/terms/{tid}` | 改 / 刪名詞（刪除回 204） |
| GET | `/terms?q=&limit=&cursor=` | 全租戶查名詞（帶對話標題，封存的不列） |
| POST | `/lines/{id}/spinoff` | 獨立成新對話（`detach` 整條支線 / `fresh` 從某則訊息） |
| GET | `/lines/{id}/links` | 這棵樹的連結（獨立的來源與去向） |
| POST | `/lines/{id}/spinoff/preview` | 預覽起始膠囊（不寫入） |
| GET / PUT / DELETE | `/lines/{id}/goal` | 對話目標（`goal`，B9） |
| POST | `/lines/{id}/goal/propose` | AI 提出目標 → 建議匣 |
| GET / POST | `/lines/{id}/relations` | 關聯線（`relations`；可帶種類 `relationKind`，B15） |
| PATCH / DELETE | `/lines/{id}/relations/{rid}` | 改說明與種類（沒給的欄位保留，B15）/ 刪除關聯線 |
| POST / DELETE | `/messages/{mid}/pin` | 釘選訊息（核心） |
| PUT / DELETE | `/messages/{mid}/tag` | 論證類型（`ibis`；`status: draft` 改回待確認，B15）/ 移除 |
| GET | `/lines/{id}/tag-drafts` | 整棵樹待確認的論證類型（`ibis`、唯讀可用；不含捨棄的支線；內容是 200 字摘錄；最多 500 筆，超過時 `truncated`，B15） |
| GET | `/open-loops?root=&staleDays=` | 未完成清單（`open_loops`） |
| POST | `/lines/{id}/diverge`、`/diverge/models` | 發散：AI 提方向（job）/ 指定 2–5 個模型立刻開平行支線（`diverge`，B14） |
| GET | `/search?q=&limit=&archived=&root=` | 搜尋標題、支線目的與訊息（`search` 功能）→ `{query, hits}`；每一類只排序最新 200 筆符合的候選；`root` 只搜那棵樹（B14） |

功能模組的路由只有在該功能開啟時才掛上；功能被 `FeaturePolicy` 對某租戶關閉時回 `404 feature_disabled`。

```go
httpapi.New(httpapi.Config{
    Engine     *tangent.Engine,
    Dispatcher tangent.Dispatcher,
    Scope      func(*http.Request) (tangent.Scope, error), // 宿主的認證在這裡
    CanWrite   func(*http.Request) bool,                  // nil = 都可寫
    Hub        *httpapi.Hub,                              // nil = 不掛 /events
}) http.Handler
```

## 8. Web UI（`web/`）

pnpm workspace，技術棧為 React 19、TanStack Query 5、zustand 5、@base-ui/react、Tailwind 4、lucide-react，
便於各宿主服務直接嵌入元件。

- `@tangent/client`：TS 型別（對應 §6、§7 的 JSON）、fetch client（baseUrl + headers 掛勾）、SSE 訂閱、
  純邏輯（branch-tree、branch-map-layout、layered-layout、chapters、card 驗證、錯誤碼對應）。不依賴 React。
- `@tangent/react`：Query hooks（query key 含 baseUrl 與 tenant）、zustand 只放 UI 狀態、元件（訊息列表、輸入框、
  支線大綱與樹狀圖、建立支線、結論卡返回、promote / move、筆記、章節）。i18n 用 `TangentProvider messages={...}`，
  內建 en 與 zh-TW。樣式用 CSS 變數 token，不寫死顏色。
- `apps/demo`：參考 UI。左：對話列表；中：對話；右：支線大綱 / 樹狀圖 / 筆記 / 章節。dev port 5183，`/api` proxy 到 8120。

元件涵蓋 branch-* / chapter-* / aside-* / notes 等對話分支介面，不含宿主專屬的 terminal、diff 或 workspace 路由。

## 9. 宿主整合對應表

| 宿主端概念 | tangent |
|---|---|
| 宿主對話（session） | `tangent_line`（id 可沿用）；執行環境欄位留在宿主自己的表 |
| 宿主訊息 | `tangent_message`（`user` / `assistant` / `system`，依 `seq` 排序；citations / attachments → `host_meta`） |
| 支線 / 紀要 / 章節切點 | `tangent_branch` / `tangent_note` / `tangent_chapter_cut` |
| workspace / 租戶 ID | `tenant_id`（UUID 字串） |
| 佇列派送與遠端執行器 | `httpapi.Config.TxOptions` 的 `InTx` 掛勾在 `turns.send` / `turns.retry` 同一交易寫入只帶 turn id 的指令；worker 認領時用 `Engine.LoadTurn` 重建；`DispatchTurn` 只負責喚醒；`turns.cancel` 的掛勾寫取消命令 |
| 自訂 prompt 區塊（plan / blackboard 等） | `PromptContributor` |
| 執行器離線檢查 | `TurnGate` |
| SSE 宿主事件轉發 | `Publisher` 轉成宿主事件名 |

## 10. 開發環境

- Postgres：`docker compose up -d`（`tangent-postgres`，port **5444**，db `tangent` 與 `tangent_test`）。
- 測試：`tangenttest.Open(t)` 每個測試建一個乾淨 schema 並跑完 migration；連不到資料庫就 skip 並說明。
  `TANGENT_TEST_DATABASE_URL` 可覆寫，預設 `postgres://tangent:tangent@localhost:5444/tangent_test?sslmode=disable`。
- 參考伺服器 port **8120**，Web dev port **5183**。
- sqlc：`make sqlc`。

## 11. 功能模組

核心之外的功能都是**內建、可選**的模組，嵌入時用 `WithFeatures` 挑選，沒選的功能不會被呼叫、路由不會掛上。
功能清單與各功能規格見 `docs/design/EXTENSIONS.md`。

```go
eng, err := tangent.New(pool,
    tangent.WithFeatures(
        tangent.Notes(),
        tangent.Chapters(),
        tangent.Summary(tangent.ModeAuto, tangent.JobModel("anthropic", "claude-haiku-4-5")),
        tangent.CardDraft(tangent.ModeManual),
        tangent.Leaf(tangent.ModeSuggest),
        tangent.Memory(tangent.MemoryConfig{Embedder: myEmbedder}),
    ),
    tangent.WithFeaturePolicy(myPolicy),
)
```

**核心（不能關）**：line、message、turn 協定、建立支線、結論卡 merge / discard、promote、move、背景包、
封存與刪除、`tangent_job`、`PreviewTurn`、prompt 快取友善的排序。

**規則**
1. **封閉集合**：功能模組都在本 repo 內建（`feature_<name>.go` + 對應 store 檔），不開放第三方模組。
   宿主要擴充，用既有的掛勾：`PromptContributor`、`TurnGate`、`Publisher`、`InTx`。
2. **依賴**：每個功能宣告 `Requires()`；`New()` 檢查，缺依賴或設定不合法（例如 Memory 沒給 Embedder）直接回錯。
3. **模式**：用到 AI 的功能有四種模式 `ModeOff / ModeManual / ModeSuggest / ModeAuto`
   （關閉 / 使用者按了才做 / AI 提出、使用者確認 / AI 直接做）。不用 AI 的功能只有開或關。
4. **內部擴充點**：Engine 在固定位置呼叫已啟用功能註冊的掛勾，核心程式碼裡不寫 `if feature enabled`：
   | 擴充點 | 時機 | 在交易內 |
   |---|---|---|
   | `ContextProvider` | 組 prompt 時，提供 section 並參與 token 預算分配 | 否（讀取） |
   | `HistorySelector` | 取代預設的「最近訊息」挑選（魚眼脈絡用）；最多一個功能可以註冊 | 否 |
   | `historyRewriter`（內部） | 在 `HistorySelector` 之前改寫歷史（折疊用） | 否 |
   | `OnTurnCompleted` | `CompleteTurn` 寫入後 | 是 |
   | `OnBranchCreated` / `OnBranchClosed` | 建立 / merge / discard / promote 後 | 是 |
   | `AfterCommit` | 上述交易 commit 後，用來派發 Job、發事件 | 否 |
   | `JobHandler(kind)` | `FinishJob` 依 kind 交給功能處理 | 是 |
   同一擴充點有多個功能時，依 `WithFeatures` 的順序執行；任何一個在交易內回錯就整筆 rollback。
5. **資料表**：一般功能的資料表一律由核心 migration 建立（空表沒有成本，之後開功能不用跑 migration）。
   需要資料庫擴充的功能（Memory 需要 pgvector）另附一組 migration，`store.MigrateFeatures(...)` 只在開啟時執行。
6. **執行期政策**：`FeaturePolicy.Mode(ctx, scope, feature) Mode` 可以依租戶或對話**收窄**設定（只能關或降級，不能打開沒設定的功能）。
7. **關閉後的資料**：資料保留不刪；讀取回 `feature_disabled`，prompt 不再帶入。重新打開就恢復。
8. **對外可見**：`Engine.Capabilities(scope)` 與 `GET /capabilities` 回傳已開啟的功能與模式；Web 元件依此顯示。

## 12. 決定紀錄

> 這一節是**目前有效的決定**，依主題分組。每一條是目前的結論，「來源」是原始紀錄列的日期與標籤（標籤 = 原列開頭括號裡的字，例如「F2 問題」「原型審查」）。
> 被推翻的決定不列；被修改的只列修改後的結果。依時間的完整原始紀錄（2026-10-15 到 2026-10-18 共 131 列，原文不改）在
> [`docs/design/DECISIONS_LOG.md`](design/DECISIONS_LOG.md)；舊文件說的「§12 的 F2 列」「原型審查列」「§12 最新列」指的是那裡的列。
> 哪些列被判定推翻、怎麼分組，見 `docs/devlog/D2-decisions.md`。
>
> 標 **待確認** 的條目：可能已被後來的決定或實作推翻，但沒有對應的決定列，暫時照原列保留；協調者確認後改寫或刪除。（D2 的四條已在 2026-10-22 確認，見 12.10。）
>
> **新的決定**加在本節最後的「新增決定」表（同原格式：日期 + 內容），同一次修改也追加到 `DECISIONS_LOG.md` 表尾。
> 協調者定期（例如每個步驟收尾時）把「新增決定」併入上面的分組，併入後從「新增決定」表移除；`DECISIONS_LOG.md` 只追加、不改舊列。

### 12.1 資料、交易與不變條件

| 決定 | 來源 |
|---|---|
| line 保留累計 token 與費用（`input_tokens`、`output_tokens`、`cost_usd`）；`LineView` 帶累計用量 `usage{inputTokens, outputTokens, costUsd}` | 2026-10-15；2026-10-15 F0 |
| `CreateBranch` 的背景包在鎖外建好再傳入；交易內只重新驗證 anchor 仍在父線（anchor 之前的訊息不會被搬走而 anchor 留下） | 2026-10-15 |
| 已封存的主線（含其支線）拒絕新的 turn 與新支線（錯誤碼 `archived`）；解除封存後才能繼續 | 2026-10-15 |
| store 回傳受影響的 id 與最少資料；Engine 在 commit 之後重新讀取需要的 view 再發事件 | 2026-10-15 |
| 合併支線時，被合併支線底下開放中的直接子支線改掛到新支線（depth 不變，超過開放上限回 `branch_limit` 整筆回滾），回應帶 `reparented`；改掛的子支線保留原本的 `anchorMessageId`（在已結束的舊支線上）——§5「anchor 是父線上已完成的訊息」只在建立時成立，改掛是唯一例外 | 2026-10-17 B9.1 |
| 資料表：P1 的都走核心 migration（006 階段 A、007 階段 B），P2 的走核心 migration（009 起），`ibis`、`fold`、`diverge` 走核心 migration（012 起）；需要資料庫擴充的 `search`、`memory`（需要 `vector`）用功能專屬 migration | 2026-10-16 B8；2026-10-16 B9；2026-10-17 B10 |
| `store.MigrateDown` 只要回退任何核心步驟，就先回退所有已套用的功能 migration（功能 migration 建在核心表上） | 2026-10-16 R4 |
| 功能需要的擴充裝在連線 `search_path` 的第一個 schema（同 tangent 的資料表）；要放共用 schema 的宿主事先自己安裝 | 2026-10-16 R4 |

### 12.2 回合協定、派發與 runner

| 決定 | 來源 |
|---|---|
| Dispatcher 簡化成 `DispatchTurn` + `DispatchJob`；草稿與摘要都是 Job，記在 `tangent_job` | 2026-10-15 |
| 接受的 API 調整：`Turn` 加 `Scope`、`RootLineID`；`CancelTurn` 回傳 `(CancelledTurn, error)`；`NewRunnerDispatcher` 回傳 `*RunnerDispatcher`（多 `Wait()`）；新增 `Engine.ListMessages`；job 的 prompt 放在 `UserMessage` 一段文字 | 2026-10-15 B3 階段一 |
| `FailStaleJobs(ctx)`：pending 超過該 kind 的逾時就標 failed，逾時用 store 的各 kind 預設值（card_draft 3 分鐘、summary 5 分鐘，可設定）；維護迴圈呼叫 | 2026-10-15；2026-10-15 B3 階段一 |
| 批次清理（`FailStaleTurns`、`FailStaleJobs`、`PurgeExpiredAsides`）不接受 TxHook | 2026-10-15 |
| `TurnGate` 在 `BeginTurn` 交易之前呼叫（建議性檢查，例如 daemon 在線），不放進交易 | 2026-10-15 |
| `CompleteTurn`、`AppendDelta`、`FinishJob` 只給執行端（runner / Dispatcher / 宿主佇列）使用，以 id 當憑證；httpapi 絕不把它們開放給客戶端 | 2026-10-15 |
| Dispatcher 不加跨程序取消掛勾；宿主自己的佇列監聽 `CancelTurn` 寫入的狀態或事件處理 | 2026-10-15 |
| `StreamSince` 回傳 `truncated`；為 true 時前端改為重新讀訊息 | 2026-10-15 |
| 進行中回合的訊息 `content` 是定期存下的部分文字（`WithPartialFlush`，記 `meta.streamSeq`，可能落後），即時文字在 `/stream` 與 `message.delta`；完成或取消時寫入全文 | 2026-10-15；2026-10-22 D2 確認（B4.2 的實作） |
| 串流的 delta 要過濾 `[BRANCH-SUGGEST]` 行（逐行緩衝，標記行不送出），完成時照舊解析成建議 | 2026-10-15 |
| 新增 `POST /lines/{id}/retry`（`Engine.RetryTurn`）：重跑最後一個失敗的回合，不重複使用者訊息；失敗的助理訊息保留為 error 且不進 prompt | 2026-10-15 B4.1 |
| runner 只對 429 / 5xx 自動重試（Anthropic 另外重試 529）；`Retry-After` 超過上限就不等；重試時發 `turn.retrying{turnId, attempt, maxAttempts, nextRetryAt}` 事件，其他錯誤直接失敗並可手動重試 | 2026-10-15 設計稿回饋 12；2026-10-15 B4.1 確認 |
| `RunRequest` 分成穩定與變動兩段 system（`SystemBlocks`），Anthropic 的快取只蓋穩定段 | 2026-10-15 B4 問題 |
| OpenAI runner 對 o 系列與 gpt-5 系列自動改用 `max_completion_tokens`，並可用選項覆寫 | 2026-10-15 B4 問題 |

### 12.3 Prompt 組裝與 token 預算

| 決定 | 來源 |
|---|---|
| prompt 區塊順序固定為：規則 → 背景包（獨立出來的新對話是起始膠囊，同一個位置）→ 紀要 → 宿主區塊 → 摘要 → 結論卡通知 → 最近歷史（越後面越常變）。不快取的尾段依序是：卡片通知 → 宿主尾段區塊 → 其他支線的結論 → 記憶 → 名詞表（`glossary`）→ 回覆行規則（`reply_lines`）。`goal`（目標）區塊在規則之後、背景包之前（屬於穩定段） | 2026-10-15；2026-10-16 B8 階段 B；2026-10-18 B7.1；2026-10-22 D2 確認（B9 的實作）；2026-11-13 B24 |
| 沒有摘要時，一輪最多讀 `Limits.HistoryScan`（`domain.Limits` 的頂層欄位，預設 200）則歷史；超過就該跑摘要 | 2026-10-15（兩列） |
| Engine 組 prompt 時一律帶 `SummaryUptoSeq`，摘要取代它涵蓋的歷史 | 2026-10-15 |
| 摘要游標停在第一則「未送達的結論卡」之前，卡片送達前不會被摘要吞掉 | 2026-10-15 |
| 摘要 prompt 的用語改成一般對話（不再寫 coding session），標記名稱沿用 `[SESSION-SUMMARY]` | 2026-10-15 |
| 多個 `ContextProvider` 共用一個 token 預算的分配器：`Limits.Context.TokenBudget` 預設 40,000；先固定區塊（背景包、膠囊、卡片通知），再依 `WithFeatures` 順序的 ContextProvider、宿主區塊，最後歷史（至多 24,000）；份額用前後估算量測；`PreviewTurn` 回 `budget`；宿主區塊不另外豁免 | 2026-10-15 B3 階段二；2026-10-16 B9 階段 B |
| 起始膠囊 `origin_capsule` 是核心 prompt 區塊（背景包的位置，不可改，預設上限 6,000 token），獨立功能之後關掉也照樣帶入；`copyNotes` 複製的紀要帶 `copiedFromNoteId` | 2026-10-16 B8 階段 B |
| `domain.PromptSection.Trailing`：宿主區塊標 `Trailing` 時放在不快取的尾段，預設維持在穩定前段；仍計入 `host` 預算；每輪變動的宿主資料（如 plan / blackboard）應標 `Trailing` | 2026-10-18 B7.1 |

### 12.4 事件與即時通道

| 決定 | 來源 |
|---|---|
| 前端 SSE 用 fetch + ReadableStream 解析（不用 `EventSource`），這樣 `headers()` 掛勾也能帶認證；httpapi 的 `/events` 不另外支援 query token | 2026-10-15 |
| `MarkRead` 之後對祖先線（深度上限內）也發 `line.updated`，因為未讀彙總會變 | 2026-10-15 |
| SSE hub 丟掉慢客戶端的事件時，送出 `stream.lagged`，前端收到就重新讀取；「持續落後」= 連續落後超過 `WithMaxLag`（預設 30 秒）才斷開 | 2026-10-15 B4 問題；2026-10-15 B4.1 確認 |
| 背景 job（`goal_propose`、`drift_check`、`relation_suggest` 及之後的）失敗時發通用事件 `job.failed {jobId, kind, lineId, rootLineId, error}`；`job.failed.error` 是 `{code, message}` | 2026-10-17 F5 階段 1 缺口；2026-10-17 B9 階段 C |

### 12.5 HTTP API 與參考伺服器

| 決定 | 來源 |
|---|---|
| `/capabilities` 每項為 `{name, enabled, mode?}`；`mode` 只出現在用到 AI 的功能（`card_draft` 只有開 / 關）；另帶 `permissions{canWrite}` 與允許的 provider / model；建議匣列為 `{name: "suggestions", enabled}`（見 12.6） | 2026-10-15；2026-10-15 B3 階段二；2026-10-15 B4.1；2026-10-15 F2 問題；2026-10-16 B8 階段 A |
| notes / chapters 的回應帶上限資訊，`/notes` 的上限另有 `tokenBudget`；merge 對卡片欄位進行嚴格驗證 | 2026-10-15；2026-10-16 F3 問題 |
| `LineView` 彙總有 `awaitingReview`（結論卡草稿已就緒待審的支線數）；「等你」= 有未讀或待審 | 2026-10-15 原型審查 |
| `GET /lines/{id}/branches` 一律回傳整棵樹的大綱（傳入支線 id 也解析到根） | 2026-10-15 |
| 接受的差異：`httpapi.New` 回 `(http.Handler, error)`；客戶端不能寫 `hostMeta`（400）；`promote` 需要 `{confirm:true}`；唯讀身分可呼叫 `/preview`；path id 格式錯回該資源的 404；功能輸入在功能關閉時回 404 `feature_disabled`；`RunResult.Model`、`Usage` 快取兩欄；`WithPricing` 以 model 名稱比對、估價只算輸入；回應形狀以 `httpapi/testdata/contract/` 為準 | 2026-10-15 B4 |
| httpapi 新增錯誤碼：`unauthorized` 401、`forbidden` 403、`payload_too_large` 413、`not_found` 404、`unavailable` 503、`internal` 500、`rate_limited` 429（+`Retry-After`）；`httpapi.StatusOf` 匯出 | 2026-10-15 B4 |
| 欄位上限：標題 200、provider / model 100、訊息內容可設定（預設 32k），超過回 422 `too_long{field,max}`；請求本文必須是 `application/json`（415） | 2026-10-15 B4.1 |
| `TANGENT_ALLOWED_MODELS` 限制可選模型；沒設時只允許已設定的模型；沒指定 provider / model 的新線用伺服器預設值；fake provider 建立的線預設 model `fake-1` | 2026-10-15 B4.1；2026-10-15 B4.1 確認；2026-10-16 F3 問題 |
| dispatcher 佇列有上限（預設 64，滿了回 503）；每個租戶的 pending 回合有上限；SSE 連線數有上限 | 2026-10-15 B4.1 |
| 參考伺服器支援 `TANGENT_JOB_MODEL`（摘要、起草等背景工作用較便宜的模型）與 `TANGENT_VIEWER_TOKEN`（唯讀身分） | 2026-10-15 B4 問題 |
| B5 補的契約：`POST /lines/{id}/branches/preview` 預覽新支線的背景（含 token）；結論卡草稿在 `notes` 開啟時提出紀要變更；結論卡送達時對卡片本身發 `message.updated`；起草的 202 回傳 provider / model；`PATCH /lines/{id}/branch` 可改支線目的 | 2026-10-15 F2 問題；2026-10-16 F2 階段二 |
| 參考伺服器的預設：`search` 開啟；`fisheye` 關閉；`memory` 不開（要 `memory:<mode>` + `TANGENT_EMBEDDER`）。B25：`TANGENT_FEATURES` 可用預設組 `essential` / `standard` / `full`（沒設 = `standard`，見 12.10 B25） | 2026-10-16 B5 問題；2026-10-16 B9；2026-10-16 B9 階段 B；2026-10-18 B10 階段 C；2026-11-13 B25 |

### 12.6 功能模組

**通用**

| 決定 | 來源 |
|---|---|
| 功能模組採內建封閉集合 + 選項開關（§11），使用者確認 | 2026-10-15 |
| 功能模式只由宿主設定，使用者不能自己改；設定頁維持唯讀顯示 | 2026-10-16 F3 問題 |
| 順口問的清除依設定，不依每個租戶的 `FeaturePolicy`；`card_draft` 只有開 / 關（何時起草由客戶端呼叫 `StartDraft` 決定）；`branch_suggest` 的 auto 等同 suggest | 2026-10-15 B3 階段二 |
| `AllFeatures()` 不含 `search`（需要資料庫擴充，要宿主明確開啟），也不含 `memory` | 2026-10-16 B5 問題；2026-10-17 B10 |
| 章節的話題切點由後端 `summary` 模組產生，mock 不模擬，不算缺口 | 2026-10-16 F2 階段二 |

**搜尋（`search`）**

| 決定 | 來源 |
|---|---|
| `archived=true` 只搜封存的樹（同 `/lines`）；前端開「包含封存」時發兩次請求並合併 | 2026-10-16 B5 |
| 搜尋每一類（標題、支線目的、訊息）只排序最新 200 筆符合的候選；更舊的符合只有在較新的符合少於 200 筆時才會出現（成本上限，接受） | 2026-10-16 R4 |
| 搜尋高亮的位移用 UTF-16（對應 JavaScript 字串） | 2026-10-16 B5 問題 |

**紀要（`notes`）**

| 決定 | 來源 |
|---|---|
| 紀要條目有 `sourceLabel`（寫入時存來源文字快照），來源支線被清除後仍可顯示；文字用伺服器語言（宿主用 `WithNoteSourceLabels` 設定） | 2026-10-15 原型審查；2026-10-16 B8 階段 A；2026-10-16 F4 問題 |
| 「完成」只用在待辦；待確認的事確認後應「取代」成已確認的事實，不是標完成。取代可以換區塊：原本在「待確認」的預設取代成「已確認的事實」，其他區塊預設不換 | 2026-10-16 F3 問題；2026-10-16 R5 |

**建議匣**

| 決定 | 來源 |
|---|---|
| 同一對象（`target_key`）同時最多一筆 open；dismiss 後冷卻預設 7 天，功能可宣告永久不再提；建議不自動執行；對象消失時變 expired | 2026-10-16 B8 |
| 建議匣不是功能：有功能註冊建議種類才存在，`/capabilities` 列為 `{name: "suggestions", enabled}`；過期在交易內做，維護工作 `suggestions.expire` 補漏；冷卻與種子上限在 `domain.Limits` | 2026-10-16 B8 階段 A |
| `LineView` 加 `openSuggestions`、`openSeeds`（主線）；`openSuggestions` 只算目前開著的功能提出的；建議匣計數依呼叫者開著的功能過濾（`store.WithInboxFeatures`），沒有 scope 的背景清理事件仍全算 | 2026-10-16 B8 階段 A；2026-10-16 B8 階段 B |
| 建議匣加 `Asked`：使用者按了才提的建議不受冷卻 | 2026-10-16 B9 階段 A |
| `SuggestionProbe()` 匯出但不在功能清單，只給測試、smoke 與 e2e 產生建議 | 2026-10-16 B8 階段 A |

**收尾（`leaf`）**

| 決定 | 來源 |
|---|---|
| 收尾只屬於支線（含 `previous_main_line`）；merge 由結論卡產生 `conclusion`（不用 AI）；discard 可帶 `dead_end` 原因；收尾不進 prompt（只經 fisheye） | 2026-10-16 B8 |
| `BranchView` 加 `leaf`；`GET /leaf` 沒有收尾回 `{leaf: null}`；`DELETE /leaf` 回 204；`POST /branch/discard` 可帶 `{leaf}`（預設 `dead_end`）；收尾的 AI 標記是 `aiDrafted`；答完的順口問不自動起草收尾 | 2026-10-16 B8 階段 A |
| `leaf_draft` 失敗時發 `leaf.changed` 並帶 `draftError {code, message}` | 2026-10-16 F4 問題，B8.1 |
| `dead_end` 的預設收尾文字用伺服器語言（`WithLeafTexts`，預設繁中，可設定） | 2026-10-18 B10 階段 C |

**停車場（`parking`）**

| 決定 | 來源 |
|---|---|
| 種子展開成支線的 `origin` = `seed`；記進紀要預設「待確認」 | 2026-10-16 B8 |
| 種子展開時 anchor 所在的線已結束 → 沿分岔點往上找最近的進行中祖先線，在它的分岔點展開（主線一定可用） | 2026-10-16 B8 階段 A |
| `Seed` 加 `anchorLineId` 與 `sourceLabel`（同紀要的規則）；`GET /seeds` 回 `limits`（同 `/notes`） | 2026-10-16 F4 問題，B8.1 |

**獨立成新對話（`spinoff`）**

| 決定 | 來源 |
|---|---|
| 新主線的 `LineView` 帶 `spunOffFrom{lineId, messageId, title}`；「已獨立 →」放在原線結尾的標記訊息 `meta.spunOffTo`（seq 不能插在中間），分岔訊息 id 在其中與 `link.fromMessageId`；`spunOffFrom` / `spunOffTo` 加 `available` | 2026-10-15 設計稿回饋 11；2026-10-16 B8 階段 B；2026-10-16 B8.2 |
| detach 只限進行中的支線（已結束的回 `branch_closed`，改用 `fresh`）；支線本身的收尾併入起始膠囊後刪除（主線沒有收尾） | 2026-10-16 B8 階段 B |
| detach 時：子樹內的收尾與建議跟著移到新樹；anchor 在被搬走子樹內的種子跟著移動，其他種子留在原樹 | 2026-10-16 B8 階段 B |
| `POST /lines/{id}/spinoff/preview` 預覽起始膠囊（不寫入） | 2026-10-16 B8.2 |
| `/links` 在 `spinoff` 或 `relations` 任一開啟時掛上 | 2026-10-16 B9 |

**樹平衡（`rebalance`）**

| 決定 | 來源 |
|---|---|
| 預設門檻：支線分岔後 ≥ 6 輪且 ≥ 父線分岔後的 2 倍，或最近 5 輪都在這條支線；「維持」= 對這條支線永久不再提；`ModeAuto` 等同 suggest | 2026-10-16 B8 |
| 只檢查支線的回合；建議 payload 只列當下可做的動作（payload 另有 `parentIsMain`、`parentTitle`）；已有 open 或永久拒絕的支線每輪多一次被擋下的提出（約 1 ms），不另做記憶體快取 | 2026-10-16 B8 階段 B；2026-10-16 B8.2 |

**P2：釘選、目標與偏題、關聯、未完成清單**

| 決定 | 來源 |
|---|---|
| 釘選是核心（不需要功能），`Message.pinned` | 2026-10-16 B9 階段 A |
| 使用者用 PUT 設定目標時，open 的 `goal_propose` 建議變 expired；偏題偵測只看主線，預設每 4 輪一次；獨立出去的新對話不繼承目標 | 2026-10-16 B9；2026-10-16 B9 階段 A |
| `relations` 的 auto 等同 suggest；刪除關聯線用 `DELETE /lines/{id}/relations/{rid}`；`PATCH /lines/{id}/relations/{rid}` 改說明 | 2026-10-16 B9 階段 A；2026-10-17 F5 階段 1 缺口 |
| 「開太久的支線」= 進行中且 `last_activity_at` 超過 N 天（預設 3）；`LineView.staleBranches` 加進「待處理」數（= `openSeeds` + `openSuggestions` + `staleBranches`） | 2026-10-15 原型審查；2026-10-16 B9；2026-10-16 B9 階段 A |

**P2：魚眼脈絡（`fisheye`）、群組與合併（`group`）**

| 決定 | 來源 |
|---|---|
| 魚眼程度與分數由後端在組 prompt 時決定：訊息 full / summary / hidden，支線 leaf_only / hidden（至多 20 條）；最新一則一定原文；`PreviewTurn` 逐項回傳（`fisheye.items`），前端只顯示 | 2026-10-15 設計稿回饋 9；2026-10-16 B9 階段 B |
| 「其他支線的結論」區塊放在不快取的尾段，短的線也保留；祖先線分岔後的訊息不納入（背景包不變） | 2026-10-16 B9 階段 B |
| fisheye 對已確認的 `decision` 標記 +4；群組的魚眼程度覆蓋成員 | 2026-10-17 B10 階段 B；2026-10-17 F5 階段 3 |
| 合併支線不新增狀態：被合併的支線為 `discarded` + `mergedIntoLineId`，前端據此顯示「已合併到…」 | 2026-10-15 設計稿回饋 10 |
| 合併支線請求帶每個矛盾項的選擇 `adoptBranch / adoptOther / keepBoth`；`keepBoth` 寫入紀要「待確認」 | 2026-10-15 原型審查 |
| 群組只收同一棵樹已結束的支線（2–12 條，含 `previous_main_line`），合併只收同一父線下開放中的兄弟支線；群組只經 fisheye 進 prompt；建立群組即起草摘要；detach 帶走成員時解散群組 | 2026-10-17 B9 階段 C |
| 沒有 Embedder 前 `group` 分群一律用便宜模型 | 2026-10-16 B9 |

**P3：論證類型（`ibis`）、折疊（`fold`）、發散收斂（`diverge`）**

| 決定 | 來源 |
|---|---|
| `ibis`：suggest 寫成 `draft`（AI 待確認，不進建議匣）、auto 寫成 `confirmed`，AI 只補沒有標記的訊息；大綱用 `BranchView.anchorTag`（分岔那則的標記）；結論卡不能標 | 2026-10-17 B10 階段 A |
| `ibis_tag` 每 3 則回覆一次（`Limits`）；`goal` / `ibis` / `fold` 每次 commit 共用一次回覆計數 | 2026-10-17 B10 階段 B |
| `fold`：同一條線不重疊，經新的內部擴充點在 `HistorySelector` 之前改寫歷史（fisheye 把一段折疊當一個 `kind: fold` 項目）；只套用在該線自己的 prompt（背景包、滾動摘要、起始膠囊不受影響）；move 拆開折疊時變 `removed`；`fold_suggest` 用章節切點（不需要 `chapters` 開啟） | 2026-10-17 B10 階段 A |
| `tangent_fold` 有 `tokens_original`、`tokens_summary`；`PATCH /folds/{fid}` 改摘要後 `aiDrafted: false`、進行中的起草 job 不再覆蓋 | 2026-10-15 原型審查；2026-10-17 B10 階段 B |
| `diverge`（需要 `leaf`，只在使用者要求時執行）：發散的 N 條支線一個交易全開或全不開；收斂只收開放中的支線，比較表存在父線下；比較表分數不可編輯；發散開的、決定關掉的支線不跑功能的支線掛勾 | 2026-10-17 B10 階段 B |
| `POST /comparisons/{cid}/decide` 一個交易：選定支線 `decision` 收尾並保持開放，其他開放中的被比較支線 discarded + `dead_end` 收尾 | 2026-10-15 原型審查；2026-10-17 B10 階段 B |

**P3：跨對話記憶（`memory`）**

| 決定 | 來源 |
|---|---|
| `memory` 需要 `notes` 與 Embedder；功能專屬 migration，`vector` 不固定維度、以 `embedding_dim` 區分，無 ANN 索引，不提供 HNSW 選項 | 2026-10-18 B10 階段 C（兩列） |
| 記憶屬於租戶、只取代不刪除；suggest 進建議匣、auto 直接寫、manual 不萃取；沒有來源線的記憶不整併 | 2026-10-18 B10 階段 C（兩列） |
| 召回 = 相似度 × 近期（半衰期 30 天）× 重要性，門檻 0.30、前 5 筆、1500 token（暫定，有真 embedder 後校準）；每輪召回放在不快取的尾段 | 2026-10-18 B10 階段 C |
| 記憶只在開新對話與開支線時主動提示（由前端呼叫 `POST /memories/search`）；每輪自動帶入的記憶只在 `PreviewTurn` 裡看得到 | 2026-10-15 設計稿回饋 13；2026-10-18 B10 階段 C |
| Embedder 失敗回 `503 embedder_unavailable` | 2026-10-18 B10 階段 C |
| 開新對話時「帶入」記憶 = 在草稿開頭放一段可見的文字；開支線勾選的記憶併入摘錄；「帶入」不做成伺服器概念（候選）；`GET /memories` 需要 cursor 或「目前 + 歷史」查詢（列為 B10.1 候選；cursor 已在 B10.1 做了，見 §12.10） | 2026-10-18 F6 階段 3 |

### 12.7 Web 前端

| 決定 | 來源 |
|---|---|
| 前端 CSS 變數一律加 `--tg-` 前綴，嵌入其他 app 時不會撞名 | 2026-10-15 |
| 介面用語以 `UI_DESIGN_BRIEF.md` §3 為準：notes 一律叫「紀要」（W0 留下的「筆記」改掉） | 2026-10-15 F0 |
| 宿主自訂的錯誤碼前端顯示伺服器回傳的文字；宿主要翻譯就在 `TangentProvider messages` 補 key | 2026-10-15 |
| 前端事件型別有 `turn.retrying` | 2026-10-15 F0 |
| 「待處理」分頁只在 P1 以上的功能（parking、建議匣、open_loops）開啟時出現 | 2026-10-15 F0 |
| 手機切換對話：頂端左側的選單鈕打開對話清單抽屜（設計稿未定義，先照此實作） | 2026-10-15 F0 |
| 分岔點膠囊的 `onOpen` 接上內嵌清單與進入支線；接受 AI 建議時開支線對話框並帶 `suggestionMessageId` | 2026-10-15 F1 問題 |
| 送出前預覽：桌機是對話旁的固定欄（不蓋住對話，偏離原型的浮層，接受），手機維持全螢幕 | 2026-10-15 F1 問題；2026-10-16 F2 階段二 |
| Base UI Select 的 `aria-hidden-focus`：本地繞過並記錄，不向上游回報 | 2026-10-15 F1 問題；2026-10-22 D2 確認（`docs/HANDOFF.md` §2 的使用者決定） |
| 搬移後停在來源線並高亮標記；結論卡的「問題」欄位維持必填（伺服器要求）；沒有紀要提案時隱藏「依勾選帶回」 | 2026-10-15 F2 問題 |
| 地圖懶載入；地圖有圖層篩選與群組外框。死路支線的邊不用虛線（虛線保留給關聯與待確認，見下一條） | 2026-10-16 F2 階段二；2026-10-22 D2 確認（F5 階段 3） |
| 地圖群組外框用實線（虛線保留給關聯與待確認）、群組名稱在摘要框裡；群組圖層與關聯圖層同時開時同欄關聯的弧線較擠，暫時接受 | 2026-10-17 F5 階段 3 |
| 搜尋介面放在對話清單的搜尋框：`search` 開啟時改用伺服器搜尋（標題、支線目的、訊息內容與摘錄），關閉時維持本機標題搜尋 | 2026-10-16 F3 問題 |
| 結論卡與搬移標記內的選取可以記進紀要（來源是那則訊息），不能開支線；⌘⇧N 只有沒選取時才存最後一則回覆，選取無法使用時不存並提示 | 2026-10-16 R5 |
| ⌘B 同一規則：只有沒選取時才從最後一則開支線；選取在結論卡或搬移標記內、或跨訊息時不開並提示 | 2026-10-16 R5 |
| 建議的呈現由前端依已知的 `feature` + `kind` 決定，不認得的種類顯示通用卡片；後端不加通用標題；答完的順口問不顯示收尾編輯 | 2026-10-16 F4 問題 |
| 「從這裡開新對話」只在 AI 回覆上；順口問沒有「獨立成新對話」；升為主線與獨立一律經確認對話框，維持立即生效 | 2026-10-16 F4 階段 2 |
| 回顧的「暫存」v1 只存在瀏覽器（同「新」標記），後端不存 | 2026-10-16 B9 階段 A |
| i18n 依語言載入：zh-TW 字典獨立成 chunk，移除 `BUNDLED_MESSAGES`，改用 `loadLocale` / `registerLocale`（1.0 前的公開 API 變更，接受）；窄寬度的目標顯示成圖示（不隱藏）；結論卡暫不提供釘選 | 2026-10-17 F5 階段 1 |

### 12.8 嵌入與宿主

| 決定 | 來源 |
|---|---|
| 宿主額外要清除的模型標記用 `WithExtraMarkers` 傳入（例如 `[NEEDS-INPUT]` 等宿主自訂標記） | 2026-10-15 |
| Engine 的 `TxHook` 直接沿用 store 的收窄介面（`store.Tx` + 寫入結果），不暴露 `pgx.Tx` | 2026-10-15 |
| `Engine` 有 `WithPricing(map[model]Price)`；`PreviewTurn` 有價格時回傳 `estimatedCostUsd`。費用門檻是前端偏好，宿主可預設或鎖定 | 2026-10-15 原型審查 |
| 宿主交易掛勾與跨行程支援在 tangent 內實作（httpapi 帶宿主交易掛勾與 `host_meta`、跨行程 worker、匯出組請求與取消查詢） | 2026-10-17 B7.0 |
| httpapi 的每條寫入路由經 `Config.TxOptions(r, op)` 帶宿主的交易掛勾（45 個穩定的 `httpapi.Op…`），四個帶 host_meta 的寫入經 `Config.HostMeta`；§9 的佇列指令在 `InTx` 寫、`LoadTurn` 重建、`DispatchTurn` 只喚醒 | 2026-10-17 B7.0 |
| `tangent.LinePatch` 加 `HostMeta`，`lines.update` 也詢問 `Config.HostMeta`（只新增） | 2026-10-17 B7.0 |
| 跨行程時只有 API 行程替 delta 編號：worker 用 `WithDeltaSink` 轉送原始 delta、用 `Engine.Observe` 同步記憶體；`ChatRequest` / `Turn.Request()` 保留快取斷點；`Engine.TurnPending` 給沒有事件通道的 worker 查取消；多個 API 行程需要共用序號來源，另議（目前一個 API 行程） | 2026-10-17 B7.0 |

### 12.9 測試、評估、開發環境與已接受的限制

| 決定 | 來源 |
|---|---|
| 開發資料庫（:5444）改用 `pgvector/pgvector:pg17`（沿用資料 volume，切換後 REINDEX）；`vector` 0.8.7 可用，memory 的功能 migration 照 search 的做法安裝 | 2026-10-17 |
| 沒有真模型 key 前 `tangent-eval` 只跑 token 比較：三組固定樣本總計省 45%（主線 60–64%，短支線 +4–5%），門檻看總和；品質評分未跑 | 2026-10-16 B9；2026-10-16 B9 階段 B |
| 沒有真模型 key 前用決定性的假 Embedder 測試，召回品質評估只跑流程 | 2026-10-17 B10 |
| 接受 promote 的成本隨被搬走的尾段長度成長（每則訊息一次更新，2,000 則約 100 ms），不改資料模型 | 2026-10-16 B5 問題 |
| 2 個字的冷門查詢在大型租戶約 90 ms，接受；之後有需要再評估 pg_bigm 選項 | 2026-10-16 B5 問題 |
| 建議 job 暫不節流（每次支線結束約 +12–15 ms） | 2026-10-17 B9 階段 C，待辦 |

### 12.10 新增決定

之後的新決定加在這張表（日期 + 內容），同時追加到 `docs/design/DECISIONS_LOG.md` 表尾；協調者定期併入上面的分組後從這裡移除。

| 日期 | 決定 |
|---|---|
| 2026-10-22 | （D2 確認）四條原本沒有決定列的現況寫成決定：進行中回合的 `content` 是定期存下的部分文字（`meta.streamSeq`）；`goal` 區塊在規則之後、背景包之前；Base UI Select 的問題不向上游回報；地圖死路支線的邊不用虛線 |
| 2026-10-23 | （B11）建議的失效除了 `line_id`，也看 payload 寫到的線（`fromLineId`、`toLineId`、`members[].lineId`；之後的功能在 payload 寫線時用同樣的欄位名）：離開樹就 `expired`、提案時在樹外就不提。`Engine.FinishJob` 在 handler 失敗而 job 已隨對話刪除時回 `job_not_found`。auto 的 AI 寫入遇到已封存的樹：略過並 WARN，job 照樣 done。記憶整併掃描途中一對的對話被刪：略過那一對。`scripts/soak.sh` 預設全功能（`SOAK_FEATURES=full`），伺服器日誌有 ERROR 就失敗 |
| 2026-10-23 | （B7.2）宿主系統訊息是 `role=system` + `kind=chat`（函式庫自己只寫卡片與標記），不加新 kind。寫法只有兩種：`TurnResult.Notices`（`CompleteTurn` 的同一個交易、在回覆之後）與 `Engine.AppendSystemMessage`（只鎖那條線，進行中的回合也可寫、排在 pending 之後；封存、已結束的支線拒絕）。宿主不得改寫 `tangent_message` 或改 seq。內容經 `domain.CleanSystemText`，上限 `Text.MessageMaxRunes`；`SkipRepeat` 在交易內跳過與最近一則相同的狀態。 |
| 2026-10-23 | （B7.2）宿主系統訊息進之後的 prompt 歷史（`system: …`），摘要、折疊、魚眼照一般訊息算；不算對話：不讓 `parentTipMessageId` 前進、不能當 anchor、不被搜尋，`RetryTurn` 判斷最後一輪時跳過它。 |
| 2026-10-23 | （B7.2）`httpapi.Config.DeltaFilter(r, lineID, delta)` 依讀者過濾 `/stream` 與 `/events` 的 `message.delta`（`turnId` / `seq` 不可改；`/events` 在訂閱者自己的 goroutine 上判斷；解不出 delta 的事件不給有過濾器的讀者）。部分文字、完成的內容、宿主的 Publisher、`hostMeta` 不在範圍內：只該給部分讀者的資料不放進 `text` delta、`Content` 或 `hostMeta`。事件 payload 不依讀者過濾（與 REST 一致）。 |
| 2026-10-25 | （B13）`memo` 備忘：寫在節點上、**不給 AI** 的筆記（不註冊 `ContextProvider`，不進 prompt、送出前預覽與任何 job；有測試）。表 `tangent_memo`（核心 migration 014）：`root_line_id` 隨對話 CASCADE，`line_id` ON DELETE SET NULL，`source_label` 是寫入時的節點名稱快照（紀要的規則，改名不影響），文字 1–4,000 字可多行；每棵樹 500 則（`409 memo_limit`）。寫入只鎖主線（不改線狀態），封存的對話拒絕寫入。看得到對話的人都看得到（同 REST，不依讀者過濾），不叫「私人」。獨立成新對話時不複製；detach 時寫在搬走的線上的備忘跟著搬到新對話（同種子與收尾）。事件 `memo.changed {rootLineId, memoId, change}`。新錯誤碼 `memo_not_found`、`memo_limit`。 |
| 2026-10-25 | （B13）已結束的支線可以改目的：`merged`、`discarded`（含合併到別的支線）；`promoted`（訊息已搬到主線、只剩空線）與「先前的主線」（介面用固定名稱）仍回 `409 branch_closed`；封存仍拒絕。改名不改寫歷史（訊息、結論卡內容、背景包、紀要／種子／備忘的 `sourceLabel`、獨立的膠囊、建議匣的文字、比較表的選項名都是快照）。**之後**讀目的的地方用新名字：父線之後每一輪的結論卡通知（`BranchPurposes`；尚未送達的卡片通知會和卡片內容的舊名不同）、魚眼、群組摘要、AI 的關聯與群組建議、收尾草稿；這是刻意的（改名就是要讓之後的討論用新名字），也會讓那一段的 prompt 快取失效。事件沿用 `branch.changed{renamed}`。 |
| 2026-10-25 | （B14）`GET /search?root=`：只搜一棵樹（主線 id；不是 UUID、不存在、別的租戶或是支線 → `404 line_not_found`），範圍是那棵樹的標題、支線目的與完成的 user / assistant 訊息（折疊起來的訊息照樣搜得到，因為折疊不改訊息），封存與否都搜（忽略 `archived`）；樹內不用全租戶的 4,000 則視窗，直接取這棵樹最新的 200 筆符合的候選。 |
| 2026-10-25 | （B14）`GET /lines/{id}/export` 是核心唯讀路由（不需要功能、唯讀身分可用）：`{id}` 是樹上任一條線，回整棵樹的主線、大綱（含岔題）、各線訊息與開著的功能資料；功能關著時那一部分是 `[]` / `null` / `{}`，不回 `feature_disabled`。每條線最多取最舊的 500 則（`ExportMaxMessagesPerLine`，同訊息分頁上限），任一條線超過時頂層 `truncated: true`；大綱到 500 條支線、比較表超過 500 筆時也是。store 的整棵樹查詢都另外以租戶過濾。每一部分一個查詢（不隨線數增加），各部分依序讀、不是同一個快照。 |
| 2026-10-25 | （B14）`POST /lines/{id}/diverge/models` 跨模型發散：指定 2–5 個 provider/model，在錨點上一個交易（鎖 主線 → 父線）立刻開出對應的平行 `alternative` 支線（`origin: diverge`），全開或全不開，不跑 job、不呼叫模型；數量不合格沿用 `CheckDivergeCount` 的 `400 invalid_input`，模型由宿主的 `WithModelCheck` 決定（`422 model_not_allowed`）。目的預設 `「{共用目的} · {model}」`，沒有共用目的時取錨點前 40 字（`defaultDivergePurposeRunes`）；太長時截前段、保留模型名稱。背景包附「平行回答」一段（新的 `domain.BuildDivergeTargetsNote`，不用講「AI 提出的方向」的 `BuildDivergeNote`）。和 job 開的發散一樣，交易內不跑功能的建立支線掛勾，commit 後跑 AfterCommit 掛勾；InTx 收到 `store.DivergedBranches`（`Job` 為零值）。 |
| 2026-10-25 | （B14）`POST /lines/{id}/seeds/batch` 一次停 1–20 顆種子（`domain.SeedBatchMax`）：一個交易、只鎖主線（同 `CreateSeed`，含 detach 的重新檢查），全建或全不建；open 種子上限算整批（`409 seed_limit`）；整批共用同一個 anchor 與來源標籤；只發一次 `seeds.changed` 與主線 `line.updated`。InTx 收到 `store.CreatedSeeds`。 |
| 2026-10-25 | （B15）關聯加上種類 `relation_kind`（migration 015，`tangent_link` 欄位 `NOT NULL DEFAULT 'related'`，CHECK 四種：`related`、`supports`、`contradicts`、`depends_on`）。JSON `Link.relationKind`：每一條關聯都有（舊資料是 `related`），spinoff 連結的欄位一樣是 `related` 但不輸出；所有讀 Link 的地方共用 `linkFromRow`，所以關聯清單、`/links`、匯出、`link.changed`、建議接受的結果一致。`domain.NormalizeRelationKind`：空字串 → `related`，其他值（大小寫有別）→ `400 invalid_input`（`field: relationKind`）。 |
| 2026-10-25 | （B15）`PATCH /lines/{id}/relations/{rid}` 改成 `{label?, relationKind?}`，沒給或 `null` 的欄位保留原值（之前沒給 `label` 等於清空）；`{}` 不是錯誤，照舊 `200` 並發 `link.changed`；沒有本文仍是 `400`。鎖與檢查同 B9（`lockRelation`，兩端的樹都不能封存），讀出現值後在鎖內寫回。為了不破壞嵌入者，Engine 保留 `UpdateRelation(label)`（保留種類），新增 `EditRelation(RelationEdit{Label, RelationKind *string})`；store 同樣保留 `UpdateRelationLabel`，新增 `UpdateRelation`。InTx 都收到 `store.RelationChange`。 |
| 2026-10-25 | （B15）`relation_suggest` 的回覆可以帶 `kind`（prompt 列出四種）；認不得或沒給 → `related`，不讓整個 job 失敗。建議的 payload 多 `relationKind`；接受的本文 `{label?, relationKind?}` 可以覆寫，接受時寫入種類。B15 之前提出的建議沒有這個欄位，接受時是 `related`。 |
| 2026-10-25 | （B15）`PUT /messages/{mid}/tag` 加 `status`：沒給、空字串或 `confirmed` = B10 的行為（`source: user, status: confirmed`）；`draft` = 改回待確認，寫成 `source: ai, status: draft`（`source_job_id` 清空，`updated_by` 是操作者），所以和 AI 標的草稿一視同仁（fisheye 不加分、AI 之後也不覆蓋它）；其他值 → `400 invalid_input`。`kind`、`source`、`status` 都相同時不寫、不發事件。Engine 保留 `TagMessage(kind)`，新增 `SetMessageTag(TagInput{Kind, Status})`；InTx 收到 `store.TaggedMessage`。 |
| 2026-10-25 | （B15）`GET /lines/{id}/tag-drafts`：`ibis` 功能的讀路由（唯讀可用，租戶檢查，樹上任一條線解析到主線，封存的樹也可讀）。一個查詢（`ListTreeTagDrafts`，主線加 `tangent_branch.root_line_id` 的線，依 `line_id` 索引）列出標記為草稿的完成 user / assistant 聊天訊息，主線在前、支線依大綱順序（`created_at, line_id`），線內依 `seq`；最多 `store.TagDraftsMax`（500），多查一筆判斷 `truncated`。回應 `{rootLineId, drafts[{lineId, messageId, seq, role, content, tag}], truncated}`。 |
| 2026-10-25 | （B15 審查）`PATCH /relations/{rid}` 的 `relationKind` 不接受空字串（含只有空白）→ `400 invalid_input`（`field: relationKind`）；建立時空字串仍是 `related`。domain 分成 `ParseRelationKind`（修改用）與 `NormalizeRelationKind`（建立用）。`relation_suggest` 的解析器放寬：轉小寫、`-` 與空白換成 `_` 再比對，認不得仍是 `related`。 |
| 2026-10-25 | （B15 審查）`GET /lines/{id}/tag-drafts` 的 `content` 是摘錄：最多 `domain.TagDraftContentRunes`（200）字，超過用 `CutRunes`（199 字加「…」），SQL 只讀 `left(content, 201)`。捨棄（`discarded`）支線上的草稿不列；`open`、`merged`、`promoted` 照列。 |
| 2026-10-26 | （B16）回覆末行的 `[TOPIC]{"title":…}` 是**核心**行為（不是模組；改名用的是核心的 `UpdateLine` / `RenameBranch`，不用額外的 AI 呼叫）：一條線的**第一輪**（prompt 沒有歷史、選取的歷史或摘要；不是順口問，也不是獨立出來帶膠囊的新對話）在下列情況要求主題要約：主線且使用者第一則訊息 > 20 字或主線沒有標題；支線（非 aside）且**目的** > 25 字（工單寫「問題或目的 > 25 字」，協調者改成只看目的：範本化的第一個問題通常就超過 25 字，而短而刻意的目的（如「了解：豪斯多夫維度」）不能被覆蓋）。`[TOPIC]` 與 `[CHAPTER]` 的規則**不放在穩定的規則區塊**，而是自己一個 prompt 區塊 `reply_lines`（`domain.SectionReplyLines`），排在不快取的尾段最後（卡片通知 → 宿主尾段 → 其他支線的結論 → 記憶 → `reply_lines`），續接的 session（`ResumeText`）也帶；規則出現或消失不會讓快取失效。兩種標記都在 `agentMarkers`：串流過濾整行、`StripAgentMarkers` 會拿掉；`CompleteTurn` 一律從成功的回覆拿掉這些行（`domain.ExtractTopicSummary` / `ExtractChapterCut`，第一個合格的 JSON 標題，`title` 壓成一行、`[TOPIC]` ≤ 36 字、`[CHAPTER]` ≤ `Chapters.TopicTitleMaxRunes`，不合格就當沒有）。標題只在**這個程序組這一輪 prompt 時有要**才用（記在記憶體的 turn 快取：`BeginTurn` / `RetryTurn` / `LoadTurn` 組 prompt 時寫入，連同 prompt 看到的主線標題或支線目的）；重啟後或別的程序才完成的回合只拿掉標記行（接受的限制）。改名在回合 commit 之後、AfterCommit 掛勾之前，先重讀線：**主線**若 prompt 看到的標題不是空的、而現在的標題不同（使用者在這一輪進行中改了名）就不改；prompt 看到的是空標題時照改（網頁在送出第一則訊息後立刻用訊息設一個暫時標題，`[TOPIC]` 要取代它）。**支線**現在的目的和 prompt 看到的不同就不改。要改時走跟手動改名一樣的路徑與事件：主線 `line.updated`（新 `title`），支線 `branch.changed{renamed}` + 支線的 `line.updated`；被拒只記 WARN，回合照樣完成。`CompletedTurn.Line` 是重讀或改名後的線。 |
| 2026-10-26 | （B16）`chapters` 的閒置切點 `Chapters.IdleGap` 預設從 2 小時改成 30 分鐘（`GET /chapters` 的 `limits.idleGapMinutes` 是 30）。`chapters` 開著時多註冊一個 `ContextProvider`：**只在主線**；先用既有的 `ReplyCount`（一個 count）擋掉完成的回覆少於 2 則的線，再讀 `ListChapters`：最後一章扣掉卡片與這一輪自己的使用者訊息後還有 ≥ 4 則完成的訊息（`domain.ChapterCutMinMessages`，兩輪問答）時，`PromptInput.AllowChapterCut` 把 `domain.ChapterCutRule` 放進 `reply_lines`。模型給了合格的 `[CHAPTER]` 時，AfterCommit 用既有的 `store.RecordTopicCut` 在**這一輪的使用者訊息**記 topic 切點並發 `chapters.changed{rootLineId}`；那則訊息已經有 topic 切點就不動、不發事件；寫入失敗只記 WARN。主線第一輪拿到 `[TOPIC]` 時同樣在第一則使用者訊息記 topic 切點（第一章的名字；切點在第一則訊息不會多出空章）。`chapters` 關著：不加規則、不記切點，標記行照樣拿掉。fake runner 新增 `[fake:topic]` / `[fake:chapter]` 指令。 |
| 2026-10-26 | （B10.1）`GET /memories` 加游標分頁：參數 `cursor`（上一頁的 `nextCursor`），回應多 `nextCursor`（沒有下一頁時是空字串，同 `GET /lines`）；排序明確為 `created_at DESC, id DESC`（之前同時間的依 id 由小到大），keyset 條件 `(created_at, id) < 游標`，每頁多查一筆判斷有沒有下一頁；游標格式同主線列表（base64url 的 `微秒_uuid`，store 共用 `encodeKeysetCursor` / `decodeKeysetCursor`），解不開 → `400 invalid_input`（同 `GET /lines`）；`limit` 仍是 1–200、預設 100。游標不帶篩選條件與租戶：換 `kind` / `status` 要從第一頁重來，別的租戶拿到游標只讀得到自己的記憶。新增 `Engine.ListMemoriesPage` / `store.ListMemoriesPage`（回 `MemoryPage{Memories, NextCursor}`），`ListMemories` 保留給嵌入者（回那一頁的記憶）；召回、`POST /memories/search` 與整併不經過這個列表，不受分頁影響。網頁記憶庫改用無限查詢（`useMemories` 回傳攤平的 `{memories, limits}` 加 `fetchNextPage` / `hasNextPage`），卡片清單是 `status=active` 的分頁、種類篩選改送伺服器（`kind`），每個篩選各自從第一頁開始；取代的歷史另外讀一頁不篩種類的 `status=superseded&limit=200`（最新的 200 筆舊版本，更早的不顯示）。 |
| 2026-10-30 | （B17）`POST /lines/{id}/suggestions/dismiss-all`（功能 `suggestions`，op `suggestions.dismiss_all`，`Engine.DismissAllSuggestions`）：一個交易、只鎖主線（同 `DecideSuggestion`），把整棵樹 open 且由目前開著的功能提的建議（範圍同 `GET /suggestions`，`registry.producers`）一次改成 `dismissed`；每一筆照單筆拒絕的規則（冷卻或永久），沒有上限（每個對象最多一筆 open）。回 `{rootLineId, suggestions}`（新的在前，沒有時 `[]`），commit 後每筆一個 `suggestion.changed`、最後主線 `line.updated`；沒有拒絕任何一筆時不發事件。InTx 收到 `store.SuggestionList`。 |
| 2026-10-30 | （B17）`PATCH /lines/{id}/branch/card`（核心，op `branches.update_card`，`Engine.UpdateBranchCard`）編輯 `merged` 支線的結論卡：卡片照 merge 的規則檢查（`checkedCard`，`422 invalid_card`），同一則卡片訊息原地改寫 `content`（`RenderBranchCardMarkdown`）與 `meta.card`（`meta` 其他鍵保留，`delivered` 整個拿掉，所以下一輪用結論卡通知再送一次、成功後再標回；之前歷史不顯示它，不會新舊同時出現），seq 不變、不算未讀；同交易改 `tangent_branch.conclusion_line`，收尾只在 `leaf` 開著且仍等於 merge 從舊卡寫出的那份（`LeafFromCard`、不是 job 寫的）時照新卡重寫。鎖 root → parent → branch（同 merge），不多鎖別的線；拒絕：不是 `merged` → `409 branch_closed`（`domain.ErrCardNotEditable`）、封存 → `409 archived`、父線已結束或卡片已被 promote 搬離父線 → `409 parent_closed`、父線在回合中 → `409 parent_busy`（那一輪可能已帶著舊卡，完成時會把卡標成已送達）。事件 `message.updated`、`branch.changed{merged}`、收尾有改時 `leaf.changed`。不重寫：記憶、滾動摘要、群組摘要、從卡片開出的支線的背景包、紀要（都是快照）。InTx 收到 `store.UpdatedCard`。 |
| 2026-10-30 | （B17）父線上的結論卡可以當開支線的 anchor（`domain.CanAnchorBranch`，store 的 `requireAnchor` 與預覽的 `requirePreviewAnchor` 共用）：背景包（`BranchPackInput.CardAnchor`，只有 `Engine.buildPack` 開，所以建立、預覽、合併支線適用）引用卡片之前的對話，最後一則是卡片本身（標頭 `· branch conclusion card`，內容是卡片 Markdown 當資料引用）。發散（`diverge` / `diverge/models`）與 `fresh` 獨立仍只接受 user / assistant。 |
| 2026-10-30 | （B17.1）結論卡的編輯時間：`PATCH /branch/card` 在卡片訊息寫 `meta.editedAt`（`UpdateCardMessage` 用 `clock_timestamp()` 轉 UTC，格式 `YYYY-MM-DDTHH:MM:SS.ffffffZ`），大綱 `BranchView.cardEditedAt` 在三個大綱查詢（`GetBranchView`、`ListBranchViewsByRoot`、`ListBranchViewsByLineIDs`）以 `LEFT JOIN` 卡片訊息讀同一個值；兩者都 `omitempty`，沒編輯過的卡與支線 JSON 不變。不加欄位、不加 migration。`MarkCardsDelivered` 用 `jsonb_set` 只改 `delivered`，`editedAt` 保留。用意：「改過、下一輪才帶入」（`editedAt` 有、`delivered` 沒有）與追問支線的「前提已更新」（來源卡的 `cardEditedAt` 晚於追問支線的 `createdAt`）都由伺服器資料決定，換裝置或重新整理後一樣；網頁拿掉 F12 的 `localStorage` 紀錄。 |
| 2026-10-30 | （B18）主線的資料夾與標籤（核心 migration 016：`tangent_line.folder TEXT NOT NULL DEFAULT ''`、`tags TEXT[] NOT NULL DEFAULT '{}'`，常數預設值不重寫資料列；`(tenant_id, folder) WHERE folder <> ''` 與 `tags` 的 GIN 索引）。`LineView.folder` / `tags` 每個讀 Line 的地方都有（`tags` 永遠是陣列）；支線永遠 `""` / `[]`（`PATCH` 對支線給非空值 `400 invalid_input`，給空值不改）。正規化在 domain：資料夾去空白與控制字元、最多 40 字、`__unfiled__` 保留給篩選；標籤去空白、控制字元與開頭的 `#`、轉小寫、依序去重，每個 1–24 字、最多 12 個。改資料夾或標籤不算活動。`GET /lines?folder=&tag=`：沒給篩選時走原本的查詢與部分索引，有給時另一個查詢（同樣的 keyset 排序，`archived` 照樣適用）。`POST /lines/folders/rename {from, to}`（op `lines.rename_folder`，`Engine.RenameFolder`）：同租戶 `folder = from` 的主線（封存的也算）依 id 上鎖後改成 `to`（`""` 解散），回 `{updated}`，每條 `line.updated`。spinoff（fresh 與 detach）的新主線繼承原主線的資料夾與標籤。 |
| 2026-10-30 | （B18）`POST /lines/import`（op `lines.import`，`Engine.ImportLine`）：外部對話一個交易寫成新主線、訊息與最多 20 條一階支線，不呼叫模型。訊息 1–200 則、只有 user / assistant，內容照宿主系統訊息的規則清理（`CleanSystemText`，保留 code fence），上限沿用 `Text.MessageMaxRunes`（預設 32,000，同一般訊息）；支線每條 1–100 則，`kind` 預設 `alternative`、`status` 預設 `discarded`，`origin` 新值 `import`（migration 016 的 CHECK）。標題空的取第一則 user 訊息前 60 字。背景包照一般開支線從錨點以前的匯入訊息建出。匯入不跑任何功能掛勾或 job、沒有用量與未讀；`source` 不存表，只給 InTx（`store.ImportedLine.Source`）。本文上限另設 `httpapi.Config.MaxImportBodyBytes`（預設 16 MiB）。事件：主線 `line.created`，每條支線 `line.created` + `branch.changed{created}`。回應的 `messageCount` 是主線的訊息數。 |
| 2026-10-30 | （B18）`POST /lines/{id}/branches/extract`（核心，op `branches.extract`，`Engine.ExtractToBranch`）：move 的一般化，任意連續區間（主線或支線，1–40 則），錯誤碼沿用 move 的（`move_protected_message` / `move_must_start_with_user` / `move_no_anchor` 是 400，`source_busy` 409）；區間裡的訊息上開過、已帶回而卡片還在來源線上的支線也是 `move_protected_message`（否則支線被帶走、卡片留下）。錨點是區間前最近可掛支線的訊息（含結論卡）。**seq**：區間最後一則換新的 seq（`UPDATE … SET seq = DEFAULT`），標記或結論卡用它空出來的 seq 寫入（`OVERRIDING SYSTEM VALUE`），所以留痕在區間原位、prompt 歷史照順序讀；被搬走的其他訊息 seq 不變。折疊：跨過區間兩端或包住區間的移除，完全在內的跟著搬（同 move，核心在交易內處理，功能開著時發 `fold.changed`）；區間之後還有訊息時，每一種章節切點在區間內最新的那個移到標記上（尾段時不動，同 move）。帶 `card`：照 merge 檢查（引用的支線端訊息必須在區間內、父線端在區間之後），支線直接 `merged`（`conclusion_line`、`card_message_id`），`leaf` 開著時同交易寫結論收尾；卡片 `meta.delivered: true`，歷史在原位顯示卡片、不再發通知，不算未讀。只跑建立支線的掛勾（同 move），不跑結束支線的掛勾，所以不開始任何 job。事件同 move（`branch.changed{moved}`）加 `fold.changed` / `leaf.changed` / `chapters.changed`。 |
| 2026-10-30 | （B18）`GET /lines/{id}/decompose`（核心、唯讀、`Engine.Decompose`）：不呼叫模型的整理建議，純函式 `domain.BuildDecomposePlan`（決定性）。只讀線上最舊的 400 則；`suggestedTags` ≤ 5、`chapterCuts` ≤ 8（≥ 30 分鐘間隔、轉折詞、或 12 則之後前後 6 則主題詞重疊 < 15%）、`detourRanges` ≤ 8（1–4 輪、問報錯 / 短的「什麼是」/ 與主題不重疊，之後回到主題）、`seedCandidates` ≤ 8（列點的問句或待辦、回覆最後的問句）、`relatedLines` ≤ 5（同租戶、未封存、共同標籤或同一個非空資料夾，依主線的組織）。中英文提示詞固定在 `domain/decompose_text.go`。 |
| 2026-11-01 | （B18.1）`GET /lines/organization`（核心、唯讀、`Engine.TenantOrganization`，型別 `domain.TenantOrganization`；`domain.LineOrganization` 已是單一主線正規化後的資料夾與標籤，所以換名）：這個租戶所有主線的資料夾 `{folder, active, archived}`（非空、依名稱 `COLLATE "C"`，封存的分開數）與未封存主線的標籤 `{tag, count}`（篇數多的在前、同數依名稱），支線不算，空的是 `[]`。不分頁、不加索引或 migration。左側清單的膠囊篇數、資料夾清單與自動補完因此不受第一頁與 `?tag=` 篩選限制。同一步 `decompose` 的 `suggestedTags` 清理中文雙字詞（`domain.cleanSuggestedTags`，規則同網頁的 `filterSuggestedTags`：標題主題詞內依重疊接回原詞、功能字開頭或結尾的丟掉、清單中首尾相接的接起來最多 6 字、租戶已在用的標籤原樣保留，`DecomposeInput.TenantTags` 由 store 以同一個 `ListTenantTags` 讀出）；清理後才取前 5 個。 |
| 2026-11-02 | （B19）`POST /lines/import` 的選填欄位，不帶時行為與回應不變，沒有新 migration：**時間**——對話、訊息、支線的 `createdAt`（RFC 3339，轉 UTC，1970-01-01 到現在 + 24 小時；`domain.PlanImport` 多一個 `now` 參數），請求裡只要有一個，每條線各自補齊：開始取線的 `createdAt` 與第一則有時間的訊息中較早的（都沒有就現在），沒時間或比上一則早的訊息取上一則的時間（時間隨 `seq` 不倒退），`last_activity_at` / `updated_at` 是最後一則；支線列的 `created_at` 同它的線，結束的 `closed_at` 是最後一則（新查詢 `InsertMessageAt`、`DateImportedLine`、`DateImportedBranch`）。**章節切點**——`chapterCuts` ≤ 20（也受 `MilestoneMaxPerTree`），掛在主線訊息上、一則一個、標題 1–60 字，寫成 `milestone`（同 `AddMilestone` 的 `insertCut`）；`chapters` 關著也寫，只有開著才發 `chapters.changed`。**已帶回的支線**——`status: merged` 必須帶 `card`、其他不能帶（`400 invalid_input`，`field` `branches[i].card`）；卡片照 merge 嚴格解碼、`question` 空的用 `purpose` 補，以空的引用集檢查（匯入的訊息還沒 id，不能引用），問題 `422 invalid_card`、`field` 加上 `branches[i].card.` 前綴。卡片訊息（`system` / `branch_card` / `meta.delivered: true` / `meta.branchLineId`，時間同錨點）寫在主線緊接錨點之後、下一則主線訊息之前（支線 id 先產生，`insertBranchAs`），支線 `merged` + `card_message_id` + `conclusion_line`，`leaf` 開著時寫 `confirmed` 葉子（同 extract 的 `closeExtracted`）。事件多 `leaf.changed`（每個葉子）與 `chapters.changed`。`messageCount` 仍是匯入的主線訊息數（卡片不算）。同一步 `cleanSuggestedTags`：標題主題詞內的漢字詞不論是否租戶已用都參與接合（租戶有 `幾何` 時不再得到 `微分幾`），租戶已用的標籤仍單獨保留。 |
| 2026-11-03 | （B20）`POST /lines/{id}/attach`（核心，op `lines.attach`，`Engine.AttachLine`，`store.AttachLine`）：detach 的反向，把同租戶另一條獨立主線連同整棵樹掛成這條線的支線，沒有新 migration（新查詢在 `store/queries/attach.sql`）。**鎖**：兩條主線依 id 排序（`lockRootRows`）→ 目標線 → 來源樹的支線依 id 排序；目標線鎖後重查所在的樹（被搬走就 `errBranchMoved` 重試），來源線鎖後又變成支線也重試（重試時拒絕）。**拒絕**：沿用既有錯誤碼——`invalid_input`（沒有來源、同一條、來源是支線或是目標的主線、來源空的、`status` / `card` 不合）、`line_not_found`、`archived`、`source_busy`（目標回合中）、`branch_busy`（來源樹回合中）、`branch_drafting`、`parent_closed`、`kind_unsupported`（aside）、`anchor_not_found`、`move_no_anchor`（400）、`depth_hard_limit` / `depth_soft_limit` / `branch_limit`（只有 open 算）/ `tree_limit`（`domain.CheckAttach`：深度與總數都把來源樹算進去）、`invalid_card`。**錨點**：沒給時挑目標線上時間不晚於來源 `created_at` 的最後一則可掛訊息（依 `seq`），都比它晚就挑最新的（時間只用來挑錨點）。**資料**：來源線不搬訊息、`seq` 不變，`RehomeBranches` 用負的 shift 把子樹加深；建議、收尾、章節切點、種子、備忘、筆記（搬，不是複製）、群組依舊主線整批改 `root_line_id`，來源與目標都開著的同一個建議先 `expired`，來源的目標（goal）刪除；訊息標籤、折疊、比較、job、關聯只指向線或訊息，不動；每棵樹的筆記 / 備忘 / 種子 / 里程碑 / 關聯 / 群組上限只擋新增。來源線標題改成 `purpose`，清掉資料夾、標籤、起源膠囊。`origin: move`（不是 `import`：卡片不是匯入時建立的）。**`status: merged`**：卡片照 merge 檢查（支線端引用來源線的訊息、父線端引用錨點之後），接在目標線最後、`meta.delivered: true`，`leaf` 開著時寫 `confirmed` 收尾。不跑功能掛勾、不開始 job。事件見 API.md（備忘沒有事件）。 |
| 2026-11-04 | （B21 + F16）長對話與合併匯出檔：**上限放寬**——`POST /lines/import` 主線 1–2,000 則（`domain.ImportMaxMessages`，原 200）、支線最多 50 條（`ImportMaxBranches`，原 20）、每條 1–500 則（`ImportMaxBranchMessages`，原 100）、`chapterCuts` 最多 50 個（`ImportMaxChapterCuts`，原 20，仍受 `MilestoneMaxPerTree` 預設 200 限制）；`GET /lines/{id}/decompose` 讀最舊的 2,000 則（`DecomposeMaxMessages`，原 400）。錯誤訊息字串跟著常數（`an import has 1 to 2000 messages` 等），錯誤碼不變；沒有 migration；匯入本文上限仍是 `MaxImportBodyBytes` 預設 16 MiB（2,000 則每則 1,000 個中文字約 6 MB）。**前端**（`@tangent/client`，不呼叫模型、決定性）：通用 JSON 的訊息群組在 `exportType: "combined"`（或檔名含 `combined`）時一律依話題分篇，沒有逐則時間且超過 500 則時累積 20 則後才分篇（`import-topics.ts` 的 `splitByTopicShifts`）；一輪 = 一則 user 提問加後面的回覆，新提問的話題詞與目前篇章（提問＋回覆前 300 字）及上一輪（提問＋回覆前 600 字）完全沒有共同詞、不是延續開頭（那、另外、如果、為什麼、what about…）、目前篇章已有回覆時切開；話題詞是 decompose 的詞（`text-terms.ts` 的 `orderedTerms`，與 mock decompose 共用）再加 2 字母縮寫（ui、db、ai）、去掉英文 2 字停用詞、純數字與含虛詞字（的是什麼一這那…）的漢字雙字；再以 500 則在提問邊界保底切開（`splitOverLimit`）。多篇時標題是各篇第一則提問，資料夾繼承 `projectName`，只有檔案日期、訊息沒時間時各篇依檔案順序遞增 1 分鐘。主幹＋支線樹的**預設**角色不超過上限：支線超過 500 則或已滿 50 條時改章節（主線還放得下 2,000 則且章節不到 50 個），否則獨立對話；預設的章節放不下時改支線，再不行改獨立對話；使用者手動選的角色不改（仍顯示 `branchTooLong` 等）。時間軸模式照舊（決定 #2：超過上限只提示、不自動切換）。F14 對話框的資料夾在使用者還沒改過、勾選的對話只帶一個資料夾時預填它。 |
| 2026-11-04 | （B22 + F16.2）`POST /lines/import-analyze`（核心、讀：唯讀身分可呼叫、不是寫入、沒有 op、不寫資料庫、不發事件；`Engine.AnalyzeImport`；沒有 migration）：匯入前把 1–200 個單元（問答輪次或整篇對話，`domain.ImportAnalyzeUnit`）提成主幹＋支線樹（`domain.ImportAnalyzePlan{mode, source, summary, nodes}`；每個單元恰好在一個節點，節點 `key` 是最早的單元，支線的 `attachToKey` 一定是章節節點）。**輸入**：key 去空白後非空、不重複、≤ 200 字，`messageCount` 0–100,000，`startAt` RFC 3339，違反是 `400 invalid_input`（`field` 例如 `units[1].key`）；問題與回答清理後截成 300 字，不算錯；`hostMeta` 拒絕；本文上限用 `MaxImportBodyBytes`。**模型**：只有 API 的 Dispatcher 實作 `tangent.OnceRunner`（`RunnerDispatcher.RunOnce`：同步、算進 `WithMaxQueue`、等 `WithMaxConcurrent`、Shutdown 等它、Close 取消它）時才問，用引擎的預設 provider／model，最多 45 秒；單元在 prompt 裡以 `U1…` 編號（不放客戶端給的 key）、內容當引用資料；回覆可以包在 json code fence 裡，嚴格檢查並修補（`ParseImportAnalyzeOutput`：未知與重複單元丟掉、漏掉的併入前一個單元的節點、超過一半漏掉或沒有可用節點就不用、未知角色當章節、沒有章節時第一個節點當章節（prompt v2 改為單元最多的節點）、`attachToKey` 不是章節時改掛它所在跨度的章節、上限照樹狀預設移動角色）。**降級**：沒有 OnceRunner、呼叫失敗或逾時、回覆不可用時用 `domain.AnalyzeImportDeterministic`（`source: "heuristic"`），log 只記固定的原因字串；所以這個路由不會因模型失敗。**確定性演算法**（與網頁 `analyzeImportLocal` 相同，契約樣本兩邊逐字相等）：話題詞同 B21 分篇；單元依序縫合——上一節點沒有回覆、延續開頭、沒有話題詞時留在上一節點；否則先比**問題**：與各節點（含上一個）問題共用、且這時只出現在一個節點問題裡的話題詞最多的節點勝出（同分上一節點優先，其次最近的）；沒有任何節點共用時才照 B21（與上一節點的問題＋回覆前 300 字或上一單元回覆前 600 字共用就留下），否則開新節點（協調者實測：回覆裡的「排程」曾把 NAS 的問題拉進 asyncio 節點）；角色依節點第一個單元的順序——第一個是章節，第一個單元嚴格落在某章節第一與最後單元之間的是該章節（最內層）的 `merged_branch`（掛在該章節在它之前的最後一個單元之後，結論是最後回覆的第一句 120 字），其餘 2 個以上單元或 4 則以上訊息的是章節，剩下的是 `standalone`；放不下時照 B21 的樹狀預設移動。前端的合併匯出檔分篇改用同一個縫合（`threadByTopicShifts`，`long` 模式仍要 20 則才離開目前話題）。理由與摘要是繁體中文的固定句子。 |
| 2026-11-04 | （B22 prompt v2）使用者回饋 AI 分析「不該合的合在一起」。只改模型端、不動確定性演算法：`domain.importAnalyzeInstructions` 改為逐單元判定「延續哪個 U → 新問題 → 插話」，明說節點是「同一對象＋同一目標的提問線」而不是領域或工具，同工具不同問題是不同節點，標題需要「與／及／and」才能涵蓋的節點必須拆，寒暄不併入章節，「那／這／另外／對了」開頭不代表延續（另外／對了／順便問通常是換題），不確定就分開（下一步合併是一次拖曳、拆肥節點要重讀），章節是最大的主題而不是第一個節點，標題用單元的字、6–30 字、禁用類別詞，語言跟**提問**而非回覆，附一個 8 單元的範例，結尾要模型自查超過 3 個單元的節點。`ParseImportAnalyzeOutput` 新增兩個守門（`guardedAnalyzeTitle`）：標題只是類別詞（技術討論、其他、Misc…）或書寫系統與提問不同時改用第一個單元自己的標題（以「詞」計：每個漢字／假名一個、每串英數字一個；提問 CJK ≥ 50% 而標題沒有 CJK 且超過 2 個英文詞——Docker Compose 這種名字留下；或提問完全沒有 CJK 而標題 CJK ≥ 50%；提問沒有任何字時不判）；回覆沒有章節時改由**單元最多**的節點當章節（原本是第一個）。上下文抽取與 fallback 門檻的改法在 `docs/plan/import-analyze-over-merge.md` §2–§3，待做。 |
| 2026-11-04 | （B22 評測集）匯入分析的評測：`domain.ImportAnalyzeEvalSample{name, source, title, units, gold}` 是一份人工標好的對話，`gold` 是它該得到的節點（每個單元恰好一個節點、`role` 可省、`note` 寫理由；`CheckImportAnalyzeGold` 檢查）。`ScoreImportAnalyzePlan(plan, gold)` 以**單元對**計分：計畫與 gold 都放同一節點的對是 Hits、只有計畫合的是 Extras（過度合併→precision 低）、只有 gold 合的是 Misses（過度拆分→recall 低）；角色以 gold 節點第一個單元所在的計畫節點比對（RoleHits／RoleTotal）。樣本在 `domain/testdata/import_analyze_eval/`（README 說明怎麼加；避開 prompt 範例用過的素材），`go test ./domain -run ImportAnalyzeEval` 用確定性演算法跑每一份並與 `baseline.json` 比對（低於基準 0.005 以上就失敗，`-update-analyze-baseline` 重寫；首次基準三份合計 P 0.42／R 0.41，mvcc P 0.39、pgpool P 0.36 就是過度合併的數字）。`tangent-eval -mode import` 另外用 `TANGENT_EVAL_IMPORT_MODEL=provider:model`（anthropic、openai、claude-cli、codex-cli、agy-cli）的模型每份跑一次並列表（沒設就只跑確定性演算法；開跑前印呼叫次數；任一次呼叫沒有可用計畫就 exit 1；`-min-import-f1` 門檻以單元對的 F1 計，precision 單獨會把「全部拆開」算成 1）；`-mode import-convert -export <ChatGPT／Claude 匯出檔> -out-dir <目錄>` 把匯出檔轉成每篇一份、每單元一個 gold 節點、標 `draft: true` 的草稿供人工合併標註（評測拒絕草稿；已存在的檔不覆蓋；ChatGPT 的 `current_node` 找不到時走根節點一路最後一個子節點的分支）。 |
| 2026-11-05 | （B22 fallback v2）確定性匯入分析不再以「任一共用詞」縫合（使用者回饋過度合併；評測集 P 0.42→0.93、R 0.41→0.93；weekend 金樣、契約樣本與 F17 九輪範例不變）。Go `domain/import_analyze_weights.go` 與網頁 `import-topics.ts` 同步：**詞權重**漢字雙字 1.0、英數字詞 1.5，超過一半單元出現的詞與標題裡的詞各 ×0.5（IDF 試過更差：主題越大它的關鍵詞 df 越高）；節點記住它**所有問題**的詞（主題是什麼）但只記最近 2 個單元的**回覆**詞（回覆的詞不再無限累積，不再有「只在一個節點問過」的 distinctive 規則）；**分數**＝節點問過的詞全額＋只在最近回覆裡的詞（英數字全額、漢字 ×0.5），位置相連的共用漢字雙字算一個詞組取最輕者；**門檻**留在目前節點 1.0、回到更早節點 1.2；問題的每個詞目前節點都有時直接留下（Docker 第 10 題）；**延續規則**（follow-up 開頭；≤ 30 字、含了／是／到／很等陳述字、不含什／怎／哪／嗎／why／what 等疑問詞、不是命令句（寫好了、works now 這種做完的回報除外）的回報句；含回指詞——它、那個、上面、這次、最後任何長度，也、再、還要只在 ≤ 30 字的問題）在沒有別的節點達門檻時留下，換題詞（另外、對了、順便、我想問、請問、by the way…，前 12 字內）不適用；follow-up cue 去掉為什麼、怎麼、所以、但是、可是、然後、and、so、but、then、why，加要怎麼；停用詞加開始。**角色**：第一個章節是第一個 core 節點，沒有 core 時單元最多的（開場寒暄改為 standalone）；`roomyRole` 的 `first` 改名 `must`。網頁 B21 的 `splitByTopicShifts` 共用 follow-up cue 表，所以以 為什麼／另外／and 開頭且沒有共同詞的提問現在會切開（以前不切），其餘切法不變；`threadByTopicShifts` 用同一套縫合。已知兩邊仍不同的只有正規化：伺服器會去掉零寬字元與 U+0085，網頁只合併空白。`text-terms.ts` 加 `orderedTermsAt`（帶位置）。 |
| 2026-11-13 | （B26）匯入分析 prompt 裡每個單元的內容（只改模型端；確定性演算法與它的輸出、`ParseImportAnalyzeOutput` 的檢查與修補、請求與回應 JSON、契約樣本、45 秒逾時、降級到 `heuristic` 的條件都不變）：`NormalizeImportAnalyzeInput` 的截斷拆成問題 600 字（`domain.ImportAnalyzeQuestionRunes`）、回答 2,000 字（`ImportAnalyzeAnswerRunes`），超過仍是截斷、不是錯；`ImportAnalyzeTextRunes`（300）保留，改指確定性演算法與修補讀的摘錄（`analyzeExcerpts` 把正規化後的文字再截成 300 字，與之前逐字相同，網頁 `analyzeImportLocal` 不用改）。單元在 prompt 裡依序是：標頭（訊息數；與前一個有時間的單元相隔超過 30 分鐘時加 `+31m`、`+3h`、`+1h 5m`、`+2d 3h`、`+7d`，剛好 30 分鐘、倒退或沒有時間不標，沒有時間的單元不重設起點）、標題、問題（≤ 400 字全文，更長是前 300 字＋「 … 」＋後 100 字）、回答首句與末句（各 ≤ 120 字、壓成一行；在換行、。！？與後面是空白或結尾的 .!? 斷句，`1.5`、`asyncio.gather` 不斷；code fence（```、'''、~~~）整塊算一句、不在裡面斷；只有一句時不重複）、回答關鍵詞一行（最多 8 個，每個 ≤ 30 字、整行 ≤ 80 字；回答的話題詞（`importTopicTermsAt`）去掉問題與標題已有的，分數 = 權重 × 在回答裡出現的次數（英數字詞以整詞計），同分依出現順序；漢字顯示成不含虛詞字的整段詞組，超過 6 字取分數最高的雙字附近 6 字，被已選詞組包含的跳過；權重預設是 fallback v2 的 `analyzeTermWeights`，可切換成 IDF `ln(1 + 單元數 / df)`，只能從 Go 的 `domain.BuildImportAnalyzePromptWith` 與 `tangent-eval -import-keywords weights|idf` 選，HTTP API 不暴露）；沒有回答的單元寫 `Answer: none`。**預算**：整個 prompt（系統指示＋單元，以 `Prompt.Chat()` 的字數計）≤ 60,000 字（`importAnalyzePromptBudgetRunes`），每單元配額 = 扣掉指示與標頭後 ÷ 單元數、下限 150 字；放不下時依序去掉末句 → 首句 → 只剩標題（截 40 字）、問題（壓成一行、依配額縮成前後 3:1，不少於 40 字）與關鍵詞，所以預設預算與 ≤ 200 個單元時一定放得下（所有欄位都到上限的 200 個單元是 59,958 字；之前沒有預算，同樣輸入 116,056 字）。分窗不做。指示文字說明單元的新內容，並說長間隔只是換題的提示、回指前面的單元仍是延續。 |
| 2026-11-13 | （B23，D1）**保留順口問**用欄位不用狀態：`tangent_branch.kept_at TIMESTAMPTZ`（核心 migration 017，可為 NULL、沒有預設值、不重寫資料列；down 是 `DROP COLUMN`）。支線狀態機 `open → merged \| discarded \| promoted` 不加新值：保留的順口問答完照樣是 `discarded`，只是清除（`ListExpiredAsides` 加 `kept_at IS NULL`；`purgeAside` 鎖住後再讀一次，所以清單列出之後才被保留的也不會被清）跳過它。`PUT /lines/{id}/branch/keep`（功能 `aside`，op `branches.keep`，`Engine.KeepBranch`，本文 `{keep}` 必填）：只對順口問（其他種類 `400 kind_unsupported`，主線 `404 branch_not_found`），進行中與已結束的都可以設；`true` 寫 `clock_timestamp()`，狀態沒變（重複保留、重複取消）就不寫、不發事件；`false` 清成 NULL，清除時間照原本的 `closed_at + AsideRetention`，所以過期的會在下一次維護被清；封存 `409 archived`。**鎖**只鎖順口問那條線（同 `RenameBranch` 的 `lockBranch`：鎖住後確認它還在原本那棵樹，不同就重試）——清除、接著問、刪除都會鎖這條線，所以不需要主線的鎖。`BranchView.keptAt` 是 `omitempty`（沒保留的順口問與其他支線 JSON 不變）；事件 `branch.changed` 的新值 `kept`（保留與取消都用它，看 `keptAt`）。建立時就保留：`POST /lines/{id}/branches` 的 `keep: true`（`BranchInput.Keep`），不是順口問 → `400 invalid_input`（`field: keep`）。InTx 收到 `store.KeptBranch{Branch, Changed}`。 |
| 2026-11-13 | （B23，D2）**接著問**不把已結束的順口問改回 `open`：`POST /lines/{id}/branch/continue`（功能 `aside`，op `branches.continue`，`Engine.ContinueAside`，`store.ContinueAside`，回 `201 {branch, line, replacedLineId}`）在同一個錨點開一條新的 `open` 支線（`kind` 預設 `investigate`，可給 `alternative`；`purpose` 預設沿用；`origin`、`excerpt`、`provider`、`model` 沿用順口問的），把順口問上所有 `done` 的訊息搬過去（`MoveDoneMessages`，`id` 與 `seq` 不變；`error` 的不搬，跟著順口問刪除），直接掛在順口問上的支線改掛到新支線（深度不變），然後刪掉順口問那條線——**線的 id 換了**。背景包照一般支線在鎖外建好傳入（順口問的比較小，不沿用）；store 鎖住後確認順口問仍掛在同一條父線的同一則訊息上，不是就 `409 concurrent_change`。**鎖**：主線 → 父線 → 順口問（`lockBranch(withParent)`）→ 它底下的線依 id。**拒絕**：不是順口問 `400 kind_unsupported`（`kind: aside` 也是）；還沒結束 `409 branch_busy`；結束但沒有完成的回答 `409 no_messages`；子樹有線在回合中 `409 branch_busy`；封存 `409 archived`；父線照 `CreateBranch` 檢查（`parent_closed`、`branch_limit`、`tree_limit`、`depth_soft_limit`、`depth_hard_limit`、`anchor_not_found`），其中整棵樹的數量不算被取代的那條。**附屬資料**：寫在順口問上的備忘留在樹上（`line_id` SET NULL）；從它記下的紀要補上來源標籤；提到它的開放建議變 `expired`；端點在搬走訊息上的連結跟著訊息到新線（`RehomeLinkEnds`），端點只指向那條線的連結隨線刪除；那條線自己的建議、收尾、折疊、job 隨線刪除，累計用量不帶到新線（每則訊息的 `meta.usage` 還在）。跑建立支線的功能掛勾（同 `CreateBranch`），不跑結束支線的掛勾。事件依序：`line.deleted`（順口問）、`line.created`、父線 `line.updated`、`branch.changed{created}`，再來是改掛子支線的 `branch.changed{moved}`、被刪連結的 `link.changed`、失效建議的 `suggestion.changed`。InTx 收到 `store.ContinuedAside`。 |
| 2026-11-13 | （B23，D3）**單獨刪除已結束的支線**：`DELETE /lines/{id}/branch`（核心，op `branches.delete`，`Engine.DeleteBranch`，`store.DeleteBranch`，回 `200 {rootLineId, lineIds}`）。可刪的只有（`domain.BranchDeletable`）已結束的順口問（保留的也可以），以及 `discarded` 的支線——「先前的主線」（`origin: previous_main_line`，裝著升級前的舊尾段）與被合併進別的支線的（`mergedIntoLineId`）除外；其他 `409 branch_not_deletable`。主線 `400 invalid_input`（用 `DELETE /lines/{id}`），不存在 `404 line_not_found`，封存 `409 archived`。連同底下所有支線一起刪；子樹裡有 `open` 的支線或有線在回合中 → `409 branch_busy`。**鎖**：主線 → 這條線 → 子樹的線依 id（不鎖父線：父線不寫入）；鎖住後確認它還在同一棵樹，被 detach / attach 搬走就重試。**不刪的**：父線上指向它的 `branch_marker`（前端對找不到的支線顯示已刪除，同被清掉的順口問）。**附屬資料**（`store.releaseLines`，接著問共用）：這些線上的備忘 `line_id` 變 NULL、紀要補來源標籤、提到它們的開放建議 `expired`、所屬的 active 群組移除成員並在剩不到 2 條（`domain.GroupMinMembers`）時解散；端點在這些線上的連結、它們自己的訊息、建議、收尾、折疊、章節切點、job 由外鍵 CASCADE 刪除。TxHook 在刪除**之前**執行（同 `DeleteTree`），收到 `store.DeletedBranch`（含每條線與訊息的 `host_meta`）。事件：`line.deleted`（信封 `lineId` 是被刪的支線、`rootLineId` 是還在的主線）、被刪連結的 `link.changed{deleted}`（`relations` 或 `spinoff` 開著）、群組的 `group.changed`（`group` 開著）、`suggestion.changed`、父線與主線的 `line.updated`。§4「刪除只有 `DeleteTree`」因此放寬：單獨刪除只限已結束、不承載其他資料的支線，整個子樹一起走，所以仍不留孤兒資料。 |
| 2026-11-13 | （B24，D1）**名詞表是獨立的功能模組 `glossary`**，不是紀要的第五個區塊：紀要每則 400 字、全文每輪進 prompt，放幾十個名詞會讓每輪的 token 一直變多；名詞表進 prompt 的量、上限都不同，而且要能跨對話查。表 `tangent_term`（核心 migration 018）：`root_line_id` 隨對話 CASCADE、`source_line_id` ON DELETE SET NULL、`source_message_id` 沒有 FK（訊息會在線之間搬動）、`source_label` 是寫入時的來源名稱快照（紀要、備忘的規則）、`UNIQUE (root_line_id, term_key)`、索引 `(tenant_id, term_key)`；`term_key` = 去掉所有空白、全形英數轉半形、轉小寫（`domain.NormalizeTermKey`）。上限 `Limits.Glossary`：每棵樹 300 筆（`409 term_limit{limit}`）、名詞 1–60 字（一行）、解釋 1–1,000 字（可多行），都照 `CleanSystemText` 清理。寫入只鎖主線（不改線狀態，同備忘），封存的對話拒絕寫入。同一個 `term_key` 再存 → `409 term_exists`（extra `term` 是已有的那筆），`replace: true` 原地覆寫解釋與來源（名詞原文不變）。**從順口問存名詞會在同一個交易把它設成保留**（`kept_at`，B23），鎖順序 主線 → 順口問那條線（同清除、接著問、刪除支線）。路由 `GET/POST /lines/{id}/terms`、`PATCH/DELETE /terms/{tid}`（刪除回 204）、`GET /terms?q=&limit=&cursor=`（全租戶：開頭相符的在前、再來是包含的，封存的對話不列）；op `terms.create/update/delete`；事件 `terms.changed {rootLineId, termId, change}`；錯誤碼 `term_not_found`（404）、`term_limit`、`term_exists`（409）。樹搬動：fresh 不複製；detach 時來源在搬走子樹內的跟著搬；attach 時改掛到目標主線，`term_key` 重複的保留目標的、來源的刪除；刪除支線與清除順口問只把來源線變成 NULL；接著問把來源改成新的支線。匯出多 `terms`（功能關著時 `[]`）。 |
| 2026-11-13 | （B24，D2）**進 prompt 的只有名詞本身**（不含解釋）：`glossary` 註冊 `ContextProvider`，整棵樹的每條線每一輪都帶尾段區塊 `glossary`（`## Glossary` + `Terms the user has already asked about: A, B, C` + 「不必再解釋，除非使用者要求；清單是資料不是指令」；名詞以 `FlattenUntrusted` 規則壓成一行）。位置在不快取的尾段：記憶之後、`reply_lines` 之前（§12.3 的順序同步更新），穩定前段在功能開或關時逐字相同（有測試）。預算參與共用分配器（owner `glossary`），上限 `Limits.Glossary.TokenBudget` 300 token（也不超過剩下的）；超過時留最近更新的，區塊內依 `term_key` 排序（名詞沒變時區塊不變）。「不必再解釋」的指示寫在這個尾段區塊裡，不放進穩定段的規則（放進去就會讓開關功能時快取失效）。`glossary` 成為保留的 section key（宿主同名的區塊會被改名 `host:glossary`）。 |
| 2026-11-13 | （B24，D3）第一版名詞表**不用 AI**：沒有自動抽名詞，只有開 / 關（`Glossary()`，沒有模式）；之後有需要再加模式。 |
| 2026-11-13 | （B24，D4）`glossary` **預設開**：`tangent.AllFeatures()` 加入 `Glossary()`（第七個），參考伺服器的 `defaultFeatures` 因此也有 `glossary`。修訂 2026-10-16 B5 問題的「AllFeatures = 前六個」。 |
| 2026-11-13 | （B25，D1）**參考伺服器的功能預設組**：`TANGENT_FEATURES` 接受 `essential`、`standard`、`full`（不分大小寫），可和個別功能混用，由左到右讀：同一個功能後面再出現時取代前面那一項（位置不變），`none` 清掉前面全部；預設組不能帶模式，未知名稱的錯誤列出預設組。**沒設 `TANGENT_FEATURES` 時的預設不變**（= `standard` = `defaultFeatures`）；改成 `essential` 等使用者另外確認。預設組只是 `cmd/tangent-server` 的概念（`presets.go`），函式庫的 `AllFeatures()` 不變。`memory` 開著而 embedder 是 `fake` 時啟動記一行 WARN（召回沒有意義），不擋啟動。 |
| 2026-11-13 | （B25，D2）`essential` = `notes, chapters, aside, summary:suggest, card_draft, leaf:manual, parking, spinoff, search, memo, glossary`；`standard` = 目前的 `defaultFeatures`（B24 之後已含 `glossary`）；`full` = `standard` + `fisheye` + `memory`（`memory` 仍需要 `TANGENT_EMBEDDER`，fake provider 預設 fake embedder，其他沒設就照原規則回錯）。 |
| 2026-11-13 | （B25）**匯入批次**：`POST /lines/import` 選填 `batchId`（客戶端產生的 UUID）與 `batchLabel`（≤ 120 字，`domain.ImportBatchLabelMaxRunes`）；同一個交易 upsert `tangent_import_batch`（migration 019）：同租戶沿用（標籤以第一次為準），別的租戶 `404 import_batch_not_found`（新錯誤碼），`INSERT … ON CONFLICT DO UPDATE … WHERE tenant 相同` 讓併發匯入同一個新 id 不會撞唯一鍵、且批次列鎖到 commit。新主線記 `import_batch_id` 與「匯入完成時的樹」：`import_seq`（樹上最新訊息的全域 seq）、`import_activity_at`（主線當時的 `last_activity_at`）。`LineView.importBatchId`（omitempty）。`GET /imports`（核心唯讀，keyset 新的在前）回 `lineCount`（還存在的線，被 attach 併走的算）與 `standaloneCount`（仍是主線的）。`DELETE /imports/{bid}?force=`（op `imports.delete`，`Engine.DeleteImportBatch`）逐棵走 `DeleteTree` 的同一條路徑（`store.deleteTree` 加一個在鎖之下執行的檢查；各自的交易、鎖、TxHook、`line.deleted`），不要求整批原子；`kept` 的原因 `attached`、`busy`、`changed`。**「匯入後用過」**（在那棵樹的鎖之下判斷）：主線 `last_activity_at` 和 `import_activity_at` 不同、樹上有 seq 大於 `import_seq` 的訊息或編輯過的結論卡（`meta.editedAt`）、有 `origin` 不是 `import` 的支線，或樹上有 notes / 備忘 / 名詞 / 種子（匯入不寫這些）；不和「現在」比，因為 B19 的時間可以是歷史的，也可以在未來 24 小時內。`force=true` 也刪 `changed` 的。`kept` 是空的才刪批次列（鎖住批次列再數線，避免和進行中的匯入競爭）。`DeleteTree` 不動批次列；attach 保留 `import_batch_id`；spinoff 的新主線清掉批次與釘選。 |
| 2026-11-13 | （B25，D3）**對話釘選存在伺服器**：`tangent_line.pinned_at`（同 migration 019，只有主線）；`PATCH /lines/{id}` 的 `pinned: bool`（`true` 寫 `clock_timestamp()`，已釘選不動；`false` 清掉；支線給 `true` 回 `400 invalid_input{field: pinned}`、`false` 不改；`POST /lines` 不接受）。釘選不算活動（`last_activity_at` 不變，同資料夾與標籤），發 `line.updated`。`LineView.pinnedAt`（omitempty）。**不影響 `GET /lines` 的排序與游標**：`pinned=true` 走另一個查詢（依 `pinned_at DESC, id`，不分頁、最多 200、帶 `cursor` 回 `400`，`archived` / `folder` / `tag` 照樣適用）；沒帶時查詢逐字不變。attach 併走的線清掉 `pinned_at`；spinoff 的新主線不繼承。 |
| 2026-11-15 | （G1）**CLI 模型目錄、自動偵測、fallback 與思考深度透傳**：`tangent.ModelGroup` 新增選填 `Ready *bool`、`Reason string`、`Details []ModelDetail{Model, DisplayName?, Status?, EffortLevels?}`（`ModelCurrent` / `ModelLegacy`，全部 `omitempty`），`GET /capabilities` 照 `engine.ModelCatalog()` 回報；舊宿主的 JSON 形狀一字不差。`tangent.RunRequest` 新增 `ReasoningEffort` 與 `HostMeta json.RawMessage`（`Turn.Request()` 在使用者訊息非 `{}` 時複製其 `host_meta`，函式庫不讀；`ChatRequest` 與 `Job.Request()` 不帶）。`runner/cli` 依模型接受的等級傳參數：`claude` `--effort <level>`（`xhigh` 視為 `max`）、`codex` `-c model_reasoning_effort="<level>"`（`max` 視為 `xhigh`）、`agy` 忽略；不認得的值不加。參考伺服器：`TANGENT_CLI_AUTODETECT`（未設定時跟著 `TANGENT_DEV`）偵測執行檔自動啟用 CLI provider；沒設 `TANGENT_ALLOWED_MODELS` 時啟用的 CLI 帶入內建 preset 與別名，設了仍是嚴格白名單；`TANGENT_FALLBACK_MODEL=provider:model` 在還沒串出任何 delta 且遇用量／429 上限時重跑一次；`Config.HostMeta` 掛勾（`cmd/tangent-server/hostmeta.go`）從 `POST /lines`、`PATCH /lines/{id}`、`POST /lines/{id}/messages` 的 `reasoningEffort` 寫入 `host_meta.reasoningEffort`（線存對話預設、支線未設沿用主線、使用者訊息記當輪實際值），`httpapi` 本身維持忽略未知欄位，不改 DB schema。 |
| 2026-11-15 | （G3）**開分支／結論卡／收尾 prompt 的準確率與 token 優化**：(1) `PackLimits.ExcerptRecentMessages`（預設 3）：有選取文字時背景包只整則引用最近 3 則（順口問不超過 4），其餘改單行摘要與滾動摘要；沒有選取時背景包不變。(2) `BranchPromptInfo.Kind` 依支線類型（`investigate` / `alternative`）各補一行規則，`Kind == ""` 與 `aside` 不變；`[BRANCH-SUGGEST]` 規則預設只在主線帶入，支線需 `BranchPromptInfo.SuggestBranches`（opt-in，引擎預設不帶，順口問永遠不帶），回覆仍照常解析與串流過濾 `[BRANCH-SUGGEST]`。(3) `card_draft` 結論卡草稿不再整包貼背景包（只在支線完成訊息 ≤ 2 則且沒有選取文字時附截斷到 1,200 token 的背景包）；標題改列目的＋選取文字與錨點單行摘要；分叉後主線最多讀 30 則且只到 claim 當時的 `ParentTipMessageID`（最新 5 則原文、較舊每則單行摘要）；訊息標題改短代號 `B1…` / `M1…`（依 seq 由舊到新），完成時依 claim 的 `UptoSeq` 與 `ParentTipMessageID` 重建對照表把 `B` / `M` 還原成 UUID（真 UUID 仍通過）；收緊 `excerpts` 引用指示。(4) `leaf_draft` 輸入預算 12,000 → 4,000 token（每則上限 700），組裝為頭 1 則原文＋中段單行＋尾 4 則原文（拿掉 UUID 標題），帶 `Excerpt`，要求 `dead_end` 寫出具體失敗／放棄原因、`to_continue` 與 `previous_main_line` 寫清楚進度與未定項。 |
