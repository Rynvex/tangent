# S1 · `domain/` 套件

> 2026-10-15。從 宿主 `internal/service`（以及少數 `internal/handler`、`internal/storage` 裡的純邏輯）移植對話分支的型別與純函式。
> `domain` 只 import 標準函式庫與 `github.com/google/uuid`，沒有 IO。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 通過 |
| `go test ./domain/... -count=1` | 通過：127 個頂層測試（含子測試共 171 個 RUN），覆蓋率 94.7% |
| `gofmt -l .` | 無輸出 |
| `go list -deps ./domain` 的非標準函式庫依賴 | 只有 `github.com/google/uuid` |

測試先寫（從 宿主 移植並套上改名），確認編譯失敗（RED）後才寫實作。

測試數量：宿主 範圍內原有 82 個測試函式（`session_test.go`、`session_branch*_test.go`、`chapters_test.go`、
`conversation_notes_test.go`、`session_prompt_test.go` 共 79 個，加 `session_acp_test.go` 裡摘要相關的 3 個）。
保留並改寫 71 個，因功能移除刪掉 11 個（見下），新增 56 個（其中 18 個是 code review 修正的回歸測試）。

## 檔案對照（來源 → 目標）

| 宿主 | tangent `domain/` |
|---|---|
| `service/session.go`（對話型別、狀態、角色、`TransitionSessionStatus`、`ResolveTurnOutcome`、`truncateRunes` 等） | `line.go` |
| `handler/session_turn.go` 的 `historyBeforeTurn` | `line.go`（`HistoryBeforeTurn`） |
| `service/session_branch.go` | `branch.go` |
| `storage/postgres_conversation_branch_tx.go` 的 `checkBranchLimits`（純判斷部分） | `branch.go`（`CheckBranchCreate`） |
| `service/session_branch_pack.go` 的 token 估算 + `session_prompt.go` 的 `EstimateTokens`、`isCJK` | `tokens.go` |
| `service/session_branch_pack.go` 的 marker / 引用 / 控制字元處理、`CleanCardText` | `sanitize.go` |
| `service/session_branch_pack.go` | `branch_pack.go` |
| `service/session_branch_later.go` | `branch_pack_later.go` |
| `service/session_branch_card.go` | `branch_card.go` |
| `service/session_branch_card_render.go` | `branch_card_render.go` |
| `service/session_branch_draft.go` + `handler/session_branch_draft.go`（`draftOutcome`、`capReferences`、失敗文字）+ `storage/…_draft.go`（`BranchDraftOutcome`） | `branch_draft.go` |
| `service/session_branch_move.go` | `branch_move.go` |
| `service/session_branch_suggest.go` | `branch_suggest.go` |
| `service/chapters.go` | `chapters.go` |
| `service/conversation_notes.go` | `notes.go` |
| `service/session_summary.go` + `service/session_acp.go`（`SessionSummary`、`NormalizeSessionSummary`、trigger 門檻）+ `handler/session_summary.go`（`topicCutFor`、`summaryInputUpTo`、游標計算） | `summary.go` |
| `service/session_prompt.go`（歷史、規則、組裝） | `prompt.go`（`Prompt` 與三種輸出）、`prompt_build.go`（`BuildPrompt`） |
| `handler/session_branch_support.go` 等的錯誤碼、`storage.ParentMovedError` | `errors.go` |
| 各處的上限常數 | `limits.go` |

測試檔對照：`session_test.go`→`line_test.go`；`session_branch_pack_test.go`、`…_fix1_test.go`、`…_fix2_test.go`→`branch_pack_test.go`
（token 估算的測試移到 `tokens_test.go`，pack 進 prompt 的測試移到 `prompt_test.go`）；`session_branch_later_test.go`→`branch_pack_later_test.go`；
`session_branch_card_test.go`→`branch_card_test.go`；`session_branch_card_verbatim_test.go`→`branch_card_verbatim_test.go`；
`session_branch_history_test.go` + `session_branch_render_b3_test.go`→`prompt_history_test.go`、`summary_test.go`；
`session_branch_suggest_test.go`→`branch_suggest_test.go`；`chapters_test.go`→`chapters_test.go`（topic cut / 摘要解析移到 `summary_test.go`）；
`conversation_notes_test.go`→`notes_test.go`；`session_prompt_test.go`→`prompt_test.go`、`tokens_test.go`；`session_acp_test.go`（摘要 3 個）→`summary_test.go`。
新增：`limits_test.go`、`errors_test.go`、`branch_test.go`。

## 改名

