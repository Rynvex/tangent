# F1 · 對話（接上真 API）

> 2026-10-15。依該階段工單：client 改用 B4 契約（契約測試直接讀 `httpapi/testdata/contract/*.json`）、TanStack Query 資料層與 SSE 同步、
> 對話元件（Markdown 移植自 宿主）、demo 的 ConversationList 與主線對話頁接真 API、Playwright（mock 與真 API）+ axe。
> 只動了 `web/` 與 `docs/devlog/`（本檔與 `screenshots/F1/`），沒有改 Go，沒有 commit。

## 驗收（在 repo 根目錄執行）

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過（fonts、client、react、demo、e2e） |
| `pnpm -C web test` | 通過：fonts 9、client 319、react 287、demo 16，共 **631**（F0 後 413） |
| `pnpm -C web build` | 通過：主 JS 154.8 kB gzip（F0 138.3）；Markdown（react-markdown + remark）175 kB / 54 kB gzip、KaTeX 262 kB / 78 kB gzip、各語法檔皆為按需載入的獨立 chunk |
| `pnpm -C web e2e` | 通過 **18**：mock 15（F0 冒煙 9、對話流程 3、情境一畫面 3）＋ 真 API 3（1440 / 420 / 375） |

e2e：`E2E_ONLY=mock|api` 只跑一邊（`pnpm -C web/e2e e2e:mock`、`e2e:api`）。真 API 那邊由 `web/e2e/scripts/start-api.sh` 在 `tangent-postgres` 裡 drop / create
`tangent_e2e`、`go build` 參考伺服器到 `web/e2e/.cache/`、fake runner（`TANGENT_FAKE_CHUNK_DELAY=60ms`、`TANGENT_PRICING` 給 `fake-1` 價格），
port 與兩個 token 由 `playwright.config.ts` 隨機產生（不用 8120 / 8121）；demo 以 HTTP 模式另起在一個空閒 port，Vite proxy 依 `X-Tangent-Demo-Identity`
換成 `Authorization: Bearer`，token 不進瀏覽器。截圖：`UPDATE_SCREENSHOTS=1 pnpm -C web/e2e e2e conversation screens`（只跑 F1 的 spec，F0 的截圖不會被覆寫）。

## 做了什麼

### 1. `@tangent/client` 改用真契約
- `api-types.ts` / `types.ts`：清掉所有 PROVISIONAL。拿掉 `CreateLineInput.hostMeta`、`SendMessageInput.hostMeta`；新增 `DeleteLineResult`、`ArchiveResult`、
  `CancelResult`、`StreamPage{deltas, seq, truncated}`、`PreviewBlock`、`PreviewTurnResult{prompt, blocks, totalTokens, provider, model, estimatedCostUsd?}`、
  `JobStarted{jobId, kind, lineId}`、新的 `MoveBranchResult`（不再繼承、沒有 pack）、`merge.notes.rootLineId`、`NoteWriteResult.rootLineId`、
  `MilestoneWriteResult{milestone, rootLineId}`；`LineView.awaitingReview`、`Line.usage`（正式）、`Usage.cacheRead/WriteTokens?`、`MessageMeta.actor`、`Prompt.trailing?`。
- API：delete / archive / unarchive / read / cancel 回傳正規化後的內容；`promoteBranch` 送 `{confirm:true}`；`updateLine` 空 patch 直接以 `invalid_input`（status 0）拒絕不送出；
  `previewTurn` 的 content 可省略；`addMilestone` 讀 `body.milestone`（回 `{milestone, rootLineId}`）；失敗回應帶 `Retry-After` 時 extra 加 `retryAfterSeconds`。
