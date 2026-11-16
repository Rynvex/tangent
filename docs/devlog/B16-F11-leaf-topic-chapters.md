# B16 / F11 · 秒問葉節點、主題要約與主線章節

> 2026-10-26。工單 `10_B16_F11_LEAF_TOPIC_CHAPTERS.md`。後端（Part A · B16）和前端（Part B · F11）分在不同 worktree 平行做，協調者驗收後合併、commit。

## Part A · B16（後端）

> 在獨立 worktree（`../tangent-b16`，分支 `b16`，從 `ed106fd` 開）裡做，**沒有改 `web/`**（`git status` 沒有 `web/` 的變更）。
> Go 測試用 `tangent_test`；smoke 用 :8121 與 `tangent_smoke`。沒有碰 :8120、:5183、使用者的 `tangent` 資料庫或 宿主，也沒有呼叫付費模型。
> `[TOPIC]` 與 `[CHAPTER]` 都是隨正常回合附帶的回覆行（同 `[BRANCH-SUGGEST]` 的架構），**沒有任何額外的模型呼叫**。

### 驗收

| 檢查 | 結果 |
|---|---|
| `~/go/bin/sqlc diff` | 無差異（沒有改查詢或 migration） |
| `go vet ./...`、`gofmt -l .` | 通過、無輸出 |
| `go test ./... -count=1` | 全部 ok（審查修正後：root 73.2s、store 47.2s、httpapi 16.8s，其餘套件也都 ok） |
| `bash scripts/smoke.sh`（:8121） | `SMOKE PASSED (803 events)`（審查修正前後都是）。新增一步「B16: [TOPIC] names a new conversation and a branch, [CHAPTER] cuts a main-line chapter」，`/events` 檢查清單加 `chapters.changed` |
| `web/` | 沒有變更 |

新增與修改的測試（新增 19 個）：

| 檔案 | 內容 |
|---|---|
| `domain/topic_marker_test.go` | 6 個：`ExtractTopicSummary`（合格、`[/TOPIC]` 收尾、JSON 壞掉、不是物件、後面有雜字、空標題、超過 36 字、剛好 36 字、多行取第一個合格的且全部拿掉、行中的標記只拿掉不解析、壓成一行並拿掉其他標記、行首的零寬字元、`TitleMaxRunes` 更小時）；`ExtractChapterCut`（合格、太長、先壞後好、行中、`TopicTitleMaxRunes`）；`StripAgentMarkers`；`WantsTopicSummary` 的條件表（主線長 / 短 / 剛好 20 字 / 沒有標題、有歷史、失敗的回覆不算歷史、有摘要、有選取、獨立出來的新對話、支線目的長 / 短 / 剛好 25 字、順口問、支線有歷史）；`ChapterCutDue`；`reply_lines` 區塊只在有要時出現、穩定的規則區塊不變、`ResumeText` 也帶、支線不帶章節規則 |
| `stream_filter_internal_test.go` | 1 個：兩種標記被切在不同 delta 也不送出；任何切法串流出來的文字和存下的回覆逐位元組相同 |
| `b16_test.go`（engine，fake runner） | 11 個：規則在 `ChatBlocks` 的不快取段（兩種都測）；第一輪進行中使用者改名會保留（有標題的主線、支線），沒有標題的主線進行中被設暫時標題仍換成主題；`RenameBranch` 被拒（觸發器擋下目的的更新）或 `RecordTopicCut` 被拒（觸發器擋下 insert）時回合照樣完成、沒有 `chapters.changed`；主線第一輪改標題（`line.updated`、`CompletedTurn.Line`、第一章用主題命名、`chapters.changed`）、之後的 `[TOPIC]` 只拿掉；短訊息不改、沒有標題的線會改；不合格的標題什麼都不改；支線目的 > 25 字改目的（`branch.changed{renamed}` + `line.updated`，不記章節）、短而刻意的目的不改、順口問永遠不改；別的 Engine 完成的回合只拿掉標記行；主線兩輪後才有 `[CHAPTER]` 規則、切點落在這一輪的使用者訊息、`chapters.changed`、切完下一輪又沒有規則；支線沒有章節規則；`chapters` 關著只拿掉標記行（主題照常改，因為是核心） |
| `runner/fake/fake_test.go` | 1 個：`[fake:topic]` / `[fake:chapter]` 產生可解析的行 |
| `domain/limits_test.go` | 預設值斷言 `IdleGap` 2h → 30m |