| 宿主 | tangent |
|---|---|
| `Session` | `Line`（API 形狀）、`LineView`（加上 `conversationBranch`、`branchCounts`、`branchUnread`） |
| `SessionMessage` | `Message`（新增 `Seq int64`、頂層 `Kind`、`HostMeta json.RawMessage`、`LineID`） |
| `SessionMessageMeta` | `MessageMeta` |
| `SessionSummary` / `SessionSummaryLanding` | `Summary` / `SummaryLanding` |
| `SessionTurnUsage` | `Usage{InputTokens, OutputTokens, CostUSD}` |
| `ConversationNote` | `Note` |
| `SessionRoleAgent = "agent"` | `RoleAssistant = "assistant"` |
| `meta.kind`（`branch_card` / `branch_marker`） | `Message.Kind`：`chat` / `branch_card` / `branch_marker` |
| `workspaceId` | `tenantId`（`Line.TenantID`） |
| `SessionID` / `ParentSessionID` / `RootSessionID`（及 JSON） | `LineID` / `ParentLineID` / `RootLineID`（`lineId` / `parentLineId` / `rootLineId`） |
| `BranchView.SessionStatus`（`sessionStatus`） | `BranchView.LineStatus`（`lineStatus`） |
| `MessageMeta.BranchSessionID` | `MessageMeta.BranchLineID`（`branchLineId`） |
| `MessageMeta.NoticeMessageIDs`（`noticeMessageIds`） | `MessageMeta.DeliversCards`（`deliversCards`） |
| `MessageMeta.BranchSuggestions`（`branchSuggestions`） | `MessageMeta.Suggestions`（`suggestions`） |
| `MessageMeta.Tokens` / `CostUsd` | `MessageMeta.Usage *Usage` |
| `Session.SummaryUptoMessageID` | `Line.SummaryUptoSeq` |
| `BranchDraft.UptoMessageID` | `BranchDraft.UptoSeq` |
| `BranchPackInput.SummaryUpto time.Time` | `BranchPackInput.SummaryUptoSeq int64` |
| `ChapterBranch.SessionID` | `ChapterBranch.LineID` |
| `ConversationNote.SourceSessionID` / `NoteChange.SourceSessionID` | `SourceLineID`（`sourceLineId`） |
| `BranchOpenTailError.SessionIDs`（extra `sessionIds`） | `LineIDs`（extra `lineIds`） |
| `SessionStatus*` / `SessionMessage*` | `LineStatus*` / `Message{Pending,Done,Error}` |
| `TransitionSessionStatus` | `TransitionLineStatus` |
| `ErrSessionTurnPending` / `ErrSessionTransition` / `ErrSessionBusy` / `ErrBranchSessionArchived` | `ErrTurnPending` / `ErrStatusTransition` / `ErrLineBusy` / `ErrLineArchived` |
| `BuildSessionSummaryPrompt` / `ParseSessionSummary(WithCut)` / `SessionSummaryTokenCount` / `SessionSummaryMarker` | `BuildSummaryPrompt` / `ParseSummary(WithCut)` / `SummaryTokenCount` / `SummaryMarker` |
| `BuildSessionPrompt` / `BuildSessionResumePrompt` / `SessionPromptInput` | `BuildPrompt(...).Text()` / `.ResumeText()` / `PromptInput` |
| `renderSessionHistory` / `splitSessionHistory` / `renderSessionMessage` | `buildHistory` / `splitHistory` / `historyEntry` |
| 套件常數（`BranchSoftMaxDepth`、`BranchPack*`、`ConversationNote*`、`Chapter*`、`SessionHistoryTokenBudget`…） | `Limits` 的欄位（見下） |

## 移除的功能與測試

**移除的功能**（屬於 宿主 執行環境或 plan 功能，DESIGN §1 非目標）：

- Session 欄位：project / git root / git branch / agent id·name·role / transport / cwd / context（plan、task、conflict）/ resume id /
  daemon id·online / mode（ask、edit）/ worktree / tokens·costUsd·contextTokens 累計 / pendingPermissions / compactAvailable /
  shell / branchWaiting / turnQueued / carryContext。
- `awaiting_input` 狀態與 `[NEEDS-INPUT]`（`StripNeedsInput`、`NeedsInputMarker`）。
- shell session（`SessionKind*`、`ShellState*`、`ShellAudit`、`ShellPTYID`…）、ask/edit 模式（`SessionMode*`、`SessionWorktree`、
  `ResolveReadOnlyViolation`、`ReadOnlyUnverified`、`AskOnlySessionProviders`…）。
- clone（`BuildCloneSummary`）、`BuildSessionName`、`ConflictLabel` / `DecisionLabel` / `SameConflictRef`、citations、landed actions、
  `BuildProposalApproved/RejectedMessage`。
- prompt 的 plan / blackboard / task / conflict 區塊（`BuildSessionContextBlock`、`writeSession*`）、DAG proposal 協定、`BuildSyncSummary`、
  「cite T3/commits/C-3」與「do not invent tasks」規則（宿主改用 `PromptContributor` 加區塊）。
