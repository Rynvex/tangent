# F14 · 跨檔案／多 Session 時間序拼圖、小展開預覽與樹狀組裝匯入（對接 B19）

> 2026-11-03。工單（工單 20），設計交付包。基線 `main` @ `4c15cbc`（已含後端 B19，見 `docs/devlog/B19-import-timestamps-and-assembly.md`）。
> 純前端，只改 `web/` 與 `docs/`（這份 devlog 與截圖）；沒有改 Go、SQL、migration 或契約樣本。在獨立 worktree（`../tangent-f14`，分支 `f14`）由一個實作 agent 完成，未 commit。測試手冊與 HTML 指南、截圖複製到 NAS、CHANGELOG / HANDOFF / ROADMAP、合併與 :5183 由協調者做。
> 沒有碰 宿主；沒有動 :8120、:5183（看畫面用 :5191 的 mock dev server，看完就關；e2e 自己挑 port）；沒有寫 dev 資料庫 `tangent`；沒有呼叫付費模型（全部是 mock）。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 5 個專案全部通過 |
| vitest（逐一套件） | fonts **10**、client **1147**、react **1015**、demo **218**（開工時 10、1065〔worktree 裡含 B19 新樣本的 2 個契約測試是 1067〕、1010、205） |
| `pnpm -C web build` | 通過。主入口 JS **167,696 bytes gzip**（`gzip -c` `dist/index.html` 引用的 `index-*.js \| wc -c`；開工時 165,223，上限 172 kB） |
| `pnpm -C web/e2e e2e:mock --workers=2` | **158 passed、3 skipped、0 failed**（開工時 155 passed、3 skipped；新增 `f14.spec.ts` 3 個；審查修正前後各跑一次整套，兩次都是 0 failed，機器 load 約 6～8） |
| `git status --short` | 只有 `web/` 與 `docs/` 底下的變動 |

延遲載入：F14 的對話框全部在 `import-dialog` chunk（134.99 kB，gzip 42.64 kB）。主入口多出的約 2.5 kB 是對話檢視要用的 `ChapterStrip`、`TimeGapDivider`、`time-gaps.ts`（間隔與短日期）、對話框寬度 `split`、兩個新用語，以及 `useF13Frame` 的 toast／復原接線。

## 做了什麼

### 階段一：`@tangent/client`

**對接 B19（`b18-routes.ts`）**
- `IMPORT_MAX_CHAPTER_CUTS = 20`、`IMPORT_CUT_TITLE_MAX_RUNES = 60`、`IMPORT_FUTURE_SLACK_MS`、`IMPORT_EARLIEST`。
- `ImportMessageInput.createdAt?`；`ImportBranchInput.status` 多 `"merged"`、`card?`、`createdAt?`，支線訊息也可帶 `createdAt`；`ImportChapterCutInput`；`ImportConversationInput.createdAt?`、`chapterCuts?`。

**mock 的匯入（新檔 `testing/mock-import.ts`，從 `mock-b18.ts` 移出）**
- 檢查順序照 `domain.PlanImport`：source、則數、支線數、對話 `createdAt`、訊息（含每則 `createdAt`）、externalId 重複、每條支線（錨點、kind、status 含 `merged`、`createdAt`、則數、訊息、目的、卡片）、章節切點、進行中上限。
- 時間：非 RFC 3339 或 1970 以前、超過現在 + 24h 都是 `400 invalid_input`，`field` 同伺服器（`createdAt`、`messages[i].createdAt`、`branches[i].createdAt`、`branches[i].messages[j].createdAt`）；轉 UTC；`dateImportLine` 照 Go：線的開始取 `createdAt` 與第一則有時間的訊息中較早的，沒時間或比上一則早的取上一則（不倒退）；整個請求沒有任何時間時一律現在（B18 行為）。線的 `createdAt` / `lastActivityAt` / `updatedAt`、支線的 `createdAt` / `lastActivityAt`、結束的支線 `closedAt` = 最後一則。
- `chapterCuts`：上限 `min(20, maxMilestones)`、錨點必須是主線訊息且一則一個、標題壓成一行 1～`min(60, milestoneMaxLen)` 字；寫入 `chaptersByLine[root].milestones`（`chapters` 關著也寫），開著才發 `chapters.changed`。
- `merged` + `card`：缺卡、非 merged 帶卡是 400 `branches[i].card`；結論空白、引用訊息是 `422 invalid_card`，`problems[].field` 帶 `branches[i].card.` 前綴；`question` 空的用 `purpose` 補。先產生所有支線 id，寫主線時在錨點後**立刻**寫 `kind: branch_card`、`meta.delivered: true`、時間同錨點的卡片（同錨點依輸入順序）；`messageCount` 不算卡片；`leaf` 開著時寫 confirmed 葉子。
- 事件同 `Engine.importEvents`：主線 `line.created`、每條支線 `line.created` + `branch.changed{created}`、每個葉子 `leaf.changed`、`chapters.changed`。
- `mock-chapters.ts`：切點落在某章第一則時，那一章變成 milestone 章並用切點標題（同 `domain/chapters.go`；之前 mock 什麼都不做，所以匯入後的 §1 顯示成時間）。
- `mock-contract.test.ts` 加 `exerciseB19`（組裝匯入），`route.lines.import.assembled` 的形狀有一次真正對得上的呼叫。