契約樣本（`go test ./httpapi -update`，19 個）：沒有任何欄位增減，只有值與陣列元素：

- `route.chapters.list`：`limits.idleGapMinutes` 120 → 30。
- `route.preview`、`route.preview.fisheye`、`route.preview.folds`、`route.preview.group`、`route.preview.memories`：`blocks[]` 多一個 `key: "reply_lines"` 的元素（排在記憶之後、歷史之前），`prompt.trailing[]` 多一個同 key 的區塊（原本沒有尾段的樣本因此出現 `trailing`），`totalTokens` / `estimatedCostUsd` 跟著變；`rules` 區塊和 `main` 完全一樣。
- 第一輪多了要約規則，所以其他樣本的 `usage.inputTokens` / `costUsd` 變了：`lines.read/archive/unarchive/export/get.inbox/get.rich`、`messages.list.pending/rich/tagged`、`messages.tag(.draft)`、`branch.promote`、`cancel`。

### 實作

| 項目 | 做法 |
|---|---|
| domain | 新檔 `domain/topic_marker.go`：`TopicMarker = "[TOPIC]"`、`ChapterCutMarker = "[CHAPTER]"`（加進 `agentMarkers()`：串流過濾、`StripAgentMarkers`、所有不可信文字的清理都會拿掉）；`TopicSummaryRule`、`ChapterCutRule`（工單原文）；`WantsTopicSummary(in, lineTitle)`；`ChapterCutDue(chapters, own)`（`ChapterCutMinMessages = 4`）；`ExtractTopicSummary(content, TextLimits)`（≤ `TopicSummaryMaxRunes` 36 與標題上限）、`ExtractChapterCut(content, ChapterLimits)`（≤ `TopicTitleMaxRunes`）。兩個抽取器共用 `extractTitleLine`：以標記開頭的行（判斷同 `MarkerLineStart`）全部拿掉，取第一個合格的 `{"title":…}`（`branchLine` 壓成一行、拿掉標記），其他行裡的標記與收尾形式也拿掉；不合格就是 `""`，從不報錯。`PromptInput.RequestTopicSummary` / `AllowChapterCut` 由 `BuildReplyLinesBlock` 組成自己的區塊 `SectionReplyLines`（`reply_lines`，章節規則只給主線），不進穩定的規則區塊；`ResumeText` 也帶它。`Chapters.IdleGap` 預設 30 分鐘 |
| 核心：要約的條件 | `assemblePrompt` 在選完歷史之後呼叫 `WantsTopicSummary`：第一輪 = 沒有完成的歷史訊息（失敗的回覆不算，所以重試第一輪仍算）、沒有魚眼選取、沒有摘要；不是順口問，也不是帶起始膠囊的獨立新對話；主線且第一則訊息 > 20 字或沒有標題；支線且**目的** > 25 字 |
| 核心：prompt 位置 | `reply_lines` 列在 `trailingSections`，由 `arranged` 移到不快取的尾段最後（卡片通知 → 宿主尾段 → 其他支線的結論 → 記憶 → `reply_lines`）。規則出現或消失（第一輪、第 3 輪起、切章後）不再讓穩定段的快取失效 |
| 核心：記住這一輪要了什麼 | `turnRef.asks`（`topic`、`chapterCut`、`userMessageID`，以及 prompt 看到的主線標題或支線目的 `seen`）在 `turnPrompt`（`BeginTurn` / `RetryTurn` / `LoadTurn`）組好 prompt 後寫進記憶體的 turn 快取。`PreviewTurn` 不寫 |
| 核心：完成 | `CompleteTurn` 對成功的回覆先 `extractTitleLines`（兩個抽取器，一律拿掉），再跑功能的 ReplyFilter。標題只在 `asks` 有要時保留。commit、發完這一輪的事件之後（AfterCommit 之前），`applyTopic` 先重讀線：主線若 `seen` 不是空的而現在的標題不同 → 不改（使用者在這一輪進行中改了名）；`seen` 是空的照改（網頁送出第一則訊息後立刻設暫時標題，主題要取代它）。支線現在的目的不等於 `seen` → 不改；順口問直接跳過。要改時主線 `Engine.UpdateLine(title)`、支線 `Engine.RenameBranch(purpose)`，驗證、鎖、事件都是手動改名那一套；被拒只記 WARN，回合已經完成。`CompletedTurn.Line` 是重讀或改名後的線。重讀與改名之間仍有極短的空窗（接受） |
| `chapters` 模組 | `feature_chapters.go` 多註冊 `chaptersContext`（ContextProvider）：只在主線；先用既有的 `store.ReplyCount`（一個 count，`line_id` 索引）擋掉完成回覆少於 2 則的線（`chapterCutMinReplies`），前兩輪不讀章節；再用 `store.ListChapters` 算出的最後一章扣掉卡片與這一輪的使用者訊息（組 prompt 時已存）≥ 4 則 → `AllowChapterCut`。讀取失敗只記 WARN、不加規則（不讓整輪失敗）；`RecordTopicCut` 失敗也只記 WARN。`chaptersAfterCommit` 多處理 `commitTurnCompleted`：有 `[CHAPTER]` 標題用它，否則用主線第一輪的 `[TOPIC]`，以既有的 `store.RecordTopicCut` 記在這一輪的使用者訊息，有新切點才發 `chapters.changed`。`commitEvent.reply` 帶這些資料 |
| fake runner | `[fake:topic]` → 回覆末尾加 `[TOPIC]{"title":"Fake topic"}`；`[fake:chapter]` → `[CHAPTER]{"title":"Fake chapter"}`。只在訊息帶指令時才加，所以既有的 e2e:mock 與 smoke 行為不變 |
| 文件 | DESIGN §2（章節一列）、§6（`CompleteTurn` 註解）、§12.10 兩列；`DECISIONS_LOG.md` 同樣兩列；API.md（`POST /messages` 完成時的改名與切章事件、`GET /chapters` 的說明）；EXTENSIONS 總表（`chapters` 一列、核心行為）；EMBEDDING（`CompleteTurn` 要在組 prompt 的同一個 Engine 上） |

