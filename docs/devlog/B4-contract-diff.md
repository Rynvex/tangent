# B4 · 前端暫定型別 vs 實際契約（給 F1）

> 2026-10-15。比較對象：`web/packages/client/src/api-types.ts`、`types.ts`、`events.ts`、`capabilities.ts`、`errors.ts`（W0 / F0 的暫定版）
> 與 B4 的 httpapi。**實際契約的唯一來源是 `httpapi/testdata/contract/*.json`**（47 檔，`go test ./httpapi -update` 重新產生）；
> 路由表與錯誤碼表見 `docs/devlog/B4-api.md`。下表只列「前端需要改」或「前端可以開始用」的地方；沒列的就是一致。

## 樣本怎麼用

- `route.<name>.json`：`{method, path, status, request?, response?}`；`event.<type>[.<change>].json`：SSE `data:` 的完整 envelope `{type, tenant, rootLineId, lineId, data}`。
- 佔位值：UUID → `00000000-0000-4000-8000-00000000000N`（同檔依出現順序）、時間 → `2026-01-01T00:00:00Z`、`durationMs` → 42、delta seq → 1000 起、`nextCursor` → `"CURSOR"`。
- 建議 F1 的契約測試：每個 `route.*.json` 的 `response` 丟進對應的 normalizer，斷言「正規化前後欄位集合相同、值相同」（樣本是 Go 實際輸出，不該被補值或丟欄位）。

## 請求（前端送出的 body）

| 路由 | 前端現況 | 實際 | 要改 |
|---|---|---|---|
| `POST /lines` | `CreateLineInput.hostMeta?` | 客戶端送 `hostMeta` → **400 `invalid_input`** | 從 `CreateLineInput` 拿掉 `hostMeta` |
| `POST /lines/{id}/messages` | `SendMessageInput.hostMeta?` | 同上 400 | 拿掉 `hostMeta` |
| `PATCH /lines/{id}` | 可送空物件 | 至少要 `title`、`provider`、`model` 其中之一，否則 400 | 送出前檢查 |
| `POST /lines/{id}/branch/promote` | 不送 body | **必須** `{"confirm": true}`，否則 400 `invalid_input` | `promoteBranch` 送 `{confirm: true}` |
| `POST /lines/{id}/branch/merge` | `card: Partial<BranchCard>` | 卡片嚴格解碼：未知或重複欄位 → 422 `invalid_card`，`problems[0].field = "card"` | `buildMergeBody` 已省略空欄位，維持即可；不要多送欄位 |
| `POST /lines/{id}/preview` | `{content}` | 同；`content` 可省略（空字串） | — |

## 回應

| 路由 | 前端暫定 | 實際（見樣本） | 要改 |
|---|---|---|---|
| `DELETE /lines/{id}` | void | 200 `{rootLineId, lineIds}` | 可忽略；也可用 `lineIds` 清 cache |
| `POST /archive`、`/unarchive` | void | 200 `{lines: LineView[]}`（主線在前，其餘順序不定） | 可忽略或直接寫入 cache |
| `POST /read` | void | 200 `LineView` | 同上 |
| `POST /cancel` | void | 200 `{cancelled, line: LineView, message: Message \| null}` | 同上 |
| `GET /stream` | `{deltas}` | `{deltas, seq, truncated}` | 加 `seq`、`truncated`；`truncated: true` 時重新讀訊息（DESIGN §12） |
| `POST /compact`、`/branch/draft` | `{jobId}` | 202 `{jobId, kind, lineId}` | 加 `kind`、`lineId`（可選用） |
| `POST /preview` | `{prompt, tokenEstimate}` | `{prompt, blocks: [{key, role?, content, tokens}], totalTokens, provider, model, estimatedCostUsd?}` | **改名** `tokenEstimate` → `totalTokens`；新增 `PreviewBlock`、`blocks`、`provider`、`model`、`estimatedCostUsd`（只在伺服器有該 model 的價格時出現；只算輸入） |
| `POST /branches/move` | `MoveBranchResult extends CreateBranchResult`（含 `pack`） | `{line, branch, marker, sourceLineId, rootLineId, movedMessageIds, reparented, summaryReset}`，**沒有 `pack`** | 不要繼承 `CreateBranchResult`；需要背景包時 `GET /branch` |
| `POST /branch/merge` | `notes?: {revision, created, superseded}` | `notes` 只在送了 `noteChanges` 時出現，形狀 `{rootLineId, revision, created, superseded}` | 加 `rootLineId` |
| `POST /branch/promote` | `{branch, previousMainLine, line, reparented}` | 相同；`branch.status` 是 `promoted`，`line` 是主線（id 不變） | — |
| `POST /notes`、`PATCH /notes/{nid}`、`POST /supersede` | `{note, superseded?, revision}` | 另有 `rootLineId` | 可加 |
| `POST /chapters/milestones` | 回傳**單一 milestone** | 201 `{milestone, rootLineId}`（同 宿主） | `addMilestone` 改讀 `body.milestone` |
| `GET /capabilities` | `{features: [{name, enabled, mode?}]}` | 相同；`card_draft` 沒有 `mode`，`summary`、`branch_suggest` 永遠有 `mode`（關閉時 `"off"`） | — |
| 其餘（`GET /lines`、`/messages`、`/branches`、`/branch`、`/notes`、`/chapters`、`POST /lines`、`/branches`、`/discard`、202 `/messages`） | | 與暫定型別一致 | — |

## 型別（`types.ts`）

| 型別 | 要改 |
|---|---|
| `LineView` | 加 `awaitingReview: number`（底下 open 且結論卡草稿 `ready` 的支線數，不含自己；「等你」= `unread + branchUnread > 0 \|\| awaitingReview > 0`）。`usage` 已存在、**一定有**（不再是 PROVISIONAL）；它實際在 `Line` 上，所以 `Line` 也可以加 |
| `Usage` | 加 `cacheReadTokens?`、`cacheWriteTokens?`（只出現在訊息的 `meta.usage`，0 時省略；`inputTokens` 已含這兩者）。線的 `usage` 只有三個總數 |
| `MessageMeta` | 加 `actor?: string`（開始這一輪的人，在 assistant 訊息上） |
| `Prompt` | 加 `trailing?: PromptSection[]`（B3 起就有：摘要之後的區塊，例如結論卡通知；空時省略） |
| `Milestone` | 與 Go `ChapterCut` 相同（`id, messageId, kind, title, createdBy, createdAt`） |

## 事件（`events.ts`）

- envelope 與 SSE event 名稱 = `type`：一致。`turn.retrying` 欄位一致（`event.turn.retrying.json`）。
- 串流會有註解行 `: connected`、`: keepalive`（每 25 秒），解析器已忽略註解。
- 伺服器關機時串流結束；重連得到 503 `unavailable` 時照原本的退避重試。
- 慢客戶端可能**漏事件**（伺服器丟最舊的）：重連（`onReconnect`）時重抓，或 `/stream` 回 `truncated` 時重抓。

## 錯誤碼與 HTTP 狀態（`errors.ts`）

- 新的 httpapi 碼（不在 `domain/errors.go`，請放在像 `CLIENT_ERROR_CODES` 的另一份清單，防漂移測試不受影響）：
  `unauthorized`（401）、`forbidden`（403，`CanWrite` 拒絕寫入）、`payload_too_large`（413，**現在有 envelope**）、`not_found`（404，沒有這個路由，含沒開的功能路由）、
  `unavailable`（503，工作無法交給 dispatcher / 事件串流已關）、`internal`（500）。參考伺服器另有 `rate_limited`（429，帶 `Retry-After`）。
- `feature_disabled` 是 **404**，extra `feature`（功能名）。
- 狀態對照：S1 devlog 的表照用；`job_not_found` 404、`job_not_pending` / `concurrent_change` / `id_unavailable` 409。宿主自訂碼預設 409。
- path id 不是 UUID 時回該資源的 404 碼（`line_not_found`、`note_not_found`、`milestone_not_found`）。
- W0 的問題「`CanWrite` 拒絕時回什麼 code」→ 403 `forbidden`。「413 沒有 envelope」→ 現在有。

## 唯讀身分

`CanWrite` = false 時所有 POST / PATCH / DELETE 回 403 `forbidden`，**除了** `POST /preview`（不寫入，可用）。GET 與 `/events` 都可用。

---

# B4.1 增補（2026-10-15）

## 新路由

| 路由 | 說明 |
|---|---|
| `POST /lines/{id}/retry` | 沒有 body。202 `{turnId, userMessage, pendingMessage}`（`userMessage` 是原本那則，不會重複）。最後一輪沒失敗 → 409 `nothing_to_retry`；有 pending → 409 `turn_pending`。失敗的回覆留在列表（`status: "error"`），新的 pending 回覆接在後面 |

## 回應變動

| 路由 / 型別 | 變動 |
|---|---|
| `GET /capabilities` | 加 `permissions: {canWrite: boolean}`（`route.capabilities.viewer` 是 `false`）。唯讀身分據此隱藏寫入 UI |
| `POST /lines` | 沒指定 provider / model 時，回應的 `provider` / `model` 是伺服器預設（不再是空字串） |
| 失敗的回覆 | `meta` 有 `provider`、`model`、`error`，runner 跑過時也有 `durationMs`（dispatcher 拒絕、逾時等沒跑完的情況可能沒有）；`content` 是失敗說明 |
| pending 的回覆 | `content` 一律 `""`；串流文字只在 `/stream` 與 `message.delta` |

## 新事件

- `stream.lagged`：`data: {dropped: number}`，`rootLineId` / `lineId` 是空字串。收到時重抓目前顯示的資料（等同重連）。客戶端如果長時間（30 秒）一直落後，伺服器會斷線，照原本的退避重連即可。

## 請求

- **寫入請求的 `Content-Type`**：有 body 就必須是 `application/json`（`createTangentClient` 已經這樣做）；沒有 body 時不要送其他 `Content-Type`。否則 415 `unsupported_media_type`。
- JSON body 後面不能有任何多餘內容（400）。
- 長度上限：`title` 200 字、`provider` / `model` 100 字、訊息 `content` 32000 字（可由宿主調整）→ 422 `too_long`，extra `{field, max}`。表單可以先用這些值檢查。
- 模型白名單：選了伺服器不允許的 provider / model → 422 `model_not_allowed`，extra `{provider, model}`。

## 新錯誤碼

