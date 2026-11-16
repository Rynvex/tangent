# G3 · 開分支 / 結論卡 / 收尾的 prompt：準確率與 token

> 2026-11-15。工單。實作 agent 完成，**未 commit**。
> 與 G1 同一個工作目錄並行：G3 只改 `domain/`、根套件的 `prompt.go`、`feature_branch_suggest.go`、`feature_card_draft.go`、`feature_leaf.go` 與根套件測試；沒有碰 `web/`、`cmd/`、`httpapi/`、`store/`、`runner/`、`runner.go`、`branch_b5.go`。
> 零付費呼叫：只跑離線單元測試與 `:5444` 的測試資料庫。沒有碰 宿主。

## 改了什麼

### 一、開分支

1. **背景包依選取文字縮小**（`domain/branch_pack.go`、`domain/limits.go`）：`PackLimits` 新增 `ExcerptRecentMessages`（預設 3，0 / 負值照慣例回預設，`Validate` 拒絕負數）。`Excerpt` 不是空白時，整則引用的訊息數取 `min(原本的視窗, ExcerptRecentMessages)`（順口問仍不超過自己的 4）；其餘照既有邏輯變成單行摘要（`digestLines`）與滾動摘要。錨點一定是最後一則；沒有選取時完全不變（契約樣本的背景包都不變）。背景包只在建立時算一次並存起來，所以分支內每輪的 pack 區塊不變。
2. **依支線類型的規則**（`domain/prompt_build.go`、`prompt.go`）：`BranchPromptInfo` 新增 `Kind`，引擎傳 `detail.Branch.Kind`。`investigate`、`alternative` 各多一行規則（約 +50 token），`aside`（`Aside` 或 `Kind == aside`）維持原本的單問單答，`Kind == ""` 與舊規則逐字相同。目的仍經 `branchLine`（攤平、去標記），整個規則區塊仍經 `StripMarkers`。`topic_marker.go` 改用同一個 `isAside()` 判斷。
3. **支線內不帶 `BranchSuggestRules`**：只有主線預設帶；支線要帶得設 `BranchPromptInfo.SuggestBranches`（opt-in，引擎不設；順口問永遠不帶；`OmitBranchSuggestRules` 仍優先）。回覆中 `[BRANCH-SUGGEST]` 的解析與串流過濾不變（模型自己寫了仍會被收成建議）。`feature_branch_suggest.go` 只更新註解。

### 二、結論卡草稿（`card_draft`）

1. **不再整包貼背景包**：`BranchDraftInput` 新增 `Excerpt`、`Anchor *Message`。標題區塊改成「Branch purpose」＋「Where the branch started」（選取文字原文引用、錨點訊息單行摘要 ≤ 300 字）。只有支線完成訊息 ≤ 2 則**且**沒有選取文字時，才附背景包並截到 1,200 token（截斷時標 `[background cut]`）。
2. **分叉後主線分級**：仍取最近 30 則（`BranchDraftParentSinceMessages`）；最新 5 則整則引用（預算同樣是 `remaining/4`），較舊的每則一行（`> [M3] agent: …`，≤ 160 字），由新到舊塞到預算用完。以前超出 `remaining/4` 的較舊訊息是**直接不見**，現在至少留一行，衝突仍看得到。
3. **短代號**（新檔 `domain/branch_draft_ids.go`）：標題改成 `### [B1] branch message (operator)`、`### [M1] main-line message (agent)`，依 `seq` 由舊到新編號（M 只編 prompt 顯示的那 30 則）。`DraftShortIDs` 是 `BranchDraftInput` 的純函式；`ResolveCard` 把 evidence / excerpts 的 B 代號、needsDecision 的 M 代號換回 UUID（容忍 `[B2]`、`b2`、前後空白），`ResolveNoteChanges` 換 `sourceMessageId` 的 B 代號。其他值原樣保留：真的 UUID 照常驗證；`B999`、放錯欄位的 `M1`（evidence）或 `B1`（decision）解析不到，交給既有的 `SanitizeBranchDraft` 丟掉並記警告。
4. **根套件還原**（`feature_card_draft.go`）：新的 `draftSources` 依 claim 的游標讀資料——支線取 `seq ≤ uptoSeq` 的完成對話，父線取錨點之後、**到 claim 當時的父線 tip 為止**（`messagesUpTo`）。起草時用 `claim.UptoSeq / ParentTipMessageID`，完成時用 `detail.Draft.UptoSeq / ParentTipMessageID`（同一列），重建同一份編號，在 `cardRefs` 之前 `resolveDraftIDs`。起草期間主線繼續往前走，M 代號意義不變（根套件測試涵蓋）。錨點用 `GetMessage` 讀（不存在就略過）。
5. **excerpts 指示收緊**：「short verbatim pieces (a key command, a number or a core fragment of 1-3 lines)… Never copy long passages」。卡片格式上限（`BranchCardExcerptMaxRunes` 1,500）不變。