- 錯誤碼：`HTTP_ERROR_CODES`（unauthorized、forbidden、payload_too_large、not_found、unavailable、internal、rate_limited）另列，`DOMAIN_ERROR_CODES` 的防漂移測試不變；`ALL_ERROR_CODES`。
- `card_draft` 不再算「有 mode 的功能」（契約樣本沒有 mode，DESIGN §12 B3 階段二）。
- 事件：加 `stream.lagged`（payload 原樣保留，可以沒有 data）；`onStatus("reconnecting", {attempt, nextRetryAt})` 讓狀態列能顯示第幾次與倒數。
- **契約測試** `contract.test.ts`：每個 `route.*.json` 都用真 client 呼叫一次（假 fetch 回樣本），斷言送出的 method、path（含 query）、body 與樣本**完全相同**，
  正規化後的結果與樣本 `response` **深度相等**（欄位不增不減）；錯誤樣本斷言 status、message、code、extra。每個 `event.*.json` 經 `parseEvent` 後等於原 envelope。
  另有測試確認路由對照表與樣本檔一一對應、每個樣本檔都被用到（新增樣本沒有對應呼叫就失敗）。
- **mock 也對樣本**：`testing/mock-contract.test.ts` 用 `inspect` 選項拿到 mock 正規化**之前**的原始回應，逐鍵比對樣本形狀（`shapeDiff`：鍵集合、型別、陣列取第一個、null 視為可空、
  `meta`/`hostMeta` 內容不比）。只有 move、promote（mock 不模擬）與兩個錯誤樣本除外。為此 mock 改成：刪除回 `{rootLineId, lineIds}`、封存整棵回 `{lines}`（主線在前）、
  `markRead` 回 LineView、取消回 `{cancelled, line, message}`（訊息是 `done` + `meta.cancelled`，同伺服器）、沒有進行中的一輪時 `{cancelled:false, message:null}`、
  `/stream` 回 `{deltas, seq, truncated}`（delta seq 用獨立的全域計數器，從 1 000 000 起）、preview 回 blocks / totalTokens / 估價、job 帶 kind 與 lineId、
  merge 會套用 `noteChanges`、待回覆訊息帶 `meta.actor/provider/model`。
- mock 也認得 fake runner 的指令：`[fake:retry]`（發 `turn.retrying`）、`[fake:slow]`（等 3 秒）、`[fake:error]`（訊息 `error`、線 `status=error` + statusDetail），所以同一套 e2e 能跑兩邊。

### 2. 資料層（`@tangent/react/src/data/`）
- `queries.ts`：`useCapabilities`（staleTime 5 分）、`useLines`、`useLine`、`useMessages`（分頁讀完，每頁 500、最多 20 頁）、`useBranches`、`usePreview`（POST 但不寫入，所以是 query，key 含草稿文字）。
- `mutations.ts`：`useSendMessage`（樂觀：先放一則 `tg-optimistic:` 使用者訊息，成功換成伺服器的兩則，失敗移除；Composer 失敗時把文字放回）、`useCancelTurn`、
  `useCreateLine`、`useUpdateLine`、`useArchiveLine`、`useMarkRead`。任何寫入收到 403 `forbidden` → provider 轉唯讀。
- `event-sync.ts`：事件**只**更新已在快取裡的 query 或 invalidate：message.created/updated → upsert 訊息頁（依 seq）；line.updated → 線與清單中的那一列（封存狀態改變時 invalidate 清單）；
  line.created（主線）→ invalidate 清單；line.deleted → 從清單移除並丟掉該線的 query；branch.changed / notes.changed / chapters.changed → invalidate；
  turn.retrying → live store；stream.lagged 與重新連線 → invalidate 全部 Tangent query 並讓串流重抓。**若事件到達時該 query 正在 fetch（含第一次載入），會 invalidate 它**，避免較舊的回應蓋掉事件。
- `live-store.ts`：小型 external store（`useSyncExternalStore`）只放暫時 UI 狀態：串流中的 delta（依 seq 去重排序）、連線狀態與重試次數、`turn.retrying`、resync 次數、是否被拒寫。
  結束的 turn 會記住，晚到的 delta 不再寫入。
- `live-hooks.ts`：`useTangentEvents()`（宿主在 provider 下掛一次）、`useStreamingReply(lineId, message)`（掛上時與 resync 後用 `/stream?afterSeq=0` 補抓同一 turn 的 delta，
  `truncated` 就重新讀訊息）、`useConversationBanner(lineId)`（重連 → AI 重試 → 唯讀 → 上限）、`useReadOnly()`。
- `TangentProvider` 新增 `readOnly`、`costThreshold`（預設 0.05）；query key 加 `lineView(id)`、`preview(id, content)`。

