# S2 · `store/` 套件（+ `tangenttest/`）

> 2026-10-15。把 宿主 對話分支的 Postgres 儲存層移植成 `store`：embed 的 migrations、sqlc 查詢（`store/db`）、
> 所有交易，以及 `tangenttest.Open`。依賴只多了 `github.com/jackc/pgx/v5`（含 pgxpool）。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 通過 |
| `go test ./... -count=1` | 通過：217 個 PASS、0 FAIL、**0 SKIP**（store 90 個測試函式全部真的連上 :5444 執行；domain 127 個） |
| `go test ./store/ -race -count=3` | 通過 |
| 併發測試 `-run 'Concurrent\|Exclusive' -count=25` | 通過（沒有死鎖、沒有 flaky） |
| `gofmt -l .` | 無輸出 |
| `~/go/bin/sqlc generate` 後 `sqlc diff` | 無差異 |
| store 覆蓋率（`-coverpkg=./store/,./tangenttest/`，不含 sqlc 產生碼） | 約 82% |

TDD：先寫測試（從 宿主 移植 + 新增），確認 `store` 沒有實作時編譯失敗（RED），再寫實作。domain 的小改動也是先改
`errors_test.go` 看它失敗，再加錯誤。

## 檔案對照（來源 → 目標）

| 宿主 | tangent |
|---|---|
| `db/migrations/010,015,019,020,024,026–029`（對話部分） | `store/migrations/001_lines_messages`、`002_branches`、`003_notes_chapters`、`004_jobs`（.up/.down） |
| `db/queries/session.sql`（對話部分） | `store/queries/lines.sql`、`messages.sql` |
| `db/queries/conversation_branch*.sql` | `store/queries/branches.sql`、`messages.sql`（卡片、搬移） |
| `db/queries/conversation_note.sql`、`conversation_chapter.sql` | `store/queries/notes.sql`、`chapters.sql` |
| （新）宿主任務佇列 的草稿 / 摘要耦合 | `store/queries/jobs.sql`、`store/jobs.go` |
| `storage/postgres_session_store.go`（建立、讀取、列表、更新、未讀、hydrate） | `store/lines.go`、`store/hydrate.go`、`store/convert.go` |
| `storage/postgres_session_messages.go` | `store/messages.go`、`store/turns.go` |
| `storage/postgres_session_cancel.go` | `store/turns.go`（`CancelTurn`） |
| `storage/postgres_session_summary.go` + `handler/session_summary.go` 的存檔與 topic cut | `store/summary.go`（`SaveSummary`） |
| `storage/postgres_conversation_branch.go`、`_tx.go` | `store/branches.go`、`store/branch_guard.go`、`store/tree.go`（`ArchiveTree`） |
| `storage/postgres_conversation_branch_end.go` | `store/branch_end.go` |
| `storage/postgres_conversation_branch_draft.go` | `store/drafts.go` |
| `storage/postgres_conversation_branch_move.go` | `store/branch_move.go` |
| `storage/postgres_conversation_branch_promote.go` | `store/branch_promote.go` |
| `storage/postgres_conversation_notes.go` | `store/notes.go` |
| `storage/postgres_conversation_chapters.go` | `store/chapters.go` |
| `storage/postgres_conversation_aside.go`、`postgres_session_tree_delete.go` | `store/turns.go`（`endAnsweredAside`）、`store/tree.go` |
| `db.MigrateFS` | `store/migrate.go`（`Migrate`、`MigrateDown`、`MigrationsFS`） |
| `internal/testdb`、`storage/schema_harness.go` | `tangenttest/db.go`（`Open`、`OpenSchema`） |

測試檔：`postgres_conversation_branch_test.go` → `branches_test.go`；`…_end_test.go` → `branch_end_test.go`；
`…_move_test.go` → `move_promote_test.go`；`postgres_session_tree_delete_test.go` → `delete_test.go`；
`postgres_session_store_test.go` → `lines_test.go`、`turns_test.go`；`postgres_session_acp_test.go`（cancel、summary） → `turns_test.go`、`summary_test.go`。
handler 測試裡屬於儲存層的斷言（promote、move、notes、chapters、aside、draft、merge、卡片送達）改寫成 store 層測試，放在
`move_promote_test.go`、`notes_test.go`、`chapters_test.go`、`aside_test.go`、`jobs_test.go`、`branch_end_test.go`、`turns_test.go`。

## Schema 說明

- 四個 migration，全部不指定 schema（測試靠 `search_path`）。`tangent_schema_migrations(version, applied_at)` 由 `Migrate` 建立，
  不在 migration 檔裡，所以 `MigrateDown(…, 0)` 之後它還在（空的）。
