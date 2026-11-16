# B3 · Engine（root 套件 `tangent`）

> 2026-10-15。工作單。前半是**第一階段（B3a + B3b）**的紀錄（`62d122a`，保留原文；與現況不同處以後面兩節為準）：
> Engine 骨架、選項、lines、turn 協定（含 `PreviewTurn` 與 delta 緩衝）、支線、job、`Runner` / `Dispatcher` / `NewRunnerDispatcher`、
> commit 後發事件，以及 `tangenttest` 的假 Runner 與事件收集器。後半是「第一階段審查修正」與「第二階段（B3c + B3d）」。

## 驗收（第一階段）

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 通過 |
| `go test ./... -count=1` | 通過：295 個頂層測試 PASS、0 FAIL、**0 SKIP**（DB 測試都實際連 :5444） |
| `go test ./... -count=1 -race` | 通過 |
| `gofmt -l .` | 無輸出 |
| `~/go/bin/sqlc diff` | 無差異（沒有新增或修改 SQL） |
| 新程式碼覆蓋率 | **93.1%**（root 套件、`tangenttest/runner.go`、`tangenttest/events.go`、`store/turn_lookup.go`，以 `-coverpkg` 合併各測試執行檔計算；root 套件整體 92.3%） |
| 檔案 / 函式大小 | 新檔最大 290 行（`jobs.go`）；所有函式（含測試）< 50 行 |

新增測試函式 50 個：root 套件 45 個（`package tangent` 內部 10 個、`package tangent_test` 35 個）、`tangenttest` 3 個、`store` 2 個。

**TDD 說明**：`store.GetTurn` / `PendingTurn`、delta 緩衝、turn cache、功能登錄殼先寫測試看到編譯失敗（RED）再實作。Engine 本體因為
API 面很大，是先把型別與骨架寫到能編譯，再以整合測試逐區驅動與修正（第一輪跑出 4 個失敗：move 的訊息數、purpose 正規化的預期、
無法使用的草稿案例、hook 測試資料不足，都已修正）。prompt 快取排序有反向驗證：把 `cacheOrdered` 拿掉時
`TestPrompt_ConsecutiveBranchTurnsShareTheirStablePrefix` 會失敗。

**第一階段驗收項目對照**

| 工作單要求 | 測試 |
|---|---|
| 建主線 → 兩輪（假 runner）→ 開支線 → 起草 → merge → 下一輪 prompt 帶卡片且完成後標記送達 → promote → move → 刪除整棵 | `TestFlow_MainLineToDeleteTree` |
| commit 失敗不發事件 | `TestLines_AFailingHookRollsBackAndPublishesNothing`（16 種寫入，每個都驗證回錯、零事件、沒有殘留資料） |
| prompt 快取前綴（同一條支線連續兩輪，不變區塊位元組相同） | `TestPrompt_ConsecutiveBranchTurnsShareTheirStablePrefix`、`TestCacheOrdered_StableBuiltInsFirstHostNextCardsLast` |
| `BeginTurn` / `CompleteTurn` 效能 | `TestPerf_TurnProtocolWithinBudget`（見下） |

## 效能量測

`TestPerf_TurnProtocolWithinBudget`：主線 2,000 則訊息、樹上 200 條支線（8 open、192 discarded，直接用 SQL 灌入），每項 40 次。
本機（Linux、Postgres 17 in docker on :5444、無其他負載）：

| 操作 | p50 | p95 | 預算（p95） |
|---|---|---|---|
| `BeginTurn`（含組 prompt：最近 202 則、筆記、卡片、摘要） | 7.06 ms | 9.24 ms | < 60 ms |
| `CompleteTurn`（含解析建議、`SummaryDue` 檢查：讀游標後最多 500 則） | 6.27 ms | 7.78 ms | < 30 ms |
| `ListBranches`（200 條，含 aside） | 2.03 ms | 3.29 ms | < 30 ms |
| `PreviewTurn` | 5.16 ms | 6.05 ms | （無預算，參考 `BeginTurn`） |

預設只記錄數字；`TANGENT_PERF_ASSERT=1` 時超過預算會讓測試失敗（機器差異大，CI 先不開）。Merge / Promote / Move 的量測留給 B5。

## 公開 API（第一階段）

建立與設定（`engine.go`、`options.go`、`features.go`）

- `New(pool, opts...) (*Engine, error)` — pool 為 nil、limits 不合法、功能重複 / 缺依賴 / 沒名字時回錯。schema 需先 `store.Migrate`。
- 選項：`WithLimits`、`WithPublisher`、`WithPromptContributor`、`WithTurnGate`、`WithExtraMarkers`、`WithClock`（同時傳給 store）、
  `WithLogger(*slog.Logger)`、`WithFeatures(...Feature)`、`WithFeaturePolicy(FeaturePolicy)`。
- `Scope{Tenant, Actor}`（Tenant 必填，否則 `invalid_input`）；`TxHook = store.TxHook`；`TxOption`、`InTx(h)`。
- `(*Engine).Limits()`。
- 介面：`Publisher`、`PromptContributor`、`TurnGate`（同 DESIGN §6）。
- 功能模組殼：`Feature`（`Name`、`Requires`、`AI`、未匯出的 `register(*registry)`，所以是封閉集合）、`Mode`（`ModeOff/Manual/Suggest/Auto`，`String()`）、
  `FeaturePolicy`。目前沒有任何模組；空清單可以運作。

Lines（`lines.go`）

- `CreateLine(ctx, scope, LineInput, ...TxOption)` → `line.created`。
- `GetLine`、`ListLines(ctx, scope, LineQuery)`（`LineQuery = store.ListLinesInput`，Tenant 以 scope 為準）、`ListMessages(ctx, scope, lineID, afterSeq, limit)`。
- `UpdateLine(…, LinePatch)`、`MarkRead` → `line.updated`。
- `ArchiveTree(…, archived bool)` → 每條線一個 `line.updated`（主線在前）。
- `DeleteTree(…)` → `line.deleted{rootLineId, lineIds}`，並清掉這些線的 delta 緩衝。型別別名 `LinePage`、`LinePatch`、`DeletedTree`。

Turn 協定（`turn.go`、`turn_complete.go`、`preview.go`、`runner.go`）

- `BeginTurn(ctx, scope, lineID, TurnInput{Content, HostMeta}, ...TxOption) (Turn, error)` — 空內容 `invalid_input`；`TurnGate` 在交易前
  （有 gate 時才多讀一次 `GetLine`）；commit 後發 `message.created` ×2、`line.updated`，再組 prompt。prompt 組不出來時立即以
  `"the prompt could not be assembled"` 讓這一輪失敗並回傳原因（不留 pending 給清掃）。
