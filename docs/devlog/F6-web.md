# F6 · P3 介面（階段 1）：論證類型（D2）、折疊（D4）

> 2026-10-17。工作單（`089a770`）的階段 1，依 B10 階段 A（`5c3fdd9`，158 個樣本）。只動了 `web/` 與本檔；沒有改 Go，沒有 commit。
> 後端 B10 階段 B 同時在改工作目錄的 Go（樣本多了 `route.folds.update`、`route.comparisons.*`），所以契約與錯誤碼的測試對 HEAD（`089a770`）的副本跑
> （`TANGENT_CONTRACT_DIR`、`TANGENT_DOMAIN_ERRORS_GO`），真 API 的 e2e 伺服器也從那份副本建置（`TANGENT_E2E_SRC`）。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過 |
| vitest（逐一套件，契約對 HEAD 副本） | fonts **9**、client **753**、react **744**、demo **82** |
| `pnpm -C web build` | 通過。主 JS **175.80 kB gzip**（F5 結束時 173.84）。標記控制、折疊區塊、折疊對話框、P3 文字都在各自的延遲載入塊（`arg-tag`、`fold-block`、`p3-messages`、`branch-flows`） |
| Playwright | 全套 **170 passed、53 skipped、0 failed**（共 223：mock 96、api 78、api-core 49；skip 都是刻意的）。連跑兩次都一樣 |
| axe | 標記（1440，主欄 moderate+）、折疊區塊展開後（1440，主欄 moderate+）、折疊對話框（moderate+）、地圖的論證類型圖層（側欄 moderate+）、420 嵌入與 375 手機（serious+） |

## 做了什麼

### client
- 型別：`TAG_KINDS`（問題／想法／贊成／反對／決定）、`MessageTag {kind, source ai|user, status draft|confirmed, updatedAt}`；`Message.tag?`、`BranchView.anchorTag?` 只在有的時候出現（同伺服器的 omitempty，契約樣本逐鍵相等）；不認得的種類不當成任何一種。
- `fold-routes.ts`：`Fold`（`drafting / active / failed / removed`）、`FoldList`（含 `limits`，伺服器沒給時用預設）、`FoldCreated {fold, job | null}`、`fold.changed`；`PreviewTurnResult.folds?: AppliedFold[]`；魚眼項目多 `kind: fold`。
- API：`tagMessage`（PUT）、`untagMessage`（DELETE）、`listFolds`、`createFold`、`deleteFold`。錯誤碼加 `fold_not_found`、`fold_overlap`、`fold_limit`、`invalid_fold`（`describeError` 都有句子，`fold_limit` 帶上限）。
- 純邏輯 `folds.ts`：`canTag`（完成的 user / assistant 聊天訊息）、`foldSpans`（一條線的 live 折疊各蓋住哪些已載入的訊息，依 seq）、`foldEndOptions`、`foldSuggestionOf`（含每輪省下的 token）。
- mock（`mock-p3.ts`）：標記（只有變了才發 `message.updated`；不能標的 → `invalid_input`；功能關 → `feature_disabled`）、AI 起草的標記（suggest 每一輪後把最新、還沒標的訊息標成 user → 問題、AI → 想法、`draft`；auto 寫 `confirmed`；從不取代任何標記；`[fake:job-error]` → `job.failed{ibis_tag}`）、`anchorTag`、折疊（同伺服器的檢查與錯誤；沒摘要 → drafting + job，`draftMs` 後寫好或失敗並發 `job.failed{fold_summary}`）、預覽套用 active 折疊（歷史裡換成一則 system 項目、魚眼裡是一個 `fold` 項目、`folds` 報告）、折疊建議（每 10 個回覆找最舊、已結束、≥ 8 則、≥ 1000 token 的章節；拒絕是永久的）。
  mock 專用的捷徑：使用者訊息有 `[fake:fold-suggest]` 時，馬上提議折疊這條線最前面 4 則（demo 與 e2e 用；伺服器要等第 10 個回覆）。

