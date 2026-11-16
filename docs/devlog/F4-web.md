# F4 · P1 介面（階段 1）：收尾、停車場、建議匣、紀要 `sourceLabel`、「待處理」分頁

> 2026-10-16。依該階段工單，只做**階段 1**（獨立成新對話、樹平衡等協調者通知）。
> 只動了 `web/` 與 `docs/devlog/`（本檔與 `screenshots/F4/`），沒有改 Go，沒有 commit。
> 後端 B8 階段 B 在做的同時 commit 了（`43dbb8a`）；結束前依協調者通知重新讀了樣本（101 檔），client 的型別與契約測試已對上，階段 B 的介面仍留給階段 2（見「契約」）。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過（fonts、client、react、demo、e2e） |
| vitest（逐一套件） | fonts **9**、client **535**（F3/R5 後 443）、react **560**（513）、demo **72**（66），共 1176 |
| `pnpm -C web build` | 通過。主 JS **179.87 kB gzip**（R5 後 176.4；上限 180） |
| Playwright | 全套 **101 passed、17 skipped**（mock 61、api 43、api-core 14 個；skip 都是刻意的：依伺服器的功能組合只跑對應的那一組，api-core 沒有 P1 功能） |
| axe | 待處理分頁（moderate+，1440）、收尾編輯中的支線條（moderate+）、不帶回與展開種子的對話框（moderate+）、420 嵌入與 375 手機整頁（serious+） |

以上都是在 `43dbb8a`（B8 階段 B 已 commit）之上跑的；Playwright 的真 API 伺服器也是用它建置。

## 做了什麼

### 1. `@tangent/client`
- 型別（`types.ts`）：`Leaf`、`LeafSummary`、`LEAF_KINDS`、`Seed`、`Suggestion`；`BranchView.leaf`、`BRANCH_ORIGINS` 加 `seed`、`LineView.openSuggestions` / `openSeeds`。
- `p1-routes.ts`：12 條新路由的輸入型別與 normalizer（`GET/PUT/DELETE /leaf`、`/leaf/draft`、seeds 五條、suggestions 三條）；`discardBranch(lineId, {leaf})`；`api.ts` 加 `PUT`。
  `status` 查詢參數原樣傳（`open` 預設、`all`、逗號分隔）。`acceptSuggestion` 預設送 `{}`、`expandSeed` / `noteSeed` 預設送 `{}`（同樣本），`dismiss` / `drop` 不送本文。
- `p1.ts`（純邏輯）：`leafLine` / `validateLeafLine`（一行、≤ 200）、`discardLeafBody`（空白原因＝不送 `leaf`）、`leafPresentation`（draft / ai / confirmed）、`leafProblems`（`invalid_leaf` 的欄位原因）、
  `seedFromText`（120 字）、`seedLimitState`（90% 起「快滿了」）、`seedOrigin`（種子來自主線 #n、已載入的支線 #n、沒載入的線、沒有訊息）、`hasInbox`、`inboxCount`、`suggestionReason`。
- 事件：`leaf.changed`、`seeds.changed`、`suggestion.changed`；功能 `suggestions`；錯誤碼 6 個進 `DOMAIN_ERROR_CODES`（`errors.test` 對 `domain/errors.go` 比對）。
- mock：`mock-leaves.ts`（讀寫、草稿依模式、discard 的原因寫成死路、merge 寫結論、promote 為原本的主線起草）、`mock-inbox.ts`（種子五條、建議三條、`[probe:suggest]` / `[probe:suggest-permanent]` 的測試建議、支線結束時建議過期）、
  `recount` 帶主線的 `openSeeds` / `openSuggestions`、新紀要帶 `sourceLabel`（同 `domain.NoteSourceLabels` 的繁中模板）。情境 1 加上原型的收尾（四條）、三顆種子、一則測試建議。
  `mock-contract.test` 走一遍所有 P1 路由；`sourceLabel` 這種 `omitempty` 欄位不比形狀（`notes.list` 與 `notes.list.rich` 的第一筆一個有、一個沒有），另外測 mock 寫的有來源紀要都帶它。