鎖與事件：

- 改名不在回合的交易裡，是 commit 之後再呼叫 `UpdateLine`（鎖那條線）或 `RenameBranch`（`lockBranch`），所以鎖順序與既有路徑相同；事件都在各自 commit 之後發。
- 切章用 `RecordTopicCut`（一個 insert，同一則訊息已有 topic 切點就不寫）；在 AfterCommit 裡，事件在它 commit 之後發。
- 排序一律依 `seq`（章節計算本來就是）。

### 核心還是模組

- `[TOPIC]` 放在**核心**：DESIGN §11 的規則是「核心程式碼裡不寫 if feature enabled」，而改標題與支線目的本來就是核心（`UpdateLine`、`RenameBranch`），沒有任何功能的資料。做成模組會多一個要宿主打開的開關，卻沒有可關的東西。
- `[CHAPTER]` 的**規則與記錄**放在 `chapters` 模組（ContextProvider + AfterCommit）；**拿掉標記行**放在核心，這樣 `chapters` 關著時回覆裡也不會留下標記。

### 和工作單不同的地方

1. **支線的要約條件只看目的**（協調者決定）：工單寫「使用者問題或支線目的超過 25 字」。範本化的第一個問題通常就超過 25 字，若看問題，短而刻意的目的（例如「了解：豪斯多夫維度」）會被模型的標題覆蓋，所以只看目的 > 25 字。
2. **獨立出來的新對話（帶起始膠囊）不要約**：它的標題來自 spinoff（支線目的或指定的名字），也是刻意的。
3. **事件名稱**：工單寫支線發 `branch.updated`，實際沿用手動改名的 `branch.changed{change: renamed}` 加支線的 `line.updated`。
4. **標題只在組 prompt 的同一個 Engine 完成時才用**：要約與切章依賴「這一輪的 prompt 有沒有要」，這記在記憶體的 turn 快取。重啟後或別的程序完成的回合（沒先 `LoadTurn`）只拿掉標記行。沒有存進資料庫，因為 prompt 是在 commit 之後才組的，要存就得多寫一次。
5. **太長的標題直接當無效**（不截斷）：`[TOPIC]` > 36 字、`[CHAPTER]` > `TopicTitleMaxRunes`（120）就不用。截斷可能留下半句。
6. **「4 則已完成訊息」的算法**：用既有的章節計算（`ListChapters` 的最後一章），扣掉卡片與這一輪自己的使用者訊息；宿主系統訊息照算（章節計算本來就算它）。
7. **選做項目（第一章的名字）有做**：主線第一輪拿到 `[TOPIC]` 且 `chapters` 開著時，在第一則使用者訊息記 topic 切點。章節計算本來就把第 0 則當起點，切點落在那裡只會把第一章的 `kind` 變成 `topic`、`title` 變成主題，不會多出空章（有測試）。
8. **「回覆少於 2 則就不讀章節」的擋法**（審查第 3 點）：用既有的 `ReplyCount`，沒有新查詢。它比「最後一章 ≥ 4 則」稍嚴：完成的回覆少於 2 則、卻靠宿主系統訊息或失敗回覆前的使用者訊息湊到 4 則的線，不會拿到章節規則（實務上沒有影響）。之後每一輪仍是 count + `ListChapters`（每輪讀一次這條線的訊息 id / seq / 時間，上限 `Chapters.MaxMessages`）。
9. **測「改名被拒」用觸發器**：審查建議「支線在這一輪進行中被關掉」，但 B13 起 merged / discarded 的支線仍能改目的，回合進行中讓 `RenameBranch` 真的拒絕不好重現，所以測試在 test schema 裡建 `BEFORE UPDATE OF purpose` 的觸發器讓 `RenameBranch` 失敗；`RecordTopicCut` 同樣用 `BEFORE INSERT` 觸發器。
10. **風險：長目的會被換成模型的短主題**：只有目的 > 25 字的支線會被改；改了之後，之後每一輪的支線規則（「The purpose of this branch is: …」）、父線的結論卡通知、魚眼等讀目的的地方都用新的短主題（同 B13 的改名規則）。原本那段長目的不會保留在別處（背景包是建立時的快照，裡面仍有原文）；如果模型的主題漏掉了限制條件，之後的回答可能偏離原本的目的。使用者可以再改回來。