| Code | HTTP | Extra |
|---|---|---|
| `too_long` | 422 | `field`, `max` |
| `model_not_allowed` | 422 | `provider`, `model` |
| `nothing_to_retry` | 409 | |
| `unsupported_media_type` | 415 | |
| `unavailable` | 503 | （新情況：dispatcher 佇列或租戶上限已滿；`/events` 連線數已滿） |
| `forbidden` | 403 | （參考伺服器：沒有 token 的 dev 模式下 Host 不是 localhost） |
| `rate_limited` | 429 + `Retry-After` | （參考伺服器：位址、token、認證失敗三種額度） |

`too_long`、`model_not_allowed`、`nothing_to_retry` 是 domain 碼（`domain/errors.go`，前端的防漂移清單要加）；`unsupported_media_type` 是 httpapi 碼。

## 樣本

新增 20 個（共 67 個），清單見 `B4-api.md`「B4.1 / 契約樣本」。建議前端的契約測試：(1) 斷言清單裡每個檔都存在；(2) `*.rich` 樣本正規化後每個欄位值不變（它們都不是零值，欄位改名會被抓到）；
(3) `route.server.*` 的 `headers` 欄位是回應標頭（`Retry-After` 秒數、`WWW-Authenticate`）。

---

# B4.2 增補

- **`message.delta` / `/stream` 不再有協定標記行**（`[BRANCH-SUGGEST]…` 等）：前端不用再自己藏。串流全文 = 完成後存的 `content`。行尾空白與換行會延到下一段文字一起到（結尾的不會到）。
- **pending 回覆的 `content`** 會定期（約每 2 秒或 8 KB）存成已串流的部分，`meta.streamSeq` 是它涵蓋到的 delta seq。重新載入時：先顯示 `content`，再接 `/stream?afterSeq=<streamSeq>`（或 `message.delta` 中 seq > streamSeq 的）。沒有 `streamSeq` 時從 0 開始。完成或取消後 `streamSeq` 不再出現。存部分內容時**不會**發 `message.updated`。
- `MessageMeta` 加 `streamSeq?: number`。
- 錯誤樣本改名：`route.error.rate_limited`、`route.error.unauthorized`（原本的 `route.server.*` 已刪）。

---

# B5 增補（2026-10-16）

> 後端 B5：搜尋、F2 契約缺口、效能與穩定性。樣本仍以 `httpapi/testdata/contract/` 為準（`go test ./httpapi -update`），共 **71** 檔（+4）。
> 細節見 `docs/devlog/B5-search-perf.md`。下面只列前端要知道的。

## 新路由

| 路由 | 請求 | 回應 | 樣本 |
|---|---|---|---|
| `GET /search?q=&limit=&archived=` | `q` 2–200 字（前後空白去掉）；`limit` 1–50（預設 20）；`archived=true` 只搜封存的對話（同 `/lines`，預設只搜進行中的） | 200 `{query, hits: SearchHit[]}` | `route.search` |
| `POST /lines/{id}/branches/preview` | 同 `POST /branches`：`anchorMessageId`、`kind`、`excerpt?`、`purpose?`（**可以空**，對話框還沒填目的時也能預覽）、`includeLater?`；`provider` / `model` / `confirmDeeper` / `suggestionMessageId` 不影響結果；`hostMeta` → 400 | 200 `{pack: BranchPack, text, tokenEstimate}`（`text` = `pack.rendered`，`tokenEstimate` = `pack.tokenEstimate`），**不寫入** | `route.branches.preview` |
| `PATCH /lines/{id}/branch` | `{purpose}`（必填） | 200 `{branch: BranchView}` | `route.branch.rename` |

- `/search` 是功能 `search` 的路由：伺服器沒開 → 404 `not_found`；政策對這個租戶關掉 → 404 `feature_disabled`（extra `feature: "search"`）。
  唯讀身分可以搜尋。錯誤：`q` 少於 2 字 → 400 `invalid_input`；超過 200 字 → 422 `too_long`（`field: "q"`, `max: 200`）；`limit` 不在 1–50、`archived` 不是布林 → 400 `invalid_input`。
- `/branches/preview` 唯讀身分可以呼叫（同 `/preview`）。錯誤同建立支線的輸入部分：`anchor_not_found` 404（分岔點不是父線上完成的 user / assistant 訊息，含結論卡）、
  `kind_unsupported` 400、目的太長 400 `invalid_input`、`aside` 而 `aside` 功能關閉 404 `feature_disabled`、`line_not_found` 404。**深度、每線 8 條、每棵 200 條的上限不檢查**（只有真的建立時才檢查）。
- `PATCH /branch`：只限進行中的支線。`purpose` 缺少、空白或超過 200 字 → 400 `invalid_input`；已結束 → 409 `branch_closed`；封存中 → 409 `archived`；主線或別的租戶 → 404 `branch_not_found`；唯讀 → 403。
  支線線的 `title` 跟著改（`line.updated`）。背景包（`pack.purpose`、`pack.rendered`）**不變**：它是開支線當下的快照。

### `SearchHit`

```ts
interface SearchHit {
  lineId: string;          // 命中所在的線（主線或支線）
  rootLineId: string;      // 所屬對話
  kind: "title" | "purpose" | "message";
  messageId?: string;      // 只有 message
  seq?: number;            // 只有 message
  role?: "user" | "assistant"; // 只有 message
  snippet: string;         // 純文字（不是 HTML）；以第一個命中處為中心約 120 字，被截斷的一端有「…」；換行與 tab 變成空白
  highlights: { start: number; end: number }[]; // snippet 裡每個命中（不分大小寫），UTF-16 offset，end 不含；可能是 []
  score: number;           // 0..1，相似度
  rootTitle: string;       // 對話標題
  purpose: string;         // 命中所在支線的目的；主線 ""
  at: string;              // 時間：訊息的建立時間，或線的最後活動時間
}
```

- 排序已經排好：相似度高的在前，相同時新的在前。`title` 只搜主線標題（支線的標題就是目的，用 `purpose` 命中）。訊息只搜 `done` 的 user / assistant 聊天訊息（不含結論卡、標記、進行中或失敗的回覆）。
- `highlights` 用 UTF-16 offset，`snippet.slice(start, end)` 就是命中文字（emoji 之類佔 2）。

## 回應變動

| 路由 / 型別 | 變動 |
|---|---|
| `GET /capabilities` | `features` 多一項 `{name: "search", enabled}`（沒有 `mode`，排最後）；新增 **`models: [{provider, models: string[]}]`**（一定有，沒有時 `[]`）。參考伺服器：預設 provider 在前；有 `TANGENT_ALLOWED_MODELS` 就列它（只列有 runner 的 provider），否則列已設定的模型（含 `TANGENT_JOB_MODEL`）；fake 是 `["fake-1"]`（fake 其實接受任何名稱） |
| `POST /branch/draft`、`POST /compact`（202） | 加 `provider`、`model`：這個 job 會用的（功能的 `JobModel` / `TANGENT_JOB_MODEL`，否則該線的）。線沒有 provider 時可能是空字串（實際由伺服器預設決定） |
| `BranchDraft`（`GET /branch` 的 `draft`） | 加 **`noteChanges: NoteChange[]`**（一定有；只有 `status: "ready"` 且 `notes` 開啟時可能非空）。形狀與 merge 的 `noteChanges` 完全相同：`{op: "add" \| "supersede", noteId?, section?, text, sourceLineId, sourceMessageId?}`，`sourceLineId` 一律是這條支線。伺服器已經用 merge 的規則檢查過（不存在或已被取代的 `noteId`、壞的 `op` / `section`、空白或太長、重複的都丟掉，丟掉的寫在 `draft.warnings`），所以前端勾選後**原樣**放進 merge 的 `noteChanges` 即可 |
| `GET /lines/{id}/notes` 的 `limits` | 加 **`tokenBudget`**（預設 2000）：一輪 prompt 的紀要區塊上限。超過時先略掉最舊的「待確認」，再「待辦」，再「事實」，「已決定」永遠保留（`domain.BuildNotesBlock`，token 用 `EstimatePackTokens` 估） |
| 參考伺服器、fake provider 的新主線 | 沒指定 model 時填 fake 的預設 **`fake-1`**（以前是空字串，所以沒有估價）。其他 provider 原本就填伺服器預設 |
| 事件 `branch.changed` | 新的 `change: "renamed"`（`PATCH /branch`），隨後一個該支線線的 `line.updated` |
| 結論卡送達 | 父線某一輪成功完成、把卡片標成送達時，**對卡片訊息本身**發 `message.updated`（`kind: "branch_card"`、`meta.delivered: true`），順序在回覆的 `message.updated` 之後、`line.updated` 之前；每張卡只發一次。前端現在依回覆 `meta.deliversCards` 自己標記的做法可以保留，或改用這個事件 |

## 樣本

新增：`route.search`、`route.branches.preview`、`route.branch.rename`、`event.branch.changed.renamed`。
有變動：`route.notes.list`、`route.notes.list.rich`（`limits.tokenBudget`）、`route.capabilities`、`route.capabilities.viewer`（search、models）、`route.branch.draft`、`route.compact`（provider / model）、`route.branch.get`、`route.branch.get.ready`（`noteChanges`；fake runner 的草稿在 `notes` 開啟時提一個「已決定」的紀要）、
以及因為流程裡多了改名而變動標題 / token 的 `route.branch.merge`、`route.branch.promote`、`route.branches.list`、`route.cancel`、`route.lines.archive` / `unarchive` / `read`、`event.branch.changed.draft` / `merged`。

## 錯誤碼

沒有新的錯誤碼（搜尋用既有的 `invalid_input`、`too_long`、`feature_disabled`、`not_found`）。

## fake runner（e2e 用）

- 結論卡草稿的 prompt 有要求紀要提案時（`notes` 開啟），回覆帶一個 `noteChanges`（add / decided）。
- 新指令：`[fake:wait=250ms]`（先等，最多 30 秒）、`[fake:job-error]`（出現在 job 的 prompt 裡時，例如支線訊息含這段文字，起草或摘要就失敗）。

# B8 增補（階段 A，2026-10-16）

> 後端 B8 階段 A：建議匣、`leaf` 收尾、`parking` 停車場、紀要 `sourceLabel`。樣本仍以 `httpapi/testdata/contract/` 為準（`go test ./httpapi -update`），共 **94** 檔（+23）。
> 細節見 `docs/devlog/B8-p1.md`；每條路由的說明也在 `docs/API.md`。階段 B（`spinoff`、`rebalance`）之後再補。

## 新路由