- `Turn{ID, Scope, LineID, RootLineID, UserMessage, Pending, Prompt, Provider, Model}`。
- `AppendDelta(ctx, turnID, domain.Delta)` — 驗證 kind；turn 位置先查記憶（本行程開始的 turn），否則讀一次 `store.GetTurn` 後記住；
  buffer 指派每條線的 seq；發 `message.delta`（Data = 存好的 `domain.Delta`）。
- `StreamSince(ctx, scope, lineID, afterSeq) ([]domain.Delta, error)` — 只讀記憶體，依租戶分隔。
- `CompleteTurn(ctx, turnID, TurnResult, ...TxOption) (CompletedTurn, error)` — `ResolveTurnOutcome` → 成功時 `ExtractBranchSuggestions` →
  store；發 `message.updated`、`line.updated`；結束 aside 時再發 `branch.changed{discarded}` + 父線 `line.updated`；回報 `SummaryDue`。
  `TurnResult{Content, Error, Usage, DurationMs, Provider, Model}`；`CompletedTurn{Line, Message, RootLineID, SummaryDue, EndedAside}`。
- `CancelTurn(ctx, scope, lineID, ...TxOption) (CancelledTurn, error)` — 部分內容取自 delta 緩衝；本行程正在跑的 run 會被 cancel。
- `FailStaleTurns(ctx, olderThan time.Time) ([]StaleTurn, error)` — 換算成 store 的 maxAge；`olderThan` 不在過去回 `invalid_input`。
- `PreviewTurn(ctx, scope, lineID, content) (Preview, error)` — 不寫入、不發事件。`Preview{Prompt, Blocks, TotalTokens, Provider, Model}`，
  `PreviewBlock{Key, Role, Content, Tokens}`；Key 是 section key 或 `summary` / `earlier` / `history` / `user_message`；每個區塊的 Content
  與 `Prompt.Chat()` 的輸出逐位元組相同（用只含該區塊的 `domain.Prompt` 渲染）。
- `RunTurn(ctx, Turn, Runner) (CompletedTurn, error)` — `Prompt.Chat()` → `Runner.Run`（`OnDelta` → `AppendDelta`、`OnRetry` → `turn.retrying`）→
  `CompleteTurn`（寫回用 `context.WithoutCancel` + 15 秒）。runner panic 轉成失敗（`"the runner crashed: …"`）；被取消的 turn 回 `ErrTurnNotPending`。
- `Runner`、`RunRequest{Provider, Model, System, Messages, MaxTokens, OnDelta, OnRetry}`、`Retry{Attempt, MaxAttempts, NextRetryAt}`、`RunResult{Content, Usage, StopReason}`。

支線（`branches.go`、`branch_ops.go`、`merge.go`）

- `CreateBranch(ctx, scope, parentLineID, BranchInput, ...TxOption) (CreatedBranch, error)` — 先正規化 purpose / excerpt / kind；
  `SuggestionMessageID` 時重新比對該 assistant 訊息的 suggestions（origin `suggestion`，空 excerpt 由建議補上）、有 excerpt 時 origin `selection`、
  否則 `button`；鎖外建背景包（`MessagesUpToAnchor`、`IncludeLater` 時 `MessagesAfterAnchor`、父線摘要、`Check()`）；store 在交易內重驗 anchor。
  事件：`line.created`（新支線）、`line.updated`（父線，重讀）、`branch.changed{created}`。`CreatedBranch{Line, Branch, Pack}`。
- `ListBranches(ctx, scope, lineID, includeAside)`、`GetBranch(ctx, scope, lineID) (domain.BranchDetail, error)`。
- `MergeBranch(ctx, scope, lineID, MergeInput{Card, ParentTipMessageID, ConfirmParentMoved, NoteChanges}, ...TxOption)` — tip 不是 UUID →
  `invalid_parent_tip`；支線已關 → `branch_closed`；`CheckBranchCardShape` → 讀 `CappedReferencedIDs`（支線訊息，或 pack 引用的父線訊息；
  父線 anchor 之後的訊息以 seq 判斷）→ `ValidateBranchCard` → `RenderBranchCardMarkdown` → store。問題一律 `domain.CardError`（`invalid_card` + problems）。
  事件：`message.created`（卡片）、`branch.changed{merged}`、`line.updated`（父線、支線）、有筆記變更時 `notes.changed`。
- `DiscardBranch` → `branch.changed{discarded}`、父線與支線 `line.updated`。
- `MoveToBranch(ctx, scope, lineID, MoveInput{Count, Purpose, Kind, Provider, Model, ConfirmDeeper, HostMeta})` — Kind 預設 investigate；
  背景包在鎖內用 `store.MovePackBase` 建。事件：`line.created`、`message.created`（marker）、來源線 `line.updated`、`branch.changed{moved}`（新支線與每條跟著搬的支線）。
- `PromoteBranch` → 主線與升級支線 `line.updated`、前主線 `line.created`、`branch.changed`：promoted（升級的）、created（前主線）、moved（改掛的）。
- 型別別名：`MovedBranch`、`PromotedBranch`、`MergedBranch`、`CancelledTurn`、`StaleTurn`、`JobRecord`（= store 型別）。

背景工作（`jobs.go`、`dispatcher.go`）

- `Job{ID, Kind, Feature, Scope, LineID, Prompt, Provider, Model}`；`JobKindCardDraft`、`JobKindSummary`。
- `StartDraft(ctx, scope, lineID, ...TxOption) (Job, error)` — `ClaimBranchDraft` → `branch.changed{draft}` → 起草 prompt（支線到 claim 游標為止的
  user / assistant、父線 anchor 之後、pack）。prompt 組不出來時立即以 `DraftRunFailedText` 結束草稿。
- `StartSummary(ctx, scope, lineID, ...TxOption) (Job, error)` — 游標之後沒有訊息 → `no_messages`；建 job（input `{uptoSeq}`，取代同線 pending 摘要）。
- `FinishJob(ctx, jobID, raw, runErr) error` — 依 kind 分派：card_draft 走 `ParseBranchDraft` → 引用檢查 → `DraftOutcome` → `FinishBranchDraft`
  （`branch.changed{draft}`；過期 / 被取代時也重發 branch 狀態並回 `draft_not_pending`）；summary 走 `ParseSummaryWithCut` → `SaveSummary`
  （`line.updated`，有 topic cut 時 `chapters.changed`），失敗或無法解析時 job 標 failed、保留舊摘要。其他 kind → `invalid_input`（第二階段由 JobHandler 接）。