### react
| 元件 | 內容 |
|---|---|
| `ArgTag`（D2，components.md：h22 select；五種類型；AI 標、可改） | 每則完成的聊天訊息標籤列上的原生 select（顏色＝類型 token，§9-7 的「標籤＝論證類型」）；沒標時是「類型…」。AI 的草稿是虛線、寫「AI 標・待確認」並有「確認「想法」」；選一個類型就變成使用者的；「不標類型」清除。唯讀只顯示類型的字（沒標就什麼都沒有）。結論卡、進行中的回覆不能標。延遲載入（第一次顯示時才下載） |
| 大綱 | `ibis` 開時支線列寫出分岔那則訊息的類型（`anchorTag`），名稱念「分岔處是「問題」」；AI 草稿是虛線框 |
| 地圖的「論證類型」圖層 | 圖層列多「論證類型」（`ibis` 開時才有，預設關）；開了節點右上角寫類型、名稱念出來 |
| `FoldBlock`（D4，components.md：r・p 10/12、gap 10；收合、展開原文） | 折疊範圍內的訊息收成一個區塊，放在第一則的位置：「已折疊 #20–#31」、「送給 AI 時只送摘要：180 token（原本 4.2k）」、摘要；按鈕（`aria-expanded`）展開原文（原本的訊息列，可照常操作，但不能再開始另一個折疊）；起草中「AI 正在寫摘要…」（減少動態時不閃）；失敗時說明；「取消折疊」。唯讀不能取消。延遲載入 |
| `FoldDialog` | 訊息動作「從這則起折疊…」打開：「折疊到」選後面的一則（`#n 你／AI：摘錄`）、摘要（留白由 AI 起草，最多 1000 字）；沒有可選的就說明並停用。依（線、起點）重設（R9） |
| 送出前預覽 | 「折疊」段列出這一輪套用的折疊（`#a–#b：n 則，送 x token（原本 y）`）；魚眼清單的折疊項目叫「折疊 #a–#b」並帶摘要 |
| 建議匣 | `fold` 建議：「建議折疊章節「需求盤點」（15 則），每輪約可省 3.1k token」與摘要；接受即折疊 |
| 資料層 | `useTagMessage`（標記與清除；同時改快取裡的訊息與大綱的 `anchorTag`）、`useFolds`、`useCreateFold`、`useDeleteFold`；`fold.changed` 讓那條線的折疊與預覽重載；`message.updated` 若只改了已完成訊息的標記（內容、狀態沒變），只更新訊息與大綱的 `anchorTag`，不當成回合的事件（不重載預覽、不動串流狀態） |

demo：對話欄接上標記（`ibis` 開時）、折疊（`fold` 開時）與「從這則起折疊…」（寫入權限），branch-flows 多 `fold` 流程；全幅地圖接上論證類型圖層。

### e2e（新檔 `f6.spec.ts`；真 API 的伺服器加 `ibis:suggest,fold:suggest`）
| 寬度 | 測試 | mock | 真 API |
|---|---|---|---|
| 1440 | AI 起草的標記是虛線、「AI 標・待確認」→ 確認 → 鍵盤改成「決定」（真 API 重載後還在）；axe | ✓ | ✓ |
| 1440 | 把回覆改標「問題」→ 從它開支線 → 大綱念「分岔處是「問題」」→ 地圖開「論證類型」→ 節點寫「問題」；axe | ✓ | ✓ |
| 1440 | 從第一則「從這則起折疊…」到第 4 則（AI 起草）→ 摘要與 token → 展開看到 4 則原文 → 預覽的「折疊」段 → 取消折疊；axe | ✓ | ✓ |
| 1440 | 折疊建議從待處理來、不彈出 → 接受 → 對話裡出現折疊區塊。真 API 照伺服器的規則（5 輪長訊息、milestone、再 5 輪）；mock 用 `[fake:fold-suggest]` | ✓ | ✓ |
| 1440 | 功能關：沒有標記控制、沒有「從這則起折疊…」、沒有折疊區塊 | C1 | api-core |
| 420 | 嵌入：標記控制不超出 420、折疊對話框與區塊；axe | ✓ | ✓ |
| 375 | 手機：標記 select 與折疊的展開鈕 ≥ 44px，觸控選類型、展開；axe | ✓ | ✓ |

`features.spec` 的訊息動作清單多了「從這則起折疊…」（`fold` 開著的組合）。