- 附件與圖片註記（`WithImageNote`、`MessageAttachment`、`ErrAttachmentGone`）：宿主放在 `host_meta`。
- 對話文件（Step 8 D：`DocumentsFull`、`DocumentsDelta`、`stripDocumentMarkers`、`[DOCUMENT]`）。
- 「支線讀主線 worktree」：`BranchReadSource`、`BranchReads*`、`cliProvidersWithReadOnlyMode`、`ProviderHasCLIReadOnlyMode`、
  `BranchView.ReadsFrom` / `Transport`、`BranchView.AwaitingUser` / `TurnQueued`。
- `BranchRefusalMode` / `BranchRefusalClone` / `BranchRefusalArchive`、`ErrBranchNotAgentSession`。
- daemon 相關：`CommandSessionTurn`、`CommandBranchDraft`、`ProviderHasToolFreeMode`、`DraftProviderCandidates`、`ParseDraftModelSetting`、
  `EnvBranchDraftModel`、`BranchDraftRefusedText`、`BranchDraftReportMaxBytes`、`ErrBranchDraftSuperseded`、summary model env、ACP compaction 門檻。
- prompt / pack 文字裡的 protocol marker 清單只剩 tangent 自己會解析的三個：`[SESSION-SUMMARY]`、`[BRANCH-CARD]`、`[BRANCH-SUGGEST]`
  （及其 `[/…]`）。宿主 另外會清掉 `[NEEDS-INPUT]`、`[DAG-PROPOSAL]`、`[DOCUMENT]`、`[SWARM-*]`、`[BLACKBOARD-ANSWER]`。

**刪掉的測試（11 個）**：

- `session_test.go`：`TestBuildSessionName`、`TestBuildCloneSummary`、`TestConflictAndDecisionLabels`。
- `session_prompt_test.go`：`TestBuildSessionPrompt_PlanContext`、`TestBuildSessionPrompt_ProposalProtocolOnlyWhenAnchored`、
  `TestBuildSessionPrompt_TaskContext`、`TestBuildSessionPrompt_ConflictContext`、`TestResolveReadOnlyViolation`、`TestBuildSyncSummary`。
- `session_branch_pack_test.go`：`TestBuildSessionPrompt_BranchDoesNotCarryTheDAGProposalProtocol`。
- `session_branch_render_b3_test.go`：`TestBuildCloneSummary_ShowsADeliveredCardFramedAndSkipsAnUndeliveredOne`。

**改寫但保留意圖的測試**：用到 `[NEEDS-INPUT]`、`[DAG-PROPOSAL]`、`[SWARM-RESULT]`、`[BLACKBOARD-ANSWER]` 的惡意輸入，改用 tangent 的 marker
（巢狀拆解技巧改成 `[BRANCH-[BRANCH-CARD]CARD]`）；`TestTransitionSessionStatus` / `TestResolveTurnOutcome` 拿掉 awaiting_input 的案例；
`TestBuildSessionPrompt_HistoryWindow` 與 `TestBuildSessionResumePrompt` 不再用 plan fixture；時間游標的 pack 測試改成 seq 游標。

## 有意的偏離（相對 宿主）

1. **排序一律用 seq。** `BuildBranchPack`、`BuildPrompt`、`BuildSummaryPrompt`、`TopicCutMessage`、`ComputeChapters`、`BuildBranchDraftPrompt`、
   `HistoryBeforeTurn` 都先依 `Seq` 排序（複製後排序，不改呼叫者的 slice）。摘要游標、pack 的摘要範圍判斷、draft 游標都改用 seq。
2. **`Limits`。** 所有可調上限集中在 `Limits{Branch, Pack, Notes, Chapters, History}`，`DefaultLimits()` = 宿主的值；
   **逐欄位**補預設：任何不是正數的欄位在使用時換成預設值（`WithDefaults`），所以部分填寫的 struct 不會把 0 帶進程式；
   `Validate()` 擋負數，以及補完預設後 soft > hard。結論卡的格式上限（`BranchCard*`、
   `BranchDraftInputTokenBudget`、`BranchDraftOutputMaxBytes`、`BranchConclusionLineMaxRunes`…）仍是常數，因為它們定義的是卡片格式。
   函式改成收 limits：`NormalizeBranchPurpose/Excerpt(…, BranchLimits)`、`ExtractBranchSuggestions(…, BranchLimits)`、
   `ComputeChapters(…, ChapterLimits)`、`CheckNoteText(field, text, maxRunes)`、`NormaliseNoteChanges(…, NoteLimits)`、
   `EffectiveBranchDraftStatus(…, timeout)`；`BranchPackInput.Limits`、`PromptInput.Limits` 是欄位。