- `Migrate`：一個連線上拿 `pg_advisory_lock(hashtext('tangent_schema_migrations:' || current_schema()))`，每個檔一個交易
  （執行 SQL + 寫版本），所以多個行程同時啟動只會有一個在套用；key 含 `current_schema()`，不同 schema 互不阻擋。
  `MigrateDown(ctx, pool, target)` 由新到舊撤銷大於 target 的版本。檔名必須成對（`NNN_name.up.sql` / `.down.sql`），否則回錯。
- `tangent_message.seq`：`BIGINT NOT NULL GENERATED ALWAYS AS IDENTITY UNIQUE`（多寫 `NOT NULL` 讓 sqlc 產生 `int64`）。
  `created_at` 用 `clock_timestamp()`，但沒有任何查詢用它排序。
- 索引：DESIGN 列的之外，加了 `tangent_line (tenant_id, archived_at, last_activity_at DESC, id DESC)`（主線列表的 keyset）、
  `tangent_message (created_at) WHERE status='pending'`（stale turn 清掃）、`tangent_branch (closed_at) WHERE kind='aside' AND status<>'open'`（aside 清除）。
- `tangent_note`、`tangent_chapter_cut`、`tangent_branch`、`tangent_job` 的 `created_at` 用 `clock_timestamp()`
  （同一交易寫多筆時仍有先後；宿主 用 `now()`）。
- `tangent_chapter_cut` 多了 `tenant_id`、`line_id`（宿主的 `session_id`，有 FK cascade），`message_id` 不加 FK。
- `tangent_job.line_id` 有 FK cascade：刪樹或清 aside 時一起刪。
- sqlc 設定加了 override：`uuid` → `github.com/google/uuid.UUID`（nullable → `uuid.NullUUID`），非 null 的 `timestamptz` → `time.Time`。

## 與 宿主的差異（有意的）

1. **排序一律 seq**：所有「之後 / 之前 / 最新」查詢都改用 seq（`ListMessagesAfterSeq`、`ListDoneMessagesUpToSeq`、`LatestRelevantMessage`…）。
   move 用 id 搬、promote 用 `seq > anchor.seq` 搬，訊息 seq 不變。`CompleteTurn` 不再把回覆的時間戳改成完成時間
   （宿主 用它讓回覆排在回合中插入的通知之後；tangent 的回合中 merge / move 都會被擋，不需要）。
2. **游標都是 seq**：`summary_upto_seq`、`draft_upto_seq`、`ListMessages(afterSeq)`。move 時「摘要游標落在搬走的範圍」= `summary_upto_seq >= 第一則搬走訊息的 seq`。
3. **BeginTurn 自己挑卡片與筆記版本**：在鎖住線的同一交易裡讀未送達卡片（最多 `NoticeMaxPerTurn`，舊的先）與 notes revision，
   寫進 pending 訊息的 `meta.deliversCards` / `meta.notesRevision`，並回傳給 Engine 組 prompt。宿主 是 handler 事後用
   `SetTurnCommand` 補寫。`CompleteTurn` 只依 store 自己記的 id 標記送達，而且只限同一條線的卡片。
4. **CompleteTurn 的加鎖順序**：先鎖線再更新訊息（宿主 先更新訊息再更新 session，與 cancel 相反，理論上可能死鎖）。
   冪等：訊息不是 pending 就回 `ErrTurnNotPending`。用量加到線的 `input_tokens/output_tokens/cost_usd`。
5. **CancelTurn**：沒有 daemon / command，所以沒有「已被認領」分支；Engine 傳入已串流的部分文字，存成內容並標 `meta.cancelled`。
6. **FailStaleTurns(olderThan)**：只看 pending 訊息的 `created_at`，細節固定為 `StaleTurnDetail`；宿主 依 command 狀態與 daemon 在線判斷。
7. **Job 取代 宿主任務佇列**：`ClaimBranchDraft` 建立 `card_draft` job（同線舊的 pending 草稿 job 標 `superseded`）並記到
   `draft_job_id`；`FinishBranchDraft(jobID, outcome)` 只在 job 仍 pending、是該支線目前的草稿、未逾時、支線仍 open 時寫入，
   否則回 `ErrDraftNotPending`，並在另一個交易把 job 標成 `failed`（自己的草稿逾時）或 `superseded`（被取代或支線已關閉）。
   沒有 daemon 綁定檢查（宿主的 `targetDaemonId`）。`draft_started_at` 與逾時判斷都用 store 的時鐘（`WithClock`）。