| 路由 | 功能 | 請求 | 回應 | 樣本 |
|---|---|---|---|---|
| `GET /lines/{id}/suggestions?status=` | `suggestions` | `status` 逗號分隔或 `all`，預設 `open` | 200 `{rootLineId, suggestions: Suggestion[]}`（整棵樹，新的在前，≤ 200） | `route.suggestions.list`、`.list.all` |
| `POST /suggestions/{sid}/accept` | `suggestions` | 依建議種類（可省略；階段 B 的樹平衡是 `{action: "promote" \| "spinoff"}`） | 200 `{suggestion, result?}` | `route.suggestions.accept` |
| `POST /suggestions/{sid}/dismiss` | `suggestions` | — | 200 `{suggestion}` | `route.suggestions.dismiss` |
| `GET /lines/{id}/leaf` | `leaf` | — | 200 `{leaf: Leaf \| null}` | `route.leaf.get`、`route.leaf.get.none` |
| `PUT /lines/{id}/leaf` | `leaf` | `{kind, line, body?}`（必填） | 200 `{leaf}`（`confirmed`、`aiDrafted: false`） | `route.leaf.put` |
| `DELETE /lines/{id}/leaf` | `leaf` | — | 204 | `route.leaf.delete` |
| `POST /lines/{id}/leaf/draft` | `leaf` | — | 202 `{jobId, kind: "leaf_draft", lineId, provider, model}` | `route.leaf.draft` |
| `GET /lines/{id}/seeds?status=` | `parking` | 同 suggestions | 200 `{rootLineId, seeds: Seed[]}` | `route.seeds.list`、`.list.all` |
| `POST /lines/{id}/seeds` | `parking` | `{text, anchorMessageId?}` | 201 `{seed}` | `route.seeds.create` |
| `POST /seeds/{sid}/expand` | `parking` | `{purpose?, kind?, confirmDeeper?}`（可省略） | 201 `{seed, line, branch, pack}`（同建立支線，`branch.origin: "seed"`） | `route.seeds.expand` |
| `POST /seeds/{sid}/to-note` | `parking` + `notes` | `{section?}`（預設 `to_confirm`） | 201 `{seed, note, revision, rootLineId}` | `route.seeds.to_note` |
| `POST /seeds/{sid}/drop` | `parking` | — | 200 `{seed}` | `route.seeds.drop` |

- 功能路由的規則照舊：伺服器沒設定 → 404 `not_found`；政策關掉 → 404 `feature_disabled{feature}`。建議匣的 `feature` 是 `"suggestions"`；`to-note` 在 `notes` 關閉時回 `feature: "notes"`。
- 唯讀身分可以呼叫三個 GET。別的租戶的種子 / 建議 → `seed_not_found` / `suggestion_not_found`（404）。
- **`POST /lines/{id}/branch/discard` 可以帶本文** `{"leaf": {kind?, line, body?}}`：同一交易寫入收尾（`kind` 預設 `dead_end`）。`leaf` 關閉時帶 `leaf` → 404 `feature_disabled{feature:"leaf"}`；
  不帶本文照舊。樣本 `route.branch.discard.leaf`。

### 型別

```ts
interface Suggestion {
  id: string; rootLineId: string;
  lineId: string;            // 建議所關於的線；那條支線結束（merge / discard / promote）時變 expired
  feature: string; kind: string; targetKey: string;   // 例如 "line:<id>"、階段 B 的 "branch:<id>"
  payload: Record<string, unknown>;                   // 功能自己的內容
  status: "open" | "accepted" | "dismissed" | "expired";
  createdAt: string; decidedAt: string | null;
}
interface Leaf {
  lineId: string; rootLineId: string;
  kind: "conclusion" | "decision" | "answer" | "dead_end" | "to_continue";
  line: string;              // ≤ 200 字，一行
  body: string;              // ≤ 4000 字，可多行，可能是 ""
  status: "draft" | "confirmed";
  aiDrafted: boolean;        // AI 寫的且使用者沒改過（auto 模式的 confirmed 也是 true）
  createdBy: string;         // AI 寫的為 ""
  createdAt: string; updatedAt: string;
}
interface Seed {
  id: string; rootLineId: string;
  anchorMessageId: string;   // 可能是 ""（在沒有訊息的線上停的）
  text: string;              // ≤ 500 字，一行
  status: "open" | "expanded" | "noted" | "dropped";
  expandedLineId: string; noteId: string;   // 沒有時 ""
  createdBy: string; createdAt: string; updatedAt: string;
}
```

## 回應變動

| 路由 / 型別 | 變動 |
|---|---|
| `GET /capabilities` | `features` 多三項（排在 `search` 之後）：`{name: "leaf", enabled, mode}`（有 mode）、`{name: "parking", enabled}`、`{name: "suggestions", enabled}`（建議匣：有會提建議的功能開著才 `enabled`；階段 A 只有測試用的 probe 會提，所以參考伺服器預設是 `false`） |
| `LineView` | 加 **`openSuggestions`**、**`openSeeds`**（這棵樹 open 的建議 / 種子數；**只在主線**，支線為 0；不管功能開關都照實計數，請依 `/capabilities` 決定要不要顯示）。「待處理」分頁用。樣本 `route.lines.get.inbox` |
| `BranchView` | 加 **`leaf: {kind, line, status} \| null`**（大綱、地圖用）。功能關閉時已存的收尾照樣帶出 |
| `BranchView.origin` | 多一個值 `"seed"`（由種子展開的支線） |
| `Note` | 加 **`sourceLabel?`**：寫入當下的來源文字快照，規則同 `note-source.ts`（`主線 #n`、`主線`、`查證・目的`、`順口問・目的`、`另一條路・目的`、`結論卡・目的`，前主線的標題是「原本的主線」）。預設繁中；宿主可用 `WithNoteSourceLabels` 換成英文或自訂。舊資料與沒有來源的紀要沒有這個欄位（前端退回現在的算法）。現在的 `noteSourceLink` 在來源支線找不到時已經會用它，不用改 |
| `POST /branch/merge`、`/discard` 的 `branch` | 會帶上同一交易寫入的 `leaf`（merge：由卡片產生的 `conclusion`） |

## 新事件

| type | data | 何時 | 樣本 |
|---|---|---|---|
| `suggestion.changed` | `{rootLineId, suggestion}` | 提出、接受、拒絕、過期；之後一個主線的 `line.updated` | `event.suggestion.changed` |
| `leaf.changed` | `{lineId, rootLineId, leaf \| null}` | merge（卡片的結論）、帶收尾的 discard、PUT、DELETE（`null`）、草稿 job 寫入；merge / discard 時排在 `branch.changed` 與 `line.updated` 之後 | `event.leaf.changed` |
| `seeds.changed` | `{rootLineId}` | 種子新增 / 展開 / 記進紀要 / 丟掉；之後一個主線的 `line.updated`（展開時另有 `line.created`、`branch.changed{created}`；記進紀要另有 `notes.changed`） | `event.seeds.changed` |

收尾改變時**不**另外發 `branch.changed`：請用 `leaf.changed` 更新快取裡那條支線的 `leaf`（`{kind, line, status}`）。

## 錯誤碼（新增，前端錯誤碼清單要補）

| code | HTTP | extra |
|---|---|---|
| `invalid_leaf` | 422 | `problems: [{field: "kind" \| "line" \| "body", message}]` |
| `leaf_not_found` | 404 | — |
| `seed_not_found` | 404 | — |
| `seed_not_open` | 409 | — |
| `seed_limit` | 409 | `limit`（預設 100） |
| `suggestion_not_open` | 409 | — |

樣本：`route.error.invalid_leaf`、`route.error.seed_not_open`、`route.error.suggestion_not_open`。種子的 anchor 不對 → 既有的 `anchor_not_found`（404）；種子文字空白 → `invalid_input`、超過 500 字 → `too_long{field:"text", max:500}`。

## 行為（給 F4）

- **建議匣**：同一對象同時最多一筆 open；拒絕後 7 天內不再提（有的種類永久不再提，例如階段 B 樹平衡的「維持」）；建議永遠不自動執行。支線結束時，關於它（merge / discard 時含它底下的線）的 open 建議變 `expired`（`suggestion.changed`）。
- **收尾**：`leaf` 的模式在 `/capabilities`。suggest / auto 下，沒帶收尾的 discard 與 promote 之後的「原本的主線」會自動起草（`leaf.changed`，suggest：`status: "draft"`，等使用者 PUT 確認；auto：`confirmed` + `aiDrafted`）。使用者 PUT 過的收尾不會被草稿覆蓋；merge 一律以卡片覆寫。答完自動結束的順口問不起草。主線沒有收尾（404 `branch_not_found`）。
- **種子**：展開時掛在 anchor 現在所在的線（訊息搬走會跟著走）；anchor 不見了掛在主線最新一則。展開失敗（上限、父線已關閉……）時種子不變，錯誤碼同建立支線。記進紀要的文字超過 400 字會被截（`…`）。
- 參考伺服器預設開 `leaf:suggest`、`parking`；要測建議匣用 `TANGENT_FEATURES=…,suggestion_probe`，送出含 `[probe:suggest]`（或 `[probe:suggest-permanent]`）的訊息就會產生一筆建議（fake runner 會回聲）。

## fake runner（e2e 用）

- `leaf_draft` job 回一個合法的收尾：`{kind: "conclusion", line: "The branch settled its question (fake runner).", body: "Drafted by the fake runner."}`。

# B8 增補（階段 B，2026-10-16）

> 後端 B8 階段 B：`spinoff`、`rebalance`，以及階段 A 的三個修正。樣本共 **101** 檔（+7）。細節見 `docs/devlog/B8-p1.md` 的「階段 B」；路由說明在 `docs/API.md`。

## 新路由

| 路由 | 功能 | 請求 | 回應 | 樣本 |
|---|---|---|---|---|
| `POST /lines/{id}/spinoff` | `spinoff` | `{mode: "detach" \| "fresh", atMessageId?（fresh 必填）, title?, copyNotes?}`（必填） | 201 `{mode, line: LineView（新主線）, sourceLineId, rootLineId（原樹）, marker: Message, link: Link, branch?（detach）, moved: string[], notes?（copyNotes）}` | `route.spinoff.detach`、`route.spinoff.fresh` |
| `GET /lines/{id}/links` | `spinoff` | — | 200 `{links: Link[]}`（這棵樹任一條線連出或連入的） | `route.links.list` |

- detach：`{id}` 必須是進行中的支線；它的 id 不變、變成主線（`conversationBranch: null`），子孫跟著搬到新樹（`rootLineId` 變成它、`depth` 減少）。原樹的大綱不再有它們。錯誤：`branch_closed`、`archived`、`branch_busy`（子樹有回合）、`source_busy`（父線有回合）、`branch_drafting`、`branch_not_found`（主線）。
- fresh：`atMessageId` 必須是 `{id}` 上完成的 user / assistant 訊息（`anchor_not_found`）；原樹不變。
- `mode` 不對 → 400 `invalid_input`；`title` 超過 200 字 → 422 `too_long`。