- `FailStaleJobs(ctx) ([]JobRecord, error)` — 用 store 預設逾時；失敗的草稿重發 `branch.changed{draft}`。
- `Dispatcher{DispatchTurn, DispatchJob}`；`NewRunnerDispatcher(e, r, ...DispatcherOption) *RunnerDispatcher`；`WithTurnTimeout`（預設 10 分）、
  `WithJobTimeout`（預設 3 分）；`(*RunnerDispatcher).Wait()`。每件工作一個 goroutine，脫離呼叫者的 context（`WithoutCancel`）再套逾時；
  runner 錯誤、panic、逾時一律寫回 turn / job。

事件（`events.go`）

- `Event{Type, Tenant, RootLineID, LineID, Data}`；常數 `EventLineCreated/Updated/Deleted`、`EventMessageCreated/Updated/Delta`、
  `EventBranchChanged`、`EventNotesChanged`、`EventChaptersChanged`、`EventTurnRetrying`；`Branch*` change 常數。
- Data 型別：`LineView`、`domain.Message`、`domain.Delta`、`BranchChange{Change, Branch}`、`LinesDeleted`、`NotesChange`、`ChaptersChange`、`TurnRetrying`。
- 只在 store 回傳成功（已 commit）後發；需要的 view 在 commit 後重讀（父線、被改掛的支線、promote 後的各線）。Publisher panic 會被記錄、不影響寫入。

`tangenttest`

- `FakeRunner`（`NewFakeRunner(replies...)`、`Queue`、`Requests`、`Respond func(RunRequest) Reply`、`Default`）；`Reply{Content, Chunks, Err, Delay, Retries, Panic, Usage}`；`ErrFake`。
- `Recorder`（`NewRecorder`、`Publish`、`Events`、`Types`、`OfType`、`Reset`、`WaitFor(type, n, timeout)`）。

## domain / store 的改動（只有新增）

- `store/turn_lookup.go`：`TurnRef{TurnID, Tenant, LineID, RootLineID}`、`(*Store).GetTurn(ctx, turnID)`（只認 pending 的 assistant 訊息，其餘
  `ErrTurnNotPending`）、`(*Store).PendingTurn(ctx, tenant, lineID) (domain.Message, bool, error)`。沒有新 SQL（用既有的 `GetMessage`、
  `GetPendingAssistantMessage`）。測試 `store/turn_lookup_test.go`。
- `domain/`：沒有改動。
- `tangenttest/db.go`：只改套件說明。

## 與契約（DESIGN §6）的差異

1. **`Turn` 多了 `Scope`、`RootLineID`**：宿主的 Dispatcher 需要租戶，事件需要 root。
2. **`CancelTurn` 回傳 `(CancelledTurn, error)` 並收 `TxOption`**（契約寫 `error`）：呼叫者要知道有沒有取消到、取消後的訊息。
3. **`NewRunnerDispatcher` 回傳 `*RunnerDispatcher`**（實作 `Dispatcher`，多一個 `Wait()` 給優雅關機與測試）。
4. **Engine 多了 `ListMessages`**：httpapi 的 `GET /lines/{id}/messages` 需要，Engine 不對外暴露 store。
5. **`FailStaleJobs(ctx)` 沒有逾時參數**：用 store 的預設（card_draft = `Limits.Branch.DraftTimeout`、summary 5 分）。第二階段由功能登錄表提供各 kind 的逾時。
6. **Job 的 prompt 形狀**：起草與摘要的 prompt 是單一文字，放在 `Prompt.UserMessage`（`Chat()` = 無 system、一則 user；`Text()` 會多一個
   `## Operator's message` 標題）。
7. **草稿的 provider / model**：`FinishJob` 不知道實際跑的是哪個模型，ready 的草稿記錄支線本身的 provider / model（宿主 由 daemon 回報）。
8. **prompt 區塊順序（快取友善）**：Engine 在 `BuildPrompt` 之後重排 `Sections`：`instructions → rules → branch_pack → notes → 宿主區塊 → branch_cards`。
   所以 Engine 產生的 prompt 用 `Text()` 時，卡片通知在背景包之後，不再是 宿主的「卡片在最前」版面（`domain` 本身的 `Text()` 不變）。
   摘要由 `domain.Prompt.systemText` 固定放在所有區塊之後，所以有卡片的那一輪，卡片在摘要之前；共同前綴只到宿主區塊為止（見問題 1）。
9. **`StreamSince` 只回 `[]domain.Delta`**（照契約），沒有 宿主的 `truncated` 旗標；buffer 被逐出後 seq 從 1 重來。
10. **`PreviewTurn` 讀的卡片與筆記版本**是當下的快照，不加鎖（`BeginTurn` 在鎖內挑）。
11. **`BeginTurn` 的筆記內容**在 commit 後才讀；`NotesChanged` 用鎖內記下的 revision 判斷。若兩者之間筆記剛好變更，這一輪帶的是新內容、
    記錄的是舊 revision，下一輪會再送一次（只會多送，不會漏送）。

## 留給第二階段的暫時位置（核心裡的功能行為）

每一處都已經隔成獨立的小函式，註解標 `Phase 2 (B3d)`：

| 功能 | 位置 | 第二階段搬去 |
|---|---|---|
| notes | `prompt.go` `notesContext`（每輪帶筆記區塊）；`merge.go` `notesEvents`（`notes.changed`）；`MergeInput.NoteChanges` 直接傳給 store | notes 模組的 `ContextProvider`、`OnBranchClosed` / `AfterCommit`；關閉時 `noteChanges` 回 `feature_disabled` |
| summary | `prompt.go` `summaryContext`；`turn_complete.go` `summaryDue`；`jobs.go` `StartSummary`、`finishSummary` | summary 模組（`ModeAuto` 時在 `AfterCommit` 自己排 job；`JobHandler(summary)`）；關閉時只用 `HistoryScan` |
| chapters | `jobs.go` `chaptersEvents`；**store 的 `SaveSummary` 一律記錄 topic cut** | chapters 模組；需要 store 加法修改（例如 `SaveSummaryInput.SkipTopicCut`）讓關閉時不記切點 |
| card_draft | `jobs.go` `StartDraft`、`finishDraft`、`draftOutcome`、`draftPrompt` | card_draft 模組的 `JobHandler(card_draft)`；auto 模式在結束支線時自動起草 |
| branch_suggest | `turn_complete.go` `extractSuggestions`；`branches.go` `acceptSuggestion`；**`domain.promptRules` 一律加 `BranchSuggestRules`** | branch_suggest 模組；需要 domain 加法修改（例如 `PromptInput` 加一個關閉建議規則的欄位） |
| aside | `kind=aside` 照常建立；store 的 `CompleteTurn` 結束已回答的 aside，Engine 發事件（`turn_complete.go`）；`PurgeExpiredAsides` 尚未包進 Engine | aside 模組（關閉時建立 aside 回 `feature_disabled`）與 `Engine.Maintain` |