### 2. `@tangent/react`
| 元件 / hook | 內容 |
|---|---|
| `Leaf` | 一行、圖示 12、gap 4；五種類型的圖示（結論 Flag、決定 Gavel、答案 CornerDownRight、死路 Ban、待續 Hourglass）與 `--tg-leaf-*` 顏色；類型名稱預設只給螢幕閱讀器（`showKind` 才顯示）；AI 草稿虛線 `--tg-suggestion` 並標「AI 草稿・待你確認」；auto 模式 AI 寫的標「AI 做的」 |
| `BranchLeaf` | 結束的支線條上的收尾：收尾與「展開詳述」；草稿「確認」一鍵確認；「修改」開表單（類型、一句話含字數、詳述；Enter 存、Esc 取消且不讓頁面收到；欄位錯誤顯示伺服器原因）；沒有收尾時「寫收尾」「請 AI 起草」（manual 只有這顆按鈕），起草中顯示狀態直到 `leaf.changed` 帶來草稿；唯讀身分只看 |
| `SeedCard` | 待處理（展開成支線、記進紀要〔`notes` 開才有〕、丟掉）、已展開（「到支線」）、已記進紀要、已丟掉（劃掉）；「來自 主線 #n」可點跳到那則訊息 |
| `SuggestionCard` | 虛線 `--tg-suggestion` 卡片：種類、「關於：對象」、理由、接受 / 忽略；已接受、已忽略、已過期沒有按鈕；不認得的種類顯示原字 |
| `InboxPanel` | 「待處理」：停車場（`parking` 開）＋建議（`suggestions` 開），各有標題與數量（「4・不花 token」「1・等你決定」）、空狀態、載入與重試；停車場 90% 起提示快滿、滿了提示上限；這次在頁面上處理掉的項目留在原處並標出結果，直到分頁關閉 |
| hooks | `useLeaf` / `usePutLeaf` / `useStartLeafDraft`、`useSeeds` / `useExpandSeed` / `useNoteSeed` / `useDropSeed`、`useSuggestions` / `useAcceptSuggestion` / `useDismissSuggestion`（`p1-hooks.ts`，只有懶載入的部分用）；`useCreateSeed`（`park-hooks.ts`，輸入框用）；`writeLeaf`（`leaf-cache.ts`） |
| SSE | `leaf.changed` 精準寫入收尾、大綱與支線詳情的 `leaf`；`seeds.changed`、`suggestion.changed` invalidate 那棵樹的清單；數量跟著主線的 `line.updated` |
| `DiscardBranchDialog` | `leaf` 開時多「原因（選填）」與「會成為這條支線的「死路」收尾」；有原因送 `{leaf: {line}}`（壓成一行，> 200 字擋下）；`leaf` 關閉時沒有這欄、不送 `leaf` |
| `OpenBranchDialog` | `request.seed`：目的預填種子文字，標「從停車場展開」，送 `POST /seeds/{id}/expand`（沒有模型與「之後的訊息」選項，伺服器決定分岔點） |
| 大綱、地圖、結論卡 | `leaf` 開時：大綱列的最後一行是收尾（列名稱也念出「死路：…」）、地圖節點第二行是收尾、結論卡標題列用收尾的類型圖示與那一句；關閉時照舊（`conclusionLine`、旗子） |
| `SideTabs` 規則 | 「待處理」只在 `parking`、`suggestions` 或 `open_loops` 開時出現（不再因為某個 AI 功能是建議模式就出現） |
| 紀要來源 | 有 `sourceLabel` 時優先用它（連結照舊），沒有時退回原本的算法 |
| `BranchBar` | `leaf` 插槽，支線結束後顯示 |
| 錯誤文字 | `describeError` 加 `seed_not_open`、`seed_not_found`、`seed_limit{limit}`、`suggestion_not_open`、`suggestion_not_found`、`leaf_not_found`、`invalid_leaf`；`describeBranchError` 認得展開種子時的兩個種子錯誤 |
| i18n | `en.p1.ts` / `zh-TW.p1.ts`（收尾、停車場、種子、建議、待處理、紀要；英文的收尾沿用設定頁的 “Ending”）；拿掉沒人用的 `shell.inboxLater`、`shell.mockAction` |

### 3. demo
- 「待處理」分頁（懶載入 `inbox-side`）取代 `MOCK_INBOX_COUNT` 與占位；數量 = `inboxCount(capabilities, 主線 LineView)`，常駐（含 0）。
- 停車（`park-actions.ts`）：輸入框旁「停車」與 ⌘⇧S（整段輸入框文字，≤ 500 字；伺服器收下才清空；空的提示「先在輸入框寫下念頭，再按停車。」；超過 500 字不送並提示）、訊息動作「停車」（前 120 字）、選取工具列「停車」（選取的文字），都以那則訊息為來源；順口問支線條的「停車」（目的＋答案）。成功提示「已停車・不花 token」。`parking` 關閉或不能寫時都不出現，⌘⇧S 不做事。
- 展開種子：用種子訊息所在的線（主線或畫面上的支線）開對話框；找不到時用主線最後一則（伺服器照 DESIGN §12 的規則決定真正的分岔點）。
- 支線條：結束的支線（順口問除外）有 `BranchLeaf`。

