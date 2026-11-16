# W0 · `web/` 基礎（S5 的第一步）

> 2026-10-15。建立 `web/` pnpm workspace：`@tangent/client`（型別、fetch client、SSE、從 宿主 移植的純邏輯與測試）、
> `@tangent/react` 骨架（Provider、i18n、query key、設計 token）、`apps/demo`（三欄殼層）。沒有動任何 Go 程式碼。

## 驗收（在 repo 根目錄執行）

| 檢查 | 結果 |
|---|---|
| `pnpm -C web install` | 通過（lockfile 已產生，`--prefer-offline` 下全部從本機 store 取得） |
| `pnpm -C web typecheck` | 通過（client、react、demo 三個專案，TS strict + `noUncheckedIndexedAccess`） |
| `pnpm -C web test` | 通過：client 21 個檔案 168 個測試、react 3 個檔案 13 個測試，共 181 個 |
| `pnpm -C web build` | 通過（demo：JS 238 kB / gzip 76 kB，CSS 14 kB） |
| demo dev server | `:5183` 回 200；`/api/*` 轉到 `:8120`（伺服器未啟動時 proxy 回 `ECONNREFUSED 127.0.0.1:8120`，確認轉址正確） |

`Makefile` 的 `web-check` 原本就會在 `web/package.json` 存在時跑 typecheck / test / build，現在 `make check` 會包含 web。

## 套件結構

```
web/
├── package.json            scripts: dev / typecheck / test / build（pnpm -r --if-present）
├── pnpm-workspace.yaml     packages/*、apps/*，catalog: 統一版本
├── tsconfig.base.json      strict、noUncheckedIndexedAccess、verbatimModuleSyntax、bundler resolution
├── packages/client/        @tangent/client — 不依賴 React
│   └── src/
│       ├── types.ts            domain JSON 形狀（Line、LineView、Message、BranchView、BranchPack、BranchCard、BranchDraft、Note、Chapter、Prompt…）
│       ├── api-types.ts        §7 的 request / response（暫定）
│       ├── errors.ts           TangentError、DOMAIN_ERROR_CODES、錯誤 envelope 解析
│       ├── capabilities.ts     §11 功能名稱與模式、GET /capabilities（暫定）
│       ├── api.ts              createTangentClient({ baseUrl, headers?, fetch? })
│       ├── events.ts           subscribeEvents()：fetch + ReadableStream 的 SSE、jitter 退避重連、每種事件的型別化 handler（review 後改寫）
│       ├── sse.ts              text/event-stream 增量解析（review 新增）
│       ├── wire.ts、line-normalize.ts、result-normalize.ts   回應與事件的正規化（review 新增）
│       ├── i18n-keys.ts        純邏輯會產生的訊息 key（ClientMessageKey）與 TranslateFn
│       ├── text.ts             charCount、truncateChars、sortBySeq
│       ├── lib/layered-layout.ts
│       ├── branch-*.ts、chapters.ts、aside-note.ts、notes.ts   移植的純邏輯
│       └── testing.ts          測試共用（echoT、message()），不從 index 匯出
├── packages/react/         @tangent/react — 目前只有骨架
│   └── src/
│       ├── provider.tsx        TangentProvider（client、tenant?、locale?、messages?）+ useTangent / useTangentClient / useTangentT / useTangentKeys
│       ├── i18n/               en.ts、zh-TW.ts、types.ts、index.ts（createTranslator、resolveLocale、interpolate）
│       ├── query-keys.ts       tangentKeys({ baseUrl, tenant })
│       └── styles.css          `--tg-*` CSS 變數（light / dark / data-theme）+ Tailwind 4 `@theme inline`
└── apps/demo/              Vite React，port 5183，/api → http://localhost:8120（可用 TANGENT_API_PROXY 覆寫）
```

套件採 宿主 / multica 的「內部套件」模式：`exports` 直接指向 `.ts` / `.tsx` 原始碼，由 demo（以及之後的宿主）的 bundler 編譯，
所以 client 與 react 沒有 `build` script；`pnpm build` 只建 demo，但會把兩個套件一起編譯過。