### 三、收尾草稿（`leaf_draft`）

1. `leafDraftInputTokenBudget` 12,000 → **4,000**；每則上限 700 token（`leafDraftMessageTokenCap`）。
2. 組裝：全部塞得下就全部原文；否則**第 1 則原文 + 中段每則一行（由新到舊塞到預算用完，標出省略幾則）+ 最後 4 則（兩輪）原文**。標題不再帶 UUID（收尾不需要引用），改 `### [n] operator`。
3. `LeafDraftInput.Excerpt`（`feature_leaf.go` 傳 `detail.Branch.Excerpt`），有選取時出現「Where the branch started」。先前的主線沒有選取文字，靠永遠保留的第 1 則補起點。
4. 提示詞：`dead_end` 要寫出具體原因（API 限制、太慢、假設不成立…）；`to_continue` 要寫做到哪裡、還剩什麼；先前的主線要說切換前做到哪裡、還有什麼沒定。

## Token 估算（`EstimatePackTokens`）

固定資料（`domain/g3_token_budget_test.go` 同一組）：主線 20 則 × 約 600 詞、支線 12 則 × 約 800 詞、分叉後主線 15 則 × 約 400 詞、收尾支線 30 則 × 約 600 詞。「改前」是用 `git archive HEAD domain` 解到 scratchpad 跑同一個量測得到的。

| 階段 | 改前 | 改後 | 說明 |
|---|---:|---:|---|
| 背景包，沒有選取 | 5,755 | 5,755 | 不變 |
| 背景包，有選取 | 5,800 | 3,564 | −39%；整則 3 則＋17 則單行摘要 |
| 結論卡草稿：標題區（指示＋目的＋起點／背景） | 6,317 | 659 | −90%；不再貼背景包 |
| 結論卡草稿：分叉後主線 | 3,833（只看得到 6/15 則） | 3,536（5 則原文＋10 則單行，15/15 都看得到） | |
| 結論卡草稿：支線對話 | 13,591（11/12 則） | 14,515（12/12 則） | 省下的預算讓給以前被截掉的支線訊息 |
| 結論卡草稿：總計 | 23,741 | 18,710 | −21%；總預算 24,000 沒改，所以長支線省得比標題區少 |
| 結論卡草稿：2 則的短支線、沒有選取（標題區／總計） | 6,268 ／ 8,747 | 1,865 ／ 4,292 | 背景包截到 1,200 |
| 收尾草稿 | 11,442 | 4,257 | −63% |
| 支線的規則區塊（每輪，進穩定前段） | 253 | 122（無類型）／173（investigate）／180（alternative） | 拿掉 131 token 的建議規則 |
| 指示文字本身：結論卡／收尾 | 490 ／ 149 | 531 ／ 187 | 多了短代號與原因的說明 |

## 提示詞前後

- 支線規則（`Kind == ""` 逐字不變）。新增：
  - investigate：`- This branch investigates one question: verify it, and keep what the background or evidence confirms apart from unconfirmed guesses. End each reply with one or two sentences to bring back to the main line.`
  - alternative：`- This branch explores an alternative to the approach at the branch point: compare the assumptions behind each, the main differences, pros and cons and when to choose which. Do not restate background the main line has already settled.`