### 4. e2e（`p1.spec.ts`，mock 與真 API；真 API 的伺服器加 `suggestion_probe`）
| 寬度 | 測試 | mock | 真 API |
|---|---|---|---|
| 1440 | 收尾：帶回後結論卡標題列與大綱是結論收尾；不帶回寫原因 → 死路；改成待續並確認；重新載入後仍在（只真 API） | ✓ | ✓ |
| 1440 | 收尾：不帶回不寫原因 → suggest 模式的 AI 草稿（虛線、「AI 草稿・待你確認」）→ 確認 | ✓ | ✓ |
| 1440 | 停車四個入口（按鈕、⌘⇧S、訊息動作、選取工具列）、數量 0→4、來源連結、記進紀要（紀要的待確認出現）、丟掉、展開成支線（對話框預填、到新支線、卡片標「已展開成支線」）、axe | ✓ | ✓ |
| 1440 | 建議匣：`[probe:suggest]` → 數量 1 → 接受（已接受，數量 0）；`[probe:suggest-permanent]` → 忽略 | ✓ | ✓ |
| 1440 | 功能關閉：沒有「待處理」、沒有停車按鈕、⌘⇧S 不動輸入框、沒有收尾；mock 的 C1 組合不帶回時沒有原因欄 | C1 | api-core |
| 420 嵌入 | 從輸入框停車，大綱覆蓋層的「待處理」看得到，axe | ✓ | ✓ |
| 375 | 停車、底部抽屜的「待處理」、按鈕高 ≥ 44、丟掉後數量回 0，axe | ✓ | ✓ |

其他 e2e 的調整：`features.spec` 的訊息動作與輸入框按鈕在 parking 開時多「停車」；`smoke.spec` 的待處理數量從原型寫死的 6 改成情境的實際數（3 顆種子＋1 則建議＝4）；`playwright.config.ts` 的 `api` 伺服器明確帶 `TANGENT_FEATURES`（階段 A 的預設＋`suggestion_probe`），`api` / `api-core` 的 testMatch 加 `p1`。

截圖：`UPDATE_SCREENSHOTS=1 pnpm -C web/e2e e2e p1` → `docs/devlog/screenshots/F4/`（leaf、leaf-draft、parking 1440 / 420 / 375、suggestions，mock 與真 API 各一）。與原型 B1 / B3 / B5 對照：待處理的停車場與建議兩段、卡片樣式（停車場白底卡片＋右側動作、建議虛線紫底）、收尾的圖示與顏色相符。

## TDD 紀錄

先寫測試、確認紅燈再實作：
- client：開工時契約測試就是紅的（93 個失敗：新樣本沒有對應的 client 呼叫、`openSeeds` 等欄位、錯誤碼）；`p1-routes.test`、`p1.test` 先寫（紅：模組不存在）。
- react：`p1-hooks.test`（紅：模組不存在）、`leaf.test`、`inbox.test`（紅：模組不存在）；`layout.test` 的待處理規則與 `note-source.test` 的 `sourceLabel` 優先（紅：各 1）；不帶回的原因（紅：2）；展開種子的對話框（紅：2）；大綱、地圖、結論卡的收尾（紅：3）。
- demo：`park-actions.test`（紅：模組不存在）。
- 沒有留下紅燈紀錄的：`mock-p1.test`（mock 的行為測試，在 mock 寫完後才寫，一次通過）；`BranchBar` 的收尾插槽（測試與實作同一步）；e2e。

## 與設計的差異、決定

1. **處理過的項目留在原處**：清單只列 open 的；這次在頁面上展開、記進紀要、丟掉、接受、忽略的項目（寫入的回應）存在 TanStack 的一個不會去抓的快取項目，分頁開著時接在清單後面並標出結果（元件規格的狀態表）。關掉分頁或重新整理就不再顯示。
2. **種子來源**：`Seed` 只有 `anchorMessageId`。前端只在主線與畫面上這條線的訊息裡找；在別條支線停的種子顯示「來自 另一條線的訊息」、沒有連結（見後端缺口 1）。
3. **停車的文字**：訊息動作取前 120 字（同記進紀要）；選取取選到的（≤ 500）；輸入框整段（≤ 500，超過不送）。
4. **收尾只在結束的支線條上編輯**；順口問的支線條不顯示收尾（答完自動結束的順口問不會起草，避免在保存列旁多一組按鈕）。大綱裡順口問若有收尾照樣顯示。
5. **結論卡標題列**：`leaf` 開時是收尾那一句（使用者改過就是改過的），不是卡片的 `conclusion`。
6. **不帶回的原因**壓成一行送出（收尾的 `line` 是一行）；空白時不送 `leaf`，suggest / auto 模式由伺服器起草。
7. **「待處理」出現的條件**改成 `parking`、`suggestions`、`open_loops` 任一開啟（DESIGN §12 F0 列與 B8 的 `suggestions` 能力），原本「任何 AI 功能是建議模式」的判斷拿掉。
8. **`sourceLabel` 優先**：伺服器預設是繁中模板，英文介面也會看到「主線 #n」，除非宿主用 `WithNoteSourceLabels` 換成英文。
9. **主 JS**：剛做完是 180.65 kB。把只有懶載入部分用的 hooks（`p1-hooks.ts`）與 `Leaf` 元件從主程式常用的模組拆開（`park-hooks.ts`、`leaf-cache.ts`、`leaf-meta.ts`），並拿掉重複的錯誤文字，降到 179.85 kB（加上階段 B 的型別後 179.87）。剩下的增加主要是兩種語言的 P1 文字（約 2.5 kB gzip），餘裕只有約 0.13 kB。
10. mock 的測試建議看「使用者訊息」裡的 `[probe:…]`（mock 的回覆是情境寫死的，不會回聲）。