### 給前端（F11）

- **使用者自己改的名不會被蓋掉**：這一輪進行中改了主線標題（原本有標題時）或支線目的，就不會收到改名事件。原本沒有標題的主線，前端在送出後設的暫時標題仍會被 `[TOPIC]` 取代（會收到第二個 `line.updated`）。
- **送出前預覽**：`POST /preview` 的 `blocks[]` 可能多一個 `key: "reply_lines"`（第一輪、或主線聊到第 3 輪以後），`prompt.trailing[]` 也有；介面若依 key 顯示區塊名稱，要加這個 key 的名字（例如「回覆格式」）。
- **主線標題改了**：一則 `line.updated`，`data` 是 `LineView`，`title` 是新名字（≤ 36 字）。順序：這一輪的 `message.updated` → `line.updated`（idle）→ `line.updated`（新標題）→（`chapters` 開著）`chapters.changed {rootLineId}`。`POST /messages` 的 202 不帶新標題，要看事件或重讀線。
- **支線目的改了**：`branch.changed {change: "renamed", branch: BranchView}`（`branch.purpose` 是新目的），接著支線的 `line.updated`（`title` 與 `conversationBranch.purpose` 都是新目的）。和使用者在介面上改名完全一樣。順口問永遠不會收到。
- **切出新章節**：`chapters.changed {rootLineId}`（只有主線 id，沒有章節內容），收到後重讀 `GET /lines/{rootLineId}/chapters`。新的一章 `kind: "topic"`、`titleSource: "topic"`、`title` 是模型給的名字、`startMessageId` 是那一輪的**使用者訊息**。第一章被主題命名時同樣是 `kind/titleSource: "topic"`。
- **閒置切章改 30 分鐘**：`GET /chapters` 的 `limits.idleGapMinutes` 現在是 30；`web/packages/client/src/chapters.ts` 的 `DEFAULT_CHAPTER_LIMITS.idleGapMinutes` 仍是 120（與 `chapters.test.ts` 的斷言），mock 若用到也要改。
- **串流**：`[TOPIC]` / `[CHAPTER]` 行不會出現在 `message.delta`，存下的 `content` 也沒有。
- **e2e:mock**：fake runner 只有在訊息含 `[fake:topic]` / `[fake:chapter]` 時才會回這兩種行，可以用來測。若 mock 伺服器自己模擬回合，要自己模擬以上事件。
- 契約樣本 `route.chapters.list.json` 的 `idleGapMinutes`、5 個 preview 樣本多了 `reply_lines` 區塊、多個樣本的 token 數變了（見上）。