8. **摘要**：`SaveSummary` 在一個交易裡鎖線、檢查（可選的）summary job 仍 pending 且屬於這條線、檢查游標是這條線上已完成的訊息、
   以 `domain.TopicCutFor` 決定 topic cut、寫摘要與 cut、完成 job。宿主 是 handler 分好幾步、不同交易做。
   move（游標被搬走時）與 promote（主線與升級支線）重設摘要，並把這些線上 pending 的 summary job 標 `superseded`
   （move 一律 supersede，因為輸入已經不對了）。
9. **筆記驗證進 store**：`ApplyNoteChanges` / `MergeBranch` 先跑 `domain.NormaliseNoteChanges`（形狀、清洗、數量），`UpdateNote`
   用 `CheckNoteText`、section、status（只能 active / done）檢查。宿主 由 handler 做。空的變更不動 revision。
10. **AddMilestone / DeleteMilestone 鎖主線**：計數上限在鎖裡檢查（宿主 沒鎖，併發可能超過上限）。
    `RecordTopicCut` 要求訊息在這條線上（宿主 不檢查）。
11. **promote 的「起草中」用有效狀態**：逾時的草稿不再擋 promote（宿主 用原始欄位）。
12. **lockBranch 重讀確認**：鎖到的父線若已不是支線的父線（同時有 move / promote 改掛），整個交易重跑（最多 3 次）。
13. **DeleteTree**：沒有附件表；改成回傳被刪的線 id、各線 `host_meta`、各訊息非空的 `host_meta`，讓宿主清自己的資料。
    TxHook 在刪除**之前**執行（DESIGN §6），其他寫入的 hook 在 store 自己寫完之後。
14. **PurgeExpiredAsides**：先鎖 root 再鎖 aside 與其下（宿主 直接鎖 aside），維持 root → child 的順序；回傳被清的線與訊息 `host_meta`。
15. **ListLines**：keyset 分頁（`last_activity_at DESC, id DESC`，游標是不透明字串），取代 宿主的固定 200 筆。
16. **錯誤**：全部是 domain 錯誤。新增 `ErrArchiveNotMainLine`（碼 `branch_not_main_line`，宿主的 `BranchRefusalArchive` 文字）、
    `ErrMessageNotFound`（= `ErrChapterMessageNotFound`，碼 `message_not_found`）、`ErrJobNotFound`（`job_not_found`）、
    `ErrJobNotPending`（`job_not_pending`）。這是 S2 對 `domain/` 唯一的改動（只有新增），測試在 `domain/errors_test.go`。
    宿主的 `ErrSessionNotFound` → `ErrLineNotFound`；`ErrBranchSessionArchived` → `ErrLineArchived`。
17. **拿掉的欄位與行為**：agent / daemon / git / worktree / mode / transport / shell / permissions / plan context / resume id / citations /
    attachments、`awaiting_input` 與 waiting 統計、`turnQueued`、`hasPendingPermission`、`carry_context_next_turn`、`ApplyCompaction`、
    `AppendMessageResults`、`SetTurnCommand`、`CommandClaimedBy`、單線刪除 `DeleteSession`。
18. **CreateBranch** 驗證 purpose / excerpt / kind / origin（`move`、`previous_main_line` 只能由 store 自己設定）；支線標題 = purpose；
    provider / model 空白時繼承父線。卡片內容（`ValidateBranchCard`、Markdown）仍由呼叫者負責，store 照存。

## 測試：移植與刪除

**移植（宿主 storage 測試）**

- `postgres_conversation_branch_test.go` 19 個中移植 17 個：TreeDepthRoot（拿掉 ask mode）、ListSessionsLeavesBranchesOut（併入
  `TestLines_ListPagesMainLinesNewestActivityFirst`）、WorkspaceIsolation → TenantIsolation、DeletingTheMainLine…、OutlineIsCapped、DepthLimits、
  OpenBranchesPerParentAreCapped、WholeTreeIsCapped、ConcurrentCreatesCannotPassTheLimit、AnchorMustBe…、ClosedOrArchived…、
  ArchiveCoversTheWholeTree…、CreateRefusesAnArchivedParent、ParentRowRollsUp…（拿掉 waiting）、OutlineCarriesTheStoredPack
  （擴充為 detail：pack、draft、parentTip）、BranchBelowAClosedBranch…（加 `BranchLineEnded`、`BranchSubtree`）、HydrationFailsLoudly。