## 契約

- 階段 A 的 23 個樣本（20 條路由、3 個事件）列入 `EXPECTED_SAMPLES`，client 契約測試與 mock 契約測試都通過。
- 階段 B（`43dbb8a`，101 檔）：只做到 client 讀得懂、契約測試通過，**沒有介面**（階段 2）：
  - `LineView.spunOffFrom`、`Message.meta.spunOffTo`、`Note.copiedFromNoteId`、`Link`、事件 `link.changed`、`branch.changed{detached}`（`spinoff-routes.ts`，先寫 `spinoff-routes.test.ts` 看到紅燈）；
  - `client.spinoff`、`client.listLinks`；mock 先回 `mock_unsupported`，`mock-contract` 把這兩條列在「還不模擬」；
  - mock 契約比對把建議的 `payload` 與接受的 `result` 當成功能自己的自由內容（probe 與 rebalance 的不同），和 `meta` / `hostMeta` 一樣不比形狀；
  - `branch.changed{detached}` 時對話清單重新讀取；
  - 種子展開的新規則（結束的線 → 沿分岔點往上找最近的進行中祖先線）：mock 照做（有測試，先紅後綠），demo 開對話框時也照大綱往上找。
- `LineView.openSuggestions` 現在只算開著的功能（後端修正）；前端原本就依 `/capabilities` 算數量，不用改。
- 參考伺服器的預設功能多了 `spinoff`、`rebalance:suggest`；Playwright 的 `api` 伺服器明確帶階段 A 的組合＋`suggestion_probe`，階段 1 的 e2e 不受影響（不會冒出介面還不認得的樹平衡建議）。階段 2 再改成新預設。
- `contract-samples.ts` 加 `TANGENT_CONTRACT_DIR`（只給測試用）：後端改寫樣本期間可以對某個 commit 的樣本跑。

## 後端缺口與問題（給協調者 / 後端）

1. `Seed` 沒有錨點訊息所在的線（例如 `anchorLineId`）或來源文字；停在沒載入的支線上的種子前端無法標「#n」也無法跳轉，展開對話框的父線也只能照規則推（伺服器的決定才是真的）。
2. `GET /seeds` 沒有上限資訊；前端用預設 100（`SEED_OPEN_MAX`）提示快滿，滿了則用 `seed_limit` 的 `limit`。要不要像 `/notes` 一樣回 `limits`？
3. 收尾草稿的 job 失敗時沒有事件，畫面上的「AI 正在起草收尾…」會一直等到離開或重新整理。需要一個失敗通知（事件或可查的 job 狀態）。
4. 建議的 `payload` 只有 probe 的 `reason`；階段 B 的種類若要顯示對象名稱與動作，最好在 payload 帶 `title` / 動作清單，或在契約裡說明各種類的 payload。
5. `sourceLabel` 的語言由伺服器決定；英文介面要英文就要宿主設定（見決定 8）。可以接受嗎？

## 階段 2（等通知）

獨立成新對話（B2）、樹平衡提示（B4）、mock 的 spinoff / links、對應的 e2e。

---

# 階段 2（2026-10-16）：獨立成新對話、樹平衡，以及 B8.1 的接線

> 依協調者的通知做（階段 1 已 commit 為 `8317e61`）；結束前重新讀了樣本（`ddf4423`，103 檔）。只動了 `web/` 與 `docs/devlog/`，沒有改 Go，沒有 commit。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過（5 個專案） |
| vitest（逐一套件） | fonts **9**、client **557**、react **578**、demo **72**，共 1216 |
| `pnpm -C web build` | 通過。主 JS **179.30 kB gzip**（階段 1 結束時 179.87；先騰出空間再加階段 2，見下） |
| Playwright | 全套 **115 passed、24 skipped**（mock 68、api 50、api-core 21 個；skip 都是刻意的：只跑對應功能組合的那一組，api-core 沒有 P1 功能）；連跑兩次都綠 |
| axe | 獨立成新對話的對話框（moderate+）、新對話整頁、樹平衡提示所在的支線條（moderate+）、375 手機與 420 嵌入整頁（serious+） |

## 先騰出主程式的空間