3. **錯誤。** sentinel 改成 `*Error` 值（`errors.Is` 仍以身分比對）。`refine` 產生的錯誤帶具體訊息與 extra，`Unwrap` 回 sentinel。
   `CodeOf(err)` 取 code；`AsError(err, limits)` 產生新的 `*Error` 並補上 宿主 會送的 extra（limit、depth、movedMessages…），
   訊息只用 domain 自己的文字，不帶外層 wrap 的內部資訊，也不改 sentinel。`ParentMovedError` 從 storage 搬進 domain。
   `ErrBranchMoveCount` 的 sentinel 訊息改為固定的 "count is out of range"；`CheckMoveCount` 回傳 "count must be between 1 and N"。
   錯誤訊息裡的 "session" 改成 "conversation"（例如 `ErrBranchLimit`、`ErrBranchNotFound`）。
4. **Prompt。** 新的 `Prompt{Sections, Summary, Earlier, History, UserMessage, NotesChanged}`。除了任務描述的三個欄位外，多了
   `Earlier`（放不下的舊訊息濃縮段）、`UserMessage`、`NotesChanged`（`ResumeText` 需要）。`Text()` 在沒有摘要時與 宿主
   `BuildSessionPrompt` 的版面逐字相同（有測試 `TestPromptText_Layout`）：卡片通知 → `Agent instructions:` →
   規則 → 宿主區塊 → 筆記 → 背景包 → `## Conversation so far` → `## Operator's message`。宿主區塊放在 宿主 context block 的位置。
   `Chat()`：區塊、摘要、`Earlier` 進 system；歷史變成 messages，system 項（已送達的卡片、move marker、其他 system 訊息）以 user 角色送出。
   `ResumeText()` 對應 `BuildSessionResumePrompt`：卡片、變更過的筆記（或清空通知）、使用者訊息；宿主區塊不重送。
5. **摘要進 prompt（新功能）。** 宿主的完整 prompt 不放滾動摘要（它靠 resume 與整段歷史）。tangent 的 API runner 每輪都送整段，
   所以 `PromptInput.Summary` + `SummaryUptoSeq > 0` 時，游標以前的訊息離開歷史，改由 `## Conversation summary`（引用格式）代表。
   沒給游標、或摘要沒有會被呈現的內容（`HasContent()`：topic / decisions / openQuestions / files）就不使用摘要。
6. **規則文字。** "in an interactive session with an operator of this coding plan" → "in an interactive conversation with an operator"；
   拿掉 cite ids / do not invent tasks / NEEDS-INPUT 三條；支線與 aside 規則拿掉 "You can read the repository but you cannot change any
   file…"（ask 模式專屬）。角色標籤維持 `operator:` / `agent:`（雖然 role 已改名 assistant），以保持版面相同。
   draft 指示 "a side branch of a coding conversation" → "a side branch of a conversation"。摘要 prompt 文字與 `[SESSION-SUMMARY]` marker 原樣保留。
7. **時間欄位用 `time.Time`**（`Line`、`Message`、`BranchView`、`BranchPackMessage`、`Note`、`ChapterCut`、`Chapter.StartAt/EndAt`、
   `BranchDraft.StartedAt`）。JSON 仍是 RFC3339Nano 字串。`Summary.UpdatedAt` 仍是字串（它來自模型輸出，用 `time.Time` 會讓整份摘要解析失敗）。
8. **`HistoryBeforeTurn(history, pendingID, userMessageID)`** 用 id 去掉這一輪的使用者訊息，不再猜「最後一則 user 訊息」。
   **`ResolveTurnOutcome(content, runErr string)`**：不再吃 daemon 的 `SessionTurnResult`，也沒有 NEEDS-INPUT 分支；空回覆訊息改成
   "the assistant returned no content"。
9. **`BranchDetail`** 直接包含 `Draft` 與 `ParentTipMessageID`（宿主 是 handler 另外拼）。
10. **新增的純函式**（從 handler / storage 抽出，給 S2/S3 用）：`CheckBranchCreate`（hard 限制先於 soft）、`CheckMoveCount`、
    `DraftOutcome` / `DraftFailed`、`BranchCard.CappedReferencedIDs`、`HistoryBeforeTurn`、`SortBySeq`、`SummaryUptoSeq`、
    `SummaryInputUpTo`、`TopicCutFor`、`SummaryDue`、`ValidBranchOrigin`、`ValidNoteStatus`、`ValidLineStatus`、`ValidDeltaKind`。
11. **宿主 marker（`ExtraMarkers`）**：`PromptInput`、`BranchPackInput`、`BranchDraftInput` 有 `ExtraMarkers` 欄位，`BuildSummaryPrompt`、
    `CleanSummary` 收 `extraMarkers ...string`。它們會從函式庫產生的所有區塊（卡片通知、規則、筆記、背景包、摘要、濃縮歷史、起草 prompt、摘要 prompt）
    移除；宿主區塊與逐字歷史不動（與 宿主 一致：它也沒有清掉歷史裡的 `[NEEDS-INPUT]`）。跟函式庫自己的 marker 同名的項目會被忽略，
    以免把固定指示文字裡的 marker 清掉。另外匯出 `QuoteUntrusted`、`FlattenUntrusted`、`StripMarkers` 給宿主處理自己的區塊。