- `…_end_test.go` 4 個全部：OtherWorkspace（加 promote）、MergeAndDiscardAreExclusive、TwoMergesIntoOneParent…、AnEndedBranchCannot…。
- `…_move_test.go` 1 個：ConcurrentCallsKeepEveryMessageOnce。
- `postgres_session_tree_delete_test.go` 3 個中 2 個：RemovesEveryLine…（改成驗 host_meta 回傳、hook 在刪除前）、Refusals（加 hook 失敗）。
- `postgres_session_store_test.go` 5 個中 3 個：CRUDAndHydration（拆成 lines 測試）、TurnLifecycleAndPendingGuard、FailStaleTurns。
- `postgres_session_acp_test.go`：CancelUnclaimedTurn → `TestTurns_CancelKeepsThePartialTextAndIsIdempotent`、SummaryRoundTrip。
- handler 測試的儲存層部分：promote 5 個、move 5 個 + 刪除、notes 8 個（含 merge 帶筆記 2 個）、chapters 6 個、aside 3 個（含 purge）、draft（job 只能完成一次、
  逾時、被取代、關閉後結果被忽略、失敗只存固定理由、拒絕情境）、merge（parent busy / moved、另一張卡算 moved、tip 驗證、巢狀、
  筆記同交易、筆記被拒整筆回滾、分支回答中被拒）、delivery（只有成功的回合標記送達、每輪上限、舊的先、偽造 id 無效、筆記 revision）。

**刪除（理由）**

- `BranchCannotLeaveAskMode`、`ModeWorktreeAndContextTokens`、`UpdateModeAndFieldsAtomicBusy`：沒有 mode / worktree。
- `PendingPermissionCountsAsWaiting`、`PermissionLifecycle`：沒有 ACP 權限請求。
- `CancelClaimedTurn`：沒有 daemon command。
- `ApplyCompactionAtomic`、`ApplyCompactionBusyKeepsResume`：沒有 resume id / compaction 訊息。
- `AppendMessageResults_*`（2 個）、`SetTurnCommand_KeepsTheRestOfThePendingMessageMeta`：沒有 landed / proposals / command id
  （meta 只更新頂層 key 的行為由 `CompletePendingMessage` 的 `meta || patch` 保留，`TestTurns_OnlyASuccessfulTurnMarksItsCardsDelivered` 間接驗證）。
- 附件 4 個（含 race）與 `DeleteSessionTree_KeepsAFileAConcurrentMessageIsAboutToUse`：沒有附件（宿主放 `host_meta`）。
- `TestSessionFromRow_ShellSummaryArraysAreEmptyNotNull`：沒有 shell session（摘要陣列一律非 null 由 `TestSummary_RoundTrip…` 驗證）。
- `schema_harness_test.go`：harness 換成 `tangenttest`，由每個 store 測試間接驗證；migrator 有自己的測試。

**新增**

migrations up→down→up、`MigrateDown` 到指定版本、四個 `Migrate` 併發只套用一次、檔案成對；TxHook 失敗回滾（CreateLine、BeginTurn、
MergeBranch、DeleteTree）與 hook 看得到交易內的寫入；seq 排序在 move / promote 後、而且 `created_at` 故意亂設也不影響；
job 生命週期（建立、完成一次、supersede、不能以 superseded 完成、跨租戶線）；草稿逾時與被取代（假時鐘）；summary job 只能寫一次、
不能寫到別條線；摘要游標必須是本線已完成訊息；BeginTurn 併發只有一個成功；限制來自 store 的 `Limits`；訊息形狀驗證；寬樹的刪除。

## Store 公開 API

建立與設定

- `New(pool, limits, opts...) (*Store, error)` — 建 store；`limits` 不合法或 pool 為 nil 回錯。`WithClock(func() time.Time)` 選項。
- `(*Store).Limits()` — 實際套用的上限（補完預設）。
- `TxHook func(ctx, Tx, result any) error`（B2.1 改版，`Tx` 只有 `Exec`/`Query`/`QueryRow`）— 每個寫入的最後參數 `hooks ...TxHook`。
- `MigrationsFS`、`Migrate(ctx, pool)`、`MigrateDown(ctx, pool, target)` — migrations。

Lines

- `CreateLine(ctx, CreateLineInput, hooks...) (LineView, error)` — 建主線（可指定 id）。
- `GetLine(ctx, tenant, lineID) (LineView, error)` — 讀一條線（含支線記錄、子支線計數、未讀彙總）。
- `ListLines(ctx, ListLinesInput) (LinePage, error)` — 主線 keyset 分頁，`archived` 篩選。
- `UpdateLine(ctx, tenant, lineID, LinePatch, hooks...) (LineView, error)` — 改標題 / provider / model / host_meta。
- `MarkRead(ctx, tenant, lineID, hooks...) (LineView, error)` — 清未讀。
- `ArchiveTree(ctx, tenant, lineID, archived, hooks...) ([]LineView, error)` — 封存 / 解除整棵（主線在前）。
- `DeleteTree(ctx, tenant, rootID, hooks...) (DeletedTree, error)` — 刪整棵，回傳 id 與 host_meta；hook 在刪除前。

