# Tangent HTTP API 參考

> `httpapi.New` 回傳的 `http.Handler` 提供的每一條路由、錯誤碼與 SSE 事件。契約見 `docs/DESIGN.md` §6、§7、§12；
> 回應形狀以 `httpapi/testdata/contract/*.json`（契約樣本，`go test ./httpapi -update` 產生）為準，本文的範例都取自那裡，
> 長的回應只節錄，完整內容看該樣本檔。嵌入方式見 `docs/EMBEDDING.md`。
>
> `httpapi/apidoc_test.go` 檢查：`httpapi` 註冊的每條路由、每個事件名稱、`branch.changed` 的每種 `change`、
> 每個錯誤碼（含 HTTP 狀態）都寫在這份文件裡，且引用的樣本檔都存在。新增路由或事件忘了寫文件，測試會失敗。

## 目錄

- [慣例](#慣例)
- [共用物件](#共用物件)
- [路由](#路由)：[能力](#能力)、[主線](#主線)、[訊息與回合](#訊息與回合)、[支線](#支線)、[紀要（notes）](#紀要notes)、
  [章節（chapters）](#章節chapters)、[搜尋（search）](#搜尋search)、[建議匣（suggestions）](#建議匣suggestions)、
  [收尾（leaf）](#收尾leaf)、[停車場（parking）](#停車場parking)、[獨立成新對話（spinoff）](#獨立成新對話spinoff)、
  [對話目標（goal）](#對話目標goal)、[關聯線（relations）](#關聯線relations)、[未完成清單（open_loops）](#未完成清單open_loops)、[訊息釘選](#訊息釘選)、[群組與合併支線（group）](#群組與合併支線group)、
  [論證類型（ibis）](#論證類型ibis)、[折疊（fold）](#折疊fold)、[發散與收斂（diverge）](#發散與收斂diverge)、[跨對話記憶（memory）](#跨對話記憶memory)、[名詞表（glossary）](#名詞表glossary)、[事件串流](#事件串流)
- [宿主的操作名稱（op）](#宿主的操作名稱op)
- [錯誤碼](#錯誤碼)
- [事件](#事件)

## 慣例

- **前綴**：路由不含前綴，宿主自己選（例如 `mux.Handle("/api/", http.StripPrefix("/api", handler))`）。
  契約樣本與參考伺服器都用 `/api`。
- **認證**：每個請求先呼叫宿主的 `Config.Scope(r)` 取得 `{tenant, actor}`。回傳 `*domain.Error` 就照它的碼回答，
  其他錯誤一律 `401 unauthorized`。函式庫不做帳號、角色、token；所有讀寫都以 tenant 隔離，別的租戶的資料一律 404。
- **寫入權限**：標「寫」的路由會先問 `Config.CanWrite(r)`（nil = 都可寫），拒絕時 `403 forbidden`。
  標「讀」的路由（含兩個預覽）唯讀身分也能呼叫。
- **功能路由**：標「功能 `x`」的路由只有在 `tangent.WithFeatures` 設定了該功能時才掛上（沒設定 → `404 not_found`）；
  設定了但 `FeaturePolicy` 對這個租戶關掉 → `404 feature_disabled`。
- **請求本文**：有本文的請求必須是 `Content-Type: application/json`（否則 `415 unsupported_media_type`），而且是一個 JSON 物件；
  未知欄位忽略（結論卡除外，見 merge）；空本文等於 `{}`（標「必填本文」的路由除外，回 `400 invalid_input`）。
  本文上限 `Config.MaxBodyBytes`（預設 1 MiB，超過 `413 payload_too_large`；`POST /lines/import` 與 `POST /lines/import-analyze` 用 `Config.MaxImportBodyBytes`，預設 16 MiB）。客戶端不能寫 `hostMeta`（`400 invalid_input`），那是宿主的欄位
  （宿主用 `Config.HostMeta` 寫，見[宿主的操作名稱](#宿主的操作名稱op)）。
- **路徑 id**：一律是 UUID。格式不對的 id 不會查資料庫，直接回該資源的 404（例如 `line_not_found`）。
- **回應**：JSON 一律 camelCase；清單永遠是 `[]` 不是 `null`；時間是 RFC 3339 UTC。回應帶 `Cache-Control: no-store`。
- **排序**：同一條線的訊息一律依 `seq`（全域遞增）排序，不依 `createdAt`。
- **錯誤格式**：`{"error": "給人看的訊息", "code": "錯誤碼", ...extra}`，見[錯誤碼](#錯誤碼)。
- **長度上限**（422 `too_long{field, max}`）：標題 200 字、provider / model 100 字、訊息內容預設 32k 字（`domain.Limits` 可調）。

## 共用物件

完整欄位見 `domain` 套件的型別與對應樣本；這裡只列重點。

**LineView**（`domain.LineView`；樣本 [route.lines.get.rich.json](../httpapi/testdata/contract/route.lines.get.rich.json)）：一條線。
`id`、`tenantId`、`title`、`status`（`idle` / `thinking` / `error`）、`statusDetail`、`provider`、`model`、
`folder`（B18：主線的資料夾，`""` = 未分類；支線永遠 `""`）、`tags`（B18：主線的標籤，永遠是陣列（沒有時 `[]`，不會是 `null`）；支線永遠 `[]`）、`unread`、
`summary`（滾動摘要，永遠是物件）、`notesRevision`（主線才有意義）、`usage{inputTokens, outputTokens, costUsd}`（累計）、
`hostMeta`、`lastActivityAt`、`archivedAt`、`createdBy`、`createdAt`、`updatedAt`；樹上的位置：`conversationBranch`
（主線為 `null`；支線為 `{parentLineId, rootLineId, anchorMessageId, depth, purpose, kind, status, origin}`）、
`branchCounts{open, merged, discarded, promoted}`（直接子支線）、`branchUnread`（底下所有 open 支線的未讀）、
`awaitingReview`（底下結論卡草稿已就緒待審的支線數）、`spunOffFrom`（由 spinoff 產生的主線：`{lineId, messageId, title, available}` 指向來源線、分岔的訊息與當時的標題；`available` 是讀取當下來源線是否還存在；其他為 `null`）、`openSuggestions` / `openSeeds`（這棵樹 open 的建議與種子數，只在主線；支線為 0。
`openSuggestions` 只算對這個請求開著的功能提出的（與 `GET /suggestions` 一致；沒有 scope 的背景清掃發出的事件除外）；樣本 [route.lines.get.inbox.json](../httpapi/testdata/contract/route.lines.get.inbox.json)）、
`staleBranches`（B9：這棵樹進行中且超過 `Limits.OpenLoops.StaleAfter`（3 天）沒有活動的支線數，只在主線；讀取時計算，單純時間經過不會發事件；功能狀態不影響計數，前端依 `/capabilities` 的 `open_loops` 決定是否顯示）、
`importBatchId`（B25：這條主線是哪一個[匯入批次](#get-imports)寫的；不是批次匯入的**不出現**；被 attach 併走的線保留，spinoff 產生的主線沒有）、
`pinnedAt`（B25：使用者釘選這條主線的時間，UTC RFC3339；沒釘選與支線**不出現**，見 [`PATCH /lines/{id}`](#patch-linesid)）。

**Message**（`domain.Message`；樣本 [route.messages.list.rich.json](../httpapi/testdata/contract/route.messages.list.rich.json)）：
`id`、`seq`、`lineId`、`role`（`user` / `assistant` / `system`）、`kind`（`chat` / `branch_card` / `branch_marker`；`role=system` + `kind=chat` 是**宿主系統訊息**：宿主寫的狀態、同步或稽核紀錄，沒有 HTTP 路由，見 EMBEDDING §4.6）、`content`、
`status`（`pending` / `done` / `error`）、`meta`、`hostMeta`、`pinned`（B9：使用者釘選，見[訊息釘選](#訊息釘選)）、`tag?`（B10：論證類型 `{kind, source, status, updatedAt}`，沒有就**不出現**，見[論證類型](#論證類型ibis)）、`createdAt`。進行中的回覆 `content` 是定期存下的部分文字（可能落後，`meta.streamSeq` 是存下時的 delta 序號），即時文字在
[`/stream`](#get-linesidstream) 與 [`message.delta`](#messagedelta)。`meta` 的欄位：`provider`、`model`、`usage`、`durationMs`、
`error`（失敗原因，給人看的文字）、`cancelled`、`card` 與 `branchLineId`（結論卡）、`delivered`（卡片已送達）、`editedAt`（B17.1：結論卡最後一次被編輯的時間，UTC RFC3339（微秒）；沒編輯過就**不出現**；送達後保留）、
`suggestions[]{purpose, kind, excerpt?}`（AI 提議的支線，`branch_suggest` 功能）、`actor`、`spunOffTo`（spinoff 在來源線留下的 `branch_marker` 上：`{lineId, messageId, title, available}`，新對話與分岔的訊息；`available` 在 `GET /messages` 讀取時判斷新對話是否還存在，事件裡是當時的值）。

**BranchView**（`domain.BranchView`；樣本 [route.branches.list.rich.json](../httpapi/testdata/contract/route.branches.list.rich.json)）：
大綱的一列。`lineId`、`parentLineId`、`rootLineId`、`anchorMessageId`、`excerpt`、`purpose`、`kind`（`aside` / `investigate` / `alternative`）、
`status`（`open` / `merged` / `discarded` / `promoted`）、`depth`、`origin`（`selection` / `button` / `move` / `suggestion` / `previous_main_line` / `seed`）、
`draftStatus`（`none` / `drafting` / `ready` / `failed`）、`conclusionLine`、`cardMessageId`、`closedAt`、`lineStatus`、`messageCount`、
`unread`、`provider`、`model`、`archived`、`createdAt`、`lastActivityAt`、`leaf`（收尾 `{kind, line, status}`，沒有時 `null`；`leaf` 功能）、
`mergedIntoLineId`（B9：被合併（combine）進哪條支線；這時 `status` 是 `discarded`；其他為 `""`）、`cardEditedAt`（B17.1：結論卡最後一次被編輯的時間，同卡片訊息的 `meta.editedAt`；沒有卡或卡沒編輯過就**不出現**）、`keptAt`（B23：順口問被保留的時間；沒保留的順口問與其他種類的支線**不出現**，見 [`PUT /branch/keep`](#put-linesidbranchkeep)）。`origin` 多一個值 `merge`（合併產生的支線）、`diverge`（發散開的），以及 `import`（B18：`POST /lines/import` 寫入的支線）。

**BranchDetail**（`GET /lines/{id}/branch`）：`{branch: BranchView, pack, draft, parentTipMessageId}`。`pack` 是開支線時的背景包
（`rendered` 是每輪帶給 AI 的原文，另有 `tokenEstimate`、`tokenBudget`、`recent[]` 等統計）；`draft` 是結論卡草稿
（`status`、`card`（`ready` 時才有）、`warnings[]`、`error`、`noteChanges[]`（notes 開啟時的紀要提案）、`parentTipMessageId`、`manualCardAvailable` …）。

**BranchCard**（結論卡）：`question`（必填）、`conclusion`（必填）、`evidence[]{messageId, note}`、`impact`、`openItems[]`、
`needsDecision[]{branchClaim, mainLineClaim, mainLineMessageId?}`、`excerpts[]{messageId, text}`。

**Note**：`id`、`section`（`decided` / `fact` / `to_confirm` / `todo`）、`text`、`status`（`active` / `done` / `superseded`）、
`sourceLineId`、`sourceMessageId`、`sourceCardMessageId`、`sourceLabel?`（寫入當下的來源文字快照，例如 `主線 #12`、`查證・目的`、`結論卡・目的`；
來源支線被清除後仍在；舊資料與沒有來源的紀要沒有這個欄位）、`copiedFromNoteId?`（spinoff 帶 `copyNotes` 時複製的紀要指向原紀要；來源欄位指向原對話）、`supersededBy`、`createdBy`、`createdAt`、`updatedAt`。

**Suggestion**（建議匣的一筆）：`id`、`rootLineId`、`lineId`（建議所關於的線；那條支線結束時建議變 `expired`）、`feature`、`kind`、`targetKey`、
`payload`（功能自己的物件）、`status`（`open` / `accepted` / `dismissed` / `expired`）、`createdAt`、`decidedAt`。

**Leaf**（支線的收尾）：`lineId`、`rootLineId`、`kind`（`conclusion` / `decision` / `answer` / `dead_end` / `to_continue`）、`line`（≤ 200 字）、
`body`（≤ 4000 字）、`status`（`draft` / `confirmed`）、`aiDrafted`（AI 寫的、使用者還沒改過）、`createdBy`、`createdAt`、`updatedAt`。

**Link**（`spinoff` 與 `relations` 共用）：`id`、`kind`（`spinoff` / `relation`）、`fromLineId`、`fromMessageId`、`toLineId`、`toMessageId`、`label`、`relationKind`、`fromTitle`、`toTitle`、`createdBy`、`createdAt`。
`relationKind`（B15）：關聯的種類 `related` / `supports` / `contradicts` / `depends_on`；**每一條關聯都有**（B15 之前的關聯是 `related`），spinoff 的連結**沒有這個欄位**。所有回傳 Link 的地方都一樣（關聯的列出 / 建立 / 修改、`/links`、匯出的 `links`、`link.changed`、接受關聯建議的 `result`）。
一端是訊息時，`fromLineId` / `toLineId` 是那則訊息**現在**所在的線（訊息被 move / promote 搬走後跟著變），`fromTitle` / `toTitle` 是那條線的標題。

**Group**（群組，B9）：`id`、`rootLineId`、`title`（≤ 120 字）、`summary`（共同摘要，≤ 1000 字）、`summaryStatus`（`none` / `drafting` / `ready` / `failed`）、
`status`（`active` / `dissolved`）、`memberLineIds[]`（依支線建立的順序）、`createdBy`、`createdAt`、`updatedAt`。

**Conflict**（矛盾，B9）：`{id, branch: {lineId, claim}, other: {lineId, claim}, choice?}`；`choice` 是 `adoptBranch`（採用 branch 的說法）/ `adoptOther`（採用 other 的）/ `keepBoth`（都保留，寫進紀要「待確認」，需要 `notes`）。
claim 一行 1–300 字，兩端是這次的不同支線，最多 10 個；不合格 → `422 invalid_group`。

**Goal**（對話目標，B9）：`rootLineId`、`text`（一行，≤ 300 字）、`source`（`manual` 使用者寫的 / `ai` 接受或由 AI 寫入的）、`updatedBy`、`createdAt`、`updatedAt`。

**Memo**（備忘，B13）：`id`、`rootLineId`、`lineId`（寫在哪個節點；那條線被刪掉後為空字串，備忘保留）、`sourceLabel`（寫入當下的節點名稱快照，規則同紀要的 `sourceLabel`，改名不影響）、`text`（1–4,000 字，可以多行）、`createdBy`、`createdAt`、`updatedAt`。

**Seed**（停車場的種子）：`id`、`rootLineId`、`anchorMessageId`（可能為空）、`anchorLineId`（anchor 現在所在的線；沒有 anchor 或已不存在時為空）、`sourceLabel`（停下種子時的來源文字快照，規則同紀要的 `sourceLabel`；沒有 anchor 時為空）、`text`（≤ 500 字）、`status`（`open` / `expanded` / `noted` / `dropped`）、
`expandedLineId`、`noteId`、`createdBy`、`createdAt`、`updatedAt`。

**Delta**：`{turnId, seq, kind, text}`，`kind` 為 `text` / `reasoning` / `tool`。

## 路由

### 能力

### `GET /capabilities`

讀。已設定的功能、對這個請求的有效模式、權限與可選模型；前端依此決定顯示哪些 UI。

- `features[]`：每個內建功能 `{name, enabled, mode?}`；`mode`（`manual` / `suggest` / `auto`）只出現在有 AI 模式的功能（`summary`、`branch_suggest`、`leaf`、`rebalance`、`goal`、`relations`、`group`）。
  `suggestions` 是建議匣：不是獨立的功能，只要有一個會提建議的功能對這個請求開著就是 `enabled`。
- `permissions.canWrite`：`Config.CanWrite` 對這個請求的結果。
- `models[]`：`{provider, models[], ready?, reason?, details?}`（`tangent.WithModelCatalog`）；`ready`（boolean）、`reason`（未就緒原因）與 `details[{model, displayName?, status?: "current" | "legacy", effortLevels?}]` 為選填（G1），未設定時不輸出。

```json
{"features":[{"enabled":true,"name":"notes"},{"enabled":true,"mode":"suggest","name":"summary"},{"enabled":true,"name":"search"}],
 "models":[{"models":["fake-1"],"provider":"fake"}],"permissions":{"canWrite":true}}
```

樣本：[route.capabilities.json](../httpapi/testdata/contract/route.capabilities.json)、[route.capabilities.viewer.json](../httpapi/testdata/contract/route.capabilities.viewer.json)（唯讀身分）。

### 主線

### `GET /lines`

讀。主線列表（只列主線），最新活動在前。

| 參數 | 說明 |
|---|---|
| `archived` | `true` 只列封存的樹；預設只列未封存 |
| `limit` | 1–200，預設 50 |
| `cursor` | 上一頁的 `nextCursor` |
| `folder` | B18：只列這個資料夾的主線（名稱照資料夾的規則正規化）；`__unfiled__` 只列未分類（`folder = ""`）的；空值不過濾 |
| `tag` | B18：只列帶這個標籤的主線（照標籤的規則正規化：去 `#`、轉小寫）；空值不過濾；超過 24 字 `400 invalid_input` |
| `pinned` | B25：`true` 只列釘選的主線（見下）；`false` 或不給不過濾；不是 `true` / `false` 回 `400 invalid_input` |

回應 `200 {lines: LineView[], nextCursor}`；`nextCursor` 為空字串表示沒有下一頁。樣本：[route.lines.list.json](../httpapi/testdata/contract/route.lines.list.json)。
沒給 `folder` 與 `tag` 時走原本的查詢與索引；有給時另一個查詢（同樣的 keyset 排序與游標，`archived` 照樣適用）。游標不帶篩選條件：換篩選要從第一頁重來。

**釘選的主線（B25）**：`pinned=true` 走另一個查詢，依 `pinnedAt` 新的在前（同時間依 id），**不分頁**：一次最多 200 筆（`limit` 有給時取它），
`nextCursor` 永遠是 `""`，帶 `cursor` 回 `400 invalid_input`（`field: cursor`）。`archived`、`folder`、`tag` 照樣適用。
釘選不影響一般列表：沒有 `pinned=true` 時的查詢、排序與游標和 B25 之前完全一樣（釘選的主線不會被排到前面，要排前面由客戶端合併兩份列表）。
樣本：[route.lines.list.pinned.json](../httpapi/testdata/contract/route.lines.list.pinned.json)。

### `POST /lines`

寫。建立主線。本文 `{title?, provider?, model?, folder?, tags?}`；沒給 provider / model 時用宿主的預設（`tangent.WithDefaultModel`）。
`pinned` 只能用 `PATCH` 設（建立時帶回 `400 invalid_input`）。
宿主用 `WithModelCheck` 限制可選模型時，不允許的組合回 `422 model_not_allowed`。

**資料夾與標籤（B18）**：`folder` 去頭尾空白、拿掉控制字元，最多 40 字（`domain.FolderMaxRunes`），`""` = 未分類，`__unfiled__` 保留給篩選
（兩者違反都是 `400 invalid_input`，`field: folder`）。`tags` 每個去頭尾空白、拿掉控制字元與開頭的 `#`、轉小寫，空的略過，依輸入順序去重；
每個 1–24 字、最多 12 個（`domain.TagMaxRunes`、`domain.TagsMax`；違反 `400 invalid_input`，`field: tags`）。正規化在 `domain.NormalizeFolder` / `domain.NormalizeTags`。

回應 `201 LineView`。樣本：[route.lines.create.json](../httpapi/testdata/contract/route.lines.create.json)、
[route.lines.create.rich.json](../httpapi/testdata/contract/route.lines.create.rich.json)。

```json
{"title": "Trip planning", "provider": "fake", "model": "fake-1"}
```

### `GET /lines/{id}`

讀。任一條線（主線或支線）。回應 `200 LineView`。樣本：[route.lines.get.json](../httpapi/testdata/contract/route.lines.get.json)、
[route.lines.get.rich.json](../httpapi/testdata/contract/route.lines.get.rich.json)；不存在：[route.error.line_not_found.json](../httpapi/testdata/contract/route.error.line_not_found.json)。

### `PATCH /lines/{id}`

寫。改標題、provider / model、資料夾、標籤或釘選。本文（必填）`{title?, provider?, model?, folder?, tags?, pinned?}`，至少一個欄位，否則 `400 invalid_input`
（`folder` / `tags` 的規則同 `POST /lines`；`tags` 整組取代；只能用在主線，對支線給非空的 `folder` 或 `tags` 回 `400 invalid_input`，給 `""` / `[]` 不改任何東西；
改資料夾或標籤不算活動，`lastActivityAt` 不變）
（宿主的 `Config.HostMeta` 對 `lines.update` 回了物件時，只改 `hostMeta` 也算有變更，見[宿主的操作名稱](#宿主的操作名稱op)）。
回應 `200 LineView`。樣本：[route.lines.update.json](../httpapi/testdata/contract/route.lines.update.json)。

**釘選（B25）**：`pinned: true` 釘選主線，`pinnedAt` 設成伺服器當下的時間（已經釘選的不變，保留第一次的時間）；`pinned: false` 取消（`pinnedAt` 不再出現）。
支線不能釘選：`pinned: true` 回 `400 invalid_input`（`field: pinned`），`false` 不改任何東西。不是布林值回 `400 invalid_input`。
釘選不算活動（`lastActivityAt` 不變，`updatedAt` 會變），發 `line.updated`。主線被 [attach](#post-linesidattach) 併成支線時釘選清掉；
[spinoff](#post-linesidspinoff) 產生的主線沒有釘選。釘選跟著帳號（存在伺服器），換裝置也在。

### `DELETE /lines/{id}`

寫。刪除整棵樹（只能對主線；支線回 `409 branch_not_main_line`，有回合正在進行回 `409 session_busy`）。
回應 `200 {rootLineId, lineIds[]}`（主線在第一個）。樣本：[route.lines.delete.json](../httpapi/testdata/contract/route.lines.delete.json)。

### `POST /lines/{id}/archive`

寫。封存整棵樹（只能對主線）。封存的樹拒絕新的回合與支線（`409 archived`）。回應 `200 {lines: LineView[]}`（樹上每條線）。
樣本：[route.lines.archive.json](../httpapi/testdata/contract/route.lines.archive.json)。

### `POST /lines/{id}/unarchive`

寫。解除封存。回應同 archive。樣本：[route.lines.unarchive.json](../httpapi/testdata/contract/route.lines.unarchive.json)。

### `POST /lines/{id}/read`

寫。清除這條線的未讀；祖先線的 `branchUnread` 會一起更新（各發 `line.updated`）。回應 `200 LineView`。
樣本：[route.lines.read.json](../httpapi/testdata/contract/route.lines.read.json)。

### `POST /lines/folders/rename`

寫（核心，B18）。把這個租戶 `folder = from` 的所有主線（封存的也算）改到 `to`；`to` 是 `""` 時解散資料夾（那些主線變成未分類）。
本文（必填）`{from, to}`：兩個名稱照資料夾的規則正規化，`from` 不能是空的（`400 invalid_input`，`field: from`）。`from` 與 `to` 相同時什麼都不做。
一個交易，那些主線依 id 順序上鎖；只改 `folder` 與 `updatedAt`（`lastActivityAt` 不變）。回應 `200 {updated}`（改了幾條主線）；
commit 之後每一條各發一個 `line.updated`。樣本：[route.lines.folders.rename.json](../httpapi/testdata/contract/route.lines.folders.rename.json)。

```json
{"from": "資料庫研究", "to": "Databases"}
```

### `POST /lines/import`

寫（核心，B18）。把外部服務（ChatGPT、Claude、Gemini、純文字或 Tangent 備份，由客戶端解析）的一段對話，在**一個交易、不呼叫任何模型**
的情況下寫成一條新主線、它的訊息與（選填的）一階支線。本文（必填）：

```
{title?, provider?, model?, folder?, tags?, source?, createdAt?,
 messages: [{externalId?, role: "user" | "assistant", content, createdAt?}],
 branches?: [{anchorExternalId, purpose?, kind?: "investigate" | "alternative", status?: "open" | "discarded" | "merged",
              card?: BranchCard（只有 merged 帶）, createdAt?, messages: [{role, content, createdAt?}]}],
 chapterCuts?: [{anchorExternalId, title}]}
```

`createdAt`、`chapterCuts`、`status: "merged"` 與 `card` 是 B19 新增的，全部選填；不帶它們的請求行為與回應和 B18 完全一樣。

- `messages` 1–2,000 則（`domain.ImportMaxMessages`；B21 前是 200）；每則 `role` 只能是 `user` / `assistant`；`content` 照宿主系統訊息的規則清理
  （`domain.CleanSystemText`：換行統一、拿掉控制字元與協定標記，保留 code fence）後不能是空的，上限同一般訊息（`Limits.Text.MessageMaxRunes`，預設 32,000 字，
  超過 `422 too_long`，`field` 例如 `messages[3].content`）。`externalId` 選填，只用來掛支線，同一個 import 不能重複。
- `branches` 最多 50 條（`domain.ImportMaxBranches`；B21 前是 20），都掛在主線上；`anchorExternalId` 必須是 `messages` 裡的某個 `externalId`；
  `kind` 預設 `alternative`、`status` 預設 `discarded`（匯入的歷史重問通常是試過、沒走下去的路）；每條 1–500 則訊息（`domain.ImportMaxBranchMessages`；B21 前是 100）；`purpose` 沒給時取支線第一則
  user 訊息（沒有就第一則）的前 60 字，規則同一般支線的目的（最多 200 字）。`open` 的支線算進每個父線 8 條的上限（超過 `409 branch_limit`）。
- `title` 沒給時取第一則 user 訊息（沒有就第一則）的前 60 字（`domain.ImportTitle`）；標題、provider / model、`folder` / `tags` 的檢查同 `POST /lines`。
  `source` 是來源標籤（最多 40 字），不存進資料表，只交給宿主的 InTx 掛勾（`store.ImportedLine.Source`）。
- **時間（B19）**：`createdAt`（對話、每則訊息、每條支線）是 RFC 3339 字串（例如 `2025-03-01T09:00:00Z` 或 `2025-03-01T17:00:00+08:00`），
  一律轉成 UTC 存。不是 RFC 3339 字串（例如 `"yesterday"`、數字）回 `400 invalid_input`，`field` 例如 `messages[3].createdAt`；
  範圍是 `1970-01-01T00:00:00Z` 到伺服器現在時間加 24 小時（`domain.ImportEarliest`、`domain.ImportFutureSlack`），超出同樣 `400 invalid_input`。
  整個請求只要有任何一個 `createdAt`，每條線（主線、各支線）各自這樣補齊：
  - 線的開始時間取「這條線的 `createdAt`」與「第一則有時間的訊息」中較早的；兩個都沒有就是現在。
  - 沒有時間的訊息，或時間比上一則早的訊息，取上一則的時間（第一則取線的開始時間），所以同一條線的訊息時間隨 `seq` 不會倒退
    （`decompose` 的 30 分鐘 `time_gap` 與章節的閒置切點因此不會看到負的間隔）。
  - 線的 `lastActivityAt` 與 `updatedAt` 是最後一則訊息的時間；支線的 `createdAt`（大綱的 `BranchView.createdAt`）跟它的線相同，結束的支線 `closedAt` 是它最後一則訊息的時間。
  - 整個請求都沒有 `createdAt` 時，一切照舊用匯入當下的時間。
  - 每條線各自補齊，不互相比較：支線的開始時間可以早於它的錨點訊息（例如來源本來就是平行的對話），順序仍以 `seq` 為準。
    `merged` 支線的 `closedAt` 是它最後一則訊息的時間，可能晚於主線上那張卡片（卡片的時間同錨點）。
    未來 24 小時內的時間會讓這條線暫時排在列表最前面（容許來源時鐘誤差）。
- **章節切點（B19）**：`chapterCuts` 最多 50 個（`domain.ImportMaxChapterCuts`，B21 前是 20；也不超過 `Limits.Chapters.MilestoneMaxPerTree`）；
  `anchorExternalId` 必須是主線 `messages` 的某個 `externalId`，同一則只能一個（`field` 例如 `chapterCuts[1].anchorExternalId`）；
  `title` 壓成一行、去掉前後空白後 1–60 字（也不超過 `Limits.Chapters.MilestoneTitleMaxRunes`，`field` 例如 `chapterCuts[0].title`）。
  寫成 `kind: milestone` 的切點，和 `POST /lines/{id}/chapters/milestones` 寫的一樣（`GET /lines/{id}/chapters` 的 `milestones`）。
  `chapters` 功能關著時切點照樣寫（`decompose` 讀得到），只是不發 `chapters.changed`。
- **已帶回的支線（B19）**：`status: "merged"` 必須帶 `card`（沒有或 `null` 回 `400 invalid_input`，`field: "branches[0].card"`）；其他狀態不能帶
  （同樣 `400`，同一個 `field`）。`card` 的解碼與 merge 一樣嚴格（未知欄位、重複欄位、不是物件都是 `422 invalid_card`，`problems[0].field` 是 `branches[0].card`）；
  `question` 空的時候用支線的 `purpose` 補上，再照 merge 的規則檢查（`question`、`conclusion` 必填與各欄長度）。匯入的訊息還沒有 id，所以卡片不能引用訊息：
  `evidence`、`excerpts` 不能有，`needsDecision` 不能帶 `mainLineMessageId`。卡片的問題是 `422 invalid_card`，每個 `problems[].field` 前面加支線的位置
  （例如 `branches[0].card.conclusion`）。
- 違反規則都是 `400 invalid_input`，`field` 指出哪一個欄位（例如 `branches[0].anchorExternalId`）；卡片例外，是 `422 invalid_card`。
- 寫入：主線的訊息依序寫成 `kind: chat`、`status: done`，沒有 `usage`、`model` 或其他 `meta`；每條支線照一般開支線的方式在錨點開出（背景包從錨點以前的匯入訊息建出，
  `origin: import`、`depth: 1`），寫入支線訊息，`discarded` 的直接結束。匯入不算回合：不跑任何背景工作、不呼叫功能的掛勾、不累計用量、沒有未讀。
- `merged` 支線的結論卡寫在主線上**緊接在它的錨點訊息之後、下一則主線訊息之前**（同一則錨點上有好幾條時照輸入的順序）：
  `role: system`、`kind: branch_card`、`meta.card`、`meta.branchLineId`、`meta.delivered: true`（那些輪次本來就是對話的一部分，之後的回合不會再當通知帶出），
  內容是 `RenderBranchCardMarkdown`，時間同錨點訊息。支線 `status: merged`、`cardMessageId` 是這張卡、`conclusionLine` 從卡片來；
  `leaf` 功能開著時同時寫成 `confirmed` 的葉子（同 extract 帶卡片）。
- 本文上限另外是 `Config.MaxImportBodyBytes`（預設 16 MiB，至少 `MaxBodyBytes`），超過 `413 payload_too_large`。

回應 `201 {line: LineView（新主線）, branches: BranchView[]（照輸入的順序）, messageCount}`；`messageCount` 是寫到**主線**的匯入訊息數
（`messages` 的則數，B19 的結論卡不算）。回應的形狀不因 B19 的欄位改變。
commit 之後發 `line.created`（主線），再對每條支線發 `line.created` 與 `branch.changed{created}`（`merged` 的也是 `created`，`branch.status` 是 `merged`）；
B19 起再對每個寫入的葉子發 `leaf.changed`，`chapters` 功能開著且寫了切點時發一個 `chapters.changed`。
樣本：[route.lines.import.json](../httpapi/testdata/contract/route.lines.import.json)、
帶 B19 欄位的 [route.lines.import.assembled.json](../httpapi/testdata/contract/route.lines.import.assembled.json)。

**匯入批次（B25）**：本文多兩個選填欄位 `batchId`（UUID，**客戶端產生**，例如一次匯入好幾個檔案共用一個）與 `batchLabel`（例如檔名，壓成一行、去頭尾空白，最多 120 字，
`domain.ImportBatchLabelMaxRunes`）。有 `batchId` 時同一個交易裡建立批次（這個租戶第一次用這個 id），或沿用已有的（同一租戶再用同一個 id 是「同一批的下一篇」，
`batchLabel` 以第一次的為準），新主線的 `importBatchId` 就是它。別的租戶的 `batchId` 回 `404 import_batch_not_found`（不透露是否存在），什麼都不寫。
同時用同一個新 `batchId` 匯入不會因唯一鍵衝突失敗（後到的等先到的 commit 後沿用）。`batchId` 不是 UUID（或是全 0 的 UUID）、只給 `batchLabel`、`batchLabel` 太長
都是 `400 invalid_input`（`field: batchId` / `batchLabel`）。不帶這兩個欄位時行為與回應完全不變。批次見 [`GET /imports`](#get-imports)。
樣本：[route.lines.import.batch.json](../httpapi/testdata/contract/route.lines.import.batch.json)。

### `GET /imports`

讀（核心，B25）。這個租戶的匯入批次，新的在前。參數 `limit`（1–200，預設 50）、`cursor`（上一頁的 `nextCursor`；壞的游標 `400 invalid_input`）。
回應 `200 {imports: [{id, label, createdAt, lineCount, standaloneCount}], nextCursor}`：`lineCount` 是這個批次**還存在的**線數（被刪的不算，被 attach 併走的算），
`standaloneCount` 是其中仍是獨立主線的。批次列不設上限、不會自動清；`DELETE /lines/{id}` 不動批次列（`lineCount` 自然變少，可能是 0）。
樣本：[route.imports.list.json](../httpapi/testdata/contract/route.imports.list.json)。

### `DELETE /imports/{bid}`

寫（核心，op `imports.delete`，`Engine.DeleteImportBatch`，B25）。復原一次匯入：刪掉這個批次裡**仍是獨立主線**的每一棵樹，然後刪批次列。參數 `force`（`true` / `false`，預設 `false`）。

- 逐棵用 `DELETE /lines/{id}` 的同一條路徑（各自一個交易、各自的鎖、各自發 `line.deleted`、宿主的 InTx 掛勾每棵都跑），**不是整批原子**：中途失敗時前面刪掉的不會回來。
- 留下的線與原因（`kept[].reason`）：`attached`（已經 attach 到別的對話，現在是那裡的支線）、`busy`（樹上有回合正在進行）、
  `changed`（匯入之後又用過：主線的 `lastActivityAt` 變了、樹上有匯入之後寫的訊息或改過的結論卡、有不是匯入建立的支線，或樹上有 notes、備忘、名詞、停車場種子——匯入不會寫這些）。
  `force=true` 時 `changed` 的也刪；`attached`、`busy` 永遠不刪。判斷在那棵樹的鎖之下做，和刪除是同一個交易。
  釘選、資料夾、標籤、已讀、封存不算「用過」。匯入的時間可以是來源的歷史時間（B19），所以不拿 `lastActivityAt` 和現在比，而是和匯入當下寫入的值比。
- `kept` 是空的時候刪掉批次列；不是空的時候批次列保留，之後可以再刪一次（例如 `force=true`，或取消回合之後）。
- 回應 `200 {deleted: [rootLineId…], kept: [{lineId, reason}]}`，兩者都依匯入的順序。沒有這個批次、別的租戶的、`{bid}` 不是 UUID → `404 import_batch_not_found`；
  `force` 不是布林值 `400 invalid_input`。
- 宿主的 InTx 掛勾：每棵樹收到 `store.DeletedTree`（刪除**之前**），批次列刪除時再收到 `store.RemovedImportBatch`。

樣本：[route.imports.delete.json](../httpapi/testdata/contract/route.imports.delete.json)。

### `GET /lines/{id}/decompose`

讀（核心，B18；唯讀身分也可以）。對一條線（主線或支線）提出不花錢、不呼叫模型、不寫入的整理建議（`domain.BuildDecomposePlan`，同樣的訊息永遠得到同樣的結果）。
只讀這條線最舊的 2,000 則訊息（`domain.DecomposeMaxMessages`，B21 前是 400；超過時 `truncated: true`）。回應 `200`：

```
{lineId, truncated,
 suggestedTags: string[]（最多 5）, chapterCuts: [{messageId, seq, title, reason: "topic_shift" | "time_gap"}]（最多 8）,
 detourRanges: [{fromMessageId, toMessageId, anchorMessageId, messageCount, purpose, suggestedConclusion}]（最多 8）,
 seedCandidates: [{messageId, text, reason: "question" | "open_item"}]（最多 8）,
 relatedLines: [{lineId, title, folder, sharedTags}]（最多 5）}
```

- `suggestedTags`：標題與前 6 則訊息的主題詞（3 個字母以上的英數字詞、相鄰兩個漢字；去掉常用詞），至少出現在其中兩處（標題、各則訊息）才算，
  依出現次數（標題算三次）排序，照標籤規則正規化，已經是這棵樹主線標籤的不列。B18.1 起再清理一次（`domain.cleanSuggestedTags`，規則同網頁客戶端的
  `filterSuggestedTags`，客戶端再清一次結果不變）：含英數字的詞、不全是漢字的詞、這個租戶未封存主線已在用的標籤原樣保留；落在標題同一個主題詞裡的雙字詞
  依重疊接回原詞（標題以標點、非漢字、連接詞〔為什麼、如何、還是、關於…〕與功能字〔的、在、與、要、怎…〕切成 2–8 字的主題詞；
  「微分幾何在研究什麼?」的 `微分`、`分幾`、`幾何` → `微分幾何`；B19 起租戶已在用的標籤也參與接合，所以租戶有 `幾何` 時不會得到斷尾的 `微分幾`，
  `微分幾何` 與 `幾何` 都會列出）；其餘開頭或結尾是功能字的雙字詞丟掉（`何在`），在清單中首尾相接的接起來（最多 6 字）。
  接好的詞若是這棵樹主線的標籤也不列；清理後取前 5 個。
- `chapterCuts`：還沒有章節切點的 user 訊息（不含第一則）：與上一則間隔 ≥ 30 分鐘（`time_gap`）；開頭是轉折詞（`另外`、`順便問`、`換個`、`那如果`、`話說`、`對了`、
  `By the way`、`btw`、`Another question`、`Switching to`、`On another note`… → `topic_shift`）；或離上一個切點至少 12 則時，前後各 6 則訊息的主題詞重疊不到 15%（`topic_shift`）。
  `title` 是那則訊息的前 40 字（套用時當 milestone 名稱）。匯入的訊息時間都一樣，所以匯入的對話不會有 `time_gap`。
- `detourRanges`：從第 3 則起的 user 訊息開始、1–4 輪問答的區段：開頭問報錯（`error`、`exception`、`traceback`、`報錯`、`錯誤`、`失敗`、`連不上`…）、
  短的「什麼是」問題（80 字內：`what is`、`explain`、`什麼是`、`是什麼`…），或與主題（標題與第一輪）一個詞都不重疊；區段只含完成的 user / assistant 訊息、
  以回覆結束，之後的 user 訊息又回到主題（問報錯或「什麼是」的區段也可以在線尾）。`anchorMessageId` 是區段前最近可掛支線的訊息；`purpose` 是
  `了解：` + 第一則的前 40 字（沒有漢字時 `Look into: `）；`suggestedConclusion` 是區段最後一則回覆的第一句（最多 200 字）。直接可以拿去
  `POST /branches/extract`。
- `seedCandidates`：從最新的回覆往回找：列點項目中是問句或帶「待確認、待辦、下一步、TODO、next step、open question…」的，以及回覆最後的問句；同樣的文字只列一次，依 `seq` 排列。
- `relatedLines`：同租戶、未封存的其他主線，與這棵樹的主線有共同標籤或在同一個（非空的）資料夾；共同標籤多的在前，再依最新活動；`sharedTags` 依字母排序。
  主線沒有標籤也沒有資料夾時是 `[]`。

樣本：[route.lines.decompose.json](../httpapi/testdata/contract/route.lines.decompose.json)。

### `GET /lines/organization`

讀（核心，B18.1；唯讀身分也可以）。這個租戶**所有**主線的資料夾與標籤統計（不分頁、不受 `GET /lines` 的篩選影響），讓清單只載入第一頁或在 `?tag=` 篩選中時，
資料夾清單、標籤膠囊與自動補完仍有完整的名稱與真實篇數。回應 `200`：

```
{folders: [{folder, active, archived}], tags: [{tag, count}]}
```

- `folders`：非空資料夾，依名稱（code point 順序，`COLLATE "C"`）；`active` / `archived` 分開數這個資料夾的未封存與已封存主線
  （只剩封存對話的資料夾也列，`active: 0`）。
- `tags`：**未封存**主線上的標籤與帶著它的主線數，篇數多的在前、同數依名稱。
- 支線不算（支線本來就沒有資料夾與標籤）。沒有任何資料夾或標籤時是 `[]`，不會是 `null`。
- 沒有新的索引或 migration：每次讀都彙總這個租戶的主線（資料夾那一半可用 `idx_tangent_line_folder`）。客戶端在 `line.created`、
  `line.deleted` 與資料夾、標籤或封存狀態改變的 `line.updated` 之後重讀。

樣本：[route.lines.organization.json](../httpapi/testdata/contract/route.lines.organization.json)。

### `POST /lines/import-analyze`

讀（核心，B22；唯讀身分也可以，不是寫入、沒有 `op`，**不寫資料庫、不發事件**）。匯入前的預處理分析：把要匯入的問答輪次（或整篇對話）當成「單元」，
提出一棵主幹＋支線樹（`domain.ImportAnalyzePlan`）：跨段穿插的同主題單元（`A → B → A → C → A → B`）縫合成同一個節點，並給每個節點角色。本文（必填）：

```
{title?, units: [{key, title?, question, answer, messageCount, startAt?}]}
```

- `units` 1–200 個（`domain.ImportAnalyzeMaxUnits`）；`key` 去掉前後空白後不能是空的、不能重複、最多 200 字；`messageCount` 0–100,000；`startAt` 選填，RFC 3339。
  違反都是 `400 invalid_input`，`field` 例如 `units[1].key`。`question` 清理後截成 600 字、`answer` 截成 2,000 字（`domain.ImportAnalyzeQuestionRunes`、`ImportAnalyzeAnswerRunes`，B26；確定性演算法只讀前 300 字，`domain.ImportAnalyzeTextRunes`），`title` 截成 200 字；
  截斷不算錯。客戶端不能帶 `hostMeta`（`400 invalid_input`）。本文上限是 `Config.MaxImportBodyBytes`（同 `POST /lines/import`）。
- **模型**：只問可以寫入的呼叫者（`Config.CanWrite` 為 nil 或回 true）。唯讀身分（viewer）不能匯入，所以永遠只拿到確定性演算法的結果（`source: "heuristic"`），不會花模型預算；路由本身仍是讀。
  API 的 `Dispatcher` 能同步跑一次請求時（`tangent.OnceRunner`，例如 `RunnerDispatcher.RunOnce`：算進 `WithMaxQueue` 與 `WithMaxOnce`、等 `WithMaxConcurrent` 的名額），
  用引擎的預設 provider / model 問一次（`domain.BuildImportAnalyzePrompt`：單元以 `U1…` 編號、內容當成引用資料，模型只回 JSON；B26 起每個單元是問題（> 400 字時前 300 … 後 100）、回答首句與末句、回答關鍵詞一行，與上一個單元相隔超過 30 分鐘時標 `+2d 3h`，整個 prompt 不超過 60,000 字，放不下時依序去掉末句、首句，最後只剩問題與關鍵詞），最多 45 秒（`tangent.ImportAnalyzeTimeout`）。
  回覆經 `domain.ParseImportAnalyzeOutput` 嚴格檢查與修補（可以包在 json code fence 裡；未知與重複的單元丟掉，漏掉的單元併入前一個單元的節點；
  不認得的角色當章節；沒有章節時**單元最多**的節點當章節（第一個單元常是寒暄）；標題只是類別詞（技術討論、其他、Misc…）或書寫系統與提問不同
  （中文提問配超過兩個詞的純英文標題、純英文提問配中文標題）時改用第一個單元自己的標題；支線的 `attachToKey` 必須是章節節點，否則改掛它所在跨度的章節；匯入上限同下）。
  prompt 要模型逐單元判定「接哪個 U」，不確定就分開（下一步合併是一次拖曳、拆肥節點要重讀），同領域同工具的不同問題是不同節點，寒暄不併入章節，
  標題用單元自己的字、禁用類別詞、語言跟提問而不是回覆，並附一個 A→B→A 的範例（`domain.importAnalyzeInstructions`）。
- **降級**：沒有這樣的 Dispatcher、呼叫失敗或逾時、回覆不是可用的計畫（例如 fake runner 的回覆）時，改用確定性演算法 `domain.AnalyzeImportDeterministic`，
  `source: "heuristic"`；伺服器 log 記原因（不含對話內容）。所以這個路由不會因為模型而失敗。
- **確定性演算法**（與網頁客戶端 `analyzeImportLocal` 相同）：主題詞同 B21 的分篇（英數字詞 2 字母以上、相鄰兩個漢字，去掉疑問詞、功能字與常用詞）。
  **詞權重**（`domain.analyzeTermWeights`）：漢字雙字 1.0、英數字詞 1.5；出現在超過一半單元（單元 ≥ 4 時）的詞與對話標題裡的詞各減半（Postgres 對話裡的 Postgres 只代表領域）。
  單元依序縫合：上一個節點還沒有回覆、問題沒有主題詞、或問題的每個詞目前節點都問過或剛答過時，留在目前節點；
  否則算問題與每個節點的**共用權重**：節點問過的詞算全額，只出現在節點最近 2 個單元回覆裡的詞英數字算全額、漢字減半，
  位置相連的共用漢字雙字算一個詞組、取最輕的那個（「連線時」拆成連線＋線時只算一次）。
  讀起來像延續的問題（開頭是那、還有、如果、承上、繼續、要怎麼、這、它、what about…；或 ≤ 30 字、不以 ?／嗎／呢 結尾、含了／是／到／很等陳述字、不是命令句的回報句；或含它、那個、上面、剛剛、這次、最後、也、再、還要等回指詞）
  在沒有別的節點達門檻時留在目前節點；開頭（前 12 字內）是另外、對了、順便、我想問、請問、by the way 等換題詞的不適用。
  其餘取共用權重最高且達門檻的節點（同分時目前節點優先，其次最近的）：留在目前節點的門檻 1.0（一個漢字詞），回到更早節點的門檻 1.2（兩個漢字詞或一個名字）；都不到就開新節點。
  角色依節點第一個單元的順序：第一個 core 節點（2 個以上單元或 4 則以上訊息）是章節，沒有 core 時單元最多的是（開場寒暄不因為最先出現就變章節）；
  第一個單元落在某章節跨度**之內**（該章節第一與最後單元之間）的是那個章節的 `merged_branch`（取最內層），
  掛在該章節在它之前的最後一個單元之後，結論是它最後一個回覆的第一句（120 字）；其餘 core 節點是章節，剩下的是 `standalone`。
  匯入放不下時照網頁的樹狀預設移動（支線超過 500 則或已有 50 條 → 章節，再不行 → 獨立對話；章節超過 2,000 則或已有 50 個 → 支線，再不行 → 獨立對話）。
  評測集 `domain/testdata/import_analyze_eval/` 上 pairwise precision／recall 合計 0.93／0.93（原本 0.42／0.41）。

回應 `200`：

```
{mode: "tree" | "timeline" | "batch", source: "model" | "heuristic", summary,
 nodes: [{key, unitKeys: string[], title, role: "chapter" | "merged_branch" | "open_branch" | "standalone",
          attachToKey?, attachAfterUnitKey?, conclusion?, reason?}]}
```

每個輸入單元恰好出現在一個節點的 `unitKeys`（依輸入順序）；`key` 是該節點最早的單元；`attachToKey` 是章節節點的 `key`、`attachAfterUnitKey` 是那個章節的單元
（只有支線有）；`conclusion` 只有 `merged_branch` 有（最多 300 字）；`title` 最多 60 字、`reason` 200 字、`summary` 300 字。有支線時 `mode` 一定是 `tree`。
樣本：[route.lines.import_analyze.json](../httpapi/testdata/contract/route.lines.import_analyze.json)（fake runner，所以是 `heuristic`）。

### `GET /lines/{id}/export`

讀（核心，不需要功能；唯讀身分也可以）。`{id}` 是樹上任何一條線；回傳整棵對話（B14）：

```
{rootLineId, exportedAt, truncated, rootLine: LineView, branches: BranchView[]（含岔題，舊的在前）,
 messagesByLine: {<lineId>: Message[]}, notes: Note[], memos: Memo[], terms: Term[], chapters: Chapter[]（主線的）, goal: Goal | null,
 comparisons: Comparison[]（樹上所有比較，舊的在前，最多 500）, links: Link[], foldsByLine: {<lineId>: Fold[]}}
```

- `messagesByLine`：主線與每條支線都有 key（沒有訊息的是 `[]`）；每條線依 `seq` 取最舊的 **500** 則
  （`tangent.ExportMaxMessagesPerLine`）。任何一條線超過 500 則時 `truncated: true`，要完整的那條線改用 `GET /lines/{id}/messages` 分頁。
  大綱到了 500 條支線（`store.OutlineCap`，只有宿主把每棵樹的支線上限調高才會碰到）或比較表超過 500 筆時也是 `truncated: true`。
- 大小：最多是（支線數＋1）× 500 則訊息，全部在一個回應裡（預設每棵樹最多 200 條支線）；很大的樹改用分頁的路由。
- 功能資料只在該功能對這個讀者開著時才讀：`notes`、`memos`（`memo`）、`terms`（`glossary`，B24，依 `termKey` 排序）、`chapters`、`goal`、`comparisons`（`diverge`）、
  `links`（`spinoff` 的與 `relations` 的，依各自的功能）、`foldsByLine`（`fold`，只放有未收回折疊的線）。功能關著時是 `[]`、`null`（`goal`）或 `{}`，
  **不回** `feature_disabled`。
- 每一部分是一個查詢（不隨線數增加），但各部分依序讀取，不是同一個快照：讀取途中的寫入可能只出現在其中一部分。
- 不是這個租戶的線 → `404 line_not_found`。回應 `200`。樣本：[route.lines.export.json](../httpapi/testdata/contract/route.lines.export.json)。

### 訊息與回合

### `GET /lines/{id}/messages`

讀。這條線的訊息，依 `seq` 由舊到新。

| 參數 | 說明 |
|---|---|
| `afterSeq` | 只回傳 `seq` 大於它的訊息（≥ 0） |
| `limit` | 1–500，預設 100 |

回應 `200 {messages: Message[]}`。樣本：[route.messages.list.json](../httpapi/testdata/contract/route.messages.list.json)、
[route.messages.list.rich.json](../httpapi/testdata/contract/route.messages.list.rich.json)（卡片、標記、建議）、
[route.messages.list.pending.json](../httpapi/testdata/contract/route.messages.list.pending.json)（進行中的回合）。

### `POST /lines/{id}/messages`

寫。開始一輪：插入使用者訊息與一則 pending 的助理訊息，交給 `Config.Dispatcher`。本文（必填）`{content}`（去前後空白後不可為空）。

回應 `202 {turnId, userMessage, pendingMessage}`；`turnId` = pending 訊息的 id。之後用 [`message.delta`](#messagedelta) /
[`/stream`](#get-linesidstream) 看串流、[`message.updated`](#messageupdated) 看完成。Dispatcher 拒收（例如佇列滿）時這一輪立刻標成失敗並回
`503 unavailable`。

```json
{"turnId":"…0002","userMessage":{"role":"user","status":"done","content":"When should I go to Kyoto?","seq":1,…},
 "pendingMessage":{"role":"assistant","status":"pending","content":"","seq":2,"meta":{"actor":"tester","model":"fake-1","provider":"fake"},…}}
```

常見錯誤：`409 turn_pending`（這條線已有進行中的回合）、`409 archived`、`409 branch_closed` / `aside_answered` / `branch_drafting`
（祖先鏈上有關閉、已回答或正在起草的支線）、宿主 `TurnGate` 自己的碼。
樣本：[route.messages.send.json](../httpapi/testdata/contract/route.messages.send.json)、[route.error.turn_pending.json](../httpapi/testdata/contract/route.error.turn_pending.json)。

回合完成時（B16）：回覆裡以 `[TOPIC]` / `[CHAPTER]` 開頭的行一律不串流、不存。一條線的第一輪 prompt 要了主題要約、模型也給了合格的
`[TOPIC]` 時，完成後接著改名，事件與手動改名相同：主線發 `line.updated`（`title` 是新名字）；支線（不是順口問）發
`branch.changed{change: renamed}` 與支線的 `line.updated`（`title` 與 `conversationBranch.purpose` 是新目的）。順序是這一輪的
`message.updated`、`line.updated`（idle）之後。`chapters` 開著時，主線回覆的合格 `[CHAPTER]`（以及主線第一輪的 `[TOPIC]`）在這一輪的
使用者訊息記 topic 切點並發 `chapters.changed{rootLineId}`；`GET /chapters` 的那一章 `kind: topic`、`titleSource: topic`。
這一輪進行中使用者自己改了名（主線原本就有標題時改了標題；支線改了目的）就不改；原本沒有標題的主線，進行中被設了暫時標題仍會換成 `[TOPIC]`。
這兩條規則在 prompt 的 `reply_lines` 區塊（不快取的尾段，`POST /preview` 的 `blocks[]`（`key: reply_lines`）與 `prompt.trailing` 會看到）。

### `GET /lines/{id}/stream`

讀。補抓進行中回合已串流的 delta（重新連線、換頁後用）。參數 `afterSeq`（上次看到的 delta `seq`）。

回應 `200 {deltas: Delta[], seq, truncated}`；`seq` 是這條線最新發出的 delta 序號（沒有緩衝時 0）。`truncated` 為 true 表示
`afterSeq` 之後有 delta 已經不在緩衝裡（緩衝是每個行程的記憶體快取），改為重新讀訊息。
宿主設了 `Config.DeltaFilter` 時，`deltas` 依這個讀者過濾（可能少了幾則或內容被改寫；`turnId`、`seq` 不變，`seq` 欄位仍是這條線最新的序號）。
樣本：[route.stream.json](../httpapi/testdata/contract/route.stream.json)、[route.stream.midturn.json](../httpapi/testdata/contract/route.stream.midturn.json)、
[route.stream.truncated.json](../httpapi/testdata/contract/route.stream.truncated.json)。

### `POST /lines/{id}/retry`

寫。重跑最後一個失敗的回合：失敗的助理訊息保留為 `error`（不進 prompt），不重複使用者訊息，開一則新的 pending 回覆。
回應同 `POST /messages`（`202`）。最後一輪沒有失敗 → `409 nothing_to_retry`（失敗回覆後面的宿主系統訊息不算，仍可重跑）。
樣本：[route.retry.json](../httpapi/testdata/contract/route.retry.json)、[route.error.nothing_to_retry.json](../httpapi/testdata/contract/route.error.nothing_to_retry.json)。

### `POST /lines/{id}/cancel`

寫。取消這條線進行中的回合；已串流的部分文字寫進訊息，`meta.cancelled = true`。沒有進行中的回合時 `cancelled: false`。
回應 `200 {cancelled, line: LineView, message: Message | null}`。樣本：[route.cancel.json](../httpapi/testdata/contract/route.cancel.json)。

### `POST /lines/{id}/compact`

寫，功能 `summary`。立刻排一個滾動摘要 job（強制摘要；auto 模式下 Engine 也會在需要時自己排）。回應 `202 {jobId, kind, lineId, provider, model}`；Dispatcher 拒收 → `503 unavailable`。
樣本：[route.compact.json](../httpapi/testdata/contract/route.compact.json)。

### `POST /lines/{id}/preview`

讀。預覽下一輪會送出的 prompt 與 token 估計，不寫入任何東西。本文 `{content?}`（這一輪打算送的訊息）。

回應 `200 {prompt, blocks[]{key, role?, content, tokens}, totalTokens, provider, model, estimatedCostUsd?, budget, fisheye?, folds?}`；
`blocks` 的順序就是送出的順序（規則 → 目標 → 背景包 / 起始膠囊 → 紀要 → 宿主區塊 → 摘要 → 卡片通知 → 宿主的尾段區塊 → 其他支線的結論（`branch_conclusions`，魚眼）→ 記憶（`memory`）→ 名詞表（`glossary`，B24）→ 回覆行規則（`reply_lines`，B16：`[TOPIC]` / `[CHAPTER]`，只在有要時）→ 歷史 → 這一輪）。
宿主標了 `Trailing` 的區塊（B7.1，每一輪會變的宿主資料）排在摘要之後的尾段（卡片通知之後、其他支線的結論與記憶之前），`prompt.trailing[]` 裡的這些區塊帶 `trailing: true`；沒標的照舊在「宿主區塊」的位置。
`estimatedCostUsd` 只有宿主設了 `WithPricing` 才有，只算輸入。

- `budget`（B9）：這一輪共用的 token 預算怎麼分。`{total（Limits.Context.TokenBudget，預設 40000）, shares[]{owner, tokens}, history, used}`；
  `shares` 依花用順序：`core`（背景包、起始膠囊、卡片通知）→ 各功能（`notes`、`goal`、`summary`、`glossary`…，依 `WithFeatures` 順序）→ `host`（宿主區塊）→ `history`；
  `history` 是歷史分到的上限（剩下的，最多 `Limits.History.TokenBudget` 24000）。規則與這一輪的訊息不計。沒花到的 owner 不列。
- `fisheye`（B9，`fisheye` 開著時才有）：`{items[]{kind: message | branch, id（訊息或支線線的 id）, lineId, level: full | summary | leaf_only | hidden, score, tokens}, tokens, budget}`。
  訊息依時間（舊的在前），支線依分數（高的在前）。分數 = 先天重要性 − 距離：訊息是「釘選 +100、結論卡 +6、被紀要或卡片引用 +4、確認的 `decision` 標記 +4（`ibis` 開著時）」減「往前第幾個來回」；
  支線是收尾的種類（`decision` 5、`conclusion` 4、`answer` 3、`to_continue` 2、`dead_end` 1；沒有收尾但有卡片結論 4）減樹上的距離（邊數）。
  程度：訊息 `full`（原文）/ `summary`（併進「Earlier in this session」的一行，或已被滾動摘要涵蓋）/ `hidden`；支線 `leaf_only`（進「其他支線的結論」區塊）/ `hidden`（沒有收尾或太遠）。
  預算不夠時從分數低的開始降級；最新的一則永遠保留原文。這條線自己與它的祖先不是項目（背景包已帶）。門檻在 `Limits.Fisheye`。
  B10：折疊在魚眼之前套用，折疊的摘要是一個 `kind: fold` 的項目（`id` = 折疊 id），它涵蓋的訊息不是項目。
- `memories`（B10 階段 C，`memory` 開著、沒設 `NoTurnRecall` 且這一輪有召回時才有）：`[{memory: Memory, similarity, score}]`，就是 trailing 區塊 `memory`（`## Remembered from earlier conversations`）帶的記憶。
  DESIGN §12：每一輪自動帶入的記憶**只在預覽裡**看得到。
- `folds`（B10，`fold` 開著且這一輪有套用時才有）：`[{foldId, fromSeq, toSeq, messages（這一輪它取代了幾則）, tokensOriginal, tokensSummary}]`。
  被取代的訊息在 `prompt.history`（與 `blocks` 的 `history`）裡是一則 system 項目：`Folded part of this conversation (N messages), summarized; …` 加上引用的摘要。

樣本：[route.preview.json](../httpapi/testdata/contract/route.preview.json)、[route.preview.fisheye.json](../httpapi/testdata/contract/route.preview.fisheye.json)（魚眼）、[route.preview.folds.json](../httpapi/testdata/contract/route.preview.folds.json)（折疊）。

### 支線

### `GET /lines/{id}/branches`

讀。整棵樹的支線大綱（傳入支線 id 也解析到根）。參數 `includeAside=true` 才包含岔題（aside）。
回應 `200 {branches: BranchView[]}`。B10：支線掛的那則訊息有論證類型時，`BranchView.anchorTag = {kind, source, status, updatedAt}`（沒有就不出現；功能關閉時已存的照樣帶出）。
樣本：[route.branches.list.json](../httpapi/testdata/contract/route.branches.list.json)、
[route.branches.list.rich.json](../httpapi/testdata/contract/route.branches.list.rich.json)、[route.branches.list.anchor_tag.json](../httpapi/testdata/contract/route.branches.list.anchor_tag.json)（anchorTag）。

### `POST /lines/{id}/branches`

寫。從 `{id}` 這條線的某則訊息開支線。本文（必填）：

| 欄位 | 說明 |
|---|---|
| `anchorMessageId` | 必填；父線上 `done` 的 user / assistant 訊息，或父線上的結論卡（`kind: branch_card`，從帶回的結論繼續追問，B17） |
| `purpose` | 必填；≤ 200 字 |
| `kind` | 必填；`investigate` / `alternative` / `aside`（`aside` 功能關閉時 `404 feature_disabled`） |
| `excerpt` | 選取的文字，≤ 1500 字 |
| `provider`、`model` | 預設繼承父線 |
| `confirmDeeper` | 超過軟深度（3）時必須為 true，否則 `409 depth_soft_limit` |
| `includeLater` | 背景包也帶入 anchor 之後父線的對話 |
| `suggestionMessageId` | 接受 AI 建議時填那則助理訊息；`purpose` / `kind` 必須對上其中一個建議（`branch_suggest` 功能） |
| `keep` | 選填（B23）；`true` = 這條順口問一開始就保留（答完後不被清除，`branch.keptAt` 有值）。只對 `kind: aside` 有意義，其他種類給 `true` → `400 invalid_input`（`field: keep`） |

回應 `201 {line: LineView, branch: BranchView, pack}`。上限錯誤：`depth_soft_limit`、`depth_hard_limit`、`branch_limit`、`tree_limit`。
樣本：[route.branches.create.json](../httpapi/testdata/contract/route.branches.create.json)。

```json
{"anchorMessageId":"…0002","purpose":"Compare ryokan and hotels","kind":"investigate","excerpt":"Kyoto in autumn"}
```

### `POST /lines/{id}/branches/move`

寫。把這條線最後 `count` 則訊息搬成一條新支線；來源線留下一則 `branch_marker`。本文（必填）
`{count (1–40), purpose, kind?（預設 investigate）, provider?, model?, confirmDeeper?}`。搬的第一則必須是 user 訊息、不能包含卡片或標記、
來源線不能在回合中。

回應 `201 {line, branch, marker: Message, sourceLineId, rootLineId, movedMessageIds[], reparented[], summaryReset}`。
樣本：[route.branches.move.json](../httpapi/testdata/contract/route.branches.move.json)。

### `POST /lines/{id}/branches/extract`

寫（核心，B18）。把這條線（主線或支線）上任意一段連續的訊息 `[fromMessageId … toMessageId]`（依 `seq`，兩端都含；中段或尾段都可以）抽成一條新支線，
在原來的位置留下 `branch_marker`，或帶了 `card` 時直接留下一張已帶回的結論卡（`branch_card`）。`move` 是它只搬尾段的特例。本文（必填）：
`{fromMessageId, toMessageId, purpose, kind?（investigate（預設）/ alternative）, provider?, model?, confirmDeeper?, card?: BranchCard}`。

- 兩端都必須是這條線的訊息（否則 `404 message_not_found`），`from` 不能在 `to` 之後（`400 invalid_input`）；區間 1–40 則（`400 invalid_count`）。
- 區間裡只能是完成的 user / assistant 一般訊息：有失敗的回覆、結論卡、搬移標記或宿主系統訊息，或區間裡的訊息上開過、已經帶回而結論卡還在這條線上（區間之後）的支線（抽走會把支線帶走、卡留下）→ `400 move_protected_message`；第一則必須是 user（`400 move_must_start_with_user`，同 move）。錯誤碼與狀態沿用 move 的。
- 線在回合中（`thinking` 或有 pending 的回合）→ `409 source_busy`；封存 → `409 archived`；支線的上限（深度、開放數、整棵數）同開支線。
- 新支線掛在區間**之前**最近一則可以掛支線的訊息上（完成的 user / assistant 訊息，或結論卡，B17）；沒有 → `400 move_no_anchor`（所以第一則不能被抽走）。
  背景包從那則以前的訊息建出（同 move），`origin: move`。
- 排序：區間的訊息搬到新支線、順序不變；區間最後一則換一個新的 `seq`（仍是支線裡最新的一則），標記（或結論卡）用它空出來的 `seq` 寫在來源線上，
  所以標記就在區間原本的位置，之前與之後的訊息、之後每一輪的 prompt 歷史都照原本的順序讀。標記的 `createdAt` 與區間最後一則相同（依時間算的章節間隔不會在那裡多一刀）。
- 掛在被搬走訊息上的支線改掛到新支線、整棵子樹 depth +1（超過硬上限 `409 depth_hard_limit` 整筆回滾）；來源線的滾動摘要涵蓋了被搬走的訊息就重設；
  跨過區間兩端或包住區間的折疊（`fold`，含失敗的）移除，完全在區間內的折疊跟著搬到新支線（同 move 的規則）；區間後面還有訊息時，章節切點在被搬走訊息上的，每一種
  （topic、milestone）最新的那個移到標記上，讓後面的訊息留在同一章（其他的跟著訊息走）。釘選、論證類型、種子、關聯的訊息端都跟著訊息。
- **帶 `card`**：卡片照 merge 的規則檢查（`422 invalid_card`；`evidence` 等引用的支線端訊息必須是區間裡的訊息，父線端的必須是區間之後的訊息）。
  新支線直接是 `merged`（`conclusionLine`、`cardMessageId`），`leaf` 開著時同時寫入結論收尾（同 merge）；結論卡寫成 `meta.delivered: true`：
  那幾輪本來就在對話裡發生過，所以之後的 prompt 歷史在原位置用這張卡取代被抽走的對話，不會再用結論卡通知送一次。不算未讀。
- 不跑任何背景工作（結論卡、收尾都不用 AI）。
- 客戶端事後要重新讀來源線與新支線的訊息（同 move：被搬走的訊息留在原本的 `seq`，只有區間最後一則換了新的；標記的 `seq` 比客戶端已讀到的舊，用 `afterSeq` 補抓不會看到它）。

回應 `201 {line（新支線）, branch, marker: Message（標記或結論卡）, sourceLineId, rootLineId, movedMessageIds[], reparented[], summaryReset}`。
事件：`line.created`（新支線）、`message.created`（標記或卡）、來源線 `line.updated`、`branch.changed{moved}`（新支線與每條改掛的支線）；
功能開著時另有 `fold.changed`（每個改變的折疊）、`leaf.changed`（帶卡寫的收尾）、`chapters.changed`（有切點移到標記上時）。
樣本：[route.branches.extract.json](../httpapi/testdata/contract/route.branches.extract.json)（帶卡）。

```json
{"fromMessageId":"…0005","toMessageId":"…0008","purpose":"排查 Docker 連線錯誤","kind":"investigate",
 "card":{"question":"為什麼容器連不上宿主機 Postgres？","conclusion":"改用 host network 或連 host.docker.internal 即可解決。"}}
```

### `POST /lines/{id}/attach`

寫（核心，B20）。`spinoff` 的 `detach` 的反向：把同一租戶裡另一條**獨立的主線** `sourceLineId`（連同它整棵樹）掛到這條線（`{id}`：未封存的主線或進行中的支線）下面成為一條支線。
來源線的訊息不搬、`seq` 不變。本文（必填）：
`{sourceLineId, anchorMessageId?, purpose?, kind?（investigate（預設）/ alternative）, status?（open（預設）/ merged）, card?: BranchCard, confirmDeeper?}`。

- `sourceLineId` 必填（`400 invalid_input`，`field: sourceLineId`）；不存在或是別的租戶的 → `404 line_not_found`；是支線、就是這條線、或是這條線所在對話的主線（併進自己的樹）→ `400 invalid_input`（`field: sourceLineId`）；
  來源線沒有任何完成的 user / assistant 一般訊息 → `400 invalid_input`。`kind: aside` → `400 kind_unsupported`。
- 任一邊封存 → `409 archived`；這條線在回合中（`thinking` 或有 pending）→ `409 source_busy`；來源樹任一條線在回合中 → `409 branch_busy`、有支線正在起草結論卡 → `409 branch_drafting`；
  這條線是已結束的支線 → `409 parent_closed`。
- **上限把來源整棵樹算進去**：新支線深度是這條線的深度 + 1，來源樹最深的支線跟著加深，最深的超過硬上限 → `409 depth_hard_limit`、超過軟上限且沒有 `confirmDeeper` → `409 depth_soft_limit`；
  `status: open` 時這條線的進行中支線已滿 → `409 branch_limit`；目標樹的支線數 + 1 + 來源樹的支線數超過每棵上限 → `409 tree_limit`。
- **錨點**：給了 `anchorMessageId` 就必須是這條線上可以掛支線的訊息（完成的 user / assistant，或結論卡），否則 `404 anchor_not_found`。沒給時在鎖內自動挑：
  這條線上可掛的訊息裡，時間不晚於來源對話開始時間（`createdAt`，匯入時是來源的時間）的最後一則（依 `seq`）；都比它晚就挑最新的一則；這條線沒有可掛的訊息 → `400 move_no_anchor`。
  時間只用來挑錨點，線內的順序永遠看 `seq`。背景包從錨點以前的訊息建出（同 extract），`origin: move`。
- `purpose` 沒給時用來源的標題（截到 purpose 上限），標題也是空的就用第一則提問的前 60 字。來源線的標題改成 `purpose`，資料夾、標籤與 spinoff 的起源膠囊清掉（支線沒有這些）。
- **整棵樹的附屬資料**全部改到這條線所在對話的主線底下（依舊主線一次搬，舊主線底下不留任何列）：筆記（搬過去，不是像 detach 那樣複製；有搬時筆記版本 +1）、備忘（含節點已刪的）、種子、
  收尾、章節切點、建議、群組。來源樹裡還開著、而目標樹也開著同一個（功能、種類、目標）的建議先標為 `expired`。來源對話的目標（goal）刪除（支線沒有目標，目標對話保留自己的）。
  訊息、論證類型、折疊、比較、背景工作與關聯都是指向線或訊息的 id，不用動。筆記、備忘、種子、里程碑、關聯、群組的每棵上限只擋之後的新增：併入可能讓目標對話超過它們。
- **`status: merged`**：必須帶 `card`，`open` 不能帶（`400 invalid_input`，`field: card`）；卡片照 merge 嚴格解碼，`question` 空的用 `purpose` 補，照 merge 的規則檢查（`422 invalid_card`；
  支線端的引用必須是來源線上完成的 user / assistant 訊息，父線端的必須是錨點之後的訊息）。結論卡（`system` / `branch_card` / `meta.delivered: true` / `meta.branchLineId`）
  接在這條線的最後，支線直接 `merged`（`conclusionLine`、`cardMessageId`），`leaf` 開著時同時寫入 `confirmed` 的結論收尾。已送達，所以下一輪不會再用結論卡通知送一次；不算未讀。
- 不跑任何功能掛勾，也不開始背景工作。

回應 `200 {targetLine（這條線）, branch（新支線）, branchLine（來源線，現在是支線）, cardMessage: Message | null, reparented[]（跟著過來的來源子支線）}`。
事件：來源線 `line.updated`（現在帶 `conversationBranch`，客戶端把它從主線清單拿掉）、帶卡時的 `message.created`、這條線（與它的主線）`line.updated`、`branch.changed{created}`（帶卡時再一個 `{merged}`）、
每條跟著過來的子支線 `branch.changed{moved}`；另有 `leaf.changed`（帶卡寫的收尾）、`notes.changed`（有筆記搬過來）、`seeds.changed`（有種子搬過來）、`chapters.changed`（有章節切點搬過來、`chapters` 開著）、
每個搬過來的群組 `group.changed`、每個失效的建議 `suggestion.changed`。備忘沒有事件：客戶端事後重新讀目標對話的備忘。
樣本：[route.lines.attach.json](../httpapi/testdata/contract/route.lines.attach.json)（帶卡）。

```json
{"sourceLineId":"…0042","status":"merged","card":{"conclusion":"用 transaction 模式，pool size 先設 20。"}}
```

### `POST /lines/{id}/branches/preview`

讀。預覽新支線的背景包（含 token），不寫入。本文同 `POST /branches`（只用 `anchorMessageId`、`purpose`、`kind`、`excerpt`、`includeLater`）。
回應 `200 {pack, text, tokenEstimate}`；`text` = `pack.rendered`。樣本：[route.branches.preview.json](../httpapi/testdata/contract/route.branches.preview.json)。

**掛在結論卡上（B17）**：`anchorMessageId` 可以是父線上的結論卡（`branch_card` 系統訊息）。背景包照常引用卡片之前的對話，
最後一則就是這張卡（標頭 `[main-line message … · branch conclusion card]`，內容是卡片的 Markdown，引用為資料）；`pack.recent` 的最後一筆是卡片（`role: system`）。
卡片之後再被編輯（`PATCH /branch/card`）不會改已存的背景包。其他會開支線的路由（`diverge`、`spinoff` 的 `fresh`）仍只接受 user / assistant 訊息。

### `GET /lines/{id}/branch`

讀。支線標頭、背景包、結論卡草稿與父線最新訊息 id（merge 要帶的 `parentTipMessageId`）。主線回 `404 branch_not_found`。
回應 `200 BranchDetail`。樣本：[route.branch.get.json](../httpapi/testdata/contract/route.branch.get.json)、
[route.branch.get.ready.json](../httpapi/testdata/contract/route.branch.get.ready.json)（草稿已就緒）。

### `PATCH /lines/{id}/branch`

寫。改支線的目的（線的標題跟著改）。本文（必填）`{purpose}`。回應 `200 {branch: BranchView}`。
進行中與已結束（帶回、不帶回、合併到別的支線）的支線都可以改（B13）；升為主線的支線與「先前的主線」→ `409 branch_closed`；封存中 → `409 archived`。
改名後，**之後**讀目的的地方用新名字：父線之後每一輪的結論卡通知、魚眼、群組摘要、AI 的關聯與群組建議；已經存下的快照不變（訊息與結論卡內容、背景包、紀要／種子／備忘的 `sourceLabel`、獨立的起始膠囊、建議匣裡的文字）。
樣本：[route.branch.rename.json](../httpapi/testdata/contract/route.branch.rename.json)。

### `POST /lines/{id}/branch/draft`

寫，功能 `card_draft`。請 AI 起草結論卡（一個 `card_draft` job；草稿狀態 `none → drafting → ready | failed`，超過 3 分鐘視為失敗）。
回應 `202 {jobId, kind, lineId, provider, model}`；完成時發 `branch.changed{change: draft}`，用 `GET /branch` 讀草稿。
支線沒有訊息 → `409 no_messages`。樣本：[route.branch.draft.json](../httpapi/testdata/contract/route.branch.draft.json)。

### `POST /lines/{id}/branch/merge`

寫。帶著結論卡返回父線：父線插入一則 `branch_card` 系統訊息（下一輪才送給 AI，那一輪成功後 `meta.delivered = true`），支線關閉為 `merged`。
本文（必填）：

| 欄位 | 說明 |
|---|---|
| `card` | 必填；`BranchCard`。嚴格解碼：未知或重複欄位、缺 `question` / `conclusion` → `422 invalid_card{problems[]}` |
| `parentTipMessageId` | 必填；呼叫者看到的父線最新訊息（`GET /branch` 的 `parentTipMessageId`） |
| `confirmParentMoved` | 父線之後又有新訊息時要為 true，否則 `409 parent_moved{movedMessages, movedCards}` |
| `noteChanges` | `[{op: add\|supersede, noteId?, section?, text, sourceLineId?, sourceMessageId?}]`，同一交易寫入紀要（`notes` 功能） |

回應 `200 {branch, message: Message（卡片）, line: LineView（父線）, notes?}`；有 `noteChanges` 時 `notes = {rootLineId, revision, created[], superseded[]}`。
父線或支線正在回合中 → `409 parent_busy`。
樣本：[route.branch.merge.json](../httpapi/testdata/contract/route.branch.merge.json)、[route.error.parent_moved.json](../httpapi/testdata/contract/route.error.parent_moved.json)、
[route.error.invalid_card.json](../httpapi/testdata/contract/route.error.invalid_card.json)。

### `PATCH /lines/{id}/branch/card`

寫（核心，B17）。編輯已帶回（`merged`）支線的結論卡。本文（必填）`{card: BranchCard}`，解碼與檢查同 `POST /branch/merge`
（未知或重複欄位、缺 `question` / `conclusion`、長度或引用的訊息不合格 → `422 invalid_card{problems[]}`）。

同一交易（鎖 root → parent → branch，同 merge）改寫：

- 父線上那則卡片訊息的 `content`（重新算 Markdown）與 `meta.card`；`meta` 其他鍵（`branchLineId`…）保留，`meta.delivered` 清掉（回應裡不出現 = false），
  所以父線**下一輪**會再把改過的卡放進結論卡通知送給 AI 一次，那一輪成功後再標回 `delivered`；在那之前卡片不在父線的 prompt 歷史裡（同剛帶回、還沒送達的卡），滾動摘要也停在它之前。
- B17.1：卡片的 `meta.editedAt` 寫成這次編輯的時間（資料庫時鐘 `clock_timestamp()`，UTC，`2026-10-30T08:15:42.123456Z` 這種格式），大綱的 `BranchView.cardEditedAt` 讀同一個值。
  `editedAt` 有值而 `delivered` 沒有 = 「改過、下一輪才帶入」；兩者都有 = 改過的卡已送達。從這張卡開出的追問支線 `createdAt` 早於 `cardEditedAt` 時，表示它開出之後卡片又被改過（兩個時間都出自資料庫時鐘）。
- 支線的 `conclusionLine`。
- 支線的收尾（`leaf`）只在 `leaf` 功能開著、而且它還是 merge 時從舊卡寫出的那份時跟著改（`kind: conclusion` 的 `line` / `body` 照新卡重算）；使用者或 AI 草稿改過的收尾保留。

回應 `200 {branch: BranchView, message: Message（改過的卡片）}`。事件（commit 後）：`message.updated`（卡片）、`branch.changed{change: merged}`（同一條已帶回的支線再出現一次 = 卡片被編輯）、
收尾有跟著改時 `leaf.changed`。不會重寫的：記憶（`memory` 從原卡萃取的）、父線的滾動摘要（已經摘要到舊卡、或編輯時正在跑的摘要 job）、群組摘要、從這張卡開出的支線的背景包、紀要。內容完全相同的編輯照樣寫入並重新送達。

拒絕：不是支線 → `404 branch_not_found`；支線不是 `merged`（`open` / `discarded` / `promoted`）→ `409 branch_closed`；封存中 → `409 archived`；
父線已經結束、或卡片已不在父線上（升為主線時跟舊尾段搬到「先前的主線」）→ `409 parent_closed`；父線正在回合中 → `409 parent_busy`（那一輪可能已帶著舊卡）。
樣本：[route.branch.card.update.json](../httpapi/testdata/contract/route.branch.card.update.json)。

```json
{"card":{"question":"Which hotel?","conclusion":"Stay two nights in the ryokan","openItems":["Book by Friday"]}}
```

### `POST /lines/{id}/branch/discard`

寫。放棄支線（狀態 `discarded`，不帶回任何東西）。本文可省略；`{"leaf": {kind?, line, body?}}`（`leaf` 功能）在同一交易寫入這條支線的收尾，
`kind` 預設 `dead_end`（不合格 → `422 invalid_leaf`，整個放棄回滾；`leaf` 關閉 → `404 feature_disabled`）。`leaf` 在 suggest / auto 模式下、沒帶 `leaf` 時，
會排一個 `leaf_draft` job 起草收尾。回應 `200 {branch}`（`branch.leaf` 已是新的收尾）。
樣本：[route.branch.discard.json](../httpapi/testdata/contract/route.branch.discard.json)、[route.branch.discard.leaf.json](../httpapi/testdata/contract/route.branch.discard.leaf.json)。

### `POST /lines/{id}/branch/promote`

寫。把直接掛在主線下的支線升為主線：主線 id 不變，舊尾段（anchor 之後）搬到一條 `previous_main_line` 支線（直接 `discarded`）。
本文（必填）`{"confirm": true}`，否則 `400 invalid_input`。不是主線的直接子支線 → `409 promote_not_top_level`；舊尾段上還有 open 支線 →
`409 open_branches_on_old_tail`。

回應 `200 {branch, previousMainLine: BranchView, line: LineView（主線）, reparented[]}`。
樣本：[route.branch.promote.json](../httpapi/testdata/contract/route.branch.promote.json)。

### `PUT /lines/{id}/branch/keep`

寫，功能 `aside`（B23）。保留一條順口問，或取消保留。順口問答完就結束，`Limits.Branch.AsideRetention`（7 天）後由維護工作清掉；
保留的（`keptAt` 有值）不會被清。本文（必填）`{"keep": true | false}`；沒有 `keep` → `400 invalid_input`（`field: keep`）。

- `{id}` 必須是順口問：其他種類的支線 → `400 kind_unsupported`；主線 → `404 branch_not_found`。進行中（還沒回答）與已結束的都可以設。
- `keep: true` 記下現在的時間；已經保留的再設一次不改時間、不發事件。`keep: false` 清掉；之後的清除時間照原本的算（結束時間 + 保留期），
  所以早就過期的順口問會在下一次維護時被清。沒保留的再取消一次同樣不發事件。
- 封存的樹 → `409 archived`。

回應 `200 {branch: BranchView}`（保留時 `branch.keptAt` 有值，取消後沒有這個欄位）。狀態有變時發 `branch.changed{kept}`（保留與取消都是它，看 `branch.keptAt`）。
建立時就保留：[`POST /lines/{id}/branches`](#post-linesidbranches) 的 `keep: true`。
樣本：[route.branch.keep.json](../httpapi/testdata/contract/route.branch.keep.json)。

### `POST /lines/{id}/branch/continue`

寫，功能 `aside`（B23）。順口問是單輪的；答完想接著問時，把它換成一條一般的支線：在同一個錨點開一條新的進行中支線，
順口問的訊息搬進去（`id` 與 `seq` 不變），原本的順口問刪除。已結束的順口問不會被改回 `open`（支線狀態是單向的）。本文可省略：

| 欄位 | 說明 |
|---|---|
| `purpose` | 新支線的目的；預設沿用順口問的。≤ 200 字 |
| `kind` | `investigate`（預設）或 `alternative`；其他值（含 `aside`）→ `400 kind_unsupported` |
| `confirmDeeper` | 超過軟深度（3）時必須為 true，否則 `409 depth_soft_limit` |

- `{id}` 必須是**已回答、已結束**的順口問：不是順口問 → `400 kind_unsupported`；主線、或已被清掉／已經接著問過（那條線不在了）→ `404 branch_not_found`；
  還沒結束（等待回答、回答中、回答失敗後還開著）→ `409 branch_busy`；結束了但沒有任何回答 → `409 no_messages`。
- 父線要還能開支線，照[建立支線](#post-linesidbranches)檢查：封存 → `409 archived`、父線已結束 → `409 parent_closed`、
  `409 branch_limit`、`tree_limit`（被取代的順口問不算進整棵樹的數量）、`depth_soft_limit`、`depth_hard_limit`。被拒絕時什麼都沒改。
- 新支線沿用順口問的 `origin`、`excerpt`、`provider`、`model`；背景包照一般支線重建（順口問的背景包比較小，不沿用）。
- 搬過去的是順口問上所有完成的訊息；失敗（`error`）的回覆不搬，跟著順口問刪除。掛在順口問訊息上的支線改掛到新支線（深度不變）。
- 寫在順口問上的備忘留在這棵樹（`lineId` 變 `""`，`sourceLabel` 保留）；提到那條線的開放建議變 `expired`。
- 那條順口問在搬移期間被別人改掛到別處 → `409 concurrent_change`（重試即可）。

回應 `201 {branch: BranchView, line: LineView, replacedLineId}`（`replacedLineId` 是已經不存在的順口問）。
事件（commit 後，依序）：`line.deleted`（順口問）、新支線的 `line.created`、父線的 `line.updated`、`branch.changed{created}`，
之後是改掛的子支線各一個 `branch.changed{moved}`、失效建議的 `suggestion.changed`。客戶端要重讀新支線的訊息。
樣本：[route.branch.continue.json](../httpapi/testdata/contract/route.branch.continue.json)。

### `DELETE /lines/{id}/branch`

寫，核心（B23）。刪除一條已結束的支線，連同底下所有支線；樹的其他部分不動。

- **可以刪**：已結束的順口問（保留的也可以）；`discarded` 的支線，但「先前的主線」（`origin: previous_main_line`）與被合併進別的支線的（`mergedIntoLineId` 有值）除外。
  其他（進行中、`merged`、`promoted`…）→ `409 branch_not_deletable`。主線 → `400 invalid_input`（刪主線用 [`DELETE /lines/{id}`](#delete-linesid)）；
  不存在或不是這個租戶的 → `404 line_not_found`；封存的樹 → `409 archived`。
- **子樹**：底下任何一條支線還是 `open`、或有線在回合中 → `409 branch_busy`（先處理進行中的子支線）。
- **留下的**：父線上指向它的標記（`branch_marker`，來自 move / extract）不動，客戶端對找不到的支線顯示「已刪除」（同被清掉的順口問）；
  寫在被刪的線上的備忘留在樹上（`lineId` 變 `""`）；從那些線記下的紀要保留（補上來源標籤）。
- **一起走的**：那些線的訊息、收尾、折疊、建議、job（還在跑的會被停掉）；兩端有一端在那些線上的連結（關聯與 spinoff 連結）；
  群組少掉這些成員，剩不到 2 條時解散；提到那些線的開放建議變 `expired`。

回應 `200 {rootLineId, lineIds[]}`（同 `line.deleted` 的資料：`rootLineId` 是還在的主線，`lineIds` 第一個是 `{id}`）。
事件：`line.deleted`、被刪連結各一個 `link.changed`（`deleted: true`；`relations` 或 `spinoff` 開著時）、受影響群組各一個 `group.changed`（`group` 開著時）、
失效建議的 `suggestion.changed`、父線與主線的 `line.updated`。
樣本：[route.branch.delete.json](../httpapi/testdata/contract/route.branch.delete.json)。

### 紀要（notes）

`{id}` 可以是樹上任何一條線；紀要屬於整棵樹。

### `GET /lines/{id}/notes`

讀，功能 `notes`。回應 `200 {rootLineId, revision, notes: Note[], limits{maxActive, maxTotal, maxRunes, maxChangesPerMerge, tokenBudget}}`。
樣本：[route.notes.list.json](../httpapi/testdata/contract/route.notes.list.json)、[route.notes.list.rich.json](../httpapi/testdata/contract/route.notes.list.rich.json)。

### `POST /lines/{id}/notes`

寫，功能 `notes`。新增一筆。本文（必填）`{section, text, sourceLineId?, sourceMessageId?}`。
回應 `201 {note, revision, rootLineId}`。樣本：[route.notes.create.json](../httpapi/testdata/contract/route.notes.create.json)。

### `PATCH /lines/{id}/notes/{nid}`

寫，功能 `notes`。改文字、區塊或狀態。本文（必填）`{text?, section?, status?}`（`status`：`active` / `done`；「完成」只用在待辦）。
回應 `200 {note, revision, rootLineId}`。已被取代 → `409 note_superseded`。樣本：[route.notes.update.json](../httpapi/testdata/contract/route.notes.update.json)。

### `POST /lines/{id}/notes/{nid}/supersede`

寫，功能 `notes`。用新的一筆取代 `{nid}`（舊的變 `superseded`）。本文（必填）`{text, section?, sourceLineId?, sourceMessageId?}`；
`section` 預設：原本在 `to_confirm` 的變 `fact`，其他維持原區塊。
回應 `201 {note, superseded, revision, rootLineId}`。樣本：[route.notes.supersede.json](../httpapi/testdata/contract/route.notes.supersede.json)。

### 章節（chapters）

### `GET /lines/{id}/chapters`

讀，功能 `chapters`。章節在讀取時計算（閒置間隔，預設 30 分鐘 + topic 切點（摘要、主線回覆的 `[CHAPTER]`、主線第一輪的 `[TOPIC]`）+ 手動 milestone）。
回應 `200 {lineId, rootLineId, chapters[], milestones[], limits{maxChapters, minMessages, idleGapMinutes, maxMilestones, milestoneMaxLen}}`；
每個 chapter：`{index, kind, title, titleSource, startMessageId, endMessageId, startAt, endAt, messageCount, branchIds[], cardMessageIds[], milestoneId}`。
樣本：[route.chapters.list.json](../httpapi/testdata/contract/route.chapters.list.json)。

### `POST /lines/{id}/chapters/milestones`

寫，功能 `chapters`。在某則訊息加一個手動 milestone。本文（必填）`{messageId, title?}`。
回應 `201 {milestone{id, kind, messageId, title, createdBy, createdAt}, rootLineId}`。同一則訊息已有 → `409 milestone_exists`。
樣本：[route.chapters.milestones.add.json](../httpapi/testdata/contract/route.chapters.milestones.add.json)。

### `DELETE /lines/{id}/chapters/milestones/{mid}`

寫，功能 `chapters`。刪除 milestone。回應 `204`（沒有本文）。
樣本：[route.chapters.milestones.delete.json](../httpapi/testdata/contract/route.chapters.milestones.delete.json)。

### 搜尋（search）

### `GET /search`

讀，功能 `search`（需要 `store.MigrateFeatures(…, "search")`，見 EMBEDDING.md）。搜尋主線標題、支線目的與訊息內容（不分大小寫的子字串，中文不用斷詞）。

| 參數 | 說明 |
|---|---|
| `q` | 2–200 字（太短 `400 invalid_input`，太長 `422 too_long`） |
| `limit` | 1–50，預設 20 |
| `archived` | `true` 只搜封存的樹 |
| `root` | 主線 id：只搜這一棵樹（標題、支線目的、訊息；折疊起來的訊息也搜得到），封存與否都搜，此時忽略 `archived`。不是 UUID、不存在、別的租戶或是支線 → `404 line_not_found`（B14） |

回應 `200 {query（正規化後）, hits[]}`；每筆 `{kind: title|purpose|message, lineId, rootLineId, messageId?, seq?, role?, snippet,
highlights[]{start, end}（UTF-16 位移）, score (0–1), rootTitle, purpose, at}`。每一類只排序最新 200 筆符合的候選。
樣本：[route.search.root.json](../httpapi/testdata/contract/route.search.root.json)（`root=`）。
樣本：[route.search.json](../httpapi/testdata/contract/route.search.json)。

### 建議匣（suggestions）

功能在 suggest 模式下提出的建議（例如樹平衡）都在這裡等使用者決定，永遠不會自動執行。路由只在有會提建議的功能設定時掛上（功能名稱 `suggestions`）；
同一對象（`feature`、`kind`、`targetKey`）同時最多一筆 open；被拒絕後冷卻 7 天（`Limits.Suggestions.DismissCooldown`），有的種類永久不再提。
建議 payload 寫到的線（`fromLineId`、`toLineId`、`members[].lineId`）離開這棵樹時（detach、岔題清除）建議變 `expired`；提案時就寫到樹外的線的建議不會被提出。
測試用的 `tangent.SuggestionProbe()`（參考伺服器 `TANGENT_FEATURES=…,suggestion_probe`）在回覆含 `[probe:suggest]` 時提一筆 `probe` 建議。

**對話目標（`goal`，B9）**：`kind: goal_propose`、`targetKey: goal:<主線 id>`、`lineId` = 主線、`payload = {text}`。接受的本文 `{text?}`：沒給或相同 → 目標 = 提案（`source: ai`）；給了不同的文字 → 用它（`source: manual`；空白 → `400 invalid_input`）。`result = {goal: Goal}`，並發 `goal.changed`。
使用者按「AI 提案」（`POST /goal/propose`）提出的不受之前拒絕的冷卻限制。樣本 [route.suggestions.accept.goal.json](../httpapi/testdata/contract/route.suggestions.accept.goal.json)。

**偏題（`goal`，B9）**：`kind: drift`、`targetKey: drift:<訊息 id>`、`lineId` = 主線、`payload = {anchorMessageId（偵測時主線最新的回覆）, kind（aside | investigate；aside 只在 aside 功能開著時）, purpose, reason, goal（偵測時的目標）}`。
接受的本文 `{kind?, purpose?}` 覆寫提案；接受 = 在 `anchorMessageId` 開支線（同 `POST /branches` 的檢查），`result = {line: LineView, branch: BranchView}`。
樣本 [route.suggestions.list.p2.json](../httpapi/testdata/contract/route.suggestions.list.p2.json)、[route.suggestions.accept.drift.json](../httpapi/testdata/contract/route.suggestions.accept.drift.json)。

**關聯（`relations`，B9）**：`kind: relation`、`targetKey: relation:<線 id>:<線 id>`（兩條線依 id 排序，不分方向；客戶端當成不透明字串）、`lineId` = 主線、
`payload = {fromLineId（結束的支線）, toLineId, fromTitle, toTitle（兩條支線的目的）, label, relationKind?}`（`relationKind` 是 AI 提的種類，認不得或沒提 → `related`；B15 之前提出的建議沒有這個欄位，當成 `related`）。
接受的本文 `{label?, relationKind?}` 覆寫提案（種類不合格 → `400 invalid_input`）；接受 = 畫這條關聯（同 `POST /relations` 的檢查），`result = {link: Link}`。
樣本 [route.suggestions.accept.relation.json](../httpapi/testdata/contract/route.suggestions.accept.relation.json)。

**群組（`group`，B9）**：`kind: group`、`targetKey: group:<線 id,…>`（依 id 排序；當成不透明字串）、`lineId` = 主線、
`payload = {title, members[]{lineId, purpose, ended, leaf}, conflicts: Conflict[]（沒有 choice，id c1、c2…）}`。接受的本文 `{action?: group | combine, title?, purpose?, kind?, choices?: {c1: adoptBranch | adoptOther | keepBoth}}`：
`group`（成員裡有兩條以上已結束的支線時是預設）用**已結束**的成員建群組並開始摘要，`result = {action, group, job?{jobId, kind}, notes?}`；
`combine` 合併**進行中**的成員（要同一條父線），`result = {action, combined: {created: {line, branch, pack}, combined: BranchView[], notes}, notes}`。只有給了選擇的矛盾才算數；別的 `action` → `400 invalid_input`。
樣本 [route.suggestions.list.group.json](../httpapi/testdata/contract/route.suggestions.list.group.json)、[route.suggestions.accept.group.json](../httpapi/testdata/contract/route.suggestions.accept.group.json)、[route.suggestions.accept.combine.json](../httpapi/testdata/contract/route.suggestions.accept.combine.json)。

**折疊（`fold`，B10）**：`kind: fold`、`targetKey: fold:<起訊息 id>:<迄訊息 id>`（當成不透明字串）、`lineId` = 那條線、
`payload = {fromMessageId, toMessageId, fromSeq, toSeq, title（章節標題）, summary（AI 起草）, messageCount, tokensOriginal, tokensSummary, jobId}`。拒絕是永久的（同一章節不再提）。
接受的本文 `{summary?}`：沒給或相同 → 用起草的摘要（`aiDrafted: true`）；不同 → 用你的。接受 = 建立折疊（同 `POST /folds` 的檢查；重疊時 `409 fold_overlap`、建議維持 open），`result = {fold: Fold}`，並發 `fold.changed`。
樣本 [route.suggestions.list.fold.json](../httpapi/testdata/contract/route.suggestions.list.fold.json)、[route.suggestions.accept.fold.json](../httpapi/testdata/contract/route.suggestions.accept.fold.json)。

**記憶（`memory`，B10）**：`kind: memory`、`targetKey: memory:<job id>:<n>`、`lineId` = 來源的線、`payload = {action: add | update, kind, text, importance, targetMemoryId?（update 取代的那筆）, source, jobId}`。
接受的本文 `{text?, kind?, importance?}`（改了內容就不算 AI 寫的）；`result = {memory, superseded: Memory[]}`，發 `memory.changed`。要取代的記憶已被取代 → `409 memory_superseded`，建議維持 open。
**記憶整併（`memory`）**：`kind: memory_consolidate`、`targetKey: memory_pair:<舊 id>:<新 id>`、`lineId` = 其中一筆記憶的來源線、`payload = {action: merge | conflict, memoryIds[2]（舊的在前）, texts[], kind, text, importance, reason, jobId}`，拒絕是永久的；
接受的本文同上，兩筆都被新的一筆取代，`result = {memory, superseded}`。樣本 [route.suggestions.list.memory.json](../httpapi/testdata/contract/route.suggestions.list.memory.json)、[route.suggestions.accept.memory.json](../httpapi/testdata/contract/route.suggestions.accept.memory.json)、[route.suggestions.accept.memory_consolidate.json](../httpapi/testdata/contract/route.suggestions.accept.memory_consolidate.json)。

**樹平衡（`rebalance`，需要 `leaf`）**：支線的一輪完成後，如果它分岔後的回覆 ≥ 6 且 ≥ 父線分岔後的 2 倍（`reason: share`），或整棵樹最近 5 個回覆都在它（`reason: recent`），提一筆 `kind: promote_or_spinoff`、`targetKey: branch:<lineId>` 的建議；`payload = {reason, parentIsMain, parentTitle, branchTurns, parentTurns, recentInBranch, actions[]}`（`parentIsMain`：直接掛在主線下；`parentTitle`：父線標題），`actions` 是現在可以做的：`promote`（只有直接掛在主線下的支線）、`spinoff`（`spinoff` 開啟時）。拒絕（「維持」）對這條支線是永久的。門檻在 `Limits.Rebalance`。manual 模式不提。樣本 [route.suggestions.list.rebalance.json](../httpapi/testdata/contract/route.suggestions.list.rebalance.json)。

### `GET /lines/{id}/suggestions`

讀，功能 `suggestions`。整棵樹的建議（傳入支線 id 也解析到根），新的在前，最多 200 筆；只列目前開著的功能提的。
參數 `status`：逗號分隔的狀態或 `all`，預設 `open`（不合格 → `400 invalid_input`）。回應 `200 {rootLineId, suggestions: Suggestion[]}`。
樣本：[route.suggestions.list.json](../httpapi/testdata/contract/route.suggestions.list.json)、[route.suggestions.list.all.json](../httpapi/testdata/contract/route.suggestions.list.all.json)。

### `POST /suggestions/{sid}/accept`

寫，功能 `suggestions`。執行建議的動作並標成 `accepted`（同一交易）。本文可省略，內容依建議種類（例如樹平衡要選 `{action: promote|spinoff}`）。
回應 `200 {suggestion, result?}`（`result` 是動作的結果）。樹平衡的本文是 `{action: "promote" | "spinoff", title?, copyNotes?}`（`title` / `copyNotes` 給 spinoff），`result = {action, line, branch?, previousMainLine?（promote）, link?（spinoff）}`；別的 `action` → `400 invalid_input`；`spinoff` 關閉時 → `404 feature_disabled`。動作和接受在同一個交易：例如 promote 被拒絕（`open_branches_on_old_tail`）時建議維持 open。樣本 [route.suggestions.accept.spinoff.json](../httpapi/testdata/contract/route.suggestions.accept.spinoff.json)。已不是 open → `409 suggestion_not_open`；沒有這筆 → `404 suggestion_not_found`；
提出它的功能關閉 → `404 feature_disabled`。樣本：[route.suggestions.accept.json](../httpapi/testdata/contract/route.suggestions.accept.json)、[route.error.suggestion_not_open.json](../httpapi/testdata/contract/route.error.suggestion_not_open.json)。

### `POST /suggestions/{sid}/dismiss`

寫，功能 `suggestions`。拒絕（「維持」）。回應 `200 {suggestion}`。樣本：[route.suggestions.dismiss.json](../httpapi/testdata/contract/route.suggestions.dismiss.json)。

### `POST /lines/{id}/suggestions/dismiss-all`

寫，功能 `suggestions`（B17）。一次拒絕整棵樹（傳入支線 id 也解析到根）所有 open 的建議，範圍同 `GET /suggestions`：只有目前開著的功能提的（關掉的功能的建議不動）。
每一筆都和單筆 `dismiss` 一樣（冷卻或永久不再提）；全部在一個交易（鎖主線）。本文可省略（`{}` 也可以）。
回應 `200 {rootLineId, suggestions: Suggestion[]}`：被拒絕的建議（`status: dismissed`），新的在前；沒有 open 的建議時 `suggestions: []`（不是錯誤）。
事件（commit 後）：每筆一個 `suggestion.changed`，最後一個主線的 `line.updated`（`openSuggestions` 歸零）；沒有拒絕任何一筆時不發事件。
樣本：[route.suggestions.dismiss.all.json](../httpapi/testdata/contract/route.suggestions.dismiss.all.json)。

### 收尾（leaf）

每條支線（含 promote 留下的 `previous_main_line`）可以有一個收尾；主線沒有（`404 branch_not_found`）。merge 時由結論卡自動產生 `conclusion`；
suggest / auto 模式下放棄支線（沒帶收尾）與 promote 後的前主線會由 `leaf_draft` job 起草（suggest：`draft`；auto：`confirmed` 且 `aiDrafted`）；
草稿不會覆蓋使用者寫的收尾。收尾不進 prompt。

### `GET /lines/{id}/leaf`

讀，功能 `leaf`。回應 `200 {leaf: Leaf | null, draftError?: {code, message}}`。`draftError` 只在這條支線最新的 `leaf_draft` job 失敗、且之後收尾沒有再被寫過時出現（`code`：`run_failed` / `unusable` / `timed_out` / `failed`；再起草一次或寫入收尾就消失）。樣本：[route.leaf.get.json](../httpapi/testdata/contract/route.leaf.get.json)、[route.leaf.get.none.json](../httpapi/testdata/contract/route.leaf.get.none.json)、[route.leaf.get.draft_error.json](../httpapi/testdata/contract/route.leaf.get.draft_error.json)。

### `PUT /lines/{id}/leaf`

寫，功能 `leaf`。使用者寫或確認收尾（`confirmed`，之後的草稿不覆蓋）。本文（必填）`{kind, line, body?}`；不合格 → `422 invalid_leaf{problems[]}`；
封存中 → `409 archived`。回應 `200 {leaf}`。樣本：[route.leaf.put.json](../httpapi/testdata/contract/route.leaf.put.json)、[route.error.invalid_leaf.json](../httpapi/testdata/contract/route.error.invalid_leaf.json)。

### `DELETE /lines/{id}/leaf`

寫，功能 `leaf`。刪除收尾；沒有 → `404 leaf_not_found`。回應 `204`。樣本：[route.leaf.delete.json](../httpapi/testdata/contract/route.leaf.delete.json)。

### `POST /lines/{id}/leaf/draft`

寫，功能 `leaf`（任何模式）。請 AI 起草收尾（`leaf_draft` job；同一支線 pending 的草稿被取代）。支線沒有訊息 → `409 no_messages`。
回應 `202 {jobId, kind, lineId, provider, model}`；寫入時發 `leaf.changed`。樣本：[route.leaf.draft.json](../httpapi/testdata/contract/route.leaf.draft.json)。

### 停車場（parking）

一鍵把念頭存成種子：不開支線、不呼叫 AI、不進 prompt。之後展開成支線、記進紀要或丟掉，三者都是終態（`409 seed_not_open`）。
`{id}` 可以是樹上任何一條線；`{sid}` 是種子 id。

### `GET /lines/{id}/seeds`

讀，功能 `parking`。整棵樹的種子，新的在前，最多 200 筆。參數 `status`：逗號分隔或 `all`，預設 `open`。回應 `200 {rootLineId, seeds: Seed[], limits: {maxOpen, maxRunes}}`（`maxOpen` 每棵樹 open 種子的上限，`maxRunes` 一個種子的字數上限）。
樣本：[route.seeds.list.json](../httpapi/testdata/contract/route.seeds.list.json)、[route.seeds.list.all.json](../httpapi/testdata/contract/route.seeds.list.all.json)。

### `POST /lines/{id}/seeds`

寫，功能 `parking`。本文（必填）`{text, anchorMessageId?}`。`text` 壓成一行、1–500 字；`anchorMessageId` 必須是這棵樹裡完成的 user / assistant 訊息
（`404 anchor_not_found`），沒給時用這條線當下最新的一則。每棵樹 open 的種子最多 100（`409 seed_limit{limit}`）；封存中 → `409 archived`。
回應 `201 {seed}`。樣本：[route.seeds.create.json](../httpapi/testdata/contract/route.seeds.create.json)。

### `POST /lines/{id}/seeds/batch`

寫，功能 `parking`。一次停好一批想法（AI 列的大綱、待辦清單，B14）。本文（必填）`{texts: string[], anchorMessageId?}`：
`texts` 1–20 筆（空或超過 → `400 invalid_input`），每筆照 `POST /lines/{id}/seeds` 的規則（空白 → `400 invalid_input`，太長 → `422 too_long`）；
`anchorMessageId` 同單筆，整批共用。一個交易、全建或全不建：建完會超過每棵樹 open 種子上限 → `409 seed_limit{limit}`；封存中 → `409 archived`。
回應 `201 {rootLineId, seeds: Seed[]}`（依 `texts` 的順序），只發一次 `seeds.changed` 與主線的 `line.updated`。
樣本：[route.seeds.batch.json](../httpapi/testdata/contract/route.seeds.batch.json)。

### `POST /seeds/{sid}/expand`

寫，功能 `parking`。展開成支線（`origin: seed`）：掛在 anchor 目前所在的線（訊息被搬走時跟著走）；那條線已經結束（或在已結束的支線底下）時，沿分岔點往上找最近的進行中祖先線，掛在它的分岔訊息上（主線一定可用）；anchor 不見了就掛在主線最新的一則。
本文可省略：`{purpose?（預設種子文字截到 200 字）, kind?（預設 investigate）, confirmDeeper?}`。建支線的所有規則照常（上限、深度、父線已關閉……），
失敗時種子不變。回應 `201 {seed, line, branch, pack}`。樣本：[route.seeds.expand.json](../httpapi/testdata/contract/route.seeds.expand.json)。

### `POST /seeds/{sid}/to-note`

寫，功能 `parking`（需要 `notes`，否則 `404 feature_disabled`）。記進紀要：本文可省略，`{section?}` 預設 `to_confirm`；文字截到紀要上限，
anchor 還在樹裡時當作紀要的來源。回應 `201 {seed, note, revision, rootLineId}`。樣本：[route.seeds.to_note.json](../httpapi/testdata/contract/route.seeds.to_note.json)。

### `POST /seeds/{sid}/drop`

寫，功能 `parking`。丟掉。回應 `200 {seed}`。沒有這個種子 → `404 seed_not_found`。
樣本：[route.seeds.drop.json](../httpapi/testdata/contract/route.seeds.drop.json)、[route.error.seed_not_open.json](../httpapi/testdata/contract/route.error.seed_not_open.json)。

### 獨立成新對話（spinoff）

把對話的一部分變成新的主線。新主線的每一輪 prompt 都先帶一個不變的「起始膠囊」（背景包或路徑摘要 + 有的話支線的收尾，上限 `Limits.Spinoff.CapsuleTokenBudget`，
預設 6000 token），在送出前預覽裡是 `origin_capsule` 區塊；`LineView.spunOffFrom` 指回來源。來源線留一則 `branch_marker`（`meta.spunOffTo`），兩邊以 `Link` 相連。

### `POST /lines/{id}/spinoff`

寫，功能 `spinoff`。本文（必填）：

| 欄位 | 說明 |
|---|---|
| `mode` | 必填；`detach`（`{id}` 這條支線連同子樹變成新主線，id 不變）或 `fresh`（從 `{id}` 上的一則訊息開全新的主線）；其他 → `400 invalid_input` |
| `atMessageId` | `fresh` 必填：`{id}` 上完成的 user / assistant 訊息（`404 anchor_not_found`） |
| `title` | 新主線的標題（≤ 200 字）；預設是支線目的（detach）或這條線的標題（fresh） |
| `copyNotes` | 把這棵樹 active 的紀要複製到新對話（`copiedFromNoteId` 指向原紀要） |

- **detach**：只限進行中的支線（已結束或在已結束的支線底下 → `409 branch_closed`；封存 → `409 archived`；子樹裡有線在回合中 → `409 branch_busy`；
  父線在回合中 → `409 source_busy`；正在起草 → `409 branch_drafting`；主線 → `404 branch_not_found`）。支線記錄刪除，子孫的 `rootLineId` 改成新主線、`depth` 跟著減；
  子樹裡的收尾、建議、章節切點，以及 anchor 在子樹裡的種子都跟著搬到新樹（支線自己的收尾放進膠囊）；紀要留在原樹（來源搬走的紀要補上 `sourceLabel`）。
  關於這條支線的 open 建議變 `expired`；原樹裡 payload 寫到被帶走的線（`fromLineId`、`toLineId`、`members[].lineId`）的 open 建議也變 `expired`（`suggestion.changed{expired}`，主線 `line.updated`）。膠囊 = 它的背景包 + 收尾。
- **fresh**：原樹不變（只多一則標記）。膠囊 = 來源支線的背景包（來源是支線時）+ 這條線到該訊息的對話（像背景包一樣引用）+ 收尾；超過上限先丟背景包再截斷。來源線在回合中 → `409 source_busy`。

回應 `201 {mode, line: LineView（新主線）, sourceLineId, rootLineId（原樹）, marker: Message, link: Link, branch?（detach：支線原本的樣子）, moved[]（detach：一起搬走的線）, notes?（copyNotes）}`。
樣本：[route.spinoff.detach.json](../httpapi/testdata/contract/route.spinoff.detach.json)、[route.spinoff.fresh.json](../httpapi/testdata/contract/route.spinoff.fresh.json)。

### `POST /lines/{id}/spinoff/preview`

讀，功能 `spinoff`。預覽 spinoff 會存的起始膠囊，**不寫入**（唯讀身分可呼叫）。本文（必填）同 `POST /spinoff` 的 `{mode, atMessageId?, title?, copyNotes?}`；
回應 `200 {mode, capsule: {text, tokenEstimate, tokenBudget, truncated}, notesToCopy}`（`text` 與真的 spinoff 存的膠囊完全相同；`notesToCopy` 是 `copyNotes` 會複製的紀要數，沒帶 `copyNotes` 時為 0）。
錯誤同 spinoff 的輸入檢查：`mode` 不對 `400 invalid_input`；detach 對主線 `404 branch_not_found`、已結束的支線 `409 branch_closed`；fresh 的訊息不對 `404 anchor_not_found`
（回合中、起草中這類要上鎖才知道的情況只有真的 spinoff 會檢查）。樣本：[route.spinoff.preview.json](../httpapi/testdata/contract/route.spinoff.preview.json)。

### `GET /lines/{id}/links`

讀，功能 `spinoff` **或** `relations`（任一個設定了就掛上，B9）。這棵樹任一條線連出或連入的連結，新的在前，最多 200 筆；只列對這個請求開著的功能的種類
（`spinoff` → `kind: spinoff`，`relations` → `kind: relation`；兩個都關 → `404 feature_disabled`）。回應 `200 {links: Link[]}`。
樣本：[route.links.list.json](../httpapi/testdata/contract/route.links.list.json)、[route.links.list.relations.json](../httpapi/testdata/contract/route.links.list.relations.json)（含關聯）。

### 對話目標（goal）

每個對話（主線）一句目標，放在每一輪 prompt 的規則之後（不變的區塊，送出前預覽裡是 `goal` 區塊；支線也帶）。`{id}` 可以是樹上任何一條線，一律解析到主線。
封存中的樹 → `409 archived`。suggest / auto 模式：主線第 2 個回覆完成後若還沒有目標，AI 自己提一次（`goal_propose` job）；有目標時每 `Limits.Goal.DriftEvery`（預設 4）個主線回覆排一次 `drift_check`，
偏題時在建議匣提出 `drift`（開支線或岔題，見[建議匣](#建議匣suggestions)）。auto 模式的提案直接寫成目標（`source: ai`），但不覆蓋已有的目標（使用者按了「AI 提案」才覆蓋）。

### `GET /lines/{id}/goal`

讀，功能 `goal`。回應 `200 {goal: Goal | null}`。樣本：[route.goal.get.json](../httpapi/testdata/contract/route.goal.get.json)、[route.goal.get.none.json](../httpapi/testdata/contract/route.goal.get.none.json)。

### `PUT /lines/{id}/goal`

寫，功能 `goal`。本文（必填）`{text}`：壓成一行，空白 → `400 invalid_input`，超過 300 字 → `422 too_long{field: text, max: 300}`。使用者寫的目標（`source: manual`）取代原本的。
回應 `200 {goal}`，發 `goal.changed`。樣本：[route.goal.put.json](../httpapi/testdata/contract/route.goal.put.json)。

### `DELETE /lines/{id}/goal`

寫，功能 `goal`。刪除目標；沒有 → `404 goal_not_found`。回應 `204`，發 `goal.changed{goal: null}`。
樣本：[route.goal.delete.json](../httpapi/testdata/contract/route.goal.delete.json)、[route.error.goal_not_found.json](../httpapi/testdata/contract/route.error.goal_not_found.json)。

### `POST /lines/{id}/goal/propose`

寫，功能 `goal`（任何模式；manual 模式只有這個按鈕）。AI 從主線最前面的對話提出目標：回應 `202 {jobId, kind: goal_propose, lineId（主線）, provider, model}`，
完成後進建議匣（`goal_propose`；auto 模式直接寫成目標）。主線還沒有完成的對話 → `409 no_messages`。同一條主線進行中的提案被取代。樣本：[route.goal.propose.json](../httpapi/testdata/contract/route.goal.propose.json)。

### 關聯線（relations）

兩個地方之間的一條線與說明（XMind 的關聯）：每一端是一條線，或那條線上的一則訊息（完成的 user / assistant 訊息或結論卡）；同一棵樹或跨樹（同一個租戶）。
存成 `Link`（`kind: relation`），`GET /links` 也列出。每棵樹最多 `Limits.Relations.MaxPerTree`（200）條（兩端的樹都算）。suggest 模式：支線 merge / discard 後，
AI 從同一棵樹的其他支線找關聯，在建議匣提出 `relation`（auto 等同 suggest；manual 不提）。

### `GET /lines/{id}/relations`

讀，功能 `relations`。這棵樹連出或連入的關聯，新的在前，最多 200 筆。回應 `200 {relations: Link[], limits: {maxPerTree, labelMaxRunes}}`。
樣本：[route.relations.list.json](../httpapi/testdata/contract/route.relations.list.json)。

### `POST /lines/{id}/relations`

寫，功能 `relations`。本文（必填）`{fromLineId?, fromMessageId?, toLineId, toMessageId?, label?, relationKind?}`：`fromLineId` 預設 `{id}`，且必須在 `{id}` 這棵樹（否則 `400 invalid_input`）；
`toLineId` 可以是同租戶的任何對話；`label` 壓成一行、≤ 200 字（`422 too_long`）；`relationKind`（B15）沒給或空字串 → `related`，不是四種之一（大小寫有別）→ `400 invalid_input`（`details.field: relationKind`）。兩端相同 → `400 invalid_input`；線不存在或不是這個租戶的 → `404 line_not_found`；
訊息不在那條線上或不能當端點 → `404 message_not_found`；兩端已有關聯（不分方向；訊息端點以訊息 id 比對，訊息被 move / promote 搬走後也算同一個，R8）→ `409 relation_exists`；任一棵樹已達上限 → `409 relation_limit{limit}`；任一棵樹封存 → `409 archived`。
回應 `201 {relation: Link, rootLineIds[]（碰到的對話，起點的在前）}`，對每棵樹發 `link.changed`。
樣本：[route.relations.create.json](../httpapi/testdata/contract/route.relations.create.json)、[route.relations.kind.json](../httpapi/testdata/contract/route.relations.kind.json)（`contradicts`）、[route.error.relation_exists.json](../httpapi/testdata/contract/route.error.relation_exists.json)。

### `PATCH /lines/{id}/relations/{rid}`

寫，功能 `relations`。改說明與種類。本文（必填）`{label?, relationKind?}`：**沒給（或 `null`）的欄位保留原值**（B15；之前沒給 `label` 等於清空）；
`label` 一行，≤ 200 字（`422 too_long`；空字串 = 清空）；`relationKind` 必須是四種之一：空字串（含只有空白）或不合格 → `400 invalid_input`（`details.field: relationKind`；和 `POST` 不同，改的時候空字串不等於 `related`）。兩個都沒給（`{}`）照樣回 `200`、發 `link.changed`，內容不變。
沒有本文 → `400 invalid_input`；不存在（含同時被刪掉）→ `404 relation_not_found`；任一端的樹封存 → `409 archived`。
回應 `200 {relation: Link, rootLineIds[]}`，對每棵樹發 `link.changed`。樣本：[route.relations.update.json](../httpapi/testdata/contract/route.relations.update.json)。

### `DELETE /lines/{id}/relations/{rid}`

寫，功能 `relations`。刪除一端在 `{id}` 這棵樹的關聯；不是、不存在（含同時被別人刪掉）或不是關聯（例如 spinoff 的連結）→ `404 relation_not_found`；`{id}` 這棵樹封存 → `409 archived`（另一端的樹封存時仍可從這邊刪除，R8）。
回應 `204`，對每棵樹發 `link.changed{deleted: true}`。樣本：[route.relations.delete.json](../httpapi/testdata/contract/route.relations.delete.json)、[route.error.relation_not_found.json](../httpapi/testdata/contract/route.error.relation_not_found.json)。

### 未完成清單（open_loops）

### `GET /open-loops`

讀，功能 `open_loops`。參數 `root`（可選，任何一條線的 id，解析到它的主線；不給 = 整個租戶）、`staleDays`（1–365，預設 3）。封存的樹不列。
回應 `200 {rootLineId（沒給 root 時為空字串）, staleDays, staleBranches, toConfirm?, seeds?, suggestions?}`，每一類是 `{items[], total}`（`items` 最多 `Limits.OpenLoops.MaxPerKind`（50）筆，`total` 是全部的數量）：

| 類 | 何時出現 | 項目 |
|---|---|---|
| `staleBranches` | 一定 | 進行中且 `lastActivityAt` 早於 `staleDays` 天前的支線，最久沒動的在前；`BranchView` + `rootTitle` |
| `toConfirm` | `notes` 開著 | 「待確認」的 active 紀要，新的在前；`Note` + `rootLineId`、`rootTitle` |
| `seeds` | `parking` 開著 | open 的種子，新的在前；`Seed` + `rootTitle` |
| `suggestions` | 有會提建議的功能開著 | open 的建議（只算開著的功能提的），新的在前；`Suggestion` + `rootTitle` |

功能關著的類不出現（欄位不存在）。每一項用既有的路由處理（放棄支線、取代紀要、展開種子、接受建議…）。`staleDays` 不合格 → `400 invalid_input`；`root` 不是這個租戶的線 → `404 line_not_found`。
樣本：[route.open_loops.list.json](../httpapi/testdata/contract/route.open_loops.list.json)、[route.open_loops.root.json](../httpapi/testdata/contract/route.open_loops.root.json)。

### 訊息釘選

核心（不需要功能）。`fisheye`（B9 階段 B）用它當先天重要性。只有完成的 user / assistant 聊天訊息與結論卡可以釘選（其他 → `400 invalid_input`）；封存中的樹 → `409 archived`；
沒有這則訊息或不是這個租戶的 → `404 message_not_found`。

### `POST /messages/{mid}/pin`

寫。釘選。回應 `200 {message: Message}`；狀態有變才發 `message.updated`。樣本：[route.messages.pin.json](../httpapi/testdata/contract/route.messages.pin.json)。

### `DELETE /messages/{mid}/pin`

寫。取消釘選。回應同上。樣本：[route.messages.unpin.json](../httpapi/testdata/contract/route.messages.unpin.json)。

### 群組與合併支線（group）

功能 `group`（需要 `leaf`）。**群組**把同一棵樹已結束的支線圈起來，`group_summary` job 寫一段共同摘要；魚眼（`fisheye`）開著時，摘要就緒的群組在「其他支線的結論」裡是一行
`> [group] 標題 — 摘要`，取代成員各自的收尾（`fisheye.items` 是一個 `kind: group` 的項目，`id` = 群組 id、`lineId` 空字串）。一條支線同時只能在一個 active 群組。
**合併支線**（combine）把同一條父線底下進行中的支線合成一條新支線：`origin: merge`、掛在它們最新的分岔訊息上；背景包 = 父線在那裡的背景 + 每條支線的目的、收尾與最近的訊息 +
「採用的說法 / 待確認」；舊的支線 `discarded` + `mergedIntoLineId`（關於它們的 open 建議 `expired`）。suggest 模式：每次支線 merge / discard 後，便宜模型從整棵樹提出群組（建議匣，見[建議匣](#建議匣suggestions)）。
群組與摘要的 job 由 `SetJobDispatcher` 設定的派發器執行（參考伺服器與 httpapi 的 Dispatcher 相同）。

### `GET /lines/{id}/groups`

讀，功能 `group`。這棵樹的群組，新的在前。參數 `status`：逗號分隔或 `all`，預設 `active`（不合格 → `400 invalid_input`）。
回應 `200 {rootLineId, groups: Group[], limits: {maxMembers, maxActivePerTree, titleMaxRunes}}`。樣本：[route.groups.list.json](../httpapi/testdata/contract/route.groups.list.json)。

### `POST /lines/{id}/groups`

寫，功能 `group`。本文（必填）`{memberLineIds[]（2–12 條這棵樹已結束、有收尾或卡片結論的支線）, title, conflicts?: Conflict[]}`。
成員不合格（數量、還在進行、已升為主線（promoted）、沒有收尾、別棵樹、已在 active 群組）→ `422 invalid_group`；這棵樹 active 群組已達上限（50）→ `409 group_limit{limit}`；封存 → `409 archived`；`keepBoth` 而 `notes` 關閉 → `404 feature_disabled`。
建立後馬上開始摘要（`summaryStatus: drafting`）。回應 `201 {group, job: {jobId, kind, lineId, provider, model} | null, notes?}`，發 `group.changed`（建立、開始摘要各一次）與（keepBoth）`notes.changed`。
樣本：[route.groups.create.json](../httpapi/testdata/contract/route.groups.create.json)、[route.error.invalid_group.json](../httpapi/testdata/contract/route.error.invalid_group.json)。

### `GET /groups/{gid}`

讀，功能 `group`。回應 `200 {group}`；沒有（或別的租戶）→ `404 group_not_found`。樣本：[route.groups.get.json](../httpapi/testdata/contract/route.groups.get.json)。

### `PATCH /groups/{gid}`

寫，功能 `group`。改標題。本文（必填）`{title}`（空白 `400 invalid_input`，> 120 字 `422 too_long`）。已解散 → `409 group_not_active`。回應 `200 {group}`，發 `group.changed`。
樣本：[route.groups.rename.json](../httpapi/testdata/contract/route.groups.rename.json)。

### `POST /groups/{gid}/dissolve`

寫，功能 `group`。解散（成員恢復各自的收尾，可以再進別的群組）。已解散 → `409 group_not_active`。回應 `200 {group}`，發 `group.changed`。
樣本：[route.groups.dissolve.json](../httpapi/testdata/contract/route.groups.dissolve.json)、[route.error.group_not_active.json](../httpapi/testdata/contract/route.error.group_not_active.json)。

### `POST /groups/{gid}/summarize`

寫，功能 `group`（任何模式）。重新寫摘要：回應 `202 {jobId, kind: group_summary, lineId（主線）, provider, model}`；之前進行中的摘要不再寫入。
完成時 `summaryStatus: ready` 並發 `group.changed`；失敗（執行失敗、輸出不能用、逾時）時 `summaryStatus: failed`（保留上一次的摘要）並發 `group.changed` 與 `job.failed`；群組已解散時只發 `job.failed`，群組不變。
樣本：[route.groups.summarize.json](../httpapi/testdata/contract/route.groups.summarize.json)、[route.preview.group.json](../httpapi/testdata/contract/route.preview.group.json)（魚眼裡的群組）。

### `POST /lines/{id}/branches/combine`

寫，功能 `group`。`{id}` 是父線。本文（必填）`{lineIds[]（2–12 條 {id} 底下進行中、不是岔題的支線）, purpose, kind?（預設 investigate）, conflicts?: Conflict[]}`。
鎖順序：主線 → 父線 → 被合併的支線（id 順序）→ 它們進行中的子支線（id 順序）。新支線掛在它們在 `{id}` 上最新的分岔訊息；都不在 `{id}` 上時（例如 B9.1 改掛過來的子支線，R8）改掛在 `{id}` 最新一則完成的 user / assistant 訊息，`{id}` 還沒有完成的訊息 → `404 anchor_not_found`（訊息說明要先在這條線上回覆）。
不合格（數量、別的父線、岔題、主線）→ `422 invalid_group`；已結束 → `409 branch_closed`；回合中 → `409 branch_busy`；起草中 → `409 branch_drafting`；目的不合格同建立支線。
舊支線底下**進行中**的子支線（B9.1）改掛到新支線底下：`anchorMessageId` 不變（仍是它分岔的那則訊息，留在被合併的舊支線上；新支線的背景包引用每條舊支線最近的 8 則，分岔訊息在其中時就看得到；用舊支線的 `mergedIntoLineId` 對回來），
`depth` 不變（新支線與舊支線同層），它們底下的線跟著走；已結束的子支線留在原處。改掛後新支線的進行中子支線超過 `Limits.Branch.MaxOpenPerParent`（8）→ `409 branch_limit`，整筆不做。
回應 `201 {line, branch（新支線，origin merge）, pack, combined: BranchView[]（舊的，discarded + mergedIntoLineId）, reparented: string[]（改掛的子支線，id 順序）, notes?}`；
事件：`line.created`、父線 `line.updated`、`branch.changed{created}`、每條舊支線 `branch.changed{discarded}`、（有改掛）每條子支線 `branch.changed{moved}` 與失去子支線的舊支線 `line.updated`、（keepBoth）`notes.changed`、（有）`suggestion.changed{expired}`。
樣本：[route.branches.combine.json](../httpapi/testdata/contract/route.branches.combine.json)。

### 論證類型（ibis）

功能 `ibis`（B10）。訊息標成 IBIS 的五種之一：`question`（提出問題）、`idea`（想法、選項）、`pro`（贊成）、`con`（反對）、`decision`（決定）。
`Message.tag = {kind, source: ai | user, status: draft | confirmed, updatedAt}`（沒有標記時不出現）；大綱的 `BranchView.anchorTag` 是支線掛的那則訊息的標記。
只能標完成的 user / assistant 聊天訊息（卡片、標記、進行中的回覆 → `400 invalid_input`）。標記跟著訊息走（move / promote 不變），訊息被刪（岔題清除、刪樹）時一起刪。
suggest / auto：每 `Limits.Ibis.Every`（3）則回覆（岔題除外）便宜模型標這條線上一個成功的 `ibis_tag` job 之後還沒有標記的訊息（看最新 24 則，一次最多 `Limits.Ibis.BatchMax` 12 則）；
suggest 寫成 `source: ai, status: draft`（「AI 標・待確認」，使用者 PUT 同一個或別的類型即確認），auto 寫成 `confirmed`。**AI 不覆蓋任何已有的標記**，使用者刪掉的標記（在上一個 job 之前的訊息）也不會再被標回來。
每一則被 AI 標記的訊息發一個 `message.updated`；job 失敗發 `job.failed`（kind `ibis_tag`）。
`fisheye` 開著時，標成 `decision` 且 `status: confirmed` 的訊息先天重要性 +4（同被紀要或卡片引用；`domain.FisheyeDecisionBonus`）；AI 的草稿不算。manual：只有使用者標。功能關閉：路由 `404 feature_disabled`，已存的標記照樣帶出。

### `PUT /messages/{mid}/tag`

寫，功能 `ibis`。本文（必填）`{kind, status?}`（`kind` 不是五種之一 → `400 invalid_input`）。取代原有的標記（含 AI 的）：
- `status` 沒給、空字串或 `confirmed`：使用者的標記（`source: user, status: confirmed`），同 B10。
- `status: draft`（B15，「改回待確認」）：寫成 `source: ai, status: draft`，和 AI 標的草稿一樣出現在 `GET /lines/{id}/tag-drafts`，fisheye 不加分。
- 其他值（含大小寫不同、非字串）→ `400 invalid_input`（`details.field: status`）。

回應 `200 {message}`；`kind`、`source`、`status` 都相同時什麼都不變、不發事件，否則發 `message.updated`。沒有這則訊息（或別的租戶）→ `404 message_not_found`；封存 → `409 archived`。
樣本：[route.messages.tag.json](../httpapi/testdata/contract/route.messages.tag.json)、[route.messages.tag.draft.json](../httpapi/testdata/contract/route.messages.tag.draft.json)（改回草稿）、[route.messages.list.tagged.json](../httpapi/testdata/contract/route.messages.list.tagged.json)（AI 標的草稿）。

### `GET /lines/{id}/tag-drafts`

讀，功能 `ibis`（唯讀的呼叫者也可以）。`{id}` 可以是樹裡任何一條線，解析到主線；不是這個租戶的線 → `404 line_not_found`。一次查詢列出整棵樹（主線與所有支線，含順口問；封存的樹也可以讀）**標記是草稿**的完成 user / assistant 聊天訊息：
主線在前，支線依大綱的順序（建立時間），同一條線依 `seq`。**已捨棄（`discarded`）的支線不列**；合併、提升等其他狀態照列。最多 `store.TagDraftsMax`（500）筆，超過時 `truncated: true`。
回應 `200 {rootLineId, drafts: [{lineId, messageId, seq, role, content, tag: {kind, source, status, updatedAt}}], truncated}`（`drafts` 沒有時是 `[]`）。
`content` 是**摘錄**：最多 `domain.TagDraftContentRunes`（200）個字元（rune），超過時切到 199 字加上「…」；要全文請讀該線的訊息。
樣本：[route.ibis.drafts.json](../httpapi/testdata/contract/route.ibis.drafts.json)。

### `DELETE /messages/{mid}/tag`

寫，功能 `ibis`。刪除標記（不論誰標的）；沒有標記時什麼都不變、不發事件。回應 `200 {message}`（沒有 `tag`）。樣本：[route.messages.untag.json](../httpapi/testdata/contract/route.messages.untag.json)。

### 折疊（fold）

功能 `fold`（B10）。把一條線上一段連續的訊息（`fromSeq`..`toSeq`）折疊成摘要：訊息不搬動、畫面上照樣在，之後**送給 AI** 時以一則摘要項目取代
（在 `HistorySelector` 之前套用，魚眼把它當一項；`POST /preview` 的 `folds` 列出這一輪套用了哪些）。
**Fold**（`domain.Fold`）：`{id, lineId, fromMessageId, toMessageId, fromSeq, toSeq, summary, messageCount, tokensOriginal（原本的估計）, tokensSummary, status, aiDrafted, createdBy, createdAt, updatedAt}`；
`status`：`drafting`（AI 起草中，不套用）→ `active`（套用）或 `failed`（起草失敗，可以刪掉或重新建立）；`removed`（收回，不再列出）。
同一條線的 `drafting` / `active` 折疊不可重疊；每條線最多 `Limits.Fold.MaxActivePerLine`（50）個。move / promote 把整段訊息搬到別的線時折疊跟著搬（發 `fold.changed`），段落被拆開時折疊變 `removed`。
suggest（auto 等同 suggest：折疊改變 AI 看到的內容，不自動做）：每 `Limits.Fold.SuggestEvery`（10）個回覆，找這條線最舊的、已結束的章節（不是最後一章；≥ 8 則、≥ 1000 token、沒有和折疊重疊、沒有提過），
`fold_suggest` job 起草摘要 → 建議匣（見[建議匣](#建議匣suggestions)的「折疊」）。章節的切點同 `GET /chapters`（閒置、話題、milestone）。

### `GET /lines/{id}/folds`

讀，功能 `fold`。這條線沒有收回的折疊（`drafting`、`active`、`failed`），依 `fromSeq`。回應 `200 {lineId, rootLineId, folds: Fold[], limits: {summaryMaxRunes, minMessages, maxMessages, maxActivePerLine}}`。
樣本：[route.folds.list.json](../httpapi/testdata/contract/route.folds.list.json)。

### `POST /lines/{id}/folds`

寫，功能 `fold`（任何模式）。本文（必填）`{fromMessageId, toMessageId（兩則都在這條線上、已完成；順序不拘）, summary?}`。
有 `summary` → 直接 `active`；沒有 → `drafting` 並開始 `fold_summary` job（交給 Dispatcher；完成時 `active` 並發 `fold.changed`，失敗或逾時 `failed` 並發 `fold.changed` 與 `job.failed`）。
不在這條線上 → `404 message_not_found`；範圍少於 2 則、多於 200 則或含進行中的回覆 → `422 invalid_fold`；與別的折疊重疊 → `409 fold_overlap{foldId}`；已達上限 → `409 fold_limit{limit}`；
摘要 > 1000 字 → `422 too_long`；封存 → `409 archived`。回應 `201 {fold, job: {jobId, kind, lineId, provider, model} | null}`，發 `fold.changed`。
樣本：[route.folds.create.json](../httpapi/testdata/contract/route.folds.create.json)（起草）、[route.error.fold_overlap.json](../httpapi/testdata/contract/route.error.fold_overlap.json)、[route.error.invalid_fold.json](../httpapi/testdata/contract/route.error.invalid_fold.json)。

### `PATCH /folds/{fid}`

寫，功能 `fold`。改寫摘要（B10 階段 B 開頭）。本文（必填）`{summary}`（空白 → `400 invalid_input`，> 1000 字 → `422 too_long`）。
任何沒有收回的折疊都可以改：`drafting` / `failed` 的變成 `active`（起草中的 job 之後不再寫入），`aiDrafted` 變 `false`、`tokensSummary` 重算。
回應 `200 {fold}`，發 `fold.changed`。已收回、沒有或別的租戶 → `404 fold_not_found`；封存 → `409 archived`。樣本：[route.folds.update.json](../httpapi/testdata/contract/route.folds.update.json)。

### `DELETE /folds/{fid}`

寫，功能 `fold`。收回折疊（`removed`；訊息回到 prompt；起草中的 job 之後不再寫入）。回應 `204`，發 `fold.changed`。沒有、已收回或別的租戶 → `404 fold_not_found`；封存 → `409 archived`。
樣本：[route.folds.delete.json](../httpapi/testdata/contract/route.folds.delete.json)、[route.error.fold_not_found.json](../httpapi/testdata/contract/route.error.fold_not_found.json)。

### 發散與收斂（diverge）

功能 `diverge`（B10 階段 B，需要 `leaf`）。三步都是使用者按了才做（任何模式相同，不會自動發生）：
1. **發散**：`diverge` job 從一則訊息提出 N 個（2–5）方向，各開成那則訊息上的兄弟支線：`kind: alternative`、`origin: diverge`、目的 = 方向；背景包最後多一段 `## Direction`（這個方向、理由、其他方向）。
   全部一起開（一個交易），開不了（例如父線的進行中支線已滿）就一條都不開，job `failed` 並發 `job.failed`（`error.code: failed`、`message` 是原因）。
2. **收斂**：`converge` job 對同一條線底下 2–5 條進行中、不是岔題的支線做比較表：**Comparison**（`domain.Comparison`）
   `{id, rootLineId, parentLineId, lineIds[], criteria[]（使用者給的，可空）, status: drafting | ready | failed | decided, matrix, decidedLineId, createdBy, decidedBy, createdAt, updatedAt, decidedAt}`；
   `matrix`（`ready` 之後才有，之前 `null`）= `{criteria[], options[]{lineId, label（比較時的支線目的）}, scores[criterion][option]{score: 1–5（0 = 模型沒給）, why}, recommendation: {lineId, reason}}`。
   沒給 `criteria` 時模型自己選 3–6 個。
3. **決定**：一個交易內，選定的支線寫 `decision` 收尾（line 預設：選的是建議的那條時 = 建議的理由，否則 = 它的目的；body = 它那一欄的分數）並**維持進行中**；
   其他比較的支線裡還在這條線底下進行中的，放棄（`discarded`）並寫 `dead_end` 收尾（伺服器語言的模板：預設 `沒選：改走「<選定的目的>」`，宿主用 `tangent.WithLeafTexts` 換，例如 `domain.EnglishLeafTexts()` 的 `Not chosen: went with …`；body = 它那一欄）；關於它們的 open 建議 `expired`。
   放棄的支線不會再起草收尾、也不觸發關聯 / 群組建議（不跑 discard 的 AfterCommit 掛勾）。比較之後已經結束（或被獨立出去）的支線不動。

### `POST /lines/{id}/diverge`

寫，功能 `diverge`。本文（必填）`{anchorMessageId（這條線上完成的 user / assistant 訊息）, count（2–5）}`。
`count` 不合格 → `400 invalid_input`；anchor 不合格 → `404 anchor_not_found`；開完會超過父線的進行中支線上限（8）→ `409 branch_limit`。
回應 `202 {jobId, kind: diverge, lineId, provider, model}`；job 完成時每條新支線照建立支線發 `line.created`、父線 `line.updated`、`branch.changed{created}`。
樣本：[route.diverge.json](../httpapi/testdata/contract/route.diverge.json)、[route.branches.list.diverged.json](../httpapi/testdata/contract/route.branches.list.diverged.json)（開好的支線）。

### `POST /lines/{id}/diverge/models`

寫，功能 `diverge`。跨模型發散（B14）：在錨點上**立刻**為每個目標模型開一條平行支線（`kind: alternative`、`origin: diverge`），不跑 job、不呼叫模型。`{id}` 是父線。本文（必填）：

```
{anchorMessageId, purpose?（共用目的，≤ 200 字）, excerpt?（≤ 1,500 字，每條都帶）, confirmDeeper?,
 targets: [{provider, model, purpose?}]（2–5 個）}
```

- 每條支線的 provider / model 是它的目標（宿主的 `WithModelCheck` 不允許 → `422 model_not_allowed`；`provider` 或 `model` 空白 → `400 invalid_input`）。
  同一個模型可以出現多次（例如同一個模型答兩次比較差異）。
- 支線目的：目標自己的 `purpose`；沒有時 `「{purpose} · {model}」`；兩個都沒有時取錨點內容的前 40 字（壓成一行）加 `「 · {model}」`。超過 200 字時截短前段、保留模型名稱。
- 每條的背景包最後附上「平行回答」一段：這條由哪個模型回答、其他平行支線的目的與模型。
- `targets` 數量不合格 → `400 invalid_input`；anchor 不是這條線上完成的 user / assistant 訊息 → `404 anchor_not_found`；目的太長 → `400 invalid_input`。
- 一個交易（鎖 主線 → 父線），每條照建立支線檢查（父線底下進行中的上限 → `409 branch_limit`、整棵樹的上限 → `409 tree_limit`、深度 → `409 depth_soft_limit` / `depth_hard_limit`、父線已結束 → `409 parent_closed`、封存 → `409 archived`），
  **全開或全不開**。和 job 開的發散支線一樣，交易內不跑功能的建立支線掛勾；commit 後每條各發 `line.created`、父線 `line.updated`、`branch.changed{created}`。
- 回應 `201 {parentLineId, rootLineId, branches: [{line, branch, pack}]}`（依 `targets` 的順序）。
  樣本：[route.diverge.models.json](../httpapi/testdata/contract/route.diverge.models.json)。

### `POST /lines/{id}/converge`

寫，功能 `diverge`。`{id}` 是父線。本文（必填）`{lineIds[]（2–5 條 {id} 底下進行中、不是岔題的支線）, criteria?: string[]（≤ 6 個，每個 ≤ 120 字）}`。
不合格（數量、別的父線、岔題、不是支線）→ `422 invalid_comparison`；已結束 → `409 branch_closed`；criteria 太多 → `400 invalid_input`、太長 → `422 too_long`；封存 → `409 archived`。
回應 `201 {comparison（drafting）, job: {jobId, kind: converge, lineId, provider, model}}`，發 `comparison.changed`；job 完成時 `ready`（或失敗 / 逾時 `failed` 並發 `job.failed`），再發一次 `comparison.changed`。
樣本：[route.converge.json](../httpapi/testdata/contract/route.converge.json)、[route.error.invalid_comparison.json](../httpapi/testdata/contract/route.error.invalid_comparison.json)。

### `GET /lines/{id}/comparisons`

讀，功能 `diverge`。這條線底下支線的比較，新的在前（最多 100）。回應 `200 {lineId, rootLineId, comparisons: Comparison[], limits: {minOptions, maxOptions, maxCriteria}}`。
樣本：[route.comparisons.list.json](../httpapi/testdata/contract/route.comparisons.list.json)。

### `GET /comparisons/{cid}`

讀，功能 `diverge`。回應 `200 {comparison}`；沒有（或別的租戶）→ `404 comparison_not_found`。
樣本：[route.comparisons.get.json](../httpapi/testdata/contract/route.comparisons.get.json)、[route.error.comparison_not_found.json](../httpapi/testdata/contract/route.error.comparison_not_found.json)。

### `POST /comparisons/{cid}/decide`

寫，功能 `diverge`。本文（必填）`{lineId（比較的其中一條）, line?（decision 收尾的一句話，覆寫預設）}`。
鎖順序：主線 → 父線 → 比較的支線（id 順序）→ 比較。不是 `ready` → `409 comparison_not_ready`；已決定 → `409 comparison_decided`；`lineId` 不是選項 → `422 invalid_comparison`；
選定的已結束 → `409 branch_closed`；要放棄的支線回合中 → `409 branch_busy`、起草中 → `409 branch_drafting`；封存 → `409 archived`。
回應 `200 {comparison（decided）, chosen: BranchView, decision: Leaf, discarded: BranchView[]（帶 dead_end 收尾）}`；
事件：每條放棄的 `branch.changed{discarded}` → 父線 `line.updated` → 每條放棄的 `leaf.changed` → 選定的 `leaf.changed` → `comparison.changed` →（有）`suggestion.changed{expired}`。
樣本：[route.comparisons.decide.json](../httpapi/testdata/contract/route.comparisons.decide.json)、[route.error.comparison_decided.json](../httpapi/testdata/contract/route.error.comparison_decided.json)、[route.error.comparison_not_ready.json](../httpapi/testdata/contract/route.error.comparison_not_ready.json)。

### 跨對話記憶（memory）

功能 `memory`（B10 階段 C；需要 `notes`、宿主的 `Embedder`、`vector` 擴充與功能 migration，不在 `AllFeatures()`）。記憶屬於**租戶**（跨對話），不屬於某一棵樹。
**Memory**（`domain.Memory`）：`{id, kind: fact | decision | preference | lesson, text（一行，≤ 500 字）, status: active | superseded, supersededBy, importance（1–10）, validUntil, source: {lineId, messageId, leafLineId, noteId, label}, aiDrafted, createdBy, createdAt, updatedAt}`。
記憶**不會被刪除**：改內容 = 取代（舊的 `superseded` + `supersededBy` 指向新的，可以用 `?status=superseded` 讀到歷史）；出處沒有外鍵，來源的對話刪掉後 `source.label`（寫入時的文字）還在。
**召回**：分數 = 相關性（`Embedder` 的 cosine 相似度，低於 0.3 不算）× 近期（新的 1，每 30 天朝 0.5 減半）× 重要性 / 10；`validUntil` 過了的不召回。
每一輪的 prompt 帶最相關的幾筆（最多 5 筆、1,500 token，trailing 區塊 `memory`，只在 `POST /preview` 的 `memories` 看得到）；開新對話、開支線時的「你之前得出過…」用 `POST /memories/search`。
**寫入**：使用者自己寫（任何模式）；suggest / auto 在 merge、放棄時帶了收尾、`PUT /leaf`、寫入 `decided` 紀要之後，`memory_extract` job 對照最相近的既有記憶提出 新增 / 更新（= 取代）：suggest → 建議匣 kind `memory`，auto → 直接寫入。
**整併**：維護迴圈 `memory.consolidate` 找近似重複（相似度 ≥ 0.92）的記憶，`memory_consolidate` job 判斷 合併 / 矛盾 / 都保留 → 建議匣 kind `memory_consolidate`（auto 的合併直接做；矛盾一律等使用者）。job 失敗發 `job.failed`。

### `GET /memories`

讀，功能 `memory`。這個租戶的記憶，新的在前（`createdAt` 由新到舊，同時間的依 id 由大到小）。

| 參數 | 說明 |
|---|---|
| `kind` | 只列這個種類；預設全部 |
| `status` | 逗號分隔或 `all`，預設 `active` |
| `limit` | 1–200，預設 100 |
| `cursor` | 上一頁的 `nextCursor`（B10.1）；篩選條件要和上一頁相同，換篩選就從第一頁重來 |

不合格（含解不開的 `cursor`）→ `400 invalid_input`。
回應 `200 {memories: Memory[], nextCursor, limits: {textMaxRunes, topK, searchMax}}`；`nextCursor` 為空字串表示沒有下一頁（同 `GET /lines`）。
樣本：[route.memories.list.json](../httpapi/testdata/contract/route.memories.list.json)、[route.memories.list.page.json](../httpapi/testdata/contract/route.memories.list.page.json)（`limit=1`，還有下一頁）、[route.memories.list.superseded.json](../httpapi/testdata/contract/route.memories.list.superseded.json)（歷史）。

### `POST /memories`

寫，功能 `memory`（任何模式）。本文（必填）`{kind, text, importance?（預設 5）, validUntil?, sourceLineId?}`；`sourceLineId` 給了就要是這個租戶的線（`404 line_not_found`），`source.label` = 它的支線目的或標題。
不合格的 kind / 空白 / importance 不在 1–10 → `422 invalid_memory`；> 500 字 → `422 too_long`。回應 `201 {memory}`，發 `memory.changed`。
樣本：[route.memories.create.json](../httpapi/testdata/contract/route.memories.create.json)、[route.error.invalid_memory.json](../httpapi/testdata/contract/route.error.invalid_memory.json)。

### `PATCH /memories/{mid}`

寫，功能 `memory`。改歸類：`{kind?, importance?, validUntil?（null 清掉）}`（內容只能用取代改）。被取代的 → `409 memory_superseded`；沒有或別的租戶 → `404 memory_not_found`。
回應 `200 {memory}`，發 `memory.changed`。樣本：[route.memories.update.json](../httpapi/testdata/contract/route.memories.update.json)、[route.error.memory_not_found.json](../httpapi/testdata/contract/route.error.memory_not_found.json)。

### `POST /memories/{mid}/supersede`

寫，功能 `memory`。用新的內容取代：`{text, kind?, importance?, validUntil?}`（沒給的沿用舊的；出處沿用舊的）。已被取代 → `409 memory_superseded`。
回應 `201 {memory（新的）, superseded: Memory[]（舊的）}`，發 `memory.changed`（`superseded` 帶舊的）。
樣本：[route.memories.supersede.json](../httpapi/testdata/contract/route.memories.supersede.json)、[route.error.memory_superseded.json](../httpapi/testdata/contract/route.error.memory_superseded.json)。

### 備忘（memo）

節點上的筆記，**不會給 AI**：不進任何一輪的 prompt、不出現在送出前預覽、背景工作也不讀。不是私人的：讀得到這段對話的人都讀得到（同 REST，不依讀者過濾）。
`{id}` 可以是樹上任何一條線；`{mid}` 是備忘 id。封存中的對話不能寫（`409 archived`）；刪除對話時一起刪；獨立成新對話不複製備忘。

### `GET /lines/{id}/memos`

讀，功能 `memo`。整棵樹的備忘，舊的在前；`?lineId=` 只取一個節點的（不是這棵樹的線 → `404 line_not_found`）。
回應 `200 {rootLineId, memos: Memo[], limits: {maxTotal, maxRunes}}`（`maxTotal` 每棵樹的上限，`maxRunes` 一則的字數上限）。
樣本：[route.memos.list.json](../httpapi/testdata/contract/route.memos.list.json)、[route.memos.list.node.json](../httpapi/testdata/contract/route.memos.list.node.json)。

### `POST /lines/{id}/memos`

寫，功能 `memo`。`{lineId?, text}`：`lineId` 是節點（預設 `{id}`），必須在同一棵樹（否則 `404 line_not_found`）。`text` 空白 → `422 invalid_input`，太長 → `422 too_long`。
每棵樹最多 500 則（`409 memo_limit{limit}`）。回應 `201 {memo}`，發 `memo.changed{created}`。樣本：[route.memos.create.json](../httpapi/testdata/contract/route.memos.create.json)。

### `PATCH /memos/{mid}`

寫，功能 `memo`。`{text}` 取代內容（節點與 `sourceLabel` 不變）。沒有或別的租戶 → `404 memo_not_found`。回應 `200 {memo}`，發 `memo.changed{updated}`。
樣本：[route.memos.update.json](../httpapi/testdata/contract/route.memos.update.json)、[route.error.memo_not_found.json](../httpapi/testdata/contract/route.error.memo_not_found.json)。

### `DELETE /memos/{mid}`

寫，功能 `memo`。刪掉（不留紀錄；前端的「復原」是用原文再建一則）。回應 `200 {memo（刪掉前的樣子）}`，發 `memo.changed{deleted}`。
樣本：[route.memos.delete.json](../httpapi/testdata/contract/route.memos.delete.json)。

### 名詞表（glossary）

功能 `glossary`（B24；在 `AllFeatures()`，參考伺服器預設開；沒有 AI，只有開 / 關）。一棵樹一份「名詞 → 解釋」。
**進 prompt 的只有名詞本身**：每一條線的每一輪都在不快取的尾段（記憶之後、回覆行規則之前）帶一個 `glossary` 區塊
（`## Glossary` + `Terms the user has already asked about: A, B, C` + 「不必再解釋，除非使用者要求」），最多 300 token（`Limits.Glossary.TokenBudget`），
超過時留**最近更新**的名詞，區塊裡依 `termKey` 排序；解釋不進任何 prompt、預覽或背景工作。功能關閉時路由回 `404 feature_disabled`、prompt 沒有這個區塊、資料保留。

`Term`：`{id, rootLineId, term, termKey, explanation, sourceLineId, sourceMessageId, sourceLabel, createdBy, createdAt, updatedAt}`。
`termKey` 是正規化後的名詞（去掉所有空白、全形英數轉半形、轉小寫），同一棵樹不重複。`sourceLineId` 是存的時候所在的線（那條線被刪除或清除後為 `""`，名詞留著）；
`sourceMessageId` 選填（沒給是 `""`）；`sourceLabel` 是寫入時的來源名稱快照（同紀要、備忘：`主線 #3`、`順口問・目的`…）。
名詞 1–60 字（清理後成一行），解釋 1–1,000 字（可多行），照宿主系統訊息的規則清理（`domain.CleanSystemText`）。每棵樹最多 300 筆。
封存中的對話不能寫（`409 archived`），讀與搜尋照常（搜尋不列封存的對話）。

樹搬動時：獨立成新對話（`fresh`）不複製；`detach` 時來源在搬走的子樹內的名詞跟著搬；`attach` 時來源樹的名詞改掛到目標主線，
`termKey` 重複的保留目標的（來源的那筆刪除）；刪除支線、清除順口問只把 `sourceLineId` 變成 `""`；接著問（B23）把來源改成新的那條支線。

### `GET /lines/{id}/terms`

讀，功能 `glossary`。`{id}` 是樹上任一條線。整棵樹的名詞表，依 `termKey` 排序（最多 1,000 筆；attach 可能讓一棵樹超過 300）。
回應 `200 {rootLineId, terms: Term[], limits: {maxTotal, termMaxRunes, explanationMaxRunes}}`。
樣本：[route.terms.list.json](../httpapi/testdata/contract/route.terms.list.json)。

### `POST /lines/{id}/terms`

寫（op `terms.create`），功能 `glossary`。`{id}` 是來源的線。本文（必填）`{term, explanation, sourceMessageId?, replace?}`：

- `sourceMessageId` 必須是 `{id}` 那條線上的訊息（否則 `404 message_not_found`）。
- 名詞或解釋空白 → `400 invalid_input`（`field: term` / `explanation`）；太長 → `422 too_long`（`field`、`max`）。
- 這棵樹已經有同一個 `termKey`：`replace` 沒給或 `false` → `409 term_exists`，extra `term` 是已有的那筆（`Term`）；`replace: true` → 原地覆寫**解釋與來源**（名詞原文不變）。
- 已達上限 → `409 term_limit{limit}`。
- `{id}` 是**順口問**而且還沒保留時，在同一個交易把它設成保留（`keptAt`，B23），所以存進名詞表的順口問不會被清除。

回應：新增 `201`、覆寫 `200`，本文 `{term: Term, change: created | updated, keptBranch?: BranchView}`（`keptBranch` 只在這次把順口問設成保留時出現）。
發 `terms.changed{created | updated}`；設了保留時接著發 `branch.changed{kept}`。樣本：[route.terms.create.json](../httpapi/testdata/contract/route.terms.create.json)（從順口問存，帶 `keptBranch`）。

### `PATCH /terms/{tid}`

寫（op `terms.update`），功能 `glossary`。`{term?, explanation?}`，沒給的欄位保留；兩個都沒給 → `400 invalid_input`。
改名後的 `termKey` 和同棵樹的另一筆重複 → `409 term_exists`（extra `term` 是那一筆）。來源與 `sourceLabel` 不變。
沒有或別的租戶 → `404 term_not_found`。回應 `200 {term}`，發 `terms.changed{updated}`。樣本：[route.terms.update.json](../httpapi/testdata/contract/route.terms.update.json)。

### `DELETE /terms/{tid}`

寫（op `terms.delete`），功能 `glossary`。刪掉（不留紀錄）。回應 `204`（沒有本文），發 `terms.changed{deleted}`。沒有或別的租戶 → `404 term_not_found`。

### `GET /terms`

讀，功能 `glossary`。`?q=&limit=&cursor=`：全租戶查名詞。`q` 用同樣的規則正規化後比對 `termKey`：**開頭相符的在前**，再來是包含的，各自依 `termKey` 排序；
`q` 空白列出全部。`limit` 1–100（預設 20，超出範圍 `400 invalid_input`）；`cursor` 是上一頁的 `nextCursor`（不合格 → `400 invalid_input`）。封存的對話不列。
回應 `200 {terms: [Term + rootTitle], nextCursor}`（每筆是 `Term` 的欄位加上它所在對話的標題 `rootTitle`；`nextCursor` 為空字串表示沒有下一頁）。
樣本：[route.terms.search.json](../httpapi/testdata/contract/route.terms.search.json)。

### `POST /memories/search`

讀（唯讀身分也可以），功能 `memory`。`{query（必填）, limit?（預設 5，最多 20）}` → `200 {query, results: [{memory, similarity, score}]}`（分數高的在前，只有夠相關的）。
開新對話時用第一則訊息、開支線時用支線目的查，顯示「你之前得出過…」（帶入或忽略由前端決定）。樣本：[route.memories.search.json](../httpapi/testdata/contract/route.memories.search.json)、[route.preview.memories.json](../httpapi/testdata/contract/route.preview.memories.json)（這一輪帶入的記憶）。

### 事件串流

### `GET /events`

讀。Server-Sent Events，只有 `Config.Hub` 不為 nil 時才掛上。只送這個租戶的事件。連上後先送一行註解 `: connected`，
之後每 25 秒一行 `: keepalive`。每個事件是：

```
event: <type>
data: {"type":"<type>","tenant":"…","rootLineId":"…","lineId":"…","data":{…}}
```

`data` 的形狀見[事件](#事件)。宿主設了 `Config.DeltaFilter` 時，`message.delta` 依這個連線的請求過濾（可能少了幾則或內容被改寫），其他事件不過濾。沒有重播：斷線重連後請重新讀取畫面上的資料（進行中的回合用 `/stream` 補）。
連線數超過上限（預設總共 256、每租戶 16）→ `503 unavailable`。前端用 fetch + ReadableStream 讀，這樣認證標頭也能帶上
（`EventSource` 不能帶標頭；`/events` 不支援 query token）。

## 宿主的操作名稱（op）

每個寫入路由都有一個穩定的操作名稱，傳給宿主的兩個 callback（`httpapi.Config`，B7.0）：

- `TxOptions(r, op) []tangent.TxOption`：結果原封不動傳給那個路由的 Engine 寫入。`tangent.InTx` 的掛勾在**同一個交易**、commit 前執行，
  收到的 `result` 型別見 `docs/EMBEDDING.md` §4.4（依下表的 Engine 方法）；掛勾回錯就整筆 rollback，httpapi 照一般錯誤回答
  （`*domain.Error` 用它的碼，未知的碼問 `Config.StatusFor`，其他錯誤 500）。Engine 在交易前就拒絕的請求（例如 `turn_pending`）
  與不寫入的請求（沒有回合在跑時的 `turns.cancel`）不會執行掛勾。
- `HostMeta(r, op) (json.RawMessage, error)`：只有 `lines.create`、`lines.update`、`turns.send`、`branches.create`、`branches.move`、`branches.continue`（B23）會問，
  結果存成新線（或新使用者訊息）的 `hostMeta`，必須是 JSON 物件或 nil；`lines.update` 時它**整個取代**那條線的 `hostMeta`，nil 表示不變。回 `*domain.Error` 就用它的碼拒絕，其他錯誤 500（細節只寫 log）。
  客戶端自己送 `hostMeta` 仍然是 `400 invalid_input`；要讓客戶端帶宿主的資料（例如附件 id），放在別的欄位（API 會忽略未知欄位），
  由 callback 讀出來（參考伺服器 `cmd/tangent-server` 另用此機制在 `lines.create`、`lines.update`、`turns.send` 讀取 `reasoningEffort`，寫入 `hostMeta.reasoningEffort`，見 `docs/EMBEDDING.md` §4.5）。
- 兩個 callback 都可以再讀一次 `r.Body`：httpapi 讀過並驗證的同一段位元組（受 `MaxBodyBytes` 限制），API 忽略的欄位也在。

名稱匯出成 `httpapi.Op…` 常數（例如 `httpapi.OpTurnsSend`）。讀取路由沒有操作名稱。`httpapi/ops_doc_test.go` 檢查本表與路由一致。

| op | 路由 | Engine 方法 |
|---|---|---|
| `lines.create` | `POST /lines` | `CreateLine` |
| `lines.update` | `PATCH /lines/{id}` | `UpdateLine` |
| `lines.delete` | `DELETE /lines/{id}` | `DeleteTree` |
| `lines.archive` | `POST /lines/{id}/archive` | `ArchiveTree` |
| `lines.unarchive` | `POST /lines/{id}/unarchive` | `ArchiveTree` |
| `lines.read` | `POST /lines/{id}/read` | `MarkRead` |
| `lines.import` | `POST /lines/import` | `ImportLine` |
| `imports.delete` | `DELETE /imports/{bid}` | `DeleteImportBatch` |
| `lines.rename_folder` | `POST /lines/folders/rename` | `RenameFolder` |
| `lines.attach` | `POST /lines/{id}/attach` | `AttachLine` |
| `turns.send` | `POST /lines/{id}/messages` | `BeginTurn` |
| `turns.retry` | `POST /lines/{id}/retry` | `RetryTurn` |
| `turns.cancel` | `POST /lines/{id}/cancel` | `CancelTurn` |
| `summary.compact` | `POST /lines/{id}/compact` | `StartSummary` |
| `branches.create` | `POST /lines/{id}/branches` | `CreateBranch` |
| `branches.move` | `POST /lines/{id}/branches/move` | `MoveToBranch` |
| `branches.extract` | `POST /lines/{id}/branches/extract` | `ExtractToBranch` |
| `branches.combine` | `POST /lines/{id}/branches/combine` | `CombineBranches` |
| `branches.rename` | `PATCH /lines/{id}/branch` | `RenameBranch` |
| `branches.draft` | `POST /lines/{id}/branch/draft` | `StartDraft` |
| `branches.merge` | `POST /lines/{id}/branch/merge` | `MergeBranch` |
| `branches.discard` | `POST /lines/{id}/branch/discard` | `DiscardBranchWith` |
| `branches.promote` | `POST /lines/{id}/branch/promote` | `PromoteBranch` |
| `branches.update_card` | `PATCH /lines/{id}/branch/card` | `UpdateBranchCard` |
| `notes.create` | `POST /lines/{id}/notes` | `ApplyNoteChanges` |
| `notes.update` | `PATCH /lines/{id}/notes/{nid}` | `UpdateNote` |
| `notes.supersede` | `POST /lines/{id}/notes/{nid}/supersede` | `ApplyNoteChanges` |
| `milestones.add` | `POST /lines/{id}/chapters/milestones` | `AddMilestone` |
| `milestones.delete` | `DELETE /lines/{id}/chapters/milestones/{mid}` | `DeleteMilestone` |
| `suggestions.accept` | `POST /suggestions/{sid}/accept` | `AcceptSuggestion` |
| `suggestions.dismiss` | `POST /suggestions/{sid}/dismiss` | `DismissSuggestion` |
| `suggestions.dismiss_all` | `POST /lines/{id}/suggestions/dismiss-all` | `DismissAllSuggestions` |
| `leaf.put` | `PUT /lines/{id}/leaf` | `PutLeaf` |
| `leaf.delete` | `DELETE /lines/{id}/leaf` | `DeleteLeaf` |
| `leaf.draft` | `POST /lines/{id}/leaf/draft` | `StartLeafDraft` |
| `seeds.create` | `POST /lines/{id}/seeds` | `CreateSeed` |
| `seeds.expand` | `POST /seeds/{sid}/expand` | `ExpandSeed` |
| `seeds.to_note` | `POST /seeds/{sid}/to-note` | `NoteSeed` |
| `seeds.drop` | `POST /seeds/{sid}/drop` | `DropSeed` |
| `seeds.batch` | `POST /lines/{id}/seeds/batch` | `CreateSeeds` |
| `spinoff.create` | `POST /lines/{id}/spinoff` | `Spinoff` |
| `goal.put` | `PUT /lines/{id}/goal` | `PutGoal` |
| `goal.delete` | `DELETE /lines/{id}/goal` | `DeleteGoal` |
| `goal.propose` | `POST /lines/{id}/goal/propose` | `ProposeGoal` |
| `relations.create` | `POST /lines/{id}/relations` | `CreateRelation` |
| `relations.update` | `PATCH /lines/{id}/relations/{rid}` | `EditRelation` |
| `relations.delete` | `DELETE /lines/{id}/relations/{rid}` | `DeleteRelation` |
| `messages.pin` | `POST /messages/{mid}/pin` | `PinMessage` |
| `messages.unpin` | `DELETE /messages/{mid}/pin` | `PinMessage` |
| `groups.create` | `POST /lines/{id}/groups` | `CreateGroup` |
| `groups.rename` | `PATCH /groups/{gid}` | `RenameGroup` |
| `groups.dissolve` | `POST /groups/{gid}/dissolve` | `DissolveGroup` |
| `groups.summarize` | `POST /groups/{gid}/summarize` | `SummarizeGroup` |
| `messages.tag` | `PUT /messages/{mid}/tag` | `SetMessageTag` |
| `messages.untag` | `DELETE /messages/{mid}/tag` | `UntagMessage` |
| `folds.create` | `POST /lines/{id}/folds` | `CreateFold` |
| `folds.update` | `PATCH /folds/{fid}` | `UpdateFold` |
| `folds.delete` | `DELETE /folds/{fid}` | `RemoveFold` |
| `diverge.start` | `POST /lines/{id}/diverge` | `StartDiverge` |
| `diverge.models` | `POST /lines/{id}/diverge/models` | `DivergeModels` |
| `comparisons.create` | `POST /lines/{id}/converge` | `Converge` |
| `comparisons.decide` | `POST /comparisons/{cid}/decide` | `DecideComparison` |
| `memories.create` | `POST /memories` | `CreateMemory` |
| `memories.update` | `PATCH /memories/{mid}` | `UpdateMemory` |
| `memories.supersede` | `POST /memories/{mid}/supersede` | `SupersedeMemory` |
| `memos.create` | `POST /lines/{id}/memos` | `CreateMemo` |
| `memos.update` | `PATCH /memos/{mid}` | `UpdateMemo` |
| `memos.delete` | `DELETE /memos/{mid}` | `DeleteMemo` |
| `branches.keep` | `PUT /lines/{id}/branch/keep` | `KeepBranch` |
| `branches.continue` | `POST /lines/{id}/branch/continue` | `ContinueAside` |
| `branches.delete` | `DELETE /lines/{id}/branch` | `DeleteBranch` |
| `terms.create` | `POST /lines/{id}/terms` | `CreateTerm` |
| `terms.update` | `PATCH /terms/{tid}` | `UpdateTerm` |
| `terms.delete` | `DELETE /terms/{tid}` | `DeleteTerm` |

## 錯誤碼

`code` 對應的 HTTP 狀態（`httpapi.StatusOf(code)`）。表裡沒有的碼（例如宿主 `TurnGate` 自己的碼）先問 `Config.StatusFor`，
查不到時 `domain.Error` 回 409，其他錯誤回 `500 internal`（細節只寫進 log）。有 extra 欄位的碼另外標出。

**開支線**

| code | HTTP | 說明 |
|---|---|---|
| `depth_soft_limit` | 409 | 超過軟深度（3），要 `confirmDeeper: true` |
| `depth_hard_limit` | 409 | 超過硬深度（6） |
| `branch_limit` | 409 | 父線 open 支線已達上限（8） |
| `tree_limit` | 409 | 整棵樹支線已達上限（200） |
| `parent_closed` | 409 | 父線（或祖先）已關閉 |
| `anchor_not_found` | 404 | anchor 不是父線上完成的 user / assistant 訊息或結論卡 |
| `kind_unsupported` | 400 | 不支援的支線種類 |
| `suggestion_not_found` | 404 | `suggestionMessageId` 的建議對不上 |

**回合與支線狀態**

| code | HTTP | 說明 |
|---|---|---|
| `branch_closed` | 409 | 支線（或祖先）已關閉 |
| `archived` | 409 | 樹已封存 |
| `aside_answered` | 409 | 岔題已回答，不能再問 |
| `branch_busy` | 409 | 支線正在忙（B23：順口問還沒答完不能接著問；要刪的支線底下還有進行中的支線） |
| `branch_drafting` | 409 | 支線正在起草結論卡 |
| `turn_pending` | 409 | 這條線已有進行中的回合 |
| `turn_not_pending` | 409 | 這一輪已不是進行中（執行端用） |
| `nothing_to_retry` | 409 | 最後一輪沒有失敗 |
| `invalid_transition` | 409 | 不合法的狀態變化 |
| `session_busy` | 409 | 線正在回答，操作被略過 |
| `concurrent_change` | 409 | 併發寫入一直衝突，請重試 |
| `id_unavailable` | 409 | 宿主指定的 id 不能用 |

**起草與返回**

| code | HTTP | 說明 |
|---|---|---|
| `no_messages` | 409 | 支線沒有訊息可起草（B23：順口問沒有回答可以接著問） |
| `draft_not_pending` | 409 | 草稿已不在起草中（執行端用） |
| `parent_busy` | 409 | 父線或支線正在回合中 |
| `parent_moved` | 409 | 父線在你看到之後又有新訊息；extra `movedMessages`、`movedCards` |
| `invalid_card` | 422 | 結論卡不合格；extra `problems[]{field, message}` |
| `invalid_parent_tip` | 422 | `parentTipMessageId` 不是父線的訊息 |

**搬移、升級、刪除**

| code | HTTP | 說明 |
|---|---|---|
| `invalid_count` | 400 | `count` 不在 1–40 |
| `not_enough_messages` | 400 | 線上訊息不夠搬 |
| `move_must_start_with_user` | 400 | 搬的第一則不是 user 訊息 |
| `move_protected_message` | 400 | 範圍包含卡片或標記 |
| `move_no_anchor` | 400 | 搬完沒有可掛的 anchor |
| `source_busy` | 409 | 來源線在回合中 |
| `promote_not_top_level` | 409 | 不是主線的直接子支線 |
| `open_branches_on_old_tail` | 409 | 舊尾段上還有 open 支線 |
| `branch_not_main_line` | 409 | 只能對主線做（封存、刪除） |
| `branch_not_deletable` | 409 | 這條支線不能單獨刪除（B23：只有已結束的順口問與 `discarded` 的支線可以；先前的主線、被合併進別的支線的除外） |

**紀要與章節**

| code | HTTP | 說明 |
|---|---|---|
| `note_not_found` | 404 | 沒有這筆紀要 |
| `note_superseded` | 409 | 紀要已被取代 |
| `note_limit` | 409 | 紀要已達上限 |
| `invalid_note` | 422 | 紀要內容不合格 |
| `note_source_not_found` | 422 | 來源線或訊息不在這棵樹 |
| `milestone_not_found` | 404 | 沒有這個 milestone |
| `milestone_exists` | 409 | 這則訊息已有 milestone |
| `milestone_limit` | 409 | milestone 已達上限 |
| `message_not_found` | 404 | 這條線上沒有這則訊息 |
| `invalid_milestone` | 422 | milestone 不合格 |

**建議匣、收尾、停車場（B8）**

| code | HTTP | 說明 |
|---|---|---|
| `suggestion_not_open` | 409 | 建議已接受、拒絕或過期 |
| `invalid_leaf` | 422 | 收尾不合格；extra `problems[]{field, message}` |
| `leaf_not_found` | 404 | 支線沒有收尾 |
| `seed_not_found` | 404 | 沒有這個種子（或不是這個租戶、這棵樹的） |
| `seed_not_open` | 409 | 種子已展開、記進紀要或丟掉 |
| `seed_limit` | 409 | 這棵樹 open 的種子已達上限；extra `limit` |

**目標與關聯（B9）**

| code | HTTP | 說明 |
|---|---|---|
| `goal_not_found` | 404 | 對話沒有目標（`DELETE /goal`） |
| `relation_not_found` | 404 | 沒有這條關聯（或不碰到這棵樹、不是這個租戶的、不是關聯） |
| `relation_exists` | 409 | 兩端已有關聯（不分方向） |
| `relation_limit` | 409 | 這棵樹的關聯已達上限；extra `limit` |
| `group_not_found` | 404 | 沒有這個群組（或不是這個租戶的） |
| `group_not_active` | 409 | 群組已解散 |
| `invalid_group` | 422 | 群組或合併的支線、矛盾不合格（訊息說明原因） |
| `group_limit` | 409 | 這棵樹 active 的群組已達上限；extra `limit` |

**折疊（B10）**

| code | HTTP | 說明 |
|---|---|---|
| `fold_not_found` | 404 | 沒有這個折疊（或已收回、不是這個租戶的） |
| `fold_overlap` | 409 | 範圍與這條線的另一個折疊重疊；extra `foldId` |
| `fold_limit` | 409 | 這條線的折疊已達上限；extra `limit` |
| `invalid_fold` | 422 | 範圍不合格（則數、含進行中的回覆；訊息說明原因） |

**發散與收斂（B10 階段 B）**

| code | HTTP | 說明 |
|---|---|---|
| `comparison_not_found` | 404 | 沒有這個比較（或不是這個租戶的） |
| `comparison_not_ready` | 409 | 比較表還沒好（drafting）或失敗了（failed） |
| `comparison_decided` | 409 | 已經決定過 |
| `invalid_comparison` | 422 | 比較的支線或選擇不合格（訊息說明原因） |

**跨對話記憶（B10 階段 C）**

| code | HTTP | 說明 |
|---|---|---|
| `memory_not_found` | 404 | 沒有這筆記憶（或不是這個租戶的） |
| `memo_not_found` | 404 | 沒有這則備忘（或不是這個租戶的） |
| `memo_limit` | 409 | 這棵樹的備忘已達上限；extra `limit` |
| `term_not_found` | 404 | 沒有這個名詞（或不是這個租戶的；B24） |
| `term_limit` | 409 | 這棵樹的名詞表已達上限；extra `limit` |
| `term_exists` | 409 | 這棵樹已經有這個名詞（`termKey` 相同）；extra `term` 是已有的那筆，`POST` 帶 `replace: true` 可覆寫 |
| `import_batch_not_found` | 404 | 沒有這個匯入批次（或不是這個租戶的；B25） |
| `memory_superseded` | 409 | 記憶已被取代（只能讀，不能再改或取代） |
| `invalid_memory` | 422 | 記憶不合格（種類、空白、重要性；訊息說明原因） |
| `embedder_unavailable` | 503 | 宿主的 Embedder 失敗（原因只記在伺服器 log）：`POST /memories`、`POST /memories/{mid}/supersede`、`POST /memories/search` 與接受記憶建議需要向量，可以稍後重試；每一輪的召回與 merge 不受影響（只是不帶記憶）。樣本 [route.error.embedder_unavailable.json](../httpapi/testdata/contract/route.error.embedder_unavailable.json) |

建議匣找不到建議也是 `suggestion_not_found`（404，見「開支線」）。

**一般**

| code | HTTP | 說明 |
|---|---|---|
| `line_not_found` | 404 | 沒有這條線（或不是這個租戶的） |
| `branch_not_found` | 404 | 不是支線 |
| `job_not_found` | 404 | 沒有這個 job（執行端用） |
| `job_not_pending` | 409 | job 已結束、逾時或被取代（執行端用） |
| `invalid_input` | 400 | 參數或本文不合格 |
| `too_long` | 422 | 欄位太長；extra `field`、`max` |
| `model_not_allowed` | 422 | 宿主不允許這個 provider / model |
| `feature_disabled` | 404 | 功能對這個租戶關閉；extra `feature` |
| `unauthorized` | 401 | `Config.Scope` 拒絕 |
| `forbidden` | 403 | `Config.CanWrite` 拒絕寫入 |
| `payload_too_large` | 413 | 本文超過 `MaxBodyBytes` |
| `unsupported_media_type` | 415 | 有本文的請求不是 `application/json` |
| `not_found` | 404 | 沒有這條路由（含沒設定的功能路由） |
| `unavailable` | 503 | Dispatcher 拒收、SSE 連線已滿 |
| `internal` | 500 | 其他錯誤；細節只寫進 log |

**參考伺服器另外的碼**（`cmd/tangent-server` 的閘道，不在 `httpapi`）：`rate_limited` 429（帶 `Retry-After`），
樣本 [route.error.rate_limited.json](../httpapi/testdata/contract/route.error.rate_limited.json)；它的 401 另帶
`WWW-Authenticate`，樣本 [route.error.unauthorized.json](../httpapi/testdata/contract/route.error.unauthorized.json)。
其他錯誤樣本：[route.error.forbidden.json](../httpapi/testdata/contract/route.error.forbidden.json)、
[route.error.too_long.json](../httpapi/testdata/contract/route.error.too_long.json)、
[route.error.unsupported_media_type.json](../httpapi/testdata/contract/route.error.unsupported_media_type.json)。

## 事件

Engine 只在交易 commit 之後發事件，交給宿主的 `Publisher`；`httpapi.Hub` 是一個 `Publisher`，把事件依租戶送到 `/events`。
信封：`{type, tenant, rootLineId, lineId, data}`。下列每個 `type` 的 `data`：

### `line.created`

`LineView`（新的主線或支線）。樣本：[event.line.created.json](../httpapi/testdata/contract/event.line.created.json)。

### `line.updated`

`LineView`（標題、狀態、未讀、用量、封存……有變）。樣本：[event.line.updated.json](../httpapi/testdata/contract/event.line.updated.json)。

### `line.deleted`

`{rootLineId, lineIds[]}`：整棵樹刪除（`rootLineId` 是被刪的主線，`lineIds` 第一個也是它）；或樹還在、只刪掉其中幾條線（順口問過期被清、
接著問取代了順口問、[`DELETE /branch`](#delete-linesidbranch)，B23）：`rootLineId` 是還在的主線，信封的 `lineId` 與 `lineIds` 第一個是被刪的那條支線，之後是它底下的線。樣本：[event.line.deleted.json](../httpapi/testdata/contract/event.line.deleted.json)。

### `message.created`

`Message`（使用者訊息、pending 回覆、卡片、標記、宿主系統訊息（回合完成時的通知緊接在回覆的 `message.updated` 之後））。樣本：[event.message.created.json](../httpapi/testdata/contract/event.message.created.json)。

### `message.updated`

`Message`（回合完成或失敗、取消、卡片送達、釘選或取消釘選、論證類型寫入或刪除（B10，使用者的或 AI 的））。樣本：[event.message.updated.json](../httpapi/testdata/contract/event.message.updated.json)。

### `message.delta`

`{turnId, seq, kind, text}`：進行中回合的一段串流。`[BRANCH-SUGGEST]` 標記行不會出現在 delta 裡。依讀者過濾見 [`GET /events`](#get-events)。
樣本：[event.message.delta.json](../httpapi/testdata/contract/event.message.delta.json)。

### `branch.changed`

`{change, branch: BranchView}`。`change` 的值：

| change | 時機 |
|---|---|
| `created` | 開了新支線 |
| `moved` | 訊息搬成新支線；被改掛到別處的支線也發 |
| `promoted` | 支線升為主線（同時對新的 `previous_main_line` 支線發 `created`、對改掛的子支線發 `moved`） |
| `draft` | 草稿狀態改變（開始、就緒、失敗、逾時） |
| `merged` | 帶著結論卡返回；已帶回的支線再出現一次 = 結論卡被編輯（`PATCH /branch/card`，B17，同時有卡片的 `message.updated`） |
| `discarded` | 放棄 |
| `renamed` | 改了目的 |
| `detached` | 支線獨立成新主線（`branch` 是它原本的樣子；之後子孫各發一個 `moved`，`rootLineId` 已是新主線） |
| `kept` | 順口問被保留或取消保留（B23；`branch.keptAt` 有值 = 保留，沒有這個欄位 = 取消） |

樣本：[created](../httpapi/testdata/contract/event.branch.changed.created.json)、[moved](../httpapi/testdata/contract/event.branch.changed.moved.json)、
[promoted](../httpapi/testdata/contract/event.branch.changed.promoted.json)、[draft](../httpapi/testdata/contract/event.branch.changed.draft.json)、
[merged](../httpapi/testdata/contract/event.branch.changed.merged.json)、[discarded](../httpapi/testdata/contract/event.branch.changed.discarded.json)、
[renamed](../httpapi/testdata/contract/event.branch.changed.renamed.json)、[detached](../httpapi/testdata/contract/event.branch.changed.detached.json)、
[kept](../httpapi/testdata/contract/event.branch.changed.kept.json)。

### `notes.changed`

`{rootLineId, revision}`；重新讀 `/notes`。樣本：[event.notes.changed.json](../httpapi/testdata/contract/event.notes.changed.json)。

### `chapters.changed`

`{rootLineId}`；重新讀 `/chapters`。樣本：[event.chapters.changed.json](../httpapi/testdata/contract/event.chapters.changed.json)。

### `turn.retrying`

`{turnId, attempt, maxAttempts, nextRetryAt}`：runner 遇到 429 / 5xx，會在 `nextRetryAt` 重試。
樣本：[event.turn.retrying.json](../httpapi/testdata/contract/event.turn.retrying.json)。

### `suggestion.changed`

`{rootLineId, suggestion: Suggestion}`：建議提出、接受、拒絕或過期；之後一個主線的 `line.updated`（`openSuggestions` 變了）。
樣本：[event.suggestion.changed.json](../httpapi/testdata/contract/event.suggestion.changed.json)。

### `leaf.changed`

`{lineId, rootLineId, leaf: Leaf | null, draftError?}`（刪除時 `null`）：收尾寫入（merge、放棄、PUT、草稿完成）或刪除。merge / 放棄時排在 `branch.changed` 之後。`leaf_draft` 失敗（執行失敗、輸出不能用、逾時）時也發一次：`leaf` 是目前的收尾（可能 `null`），`draftError = {code, message}`。
樣本：[event.leaf.changed.json](../httpapi/testdata/contract/event.leaf.changed.json)、[event.leaf.changed.draft_error.json](../httpapi/testdata/contract/event.leaf.changed.draft_error.json)（失敗）。

### `seeds.changed`

`{rootLineId}`：種子新增、展開、記進紀要或丟掉；重新讀 `/seeds`。之後一個主線的 `line.updated`（`openSeeds`）。
樣本：[event.seeds.changed.json](../httpapi/testdata/contract/event.seeds.changed.json)。

### `link.changed`

`{rootLineId, link: Link, deleted?}`：新增了連結（spinoff、關聯）、改了關聯的說明，或刪除了關聯（`deleted: true`）；對兩棵樹各發一次（`rootLineId` 不同；同一棵樹裡的關聯只發一次）。spinoff 另發新主線的 `line.created`、標記的 `message.created`、
來源線（與原主線）的 `line.updated`，detach 再發 `branch.changed{detached}` 與子孫的 `moved`，有搬到種子時兩棵樹各一個 `seeds.changed`，被帶走成員而解散的群組各一個 `group.changed`（R8），`copyNotes` 時新樹的 `notes.changed`。
樣本：[event.link.changed.json](../httpapi/testdata/contract/event.link.changed.json)、[event.link.changed.deleted.json](../httpapi/testdata/contract/event.link.changed.deleted.json)（刪除關聯）。

### `goal.changed`

`{rootLineId, goal: Goal | null}`：目標寫入（PUT、接受提案、auto 模式的提案）或刪除（`null`）。樣本：[event.goal.changed.json](../httpapi/testdata/contract/event.goal.changed.json)。

### `group.changed`

`{rootLineId, group: Group}`：群組建立、改名、解散、開始摘要、摘要完成或失敗。樣本：[event.group.changed.json](../httpapi/testdata/contract/event.group.changed.json)。

### `job.failed`

`{jobId, kind, lineId, rootLineId, error: {code, message}}`：功能的背景 job 失敗（`code`：`run_failed` 執行失敗 / `unusable` 輸出不能用 / `timed_out` 逾時 / `failed` 其他），
而且沒有別的管道通知：`goal_propose`、`drift_check`、`relation_suggest`、`group_summary`、`group_suggest`、`ibis_tag`、`fold_summary`（另發 `fold.changed`）、`fold_suggest`、`diverge`（開不了支線時 `code: failed`、`message` 是原因）、`converge`（另發 `comparison.changed`）、`memory_extract`、`memory_consolidate`。收尾的草稿照舊用 `leaf.changed` 的 `draftError`；結論卡草稿照舊在 `branch.changed{draft}`。
樣本：[event.job.failed.json](../httpapi/testdata/contract/event.job.failed.json)。

### `fold.changed`

`{lineId, rootLineId, fold: Fold}`：折疊建立、摘要寫好或失敗、跟著訊息搬到別的線（`lineId` 是新的線）、被拆開或收回（`status: removed`）。
樣本：[event.fold.changed.json](../httpapi/testdata/contract/event.fold.changed.json)。

### `comparison.changed`

`{rootLineId, comparison: Comparison}`：比較建立（drafting）、比較表寫好（ready）或失敗（failed）、決定（decided）。`lineId` 是父線。
樣本：[event.comparison.changed.json](../httpapi/testdata/contract/event.comparison.changed.json)。

### `memory.changed`

`{memory: Memory, superseded: Memory[]}`：記憶寫入、改歸類或取代（`superseded` 是被取代的）。記憶屬於租戶：信封的 `rootLineId`、`lineId` 是空字串。
樣本：[event.memory.changed.json](../httpapi/testdata/contract/event.memory.changed.json)。

### `memo.changed`

`{rootLineId, memoId, change: created | updated | deleted}`：備忘新增、修改或刪除；重新讀 `/memos`。信封的 `lineId` 是備忘的節點（節點已不存在時為空）。
樣本：[event.memo.changed.json](../httpapi/testdata/contract/event.memo.changed.json)。

### `terms.changed`

`{rootLineId, termId, change: created | updated | deleted}`：名詞表的一筆新增、修改（含 `replace` 覆寫）或刪除（B24）；重新讀 `/terms`。
信封的 `lineId` 是名詞的來源線（已不存在時為空）。樹搬動（detach、attach）不發這個事件（同備忘）。
樣本：[event.terms.changed.json](../httpapi/testdata/contract/event.terms.changed.json)。

### `summary.due`

`{lineId, rootLineId}`：`summary` 在 suggest 模式下，這條線未摘要的歷史超過門檻（每一輪成功完成後檢查，還是超過就再發）。前端可以提示「整理摘要」（`POST /lines/{id}/compact`）；
摘要存好後 `line.updated` 的 `summary` 會更新。manual / auto 模式不發（auto 直接開始摘要）。樣本：[event.summary.due.json](../httpapi/testdata/contract/event.summary.due.json)。

### `stream.lagged`

只由 `httpapi.Hub` 送出（不經過 `Publisher`）：這個客戶端讀太慢，掉了 `{dropped}` 個事件，請重新讀取畫面上的資料。
持續落後超過 30 秒（`WithMaxLag`）就斷線。樣本：[event.stream.lagged.json](../httpapi/testdata/contract/event.stream.lagged.json)。