## 版本

`pnpm-workspace.yaml` 的 catalog 用 宿主 `web/package.json` 相同的範圍；實際解析出的版本跟 宿主 目前安裝的完全一致：

| 套件 | catalog 範圍 | 解析版本 |
|---|---|---|
| react / react-dom | 19.2.3 | 19.2.3 |
| @tanstack/react-query | ^5.96.2 | 5.104.1 |
| zustand | ^5.0.0 | 5.0.15 |
| @base-ui/react | ^1.3.0 | 1.8.0 |
| lucide-react | ^1.0.1 | 1.52.0 |
| tailwindcss / @tailwindcss/vite | ^4.1.0 | 4.3.3 |
| vite | ^7.1.0 | 7.3.7 |
| @vitejs/plugin-react | ^5.0.0 | 5.2.0 |
| vitest | ^4.1.0 | 4.1.11 |
| jsdom | ^29.0.1 | 29.1.1 |
| @testing-library/react | ^16.3.2 | 16.3.3 |
| @testing-library/jest-dom | ^6.9.1 | 6.10.0 |
| typescript | ^5.9.3 | 5.9.3 |
| @types/react / @types/react-dom | ^19.2.0 | 19.3.0 |
| @types/node | ^22.18.0 | 22.20.5 |

Node 22（`engines`）、pnpm 9.15.0（`packageManager`）。`zustand`、`@base-ui/react` 先列在 `@tangent/react` 的 dependencies，元件在之後的步驟才會用到。

## 移植的檔案與測試

來源都是 宿主 `web/src/sessions/`（唯讀）。測試先移植並確認失敗（RED，模組不存在），再寫實作。

| 宿主 | tangent `@tangent/client` | 原測試 → 現在 |
|---|---|---|
| `lib/layered-layout.ts`（原本沒有測試） | `lib/layered-layout.ts` | 0 → 5（新增） |
| `sessions/branch-tree.ts` | `branch-tree.ts` | 19 → 19（刪 1、改 3、加 1） |
| `sessions/branch-map-layout.ts` | `branch-map-layout.ts` | 11 → 11 |
| `sessions/chapters.ts` + `chapter-types.ts` | `chapters.ts`（型別在 `types.ts`、`api-types.ts`） | 10 → 10（每個 `it.each` 少一個 case，見下） |
| `sessions/branch-card.ts` | `branch-card.ts` | 10 → 10（一個加了 noteChanges 斷言） |
| `sessions/branch-normalize.ts` | `branch-normalize.ts` | 3 → 6 |
| `sessions/branch-errors.ts` | `branch-errors.ts` | 5 → 6 |
| `sessions/branch-card-errors.ts` | `branch-card-errors.ts` | 2 → 3 |
| `sessions/branch-title.ts`（原本沒有測試） | `branch-title.ts` | 0 → 2 |
| `sessions/branch-input.ts` | `branch-input.ts` | 8 → 10 |
| `sessions/branch-move.ts` | `branch-move.ts` | 9 → 10 |
| `sessions/branch-promote.ts` | `branch-promote.ts` | 5 → 4 |
| `sessions/aside-note.ts` | `aside-note.ts` | 3 → 3 |
| `sessions/branch-export.ts` | `branch-export.ts` | 9 → 9 |
| `sessions/notes.ts`（任務清單外，純邏輯，筆記元件會用到） | `notes.ts` | 4 → 4 |
| `sessions/branch-draft-flow.ts`（任務清單外，結論卡起草的純 reducer） | `branch-draft-flow.ts` | 7 → 11 |
| `sessions/branch-types.ts`、`chapter-types.ts` | `types.ts`、`api-types.ts` | — |

新寫（非移植）的測試：`api.test.ts` 8、`events.test.ts` 5、`errors.test.ts` 5（含一個比對 `domain/errors.go` 錯誤碼清單的防漂移測試）、
`capabilities.test.ts` 3、`index.test.ts` 1；react 套件 `i18n.test.ts` 6、`query-keys.test.ts` 3、`provider.test.tsx` 4。