Messages / turns

- `InsertMessage(ctx, tenant, lineID, NewMessage, hooks...) (Message, error)` — 附加一則訊息。
- `GetMessage(ctx, tenant, lineID, messageID)`、`ListMessages(ctx, tenant, lineID, afterSeq, limit)`、`RecentMessages(ctx, tenant, lineID, limit)` — 讀訊息。
- `MessagesUpToAnchor` / `MessagesAfterAnchor(ctx, tenant, lineID, anchorID)` — 背景包用（`Pack.HistoryScan` / `Pack.LaterScan`）。
- `MessagesAfterSummary(ctx, tenant, lineID)` — 摘要游標之後的已完成訊息（最多 500）。
- `ParentTipMessageID(ctx, tenant, lineID)` — 最新的相關訊息（merge 的 tip）。
- `UndeliveredBranchCards(ctx, tenant, lineID, limit)` — 未送達卡片。
- `BeginTurn(ctx, BeginTurnInput, hooks...) (BegunTurn, error)` — 開始一輪（含這輪要帶的卡片與 notes revision）。
- `CompleteTurn(ctx, CompleteTurnInput, hooks...) (CompletedTurn, error)` — 完成一輪（冪等）。
- `CancelTurn(ctx, tenant, lineID, partial, hooks...) (CancelledTurn, error)` — 取消。
- `FailStaleTurns(ctx, maxAge) ([]StaleTurn, error)` — 清逾時的回合（B2.1：截止點 = `s.now() - maxAge`）。
- `FailStaleJobs(ctx, timeouts) ([]Job, error)`、`DefaultJobTimeouts()` — 清逾時的 job（B2.1 新增）。

Branches

- `CreateBranch(ctx, CreateBranchInput, hooks...) (CreatedBranch, error)` — 開支線。
- `GetBranch(ctx, tenant, lineID) (BranchDetail, error)` — 標頭、pack、draft、parentTip。
- `ListBranches(ctx, tenant, lineID, includeAside) ([]BranchView, error)` — 整棵大綱（最多 500）。
- `MergeBranch(ctx, MergeBranchInput, hooks...) (MergedBranch, error)` — 帶卡片返回（可同交易改筆記）。
- `DiscardBranch(ctx, tenant, lineID, hooks...) (BranchView, error)` — 放棄。
- `MoveToBranch(ctx, MoveToBranchInput, hooks...) (MovedBranch, error)` — 把最後 N 則搬成支線。
- `PromoteBranch(ctx, tenant, lineID, hooks...) (PromotedBranch, error)` — 升為主線。
- `BranchLineEnded(ctx, lineID) (bool, error)`、`BranchSubtree(ctx, tenant, lineID) ([]LineView, error)`。

Jobs / drafts / summary

- `CreateJob(ctx, CreateJobInput, hooks...) (Job, error)`、`GetJob(ctx, jobID)`、`PendingJob(ctx, tenant, lineID, kind)`、
  `FinishJob(ctx, jobID, status, errText, hooks...)` — job 生命週期（`JobPending/Done/Failed/Superseded`、`JobKindCardDraft/Summary`）。
- `ClaimBranchDraft(ctx, tenant, lineID, hooks...) (DraftClaim, error)` — 開始起草。
- `FinishBranchDraft(ctx, jobID, BranchDraftOutcome, hooks...) (BranchView, error)` — 寫入草稿結果。
- `GetBranchDraft(ctx, tenant, lineID) (BranchDraft, error)` — 草稿狀態（逾時視為失敗）。
- `SaveSummary(ctx, SaveSummaryInput, hooks...) (SavedSummary, error)` — 存摘要、游標、topic cut。

Notes / chapters / asides

- `ListNotes`、`NotesForTurn(ctx, tenant, lineID)` — 讀筆記。
- `ApplyNoteChanges(ctx, ApplyNotesInput, hooks...) (NotesWrite, error)` — 新增 / 取代。
- `UpdateNote(ctx, tenant, lineID, noteID, NotePatch, hooks...) (NoteUpdate, error)` — 改一則。
- `ListChapters(ctx, tenant, lineID) (ChaptersView, error)` — 章節（`domain.ComputeChapters`）。
- `AddMilestone(ctx, MilestoneInput, hooks...) (ChapterChange, error)`、`DeleteMilestone(ctx, tenant, lineID, milestoneID, hooks...)`、
  `RecordTopicCut(ctx, tenant, lineID, messageID, topic, hooks...) (TopicCut, error)`。
- `PurgeExpiredAsides(ctx, retention) ([]PurgedAside, error)` — 清過期的 aside（B2.1：0 = `Limits.Branch.AsideRetention`）。