**`suggested-tags.ts`**：照 `domain/decompose.go` 的 B19 修正，主題詞裡的雙字詞全部參與接合（含租戶已用的），只有非租戶標籤標 handled。`suggested-tags.test.ts` 加「租戶標籤在微分之後／之前／最後」三種順序（都得到 `微分幾何`、`幾何`、`研究`，沒有 `微分幾`、`分幾`，再清一次不變）。mock 的 decompose 本來就呼叫 `cleanSuggestedTags`，所以跟著改。

**解析器保留每則訊息的時間**
- `ParsedMessage.createdAt?`、`ParsedBranchMessage`、`ParsedConversation.timeSource?: "exact" | "file" | "none"` 與 `fileTime?`。
- ChatGPT `message.create_time`、Claude `created_at`、Gemini Takeout 的 `turn.time`（同一輪的提問與回答）、Tangent 備份 `message.createdAt`；還原的重問／重新生成支線訊息也帶。只有來源真的有時間才放 `createdAt`。
- 文字稿（`import-transcript.ts`）：標記行前面的 `[2026-08-12 14:30]`、標記後括號的 `(2026/08/12 14:30)`、或標記上一行單獨一行的日期時間，都是那則的 `createdAt`；可帶 `Z` 或 `+08:00`，否則當本機時間；不存在的日期（2/31）不算；對話的 `createdAt` / `updatedAt` 是第一則與最後一則。內文裡的日期不會被拿走。
- `ParseImportOptions.fileModifiedAt`：對話自己沒有任何時間時 `timeSource: "file"`、`fileTime` = 檔案修改時間（決定 #4）；貼上文字沒有就是 `none`。worker 協定一起帶 `fileModifiedAt`。
- `buildImportPlan`（F13 單篇）也送 `createdAt`（訊息、支線訊息、對話；分段匯入時只有第一段帶對話的開始），F13 的快速匯入因此也保留歷史時間。