截圖：`screenshots/F6/tags-1440`、`fold-1440`、`fold-420`、`fold-375`（mock 與真 API）。與原型 D2 / D4 對照：標記的 select 在訊息標籤列、顏色依類型；折疊區塊的標題、「送給 AI 時只送摘要：… （原本 …）」、摘要與展開原文都相符；差異見下。

## TDD 紀錄

先寫、看到紅燈：client 契約 13 個新樣本（開工時就紅）與 `errors.test`、`fold-routes.test` 與 `folds.test`（模組不存在）、`mock-p3.test`（模組不存在；之後 `[fake:fold-suggest]` 1 紅）；react `event-sync.test`（2 紅）、`p3.test`（模組不存在）、`message-list.test`（2 紅）、`outline-tree.test` 的 `anchorTag`（1 紅）、`map-tags.test`（2 紅）、`turn-preview.test` 的折疊（1 紅）、`inbox.test` 的折疊建議（1 紅）。
沒有紅燈紀錄（實作同時或之後寫）：`p3-hooks.test`、`error-text.test` 的折疊錯誤句子、e2e。過程中修的既有測試：`events.test`（20 種事件）、`mock-client.test` 的事件順序（AI 標記的 `message.updated` 排在回合結束之後）、`mock-groups.test` 的 `job.failed`（改成找對應的 kind）。

## 與設計的差異、決定

1. **標記用原生 select**（components.md 寫 h22 select）：鍵盤、螢幕報讀、手機都是平台的行為；手機上高度 44px。
2. 地圖的論證類型圖層**預設關**、**沒有依類型篩選**（原型 D2 有篩選鈕）：篩選要嘛隱藏節點、要嘛用透明度，而透明度是魚眼的通道；先只做標籤，篩選留到需要時再討論。
3. 大綱的類型用 `anchorTag`（支線分岔那則訊息的類型，DESIGN §12 已定）。
4. 折疊區塊放在第一則被折疊的訊息的位置；區塊裡的訊息展開後是原本的訊息列（可以照常操作），但不能再開始另一個折疊。區塊裡第一則之外的訊息的章節分隔線不顯示。
5. 折疊的範圍用「從這則起折疊…」＋選結束的一則，而不是原型 D4 的「拖選一段 → 浮動工具列」：既有的文字選取工具列是選文字用的，跨訊息拖選在觸控上也難；兩步的對話框鍵盤可達。
6. 改摘要：B10 階段 B 才有 `PATCH /folds/{fid}`；在那之前要改就「取消折疊」後重建。
7. 起草中與失敗的折疊也收合顯示（失敗的可以取消後重試）；只有 `active` 會套用到 prompt。
8. `message.updated` 只改了已完成訊息的標記時不當成回合事件（見資料層）；AI 每一輪標兩則，不這樣做每一輪會多重載兩次預覽。
9. mock 的 `[fake:fold-suggest]`（見 client 的 mock）。

## 後端缺口與問題

沒有缺口。一個問題：`message.updated` 對 AI 標記是一則訊息一個事件；之後若一次標很多則（`BatchMax` 12），會連發 12 個事件。前端已經只做精準更新，目前沒問題；若要合併成一個事件請先告訴我。

# 階段 2（2026-10-18）：發散與收斂（D3）、折疊改摘要

> 依 B10 階段 B（`6249ca9`，170 個樣本）。只動了 `web/` 與本檔；沒有改 Go，沒有 commit。後端階段 C（memory）同時在改 Go，契約、錯誤碼與真 API 的 e2e 都用 HEAD（`6249ca9`）的 `git archive` 副本。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過 |
| vitest（逐一套件，契約對 HEAD 副本） | fonts **9**、client **784**、react **758**、demo **82** |
| `pnpm -C web build` | 通過。主 JS **176.49 kB gzip**（階段 1 結束時 175.80）。D3 的元件、文字與 hooks 都在延遲載入塊（`diverge-marker`、`compare-table`、`branch-flows` 裡的對話框、`p3-messages`）；主程式只多了訊息動作、列表的插槽、事件與錯誤碼 |
| Playwright | 全套 **172 passed、54 skipped、0 failed**（共 226：mock 97、api 79、api-core 50），最後連跑兩次都一樣。之前兩次各有 1 個紅燈，見「過程」 |
| axe | 給我幾個方向的對話框（moderate+）、發散標記與比較表（1440，主欄 moderate+）、420 嵌入與 375 手機（serious+） |