`tangenttest`：`Open(t)`（乾淨 schema + migrations）、`OpenSchema(t)`（只有空 schema）、`Context(t)`（30 秒逾時）、`URL()`、`EnvDatabaseURL`、`EnvRequireDB`、`DefaultDatabaseURL`。

## 給 S3 的待決問題

1. **背景包在交易外建**：`CreateBranch` 收呼叫者建好的 pack（同 宿主），anchor 在鎖內重驗，但 pack 讀的訊息可能比鎖內稍舊。
   要不要像 `MoveToBranch` 一樣給 `CreateBranch` 一個在鎖內呼叫的 `BuildPack`？
2. **TurnGate**：建議用 `BeginTurn` 的 TxHook 實作（回錯即整筆回滾），或在 `BeginTurn` 之前先 `GetLine` 再呼叫。
3. **卡片驗證與 Markdown**：`MergeBranch` 照存呼叫者給的 card / content；Engine 要先 `CheckBranchCardShape` → 讀 `CappedReferencedIDs` 的訊息 →
   `ValidateBranchCard` → `RenderBranchCardMarkdown`。
4. **建議（`[BRANCH-SUGGEST]`）**：`CompleteTurn` 收已解析的 `Suggestions` 與清掉 marker 的內容；Engine 用 `ExtractBranchSuggestions` + `ResolveTurnOutcome`。
5. **job 沒有逾時**：pending 的 summary / 功能 job 若宿主掛掉會一直 pending（`PendingJob` 會擋重複排程）。需要 `FailStaleJobs(olderThan)` 或 Engine 依 `CreatedAt` 判斷？
6. **批次操作沒有 hook**：`FailStaleTurns`、`PurgeExpiredAsides` 不收 TxHook（每項各自一個交易）。Engine 若要在其中做事，要不要加？
7. **一輪的歷史上限**：DESIGN §12 說 `Limits.HistoryScan`（預設 200），domain 目前只有 `Pack.HistoryScan`；`RecentMessages` 預設 200。S3 決定欄位。
8. **封存的主線仍可開始一輪**（照 宿主）；只有支線在封存後被擋。Engine 要不要也擋主線？
9. **草稿進行中仍可手寫卡片 merge**（照 宿主），之後草稿結果被忽略、job 標 superseded。
10. **事件資料**：各寫入回傳的內容（例如 `MovedBranch` 沒有來源線的新 `LineView`）是否足夠 Engine 發事件，或 Engine commit 後再讀一次？
11. **`ListBranches` 傳入支線 id 時會解析成整棵樹**；`ListNotes` / `ListChapters` 同樣以線找 root。

## B2.1 review fixes（2026-10-15）

來源：go-reviewer 與 database-reviewer 對 S2（`8e456b0`）的審查，加上 DESIGN §12 的 S2 後續決定。每一項都有回歸測試；
死鎖與競態的修正用混合路徑的併發測試驗證。

### 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 通過 |
| `go test ./... -count=1` | 通過：全部 PASS、0 FAIL、**0 SKIP**（store 的 DB 測試都真的連 :5444 執行） |
| `go test ./store/ -race -count=2` | 通過 |
| 併發測試 `-run 'Concurrent\|Exclusive\|Locking' -count=15` | 通過 |
| `gofmt -l .` | 無輸出 |
| `sqlc diff` | 無差異 |
| 死鎖測試的有效性 | 暫時把鎖改回 `FOR UPDATE`、關掉 40P01 重試：`TestLocking_*` 兩個都失敗（`deadlock detected`、topic cut 等鎖逾時）；改回後通過 |

### HIGH

1. **死鎖（PG17 重現）**：`GetLineForUpdate` 改成 `FOR NO KEY UPDATE`。外鍵檢查拿 `KEY SHARE`，不再等線的鎖，
   所以「SaveSummary(B) 持有 B → 插 chapter cut 檢查 root 外鍵」與「Merge 持有 root → 等 B」不再成環（AddMilestone、RecordTopicCut 同理）。
   放寬前先補上原本只靠外鍵 key-share 序列化的地方：`InsertMessage` 與 `createJob`（有 LineID 時）都明確鎖線。
   `runTx` 對 SQLSTATE `40P01` / `40001` 重試（最多 5 次、指數退避加抖動、每次先查 `ctx.Err()`）。
   測試：`TestLocking_ALineLockDoesNotBlockRowsThatReferenceIt`（UpdateLine 掛勾卡住 root 時，支線上的 RecordTopicCut 仍在 2 秒內完成）、
   `TestLocking_SummariesMergesAndCutsDoNotDeadlock`（6 條支線 × SaveSummary / Merge / RecordTopicCut / AddMilestone 併發）。