**時間序與組裝（純函式）**
- `import-timeline.ts`：`sessionTimes`（手動設定 > `createdAt` > 第一則有時間的訊息 > `updatedAt` > 檔案時間 > 無；手動設定會平移整篇）、`sessionMessageTimes`、`orderByTime`（有時間的由舊到新，同時間或沒時間的依目前順序／勾選順序）、`moveSession` / `placeSession`、`findInterleaves`（決定 #1：開始時間落在前面某篇的 `[start, end)` 裡，只算真實時間）、`buildMiniExpand`（相鄰訊息間隔 ≥ 30 分鐘切段：`#a～#b`、輪數、首句、段內重問數、段前間隔、結尾第一句）、`sessionEnding`、`sessionGist`、`matchSession`（標題、再首問，帶命中前後文）、`selectionSummary`、`findDuplicate`（決定 #10）。
- `time-gaps.ts`（主入口用）：`timeGaps`、`describeGap`（「2 小時 37 分」／「2 h 37 min」）、`shortDateUnlessToday`、`clockTime`。
- `import-assembly.ts`：模式與角色（決定 #3 的預設角色、`effectiveRoles`）、`defaultAttachMessage`（章節裡時間 ≤ 支線開始的最後一則；比整章都早就掛第 1 輪回覆，否則第 1 則；沒時間掛最後一則）、`prefillSessionCard`（決定 #6：標題或首問 60 字、最後一則 AI 回覆第一句，不呼叫模型）、問題種類。
- `import-assembly-build.ts`：`buildAssemblyBlueprint` 產生預覽節點、依時間排好的 import body、阻擋原因與摘要數字。時間軸：每篇一章、兩章以上才在每章第一則下切點、超過 200 則擋下並建議樹狀圖但不自動切換（決定 #2）；樹：章節的訊息與還原版本 id 加 `cN-` 前綴、支線 `investigate` + `merged`/`open`、卡片、`createdAt`，支線超過 100 則、超過 20 條、進行中超過 8 條、章節超過 20 個、卡片結論空白、掛載點不再是章節（決定 #3 的「掛載位置不合法」）都擋下；20 條上限時先丟還原版本並計數；`standalone` 與批次每篇用 `buildImportPlan`；1970 以前或明天以後的時間也先擋下。
- `import-assembly-run.ts`：`runAssembly` 依序送出、失敗不中斷、回報進度；relations 開著時依時間序關聯第 k 與 k+1 篇（決定 #7），重試單篇時只關聯它和相鄰的；`undoAssembly` 用 `DELETE /lines/{id}` 刪掉這次匯入的主線（決定 #8）。
- 測試：`import-timeline.test.ts`、`import-assembly.test.ts`、`import-assembly-run.test.ts`（對 mock 跑：樹、批次關聯開／關、部分失敗再重試、復原）、`import-times.test.ts`、`time-gaps.test.ts`、`testing/mock-import.test.ts`；共用的設計稿五篇 fixture 在 `import-fixtures.ts`（不進建置）。

### 階段二：介面

**對話框（`frame/import-dialog.tsx` 改寫，`frame/f14/*`，全部在延遲載入的 chunk）**
- 寬 880（`DialogWidth` 加 `split`），手機全螢幕；上方 `ImportStepper`（完成的步驟可以點回去；每換一步，螢幕閱讀器用的步驟標題取得焦點）。
- S1：分段「貼上對話文字／Markdown」｜「上傳匯出檔（可以多個）」；`ImportFileChips`（多檔、分次加入、拖入時「放開以加入 n 個檔案／已載入的檔案會保留」、讀不懂的檔案錯誤色 + alert 並保留其他、移除）；`SessionPicker`（兩篇以上或多檔時有搜尋，「符合 n / total 篇」、全選符合的、標題高亮或「首問符合：…」、清單由新到舊；每列核取方塊、`TimeBadge`、標題、來源、規模；已匯入過的列警示且不自動勾選）；底部「已勾選 n 篇・共 m 則訊息・橫跨 …」、取消、快速匯入單篇（只勾 1 篇可用，走 F13 表單）、下一步。只有一篇時自動勾選。
- `TimeBadge` 三種外觀（真實時間 `Calendar`／`CalendarClock`、檔案時間 `FileClock` 警告底、未定時間虛線 `CalendarPlus`），點了打開 `SessionTimePopover`（日期、時間、目前用的是什麼、「存了以後會重新排序」、用檔案時間、套用；範圍外不能套用），套用後立刻重排。
- S2（左欄 372；手機「時間序 n｜結構圖」分頁，兩個分頁都保持掛載）：`SessionNodeCard`（拖拉把手與 Alt＋↑／↓、時間徽章、來源、角色膠囊即 `NodeRoleMenu`、標題、「問：… → 答：…」、小展開按鈕）；`MiniExpand`（時間段、`CirclePause` 間隔列「可以在這裡切章節」、重新生成數、`Flag` 結尾；點時間段才列出那幾則，可切換你 ⇄ AI、移除／恢復，不能改字，決定 #5）。
- S3（右欄）：`AssemblyModePicker`（三張單選卡，左右鍵；穿插或總數超過 200 標「建議」；relations 關閉時批次寫「同資料夾・不建立關聯」）；時間軸的穿插警示與 200 則警示都有「改用樹狀圖」；全部沒時間時說明；`BlueprintPreview`（主幹線、§ 節點、`└` 接出的支線與「掛在 §1 #4（14:58） 之後・時間穿插／依檔案時間」、沒有時間戳記標記；`BlueprintCardEditor` 點一下直接改結論，空白時「結論不能空白」並停用兩個匯入鈕；批次是同一資料夾與標籤的虛線框、相鄰之間 `Link2` 相關）；主線標題、資料夾與標籤（「改資料夾與標籤」展開）。`NodeRoleMenu`：四種角色（目前的打勾，模式不能用的變淡並說明）、「掛在」選單、上移／下移（決定 #9）；手機改成底部表；在時間軸選支線角色會切到樹狀圖。
- S4：`AssemblySummaryBar` 即時摘要（時間軸／樹／加上獨立對話／批次各有一句）、上一步、確認並純匯入、確認結構並展開拆解建議；匯入中「匯入中…（i / n）」；沒有建立任何東西時「沒有匯入成功：…［再試一次］」；批次部分失敗「n 條主線建好 k 條；「…」沒有建立：…［只重試這一篇］［完成］」，此時不能回上一步，直接關掉對話框也會把已建立的交給主畫面（含復原）。