## Part B · F11（前端）

> 在獨立 worktree（`../tangent-f11`，分支 `f11`，從 `ed106fd` 開）裡做，沒有改 Go。兩個背景 agent 平行做互不重疊的部分：順口問葉節點（§1）、主線章節節點（§3.3）。§2.2 與 e2e 由協調者做，最後再由唯讀 TypeScript 審查 agent 檢查。
> 合併時把 client 的章節閒置預設改成 30 分鐘（對齊 B16），預覽面板替新的 `reply_lines` 區塊加上名稱「回覆附註（主題、章節）」。

### 驗收（兩支合併到 `main` 後重跑）

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 5 個專案全部通過 |
| vitest（逐一套件） | fonts **10**、client **951**、react **959**、demo **182**（開工時 10、937、937、180） |
| `pnpm -C web build` | 通過。主 JS **151.68 kB gzip**（開工時 150.2，上限 172） |
| Playwright `e2e:mock --workers=4` | 見下方 |
| Go（合併後） | `go vet`、`gofmt` 乾淨；`go test ./... -count=1` 全部 ok；`smoke.sh` `SMOKE PASSED (803 events)` |

### 做了什麼

**§1 順口問是葉節點**
- **地圖：** 順口問用大圓角、虛線、凹陷底色的「葉片」外框，標題列有「單輪葉節點」小標。
  - 第二行是回答摘要（`conclusionLine`），沒有就寫「單輪問答・不往下分岔」。
  - 沒有拉關聯的圓點，也沒有折疊鈕。
- **大綱：**
  - 預設就顯示順口問；底部按鈕是「隱藏順口問（N）」／「顯示順口問（N）」。
  - 狀態：回答中是「回答中」，答完是「單輪葉節點」，不再寫「未帶回」。還沒答出來的（回合失敗、等重試）維持一般的進行中。
- **分岔膠囊：** 展開的清單裡，順口問的狀態是「順口問・單輪葉節點」。
- **支線列：** 虛線底框，類型旁邊有「單輪葉節點（一問一答即結束，不可往下開支線）」。進行中／未帶回這個狀態字不另外顯示。
- **順口問裡面不能開支線：**
  - 訊息不提供開支線、修改並分岔、分岔重答、給我幾個方向、搬移、從這裡開新對話、AI 開支線建議。
  - 框選工具列沒有開支線與秒問解釋，只剩紀要、備忘、停車；`SelectionToolbar.onBranch` 改成選用。
  - 輸入框沒有開支線鈕，⌘B 也不作用。

**§2.2 `summarizeTopic`（`@tangent/client`）**
- 處理順序：
  1. 拿掉已關閉的程式碼區塊；未關閉的只拿掉那一行標記。
  2. Markdown 連結留下文字，網址拿掉。
  3. 拿掉引用、標題與條列記號。
- 依句界切成子句，太短的不算。
  - 句界是 `。！？；` 與換行；ASCII 的 `. ! ?` 只在後面接空白或結尾時才算，所以 `Node.js` 不會被切開。