i18n 文案從 宿主 `web/src/i18n/{en,zh-TW}.branch.ts`、`.branchMove.ts`、`.branchNav.ts`、`.chapters.ts` 移植。

### 刪掉的測試（功能不存在於 tangent）

- `branch-tree.test.ts`「readsFrom and readSource labels」：`readsFrom` / `readSource` 是 宿主 執行環境（worktree），DESIGN §4.5 已移除。
- `branch-promote.test.ts`「explains why an investigation cannot be promoted」：DESIGN §4.3 規定任何直接掛在主線下的支線都能升級，不限 kind。
- `branch-errors.test.ts`「appends the verbatim backend text for daemon errors only」：daemon 錯誤碼與 `original` / `nextStep` 欄位都拿掉了。
- `branch-errors.test.ts` 的 `it.each` 少了 `not_agent_session`、`daemon_offline`、`main_daemon_offline`、`main_daemon_mismatch` 四個 case；
  `chapters.test.ts` 的 `it.each` 少了 `not_agent_session`（tangent 沒有這些錯誤碼）。

### 改寫的測試

- `branch-tree` 的 `branchRowState`：「waiting > queued > unread」改成「error > thinking > unread」（tangent 沒有 `awaitingUser` / `turnQueued`，
  改用 `BranchView.lineStatus`）；`summarizeBranchAttention` 拿掉 `branchWaiting` 與 `awaiting_input`，加一個「保留最強的標記」。
- `branch-draft-flow` 的 `draft_unavailable` 改為 `feature_disabled`（`card_draft` 功能被關閉時的碼），另加 4 個 start failure / restart 測試。
- 所有 `ApiError(status, msg, undefined, {code, ...})` 改為 `TangentError(status, msg, code, extra)`；錯誤訊息的斷言改用 `echoT`
  （回傳 key 與參數的假翻譯函式），不再依賴實際字典，字典另由 react 套件的 i18n 測試覆蓋。

## 改名與行為差異

| 宿主 | tangent |
|---|---|
| `sessionId` / `parentSessionId` / `rootSessionId` | `lineId` / `parentLineId` / `rootLineId` |
| `Session`、`normalizeSession` | `LineView`、`normalizeLine`（只補 `conversationBranch`、`branchCounts`、`branchUnread`） |
| `SessionMessage`、`meta.kind` | `Message`、頂層 `kind`（`chat` / `branch_card` / `branch_marker`） |
| role `agent` | `assistant` |
| `BranchView.sessionStatus`、`awaitingUser`、`turnQueued`、`readsFrom` | `lineStatus`；其他三個刪除 |
| `ConversationNote`、`sourceSessionId` | `Note`、`sourceLineId` |
| `BranchDraft.startedAt: string` | `string \| null`，另有 `uptoSeq`、`parentTipMessageId`（domain 有） |
| `agentId` / `mainAgentId`（建立、搬移表單） | `provider` / `mainProvider` |
| `ApiError.body` | `TangentError.extra`（envelope 去掉 `error`、`code` 之後的欄位）；`code` 一律是字串，沒有時是 `""` |
| `open_branches_on_old_tail` 的 extra `sessionIds` | `lineIds`（domain/errors.go） |
| 匯出標籤 `labels.session`、FreeMind attribute `session` | `labels.line`、attribute `line` |

行為上的刻意差異：

1. **排序一律用 `seq`**：`planMove`、`countLaterMessages`、`asideAnswer` 先依 `seq` 排序，不信任陣列順序（CLAUDE.md 規則）。各加一個測試。
2. **錯誤分類看 code，不看 HTTP 狀態**：宿主的 `classifyReturnError`、`isBranchStateError`、`isDepthSoftLimit` 同時檢查 409 / 422；
   tangent 的 httpapi 狀態碼對應還沒定（S4），而 code 才是契約，所以只看 code。只有 413（body 上限，沒有 envelope）與 403 仍看狀態碼。
   `branch-draft-flow` 的「其他 409 → blocked」保留原樣（domain 錯誤預設就是 409）。