功能登錄表 `registry` 目前只有名字、順序與依賴檢查；擴充點欄位（`ContextProvider`、`HistorySelector`、`OnTurnCompleted`、`OnBranchCreated`、
`OnBranchClosed`、`AfterCommit`、`JobHandler`）在第二階段加入，核心呼叫它們的位置就是上表的函式。`FinishJob` 的 kind 分派（`jobs.go`）
會改成查登錄表；交易內的擴充點用 `TxHook` 串進 store（目前所有寫入都已經收 `...TxOption`）。

## 給協調者的問題（第一階段；已在 DESIGN §12 回覆，處理見「第一階段審查修正」）

1. **摘要與卡片的順序**：要讓「有卡片的那一輪」也保住摘要的快取前綴，需要 `domain.Prompt` 把卡片通知渲染在摘要之後（例如新增一個欄位或方法，
   只加不改）。要做嗎？還是接受目前「卡片只出現一輪」的代價？
2. **`Text()` 版面**：宿主 接回時若要原本「卡片在最前」的版面，Engine 要不要提供選項（例如 `WithHostLayout`）？目前 YAGNI 沒做。
3. **`MarkRead` 的事件**：支線清未讀時，祖先的 `branchUnread` 彙總也變了，但目前只發該線的 `line.updated`。要不要沿祖先鏈各發一個？
4. **`StreamSince` 的 `truncated`**：要不要改契約回傳 `{deltas, seq, truncated}`，讓前端知道該重抓訊息？
5. **跨行程取消**：`CancelTurn` 只能停掉本行程 `RunTurn` 的 run；別的行程（宿主自己的佇列）只會在寫回時拿到 `turn_not_pending`。要不要在
   `Dispatcher` 介面加取消掛勾？
6. **摘要游標蓋過未送達卡片**：`StartSummary` 的游標 = 最新的非 pending 訊息，可能是一張還沒送達的卡片（宿主 同樣行為）。卡片送達後
   seq 在游標之內，會從歷史消失、也沒被摘要。要不要讓游標停在第一張未送達卡片之前？


---

# 第一階段審查修正（2026-10-15）

來源：協調者轉來的 go-reviewer 報告，以及 DESIGN §12「B3 階段一」之後幾列的決定。每一項都有回歸測試（多數在 `review_fixes_test.go`）。

## DESIGN §12 的決定

| 決定 | 做法 | 測試 |
|---|---|---|
| prompt 區塊順序：規則 → 背景包 → 紀要 → 宿主區塊 → 摘要 → 結論卡通知 → 最近歷史 | domain 加法：`Prompt.Trailing`（在摘要之後渲染；`ResumeText` 也找得到裡面的卡片）。Engine 的 `arranged` 把 `branch_cards` 移進 `Trailing`。不提供舊排列選項 | `TestPrompt_BlocksFollowTheFixedOrder`、`TestArranged_*`、`domain/prompt_trailing_test.go` |
| `MarkRead` 也對祖先發 `line.updated` | `ancestorEvents`（最多 `HardMaxDepth` 層，近的先） | `TestReview_MarkReadRepublishesTheAncestors` |
| `StreamSince` 回傳 `truncated` | 回傳 `DeltaTail{Deltas, Seq, Truncated}` | `TestDeltaRegistry_ReportsWhatTrimmingAndEvictionLost` |
| Dispatcher 不加跨行程取消 | 沒加。另外讓串流中的 run 每 2 秒（`pendingRecheck`）問一次 store turn 是否還 pending（見 M3） | — |
| 摘要游標停在第一張未送達卡片之前 | `summarizable`（summary 模組）；`StartSummary` 與 `SummaryDue` 都只看卡片之前的訊息 | `TestSummary_TheCursorStopsBeforeAnUndeliveredCard` |

## go-reviewer 發現