## 做了什麼

- **client**：`comparison-routes.ts`（`Comparison`、`ComparisonMatrix`（分數 1–5，其他當 0 顯示「—」）、清單與上限、`ConvergeStarted`、`DecideResult`、`comparison.changed`）、`BRANCH_ORIGINS` 加 `diverge`；
  API：`diverge`（202）、`converge`、`listComparisons`、`getComparison`、`decideComparison`、`updateFold`；錯誤碼 `comparison_not_found / not_ready / decided`、`invalid_comparison`（都有句子）。
  純邏輯 `diverge.ts`：`divergeGroups`（一條線上、同一則訊息發散出來的支線）、`convergeProblem`、`cellOf`、`optionLabel`。
- **mock**（`mock-diverge.ts`，比較存在 state 裡）：發散（同伺服器的檢查：數量、anchor、`進行中 + N ≤ 8`；`draftMs` 後一次開 N 條 `Direction n (fake runner)`，開不了就 `job.failed{diverge}`）、收斂（drafting → ready，條件用使用者的或 `Fit (fake runner)`，第 1 個 5 分、第 2 個 4 分…，建議 O1；選項有 `[fake:job-error]` → failed + `job.failed{converge}`）、決定（選定的寫 `decision` 收尾並維持進行中，其他進行中的放棄並寫 `Not chosen: went with …` 的 `dead_end`；事件順序同伺服器）、`updateFold`（變 active、`aiDrafted: false`，起草中的 job 不再寫入）。
- **react**：
  | 元件 | 內容 |
  |---|---|
  | `DivergeDialog`（給我幾個方向） | 回覆的動作「給我幾個方向…」打開；方向數 2–5（單選，預設 3，方向鍵可選）；送出後等到 N 條都出現在大綱才關（「AI 正在想 N 個方向…」），失敗（`job.failed` 或拒絕）說明原因。依（線、回覆）重設 |
  | `DivergeMarker`（components.md：虛線 `--tg-primary`、p 12） | 在那則回覆底下取代那幾條在分岔清單裡的位置：每個方向的則數、目的、收尾或狀態、前往；勾 2–5 條進行中的、條件（一行一個，可留白）→「比較 n 條」；下面是這幾條最新的比較表。唯讀只看 |
  | `CompareTable`（components.md：最小欄寬 120、格 p 8/10） | 有 caption 的表格（列＝條件、欄＝方向，每格分數與理由，建議的那欄淡綠底）；建議與理由；「決定採用」單選（預設建議的）、決定的一句話（可留白）、「產生「決定」收尾」；決定後寫「決定：…；其他 n 條以「未帶回」收尾。」起草中、失敗各有說明。分數不能改（沒有路由，見差異） |
  | `FoldBlock` 改摘要 | 「改摘要」→ 原地編輯（Esc 取消）→ 儲存（`PATCH /folds/{fid}`） |
  | 資料層 | `useComparisons`、`useDiverge`、`useConverge`、`useDecide`（另一個檔，只有延遲載入的部分用）、`useUpdateFold`；`comparison.changed` 讓父線的比較重載 |
  | 文字 | 主字典只多「給我幾個方向…」與 4 個錯誤句子；其他在 `p3-messages` |
  | 「進行中」的提示 | 「AI 正在寫摘要／正在比較／正在想方向／正在寫共同摘要」改成**轉動的圖示＋不變淡的字**（見過程）；減少動態時圖示不動 |
- **demo**：對話欄在 `diverge` 開時顯示發散標記、寫入權限時有「給我幾個方向…」；branch-flows 多 `diverge` 流程。
- **e2e**（`f6.spec.ts`，真 API 的伺服器加 `diverge`）：1440 給我 3 個方向 → 勾兩條、兩個條件 → 比較表（列、欄、建議）→ 產生決定收尾 → 另一條「Not chosen…」；折疊測試加「改摘要」；功能關沒有「給我幾個方向…」；420 的比較表在框內捲動（頁面不橫向捲）；375 勾選目標 ≥ 44px。`features.spec` 的訊息動作清單加「給我幾個方向…」。
  伺服器現在每 3 則回覆才標 AI 標記，所以 1440 的兩個標記測試在真 API 上先做 3 輪（mock 仍每輪都標，見差異）。