```ts
interface Link {
  id: string; kind: "spinoff" | "relation";
  fromLineId: string; fromMessageId: string;   // 來源線與分岔的訊息
  toLineId: string; toMessageId: string;       // spinoff 時 toMessageId 為 ""
  label: string; fromTitle: string; toTitle: string;
  createdBy: string; createdAt: string;
}
```

## 回應變動

| 路由 / 型別 | 變動 |
|---|---|
| `LineView` | 加 **`spunOffFrom: {lineId, messageId, title} \| null`**（spinoff 產生的主線指回來源；`title` 是當時的快照）。**`openSuggestions` 現在只算對這個請求開著的功能提出的**（與 `GET /suggestions` 一致） |
| `Message.meta` | spinoff 在來源線最後留一則 `kind: "branch_marker"`、`role: "system"` 的標記，`meta.spunOffTo = {lineId（新主線）, messageId（分岔的訊息）, title}`；用它顯示「已獨立 →」並連到新對話。搬移的標記沒有這個欄位 |
| `Note` | 加 `copiedFromNoteId?`（`copyNotes` 複製的紀要；來源欄位指向原對話，請顯示 `sourceLabel`） |
| `GET /capabilities` | `features` 在 `parking` 之後多 `{name: "spinoff", enabled}`、`{name: "rebalance", enabled, mode}`（`suggestions` 仍在最後）。參考伺服器預設開 `spinoff`、`rebalance:suggest`，所以 `suggestions` 預設是 `enabled: true` |
| `POST /lines/{id}/preview` 的 `blocks` | spinoff 產生的主線多一個 `key: "origin_capsule"` 區塊（排在規則之後、紀要之前） |
| `POST /seeds/{sid}/expand` | anchor 所在的線已結束時，改為沿分岔點往上找最近的進行中祖先線，掛在它的分岔訊息上（以前是依建支線規則拒絕） |

## 建議匣：樹平衡（`rebalance`）

- 支線的一輪完成後，如果它分岔後的回覆 ≥ 6 且 ≥ 父線分岔後的 2 倍（`reason: "share"`），或整棵樹最近 5 個回覆都在它（`reason: "recent"`），提一筆：
  `{feature: "rebalance", kind: "promote_or_spinoff", targetKey: "branch:<lineId>", lineId: <支線>, payload: {reason, branchTurns, parentTurns, recentInBranch, actions: ("promote" \| "spinoff")[]}}`。
  `actions` 只列現在能做的（`promote`：直接掛在主線下的支線；`spinoff`：功能開著）。樣本 `route.suggestions.list.rebalance`。
- 接受：`POST /suggestions/{sid}/accept {action: "promote"}` 或 `{action: "spinoff", title?, copyNotes?}` → 200 `{suggestion, result: {action, line, branch?, previousMainLine?, link?}}`
  （promote：`branch` 是升級的支線、`previousMainLine`、`line` 是主線；spinoff：`line` 是新主線、`link`）。樣本 `route.suggestions.accept.spinoff`。
  動作被拒絕（例如 `open_branches_on_old_tail`）時建議維持 open。別的 `action` → 400 `invalid_input`；`spinoff` 關閉時選 spinoff → 404 `feature_disabled`。
- 「維持」= dismiss，對這條支線**永久**不再提。manual 模式不提。
- 接受後會照常發 promote / spinoff 的事件，以及 `suggestion.changed{accepted}`。

## 新事件

| type / change | data | 樣本 |
|---|---|---|
| `link.changed` | `{rootLineId, link: Link}`；spinoff 時對原樹與新樹各發一次 | `event.link.changed` |
| `branch.changed{change: "detached"}` | `{change, branch: BranchView}`（支線原本的樣子）；之後子孫各一個 `branch.changed{moved}`，`rootLineId` 已是新主線。收到時把這條支線與它的子孫從原樹的大綱移除，並把新主線加進對話清單（同時有 `line.created`） | `event.branch.changed.detached` |

spinoff 的完整順序：`line.created`（新主線）→ `message.created`（標記）→ `line.updated`（來源線、原主線）→ `link.changed` ×2 →（`copyNotes`）`notes.changed` →（detach）`branch.changed{detached}`、子孫的 `moved` →（有種子搬家）兩棵樹各一個 `seeds.changed` + `line.updated` →（有）`suggestion.changed{expired}`。

## 錯誤碼

沒有新的。

# B8.1 增補（2026-10-16，F4 的缺口）

> 只有新增。樣本共 **103** 檔（+2：`route.leaf.get.draft_error`、`event.leaf.changed.draft_error`）。細節見 `docs/devlog/B8-p1.md` 的「B8.1」。

| 路由 / 型別 | 變動 |
|---|---|
| `Seed` | 加 **`anchorLineId`**（anchor 訊息**現在**所在的線；沒有 anchor 或訊息已不存在時 `""`；每次讀取時查）與 **`sourceLabel`**（停下種子當下的來源文字快照，規則與紀要的 `sourceLabel` 相同：`主線 #n`、`查證・目的`…；沒有 anchor 時 `""`；**寫入時存**，anchor 之後被搬走也不變）。所有回傳種子的路由都有（`GET/POST /seeds`、`/expand`、`/to-note`、`/drop`） |
| `GET /lines/{id}/seeds` | 加 **`limits: {maxOpen, maxRunes}`**（預設 100、500；同 `/notes` 的 `limits`） |
| `GET /lines/{id}/leaf` | 加 **`draftError?: {code, message}`**：這條支線最新的 `leaf_draft` job 失敗、且之後收尾沒有再被寫過時出現。`code`：`run_failed`（執行失敗）、`unusable`（輸出不能用）、`timed_out`（逾時，3 分鐘）、`failed`（其他）；`message` 是固定的英文說明。再起草（新的 job 進行中）或寫入收尾之後就不出現 |
| 事件 `leaf.changed` | `leaf_draft` 失敗時也發：`{lineId, rootLineId, leaf: 目前的收尾 \| null, draftError: {code, message}}`。成功、PUT、DELETE、merge、discard 的 `leaf.changed` 沒有 `draftError` |

前端：起草中的狀態仍由前端自己記（`POST /leaf/draft` 的 202 之後到 `leaf.changed` 為止）；收到帶 `draftError` 的 `leaf.changed` 就結束「起草中」並顯示錯誤。

# R6 修正（2026-10-16）

- 接受樹平衡建議走 spinoff、或手動 detach 時，**被獨立那條線自己的建議留在原樹**：接受的那筆是 `accepted`，其他 open 的變 `expired`，`suggestion.changed` 的 `rootLineId` 都是原主線；
  只有它底下（子樹）的建議搬到新樹。新主線的 `openSuggestions` 不算這些。樣本 `route.suggestions.accept.spinoff` 因此改變（`suggestion.rootLineId` = 原主線、新主線 `openSuggestions: 0`）。
- 已結束（merge / discard）的支線不會再出現新的建議（之前可能在關閉的同時冒出一筆 open）。

# B8.2 增補（2026-10-16）

> 只有新增。樣本共 **105** 檔（+2：`route.spinoff.preview`、`event.summary.due`）。

| 路由 / 型別 / 事件 | 變動 |
|---|---|
| `POST /lines/{id}/spinoff/preview` | 新路由（功能 `spinoff`，唯讀可呼叫，不寫入）：本文同 `POST /spinoff`；回 `200 {mode, capsule: {text, tokenEstimate, tokenBudget, truncated}, notesToCopy}`。`text` 就是真的 spinoff 會存的膠囊（同一段組裝程式），可以取代前端的估算。`notesToCopy` 只在帶 `copyNotes: true` 時計數。錯誤：`invalid_input`（mode）、`branch_not_found`（detach 主線）、`branch_closed`（detach 已結束的支線）、`anchor_not_found`（fresh 的訊息） |
| `spunOffFrom`、`meta.spunOffTo` | 加 **`available: boolean`**：讀取當下另一邊的線是否還存在（同租戶）。`LineView.spunOffFrom` 每次讀取都判斷；標記訊息的 `meta.spunOffTo` 在 `GET /messages` 判斷（`message.created` 事件裡是建立當時的 `true`）。`false` 時不要做成連結 |
| 樹平衡 `payload` | 加 **`parentIsMain: boolean`**、**`parentTitle: string`**（直接掛在主線下時寫「主線」，否則用父線標題） |
| 事件 **`summary.due`** | `{lineId, rootLineId}`：`summary` 在 suggest 模式下，該摘要了（每輪成功完成後檢查，仍超過門檻就再發一次）。用來提示 `POST /compact`；摘要存好後照舊有 `line.updated` |

# B9 增補（階段 A，2026-10-16）

> 後端 B9 階段 A：`goal`（含偏題偵測）、`relations`、`open_loops`、訊息釘選（核心）。只有新增。樣本共 **127** 檔（+22）；32 檔既有樣本因新欄位
> （`Message.pinned`、`LineView.staleBranches`、`/capabilities` 多三項）而變動。細節見 `docs/devlog/B9-p2.md`；每條路由的說明在 `docs/API.md`。

## 新路由

| 路由 | 功能 | 請求 | 回應 | 樣本 |
|---|---|---|---|---|
| `GET /lines/{id}/goal` | `goal` | — | 200 `{goal: Goal \| null}`（`{id}` 可以是樹上任何一條線） | `route.goal.get`、`route.goal.get.none` |
| `PUT /lines/{id}/goal` | `goal` | `{text}`（必填；壓成一行，≤ 300 字） | 200 `{goal}`（`source: "manual"`） | `route.goal.put` |
| `DELETE /lines/{id}/goal` | `goal` | — | 204；沒有 → 404 `goal_not_found` | `route.goal.delete`、`route.error.goal_not_found` |
| `POST /lines/{id}/goal/propose` | `goal` | — | 202 `{jobId, kind: "goal_propose", lineId（主線）, provider, model}`；結果進建議匣（auto：直接寫成目標） | `route.goal.propose` |
| `GET /lines/{id}/relations` | `relations` | — | 200 `{relations: Link[], limits: {maxPerTree, labelMaxRunes}}` | `route.relations.list` |
| `POST /lines/{id}/relations` | `relations` | `{fromLineId?（預設 {id}）, fromMessageId?, toLineId, toMessageId?, label?}`（必填） | 201 `{relation: Link, rootLineIds: string[]}` | `route.relations.create`、`route.error.relation_exists` |
| `DELETE /lines/{id}/relations/{rid}` | `relations` | — | 204 | `route.relations.delete`、`route.error.relation_not_found` |
| `GET /open-loops?root=&staleDays=` | `open_loops` | `root` 可選（任何一條線）、`staleDays` 1–365（預設 3） | 200 `OpenLoops`（見下） | `route.open_loops.list`、`route.open_loops.root` |
| `POST /messages/{mid}/pin` | 核心 | — | 200 `{message}` | `route.messages.pin` |
| `DELETE /messages/{mid}/pin` | 核心 | — | 200 `{message}` | `route.messages.unpin` |