| 等級 | 問題 | 修正 | 測試 |
|---|---|---|---|
| H1 | 取消時的部分內容取自 64 KiB 環狀緩衝，長回覆被截、單一超大 delta 被丟、緩衝可能被逐出 | `inflightRuns` 每個 run 有自己的文字累加器（上限 `partialTextMax` = 1 MiB，不切斷 UTF-8 字元）；`CancelTurn` 優先用它，只有別的行程跑的 turn 才退回環狀緩衝 | `TestReview_CancelKeepsTheWholeStreamOfAnInProcessRun`（70 KiB 單一 delta + 40 KiB）、`TestInflightRuns_*` |
| H2 | 沒有優雅關機；Dispatch 與 Wait 競爭；併發無上限 | `RunnerDispatcher.Shutdown(ctx)` / `Close()`：mutex 下的 closed 旗標（之後的 Dispatch 回 `ErrDispatcherClosed`；`wg.Go` 只在同一把鎖下呼叫）；每個 run 的 context 保留呼叫端的 values、由 base context（`AfterFunc`）與逾時取消；Shutdown 先等，ctx 到期就取消 base 再等寫回。`WithMaxConcurrent(n)` 信號量；等位子時被關掉的 turn 會寫回失敗（`the model run was cancelled`），job 以取消錯誤結束 | `TestDispatcher_ShutdownStopsRunsAndRefusesWork`、`TestDispatcher_MaxConcurrentBoundsRuns`、`TestDispatcher_ATurnWaitingForASlotIsFailedOnClose` |
| M1 | `CancelTurn` 先讀 pending 再取消「現在 pending 的那個」，中間換了一輪會用舊文字取消新的一輪 | store 加法：`CancelTurnFor(ctx, tenant, lineID, turnID, partial, …)`，在線鎖內比對 id，不符就不動；沒有 pending 時 Engine 不寫入（也不跑 hook） | `store/b3_additions_test.go` `TestB3_CancelTurnForOnlyCancelsTheNamedTurn` |
| M2 | turn cache 只在成功時清除 | `CompleteTurn`、`turnRefFor`、`RunTurn` 的 pending 檢查遇到 `ErrTurnNotPending` 都清掉該筆（`forgetTurnIfEnded`）；Dispatcher 走 `CompleteTurn` 所以一併涵蓋 | `TestReview_ATurnEndedByAnotherEngineIsForgotten`（兩個 Engine） |
| M3 | 在 `RunTurn` 註冊前落地的 cancel 擋不住 run；同一 turn 跑兩次會互相覆蓋 | 註冊後立刻 `store.GetTurn` 再確認；`inflight.add` 拒絕重複（`turn_pending` 碼、訊息 "this turn is already running"），`remove` 只刪自己那一筆；`OnDelta` 遇到 `ErrTurnNotPending` 或定期檢查發現已結束就取消 run | `TestReview_RunTurnSeesCancelsAndRefusesDuplicates` |
| M4 | 緩衝被逐出後 seq 從 1 重來 | 改成**整個行程一個遞增計數器**，起點是行程啟動時間（微秒）：同一條線的 seq 永不倒退，重啟後也比之前大。每個緩衝記 `lostUpTo`；cursor 小於它、或 cursor > 0 但緩衝不在 → `Truncated`。（與審查建議的「每條線的高水位」效果相同，但不需要另外保存、也不會無限長） | `TestDeltaRegistry_SequenceNumbersOnlyGrowAndTailAfterACursor`、`…ReportsWhatTrimmingAndEvictionLost` |
| M5 | runner 的原始錯誤與 panic 值被存進訊息並發出 | `publicRunError`：`RunnerError{Public, Err}`（runner 可以指定給操作者看的文字）→ `Public`；panic → "the runner crashed"；逾時 → "the model run timed out"；取消 → "the model run was cancelled"；其他 → "the model run failed"。細節只寫 log。`TurnResult.Error` 的註解寫明必須是給操作者的文字 | `TestReview_RunnerFailuresAreStoredAsFixedTexts` |
| M6 | `StartDraft` 的失敗清理用可能已取消的 ctx，且丟掉錯誤 | `abandonDraft` 用 `detached(ctx)`，失敗寫 log | `TestReview_AnAbandonedDraftIsEndedEvenWhenTheContextIsGone`（publisher 在 claim 後取消 ctx） |
| M7 | `CompleteTurn`、`AppendDelta`、`FinishJob` 收裸 id | doc comment 寫明只給 runner 端、不可暴露給 client | — |
| M8 | `DeleteTree` 不停 run、不清 cache | store 加法：`DeletedTree.PendingJobIDs`（`PurgedAside` 同）。Engine 的 `forgetLines`：取消這些 job 的 run（`RunnerDispatcher` 把 job 註冊進 `inflight`）、清掉這些線的 turn cache 與 delta 緩衝。**pending turn 不可能存在**：store 在樹上有回答中的線時拒絕刪除（`CountBusyLines`），所以 store 結果帶的是 job id 而不是 turn id | `TestReview_DeleteTreeStopsTheRunsOfItsJobs`、`TestB3_DeleteTreeAndPurgeReportThePendingJobsThatWent` |
| LOW | delta 緩衝沒有定期清掃 | `deltaRegistry.sweep()`，由 `Maintain` 呼叫（回報 `DroppedBuffers`） | `TestDeltaRegistry_SweepDropsExpiredBuffersAndEmptyTenants` |
| LOW | `turnCache.put` 在上限時 O(n) | `container/list` LRU（`turn_cache.go`），另有 `dropLines` | `TestTurnCache_IsAnLRUAndForgetsDeletedLines` |
| LOW | `DispatchJob` 的 `FinishJob` 沒有 recover | `finishJob` 包 recover | （無法用公開 API 觸發 panic；靠程式審查） |
| LOW | `MoveToBranch` 忽略 purpose 正規化的 ok | 檢查並傳正規化後的值 | `TestReview_MoveRefusesABadPurpose` |
| LOW | 宿主區塊用內建 key | domain 已改名為 `host:<key>`；`arranged` 只依改名後的 key 排列，所以假的 `branch_cards` 留在宿主區塊之間、不會被移到摘要之後 | `TestArranged_HostSectionsWithBuiltInKeysStayAmongTheHosts` |
| LOW | 未知 kind 的 job 留在 pending | `FinishJob` 找不到 JobHandler → job 標 failed（card_draft 走 `FinishBranchDraft`）並回 `feature_disabled` | `TestJobs_AJobOfAnUnknownKindHasNoHandler` |
| LOW | 摘要失敗後每一輪都再報 due | summary 模組記住失敗時間（本行程），`summaryBackoff` = 10 分鐘內不再報 due / 不再自動排程；成功的摘要清除 | `TestSummary_AFailedSummaryIsNotReportedDueAgainAtOnce` |
| LOW | turn 被取消時 run 的用量遺失 | store 加法：`RecordTurnUsage(ctx, turnID, usage)`（訊息上只記一次、加進線的累計；pending 回 `turn_pending`）。`RunTurn` 在 `CompleteTurn` 回 `ErrTurnNotPending` 且 run 成功時呼叫 | `TestReview_TheUsageOfACancelledRunIsRecorded`、`TestB3_RecordTurnUsageAddsToAFinishedTurnOnce` |
| LOW | `FeaturePolicy` 未接上 | 第二階段的 `modeOf` | 見下 |

## domain / store 的改動（只有新增）

- domain：`Prompt.Trailing`（`json:"trailing,omitempty"`；`systemText` 在摘要之後渲染，`section()` 也找它）、`PromptInput.OmitBranchSuggestRules`、
  `CodeFeatureDisabled = "feature_disabled"`、`ErrFeatureDisabled`、`FeatureDisabled(name)`（extra `feature`）。**前端錯誤碼清單需要補 `feature_disabled`**（我不能動 `web/`）。
- store：`CancelTurnFor`（`CancelTurn` 改為呼叫共用的 `cancelTurn`，行為不變）、`SaveSummaryInput.SkipTopicCut`、`DeletedTree.PendingJobIDs`、
  `PurgedAside.PendingJobIDs`、`RecordTurnUsage` / `RecordedUsage`。新 SQL：`ListPendingJobIDsForLines`、`AddLineUsage`、`SetFinishedMessageUsage`
  （`sqlc generate` 後 `sqlc diff` 乾淨）。測試 `store/b3_additions_test.go`（4 個）。

---

# 第二階段（B3c + B3d）· 功能模組

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 通過 |
| `go test ./... -count=1` | 通過：**335** 個頂層測試 PASS、0 FAIL、**0 SKIP** |
| `go test . -race -count=1` | 通過 |
| `gofmt -l .` | 無輸出 |
| `~/go/bin/sqlc diff` | 無差異 |
| 覆蓋率（`-coverpkg` 合併） | root 套件 **93.5%**（每個檔都 ≥ 85%）；`tangenttest` 新檔 100%；`store/turn_lookup.go` 81.6% |
| 大小 | 最大的新檔 `features_test.go` 439 行；我寫的函式（含測試）都 < 50 行（超過的只有 S1 / S2 留下的 store、domain 測試） |