3. **上限從錯誤的 extra 讀**：`branch_limit`、`tree_limit` 的文案改成 `{limit}`（原本寫死 8 / 200），值從 extra 取，沒有時用 domain 預設；
   `milestone_limit` 讀 `maxMilestones`、`invalid_milestone` 讀 `maxLength`（domain/errors.go 的 `errorExtraFor`）。
4. **promote**：`promoteBlock` 只剩 `notOpen` / `notTopLevel`（DESIGN §4.3）。
5. **未知錯誤碼**（例如宿主 `TurnGate` 自己的碼）顯示後端訊息；沒有訊息時顯示 `branch.errorUnknown`。
6. `buildMergeBody` 多一個可選的 `noteChanges` 參數，有內容才放進 body（合約 §5 merge 可同時套用筆記變更）。
7. `cardReducer`、`buildBranchTree` 等維持原本的不可變寫法；`buildBranchTree` 與 `branch-map-layout` 內部對區域累加器的 push 保留（不外洩）。

i18n 文案的修改（其餘逐字移植）：

- `branch.errorSourceBusy` / `ParentBusy` / `BranchBusy` / `SessionBusy`：拿掉「或有排隊的回合」（tangent 沒有 turn queue）。
- `branch.errorAsideAnswered`：zh-TW「順口問」改為 DESIGN 的用語「岔題」，en「quick question」改為「aside」。
- `branch.errorNoteLimit`：zh-TW「紀要」改為「筆記」（DESIGN §2）。
- `chapters.errorViewer`：「需要 operator 權限」改為「唯讀身分不能分段」（tangent 沒有角色，只有 `CanWrite`）。
- 刪除 `branch.errorNotAgent`、`errorDaemonOffline`、`errorMainDaemonOffline`、`errorMainDaemonMismatch`、`errorBranchAskOnly`、
  兩個 `NextStep`、`chapters.errorNotAgent`。
- 新增 demo 殼層用的 `shell.*`。`branch.status*` 一併帶入（之後的大綱元件會用）。

## 設計決定

- **i18n 分層**：client 不帶字典，只匯出 `CLIENT_MESSAGE_KEYS` / `ClientMessageKey` 與 `TranslateFn`；react 的字典型別由 `en` 推導，
  `i18n/types.ts` 有編譯期檢查，缺任何 client key 就 typecheck 失敗；測試另外檢查兩種語言 key 集合相同、`{slot}` 相同。
  `TangentProvider` 的 `messages` 是宿主覆寫，順序：宿主覆寫 → 該語系 → en → key。`locale` 收任何 BCP 47，`zh*` 一律用 zh-TW。
- **Query key**：`["tangent", baseUrl, tenant, ...]`，line 底下的 key（messages、stream、branches、branch、notes、chapters）都以
  `line(id)` 為前綴，invalidate 一條線就全部刷新。baseUrl 去掉尾端斜線再放進 key。
- **CSS token 前綴 `--tg-`**，Tailwind 類別是 `bg-tg-surface`、`text-tg-muted` 等。避免嵌入 宿主 時跟它的 `--background`、
  `--color-background` 互相覆蓋。代價是移植 宿主 元件時要把 `bg-background` 之類換成 `bg-tg-background`。
  主題：預設 light、OS 偏好 dark 時 dark、`data-theme="light|dark"`（`<html>` 或任何容器）優先。
- **SSE**：~~EventSource~~ 已改為 fetch + ReadableStream，見下方「Review 修正」M5。

## 暫定的 API 型別（S4 完成後要逐一核對）

全部在 `web/packages/client/src/api-types.ts`、`events.ts`、`capabilities.ts`，標了 `PROVISIONAL`：

- `GET /lines` → `{ lines: LineView[], nextCursor }`；`GET /messages` → `{ messages }`；`GET /stream` → `{ deltas }`；`GET /branches` → `{ branches }`
  （也可能是裸陣列）。
- `POST /lines` body（`title`、`provider`、`model`、`hostMeta`；宿主能否指定 id？）。
- `POST /lines/{id}/messages` body `{ content, hostMeta? }`；202 `{ turnId, userMessage, pendingMessage }` 是 §7 寫明的。
- `POST /branches`、`/branches/move` 的回應 `{ branch, line, pack }`（+ `marker`、`movedMessageIds`、`reparented`）；
  `/branch/merge` → `{ branch, message, line, notes? }`；`/branch/promote` → `{ branch, previousMainLine, line, reparented }`；
  `/branch/discard` → `{ branch }`。