- `GET /lines/{id}/links` 現在在 `spinoff` **或** `relations` 任一設定了就掛上，只列開著的功能的種類（`kind: "spinoff"` / `"relation"`）；兩個都被政策關掉 → 404 `feature_disabled`（`feature` 是 `spinoff`，只設定了 `relations` 時是 `relations`）。樣本 `route.links.list.relations`。
- 唯讀身分可以呼叫三個 GET。釘選是寫入（唯讀 → 403）。

### 型別

```ts
interface Goal {
  rootLineId: string;
  text: string;                    // 一行，≤ 300 字
  source: "manual" | "ai";         // ai = 接受了 AI 的提案（沒改字）或 auto 模式寫入
  updatedBy: string; createdAt: string; updatedAt: string;
}
interface OpenLoopGroup<T> { items: T[]; total: number }   // items ≤ 50，total 是全部
interface OpenLoops {
  rootLineId: string;              // 沒給 root 時 ""
  staleDays: number;
  staleBranches: OpenLoopGroup<BranchView & { rootTitle: string }>;              // 一定有；最久沒動的在前
  toConfirm?: OpenLoopGroup<Note & { rootLineId: string; rootTitle: string }>;  // notes 開著才有
  seeds?: OpenLoopGroup<Seed & { rootTitle: string }>;                           // parking 開著才有
  suggestions?: OpenLoopGroup<Suggestion & { rootTitle: string }>;               // 有會提建議的功能開著才有
}
```

`Link` 不變；一端是訊息時 `fromLineId` / `toLineId` 是那則訊息**現在**所在的線（move / promote 後跟著變），`fromTitle` / `toTitle` 是那條線的標題。

## 回應變動

| 路由 / 型別 | 變動 |
|---|---|
| `Message` | 加 **`pinned: boolean`**（所有回傳訊息的地方都有，事件也是） |
| `LineView` | 加 **`staleBranches: number`**（這棵樹進行中且超過 3 天沒活動的支線數；只在主線，支線為 0；讀取時計算，單純時間經過不會發 `line.updated`；不看功能開關，請依 `/capabilities` 的 `open_loops` 決定顯示）。「待處理」數量 = `staleBranches + openSeeds + openSuggestions`（提案，見 B9-p2「給協調者的問題」） |
| `GET /capabilities` | `features` 在 `rebalance` 之後、`suggestions` 之前多 `{name: "goal", enabled, mode}`、`{name: "relations", enabled, mode}`、`{name: "open_loops", enabled}`。參考伺服器預設開 `goal:suggest`、`relations:suggest`、`open_loops` |
| `POST /lines/{id}/preview` 的 `blocks` | 有目標時多一個 `key: "goal"` 區塊，排在規則之後（背景包 / 起始膠囊、紀要之前；支線也有） |

## 建議匣：新的三種

| `feature` / `kind` | 何時 | `targetKey` | `lineId` | `payload` | 接受的本文 → `result` |
|---|---|---|---|---|---|
| `goal` / `goal_propose` | suggest / auto：主線第 2 個回覆後還沒有目標；或按了 `POST /goal/propose`（任何模式；不受之前拒絕的冷卻限制） | `goal:<主線>` | 主線 | `{text}` | `{text?}`（改了字 → `source: manual`）→ `{goal: Goal}`；空白 → 400 `invalid_input` |
| `goal` / `drift` | suggest / auto：有目標時每 4 個主線回覆檢查一次，偏題時 | `drift:<訊息>` | 主線 | `{anchorMessageId, kind: "aside" \| "investigate", purpose, reason, goal}` | `{kind?, purpose?}` → `{line: LineView, branch: BranchView}`（在 `anchorMessageId` 開支線；錯誤同 `POST /branches`） |
| `relations` / `relation` | suggest（auto 相同）：支線 merge / discard 後，AI 從同一棵樹的其他支線找出相關的（最多 3 筆） | `relation:<id>:<id>`（不分方向；當成不透明字串） | 主線 | `{fromLineId, toLineId, fromTitle, toTitle, label}`（title 是支線目的） | `{label?}` → `{link: Link}`（錯誤同 `POST /relations`） |

- 偏題建議的 `kind` 只在 `aside` 功能開著時才可能是 `aside`。manual 模式的 `goal` 只有按鈕會提案，不偵測偏題；manual 的 `relations` 不提建議。
- 樣本：`route.suggestions.accept.goal`、`route.suggestions.list.p2`（drift）、`route.suggestions.accept.drift`、`route.suggestions.accept.relation`。

## 新事件

| type | data | 何時 | 樣本 |
|---|---|---|---|
| `goal.changed` | `{rootLineId, goal: Goal \| null}` | PUT、接受提案、auto 寫入、DELETE（`null`） | `event.goal.changed` |
| `link.changed`（新增 `deleted`） | `{rootLineId, link, deleted?: true}` | 關聯新增 / 刪除（刪除時 `deleted: true`）；跨樹的關聯對兩棵樹各發一次 | `event.link.changed.deleted` |
| `message.updated`（既有） | `Message` | 釘選 / 取消釘選（狀態有變才發） | — |

## 錯誤碼（新增，前端錯誤碼清單要補）

| code | HTTP | extra |
|---|---|---|
| `goal_not_found` | 404 | — |
| `relation_not_found` | 404 | — |
| `relation_exists` | 409 | — |
| `relation_limit` | 409 | `limit`（預設 200） |

另外用到既有的：目標空白 `invalid_input`、過長 `too_long{field: "text", max: 300}`；關聯說明過長 `too_long{field: "label", max: 200}`、兩端相同或起點不在這棵樹 `invalid_input`、
端點訊息不對 `message_not_found`、線不對 `line_not_found`；釘選 pending / 系統訊息 `invalid_input`、沒有這則 `message_not_found`；封存中的樹 `archived`；`POST /goal/propose` 在主線還沒有完成的對話時 `no_messages`。

## fake runner（e2e 用）

- `goal_propose` job 回 `{"goal": "Settle what this conversation set out to decide (fake runner)."}`。
- `drift_check` job 預設回「沒偏題」；被檢查的訊息裡有 **`[fake:drift]`** 時回偏題（`kind: investigate`、`purpose: "Follow the side topic (fake runner)"`）。
- `relation_suggest` job 把結束的支線關聯到「最新的另一條支線」（`label: "Related (fake runner)"`）；樹上沒有別的支線時不排 job。
- e2e 的 `API_FEATURES` 目前沒有 P2 功能；要測請加 `goal:suggest,relations:suggest,open_loops`（注意：`goal:suggest` 會在每個對話第 2 個回覆後自動提一筆 `goal_propose` 建議，
  會影響「建議匣只有一筆」這類斷言）。

# B9 增補（階段 B，2026-10-16）

> 後端 B9 階段 B：共用 token 預算、`fisheye` 魚眼脈絡、`cmd/tangent-eval`；另外階段 A 的回覆第 4 點（使用者 PUT 目標會讓 open 的 `goal_propose` 變 expired）。只有新增。
> 樣本共 **128** 檔（+1：`route.preview.fisheye`）；`route.preview`、`route.capabilities`、`route.capabilities.viewer` 有變動。細節見 `docs/devlog/B9-p2.md` 的「階段 B」。

## 回應變動

| 路由 / 型別 | 變動 |
|---|---|
| `POST /lines/{id}/preview` | 加 **`budget: {total, shares: {owner, tokens}[], history, used}`**（一定有）與 **`fisheye?: {items: FisheyeItem[], tokens, budget}`**（`fisheye` 開著才有）。`blocks` 可能多一個 `key: "branch_conclusions"`（「其他支線的結論」，排在摘要之後、卡片通知之前） |
| `GET /capabilities` | `features` 在 `open_loops` 之後、`suggestions` 之前多 `{name: "fisheye", enabled}`（沒有 mode）。參考伺服器**預設關閉**（`TANGENT_FEATURES=…,fisheye` 開；需要 `leaf`） |
| `PUT /lines/{id}/goal` | 同一交易裡把這個對話 open 的 `goal_propose` 建議設成 `expired`：發 `goal.changed` 後接 `suggestion.changed{expired}` 與主線的 `line.updated` |

```ts
interface PromptBudget {
  total: number;                    // Limits.Context.TokenBudget，預設 40000
  shares: { owner: string; tokens: number }[];   // 依花用順序："core"（背景包 / 起始膠囊 / 卡片通知）→ 功能名稱（"notes"、"goal"、"summary"…）→ "host" → "history"；沒花到的不列
  history: number;                  // 歷史分到的上限（剩下的，最多 24000）
  used: number;                     // shares 的總和
}
interface FisheyeItem {
  kind: "message" | "branch";
  id: string;                       // 訊息 id，或支線線的 id
  lineId: string;
  level: "full" | "summary" | "leaf_only" | "hidden";
  score: number;                    // 先天重要性 − 距離（可為負）
  tokens: number;                   // 這個程度花的 token
}
interface FisheyeReport { items: FisheyeItem[]; tokens: number; budget: number }
```

- **訊息**項目依時間（舊的在前）：`full` = 原文、`summary` = 併進「Earlier in this session」的一行（或已被滾動摘要涵蓋）、`hidden` = 沒送。分數 = 釘選 +100、結論卡 +6、被紀要或卡片引用 +4，減「往前第幾個來回」。
  預設最近 4 個來回原文、往前 20 個來回內一行、更早的不送；釘選的一律原文；最新的一則一定原文。
- **支線**項目依分數（高的在前）：`leaf_only` = 收尾的一句話進「其他支線的結論」、`hidden` = 沒有收尾也沒有卡片結論，或太遠。分數 = 收尾種類（decision 5、conclusion 4、answer 3、to_continue 2、dead_end 1；只有卡片結論 4）減樹上的距離（邊數）；
  分數 ≥ −3 才顯示，最多 20 條。這條線自己與它的祖先不列（背景包已帶）。
- 預算不夠時從分數低的開始降級。地圖 / 預覽要顯示「這一輪 AI 看得到什麼」時，用 `fisheye.items` 的 `level` 標每個節點；`fisheye` 不存在時就是預設（最近的訊息原文）。

## 其他

- 沒有新路由、新事件、新錯誤碼。
- fake runner 不變。e2e 要測魚眼：`API_FEATURES` 加 `fisheye`（它會改變每一輪 prompt 的歷史，但不影響回覆，fake runner 只回聲使用者訊息；`usage.inputTokens` 會變小）。