截圖：`screenshots/F6/compare-1440`、`compare-420`（mock 與真 API），其他 F6 截圖一併更新。

## TDD 紀錄

先寫、看到紅燈：client 契約 11 個新樣本與 `errors.test`（開工時就紅）、`comparison-routes.test`（模組不存在）、`mock-diverge.test`（6 紅）、mock 契約；react `diverge-hooks.test`（模組不存在）、`event-sync.test` 的 `comparison.changed`（1 紅）、`p3b.test`（模組不存在）、`message-list.test` 的發散標記（1 紅）、`error-text.test`（比較的錯誤句子，先寫）。
後補：`p3b.test` 的唯讀情境（第一版沒有實質檢查，改寫）。

## 過程

- 全套第一次跑：`features.spec` 的訊息動作清單少了「給我幾個方向…」（改測試）。
- 之後兩次各 1 個紅燈：(1) 375 的 axe 抓到 `color-contrast`：「AI 正在寫摘要…」用 `animate-pulse`，淡到一半時灰字低於 4.5:1——改成轉動圖示、字不變淡（新元件 `Working`，F5 的群組摘要也一起改），測試改成驗「字不動畫、圖示只在 `motion-safe` 轉」；(2) `f5.spec` 的 375「回顧所有未完成的事」在全套負載下等了 30 秒沒出現，單獨跑 4 次都過，之後兩次全套也都過——負載下的時序，沒有改。

## 與設計 / 契約的差異

1. 比較表的分數**不能改**（原型寫「分數可改」；沒有路由，後端的問題 1）。
2. 比較從**發散標記**發起（勾選它的方向）；不是發散出來的兄弟支線目前不能比較（伺服器可以；介面上要另外找入口，例如大綱多選的「比較」，等需要時再加）。
3. 決定後顯示的是我們這邊的一句話；放棄的支線的收尾文字是伺服器的英文固定字串（後端的問題 2）。
4. mock 的 AI 標記仍然每一輪都標（伺服器每 3 則回覆一次），讓 mock 的 demo 與 e2e 一輪就看得到；真 API 的 e2e 照伺服器的節奏。
5. 「進行中」改用轉動的圖示（減少動態時靜止），不用淡入淡出的字（對比）。

## 給階段 3 的預算

主 JS 剩約 3.5 kB。用 source map 量過主程式的組成：`@tangent/react` 的 i18n（英文主字典）約 31 kB（未壓縮），是我們自己的程式裡最大的一塊；只有對話框用到的分支相關字（`en.branch.ts` 裡開支線／帶回／放棄的大段說明）可以搬進延遲載入的字典。記憶的介面（D1）若不夠用，先做這個搬移，不提高上限。

# 階段 3（2026-10-18）：跨對話記憶（D1）＋ B7.1

> 依 B10 階段 C（`eed9b05`，184 個樣本）與 B7.1（`4604809`）。只動了 `web/` 與本檔；沒有改 Go，沒有 commit。後端 B7.1 開工時還在改 Go，契約、錯誤碼與真 API 的 e2e 先用 `eed9b05` 的副本，B7.1 commit 之後全部改用 `4604809` 的副本重跑。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 通過 |
| vitest（逐一套件，契約對 `4604809` 副本） | fonts **9**、client **821**、react **776**、demo **85** |
| `pnpm -C web build` | 通過。主 JS **175.63 kB gzip**（階段 2 結束時 176.49）。先照預算計畫搬字典（176.49 → **174.87**），再加記憶：主程式只多了路由、正規化、事件、錯誤句子與三個延遲載入的插槽 |
| Playwright | 全套 **178 passed、57 skipped、0 failed**（共 235），連跑三次都一樣（前兩次對 `eed9b05`，第三次對 `4604809`） |
| axe | 記憶庫（1440）、新對話的回想卡（1440、375）、支線表單的回想、預覽的記憶區塊；沒有違規 |

## 預算：先搬字典

只有對話框用到的分支字（`review.*`、`promote.*`、`move.*`，共 97 個鍵）從 `en.branch.ts`／`zh-TW.branch.ts` 搬到延遲載入的 `i18n/dialog-messages.ts`（`useDialogT`）；帶回審閱、筆記提案、旁註、升級、移動支線這幾個對話框改用它（它們本來就在延遲載入塊裡）。主程式 −1.6 kB，沒有改任何文字。