P1 的文字改成**跟著懶載入的部分走**：`i18n/bundle.ts`（`useBundleT`：先看宿主的覆寫、再看這包的語言、再看這包的英文，最後交給 provider 的字典）與 `i18n/p1-messages.ts`（收尾編輯、停車場、建議匣、不帶回原因、展開種子、獨立對話框、樹平衡）。
只有一直載入的程式要用的留在主字典（`en.p1.ts` / `zh-TW.p1.ts`：收尾類型、停車提示、B8 錯誤、功能名稱、「已獨立 →」「來自：…」「從這裡開新對話」）。
宿主仍可以用 `TangentProvider messages` 改這些字（`HostMessages` 的型別含 `P1MessageKey`）；provider 多帶 `messages`，新增 `useUiLocale()`。這樣主 JS 從 179.87 降到 178.70，加完階段 2 是 179.30。

## 做了什麼

### client
- `spinoff-routes.ts`（階段 1 末已讀得懂的形狀）＋ `spinoff.ts`：`spinoffModes`（進行中且非順口問的支線可整條獨立；有訊息就可從那則開新對話）、`capsuleEstimate`（沒有預覽路由，前端估算起始膠囊：背景包、到這則為止的對話〔最近 8 則〕、收尾、紀要快照；整條獨立時列出「訊息 n 則與子支線一起搬過去」但不算進膠囊；超過 6000 token 提示會先丟背景）、
  `rebalanceOf`（`feature: rebalance`、`kind: promote_or_spinoff` 的 payload）、`rebalanceResultOf`、`lastSpinoff`（線上最新的 `spunOffTo` 標記）。
- B8.1：`Seed.anchorLineId`、`Seed.sourceLabel`、`GET /seeds` 的 `limits`、`GET /leaf` 與 `leaf.changed` 的 `draftError`。
- mock：`mock-spinoff.ts`（detach：支線變主線、子孫搬家、父線留標記、連結、`copyNotes`、事件順序同伺服器；fresh；links；樹平衡：最近 5 則都在支線〔且至少 5 則〕或 ≥ 6 且 ≥ 父線 2 倍時提一筆，接受先標 accepted 再執行、失敗退回 open，維持是永久的）、
  種子的 `anchorLineId`（讀取時算）與 `sourceLabel`（寫入時存）、`limits`、`[fake:error]` 讓收尾草稿失敗並帶 `draftError`。mock 契約測試對同一路由的多個樣本（fresh / detach）比對任一次呼叫的形狀；`payload`、`result` 是各功能自己的內容，不比形狀。

### react
| 元件 / hook | 內容 |
|---|---|
| `SpinoffDialog` | 原型 B2：方式（整條支線 / 從最後一則或從這則開全新對話；只有一種時不顯示選項）、新對話標題、「新對話一開始會帶 ≈ n token」（估算並說明上限）、「複製目前的紀要到新對話」（`notes` 開才有）、兩邊連結的說明；經由樹平衡建議時改送 `POST /suggestions/{id}/accept {action: "spinoff"}` |
| `RebalanceHint` | 支線條上的虛線建議列：原因（「最近 5 則回覆都在這條支線。」或「分岔後已有 n 則，上一層只有 m 則」）、升為主線 / 獨立 / 維持（只列伺服器說能做的）；不彈窗、不搶焦點 |
| `SuggestionCard` | 樹平衡種類：同樣的原因與三個選擇（升為主線、獨立交給宿主開確認，維持＝忽略） |
| `PromoteBranchDialog` | `suggestionId` 時用 `accept {action: "promote"}` 升為主線 |
| `BranchBar` | 「獨立成新對話」按鈕、「已獨立 →「標題」」（從這條支線開過新對話時）、`hint` 插槽 |
| 訊息清單 | 標記訊息有 `meta.spunOffTo` 時顯示「已獨立成新對話」與「已獨立 →「標題」」連結；回覆的動作多「從這裡開新對話」 |
| `SpinoffOrigin` | 新對話頂端「來自：標題」，回到來源那則訊息 |
| hooks | `useSpinoff`、`useAcceptRebalance`；`link.changed` invalidate `links`；`branch.changed{detached}` 重新讀對話清單 |
| B8.1 | `BranchLeaf`：收到 `draftError` 就結束「AI 正在起草收尾…」，顯示「AI 沒能起草收尾（執行失敗／輸出不能用／逾時／發生錯誤）。」與「再試一次」；再起草時先清掉舊的錯誤。待處理的種子來源改用 `sourceLabel`＋`anchorLineId`（舊伺服器沒有時退回原本的算法）；快滿／已滿的提示用回應的 `limits.maxOpen` |

### demo
- 支線條：獨立成新對話（開對話框）、「已獨立 →」連到新對話、樹平衡提示（建議匣與 `rebalance` 都開時，從這棵樹的建議找關於這條支線的那一筆；升為主線、獨立開確認對話框，維持直接忽略）。
- 回覆的「從這裡開新對話」；新對話頂端「來自：…」；完成後切到新對話。
- 待處理的樹平衡卡片用同樣的確認對話框。
- 展開種子時優先用 `anchorLineId`，再沿大綱往上找進行中的祖先線。