# B9 增補（階段 C，2026-10-17）

> 後端 B9 階段 C：`group`（群組、合併支線、群組建議與矛盾選擇），加上 F5 的兩個缺口：`PATCH /lines/{id}/relations/{rid}`、通用事件 `job.failed`。只有新增。
> 樣本共 **144** 檔（+16）；既有樣本因 `BranchView.mergedIntoLineId`、`/capabilities` 多 `group` 而變動。細節見 `docs/devlog/B9-p2.md` 的「階段 C」；路由說明在 `docs/API.md`。

## 新路由

| 路由 | 功能 | 請求 | 回應 | 樣本 |
|---|---|---|---|---|
| `GET /lines/{id}/groups?status=` | `group` | `status` 逗號分隔或 `all`，預設 `active` | 200 `{rootLineId, groups: Group[], limits: {maxMembers, maxActivePerTree, titleMaxRunes}}` | `route.groups.list` |
| `POST /lines/{id}/groups` | `group` | `{memberLineIds[], title, conflicts?: Conflict[]}`（必填） | 201 `{group, job: {jobId, kind, lineId, provider, model} \| null, notes?}`（摘要已開始，`summaryStatus: drafting`） | `route.groups.create`、`route.error.invalid_group` |
| `GET /groups/{gid}` | `group` | — | 200 `{group}` | `route.groups.get` |
| `PATCH /groups/{gid}` | `group` | `{title}` | 200 `{group}` | `route.groups.rename` |
| `POST /groups/{gid}/dissolve` | `group` | — | 200 `{group}`（`status: dissolved`） | `route.groups.dissolve`、`route.error.group_not_active` |
| `POST /groups/{gid}/summarize` | `group` | — | 202 `{jobId, kind: "group_summary", lineId, provider, model}` | `route.groups.summarize` |
| `POST /lines/{id}/branches/combine` | `group` | `{lineIds[], purpose, kind?, conflicts?}`（`{id}` 是父線） | 201 `{line, branch（origin "merge"）, pack, combined: BranchView[], notes?}` | `route.branches.combine` |
| `PATCH /lines/{id}/relations/{rid}` | `relations` | `{label}` | 200 `{relation, rootLineIds}` | `route.relations.update` |

### 型別

```ts
interface Group {
  id: string; rootLineId: string;
  title: string;                    // ≤ 120 字
  summary: string;                  // 共同摘要（≤ 1000 字，可多行）；還沒寫好時 ""
  summaryStatus: "none" | "drafting" | "ready" | "failed";   // failed 時保留上一次的 summary
  status: "active" | "dissolved";
  memberLineIds: string[];          // 依支線建立的順序
  createdBy: string; createdAt: string; updatedAt: string;
}
interface Conflict {
  id: string;                       // 請求裡可省略（c1, c2…）；建議裡一定有
  branch: { lineId: string; claim: string };   // claim 一行 1–300 字
  other:  { lineId: string; claim: string };
  choice?: "adoptBranch" | "adoptOther" | "keepBoth";        // 請求裡必填；keepBoth 需要 notes，寫一筆「待確認」紀要
}
```

- 群組成員：同一棵樹、**已結束**、有收尾或卡片結論的支線 2–12 條，一條支線同時只在一個 active 群組；違反 → 422 `invalid_group`（訊息說明原因）。合併：同一條父線底下**進行中**、不是岔題的支線 2–12 條。
- `job` 在建立時已交給伺服器的派發器（不用再呼叫 summarize）；摘要寫好會發 `group.changed`（`summaryStatus: ready`）。

## 回應變動

| 路由 / 型別 | 變動 |
|---|---|
| `BranchView` | 加 **`mergedIntoLineId: string`**（被合併進的新支線；`status` 為 `discarded`；其他為 `""`）。前端顯示「已合併到…」並連過去。`origin` 多一個值 `"merge"` |
| `GET /capabilities` | `features` 在 `fisheye` 之後、`suggestions` 之前多 `{name: "group", enabled, mode}`。參考伺服器預設 `group:suggest` |
| `POST /lines/{id}/preview` 的 `fisheye.items` | 多一種 `kind: "group"`（`id` 是群組 id、`lineId` 是 `""`）：摘要就緒的群組取代成員各自的收尾，「其他支線的結論」裡是 `> [group] 標題 — 摘要`；成員不再各自出現 |
| 建議匣 | 多一種 `feature: "group"`, `kind: "group"`（見下） |

## 建議匣：群組（`group`）

- 何時：suggest（auto 相同）模式，每次非岔題支線 merge / discard 之後，樹上至少有 3 條候選（已結束有收尾、或進行中有回覆，不在 active 群組）時，便宜模型提出最多 3 個群組與群組內互相矛盾的說法。
- `targetKey: "group:<id>,<id>…"`（不透明）、`lineId` = 主線、`payload = {title, members: [{lineId, purpose, ended, leaf}], conflicts: Conflict[]（沒有 choice）}`。
- 接受：`{action?: "group" | "combine", title?, purpose?, kind?, choices?: {"c1": "keepBoth", …}}`。預設：有兩條以上已結束的成員 → `group`，否則 `combine`。
  `group` 用已結束的成員 → `result = {action: "group", group, job?: {jobId, kind}, notes?}`；`combine` 用進行中的成員（同一條父線）→ `result = {action: "combine", combined: {created: {line, branch, pack}, combined: BranchView[], notes}, notes}`。
  只有給了選擇的矛盾會套用。樣本 `route.suggestions.list.group`、`route.suggestions.accept.group`、`route.suggestions.accept.combine`。

## 新事件

| type | data | 何時 | 樣本 |
|---|---|---|---|
| `group.changed` | `{rootLineId, group: Group}` | 建立、改名、解散、開始摘要、摘要完成 / 失敗 | `event.group.changed` |
| `job.failed` | `{jobId, kind, lineId, rootLineId, error: {code: "run_failed" \| "unusable" \| "timed_out" \| "failed", message}}` | `goal_propose`、`drift_check`、`relation_suggest`、`group_summary`、`group_suggest` 失敗或逾時（收尾草稿照舊用 `leaf.changed.draftError`） | `event.job.failed`（`group_suggest`） |
| `link.changed`（既有） | — | `PATCH` 關聯說明時也發（沒有 `deleted`） | — |

合併的事件順序：`line.created`（新支線）→ 父線 `line.updated` → `branch.changed{created}` → 每條舊支線 `branch.changed{discarded}`（帶 `mergedIntoLineId`）→（keepBoth）`notes.changed` →（有）`suggestion.changed{expired}`。

## 錯誤碼（新增，前端錯誤碼清單要補）

| code | HTTP | extra |
|---|---|---|
| `group_not_found` | 404 | — |
| `group_not_active` | 409 | — |
| `invalid_group` | 422 | —（`error` 是原因） |
| `group_limit` | 409 | `limit`（預設 50） |

## fake runner（e2e 用）

- `group_summary` job 回固定的摘要 `"These branches settle one question together (fake runner)."`。
- `group_suggest` job 把「最新的兩條已結束的候選」當一組（附一個矛盾：`"the first one says yes"` / `"the second one says no"`），「最新的兩條進行中的候選」當另一組；不夠兩條就不提。
- 在支線的收尾或訊息裡放 `[fake:job-error]`，引用到它的 job（摘要、群組建議）就會失敗 → `job.failed`。

# B9.1 增補（2026-10-17）：合併時改掛進行中的子支線

> 只有新增。樣本數不變（144）；`route.branches.combine`、`route.suggestions.accept.combine` 變動。細節見 `docs/devlog/B9-p2.md` 的「B9.1」。

| 路由 / 事件 | 變動 |
|---|---|
| `POST /lines/{id}/branches/combine` | 被合併的支線底下**進行中**的子支線改掛到新支線底下（以前會留在已放棄的舊支線下、不能再對話）。回應加 **`reparented: string[]`**（改掛的子支線 id，依 id 順序）；新支線的 `line.branchCounts.open` 算進它們 |
| 接受群組建議 `action: combine` | `result.combined` 加 `reparented`（同上） |
| 子支線的 `BranchView` | `parentLineId` 變成新支線；**`anchorMessageId` 不變**：仍是它分岔的那則訊息，那則訊息留在被合併的舊支線上（不在新父線的訊息裡）。要在新父線的對話裡畫分岔點時，用舊支線的 `mergedIntoLineId` 找回來，或畫在新支線的開頭（它是在合併前分岔的）。`depth` 不變（新支線與舊支線同層） |
| 事件 | 每條改掛的子支線一個 `branch.changed{moved}`（`branch.parentLineId` 是新支線），以及失去子支線的舊支線的 `line.updated`；排在舊支線的 `branch.changed{discarded}` 之後 |
| 錯誤 | 改掛後新支線的進行中子支線超過 8（`Limits.Branch.MaxOpenPerParent`）→ `409 branch_limit`（既有的碼），整筆合併不做 |

已結束的子支線留在舊支線底下；子支線底下的線跟著它（父子關係不變）。

# B10 增補（階段 A，2026-10-17）：論證類型（`ibis`）、折疊（`fold`）

> 後端 B10 階段 A。只有新增；沒有任何既有欄位改名或改型別。樣本共 **158** 檔（+14）；既有樣本只有 `route.capabilities`、`route.capabilities.viewer` 變動（多兩項功能）。
> 細節見 `docs/devlog/B10-p3.md`；路由說明在 `docs/API.md`（「論證類型（ibis）」「折疊（fold）」兩節）。F6 的 `ArgTag`、`FoldBlock` 用這一段。

## 新路由

| 路由 | 功能 | 請求 | 回應 | 樣本 |
|---|---|---|---|---|
| `PUT /messages/{mid}/tag` | `ibis` | `{kind}`（必填；`question` / `idea` / `pro` / `con` / `decision`） | 200 `{message}`（`message.tag` 是使用者的） | `route.messages.tag` |
| `DELETE /messages/{mid}/tag` | `ibis` | — | 200 `{message}`（沒有 `tag`） | `route.messages.untag` |
| `GET /lines/{id}/folds` | `fold` | — | 200 `{lineId, rootLineId, folds: Fold[], limits: {summaryMaxRunes, minMessages, maxMessages, maxActivePerLine}}` | `route.folds.list` |
| `POST /lines/{id}/folds` | `fold` | `{fromMessageId, toMessageId, summary?}`（必填；兩端順序不拘） | 201 `{fold, job: {jobId, kind: "fold_summary", lineId, provider, model} \| null}`（沒給 `summary` 時 `fold.status: "drafting"`，job 已交給伺服器的 Dispatcher） | `route.folds.create`、`route.error.fold_overlap`、`route.error.invalid_fold` |
| `DELETE /folds/{fid}` | `fold` | — | 204 | `route.folds.delete`、`route.error.fold_not_found` |