## 做了什麼

- **client**
  - `memory-routes.ts`：`Memory`（四種：事實／決定／偏好／教訓；重要性 1–10，超出範圍夾回）、`MemorySource`、上限、`RecalledMemory`（相似度、分數）、搜尋與取代的結果、`memory.changed`。
  - API：`listMemories`、`createMemory`、`updateMemory`、`supersedeMemory`、`searchMemories`。
  - 錯誤碼：`memory_not_found`、`memory_superseded`、`invalid_memory`、`embedder_unavailable`（503，「記憶服務暫時不能用，請稍後再試。」）。
  - 預覽的 `memories`（有才有）。
  - 純邏輯 `memory.ts`：兩種建議的內容、取代歷史（現行那條 → 被它取代的舊版本，新的在前）。
  - capabilities：關掉的 AI 功能若伺服器回 `mode: "off"` 就保留（`memory` 的樣本就是這樣）。
  - **B7.1**：`PromptSection.trailing`（只在 `true` 時保留）。
- **mock**（`mock-memory.ts`）：寫入、修改、取代（舊的變 superseded、指向新的）、搜尋與每輪的回想都照假 Embedder（拉丁字詞與數字、每個中日韓字，二元向量的餘弦，門檻 0.3，分數 = 相似度 ×（0.5 + 重要性/20））。預覽在最後加「## Remembered from earlier conversations」區塊與 `memories`。帶回或卡片寫下結論後（suggest／auto）提一個 `memory` 建議「Remembered: … (fake runner)」；收件匣接受 `memory` 與 `memory_consolidate`。事件的線 id 是空字串（記憶屬於整個租戶）。
  另外，`dead_end` 的固定字改成跟伺服器一樣的「沒選：改走「…」」。
- **react**
  | 元件 | 內容 |
  |---|---|
  | `MemoryRecall`（新對話） | 主線還沒有訊息時，草稿停 600 ms 後搜尋。有結果才出現虛線的建議卡「你之前得出過」，**不搶焦點、不跳出來**：「帶入這 n 條」把「之前得出過：\n- [決定] …」放在草稿開頭；「忽略」收起。帶入後顯示「已在訊息開頭帶入 n 條，會出現在送出前預覽。」 |
  | `BranchMemoryRecall`（開支線表單） | 依目的與摘錄搜尋（400 ms）；群組「帶入之前得出過的」，每條一個勾選框；勾的接在背景（摘錄）後面，一起算估計的 token。種子表單不顯示 |
  | `MemoryFooter`（筆記底下） | 區域「跨對話記憶」：這一輪預覽帶入的記憶（「不屬於這段對話」）、沒有時的說明、「記憶庫」按鈕 |
  | 預覽的「記憶（跨對話）」 | 每條的種類、內容、出處與分數；放在摘要之後（伺服器排的順序） |
  | 收件匣 | `memory`：「記住：…」與「事實・重要性 6・出處：…」；`memory_consolidate`：「兩條互相矛盾，改成一條：…」與「原本：a／b」 |
  | 資料層 | `useMemories`、`useMemorySearch`（空字串不送，30 秒內不重送）、`useCreateMemory`、`useUpdateMemory`、`useSupersedeMemory`（都 `mutateAsync`）；`memory.changed` 讓記憶清單與預覽重載 |
  | 文字 | 主字典只多預覽區塊名與 4 個錯誤句子；其他在延遲載入的 `memory-messages` |
- **demo**：記憶庫（`MemoryLibrary`，從筆記底下的「記憶庫」打開，Esc 關）：種類篩選、新增（種類、重要性、內容）、每條可改種類／重要性／有效期限、「取代…」寫新內容，舊版本以刪除線列在底下（「→ 被這條取代（日期）」），出處按鈕跳到那條線；搜尋記憶（結果附分數）。
- **e2e**（`f6.spec.ts`；真 API 伺服器加 `memory:suggest` 與 `TANGENT_EMBEDDER=fake`）：1440 在記憶庫新增 → 取代 → 開新對話打字 → 回想卡 → 帶入 → 送出前預覽有「記憶（跨對話）」；開支線表單勾一條回想；375 從筆記底下開記憶庫、回想卡的按鈕 ≥ 44px；功能關時沒有「跨對話記憶」。D3 的測試改等「沒選：改走「Direction 1 (fake runner)」」。