12. **`Chat()`**：濃縮歷史以引用格式（`> `）放進 system；相鄰同角色訊息合併（以空行相接）；第一則若不是 user，會在前面補一則固定的
    user 訊息 "(The conversation continues; earlier messages are summarized above.)"。
13. **內建區塊 key 保留**：宿主區塊若用到 `branch_cards` / `instructions` / `rules` / `notes` / `branch_pack`，key 改成 `host:<key>`。
14. **濃縮歷史與摘要 prompt 的訊息內文**改用 `branchLine` 攤平並清 marker（宿主 只用 `condenseLine`）；一般文字輸出不變，只有含 marker、
    fence、控制字元的內容不同。`ParseSummary(WithCut)` 回傳 `CleanSummary` 過的摘要：每欄攤平、topic ≤ 200 字、清單 ≤ 20 項且每項 ≤ 400 字、landings ≤ 5。
15. **`BranchPackInput.AnchorMessageID`**（選填）：有給就以它為 anchor（之後的訊息不算），`Check()` 在 anchor 不是已完成的 user / assistant 訊息時回
    `ErrBranchAnchorNotFound`。
16. **`BuildNotesBlock`** 自己依 `CreatedAt` 新到舊排序（同時間保留輸入順序），不再依賴呼叫者傳入的順序。
17. **`DESIGN.md` §6** 的錯誤碼範例 `depth_soft` 改成 宿主 實際的 `depth_soft_limit`。

## Code review 修正

go-reviewer 審查後修正的項目（HIGH / MEDIUM 每項都有回歸測試）：

| 等級 | 問題 | 修正 | 測試 |
|---|---|---|---|
| HIGH | `orDefault()` 只處理整個為零的 struct；`ChapterLimits{IdleGap: x}` 讓 `MaxCount = 0`，`capBoundaries` panic；`PackLimits` 的 `RecentMessages = 0` 也會 panic | 逐欄位補預設（`positiveOr`），`Validate` 改成擋負數 | `TestLimits_PartlyFilledStructsDoNotPanic`、`TestLimits_PartlyFilledStructsAreDefaultedFieldByField` |
| MEDIUM | `Chat()` 把未引用的濃縮歷史放進 system | 改成引用格式並清 marker | `TestPromptChat_EarlierHistoryIsQuotedData` |
| MEDIUM | `Chat()` 可能以 assistant 開頭、產生連續 user 訊息 | 合併同角色、必要時補開頭 user 訊息 | `TestPromptChat_StartsWithUserAndAlternates` |
| MEDIUM | `summarizeOlderHistory` 沒清 marker / 攤平 | 包一層 `branchLine` | `TestPromptChat_EarlierHistoryIsQuotedData` |
| MEDIUM | `BuildSummaryPrompt` 直接放內文與上一份摘要的原始 JSON | `branchLine` + `CleanSummary` | `TestBuildSummaryPrompt_NeutralisesBodiesAndThePreviousSummary` |
| MEDIUM | `ExtractBranchSuggestions` 只 `ReplaceAll` 一次，巢狀 marker 與 `[/BRANCH-SUGGEST]` 留下 | 重複清除開頭與結尾 marker | `TestExtractBranchSuggestions_NestedAndClosingMarkersDoNotSurvive` |
| MEDIUM | 要求宿主自己引用資料，但引用函式沒有匯出 | 匯出 `QuoteUntrusted`、`FlattenUntrusted`、`StripMarkers` | `TestExportedSanitizers` |
| MEDIUM | 只清 tangent 自己的 marker | `ExtraMarkers` 選項（非全域變數） | `TestPrompt_ExtraMarkersAreStrippedFromLibraryBlocks`、`TestBuildBranchPack_StripsHostMarkers`、`TestBuildBranchDraftPrompt_StripsHostMarkersButKeepsTheCardMarker`、`TestBuildSummaryPrompt_NeutralisesBodiesAndThePreviousSummary` |
| MEDIUM | 只有 landings 的摘要不呈現任何內容，卻讓 prompt 丟掉游標以前的歷史 | `Summary.HasContent()`，prompt 與背景包都改用它 | `TestPrompt_LandingsOnlySummaryDoesNotReplaceHistory`、`TestSummaryHasContent` |
| MEDIUM | 解析出的摘要沒有長度 / 數量上限 | `CleanSummary` 上限 | `TestParseSummary_CapsListsAndFields` |
| LOW | `AsError` 的副本沒有 cause，`errors.Is(AsError(err), ErrX)` 為 false；nil `*Error` 呼叫 `Error()` 會 panic | 副本保留 cause；nil receiver 防護；註明 sentinel 不可修改 | `TestAsError_KeepsTheCauseForErrorsIs`、`TestError_NilReceiverDoesNotPanic` |
| LOW | `lineBreaks` 等處用了原始 U+2028 / U+2029 / U+202E 字元 | 改用 `\u` escape（含測試檔） | 既有測試 |
| LOW | `HistoryBeforeTurn` 用猜的去掉使用者訊息 | 收 `userMessageID` | `TestHistoryBeforeTurn_OrdersBySeqAndDropsTheTurnItself` |
| LOW | 宿主區塊可用 `notes` key 劫持 `ResumeText` | 內建 key 保留，衝突改名 `host:<key>` | `TestPrompt_HostSectionsCannotTakeBuiltInKeys` |
| LOW | 背景包的 anchor 只是「seq 最大的訊息」 | `AnchorMessageID` + `Check()` | `TestBuildBranchPack_NamedAnchor` |
| LOW | `b.WriteString(fmt.Sprintf(...))` | `fmt.Fprintf` | — |
| LOW | `DESIGN.md` 寫 `depth_soft` | 改成 `depth_soft_limit` | — |
| LOW | `BuildNotesBlock` 依賴輸入順序 | 依 `CreatedAt` 排序 | `TestBuildNotesBlock_OrdersByCreatedAtNewestFirst` |
| LOW | `BuildBranchPack` 51 行 | 抽出 `fitQuotedMessages` | — |