- `/branch/draft`、`/compact` → `{ jobId }`。
- `/archive`、`/unarchive`、`/read`、`/cancel`、`DELETE /lines/{id}`、`DELETE /milestones/{mid}` 假設不需要回應內容（型別是 `void`）。
- `GET /notes` → `{ rootLineId, revision, notes, limits }`；`POST /notes` 是單筆 `CreateNoteInput`（還是 `ApplyNoteChanges` 的清單？）；
  寫入回 `{ note, superseded?, revision }`。
- `GET /chapters` → `{ lineId, rootLineId, chapters, milestones, limits }`。
- `POST /preview` → `{ prompt: Prompt, tokenEstimate }`。
- ~~`GET /capabilities` → `{ features: [{ name, mode }] }`~~ 已定案為 `{name, enabled, mode?}`（DESIGN §12）。
- SSE：每則訊息是 `{ type, tenant, rootLineId, lineId, data }` 的 JSON，SSE event 名稱等於 `type`；Go 的 `tangent.Event` 目前沒有 JSON tag。

## 未決問題

1. ~~**SSE 認證**~~（已決：DESIGN §12 改用 fetch SSE）：`EventSource` 不能帶自訂 header，所以 `createTangentClient` 的 `headers()` 掛勾對 `/events` 無效。
   要用 cookie、query token，還是改用 fetch 串流的 SSE？目前留 `createEventSource` 讓宿主自己接。
2. **錯誤碼 → HTTP 狀態**：httpapi 的對應表（`Config.StatusFor`）定案後，確認 413 / 403 之外前端真的不需要看狀態碼；
   `CanWrite` 拒絕時回什麼 code？
3. ~~**capabilities**~~（已決：DESIGN §12）：沒有 AI 的功能（notes、chapters…）開啟時回報什麼 mode？目前假設 `auto`，`isFeatureOn` 只判斷不是 `off`。
4. ~~**宿主自訂錯誤碼的文案**~~（已決：DESIGN §12，見 review 修正）：`TurnGate` 的碼（例如 宿主 接回時的 `daemon_offline`）目前只顯示後端訊息；之後是否讓
   `describeBranchError` 接受宿主的 code → key 對照？
5. ~~**notes / chapters 的 limits**~~（已決：DESIGN §12，回應帶上限）：宿主 回應帶 `limits`，tangent 的 Engine 是否也回傳（`domain.Limits` 可由宿主調整）？
6. ~~**merge 的嚴格解碼**~~（已決：DESIGN §12，與 宿主 一樣嚴格）：宿主的 merge 是嚴格解碼，所以 `buildMergeBody` 省略空欄位；tangent httpapi 是否同樣嚴格（影響是否可送 `mainLineMessageId: ""`）。
7. `domain/errors.go` 在本步驟期間被平行修改（新增 `job_not_found`、`job_not_pending`），已同步；`errors.test.ts` 會在兩邊不一致時失敗。
8. ROADMAP S5 的 Playwright e2e 還沒做（要等參考伺服器）。

## Review 修正（2026-10-15，W0 已提交為 239e72e 之後）

依 review 與 DESIGN §12 新增的決定修正，每一項都有回歸測試。閘門（在 repo 根目錄）：`pnpm -C web install` / `typecheck` / `test` / `build`
全部通過；測試數：client 24 個檔案 215 個、react 5 個檔案 23 個，共 238 個（W0 時 181 個）。

### HIGH