2. **寫入已 commit 卻回錯**：交易機制改成泛型 `runTx[T]`，結果（`hydrateOne`、`branchViewOf`、`hydrateIDs`）一律在交易內用 tx 綁定的
   queries 讀；回傳的是這次 commit 的快照，讀取失敗就整筆回滾。每次重試都從新的結果開始（順便解決 MEDIUM 7 的「重設捕獲的輸出」）。
   測試：`TestReview_AWriteThatCannotReadItsResultRollsBack`。
3. **InsertMessage**：拒絕 `pending`（只有 BeginTurn 能開一輪，內部的 `insertMessage` 不變）、鎖線、封存的線與已結束（或祖先已結束）的支線拒絕
   （`requireLineWritable`，與 BeginTurn 共用）。migration 005 加部分唯一索引 `idx_tangent_message_one_pending (line_id) WHERE status='pending' AND role='assistant'`。
   測試：`TestReview_InsertMessageRefuses…`、`TestReview_OnePendingAssistantTurnPerLine…`、`TestLocking_MessagesRacingADiscard…`。
4. **索引（migration 005）**：`tangent_note(superseded_by) WHERE NOT NULL`、`tangent_chapter_cut(line_id)`、主線列表兩個部分索引
   （`archived_at IS NULL` / `IS NOT NULL`，取代 `idx_tangent_line_tenant`）、`tangent_message(line_id, seq) WHERE kind='branch_card'`，
   另加 `tangent_job(kind, created_at) WHERE status='pending'`（FailStaleJobs）。`ListMainLines` 拆成 `ListActiveMainLines` / `ListArchivedMainLines`，
   各用字面條件。測試：`TestReview_IndexesServeTheHotReads`（索引存在、`EXPLAIN` 用到部分索引）。

### MEDIUM

5. `CreateJob` 有 LineID 時鎖線（supersede 與插入不會交錯；`TestLocking_CreateJobSupersedeIsAtomic` 8 個併發只留 1 個 pending）。
   `SaveSummary` 的游標不得倒退（含 0），所以重複或過期的結果不會降低 `summary_upto_seq`（`TestReview_SummaryCursorNeverMovesBackwards`）。
   一般的 `FinishJob` 拒絕 `card_draft`（`TestReview_FinishJobLeavesCardDraftsToFinishBranchDraft`）。
6. 整棵樹的操作（`DeleteTree`、`ArchiveTree`）改用 `ListTreeLineIDs`（`root_line_id`，無遞迴、無上限，id 排序）。遞迴 CTE
   （`ListSubtreeLineIDs`、`ListBranchUnreadByAncestors`）加深度上限 `HardMaxDepth + 1`（預設 7，< 8），拿掉 `LIMIT 1000`。
   `ArchiveTree` 也依 id 順序鎖整棵樹的線。測試：1100 條支線的樹整棵封存與刪除、沒有孤兒；循環的父鏈不會讓讀取卡住。
7. 重試用盡回 `domain.ErrConcurrentChange`（新碼 `concurrent_change`，建議 409）；每次重試前查 `ctx.Err()`。
   測試：掛勾回 `40001` 兩次後成功（只有一筆）、重試的 merge 只留成功那次的卡、一直 `40P01` → `concurrent_change`、重試中取消 → `context.Canceled` 且沒有殘留；
   內部測試 `TestRetryable_RaceLossesOnly`。
8. `FailStaleTurns` 遇到 `ErrLineNotFound` / `ErrTurnNotPending` 跳過；其他錯誤停止並回傳已完成（已 commit）的部分與錯誤。
   規則寫在 `maintenance.go` 開頭，`FailStaleJobs`、`PurgeExpiredAsides` 相同。`PromoteBranch` 失敗時回零值（`runTx` 保證）。
   測試：`TestReview_FailStaleTurnsReturnsThePartialResultOnAnError`（用 trigger 讓第二條線失敗）。
9. **TxHook**：`type TxHook func(ctx context.Context, tx Tx, result any) error`，`Tx` 只有 `Exec`/`Query`/`QueryRow`；`result` 是這次寫入將回傳的值
   （例如 `BegunTurn`、`MergedBranch`、`DeletedTree`），所以掛勾拿得到新產生的 id。錯誤包成 `tx hook: …`。重試時掛勾會再跑一次。
   **DESIGN §6 的 `TxHook` 仍寫 `pgx.Tx`，請協調者決定 Engine 層要不要跟著改。**
10. **時鐘**：store 的決定一律用 `s.now`：`FailStaleTurns(ctx, maxAge)`、`PurgeExpiredAsides(ctx, retention)`、`FailStaleJobs` 的截止點都從 `s.now` 算；
    `WithClock` 的說明寫清楚資料庫自己填的時間戳（`created_at`、`closed_at`、`last_activity_at`）仍是 DB 時鐘。