### 3. 元件（`@tangent/react/src/conversation/`、`markdown/`）
- `Markdown`：移植 宿主 `web/src/components/markdown`（react-markdown + remark-gfm + remark-math，**沒有 rehype-raw**，原始 HTML 不渲染；連結只允許 http/https/mailto 並開新分頁
  `noopener noreferrer`；KaTeX `trust:false`、strict、展開與大小上限；`$5` 不會變算式；串流中未閉合的 fence / `$$` 保持純文字；lowlight 按需載入語法；20k 字以上不高亮）。
  程式碼區塊有語言標籤、複製鈕、`overflow-x:auto` 且可聚焦；表格包在可聚焦的橫向捲動容器。宿主的 mermaid、diff 區塊、上傳圖片沒有搬（Tangent 沒有附件，所有圖片一律變連結或文字）。
  測試同步移植（49 個）。
- `UserMessage`（純文字、保留換行）、`AssistantMessage`（思考中 / 串流 / 完成 / 已停止 / 失敗 + 重試；襯線閱讀字級）、`MessageActions`（開支線、停車與記進紀要只有宿主接上才出現、複製；
  hover / focus 才顯示、觸控常駐；容器 ≤ 480px 只剩圖示）、`ForkMarker`（數量、每條一個狀態點、摘要、未讀；有 `onOpen` 才是按鈕，F2 接上）、`BranchSuggestions`（A12，最多 3 個、虛線、可忽略）、
  `Composer`（Enter 送出、Shift+Enter 換行或宿主改的鍵、組字中不送、串流中換停止鈕且 Esc 停止、草稿有估算時顯示 token、超過門檻才用警告色顯示金額）、
  `TurnPreview`（右側抽屜：合計、估價或「沒有價格」、模型、各區塊 token 可展開、這條線累計）、`MessageList`（依 kind 渲染；結論卡與搬移標記先用簡單版，F2 換正式）、`describeError`。
- 語法色只用既有 token（不新增色值），並測試每個在 `--tg-surface` 上三套主題都 ≥ 4.5:1。

### 4. demo
- `ConversationList`（A1）：搜尋（標題與摘要主題，多字詞）、今天 / 昨天 / 本週 / 更早分組、時間標籤（今天時刻、本週星期、更早日期，解決 F0 差異 7）、等你點、封存區展開與封存 / 解除封存、
  空狀態、載入中、讀取失敗重試；手機抽屜沿用 F0。`list-model.ts` 有測試。
- 主線頁接真資料：`ConversationView`（狀態列、訊息自動跟到底部、唯讀列「檢視權限・不能送出」、封存列 + 解除封存、Composer）；新對話（第一則訊息送出後以前 40 字命名）；
  讀到未讀就 `markRead`；失敗回覆的「重試」重送上一則使用者訊息；⌘B / 訊息動作 / AI 建議都開 F2 開支線對話框的佔位；⌘⇧P 與 token 膠囊開預覽。
- `?as=viewer` = 唯讀身分（provider `readOnly`，HTTP 模式時 proxy 用 viewer token）；`?line=<id>` 開指定對話（420 嵌入用）；`?state=` 仍可強制 A14 狀態做對照。

## 契約差異的處理

`B4-contract-diff.md` 的每一列都已處理（見上）。樣本在本次工作期間沒有被重新產生（`httpapi/testdata/contract/` 無變動）；契約測試每次都讀目錄裡最新的檔案，新增或刪除樣本會讓測試失敗。

## E2E 結果

| 寬度 | mock | 真 API |
|---|---|---|
| 1440 | 建對話 → 送出 → 串流（aria-busy、停止鈕、文字增加）→ 完成 → 預覽（axe moderate）→ 取消（已停止）→ `[fake:retry][fake:slow]` 狀態列「第 1 / 2 次」後消失 → `[fake:error]` 失敗與重試 → `?as=viewer` 無輸入框 | 同左；**唯讀一步標成 TODO**（參考伺服器還不認 `TANGENT_VIEWER_TOKEN`，測試先檢查 viewer token 是否被接受，接受時再驗 403 `forbidden` 與 UI） |
| 420（嵌入、宿主主題） | 同上（用情境一的 NAS 對話） | 同上（先用 API 建對話再以 `?line=` 打開） |
| 375（手機、觸控） | 同上，從抽屜開新對話；送出鈕 ≥ 44px | 同上 |