### 型別

```ts
type TagKind = "question" | "idea" | "pro" | "con" | "decision";
interface MessageTag {
  kind: TagKind;
  source: "ai" | "user";            // user 的永遠不會被 AI 改掉
  status: "draft" | "confirmed";    // AI 在 suggest 模式寫 draft（顯示「AI 標・待確認」），auto 寫 confirmed；使用者的一律 confirmed
  updatedAt: string;
}
interface Fold {
  id: string; lineId: string;
  fromMessageId: string; toMessageId: string;   // 兩端（含）；seq 由小到大
  fromSeq: number; toSeq: number;
  summary: string;                  // ≤ 1000 字；drafting / failed 時 ""
  messageCount: number;             // 建立時範圍內的訊息數
  tokensOriginal: number;           // 這段原文的 token 估計（建立時）
  tokensSummary: number;            // 摘要的 token 估計
  status: "drafting" | "active" | "failed" | "removed";      // 只有 active 會套用；removed 不再列出
  aiDrafted: boolean;               // 摘要是 AI 寫的（起草或接受建議時沒改）
  createdBy: string; createdAt: string; updatedAt: string;
}
interface AppliedFold { foldId: string; fromSeq: number; toSeq: number; messages: number; tokensOriginal: number; tokensSummary: number }
```

- 「#20–#31」的編號：前端照既有的 `chatNumbers` 從 `fromMessageId` / `toMessageId` 算（後端不回編號）。「原本 4.2k → 180 token」用 `tokensOriginal` / `tokensSummary`。
- 只有完成的 user / assistant 聊天訊息能標記（卡片、標記、進行中的回覆 → 400 `invalid_input`）。標記與折疊都跟著訊息走（move / promote）。

## 回應變動

| 路由 / 型別 | 變動 |
|---|---|
| `Message` | 加 **`tag?: MessageTag`**：沒有標記時**欄位不出現**（不是 `null`），所以既有樣本不變。`GET /messages`、`message.updated`、`POST/DELETE /pin` 都帶；`message.created`（新訊息）沒有 |
| `BranchView` | 加 **`anchorTag?: MessageTag`**：支線掛的那則訊息的標記（地圖節點依類型上色 / 篩選用），沒有就不出現。功能關閉時已存的照樣帶出 |
| `POST /lines/{id}/preview` | 加 **`folds?: AppliedFold[]`**（有套用時才出現）。被折疊的訊息在 `prompt.history` / `blocks` 是一則 `role: "system"` 的項目（`Folded part of this conversation (N messages), summarized; …` + 引用的摘要），或在魚眼下是 `prompt.earlier` 裡的一行 `folded (N messages): …`；`fisheye.items` 多一種 `kind: "fold"`（`id` = 折疊 id），被折疊的訊息不再是項目 |
| `GET /capabilities` | `features` 在 `group` 之後、`suggestions` 之前多 `{name: "ibis", enabled, mode}`、`{name: "fold", enabled, mode}`。參考伺服器預設 `ibis:suggest`、`fold:suggest` |
| 建議匣 | 多一種 `feature: "fold"`, `kind: "fold"`（見下）；`suggestions` 在 `fold` 開著時也算開 |

## 建議匣：折疊（`fold`）

- 何時：suggest（auto 相同，不自動折疊）模式，一條線（岔題除外）每 10 個回覆，找它最舊的、**已結束**的章節（不是最後一章；≥ 8 則、≥ 1000 token、沒有和折疊重疊、沒有提過），便宜模型起草摘要。章節同 `GET /chapters` 的切法。
- `targetKey: "fold:<fromMessageId>:<toMessageId>"`（不透明）、`lineId` = 那條線、
  `payload = {fromMessageId, toMessageId, fromSeq, toSeq, title（章節標題）, summary, messageCount, tokensOriginal, tokensSummary, jobId}`。原型的「可省約 3.1k token」= `tokensOriginal − tokensSummary`。
- 接受：`{summary?}`（改了就用你的，`aiDrafted: false`）→ `result = {fold: Fold}`，發 `fold.changed`；範圍已和別的折疊重疊 → 409 `fold_overlap`，建議維持 open。**拒絕是永久的**（同一章節不再提）。
  樣本 `route.suggestions.list.fold`、`route.suggestions.accept.fold`。

## 新事件

| type | data | 何時 | 樣本 |
|---|---|---|---|
| `fold.changed` | `{lineId, rootLineId, fold: Fold}` | 建立、摘要寫好（`active`）或失敗（`failed`）、收回（`removed`）、跟著訊息搬到別的線（`lineId` 是新的線）或被 move / promote 拆開（`removed`） | `event.fold.changed` |
| `message.updated`（既有） | `Message` | 使用者 PUT / DELETE 標記（有變才發）；AI 標記時每一則被標的訊息各一個（`tag.source: "ai"`） | — |
| `job.failed`（既有） | — | 多三種 kind：`ibis_tag`、`fold_summary`（另發 `fold.changed{failed}`）、`fold_suggest` | — |

## 錯誤碼（新增，前端錯誤碼清單要補）

| code | HTTP | extra |
|---|---|---|
| `fold_not_found` | 404 | — |
| `fold_overlap` | 409 | `foldId`（重疊的那個折疊） |
| `fold_limit` | 409 | `limit`（預設 50） |
| `invalid_fold` | 422 | —（`error` 是原因：少於 2 則、多於 200 則、含進行中的回覆） |

標記的錯誤沿用既有碼：`invalid_input`（kind 不對、不能標的訊息）、`message_not_found`、`archived`、`feature_disabled`。

## fake runner（e2e 用）

- `ibis_tag` job：使用者的訊息標 `question`、助理的標 `idea`。suggest 模式下每一輪完成後幾毫秒內，兩則訊息都會帶 `tag: {source: "ai", status: "draft"}`。
- `fold_summary` / `fold_suggest` job：固定的摘要 `"This stretch of the conversation is folded (fake runner)."`。
- 要讓 e2e 出現折疊建議：章節要結束（加一個 milestone）且舊章節 ≥ 8 則、≥ 1000 token（訊息要長），而且回覆數是 10 的倍數。比較簡單的做法是直接 `POST /folds`。
- `[fake:job-error]` 放在被引用的訊息裡，那個 job 就失敗 → `job.failed`（`fold_summary` 另有 `fold.changed{failed}`）。

# B10 增補（階段 B，2026-10-17）：協調者的三個回覆、`diverge`（發散 / 收斂 / 決定）

> 只有新增。樣本共 **170** 檔（+12）；既有樣本只有 `route.capabilities`、`route.capabilities.viewer`（多 `diverge`）與 `route.preview.folds`（流程裡改了一次摘要）變動。
> 細節見 `docs/devlog/B10-p3.md` 的「階段 B」；路由說明在 `docs/API.md`（「折疊」的 `PATCH`、「發散與收斂（diverge）」一節）。F6 的 `DivergeMarker`、`CompareTable` 用這一段。

## 階段 A 的三個改動

| 項目 | 變動 |
|---|---|
| `ibis` 的 AI 標記 | 改成每 **3** 則回覆一次（`Limits.Ibis.Every`），不是每一輪。一則新訊息最晚兩輪後才會有 AI 標記 |
| 魚眼 | `ibis` 開著時，`tag: {kind: "decision", status: "confirmed"}` 的訊息先天重要性 +4（`fisheye.items[].score` 高 4；AI 的 `draft` 不算） |
| `PATCH /folds/{fid}` | **新路由**（功能 `fold`）：`{summary}`（必填，非空、≤ 1000 字）→ 200 `{fold}`：`status: "active"`、`aiDrafted: false`、`tokensSummary` 重算；`drafting` / `failed` 的也可以改（起草中的 job 之後不寫）；收回的 → 404 `fold_not_found`。發 `fold.changed`。樣本 `route.folds.update` |

## 新路由（`diverge`，需要 `leaf`）

| 路由 | 請求 | 回應 | 樣本 |
|---|---|---|---|
| `POST /lines/{id}/diverge` | `{anchorMessageId, count: 2–5}`（必填） | 202 `{jobId, kind: "diverge", lineId, provider, model}` | `route.diverge` |
| `POST /lines/{id}/converge` | `{lineIds: string[]（2–5）, criteria?: string[]（≤ 6，各 ≤ 120 字）}`（`{id}` 是父線） | 201 `{comparison（drafting）, job: {jobId, kind: "converge", …}}` | `route.converge`、`route.error.invalid_comparison` |
| `GET /lines/{id}/comparisons` | — | 200 `{lineId, rootLineId, comparisons: Comparison[]（新的在前）, limits: {minOptions, maxOptions, maxCriteria}}` | `route.comparisons.list` |
| `GET /comparisons/{cid}` | — | 200 `{comparison}` | `route.comparisons.get`、`route.error.comparison_not_found` |
| `POST /comparisons/{cid}/decide` | `{lineId, line?}`（必填） | 200 `{comparison（decided）, chosen: BranchView, decision: Leaf, discarded: BranchView[]}` | `route.comparisons.decide`、`route.error.comparison_decided`、`route.error.comparison_not_ready` |

### 型別

```ts
interface Comparison {
  id: string; rootLineId: string;
  parentLineId: string;             // 比較的支線掛在這條線上
  lineIds: string[];                // 選項，依請求的順序（O1, O2…）
  criteria: string[];               // 使用者給的條件；沒給是 []（模型自己選，見 matrix.criteria）
  status: "drafting" | "ready" | "failed" | "decided";
  matrix: ComparisonMatrix | null;  // ready 之後才有
  decidedLineId: string;            // 決定前 ""
  createdBy: string; decidedBy: string;
  createdAt: string; updatedAt: string; decidedAt: string | null;
}
interface ComparisonMatrix {
  criteria: string[];                                   // 列
  options: { lineId: string; label: string }[];         // 欄（label = 比較時的支線目的）
  scores: { score: number; why: string }[][];           // scores[列][欄]；score 1–5，0 = 模型沒給（顯示「—」）
  recommendation: { lineId: string; reason: string };
}
```

- 原型的「分數可改」**沒有做**（沒有路由改分數；見 devlog 的問題）。「產生『決定』收尾」= `POST /decide`。
- 發散開的支線：`BranchView.origin = "diverge"`、`kind = "alternative"`、`anchorMessageId` 相同；同一次發散的支線建立時間相同（大綱依 `createdAt, lineId` 排，同一批之間的順序不固定）。`DivergeMarker` 用 `origin` + `anchorMessageId` 認。
- 決定後：選定的支線**維持進行中**、收尾 `decision`（line 預設 = 建議的理由或它的目的，body = 它那一欄的分數，一行一個條件）；其他比較的、還在進行中的支線 `discarded` + 收尾 `dead_end`（`"Not chosen: went with <目的>"`，英文固定字串，見 devlog 問題）。