- 多句時從後往前找會「問」的那句（問號或疑問詞，含英文的 what / why / how / which / should），找不到就取第一句。
- 那句仍超過上限時，取它逗號分段裡最後一段會問的。
  - 例如「我有一個 Go 服務…，請問該怎麼排查記憶體洩漏？」會得到「該怎麼排查記憶體洩漏」。
- 拿掉句首客套（「我想請問一下」等）和 F10 模板的句尾，最多 36 字，在逗號或空白處截斷並加「…」。
- 用在兩個地方：
  - 新對話第一則訊息的暫時標題。
  - 開支線對話框裡，使用者自己寫的問題的自動目的。
- 種子照原文當問題時，目的仍是種子原文。

**§3.3 主線章節節點**
- **地圖：** `[data-tg-map-node="__main__"]` 不變，下方同一欄有一條垂直主幹，串起每個章節（`data-tg-map-chapter`）。
  - 每個章節顯示「§n 標題（沒有標題時用章節清單原本的時間名稱）」與「N 則」。
  - 有從這段長出的支線時，加一個「↳ n 支線」徽章，只算地圖上畫得出來的。
  - 章節是按鈕（Enter / Space 也可以），會跳到主線該章的第一則；Tab 順序是主線、各章節、各支線。
  - 畫布往下長到能放下主幹，所以縮放與「符合畫面」都包含它。
- **大綱：** 樹的上方有一列「§1 …」→「§2 …」的膠囊（`role="group"`「主線章節」），在 tree 之外，不影響方向鍵。
- 側欄結構、全幅地圖、專注模式地圖都有接上；`chapters` 功能關閉時都不出現。
- **新的 hook `useMainChapters(rootLineId)`：** 只在 `chapters` 開著時回傳主線章節，和章節清單共用快取。

### 和工單不同的地方
1. **章節節點的門檻：** 地圖也是 2 章以上才顯示（工單寫 ≥ 1）。只有一章時就是整條主線，和主線節點重複。
2. **支線的連線：** 第一層支線仍然從主線節點連出，沒有改成從章節連出。主線節點在支線群的中間，改從章節連出會讓連線交叉；改用每章的「↳ n 支線」徽章表示支線從哪一段長出來。
3. **章節節點的跳轉：** 嵌入的 host 沒有給 `onOpen`、使用者又在支線上時，不顯示章節節點。只能進主線的話會丟掉章節的位置。
4. **支線列：** 順口問不另外顯示進行中／未帶回，提示文字已經說明它是什麼。
5. **「如果」：** 不在客套詞清單裡（工單的清單只有「那如果」「如果我想」），所以「如果改用 Wasabi，…」會保留「如果」。

### 審查（唯讀 TypeScript 審查 agent，沒有 HIGH）
- **採納並修好的：**
  - 一整句很長時，取到的是背景而不是問題。
  - 英文句號沒有切句。
  - Markdown 連結殘留 `[docs](`。
  - 未關閉的程式碼區塊吃掉後面的問題。
  - 回合失敗的順口問被標成「單輪葉節點」。
  - 沒有 `onOpen` 時，章節跳轉丟掉了訊息位置。
- **沒有採納的：**
  - 截斷時會把 ZWJ emoji 切開。機率低，其他截斷也一樣。
  - 順口問裡的輸入框提示仍寫「⌘B 開支線」。順口問答完就沒有輸入框，只有回答中的那幾秒看得到。
  - 深連結進入順口問、資料載入前的一瞬間。那時 `writable` 是 false，動作本來就不出現。

### e2e
- 改了的既有測試：`structure.spec.ts`。大綱預設就顯示順口問，所以不再按「顯示順口問（1）」。
- 新的 `f11.spec.ts`（3 條，截圖在 `docs/devlog/screenshots/F11/`）：
  1. 秒問解釋之後，順口問的支線列有葉節點提示；裡面沒有開支線；大綱標「單輪葉節點」；地圖畫成葉片。
  2. 新對話的長問題，標題取最後那句問題。
  3. 大綱的章節膠囊與地圖的章節主幹，都能跳到該章的第一則。