### e2e（`p2.spec.ts`）
| 寬度 | 測試 | mock | 真 API |
|---|---|---|---|
| 1440 | 整條支線獨立：對話框（方式、背景、複製紀要、axe）→ 新對話（「來自：…」、訊息跟著過來、對話清單有它）→ 回來源（「已獨立 →」、大綱不再有它）→ 再前往 | ✓ | ✓ |
| 1440 | 從回覆開新對話：沒有方式選項、膠囊有「到這則為止的對話（2 則）」、改標題、新對話是空的 | ✓ | ✓ |
| 1440 | 樹平衡：支線 5 輪後出現提示、焦點仍在輸入框、沒有對話框、axe；待處理有同一筆；維持後消失且再一輪也不再出現；另一條支線「獨立」經由建議 | ✓ | ✓ |
| 1440 | 樹平衡：「升為主線」經由建議 | ✓ | ✓ |
| 1440 | 功能關閉：沒有「從這裡開新對話」與「獨立成新對話」 | C1 | api-core |
| 375 | 從回覆開新對話（全螢幕對話框、axe） | ✓ | ✓ |
| 420 嵌入 | 樹平衡提示在窄的支線條裡不溢出、axe | ✓ | ✓ |

`playwright.config.ts`：`api` 伺服器改用參考伺服器的真正預設（含 `spinoff`、`rebalance:suggest`）＋測試用的 `suggestion_probe`（階段 1 的建議匣測試用）。`features.spec` 的回覆動作在 spinoff 開時多「從這裡開新對話」。
截圖：`UPDATE_SCREENSHOTS=1 pnpm -C web/e2e e2e p2` → `screenshots/F4/` 的 spinoff-dialog / spinoff-new / spinoff-375 / rebalance-1440 / rebalance-420（mock 與真 API）。

## TDD 紀錄
先寫、看到紅燈：client `spinoff.test`（模組不存在）、`mock-spinoff.test`（7 個）、`p1-routes.test` 的 B8.1 欄位、`mock-p1.test` 的 `draftError`；react `spinoff.test.tsx`（模組不存在）、`leaf.test` 的 `draftError`、`inbox.test` 的種子來源（看到「另一條線的訊息」而不是標籤）；i18n 的懶載入字典測試。
沒有紅燈紀錄：`lastSpinoff`、支線條與升為主線經由建議的測試、對話框裡來源標題的修正（e2e 截圖發現「來自：」寫成支線自己的標題，修正後才補測試）、e2e。

## 與設計的差異、決定
1. **起始膠囊是前端估算**：沒有預覽路由（後端缺口 1）；對話框標「這裡是估算」與上限。
2. 「從這裡開新對話」只在 AI 回覆的動作上（使用者訊息的動作列只有「從這則起搬成支線」）。
3. 順口問不提供「獨立成新對話」（伺服器允許 detach 任何進行中的支線；順口問一問一答，獨立沒有意義）。
4. 「升為主線」「獨立」在提示與待處理都先開確認對話框（同一般的升為主線、獨立）；「維持」不確認，直接忽略（永久）。
5. 支線條的「已獨立 →」只看這條支線自己的訊息裡最新的標記（從支線用 fresh 開過新對話時）；整條獨立後原支線已不在原樹。
6. 懶載入的文字包（上面「先騰出主程式的空間」）。
7. `api` e2e 伺服器的 `TANGENT_FEATURES` 列出預設功能再加 `suggestion_probe`；預設功能若再改，這裡要跟著改。

## 後端缺口與問題
1. 沒有預覽起始膠囊的路由（`POST /lines/{id}/spinoff/preview` 之類回 `rendered` 與 `tokenEstimate`）；對話框只能估算。
2. 新對話的「來自：…」只有快照標題；來源被刪除時連結會失效（前端無法事先知道）。要不要在 `spunOffFrom` 加 `exists` 或讓 `GET /links` 帶狀態？
3. `rebalance` 的 `parentTurns` 在「上一層」是支線時，文字寫「上一層」而不是「主線」；若希望精確，payload 可帶 `parentIsMain`。

---

# R7 修正（2026-10-16）

依該階段工單 的「交給實作 agent 的修正」D1–D4。只動了 `web/` 與本檔；沒有改 Go，沒有 commit。基準是 `4168ad2`。R6 只改了 `route.suggestions.accept.spinoff` 這個樣本，client 的契約測試照常通過。

## 變更
- **D1 每張卡各自的狀態**：`InboxPanel` 的 `useItemStates` 改成以 id 為鍵，分別記錄每張卡進行中的動作與錯誤。每個動作改用 `mutateAsync`，各自等自己的 promise。
  - 原因：TanStack v5 的 `mutate(vars, callbacks)` 只會對共用 mutation 的最後一次呼叫觸發 per-call 回呼。兩張卡同時操作時，第一張的錯誤和結束狀態都會遺失。