| 工作單要求 | 測試 |
|---|---|
| 每個模組「開啟時行為正確、關閉時核心照常且 prompt 不含該功能」 | notes：`TestNotes_On…`、`TestNotes_Off…`；chapters：`TestChapters_On…`、`TestChapters_Off…`；aside：`TestAside_On…`、`TestAside_Off…`；summary：`TestSummary_Modes…`、`…AutoJobsAreDispatched…`、`…Off…`；card_draft：`TestFlow_MainLineToDeleteTree/all_on` 與 `/all_off`；branch_suggest：`TestTurn_CompleteIsOnceAndParsesSuggestions`（開）、`TestBranchSuggest_ManualAndOffParseNothing` |
| 依賴缺少時 `New` 回錯 | `TestNew_ReportsRegistryErrors`、`TestRegistry_RefusesMissingDependenciesDuplicatesAndBadNames`（含「設成 ModeOff 的功能不算啟用」） |
| `FeaturePolicy` 只能收窄 | `TestPolicy_OnlyNarrows`、`TestHooks_APolicyOffFeatureIsSkipped` |
| 第一階段整合測試在全開與全關都通過 | `TestFlow_MainLineToDeleteTree/all_on`、`/all_off` |
| 擴充點順序與交易內回錯整筆回滾 | `TestHooks_RunInOrderAndRollBackTheirWrite`、`TestHooks_HistorySectionsAfterCommitJobsAndMaintenance`（用 `export_test.go` 的 `StubFeature` 掛滿每個擴充點） |

效能（同第一階段的資料量，第二階段後重跑，`AllFeatures()`）：`BeginTurn` p50 7.1 ms / p95 12.9 ms；`CompleteTurn` p50 6.3 ms / p95 13.8 ms；
`ListBranches` p50 2.1 ms / p95 2.9 ms；`PreviewTurn` p50 4.3 ms / p95 5.4 ms。都在預算內（60 / 30 / 30 ms）。

## 機制

- **`Feature`**（未匯出 `mode()`、`register(*registry)`，封閉集合）。建構函式：`Notes()`、`Chapters()`、`Aside()`、`Summary(mode, opts...)`、
  `CardDraft(mode, opts...)`、`BranchSuggest(mode, opts...)`；`FeatureOption` / `JobModel(provider, model)`；`AllFeatures()`（notes、chapters、aside 開，
  summary suggest、card_draft manual、branch_suggest suggest）；名稱常數 `Feature*`。設成 `ModeOff` 的功能等同沒啟用。
- **模式解析** `modeOf(ctx, scope, name)` = 沒設定 → Off；否則 `min(設定的模式, FeaturePolicy.Mode(...))`，所以政策只能關或降級。
  沒有 AI 的功能內部以 `ModeAuto` 表示「開」。
- **擴充點**（`feature_hooks.go`，每個點依 `WithFeatures` 的順序執行，只跑對該 scope 開啟的功能）：

  | 擴充點 | 呼叫位置 | 交易內 |
  |---|---|---|
  | `ContextProvider`（`contextProvider`） | `assemblePrompt`；可填 `PromptInput` 的任何欄位（筆記區塊、摘要、建議規則、區塊） | 否 |
  | `HistorySelector`（至多一個，`New` 檢查） | `chooseHistory`，取代預設的 `HistoryScan` 歷史 | 否 |
  | `OnTurnCompleted` / `OnBranchCreated` / `OnBranchClosed`（`txHandler`） | `CompleteTurn`；`CreateBranch`、`MoveToBranch`；`MergeBranch`、`DiscardBranch`、`PromoteBranch`。包成一個 store `TxHook`，排在宿主的 `InTx` 之前（宿主看得到功能的寫入） | 是 |
  | `AfterCommit`（`afterCommit`） | 上述寫入與「摘要存好」之後；回傳要發的事件與要跑的 job（放進 `CompletedTurn.Jobs`） | 否 |
  | `JobHandler(kind)` | `FinishJob`；找不到 → job 標 failed、回 `feature_disabled` | 由處理者決定 |
  | 另外兩個內部點 | `ReplyFilter`（存回覆之前改寫內容：解析 `[BRANCH-SUGGEST]`；`OnTurnCompleted` 在寫入之後所以做不到）、`packSummary`（背景包要不要帶父線摘要，含 move 在鎖內建的包）、`maintainer`（`Maintain` 的定期工作） | — |
- **屬於功能的輸入**：核心只在三個輸入點用 `need(ctx, scope, feature)` 檢查（回 `feature_disabled`）：`kind=aside`（`branchKindFeatures` 表）、
  merge 的 `noteChanges`、`SuggestionMessageID`。其餘都走擴充點；功能自己的 API（`ListNotes`、`StartSummary`、`StartDraft`、`AddMilestone`…）在進入點檢查。
- **`Capabilities(ctx, scope) ([]Capability, error)`**：列出內建六個功能 `{name, enabled, mode?}`（mode 只在 AI 功能；DESIGN 寫 `Capabilities(scope)`，多了 ctx 給政策用）。
- **`Maintain(ctx) (MaintenanceReport, error)`**：`FailStaleTurns`（`WithStaleTurnAge`，預設 15 分，比 dispatcher 的 10 分逾時長）、`FailStaleJobs`
  （store 預設逾時 + 各 JobHandler 的逾時）、功能的定期工作（aside 清除）、delta 緩衝清掃；每一項都跑，錯誤 `errors.Join`。
- **`RunnerDispatcher`** 跑完 turn 後會把 `CompletedTurn.Jobs` 也派出去（summary auto）。

## 第一批模組