## 新事件

| type | data | 何時 | 樣本 |
|---|---|---|---|
| `comparison.changed` | `{rootLineId, comparison}` | 建立（drafting）、比較表寫好（ready）或失敗（failed）、決定（decided）。`lineId` 是父線 | `event.comparison.changed` |
| `branch.changed{created}` 等（既有） | — | 發散的 job 完成時每條新支線一組（`line.created`、父線 `line.updated`、`branch.changed{created}`） | — |
| 決定（既有事件） | — | 每條放棄的 `branch.changed{discarded}` → 父線 `line.updated` → 每條放棄的 `leaf.changed` → 選定的 `leaf.changed` → `comparison.changed` →（有）`suggestion.changed{expired}` | — |
| `job.failed`（既有） | — | 多兩種 kind：`diverge`（支線開不了時 `error.code: "failed"`、`message` 是原因，例如進行中的支線已滿）、`converge`（另發 `comparison.changed{failed}`） | — |

## 錯誤碼（新增，前端錯誤碼清單要補）

| code | HTTP | extra |
|---|---|---|
| `comparison_not_found` | 404 | — |
| `comparison_not_ready` | 409 | —（drafting 或 failed：重新 `converge`） |
| `comparison_decided` | 409 | — |
| `invalid_comparison` | 422 | —（`error` 是原因） |

既有碼：`invalid_input`（count、criteria 太多）、`anchor_not_found`、`branch_limit`（發散會讓進行中的支線超過 8）、`branch_closed`、`branch_busy`、`branch_drafting`、`too_long`、`archived`、`feature_disabled`。

## fake runner（e2e 用）

- `diverge` job：要幾個就給幾個方向，目的 `"Direction 1 (fake runner)"`、`"Direction 2 (fake runner)"` …。
- `converge` job：條件用使用者給的（沒給就是 `"Fit (fake runner)"`），第 1 個選項 5 分、第 2 個 4 分…，建議 O1（`"The first option fits best (fake runner)."`）。
- 選項支線的訊息裡有 `[fake:job-error]` → `converge` 失敗（`comparison.changed{failed}` + `job.failed`），可以用來測 `comparison_not_ready`。
- 參考伺服器預設 `diverge:manual`。

# B10 增補（階段 C，2026-10-18）：`dead_end` 收尾用伺服器語言、跨對話記憶（`memory`）

> 只有新增。樣本共 **184** 檔（+14）；既有樣本只有 `route.capabilities`、`route.capabilities.viewer`（多 `memory`，預設 off）與 `route.comparisons.decide`（`dead_end` 改成伺服器語言）變動。
> 細節見 `docs/devlog/B10-p3.md` 的「階段 C」；路由說明在 `docs/API.md` 的「跨對話記憶（memory）」。F6 第 2 階段若要做記憶的面板 / 「你之前得出過…」用這一段。

## 階段 B 的改動

| 項目 | 變動 |
|---|---|
| 決定的 `dead_end` 收尾 | `line` 改用伺服器語言（同紀要 `sourceLabel` 的做法）：預設 `沒選：改走「<目的>」`，宿主用 `WithLeafTexts(domain.EnglishLeafTexts())` 換成 `Not chosen: went with <目的>`。前端照樣顯示 `line`，不用自己組字 |

## 新路由（`memory`，需要 `notes` 與 `vector` 擴充；功能預設 off）

| 路由 | 請求 | 回應 | 樣本 |
|---|---|---|---|
| `GET /memories` | `?kind=&status=active\|superseded\|all&limit=1–200` | 200 `{memories: Memory[]（新的在前）, limits: {textMaxRunes, topK, searchMax}}` | `route.memories.list`、`route.memories.list.superseded` |
| `POST /memories` | `{kind, text, importance?（1–10，預設 5）, validUntil?, sourceLineId?}` | 201 `{memory}` | `route.memories.create`、`route.error.invalid_memory` |
| `PATCH /memories/{mid}` | `{kind?, importance?, validUntil?（null 清掉）}` | 200 `{memory}` | `route.memories.update`、`route.error.memory_not_found` |
| `POST /memories/{mid}/supersede` | `{text, kind?, importance?, validUntil?}` | 201 `{memory（新的）, superseded: Memory[]}` | `route.memories.supersede`、`route.error.memory_superseded` |
| `POST /memories/search` | `{query, limit?（預設 5，≤ 20）}`（讀，唯讀身分可用） | 200 `{query, results: RecalledMemory[]}` | `route.memories.search` |

### 型別

```ts
interface Memory {
  id: string;
  kind: "fact" | "decision" | "preference" | "lesson";
  text: string;                     // 一行，≤ 500 字
  status: "active" | "superseded";
  supersededBy: string;             // active 時 ""
  importance: number;               // 1–10
  validUntil: string | null;        // 過期後不再被召回（還讀得到）
  source: { lineId: string; messageId: string; leafLineId: string; noteId: string; label: string };
                                    // 都可能是 ""；沒有外鍵，來源刪掉後 label（寫入時的文字）還在
  aiDrafted: boolean;               // 從 memory_extract / consolidate 來、使用者沒改內容
  createdBy: string; createdAt: string; updatedAt: string;
}
interface RecalledMemory { memory: Memory; similarity: number; score: number } // score = 相關 × 新近 × 重要性
```

- 記憶屬於**租戶**，不屬於某一棵樹。不能刪；改內容 = 取代（舊的留著，`?status=superseded` 看歷史）。
- 「你之前得出過…」：開新對話時用第一則訊息、開支線時用支線目的呼叫 `POST /memories/search`，帶入或忽略由前端決定（沒有「帶入」的路由；要帶就放進訊息或背景包）。

## 回應變動

| 路由 | 變動 | 樣本 |
|---|---|---|
| `POST /lines/{id}/preview` | 多 `memories?: RecalledMemory[]`（這一輪帶入的記憶，沒有就不出現）；`blocks` 多 key `memory` 的 trailing 區塊（`## Remembered from earlier conversations`，每行 `> [kind] text (from: label)`）。DESIGN §12：每一輪帶入的記憶只在這裡看得到 | `route.preview.memories` |
| `GET /capabilities` | `features[]` 多 `memory`（off；不在 `AllFeatures()`） | `route.capabilities`、`route.capabilities.viewer` |

## 建議匣：記憶（`memory`）、記憶整併（`memory_consolidate`）

- `memory`：`targetKey: memory:<job id>:<n>`、`lineId` = 來源的線、`payload = {action: "add" | "update", kind, text, importance, targetMemoryId?, source, jobId}`。
  接受的本文 `{text?, kind?, importance?}`（改了內容就 `aiDrafted: false`）；`result = {memory, superseded: Memory[]}`。`update` 要取代的已被取代 → `409 memory_superseded`，建議維持 open。
  何時出現：suggest 模式下 merge、放棄時帶了收尾、`PUT /leaf`、寫入 `decided` 紀要之後（`memory_extract` job）。
- `memory_consolidate`：`targetKey: memory_pair:<舊 id>:<新 id>`、`payload = {action: "merge" | "conflict", memoryIds[2]（舊的在前）, texts[], kind, text, importance, reason, jobId}`；拒絕是永久的。
  接受 → 兩筆都被新的一筆取代，`result = {memory, superseded}`。來自維護迴圈（相似度 ≥ 0.92 的兩筆）。
- 樣本 `route.suggestions.list.memory`、`route.suggestions.accept.memory`、`route.suggestions.accept.memory_consolidate`。

## 新事件

| type | data | 何時 | 樣本 |
|---|---|---|---|
| `memory.changed` | `{memory, superseded: Memory[]}` | 寫入、改歸類、取代、接受記憶 / 整併建議、auto 寫入。信封的 `rootLineId`、`lineId` 是 `""`（屬於租戶） | `event.memory.changed` |
| `job.failed`（既有） | — | 多兩種 kind：`memory_extract`、`memory_consolidate` | — |

## 錯誤碼（新增，前端錯誤碼清單要補）

| code | HTTP | extra |
|---|---|---|
| `memory_not_found` | 404 | — |
| `memory_superseded` | 409 | —（只能讀；改內容請取代現在的那筆） |
| `invalid_memory` | 422 | —（`error` 是原因：種類、空白、重要性） |

既有碼：`invalid_input`（查詢參數、空的 query）、`too_long`（> 500 字）、`line_not_found`（`sourceLineId`）、`feature_disabled`（off）、`read_only`。

## fake runner 與參考伺服器（e2e 用）

- `memory_extract` job：把來源引文的第一行記成一筆 `fact`：`"Remembered: <那一行> (fake runner)"`（重要性 6）。`memory_consolidate` job：一律合併成 `"One memory for both (fake runner)."`。
- fake Embedder（`runner/fake.NewEmbedder`，256 維）：同字（拉丁字母、數字不分大小寫）或同一個 CJK 字就相近，沒有網路、結果固定。
- 參考伺服器 `memory` **預設 off**。開：`TANGENT_FEATURES=…,memory:suggest`；`TANGENT_EMBEDDER=fake`（fake provider 時的預設）或 `openai`（`OPENAI_API_KEY`、`TANGENT_EMBEDDING_MODEL`、`TANGENT_EMBEDDING_DIM`）。資料庫要有 `vector`（dev 的 docker compose 已是 `pgvector/pgvector:pg17`）。e2e 要測記憶就照 `scripts/smoke.sh` 的參數開。

# B7.1 增補（2026-10-18）：宿主區塊可放尾段、`embedder_unavailable`

> 只有新增。樣本共 **185** 檔（+1）；既有樣本都沒變。

| 項目 | 變動 | 樣本 |
|---|---|---|
| `POST /lines/{id}/preview` 的 `prompt` | `PromptSection` 可能多 `trailing: true`（宿主標了尾段的區塊，出現在 `prompt.trailing[]`）；`blocks` 裡它排在 `summary` 之後。沒有宿主 contributor 的伺服器（參考伺服器）不會出現 | — |
| 錯誤碼 `embedder_unavailable` | **503**，`POST /memories`、`POST /memories/{mid}/supersede`、`POST /memories/search`、接受記憶建議時宿主的 Embedder 失敗；可以稍後重試（顯示「記憶服務暫時不能用」）。`error` 是固定字串，不含原因 | `route.error.embedder_unavailable` |