**匯入後（`f13-frame.ts`、`f13-slots.tsx`、`f13-host.tsx`、`conversation-view.tsx`）**
- 對話框交出 `ImportOutcome`（建立的主線、要去哪一條、則數、是否展開拆解、toast 文字、復原）。主畫面切到第一條，底部 toast（15 秒）附「復原這次匯入」：若畫面正停在要刪的線，先回到匯入前那一條，再用 `useDeleteLine` 逐條刪除（快取立刻清掉），完成後提示「已復原：這次匯入的 n 條主線已刪除」。F13 的快速單篇也有同樣的 toast 與復原。
- 「確認結構並展開拆解建議」：桌面打開右側拆解面板；手機（窄版）不蓋住畫面，改顯示頂部橫幅「已匯入 m 則・k 項拆解建議［查看］」。拆解面板的章節切點卡有 `time_gap` 時標「依真實時間」。
- `ChapterStrip`（`@tangent/react`，新）：主線有兩章以上且有手動或匯入的切點時，在對話上方顯示 §n＋標題＋（非今天的）日期，目前章節高亮，按了捲到該章並把焦點移到章節分隔線。
- `TimeGapDivider`（`@tangent/react`，新）：同一條線上相鄰兩則對話間隔 ≥ 30 分鐘時，訊息之間一條虛線「間隔 2 小時 37 分・17:35」（`MessageList` 預設開，`timeGaps={false}` 可關；章節分隔線所在處不重複畫）。

**i18n**：設計稿用語表全部照抄（`frame/f14/f14-messages.ts`，zh-TW／en），另補狀態、問題與失敗文字；主入口只多 `timeGap.label`（react）與 `banner.assembled`（demo）。全部 lucide 圖示，沒有表情符號。

### 階段三：e2e 與截圖

- `web/e2e/tests/f14.spec.ts`（3 個測試，`timezoneId: Asia/Taipei`）：1440 完整流程（三個檔案、搜尋 pg 勾 5 篇、時間序、小展開與看原文、時間軸穿插警示、改用樹狀圖、角色選單與掛載點、結論卡空白擋下再改好、批次、主線標題、確認並展開拆解建議、章節列日期、時間空檔分隔、原位結論卡、拆解面板依真實時間、復原這次匯入）；設定檔案時間後重排與 Alt＋↓；375 全螢幕、兩個分頁、匯入後是橫幅而不是面板、沒有橫向捲動。
- fixture：`web/e2e/fixtures/f14/`（`chatgpt-pg.json` 6 篇、`claude-pg.json` 2 篇、`壓測筆記.md` 沒有時間；測試把 md 複製到暫存目錄並把修改時間設成 08/18）。demo 的 vitest 也讀同一組檔案。
- `f13.spec.ts` 改走新流程（勾選那一篇 →「快速匯入單篇」），其他斷言不變。