axe：每個寬度在串流完成後跑整頁（serious 以上）；預覽抽屜與元件總覽的新元件（三套主題）跑 moderate 以上。

## 截圖對照（`docs/devlog/screenshots/F1/`）

`demo-*.png` 由 e2e 產生，`prototype-*.png` 與 `compare-*.png` 由 `web/e2e/scripts/compare-shots.mjs` 產生（1440 淺色、1440 深色 AI 錯誤、1440 預覽、420 宿主、375）；
`demo-*-mock.png` / `demo-*-api.png` 是對話流程走完第一輪的畫面。

相符：使用者訊息靠右、`--tg-accent` 底、右上小圓角；AI 回覆無框、襯線閱讀字級、表格與程式碼區塊在閱讀寬度內；標籤列「你・#n / AI・#n」；分岔點膠囊（數量、狀態點、摘要）；
AI 建議虛線膠囊與忽略鈕；輸入框的開支線、預覽、圓形送出 / 停止鈕；宿主主題的 Geist 與顏色；手機程式碼區塊可橫向捲動。

差異：
1. 訊息編號是「這條線的第幾則對話訊息」，原型是全域編號（#26、#40）；伺服器的 `seq` 是全域遞增，不適合當顯示編號。
2. 程式碼區塊多了語言 / 複製列（工作單要求），底色用 `--tg-surface`（原型 sunken）：`--tg-warning` 在 sunken 上只有 4.39:1。
3. 預覽是全頁 modal 抽屜（有遮罩、focus trap），原型是對話欄內的非 modal 面板；原型的魚眼程度標籤（C1）與「若送出完整歷史約 38k」比較不做。
4. 輸入框的鍵盤提示仍在工具列（F0 差異 4），停車鈕要等 parking（P1）才出現。
5. 章節分隔線、結論卡正式樣式、大綱 / 紀要 / 目標膠囊是 F2 / F3。
6. 「日本行程」列沒有「1 條等你」：mock 的 `recount` 用 state 裡的支線重算，情境裡大阪沒有支線資料（mock 資料問題）。

## 與設計的差異、決定

- 唯讀：宿主以 `TangentProvider readOnly` 宣告；另外任何寫入收到 403 `forbidden` 自動轉唯讀（含進入對話時的 `markRead`）。唯讀時隱藏輸入框、訊息動作、AI 建議、新對話、封存鈕；預覽仍可用。
- 「錯誤重試」：自動重試看 `turn.retrying`（狀態列，該 turn 有 delta 或結束就消失）；失敗回覆的「重試」是**重送上一則使用者訊息**（會多一則使用者訊息），伺服器沒有重跑一輪的路由。
- 送出回應比 `message.updated` 晚到時不會把已完成的回覆蓋回 pending（`[fake:error]` 立刻失敗時 e2e 抓到）：快取裡已結束的訊息不接受 pending 版本。
- 搜尋只做標題與摘要主題（client 端過濾）；原型的支線目的與訊息內容搜尋需要伺服器 API。
- KaTeX CSS 以動態 `import("katex/dist/katex.min.css")` 載入（宿主 bundler 拆成獨立檔，第一個算式時才載）；它是全域選擇器 `.katex*`，不在 `[data-tg-root]` 範圍內。
- 元件總覽的 axe：Base UI `Select` 在頁面捲動後打開時，axe 會把它的 focus guard 判為 `aria-hidden-focus`（serious）；頁面在頂端時不會。這是 F0 的 Select，與 F1 無關，
  總覽頁變長後才出現，所以 e2e 把 Select 那一步放在捲動之前，問題記在下方。

## TDD 說明

client 契約測試、mock 契約測試、live store、event sync、Composer、訊息元件、列表模型、錯誤文字都是先寫測試看到失敗再實作。Markdown 是移植：程式碼與測試一起搬，第一次執行即通過；
message-cache 與幾個 hook 測試是和實作同時寫的。

## 留給後端 / 協調者的問題（契約）