11. **tangenttest**：只有連線被拒或逾時才 skip（帳密錯、資料庫不存在 → Fatal）；`TANGENT_TEST_REQUIRE_DB=1` 連 skip 也變 Fatal；
    `Context(t)`（`t.Context()` + 30 秒）給測試用，store 測試的 fixture 改用它；套件說明寫了每個測試的連線預算（最多 2 + 8）。
    測試：`TestUnreachable_OnlyRefusedOrTimedOutConnectionsSkip`、`TestContext_EndsWithTheTest`。
12. **補測試**：CompleteTurn、CancelTurn、MoveToBranch、PromoteBranch、FinishBranchDraft、SaveSummary、ArchiveTree、FinishJob 的掛勾失敗回滾
    （`TestHooks_AFailingHookRollsEveryWriteBack`）；commit 前取消 context 不留資料（`TestHooks_ACancelledContextLeavesNoPartialRows`）；sweep 中途出錯（上面 8）。
13. BeginTurn 讀祖先的支線列時不加鎖：寫在 `requireBranchAcceptsTurn` 的註解（良性：支線只會 open → 結束，結束支線的寫入都會在支線有進行中的回合時拒絕）。

### LOW

- 存的 draft JSON 壞掉 → `GetBranchDraft` / `GetBranch` 回錯，不再當成空草稿。
- `FinishBranchDraft` 時支線已不在（或 job 已被刪）→ `ErrDraftNotPending`。
- `CompleteTurnInput` 驗證：status 只能 idle / error、失敗 ⇔ error、用量與時間不得為負（`TestReview_CompleteTurnValidatesTheOutcome`）。
- `lines.go` 的閉包改用 `:=`（整個改寫成 `runTx` 回傳值）。
- `MigrateDown` 拒絕負的 target。
- 被取消的 aside 回覆不算「已回答」（`CountDoneAssistantReplies` 排除 `meta.cancelled`），所以 aside 可以再問一次（`TestReview_ACancelledAsideTurnIsNotAnAnswer`）。
- CHECK：`(status='open') = (closed_at IS NULL)`、`parent_line_id <> line_id`（`TestReview_BranchRowsCheckTheirOwnState`；測試的直接插入也補了 `closed_at`）。
- `draft_job_id` 改成可為 NULL 的 `UUID`（`NULLIF(draft_job_id,'')::uuid`），與 `tangent_job.id` 一致。
- `CreateLine` 用宿主指定的 id 撞到既有的線 → 不論是哪個租戶的都回同一個 `ErrIDUnavailable`（新碼 `id_unavailable`），訊息不提「已存在」。
- 遷移的 advisory lock 改成兩個 int4 key（`hashtext('tangent_schema_migrations')`, `hashtext(schema)`）；`current_schema()` 為 NULL（search_path 的 schema 不存在）時直接回錯。
- **客戶端在 move / promote 之後要重新抓訊息**：seq 不重新編號，被搬走的訊息留著原本的 seq 出現在別條線，而 `afterSeq` 游標只會往後讀，
  所以增量讀取看不到「被搬走」或「被搬進來」的舊訊息。S3 的 Engine 會為此發事件（`branch.changed` 的 moved / promoted）。

### DESIGN §12 的 S2 後續決定

- **FailStaleJobs**：`FailStaleJobs(ctx, timeouts)`，nil 用 `DefaultJobTimeouts()`（card_draft = `Limits.Branch.DraftTimeout` 3 分鐘、summary 5 分鐘）；
  不在表裡的 kind 不動；每個 kind 每次最多 200 筆，`FOR UPDATE SKIP LOCKED`。批次清理都不收 TxHook。
- **`domain.Limits.HistoryScan`**（頂層，預設 200）：domain 新增欄位、預設、驗證與測試；`RecentMessages` 沒給 limit 時用它。
- **封存的主線拒絕新的 turn 與支線**：`BeginTurn`、`InsertMessage` 對封存的主線也回 `ErrLineArchived`（建立支線原本就擋）。
  DESIGN 寫的碼是 `session_archived`，但 宿主 與前端（`web/packages/client`）都用 `archived`，所以沿用 `archived`；請協調者確認或改 DESIGN。
- **Engine commit 後重讀 view**：store 仍回傳 commit 當下的快照（交易內讀），Engine 可以直接用或重讀。

### domain 的改動（只有新增）

`Limits.HistoryScan`；`ErrConcurrentChange`（`concurrent_change`）、`ErrIDUnavailable`（`id_unavailable`）。測試在 `domain/limits_test.go`、`domain/errors_test.go`。