截圖 `docs/devlog/screenshots/F14/`（`UPDATE_SCREENSHOTS=1` 跑 `f14.spec.ts`，淺色，mock demo 的真實畫面）：
- `s1-pick-search-1440.png`：S1 三個檔案膠囊、搜尋「pg」符合 7 / 9、勾 5 篇、三種時間徽章（含檔案時間 08/18）、首問命中、底部摘要
- `s1-pick-375.png`：S1 手機全螢幕
- `s2-order-mini-expand-1440.png`：S2 由舊到新、PG 連線池設定的小展開（兩段、間隔 2 小時 37 分、重新生成、結尾）與 #5–#12 的原文列
- `s3-timeline-interleave-1440.png`：S3 時間軸章節圖、時間穿插警示＋改用樹狀圖、主幹＋支線樹標「建議」
- `s3-tree-role-menu-1440.png`：S3 主幹＋支線樹、壓測筆記的角色選單（掛為支線並留結論卡打勾、掛在 §2 #18、上移／下移）
- `s3-tree-card-editor-1440.png`：S3 樹、PgBouncer 那張結論卡編輯中
- `s3-batch-1440.png`：S3 批次獨立匯入（同資料夾框、相鄰「相關」）
- `s4-summary-bar-1440.png`：S4 確認列「將建立 1 條主線（3 個章節、2 條支線與結論卡，共 54 則訊息，跨度 08/12–08/20）・不呼叫模型」與主線標題、資料夾與標籤
- `s4-imported-main-line-1440.png`：匯入後主線：章節列 §1 08/12 → §2 08/15 → §3 08/20、原位結論卡、時間空檔分隔「間隔 2 小時 37 分・17:35」、右側拆解面板（章節切點「依真實時間」與「間隔很久」）、底部 toast 與「復原這次匯入」
- `s4-undo-toast-1440.png`：按下復原後回到原本的對話、「已復原：這次匯入的 1 條主線已刪除」
- `s2-tabs-time-375.png`、`s3-tabs-structure-375.png`：手機「時間序 5｜結構圖」兩個分頁
- `s4-banner-375.png`：手機匯入後的橫幅「已匯入 54 則・n 項拆解建議［查看］」（沒有自動打開面板）與 toast

## 和工單不同的地方

1. **元件放在哪裡**：設計表把 `TimeBadge`、`MiniExpand`、`BlueprintPreview`、`BlueprintCardEditor` 標為「套件」。這次只有對話檢視要用的 `ChapterStrip`、`TimeGapDivider` 放進 `@tangent/react`；對話框的元件都在 demo 的 `frame/f14/`（跟 F13 的匯入對話框一樣），規則全部在 `@tangent/client` 的純函式，其他宿主要用時再搬。
2. **檔案切法**：工單寫 `import-timeline.ts`；組裝規則太多，拆成 `import-timeline.ts`（時間與排序）、`import-assembly.ts`（規則）、`import-assembly-build.ts`（藍圖）、`import-assembly-run.ts`（送出與復原）、`time-gaps.ts`（主入口用的小函式），每個都在 400 行以內。
3. **`ImportBranchInput.card` 型別**：工單寫 `BranchCard`；照抽出（extract）用 `Partial<BranchCard>`，伺服器本來就接受只有結論的卡（契約樣本就是）。
4. **決定 #3 的區間**：用 `[start, end)`，而且只把真實時間（來源或手動）當區間。檔案時間沒有長度，一起解壓的檔案常常同一個修改時間，用 `<=` 會把後面全部當成支線（審查 HIGH）。
5. **檔案時間不送給伺服器**：`timeSource: file` 的對話只用檔案時間排序，不當成訊息的 `createdAt` 送出；B19 會讓它們接在上一則之後（不會倒退、也不會在章節間造出假的空檔）。使用者手動設定時間時才送（整篇平移；沒有任何時間的篇放在第一則）。
6. **章節列只在有切點時出現**：條件是兩章以上而且至少一章是 milestone（手動或匯入的切點）。NAS 等既有對話（只有話題／閒置章節）畫面不變；只要用拆解面板「一鍵建立章節切點」或匯入組裝就會出現。
7. **時間空檔分隔是全面的**：不只匯入的線，任何線都會在 ≥ 30 分鐘處出現（NAS 也會）；以純文字段落呈現而不是 `role="separator"`（a11y 審查：分隔線的內容會被當成裝飾，常常不被念出）。宿主可以 `timeGaps={false}` 關掉。
8. **復原的期限**：設計建議 10 分鐘；這次只在 toast 上（15 秒，比一般 toast 長）。沒有新路由也沒有記住匯入紀錄，toast 不見後就從清單刪除。
9. **快速匯入單篇**：仍是 F13 表單；F13 對話框上方的「已識別：ChatGPT 匯出檔」徽章由檔案膠囊的「ChatGPT・n 篇」取代；檔案只有一篇時自動勾選；沒有標題的文字稿以檔名（`壓測筆記.md` → 壓測筆記）或首問命名。
10. **重複匯入的判斷**：來源 id 只對 ChatGPT、Claude、Tangent 備份比對（Gemini 與文字稿的 id 不穩定）；另外比對已載入的主線（第一頁＋封存）同標題且同一天開始。只警示並預設不勾。
11. **用語的空格**：照設計表 `掛在 {pos} 之後`，`pos` 以全形括號結尾時畫面是「（14:58） 之後」，和設計稿畫面差一個空格；沒有改用語表。
12. **匯入後的單則時間與卡片標記**：設計 S4b 的「你・#3・14:52」與結論卡上的「匯入時建立・08/12 15:22」沒有做（要改 react 套件的訊息列與卡片，影響所有線；工單 §3 也沒列）。見「留著的」。
13. **橫幅用語**：組裝匯入用設計的 `已匯入 m 則・k 項拆解建議`；F13 的單篇匯入維持原本的 `已匯入 N 則訊息・有 K 項拆解與支線建議`。
14. **還原版本在組裝裡**：章節篇的重問／重新生成照 F13 還原成 discarded 支線（超過 20 條時先丟這些並說明）；被設成支線的篇自己的還原版本不匯入（匯入不支援第二層支線），不另外計數。
15. **重排**：拖拉與 Alt＋↑／↓ 只在桌面的把手；手機不畫把手（沒有長按拖拉），用角色選單的上移／下移（決定 #9）。結構預覽裡「方向鍵在節點間移動」沒有做，節點用 Tab 走。
16. **`NodeRoleMenu`**：是 popover（裡面一組 `menuitemradio`、一個原生的「掛在」選單、上移／下移），不是 Base UI Menu，因為選單裡要放 select。
17. **「建議」的條件**：決定 #2 寫「主線超過 200 則」；`recommendTree` 用的是所有篇合計（時間軸模式下兩者相同）。
18. **mock 章節**：切點在某章第一則時改用切點標題（同 Go）；這是對既有 mock 行為的修正，不是新功能。