截圖：`screenshots/F6/memory-library-1440`、`memory-recall-1440`、`memory-recall-375`（mock 與真 API），其他 F6 截圖一併更新。

## TDD 紀錄

先寫、看到紅燈：client 契約 13 個新樣本與 `event.memory.changed`（開工就紅）、`memory-routes.test`（模組不存在）、B7.1 的 `trailing` 正規化（1 紅）、`capabilities.test` 的 `mode: "off"`（1 紅）、`mock-memory.test`（模組不存在）、mock 契約的 `exerciseP3c`；react `memory-hooks.test`（模組不存在）、`event-sync.test` 的 `memory.changed`（1 紅）、`memory.test`（模組不存在）、`turn-preview.test` 的記憶區塊（1 紅）、`open-branch-dialog.test` 的回想（1 紅）、`suggestion-card.test` 的兩種建議（紅）、`error-text.test`（4 個錯誤句子）；demo `memory-library.test`（模組不存在）。
搬字典是重構，沒有新測試；靠原本的對話框測試全綠確認。

## 過程

- 契約的 capabilities 樣本裡 `memory` 是 `enabled: false, mode: "off"`，原本的正規化把 `mode` 拿掉 → 改成保留。
- `MemoryFooter` 的測試寫入記憶後沒有更新：測試要有 `useTangentEvents`，`memory.changed` 才會讓預覽重載（實際畫面本來就有）。
- 記憶庫搜尋的測試問句跟記憶共用的字太少，低於 0.3 → 換問句（假 Embedder 的特性，不是錯）。
- 伺服器的 `dead_end` 字改成中文後，D3 的 e2e 紅 → mock、mock 測試與 e2e 一起改。
- 375 的「新對話」在收起的對話清單裡 → e2e 先打開「展開對話清單」。

## 與設計 / 契約的差異

1. **新對話的「帶入」是把一段文字放進草稿開頭**，使用者看得到、可以刪改，送出後就是那則訊息的一部分。沒有「這條線固定帶這幾條記憶」的路由；每一輪的自動回想照樣由伺服器做（預覽的記憶區塊）。
2. **開支線表單勾的記憶接在背景（摘錄）後面**，一起受摘錄上限限制；不是另外的欄位。
3. 收件匣的記憶建議只有接受／略過，**接受前不能改字**（路由接受改過的 `text`，介面先不做；要改就到記憶庫取代）。
4. mock 沒有整併的背景流程（只能接受別處產生的整併建議）；假 Embedder 是近似，分數不會跟伺服器完全一樣。
5. 420 嵌入沒有 D1 的 e2e（記憶庫是 demo 頁；嵌入的部分只有回想卡，與 1440 同一個元件）。
6. 記憶庫只從筆記底下的「記憶庫」打開，demo 沒有另外的路徑或選單入口。
7. `embedder_unavailable` 只有句子，沒有特別的重試介面（重試就是再按一次）。
8. B7.1 的 `trailing`：前端讀進來，但不需要改畫面——預覽的區塊照伺服器給的順序顯示，trailing 的段落本來就排在摘要之後。

## 後端缺口與問題

沒有缺口。問題：
1. 新對話的「帶入」若要變成伺服器的概念（例如這條線固定帶某幾條記憶、預覽標出「使用者帶入」與「自動回想」的差別），需要路由；目前放進草稿就夠用，先不做。
2. `GET /memories` 只有 `limit`（預設 100、最多 200），沒有游標。記憶庫讀全部狀態（含被取代的舊版本），所以累積超過 100 條後只看得到最新的 100 條，取代歷史也可能缺最舊的幾版。demo 目前夠用；真的要用時需要游標（或「現行 + 各自的歷史」的查詢）。（mock 不限筆數。）

# R11 修正（2026-10-18）：J1–J7