- **H1 回應與事件未經正規化**：新增 `wire.ts`（從 `unknown` 讀值的基本函式）、`line-normalize.ts`（Line、Message、MessageMeta、Delta、Summary、Prompt）、
  `result-normalize.ts`（每一個 API 回應），`branch-normalize.ts` 與 `chapters.ts` 的正規化改為接受 `unknown`。`createTangentClient` 的
  每個方法都把 2xx body 交給對應的正規化函式；Go 的 nil slice（`null`）、缺欄位、型別不對、未知列舉值都轉成預設值。
  `parseEvent` 先確認 `data` 是物件，再依事件型別用 `DATA_NORMALIZERS` 驗證與補值（`branch.changed` 的 `change` 不認得就丟錯交給 `onError`）。
  測試：`line-normalize.test.ts`、`result-normalize.test.ts`、`branch-normalize.test.ts`、`api.test.ts`「normalizes every body」、
  `events.test.ts`「normalizes payloads」。
  - 未知的 note `section` 不強制轉換，原樣保留（見 LOW notes）；未知的 message role 轉成 `system`、kind 轉成 `chat`。

### MEDIUM

- **M1**：2xx body 不是 JSON → `TangentError(status, "invalid JSON response", "invalid_response")`。新增 `CLIENT_ERROR_CODES`
  （`invalid_response`、`invalid_id`），不在 domain 錯誤碼清單內，防漂移測試不受影響。
- **M2**：非 JSON 的錯誤 body 只有 `Content-Type: text/plain` 才會成為訊息，且截到 `ERROR_TEXT_MAX`（200 字）加「…」；
  其他（例如 proxy 的 HTML 錯誤頁）用 statusText 或 `HTTP n`。`errorFromResponse` 多一個 `contentType` 參數。
- **M3**：`resolveLocale`、翻譯查表、`interpolate` 一律用 `Object.hasOwn`，`toString` / `constructor` 不會被當成語系或訊息。
- **M4**：`TangentProvider` 用 ref + 淺比較穩定 `messages`，同內容的新物件不會讓 context 重算；新增 `scopeKey`（登入身分）加進每個
  query key（`["tangent", baseUrl, tenant, scopeKey, …]`）。身分改變時宿主仍要呼叫 `queryClient.clear()`（寫在 prop 與 `tangentKeys` 的註解）。
- **M5 SSE 重做**（DESIGN §12）：不再用 `EventSource`。`subscribeEvents` 用 `fetch` 讀 `ReadableStream`，`TextDecoder` 串流解碼，
  `sse.ts` 依 WHATWG 規格增量解析（LF / CR / CRLF、跨 chunk、註解、`id`、BOM；`retry:` 忽略，退避由我們管）。
  - `headers()` 與新的 `credentials` 選項同時用在 REST 與 SSE；`client.subscribe({...})` 自動帶入 url、headers、credentials、fetch。
  - 退避加 jitter：`delay = min(maxMs, initialMs × factor^n) × (1 − jitter × random())`，預設 jitter 0.5。
  - `attempt` 只在連線穩定 `stableMs`（預設 5 秒）或收到第一則訊息後歸零，單純 open 不算。
  - 新增 `onReconnect`：斷線後再次 open 時呼叫（第一次 open 不呼叫），宿主據此重抓資料。
  - typed handler 與 `onEvent` 各自 try/catch，例外交給 `onError(error, raw)`，後續事件照常處理；HTTP 錯誤以 `TangentError` 回報後繼續重連。
  - `close()` 中止 fetch、取消待重連與穩定計時器。
- **M6**：`buildBranchTree` 的兄弟排序改比 `Date.parse` 的時間值（RFC 3339 去掉小數尾零時字串排序會錯），同時間再比 `lineId`，
  無法解析的時間排最後。
- **M7**：上限改為參數、預設值不變：`validatePurpose(purpose, max)`、`prepareExcerpt(text, max)`、`planMove(messages, startId, max)`、
  `noteDraft(answer, max)`、`validateNote(text, max)`、`buildNoteChanges(rows, max)`（現在真的會截到 max）。刪掉 `branch-errors.ts`
  重複的 `BRANCH_MOVE_LIMIT`，改用 `branch-move.ts` 的 `BRANCH_MOVE_MAX`。