## 審查與修正

唯讀的 typescript-reviewer 與 a11y-architect 兩個 agent，都沒有 CRITICAL。修掉的：
- TS HIGH：檔案時間被當成零長度區間，樹狀圖預設會把同一個修改時間的檔案全掛成支線 → 只算真實時間、`[start, end)`，加測試。
- TS MEDIUM：復原直接呼叫 `client.deleteLine`，沒有 SSE 時快取留著 → 改用 `useDeleteLine`（`forgetTree`）。復原總是把畫面拉回去 → 只有畫面正停在要刪的線時才回去（用 ref 讀目前的線）。部分失敗後關掉對話框會留下沒有復原的線 → 不能回上一步，關掉時也把已建立的交出去（只交一次）。獨立／批次的 16 MiB 檢查被丟掉 → 補上。單獨一行日期的 regex 對超長行是 O(n²) → 先擋 64 字以上的行，加計時測試。回到第 1 步會丟掉第 2 步的編輯 → 第 2 步打開過就一直掛著（隱藏），新勾的篇依時間加入。時間 popover 的點擊穿過 portal 讓列被勾選 → 先檢查 DOM 是否在列裡。時間範圍沒在前端擋 → 新的 `dateOutOfRange` 問題（含手動時間平移後）。
- TS LOW：拖拉取消後卡片一直半透明（`onDragEnd`）；問題清單的 key 可能重複（改 `<ul>`＋索引）；「沒刪掉」的提示有空的 `{reason}`（改寫用語）；`stampTime` 帶時區時日期檢查無效（改用 UTC 檢查）；`selectionSummary` 的註解。
- a11y HIGH：換步驟焦點掉到 body → 每一步有 `tabIndex=-1` 的標題「第 n 步，共 2 步：…」取得焦點。Alt＋↓ 讓把手失焦 → 移動後把焦點還給把手（有測試）。結論卡結束編輯失焦 → 回到「改結論」。角色改變讓節點重新掛載失焦 → 還給角色按鈕。角色按鈕與訊息角色鈕的名稱不含可見文字（2.5.3）→ 名稱以可見文字開頭（「§1 主線章節，「…」的角色」、「#5 你，改成 AI」）。
- a11y MEDIUM：手機分頁切換卸載另一頁（`aria-describedby` 指向不存在的元素、狀態遺失）→ `TabsPanel` 加 `keepMounted`。角色選單：roving tabindex、Home／End、打開時焦點在目前角色、不重複念名稱。重複匯入的警示用 `aria-describedby` 接到核取方塊。空白結論的按鈕有名稱。時間段按鈕改用可見內容當名稱。手機不畫無作用的把手，桌面把手加 `aria-keyshortcuts`。觸控尺寸：小按鈕加 `pointer-coarse:min-h-11`／`size-11`。移除檔案後焦點到「加入檔案」，載入結果有 `role=status`。章節列跳轉後焦點移到章節分隔線。時間空檔改成可念的文字。
- a11y LOW：對話框裡的 `<footer>` 改成 `div role=group`（不再是 contentinfo）、匯入中 `aria-busy`；結論空白不再兩個 alert 同時念；節點標題改 `h4`；批次的「改資料夾與標籤」有 `aria-expanded`；已移除的訊息有「（已移除）」。