沒有處理的 LOW：`branchDraftMessageTokenCap = 3000` 仍是常數（等於預設 `Pack.MessageTokenCap * 2`），不跟著 `Limits` 變動。

## 錯誤碼 → HTTP 狀態（S4 用）

宿主 原有的碼（字串不變）：

| Code | HTTP | Extra | 對應錯誤 |
|---|---|---|---|
| `depth_soft_limit` | 409 | `depth`, `limit` | `*BranchDepthSoftError` |
| `depth_hard_limit` | 409 | `limit` | `ErrBranchDepthHard` |
| `branch_limit` | 409 | `limit` | `ErrBranchLimit` |
| `tree_limit` | 409 | `limit` | `ErrBranchTreeLimit` |
| `parent_closed` | 409 | | `ErrBranchParentClosed` |
| `branch_closed` | 409 | | `ErrBranchClosed` |
| `archived` | 409 | | `ErrLineArchived` |
| `anchor_not_found` | 404 | | `ErrBranchAnchorNotFound` |
| `kind_unsupported` | 400 | | `ErrKindUnsupported` |
| `suggestion_not_found` | 404 | | `ErrSuggestionNotFound` |
| `aside_answered` | 409 | | `ErrAsideAnswered` |
| `branch_busy` | 409 | | `ErrBranchBusy` |
| `branch_drafting` | 409 | | `ErrBranchDrafting`、`ErrBranchPromoteDrafting` |
| `no_messages` | 409 | | `ErrBranchNoMessages` |
| `draft_not_pending` | 409 | | `ErrDraftNotPending` |
| `parent_busy` | 409 | | `ErrBranchParentBusy` |
| `parent_moved` | 409 | `movedMessages`, `movedCards` | `*ParentMovedError` |
| `invalid_card` | 422 | `problems` | `CardError(problems)` |
| `invalid_parent_tip` | 422 | | `ErrBranchParentTipUnknown`（以及 tip 不是 UUID） |
| `branch_not_main_line` | 409 | | `ErrDeleteNotMainLine` |
| `invalid_count` | 400 | `max` | `ErrBranchMoveCount` / `CheckMoveCount` |
| `not_enough_messages` | 400 | | `ErrBranchMoveTooFew` |
| `move_must_start_with_user` | 400 | | `ErrBranchMoveNotUserStart` |
| `move_protected_message` | 400 | | `ErrBranchMoveProtected` |
| `move_no_anchor` | 400 | | `ErrBranchMoveNoAnchor` |
| `source_busy` | 409 | | `ErrBranchSourceBusy` |
| `promote_not_top_level` | 409 | | `ErrBranchPromoteNotTopLevel` |
| `open_branches_on_old_tail` | 409 | `lineIds`（宿主：`sessionIds`） | `*BranchOpenTailError` |
| `session_busy` | 409 | | `ErrDeleteBusy`、`ErrLineBusy` |
| `note_not_found` | 404 | | `ErrNoteNotFound` |
| `note_superseded` | 409 | | `ErrNoteSuperseded` |
| `note_limit` | 409 | `maxActive`, `maxTotal` | `ErrNoteLimit` |
| `invalid_note` | 422 | `problems` | `NoteError(problems)` |
| `note_source_not_found` | 422 | | `ErrNoteSourceNotFound` |
| `milestone_not_found` | 404 | | `ErrChapterMilestoneNotFound` |
| `message_not_found` | 404 | | `ErrChapterMessageNotFound` |
| `milestone_exists` | 409 | | `ErrChapterMilestoneExists` |
| `milestone_limit` | 409 | `maxMilestones` | `ErrChapterMilestoneLimit` |
| `invalid_milestone` | 422 | `maxLength` | `ErrChapterTitleInvalid` |