- **M8**：`--tg-subtle` 淺色 `#706a5e`（對 background / surface / surface-sunken 都 ≥ 4.5:1；review 建議的 `#756f63` 在 sunken 上只有 4.22）、
  深色 `#8a867d`；淺色 `--tg-ring` 改 `#0d9488`（≥ 3.17:1）；`--tg-muted` 淺色加深為 `#5c574d` 以維持與 subtle 的層次。
  深色區塊去重：每個顏色只定義一次 `light-dark(淺, 深)`，`:root { color-scheme: light dark }` 跟隨 OS，`[data-theme]` 強制，
  token 也宣告在 `[data-theme]` 上，所以巢狀容器也能換主題。Tailwind 輸出保留原生 `light-dark()`（需要 Chrome 123、Firefox 120、Safari 17.5）。
  測試 `styles.test.ts` 讀取 `styles.css?raw` 計算對比並檢查每個 token 只宣告一次（vitest 設定 `css.include` 讓 raw 匯入拿得到內容）。
- **M9**：`@tangent/react` 的 peer 改成 `^19.2.3`（react、react-dom）與 `^5.96.2`（react-query），不用 `catalog:`；`package.test.ts` 檢查。

### LOW 與設定

- `chapterRange` 的「同一天」改用顯示時區的日曆日判斷（不再比 UTC 字串），`chapterTitle` / `chapterRange` 多一個可選 `timeZone`。
- 結論卡草稿逾時：`startedAt` 是伺服器時間、`now` 是瀏覽器時間，所以只在超過 `DRAFT_TIMEOUT_MS + DRAFT_CLOCK_SKEW_MS`（60 秒）才放棄；
  宿主有伺服器時間（例如回應的 Date header）時可傳 `serverNow`，此時不加寬限。domain 的 `BranchDraft` 沒有 elapsed / deadline 欄位，
  伺服器本身會把逾時草稿當成 failed（`EffectiveBranchDraftStatus`），所以伺服器狀態仍是主要依據。新增 `isDraftOverdue`。
- 路徑 id 為 `""`、`.`、`..` 時在送出前拒絕（`TangentError(0, …, "invalid_id")`，以 rejected promise 回傳）。
- `groupNotes` 多一個 `other` 桶放不認得的 section，不再丟掉。
- `shell.tsx` 的分頁 id 用 `as const`，拿掉非空斷言。
- client 的 tsconfig 拆成兩份：`tsconfig.json`（原始碼，`types: []`，確保函式庫不用 Node API）與 `tsconfig.test.json`（測試，帶 node 型別）；
  react 拿掉 `node` 與 `vitest/globals` 型別。`@tangent/react` 移除尚未使用的 zustand、@base-ui/react、lucide-react、@types/node
  （catalog 仍保留版本，之後元件用到時再加回）。`provider.test.tsx` 的 `messages` 改用 `HostMessages` 型別。

### DESIGN §12 決定的落實

- **宿主自訂錯誤碼**：顯示伺服器文字；宿主要翻譯就在 `TangentProvider messages` 加 `error.<code>` 項目。新增型別 `HostMessages`、
  `createHostErrorText`、context 的 `hostErrorText`；`describeBranchError(error, t, hostText?)`、
  `describeChapterError(error, t, { limits?, hostText? })` 只對沒有內建文案的碼詢問宿主（內建碼不能被覆寫，要改內建文案用原本的 key）。
- **capabilities**：每項 `{name, enabled, mode?}`；`mode` 只保留在已開啟的 AI 功能，缺或不合法時當作 `manual`；`isFeatureOn` 看 `enabled`；
  `featureMode` 未開啟回 `off`，已開啟的非 AI 功能回 `auto`。
- **SSE**：fetch + ReadableStream（見 M5）。

### 期間同步的 domain 變更

`domain/errors.go` 在這段期間又新增 `concurrent_change`、`id_unavailable`（防漂移測試抓到），已加入 `DOMAIN_ERROR_CODES`。

### 仍待 S4 確認

- 回應 body 與 SSE envelope 的形狀仍是暫定（上方「暫定的 API 型別」），正規化函式會吃掉缺欄位，但欄位名稱不對時只會變成預設值，要靠 S4 的整合測試抓。
- `featureMode` 對非 AI 功能回 `auto` 只是方便判斷，元件應該用 `isFeatureOn`。