| 模組 | 開啟 | 關閉 |
|---|---|---|
| `notes` | ContextProvider 帶筆記區塊與 `NotesChanged`；AfterCommit：merge 寫了筆記就發 `notes.changed`；API `ListNotes`、`ApplyNoteChanges`、`UpdateNote`、`SupersedeNote`（都發 `notes.changed`） | prompt 無筆記；merge 的 `noteChanges` 與上述 API 回 `feature_disabled`；資料保留 |
| `chapters` | AfterCommit：摘要記了 topic cut 就發 `chapters.changed`；API `ListChapters`、`AddMilestone`、`DeleteMilestone` | summary 存檔時 `SkipTopicCut`；API 回 `feature_disabled` |
| `aside` | `kind=aside` 可建立；`Maintain` 清除過期 aside（`line.deleted`，並停掉其 job）；`PurgeExpiredAsides(ctx)` | 建立 / move 成 aside 回 `feature_disabled`；不清除 |
| `summary` | ContextProvider 帶摘要；packSummary；AfterCommit：suggest → `SummaryDue`，auto → 自動 `StartSummary` 放進 `Jobs`（manual 都不做）；JobHandler(summary)；`StartSummary`；失敗退避 | prompt 與背景包都不帶摘要（只靠 `HistoryScan`）；`StartSummary` 回 `feature_disabled` |
| `card_draft` | JobHandler(card_draft)；`StartDraft`；`JobModel` 決定起草的 provider / model（ready 的草稿也記這個） | `StartDraft` 回 `feature_disabled`，只能手寫卡片 |
| `branch_suggest` | suggest / auto：prompt 加規則、ReplyFilter 解析 `[BRANCH-SUGGEST]`；接受建議時重新比對 | manual：不加規則、不解析，但已存的建議仍可接受；off：不加規則、不解析、接受建議回 `feature_disabled` |

## 與契約的差異（第二階段）

1. `Capabilities(ctx, scope)` 多 `ctx`。
2. `card_draft` 的模式在 Engine 內沒有差別（都能 `StartDraft`）；auto 的「結束支線時自動起草」由前端看 `/capabilities` 後自動呼叫。若要 Engine 主動起草，需要一個「開始返回」的 API，目前沒有。
3. `branch_suggest` 的 auto 等同 suggest（建議永遠不自動執行，同 BACKEND_PLAN 建議匣規則）。
4. `PurgeExpiredAsides` 與 `Maintain` 是跨租戶的清掃，跟著**設定**而不是 `FeaturePolicy`（被政策關掉 aside 的租戶，過期 aside 仍會被清）。若要依政策保留，需要 store 依租戶篩選。
5. `JobHandler` 也跟著設定、不看政策：政策中途關掉功能時，已經在跑的 job 仍會被寫回。
6. 內部擴充點多了 `ReplyFilter`、`packSummary`、`maintainer`（見上）。
7. 摘要 job 的 `feature` 欄位改存 `summary`（第一階段是 `core`）；草稿 job 仍由 store 以 `core` 建立，`Job.Feature` 回傳 `card_draft`。
8. ContextProvider 的 token 預算分配（DESIGN §11「參與 token 預算分配」）尚未實作：各區塊仍是 domain 各自的預算（筆記 `Notes.TokenBudget`、歷史 `History.TokenBudget`）。

## 給協調者 / B4 的問題

1. 前端錯誤碼清單要加 `feature_disabled`（extra `feature`）。
2. `Maintain` 的 aside 清除要不要依租戶政策篩選（差異 4）？
3. card_draft auto 要不要有 Engine 端的觸發點（差異 2）？
4. ContextProvider 的共同 token 預算要在 B9（fisheye）一起做，還是現在先定介面？

---

# 第二階段審查修正（2026-10-15）

來源：協調者轉來的 go-reviewer 第二階段報告，以及 DESIGN §12「B3 階段二」的回覆（aside 清除依設定、`card_draft` 只有開 / 關、
`branch_suggest` 的 auto = suggest、共用 token 預算延到 B9）。新回歸測試在 `phase2_review_test.go`、`delta_test.go`、`features_internal_test.go`、
`store/b3_additions_test.go`，全部以 `-race` 跑過。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 通過 |
| `go test ./... -count=1` | 通過：**352** 個頂層測試 PASS、0 FAIL、**0 SKIP** |
| `go test . -race -count=1` | 通過 |
| `gofmt -l .` | 無輸出 |
| `~/go/bin/sqlc diff` | 無差異（新增 3 個查詢後重新產生） |
| 覆蓋率 | root 套件 93.3%（最低的檔 `feature_summary.go` 83.8%）；`store/engine_reads.go` 82.2% |

效能（`perfIterations` 改為 200，記 p50 / p90 / p95；資料量同前）：

| 操作 | p50 | p90 | p95 | 預算（p95） |
|---|---|---|---|---|
| `BeginTurn` | 6.45 ms | 7.69 ms | 8.12 ms | 60 ms |
| `CompleteTurn` | 6.08 ms | 7.01 ms | 7.31 ms | 30 ms |
| `ListBranches` | 2.17 ms | 2.56 ms | 2.77 ms | 30 ms |
| `PreviewTurn` | 4.37 ms | 5.04 ms | 5.25 ms | — |

## 修正