- 結論卡：
  - 前：`evidence: ids of the branch messages … copied exactly from the message headings`、`mainLineMessageId is the main-line message id from its heading`、`excerpts: at most 3 verbatim pieces (a command, a number) …`、`Use only ids that appear in the headings below.`；標題 `### branch message <36 字 UUID> (agent)`。
  - 後：`Message ids are the short ids in square brackets: B1, B2, … for branch messages, M1, M2, … for main-line messages after the fork. Write them without the brackets and never make one up.`、`evidence: the B ids …`、`mainLineMessageId is that message's M id, or empty`、`excerpts: at most 3 short verbatim pieces (a key command, a number or a core fragment of 1-3 lines) … Never copy long passages.`；範例 JSON 帶 `"B1"`、`"M1"`；標題 `### [B2] branch message (agent)`。
- 收尾：
  - 前：`Use dead_end when the branch was abandoned (say why), to_continue when it stopped half-way.`；先前的主線 `Say where it stood.`
  - 後：`Use dead_end when the branch was abandoned: name the concrete reason it failed or was given up (for example an API limit, too slow, an assumption that did not hold). Use to_continue when it stopped half-way: say how far it got and what is left.`；丟棄的支線 `… name the concrete reason it failed or was given up.`；先前的主線 `Say how far it had got before the switch and what was still open.`

## 測試

新增：
- `domain/branch_pack_excerpt_test.go`：有選取時只整則引用 3 則、錨點保留、token 至少減半；空白選取等於沒選；自訂上限與順口問視窗；選取版仍去標記、不能偽造標題。
- `domain/prompt_branch_rules_test.go`：三種類型各自的規則與互斥、目的去標記與攤平、類型規則 ≤ 60 token、建議規則只在主線（opt-in、順口問、`OmitBranchSuggestRules` 的優先序）、規則與背景包區塊在兩輪之間逐字相同。
- `domain/branch_draft_ids_test.go`：短代號依 seq 編號、prompt 不再出現 UUID；`B2`／`[b1]` 還原後通過 `SanitizeBranchDraft` 與 `ValidateBranchCard`；混用真 UUID；`B999`、放錯欄位、`B1x` 被丟掉並有警告；筆記來源還原；編號是決定性的且只編顯示的 30 則。
- `domain/branch_draft_prompt_test.go`：背景包只在「≤ 2 則且沒選取」出現且截到 1,200；起點區塊引用並去標記、錨點摘要有上限；分叉後主線 5 則原文＋單行摘要，摘要仍看得到衝突內容。
- `domain/leaf_draft_test.go`：短支線全文、長支線頭＋中段單行＋尾兩輪且順序正確、超大訊息仍在預算內、選取文字與失敗原因／先前主線的指示。
- `domain/g3_token_budget_test.go`：上表四個階段的基準（`t.Logf` 印數字並設上限）。
- `g3_prompt_test.go`（根套件，連 Postgres）：`StartDraft` 的 prompt 用短代號、帶選取與錨點、不貼背景包；起草中主線又多一輪後 `FinishJob`，`B2`、真 UUID、`[B2]` 還原正確、`B999` 只產生一個警告，草稿直接 merge 成功；兩則短支線保留背景；investigate / alternative 支線回合的 system 有各自規則、沒有建議規則，主線有；`StartLeafDraft` 帶選取文字。

刻意修改的既有測試：
- `domain/limits_test.go`：預設值多 `ExcerptRecentMessages: 3`；「自訂的子結構原樣保留」的 `custom` 補上這個欄位（否則 0 會被補成 3）；`Validate` 多一個負值案例。
- `domain/prompt_test.go`：`TestPrompt_BranchGetsThePackAndTheBranchRules` 原本斷言「支線仍可建議支線」，改成斷言預設不帶（工單 2.3 的行為改變）；`TestPrompt_ExtraMarkersAreStrippedFromLibraryBlocks` 的支線設 `SuggestBranches: true`，讓「函式庫自己的標記在規則裡不被宿主清單刪掉」這個斷言仍有東西可測。
- `domain/branch_card_test.go`：`TestBuildBranchDraftPrompt_QuotesTheBranchAndCapsTheInput` 原本斷言 UUID 在 prompt 裡，改成斷言 `[B1]`、`[M1]` 在、UUID 不在。
- `flow_test.go`：`flowCard` 同上改成斷言 `[B2]`；回覆仍用真 UUID，順便驗證向下相容。