1. **viewer token**：參考伺服器還沒有 `TANGENT_VIEWER_TOKEN`（DESIGN §12 已決定，B4.1）；e2e 已傳這個變數，伺服器支援後唯讀那一步會自動啟用。
2. **沒有 model 的線沒有估價**：`POST /lines {}` 建出的線 `model=""`，`PreviewTurn` 用 `line.Model` 查價，所以就算 fake runner 回報 `fake-1` 也沒有 `estimatedCostUsd`。
   建議建立時填入預設 provider/model，或估價時退回 runner 的預設模型。
3. **客戶端取消被記成 ERROR**：前端取消 query（換頁、unmount）時伺服器 log `level=ERROR "request failed" error="list lines: context canceled"`，取消中的 turn 也記 WARN。建議 `context.Canceled` 不當錯誤。
4. 失敗的一輪 `meta` 只有 `error`、`actor`，沒有 provider / model / durationMs（成功時有）；前端不依賴，記一下。
5. 沒有「重跑這一輪」的路由，重試只能重送使用者訊息（多一則）。要不要加 `POST /lines/{id}/retry`？
6. 搜尋（支線目的、訊息內容）需要伺服器端 API。

## 留給 F2 的問題

1. `ForkMarker` 已有 `onOpen`；F2 的內嵌清單 / 進入支線接在這裡。`MessageList` 的結論卡與搬移標記是佔位，F2 換 `BranchCard`。
2. 開支線對話框：demo 的 `BranchPlaceholder` 收到 `{suggestion?, anchorMessageId?}`；F2 的 `OpenBranchDialog` 直接取代（AI 建議送出時要帶 `suggestionMessageId`）。
3. 唯讀判斷目前靠宿主宣告或 403；要不要由 `/capabilities`（或另一個路由）回報「這個身分能不能寫」，讓 UI 一開始就正確？
4. Base UI `Select` 捲動後的 axe `aria-hidden-focus`（見上）要不要換成自己的 listbox 或回報上游？
5. `TurnPreview` 是 modal；原型是對話欄內的非 modal 面板，F2 若要邊看預覽邊打字需要改。

## Review fixes（2026-10-15，F1 已提交為 0c44a9f 之後）

依協調者的審查清單修正，每一項都有回歸測試。B4.1 的 Go 改動同時在工作目錄中進行，我沒有動 Go；契約樣本已從 47 增加到 65 檔，契約測試讀的是最新的。未 commit。

### 閘門

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過 |
| `pnpm -C web test` | 通過：fonts 9、client 354、react 311、demo 16，共 **690**（修正前 631） |
| `pnpm -C web build` | 通過：主 JS 156 kB gzip |
| `pnpm -C web e2e` | 通過 **24**（mock 18、真 API 6，含 3 個唯讀測試），連跑兩次；`conversation` 另 `--repeat-each=3` 全過。axe 標準同前 |

B4.1 的 Go 端新增了 `too_long`、`model_not_allowed`、`nothing_to_retry`。防漂移測試失敗後，我已在 TS 端補上，`HTTP_ERROR_CODES` 也加了 `unsupported_media_type`。
B4.1 帶來的變更：`/capabilities` 的 `permissions{canWrite}`（`canWrite()`）、`POST /lines/{id}/retry`（`retryTurn`、`useRetryTurn`，mock 也模擬）；`TANGENT_VIEWER_TOKEN` 已生效，真 API 的唯讀 e2e 不再跳過。

### HIGH
1. **重連後卡住的 AI 錯誤列**：`resync()` 清掉 `retrying` 與 `streams`；`useConversationBanner` 只在 `turnId` 那則訊息仍是 pending 時顯示 aiError；`finishTurn` 清掉該線的任何殘留串流。
   測試：live store resync、banner 對非 pending 的 turn 不顯示、重連後消失。
2. **重新載入或 truncated 後回覆失去開頭**：pending 時畫面 = `message.content`（基底）+ 串流文字（`pendingText`）；`/stream` 回 `truncated` 時保留它還有的 delta，並標記 `gap`（畫面以「…」開頭），同時重新讀訊息。
   **對真伺服器驗證**：串流中途 `GET /messages` 的 pending 訊息 `content` 是空字串、meta 只有 actor，所以部分文字只存在於 delta 緩衝區（見下方後端請求）。
   測試：`pendingText`、truncated 保留 delta 與 gap、重新讀訊息。