tangent 新增的碼（宿主 當時回應沒有 code，狀態沿用）：

| Code | HTTP | 對應錯誤 | 宿主 原本 |
|---|---|---|---|
| `turn_pending` | 409 | `ErrTurnPending` | 409 無 code |
| `turn_not_pending` | 409 | `ErrTurnNotPending` | （daemon 回報時忽略） |
| `invalid_transition` | 409 | `ErrStatusTransition` | 內部錯誤 |
| `line_not_found` | 404 | `ErrLineNotFound` | 404 "session not found" |
| `branch_not_found` | 404 | `ErrBranchNotFound` | 404 "this session is not a branch" |
| `invalid_input` | 400 | `ErrInvalidPurpose`、`ErrInvalidExcerpt`，以及 httpapi 自己的 body 檢查 | 400 無 code（purpose、excerpt、anchorMessageId、content、promote 的 confirm） |

移除的碼：`not_agent_session`、`daemon_offline`、`branch_ask_only`、`main_daemon_offline`、`main_daemon_mismatch`、`draft_unavailable`
（宿主的 `TurnGate` 可以自己回傳 `domain.NewError("daemon_offline", …)`，S4 應把不認得的 code 對應成 409 或讓宿主擴充表）。
非 domain 錯誤（`CodeOf` 回 `""`）一律 500，訊息不外流。

## `domain` 的公開 API

型別

- `Line` — 一條對話線（API 形狀）；`LineView` — 加上支線記錄、`BranchCounts`、`BranchUnread`；`LineView.IsMainLine()`。
- `Message` / `MessageMeta` — 訊息與函式庫的 meta；`Message.IsCard()`。`Usage`（`TotalTokens()`）、`Delta`。
- `Summary` / `SummaryLanding` — 滾動摘要；`Summary.IsEmpty()`。
- `BranchRef`（`IsOpenForTurns()`）、`BranchCounts`（`Add`、`Total`）、`BranchView`、`BranchDetail`、`BranchCreateCheck`。
- `BranchPack` / `BranchPackMessage` / `BranchPackInput` — 背景包。
- `BranchCard`、`BranchCardEvidence`、`BranchCardDecision`、`BranchCardExcerpt`、`BranchCardProblem`、`BranchCardRefs`、`BranchCardNoticeItem`、
  `BranchDraftInput`、`BranchDraft`、`BranchDraftOutcome`。
- `BranchSuggestion`。`Note`、`NoteChange`、`NoteProblem`。`ChapterMessage`、`ChapterCut`、`ChapterBranch`、`Chapter`。
- `Prompt`、`PromptSection`、`ChatMessage`、`PromptInput`、`BranchPromptInfo`、`TurnOutcome`。
- `Limits`、`BranchLimits`、`PackLimits`、`NoteLimits`、`ChapterLimits`、`HistoryLimits`。
- `Error`、`BranchDepthSoftError`、`ParentMovedError`、`BranchOpenTailError`；`Code*` 常數與 `Err*` sentinel（見上表）。

函式

- `DefaultLimits()`、`Limits.WithDefaults()`、`Limits.Validate()` — 上限。
- `NewError`、`CodeOf(err)`、`AsError(err, limits)`、`CardError(problems)`、`NoteError(problems)` — 錯誤。
- `TransitionLineStatus`、`ValidLineStatus`、`ResolveTurnOutcome(content, runErr)` — 線狀態與一輪的結果。
- `SortBySeq`、`HistoryBeforeTurn(history, pendingID, userMessageID)` — seq 排序與這一輪看得到的歷史。
- `EstimateTokens`、`EstimatePackTokens` — token 估算（CJK 加權）。
- `StripAgentMarkers`、`StripMarkers`、`CleanCardText`、`QuoteUntrusted`、`FlattenUntrusted` — 清除 marker、中和卡片文字、引用 / 攤平不可信資料。
- `ValidBranchKind`、`ValidBranchOrigin`、`NormalizeBranchPurpose`、`NormalizeBranchExcerpt`、`CheckBranchCreate` — 開支線。
- `BuildBranchPack`、`BranchPackInput.Check()` — 背景包（含「之後發生的事」段落）與 anchor 檢查。
- `ValidateBranchCard`、`CheckBranchCardShape`、`SanitizeBranchDraft`、`DecodeBranchCardJSON`、`ParseBranchDraft`、`BranchCard.ReferencedIDs`、
  `BranchCard.CappedReferencedIDs` — 結論卡驗證與解析。