沒有放寬任何安全測試；新的 prompt 區塊都有去標記／不能偽造標題的測試。

## 偏離工單之處

1. **「`SectionBranchPack` 仍 `Stable: true`」**：程式裡沒有 `Stable` 欄位；穩定前段是 `prompt.go` 的 `stableSectionOrder` 決定的，沒有改。另以測試確認同一條支線兩輪之間規則區塊與背景包逐字相同。
2. **短代號不存表**：工單說在 parse 前建立對照表；表不存（不能動 `store/`），而是完成時用 claim 游標重建。代價：父線部分改成「到 claim 時的 tip 為止」，claim 當時 tip 之後只有系統通知（tip 定義就是最新的相關訊息），這些通知不再出現在草稿 prompt。殘餘風險：支線超過 `HistoryScan`（200）列、而且起草的 3 分鐘內宿主往這條支線加系統通知，視窗會位移、B 編號錯位；還原出的 id 仍必須是這條支線的訊息才會通過驗證，最壞是引用到相鄰訊息。
3. **2.3 的作法**：選了「主線才預設帶、`BranchPromptInfo` 提供 opt-in」；回覆解析不動。
4. **沒有改 `BranchDraftInputTokenBudget`（24,000）**：工單沒要求；省下的標題區預算由以前被截掉的支線訊息用掉，所以長支線總量只降 21%。若要再省，可另開工單把它降到例如 16,000。
5. `draftBlocks(label, …)` 保留給 goal / drift / group 的 prompt（它們的輸出逐字不變），新增 `draftBlocksWith` 給結論卡與收尾用。
6. 收尾的「先前的主線」不另外讀背景包，用永遠保留的第 1 則當起點。收尾標題拿掉 UUID。

## 邊界外、需要協調者處理

1. **`httpapi` 契約樣本要更新**：`route.spinoff.detach`、`route.suggestions.accept.spinoff`、`route.lines.archive`、`route.lines.unarchive` 不符。逐行比對過，差異**只有**支線訊息 `meta.usage` 的 `inputTokens` / `costUsd`（fake runner 依 prompt 長度計量；支線少了建議規則，例如 453 → 405）。確認後執行 `go test ./httpapi -update`（`httpapi/testdata/` 不在 G3 的範圍）。前端不受影響（欄位沒變，只是樣本數字）。
2. `TestChatRequest_IsWhatRunTurnSends`（`b70_test.go`）失敗是 G1 在 `runner.go` 加的 `HostMeta`（`HostMeta:[123 125]` vs `[]`），與 G3 無關。

## DESIGN.md 需要補的決定（本工單沒有改 DESIGN.md）

建議在 §12.3 / §12.10 加：
- `PackLimits.ExcerptRecentMessages`（預設 3）：有選取文字時背景包只整則引用最近 3 則（順口問不超過 4），其餘單行摘要與滾動摘要。
- 支線 prompt 規則依 `kind` 多一行（investigate / alternative）；`[BRANCH-SUGGEST]` 規則只在主線，支線要 `BranchPromptInfo.SuggestBranches` 才帶；支線回覆仍會解析建議。
- 結論卡草稿：訊息用短代號 `B<n>` / `M<n>`，完成時依 claim 的 `uptoSeq` 與父線 tip 重建後還原成 UUID，真 UUID 仍可；不再整包貼背景包（只在 ≤ 2 則且沒有選取時附 ≤ 1,200 token）；分叉後主線最新 5 則原文、較舊的單行；父線讀到 claim 時的 tip 為止。
- 收尾草稿：輸入預算 4,000 token、每則 700；頭 1 則＋中段單行＋尾 4 則；帶選取文字；`dead_end` 要具體原因。