沒有改的：
- `--tg-primary-text` 在 `--tg-accent` hover 底上是 4.47:1（既有的 token 組合，F13 起就這樣用）；11px 的「建議」「相關」小字。
- 進度只在按鈕文字上（有 `aria-busy`）、摘要 `role=status` 每次改都會念；時間設定的錯誤一律掛在時間欄。
- 還原版本支線的時間不跟著手動時間平移；關聯建立失敗只計數不提示、不重試。
- 組裝、預設角色等函式裡用了區域的 `push` / `let`（不共享的暫存，回傳值不可變）。

## 留著的

- 設計 S4b 的單則時間（「你・#3・14:52」）、結論卡「匯入時建立・時間」、分岔膠囊上的帶回時間（見上 12）。
- 「復原這次匯入」只在 toast 的 15 秒內；要 10 分鐘或跨重新整理需要記住匯入紀錄（或後端的批次 id）。
- 章節切點上限前端用 20；伺服器另外受 `MilestoneMaxPerTree` 限制，若部署設得比 20 小，前端會放行而由伺服器拒絕。
- 貼上的文字仍在主執行緒解析（F13 同樣）；很大的貼上可能卡一下。
- 關聯建立失敗沒有提示；部分失敗時 toast 的章節數是整份藍圖的數字。
- 主幹＋支線樹的 200 則提示沒有截圖（時間軸的穿插警示有；200 則的規則有 client 單元測試）。
- 結構預覽節點之間沒有方向鍵移動（Tab 可以走到每個按鈕）。

## 協調者驗收（2026-11-03）

- 在 worktree 重跑全部關卡：`pnpm -C web typecheck` 通過；vitest fonts 10、client 1,147、react 1,015、demo 218；`pnpm -C web build` 主入口 167,696 bytes gzip（上限 172 kB），`import-dialog` 與 `import-worker` 是自己的 chunk；`e2e:mock --workers=2` 158 passed、3 skipped、0 failed（8.0 分鐘，load 約 3～6）。
- 範圍：`git status` 只有 `web/` 與 `docs/`；工單 是 0644；新增的程式沒有表情符號、沒有 `console.log`；`shell.tsx` 只改一行（643 行不變）；F14 對話框只從延遲載入的 `import-dialog.tsx` 靜態引用。
- 截圖：`s2-order-mini-expand-1440.png` 與 `s3-timeline-interleave-1440.png` 是同一張（兩次拍攝之間畫面沒變，第 2 步左右兩欄同時看得到），NAS 圖鑑只放一張並在說明寫兩件事。
- NAS：截圖與 3 個測試檔（`chatgpt-pg.json`、`claude-pg.json`、`壓測筆記.md`）歸檔至交付目錄；測試手冊劇本六加第 6～10 節（B19 + F14），第 1 節改成新的「快速匯入單篇」流程；HTML 指南劇本六加步驟 6.9～6.13 與 12 張圖鑑卡。下載的 `壓測筆記.md` 修改時間是下載當天，手冊請測試者先手動設成 08/18 09:00（順便測決定 #4）。
- 沒有 Go 變更，:8120 不需重啟。