### MEDIUM
3. **每個 delta 的成本**
   - `mergeDeltas`：seq 大於 lastSeq 時直接 append 並串接文字；只有亂序或重複才走去重與排序的慢路徑。
   - 只有 pending 的回覆（`PendingAssistant`）訂閱串流狀態。
   - `AssistantMessage`、`UserMessage`、`MessageRow`、`PendingAssistant` 都加了 memo；handler 經 `useStableHandlers`，行內函式不會讓列重繪。
   - 訊息列加 `content-visibility:auto`。
   - delta 依動畫影格批次寫入。
   - 效能測試：2000 則 + 500 個 delta，已完成的列 Markdown 只渲染一次，父元件重繪也一樣。
4. send、cancel、retry 的 `onSettled` 會 invalidate `messages`（與 line）。
5. **大綱與章節改以根線為 key**：`keys.branches(rootLineId)`、`keys.chapters(rootLineId, lineId)`，`branchesOf` 與 `chaptersOf` 可整棵 invalidate；`useBranches` 改收根線 id。`branch.changed` 與 `chapters.changed` 從任何線快取的資料都碰得到（有測試）。
6. **唯讀判斷**
   - live store 依 `scopeKey`（與 client）各建一個，換身分就重設。
   - 只有送出、取消、重試收到 403 才轉唯讀；建立、改名、封存、markRead 的 403 不算。
   - `/capabilities` 有 `permissions` 時以它為準，403 不再影響。三種情況都有測試。
7. **訊息快取**
   - `sameMessage` 比較全部欄位。
   - 只有事件流（`authoritative`）能把已完成的訊息改回 pending；請求的回應不行。
   - 出現同 id 的 pending 訊息時（`beginTurn`）清掉 `finished`，同一個 turn id 能再串流。
8. **無障礙**
   - 回覆完成時，polite live region 說「回覆完成」，回覆內文不進 live region。
   - Composer 只有一個送出／停止按鈕，換的是名稱與圖示，空草稿時用 `aria-disabled` 而不是 `disabled`，焦點不會掉（有測試確認是同一個 DOM 元素）。
9. **立即重試**：`EventSubscription.reconnect()`（client 與 mock 都有）在退避等待中直接連；連線中時中斷並立刻重連，不回報錯誤。live store 綁定它，提供 `useReconnect()`；demo 的重連列有「立即重試」。
10. **契約測試**
    - 改用 `toStrictEqual`，並明確比對鍵集合（key paths）。
    - 斷言 `Authorization`、`Accept`、`Content-Type`（有 body 才有）。
    - 樣本依 method + path 對應到 client 呼叫（`.rich`、`.pending` 這類新樣本不必改程式）；未知路由會失敗。
    - `EXPECTED_SAMPLES` 列出審查時的 47 個樣本，少了就失敗。
    - capabilities 樣本帶 `permissions`（B4.1 已到）後，下列樣本變成必備：`stream.lagged` 事件、`truncated:true`、pending 與 error 訊息、403 / 409 / 415 / 422 錯誤、非零 usage。
    - mock 契約測試也改成依路由比對所有成功樣本（含 rich 與 viewer 變體）。mock 的 capabilities 帶 `permissions`。
11. **e2e**
    - 唯讀拆成每個寬度一個獨立測試；伺服器不接受 viewer token 時以 `test.skip` 加原因跳過，不再默默 return。
    - 單元測試加了真實的亂序／缺號 delta 序列，以及重連後用 `/stream` 補洞。
    - mock 專案用自己的空閒 port，`reuseExistingServer:false`。
    - `start-api.sh` 用 `tangent_e2e_<port>`，並清掉沒有連線的舊 e2e 資料庫。
    - e2e 改用頁內 MutationObserver 判斷「看到串流」（不再靠輪詢搶時間窗）。它順帶抓到一個串流結束時約 12 ms 的閃爍：pending 回覆短暫變回「思考中」，原因是 live store 的同步更新先於 query 通知渲染。
      已改成在同一批 `notifyManager` 通知裡結束串流，取消也一樣。e2e 斷言串流開始後文字不會消失；拿掉修正時這個斷言會失敗（已驗證）。