- `RenderBranchCardMarkdown`、`BranchConclusionLine`、`BuildBranchCardNotice`、`BuildBranchDraftPrompt` — 卡片呈現、通知、起草 prompt。
- `EffectiveBranchDraftStatus`、`DraftOutcome`、`DraftFailed` — 起草狀態與結果。
- `CheckMoveCount`、`BranchMoveMarkerText` — move。
- `ExtractBranchSuggestions`、`FindBranchSuggestion` — `[BRANCH-SUGGEST]`。
- `ComputeChapters` — 章節。
- `ValidNoteSection`、`ValidNoteStatus`、`NeutraliseNoteText`、`CheckNoteText`、`NormaliseNoteChanges`、`BuildNotesBlock` — 筆記。
- `NormalizeSummary`、`CleanSummary`、`Summary.HasContent()`、`BuildSummaryPrompt`、`ParseSummary`、`ParseSummaryWithCut`、`TopicCutMessage`、`TopicCutFor`、`SummaryInputUpTo`、
  `SummaryUptoSeq`、`SummaryTokenCount`、`SummaryDue` — 滾動摘要與 topic 切點。
- `BuildPrompt(in)`、`Prompt.Text()`、`Prompt.Chat()`、`Prompt.ResumeText()` — 組 prompt 與三種輸出。

## 給 S2 / S3 的待決問題

1. **store 要保存什麼（prompt 組裝需要）**：`tangent_line.summary` + `summary_upto_seq`；`notes_revision` / `notes_revision_sent`；
   pending assistant 訊息的 `meta.deliversCards` 與 `meta.notesRevision`（`CompleteTurn` 成功時才標 `delivered`、寫 `notes_revision_sent`）；
   `tangent_branch.pack` = `BranchPack` JSON（`recent[]` 帶 seq）；`draft` = `BranchDraftOutcome` JSON（card / warnings / error / provider / model，
   `Status` 存在 `draft_status` 欄）；`draft_upto_seq`、`draft_parent_tip_message_id`。
2. **每輪要讀的資料**：游標之後的訊息（依 seq；沒有摘要時是整條線，要不要加掃描上限？宿主 是全讀）；未送達的卡片
   （依 seq 最舊優先，最多 `Limits.Branch.NoticeMaxPerTurn`，加上來源支線的 purpose）；主線的 active 筆記（新的在前）與 revision。
3. **開支線要讀的資料**：父線到 anchor（含）的訊息最多 `Pack.HistoryScan` 則、anchor 之後最多 `Pack.LaterScan` 則（依 seq）、父線摘要與游標。
4. **`requireBranchAcceptsTurn` 沿祖先鏈的檢查、merge / move / promote 的檢查**仍在 store 交易裡做（S2）。目前只抽出 `CheckBranchCreate`；
   S2 若需要可以再抽同類的純判斷函式。
5. **宿主自己的 protocol marker**：domain 已有 `ExtraMarkers` 欄位 / 參數；S3 的 Engine 需要一個 option（例如 `WithExtraMarkers`）把清單傳進
   `BuildPrompt`、`BuildBranchPack`、`BuildBranchDraftPrompt`、`BuildSummaryPrompt`。已存的卡片 / 筆記文字本身不清宿主 marker，只在組 prompt 時清。
6. **摘要在 `Text()` 的行為**：宿主的 CLI resume 流程不需要摘要取代歷史；接回時 宿主 只要不傳 `SummaryUptoSeq` 就保持原樣。
   S3 的 Engine 預設要不要傳游標（API runner 需要）？
7. **`Chat()` 已合併相鄰同角色訊息並保證第一則是 user**；S4 的 runner 不必再處理。
8. **`HostMeta` 為 nil 時 JSON 是 `null`**；store 讀出時應填 `{}`（資料庫預設 `'{}'`）。
9. **Line 的用量累計**（宿主的 tokens / costUsd / contextTokens）沒有移植；S3 決定要不要在 line 上累計 `Usage`。
10. **摘要 prompt 文字**仍寫 "operator/agent coding session"、marker 仍是 `[SESSION-SUMMARY]`（為了與 宿主 相同）；要不要改成中性用語，S3 決定。
11. **Summary landings**（`suggestedLandings` 的 note / decision）保留在型別與解析裡，但 tangent 還沒有對應的動作；S3 可以把 `note` 對到 `ApplyNoteChanges`。
12. **錯誤碼表**：S4 的 httpapi 依上表把 code 對應到狀態碼；不認得的 code（宿主自訂）預設 409 或可擴充。