- **D1 掃過整個 `web/`，同類用法一起修**（同一個 mutation 實例會被連續呼叫，又依賴 per-call 回呼的地方）：

| 位置 | 問題 | 處理 |
|---|---|---|
| `react/src/inbox/inbox-panel.tsx`（記進紀要、丟掉、接受、忽略） | 兩張卡同時操作，第一張的結果遺失 | `mutateAsync`；狀態以 id 為鍵 |
| `demo/src/frame/park-actions.ts` `park` | 連續停車時，前一次的提示（含失敗）遺失 | `mutateAsync`，每次停車各自提示 |
| `demo/src/frame/note-actions.ts` | 連續記進紀要時，前一次的提示（含失敗）遺失 | `mutateAsync` |
| `demo/src/shell.tsx` 新對話 | 連按兩次時，只會切到最後一次建立的對話 | `mutateAsync`，每次都切到自己建立的對話 |
| `react/src/structure/chapter-list.tsx` 加里程碑 | 沒擋重複送出 | 進行中時不再送出 |
| `react/src/branch/card-review/use-card-review.ts` 帶回 | 按鈕擋住了，但 ⌘Enter 之類的入口沒擋 | 進行中時不再送出 |

  以下不必改：對話框類（開支線、展開種子、獨立、升為主線、不帶回、搬移、記進紀要、收尾的儲存、確認與起草）都已經在進行中時擋住再送出，或用按鈕的 loading 擋住，所以同時只會有一次呼叫。
  沒有 per-call 回呼的呼叫（封存、刪里程碑、重試、停止、改標題、改模型、維持）也不受這個問題影響。
- **D2 「已獨立 →」不靠事件也會出現**：`useSpinoff` 與 `useAcceptRebalance` 成功後，還會 invalidate 標記所在的那條線。
  - 那條線是 `link.fromLineId`；沒有時，spinoff 用來源線，接受樹平衡用建議所指的支線。
  - 支線的查詢鍵掛在它自己底下，不在主線底下，所以原本只 invalidate 整棵樹的前綴碰不到它。
- **D3 停車不重複送出**：二選一，選的是**送出中擋住**。
  - 輸入框的文字一直留著，等伺服器收下才清空；被拒絕時文字還在，可以再按一次。
  - 送出中再按（按鈕或 ⌘⇧S）不做事。
  - 沒選「先清空、失敗再還原」：那樣還原時可能蓋掉使用者在等待期間新打的字。
  - `park` 改用 D1 的做法。
- **D4 原因與問句接在一起**：改用一個鍵 `rebalance.sentence`，英文是 `"{reason} {ask}"`，繁中是 `"{reason}{ask}"`。待處理的卡片只顯示原因，不受影響。

## 測試（先寫、確認紅燈再實作）
- react `inbox.test`：兩張卡同時丟掉，兩張都顯示進行中；第一張失敗後只有它顯示錯誤，第二張成功後顯示已丟掉。
  - 紅燈：第二次點擊後，第一張已經不在進行中。
  - 這個測試第一版用計時器，在整套一起跑的負載下會不穩，改成由測試控制兩個 promise 何時結束。
- react `p1-hooks.test`（不掛事件串流），紅燈 2 個：
  - 從支線用 fresh 開新對話後，那條支線的訊息出現標記；
  - 把支線底下的支線整條獨立後，標記出現在上一層支線。
- react `spinoff.test`：英文 “…since then. Make it…” 中間有空格，繁中「只有 2 則。要升為主線」中間沒有。紅燈：英文少了空格。
- demo `park-actions.test`：送出中連按兩次 ⌘⇧S，只建立一顆種子、只提示一次。紅燈：建立了兩顆。

## 閘門
- typecheck 通過。
- vitest 逐一套件：fonts 9、client 557、react 582、demo 73。
- build 通過，主 JS 179.33 kB gzip。
- Playwright 全套 115 passed、24 skipped（都是刻意的）。

---

# B8.2 接線（2026-10-16）

依協調者的通知，把 B8.2（`3dc5513`，105 個樣本）接上。只動了 `web/` 與本檔；沒有改 Go，沒有 commit。後端另一個 agent 同時在改 B9 的 Go 程式，工作目錄的 Go 一度編不過（`domain` 少了 B9 的符號）。所以真 API 的 e2e 伺服器改從 HEAD 的副本建置，見「其他」。

## 變更
- **client**
  - `SpinoffRef.available`：舊伺服器沒送這個欄位時，當成還在。
  - `client.previewSpinoff`（`POST /lines/{id}/spinoff/preview`）與 `SpinoffPreview`。
  - 樹平衡的 `parentIsMain`、`parentTitle`：舊 payload 當成「掛在主線」。
  - 事件 `summary.due`。
  - 拿掉前端估算起始膠囊的 `capsuleEstimate`（已經有伺服器的預覽）。
  - 契約測試加 `route.spinoff.preview` 與 `event.summary.due`。