| 等級 | 問題 | 修正 | 測試 |
|---|---|---|---|
| H1 | 被逐出後重建的緩衝，比它舊的 cursor 回 `Truncated=false` | 每個新緩衝記 `startedAfter = r.next`（第一次遞增之前）；`Truncated = (afterSeq > 0 && afterSeq < startedAfter) \|\| afterSeq < lostUpTo`。看完整個舊緩衝的 cursor（= startedAfter）不算截斷 | `TestDeltaRegistry_ARecreatedBufferReportsOlderCursorsAsTruncated` |
| M1 | 超出範圍的模式讓功能保持開啟 | `clampMode`：≤ Off → Off，其餘 `min(m, Auto)`；`buildRegistry` 拒絕設定值不在四種模式內的功能 | `TestClampMode_…`、`TestRegistry_…`（Mode 7、-2）、`TestPhase2Review_InvalidPolicyModesAreClamped` |
| M2 | 失敗的 turn 的 job 被丟掉 | summary 的 AfterCommit 只在回覆成功（done 且未取消）時動作；失敗路徑（`failTurn`）回傳 AfterCommit 的 jobs：dispatcher 派出去，`BeginTurn` 內的失敗交給新的 `Engine.SetJobDispatcher(d)`（沒設定就記 log、留給 `FailStaleJobs`） | `TestPhase2Review_FailedTurnsStartNoSummaryAndKeepTheirJobs`、`…JobsOfATurnFailedInBeginTurnGoToTheJobDispatcher` |
| M3 | 回答結束的 aside 繞過 `OnBranchClosed` / `AfterCommit` | `turnTxHooks`：`OnTurnCompleted` 之後，結果帶 `EndedAsideLineID` 時在同一交易跑 `OnBranchClosed`；commit 後跑 `commitBranchClosed`（discarded） | `TestPhase2Review_AnAnsweredAsideRunsTheBranchClosedHooks` |
| M4 | `OnTurnCompleted` 一直失敗時 turn 卡 pending 到 15 分鐘清掃 | 新的 `Engine.failTurn`：不帶任何功能掛勾直接把 turn 標失敗（"the reply could not be recorded"），AfterCommit 照跑。`RunTurn` 在 `CompleteTurn` 回非 not-pending 錯誤時記 log 並呼叫它；dispatcher 與 `failUnbuiltTurn` 也改用它 | `TestPhase2Review_ARefusingTurnHookFailsTheTurnAtOnce` |
| M5 | 核心裡的功能知識 | (1) `jobHandler` 加 `onStale`（card_draft 重發支線）；未知 kind 以新的 `store.FailJob` 結束（store 自己知道 card_draft 要走 `FinishBranchDraft`）。(2) `Maintain` 不再看功能名：功能註冊具名的維護工作，報告改成 `MaintenanceReport.Tasks map[string]int`（aside 為 `TaskPurgeAsides = "aside.purge"`）。(3) summary 記不記 topic cut 改成可選合作：chapters `provide(capTopicCuts)`，summary 用 `cooperates(modes, capTopicCuts)` 查，不是 `Requires`。(4) notes revision：store 加 `CompleteTurnInput.SkipNotesRevision`，Engine 一律設 true；notes 模組的 `OnTurnCompleted` 在交易內用新的 `store.MarkNotesRevisionSent(ctx, tx, …)` 記錄（只在回覆成功時）。notes 關閉期間不記，重新開啟後 `NotesChanged` 為 true。(5) 輸入守門統一走 `requireInput(modes, input)`：核心只寫輸入名稱（`inputBranchKind(kind)`、`inputNoteChanges`、`inputSuggestion`），哪個功能擁有它寫在 `catalog` | `TestJobs_StaleDraftJobs…`、`TestAside_…`、`TestChapters_Off…`、`TestPhase2Review_NotesOffRecordsNoRevisionSent`、`TestB3_FailJob…`、`TestB3_NotesRevisionSentIsLeftToTheCaller` |
| M6 | 測試缺口 | 前一個掛勾寫入、後一個掛勾失敗 → 全部回滾、零事件（建立支線與 merge 兩種，merge 的卡片與筆記都沒寫入）；不合法的政策值 | `TestPhase2Review_AFailingLaterHookRollsBackEarlierHookWrites`、`…InvalidPolicyModesAreClamped` |
| LOW | `PromoteBranch` 讀不到支線時默默跳過 AfterCommit | 記 error log | `TestPhase2Review_PromotionRunsAfterCommit`（正常路徑；讀取失敗無法用公開 API 觸發） |
| LOW | 交易內、持鎖時呼叫 `FeaturePolicy` 6–8 次 | 每個呼叫在交易前用 `modesFor(ctx, scope)` 解析一次（每個已設定功能問一次政策），結果 `modeSet` 傳給所有擴充點 | `TestPhase2Review_ThePolicyIsResolvedOncePerCallWithTheTurnsActor`（一次 `CompleteTurn` 恰好 6 次） |
| LOW | `CompleteTurn` 的 scope 沒有 Actor | domain 加法 `MessageMeta.Actor`；store `BeginTurnInput.Actor` 記在 pending 訊息、`TurnRef.Actor` 讀回；turn cache 也記 actor。`CompleteTurn` 一律用 turn 的 scope（別的 Engine 也從 store 讀到） | 同上 |
| LOW | 等位子的時間算進 turn 逾時；逾時被存成「已取消」 | 逾時改在拿到位子之後才開始算（`waitContext` 只受 Shutdown 取消；拿到位子後才 `WithTimeout`），job 亦同。`stoppedText`：`DeadlineExceeded` → "the model run timed out"，其他 → "cancelled" | `TestPhase2Review_TimeoutsAreReportedAndStartAfterTheSlot`（3 個 150 ms 的 run、1 個位子、逾時 250 ms 全部成功；50 ms 逾時存成 timed out） |
| LOW | 被取代 / 已結束的摘要 job 也啟動退避 | 先 `FinishJob`，成功標成 failed 才記失敗 | `TestPhase2Review_ASupersededSummaryDoesNotBackOff` |
| LOW | 政策關掉被依賴的功能時，依賴它的仍開著 | `modesFor` 做依賴閉包：任何一個 requirement 是 Off，依賴者也是 Off | `TestPhase2Review_ADependentIsOffWhenItsRequirementIs` |
| LOW | `turnCache.dropLines` O(n·m) | 依 line 建索引（`byLine`） | `TestTurnCache_IsAnLRUAndForgetsDeletedLines`（含索引清空） |
| PERF | 量測樣本太少 | 200 次，記 p50 / p90 / p95 | 見上表 |
| PERF | `notesContext` 在 `BeginTurn` 重讀線、root、revisions | `beginInfo` 帶 `rootLineID`；只讀筆記（store 加法 `ActiveNotes(ctx, rootLineID)`，id 必須來自 store） | 既有 notes 測試 |
| PERF | `summaryAfterTurn` 每輪讀出全部未摘要訊息 | store 加法 `UnsummarizedSize(ctx, tenant, lineID)`（一個 SQL：卡片之前的訊息數與字元數）。`EstimateTokens` 介於 字元/4 與 字元+則數 之間：上界不到門檻 → 不 due；有 pending → 不 due；下界已到門檻 → due；其餘才讀訊息 | `TestSummary_*`、`TestB3_CheapReadsForTheEngine` |
| PERF | `cardNotices` 每張卡一次 `GetBranch` | store 加法 `BranchPurposes(ctx, tenant, lineIDs)`，一次讀完 | 既有卡片測試、`TestB3_CheapReadsForTheEngine` |

## API 變動（相對 `36c3e84`）

- `CardDraft(opts ...FeatureOption)`（不再收 `Mode`；DESIGN §12 只有開 / 關）；`Capabilities` 對 `card_draft` 不再帶 `mode`。`AllFeatures()` 跟著改。
- `MaintenanceReport`：`PurgedAsides` 改成 `Tasks map[string]int`；新常數 `TaskPurgeAsides`。
- 新增 `Engine.SetJobDispatcher(d Dispatcher)`。
- `RunTurn` 在 `CompleteTurn` 被掛勾拒絕時回傳已標失敗的 `CompletedTurn` 加原本的錯誤。

## domain / store 的改動（只有新增）

- domain：`MessageMeta.Actor`（`json:"actor,omitempty"`）。
- store：`BeginTurnInput.Actor`、`TurnRef.Actor`、`CompleteTurnInput.SkipNotesRevision`、`MarkNotesRevisionSent(ctx, tx, lineID, revision)`、
  `FailJob`、`ActiveNotes`、`BranchPurposes`、`UnsummarizedSize`（`store/engine_reads.go`）。新 SQL：`GetUnsummarizedSize`、`ListBranchPurposes`。
  store 內既有行為不變（沒設新欄位的呼叫者照舊）。