### LOW
12. Composer 的 `onSend` 同步丟例外時，草稿會放回（有測試）。
13. 樂觀訊息不再依文字配對。202 回應以 id 移除它；事件先到時，`visibleMessages` 在伺服器已有同位置以後的使用者訊息時先隱藏它（依 seq，不比文字）。
14. `resolveLanguage` 改用 `Object.hasOwn`（`constructor`、`__proto__` 不會碰到原型）。
15. `line.deleted` 會清掉該線的 `finished`、`retrying`、`streams` 與排隊中的 delta。
16. 載入中（含多頁）收到的事件不再取消並重啟載入：先套用到現有資料，同時排隊，等載入完成再套用一次（有測試：只 fetch 一次，結果含事件）。

### 其他變更
- 失敗回覆的「重試」改用 `POST /retry`：不會多一則使用者訊息，失敗的回覆保留；只有最後一則回覆會顯示重試鈕（有測試）。e2e 同步更新。
- 本地繞過 Base UI Select `aria-hidden-focus` 的做法維持不變（DESIGN §12 F1 問題列），上游回報待處理。

### 給後端的請求
1. **串流中的部分文字**：pending 訊息的 `content` 在串流中是空的，`/stream` 一旦 `truncated`，開頭就永遠補不回來（畫面只能顯示「…」）。
   建議 pending 訊息定期寫回部分內容，並附上涵蓋到的 delta seq（例如 `meta.streamSeq`）。前端已把 `content` 當基底，可以直接接上。
2. **串流裡帶了標記行**：`route.stream.midturn.json` 的 delta 包含 `[BRANCH-SUGGEST]{...}`。完成後的訊息會去掉這行，但串流中使用者看得到。建議 runner 或 Engine 在送出 delta 前就去掉標記行。
3. **沒有 429 樣本**：`rate_limited` 來自參考伺服器的限流，不在 httpapi 的契約樣本裡。B4.1 必備清單因此沒有要求 429；需要的話請從參考伺服器產生一個。

## B4.2 follow-up（2026-10-15，665076f 之後，未 commit）

- **`stops a reply and keeps what streamed` 失敗的原因**：程式碼沒錯，是測試讀太早。
  - 取消後 query cache 裡已經是 `done` + `cancelled`（已用 cache 事件記錄確認）。但 TanStack 用零秒計時器通知 observer，`act()` 不會等它。
  - 先前 `finishTurn` 會同步更新 live store，順帶讓 hook 重繪，掩蓋了這件事。665076f 把 `finishTurn` 移進 `notifyManager` 批次（修串流結束的閃爍）後，`mutateAsync` 一結束就讀，拿到的是上一次渲染的結果。
  - 修正：測試改成 `waitFor` 等 hook 重繪，並加驗串流已結束。
  - react 套件連跑 6 次、另打亂順序跑 3 次（`--sequence.shuffle`），全部通過，沒有其他依賴順序或時間的測試。
- **`meta.streamSeq`（B4.2）**
  - 保留協調者的修改（`pendingText` 只接 seq 大於 `streamSeq` 的文字 delta）。
  - 加了「洞」的判斷：`/stream` 回 `truncated`、且沒有任何串流 delta 落在 base 之內時，才在 base 與尾段之間顯示「…」。新的 base 蓋到串流開頭時標記就消失。沒有 `streamSeq` 的舊資料只有 base 為空才算洞。
  - `useStreamingReply` 補抓改用 `/stream?afterSeq=<meta.streamSeq>`，只讀 base 之後的尾段。resync 清掉串流後一樣從 `streamSeq` 接上。
  - 測試：讀取時帶 `afterSeq=41`、`gap=false`、畫面為「base + 尾段」；以及洞的標記與消失。
- **契約**：`EXPECTED_SAMPLES` 加入 `route.error.rate_limited` 與 `route.error.unauthorized`；B4.1 必備清單恢復要求 401 與 429。
- **閘門**：typecheck 通過；test 693（fonts 9、client 354、react 314、demo 16）；build 通過；Playwright 24/24（mock 18、真 API 6）。