- **mock**
  - `previewSpinoff`：檢查規則同 spinoff，不寫入；`notesToCopy` 只在 `copyNotes` 時計數。
  - `available` 在讀取時判斷：`LineView.spunOffFrom` 在 `recount`，標記的 `meta.spunOffTo` 在 `GET /messages`。
  - 樹平衡 payload 帶 `parentIsMain`、`parentTitle`。
- **獨立成新對話的對話框**
  - 起始膠囊改用伺服器的預覽：「≈ n token」、「看起始膠囊的內容」（可收合、可捲動、可用鍵盤聚焦的 `<pre>`）、「紀要 n 條會複製過去」、被截斷時的提示。
  - 改方式或勾選複製紀要時重新預覽。預覽讀不到時說明原因，仍可以建立。
  - 整條獨立時另列「訊息 n 則與子支線一起搬過去」，這個數字是前端算的，不在膠囊裡。
- **對話已刪除**：`available: false` 時只寫名字、不做成連結。
  - 原對話的標記：「已獨立 →「標題」（對話已刪除）」。
  - 新對話頂端：「來自：標題（對話已刪除）」。
  - 支線條上的「已獨立 →」同樣處理。
- **樹平衡的用語**
  - 掛在主線：「這條支線分岔後已有 n 則回覆，主線分岔後只有 m 則。」
  - 掛在別的支線：「…「父線標題」分岔後只有 m 則。」
  - 英文同樣分兩種。
- **建議整理摘要**（`summary.due`，`summary` 在建議模式時才會發）
  - 這是暫時的提示，記在 live store 的 `summaryDue`，不是伺服器狀態。
  - 帶著較新 `summary.updatedAt` 的 `line.updated` 到了，或使用者回應過，就清掉。
  - 輸入框上方出現虛線的「建議整理摘要」：「整理摘要」送 `POST /compact`（新 hook `useCompact`），「稍後」收起。不彈窗，不搶焦點。
  - 唯讀身分沒有輸入框，所以不會出現。
  - 元件與它的文字都懶載入，要等到真的該摘要時才下載。

## 主程式大小
接完是 180.10 kB，超過上限。把建議整理摘要的元件與它的文字改成懶載入（主程式只留旗標與 `useSummaryDue`），降到 **179.64 kB gzip**。

## 測試（先寫、確認紅燈再實作）
- client，紅 8 個：
  - `spinoff-routes.test`：`available` 的預設與讀取、預覽的形狀；
  - `spinoff.test`：`parentIsMain` / `parentTitle` 與舊 payload；
  - 契約測試的 4 個（detach、fresh、preview、`summary.due`）。
- react，紅 5 個，另有 1 個新檔：
  - 對話框顯示伺服器的 token、膠囊文字、要複製的紀要條數、被截斷的提示；
  - 「主線」與「「父線」」兩種用語；
  - 對話已刪除時是文字不是連結；
  - `summary-due.test.tsx`（新檔，模組不存在）：事件寫入、較新的摘要清掉、整理摘要呼叫 `compact`、稍後收起、不搶焦點。
- mock 的預覽與 `available`（`mock-spinoff.test`）：和實作一起寫，沒有留下紅燈紀錄。
- e2e `p2.spec`：
  - 新增只在真 API 跑的測試：刪掉新對話後，回到原對話看到「（對話已刪除）」，而且沒有連結。
  - 對話框的測試改成檢查伺服器的 token 與膠囊文字（含 axe）。
  - 這裡抓到一個 axe 問題：膠囊文字長到會捲動時，`scrollable-region-focusable` 不過。已把 `<pre>` 改成可以聚焦。
- 建議整理摘要沒有 e2e：fake runner 的短回覆很難把對話推過摘要門檻，改由元件與事件的單元測試涵蓋。

## 其他
- `e2e/scripts/start-api.sh` 加 `TANGENT_E2E_SRC`：有人正在改工作目錄的 Go 時，可以從另一份 Go 程式建置伺服器。
  - 這次用的是 `git archive HEAD`（`3dc5513`）解到 scratchpad 的副本。
  - 協調者驗證時，如果 B9 已經 commit 或工作目錄編得過，就不需要這個變數。

## 閘門
- typecheck 通過。
- vitest 逐一套件：fonts 9、client 560、react 588、demo 73。
- build 通過，主 JS 179.64 kB gzip。
- Playwright 全套（伺服器從 HEAD 建置）：**116 passed、26 skipped、0 failed**，含 axe。
  - 共 142 個：mock 69、api 51、api-core 22。
  - skip 都是刻意的。

## 後端缺口與問題
沒有新的。B8.2 已經補上 F4 先前列的 spinoff 預覽、`available`、父線用語與摘要訊號。