> 依該階段工單。只動了 `web/` 與本檔；沒有改 Go，沒有 commit。後端同時在改 R10 的 Go，契約、錯誤碼與真 API 的 e2e 用 HEAD（`974e98f`）的 `git archive` 副本。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck`（含 e2e） | 通過 |
| vitest（逐一套件，契約對 `974e98f` 副本） | fonts **9**、client **822**、react **783**、demo **86** |
| `pnpm -C web build` | 通過。主 JS **175.62 kB gzip**（之前 175.63） |
| Playwright | 全套 **178 passed、57 skipped、0 failed**（共 235），連跑三次 |
| axe | 記憶庫改成對話框後在 1440 與 375 都檢查（moderate+）；其他照舊 |

## 每一項

| 項目 | 改了什麼 | 測試（都先紅） |
|---|---|---|
| J1 | `CompareTable` 的 `<Decide key={comparison.id}>`。順便掃過 F6 其他依 id 保存本地狀態的地方：`LazyFoldBlock` 加 `key={fold.id}`（同一則訊息開始的另一個折疊，展開與編輯狀態不再留著）；`BranchMemoryRecall` 勾過的記憶在目的改了、搜尋不再找到時仍列出（可以取消勾選，不會變成看不見卻還在背景裡）。其他（`FoldDialog`、`DivergeDialog`、`MemoryCard`、`MemoryRecall`、`DivergeMarker`、`ArgTag`）原本就依 id 重設或在依 id 的列裡 | `p3b.test` J1；`message-list.test` 換折疊；`memory.test` 勾過的記憶 |
| J2 | 決定送出成功後按鈕維持鎖住（`loading`），直到外層換成「已決定」 | `p3b.test` J2：成功後再按不會再送 |
| J3 | P3 的三個插槽（論證類型、折疊、發散標記）與記憶的三個插槽都包 `LazyRegion`（載入中什麼都不顯示，失敗時在原處顯示小的「載入失敗」與重新載入） | 新檔 `conversation/p3-slots.test.tsx`、`memory/slots.test.tsx`：模組載入失敗時其他內容照常 |
| J4 | `f6.spec` 改標記後，等寫入 `decision` 的 `PUT /messages/{mid}/tag` 回應成功才 reload | e2e |
| J5 | mock 的假 embedder 改成跟 `runner/fake/embedder.go` 一樣：字詞是任何字母與數字，漢字、平假名、片假名、韓文各自一個字，次數向量用 FNV-1a 雜湊到 256 維；所以分數與伺服器**完全相同**（階段 3 的差異 4「近似」不再成立） | `mock-memory.test`：5 組文字的 cosine 與伺服器的值（用 `974e98f` 的 `runner/fake` 在 scratch 算出）一致到小數 5 位 |
| J6 | 記憶庫改用既有的 `Dialog`／`DialogContent`（新寬度 `page`，72rem）：`role="dialog"`、開啟時聚焦、Tab 圈住、Esc 或關閉鈕關閉、焦點回到「記憶庫」。為了讓焦點回得去，打開記憶庫時側欄（375 的抽屜、平板的浮層）不再先收起；記憶庫是蓋住全部的對話框。另外 `DialogContent` 現在一律帶 `aria-modal="true"`（Base UI 不會加；本專案的對話框都是 modal） | demo `memory-library.test`：aria-modal、焦點進入、Tab 30 次都在裡面、Esc 關閉且焦點回到按鈕；e2e 1440 與 375 驗 `aria-modal` 與焦點回到「記憶庫」 |
| J7 | 送出前預覽的折疊清單在訊息還沒載入時用不帶序號的文字（「2 則，送 … token」）；「這一輪 AI 看得到什麼」的折疊項目同樣改用「已折疊（2 則）」，連折疊本身都還沒載入時是「折疊的部分」 | `turn-preview.test`：訊息不載入時沒有「#–#」 |

## 順便修的

- 記憶庫的截圖原本固定叫 `memory-library-1440-*`，375 的測試也用同一個名字，會蓋掉 1440 的那張（階段 3 交出去的 `memory-library-1440-*` 其實是 375 的畫面）。改成依視窗寬度命名：`memory-library-1440-*` 與新的 `memory-library-375-*`。
- demo 字典拿掉不再用的 `library.close`（關閉鈕用 `DialogContent` 的「關閉」）。

## 與審查建議的差異

沒有。J6 多做了一件事：打開記憶庫時側欄不再收起（見上），否則關閉後焦點沒有地方可以回去。
