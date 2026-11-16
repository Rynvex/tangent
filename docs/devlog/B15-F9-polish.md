# B15 / F9 · 關聯種類、論證類型草稿與前端打磨

> 2026-10-25。交接包 `7_B15_F9_POLISH.md`。後端（Part A · B15）和前端（Part B · F9）分在兩個 worktree 平行做，協調者驗收後合併、commit。

## Part A · B15（後端）

> 在獨立 worktree（`../tangent-b15`，分支 `b15`，從 `fe3b883` 開）裡做，**沒有改 `web/`**（`git diff main -- web/` 是空的）。
> Go 測試用 `tangent_test`；smoke 用 :8121 與 `tangent_smoke`。沒有碰 :8120、:5183、使用者的 `tangent` 資料庫或 宿主，也沒有呼叫付費模型。
> 補的是 F8 devlog「需要後端」的兩項：關聯的種類欄位；整棵樹的 AI 草稿論證類型，以及把類型改回草稿。

### 驗收

| 檢查 | 結果 |
|---|---|
| `make sqlc` 後 `~/go/bin/sqlc diff` | 無差異 |
| `go vet ./...`、`test -z "$(gofmt -l .)"` | 通過、無輸出 |
| `go test ./... -count=1` | 全部 ok（root 107.6s、store 74.0s、httpapi 29.5s，其餘套件也都 ok） |
| `bash scripts/smoke.sh`（:8121） | `SMOKE PASSED (752 events)`。新增一步「B15: relation kinds, a tag back to a draft, the tree's tag drafts」 |
| `git diff main -- web/` | 空 |

新增與修改的測試：

| 檔案 | 內容 |
|---|---|
| `domain/b15_test.go` | 4 個：`NormalizeRelationKind`、AI 回覆的 `kind` 與 fallback、`Link.relationKind` 的 omitempty、`NormalizeTagStatus` / `TagSourceOf` |
| `domain/p2_test.go` | 解析結果多了 `Kind: related` |
| `store/b15_test.go` | 4 個：建立時的預設值與拒絕；修改時保留沒給的欄位；草稿的寫入與整棵樹的列表（排序、別的樹、別的租戶、任何一條線）；500 筆上限與 `truncated` |
| `b15_test.go`（engine） | 3 個：`EditRelation` 只改種類、`link.changed` 帶著種類、`UpdateRelation` 保留種類、hook rollback；`SetMessageTag` 改回草稿、`message.updated`、`ListTagDrafts`；功能關閉時 `feature_disabled` |
| `p2_relations_test.go` | 關聯建議：AI 提的 `kind: supports` 進 payload，接受後的 Link 也是 `supports` |
| `httpapi/b15_routes_test.go` | 路由表 82 → 83：新路由跑過讀者、匿名、跨租戶、功能關閉、驗證失敗的共用測試。另有 3 個形狀測試：關聯種類（POST / PATCH / `null` / 400、relations / links / export 都帶種類）；spinoff 連結沒有 `relationKind`；PUT 草稿與 `tag-drafts`（唯讀身分） |
| `intx_doc_test.go` | 加 `EditRelation`、`SetMessageTag` |

契約樣本：

- 新增 3 個：`route.relations.kind.json`、`route.ibis.drafts.json`、`route.messages.tag.draft.json`。
- 既有樣本只多了 `relationKind`，其他都沒有變：
  - `"relationKind": "related"`：`route.relations.create`、`route.relations.list`、`route.relations.update`、`route.links.list.relations`、`event.link.changed.deleted`。
  - `route.suggestions.accept.relation` 多了兩處：payload 與接受後的 link。
- spinoff 的樣本沒有變。

### 實作

| 項目 | 做法 |
|---|---|
| migration 015 | `tangent_link.relation_kind TEXT NOT NULL DEFAULT 'related' CHECK (IN related, supports, contradicts, depends_on)`。down 是 `DROP COLUMN IF EXISTS` |
| domain | 常數 `RelationKindRelated / Supports / Contradicts / DependsOn` 與 `RelationKinds`。<br>`NormalizeRelationKind`：去空白；空字串 → `related`；其他值（大小寫有別）→ `invalid_input`（`details.field: relationKind`）。<br>`Link.RelationKind`（`json:"relationKind,omitempty"`）。<br>`RelationProposal.Kind`：prompt 列出四種，解析時認不得或沒給 → `related`（不讓 job 失敗）。<br>`NormalizeTagStatus`（空字串 / `confirmed` / `draft`，其他 → `invalid_input`，`field: status`）、`TagSourceOf`、`TagDraft` |
| store：關聯 | `InsertLink` 寫 `relation_kind`：spinoff 寫 `related`，關聯寫正規化後的值。<br>`linkFromRow` 只在 `kind == relation` 時填 `RelationKind`。所有回傳 Link 的地方都經過它：關聯、`/links`、匯出、`link.changed`、接受建議、rebalance。<br>新的 `UpdateRelation(RelationEdit{Label, RelationKind *string})`：在 `lockRelation` 內讀出現值，沒給的欄位寫回原值（新的 sqlc 查詢 `UpdateRelation`）。`UpdateRelationLabel` 改成呼叫它，只給 label。群組的 `UpdateLinkLabel` 沒有動 |
| store：標記 | `PutUserTag` 換成 `PutTag`，source 與 status 由參數決定。<br>新的 `SetMessageTag(TagInput{Kind, Status})`：`kind`、`source`、`status` 都相同時不寫、`Changed=false`。`TagMessage` 改成呼叫它，status 為 confirmed。<br>新的 `ListTagDrafts`：查詢 `ListTreeTagDrafts`，`line_id IN (主線 ∪ tangent_branch.root_line_id = 主線)`，走 `line_id` 索引，並加租戶條件；`LIMIT 501` 判斷 `truncated`；`TagDraftsMax = 500` |
| engine | `RelationInput.RelationKind`。<br>`EditRelation`（新增；`UpdateRelation(label)` 保留，改成呼叫它）。<br>`RelationPayload.RelationKind`（`omitempty`）；接受的本文多了 `relationKind`，可以覆寫。<br>`SetMessageTag`（新增；`TagMessage(kind)` 保留）。<br>`ListTagDrafts`：`needScoped(FeatureIbis)`。<br>型別別名 `RelationEdit`、`TagInput`、`TagDrafts` |
| httpapi | `POST /relations`：本文多了 `relationKind`。<br>`PATCH /relations/{rid}`：`label`、`relationKind` 都是 `*string`，呼叫 `EditRelation`。<br>`PUT /messages/{mid}/tag`：本文多了 `status`，呼叫 `SetMessageTag`。<br>新的 `httpapi/b15.go`：`GET /lines/{id}/tag-drafts`（讀路由、功能 `ibis`）。<br>op 表：`relations.update` 對應 `EditRelation`，`messages.tag` 對應 `SetMessageTag` |
| 文件 | DESIGN §7（關聯、tag、tag-drafts 三列）、§12.10 五列；`DECISIONS_LOG.md` 同樣五列；API.md（`Link`、建議 payload、三個路由的說明、新的 `### GET /lines/{id}/tag-drafts`、op 表）；EMBEDDING §4.4 加 `EditRelation`、`SetMessageTag` |

鎖與事件：

- 關聯的修改沿用 B9 的 `lockRelation`：鎖兩端的主線，依 id 排序。標記沿用 `writeTag`，鎖訊息所在的線。
- `tag-drafts` 只讀，不鎖。
- 事件都在 commit 之後發，和原本一樣：關聯發 `link.changed`，每棵樹一個；標記有變才發 `message.updated`。

### 和工作單不同的地方

1. **Engine 的 API 不改簽名，改成新增方法。** `UpdateRelation(label string)` 和 `TagMessage(kind string)` 是公開 API，嵌入者（例如 宿主）可能在用。
   - 保留這兩個方法：`UpdateRelation` 不改種類，`TagMessage` 寫 confirmed。
   - 新增 `EditRelation` 與 `SetMessageTag`，HTTP 路由改用新的方法。
   - 兩個都列進 EMBEDDING §4.4 的 InTx 表，op 表的 Engine 欄也改成新的方法。
2. **`PATCH {}` 的意思變了。** 工作單要求「沒給的欄位保留」，所以原本「沒給 `label` = 清空」改成保留。
   - 驗證沒有變：沒有本文仍是 400；label 長度仍是 422；空字串仍可清空 label。
   - `{}` 不是錯誤：回 200、發 `link.changed`，內容不變。
   - `null` 等於沒給。
3. **接受關聯建議時可以改種類。** 本文多了 `relationKind`，和原本可以改 `label` 對稱；不合格回 400。工作單只要求「接受時寫入種類」。
4. **`status: ""` 等於沒給**，視為 confirmed。工作單寫「其他值 400」，空字串當作沒給。非字串的值（例如 `1`）是 JSON 解析失敗，也回 400。
5. **改回草稿的 `source_job_id` 會清空**，`updated_by` 是操作者。
   - 這樣它和 AI 草稿完全一樣：fisheye 不加分，之後的 AI job 也不會覆蓋它（AI 只補沒有標記的訊息）。
6. **`tag-drafts` 的跨線順序：** 主線在前，支線依大綱順序（`created_at, line_id`，同 `ListBranches`），線內依 `seq`。工作單只寫「by line then seq」。
7. **加了上限 500 與 `truncated`**（工作單說加上限時要告訴協調者）。`truncated` 一定會出現，沒有超過時是 `false`。
8. **fake runner 沒有改。** 它的關聯建議不帶 `kind`，所以樣本裡建議的 payload 是 `related`。

### 給前端（F9）

**合併後 web 的契約測試會先紅。** `web/packages/client/src/contract.test.ts` 會逐鍵比對 `httpapi/testdata/contract/` 的樣本，所以 F9 要補下面幾項：

- `Link.relationKind`（normalizer 要保留這個欄位）。
- `RelationPayload.relationKind`。
- 三個新樣本的 client 呼叫：`createRelation({…, relationKind})`、`setTag({kind, status})`、`listTagDrafts(lineId)`。
- 把新樣本加進 `EXPECTED_SAMPLES`。

JSON 形狀：

```jsonc
// Link：關聯一定有 relationKind；spinoff 沒有這個鍵
{ "id", "kind": "relation", "fromLineId", "fromMessageId", "toLineId", "toMessageId",
  "label", "relationKind": "related|supports|contradicts|depends_on",
  "fromTitle", "toTitle", "createdBy", "createdAt" }

// POST /lines/{id}/relations
{ "fromLineId?", "fromMessageId?", "toLineId", "toMessageId?", "label?", "relationKind?" }  // 空 = related
// → 201 { "relation": Link, "rootLineIds": [] }

// PATCH /lines/{id}/relations/{rid}：沒給 / null = 保留
{ "label?": "string|null", "relationKind?": "string|null" }
// → 200 { "relation": Link, "rootLineIds": [] }

// 關聯建議（kind: relation）
// payload：{ fromLineId, toLineId, fromTitle, toTitle, label, relationKind? }
// 接受的本文：{ label?, relationKind? }

// PUT /messages/{mid}/tag
{ "kind": "question|idea|pro|con|decision", "status?": "confirmed|draft" }
// → 200 { "message": Message }
// draft 的 message.tag：{ kind, source: "ai", status: "draft", updatedAt }

// GET /lines/{id}/tag-drafts（樹上任一條線；讀者可用；功能 ibis）
{ "rootLineId": "…",
  "drafts": [ { "lineId", "messageId", "seq", "role": "user|assistant", "content",
                "tag": { "kind", "source", "status": "draft", "updatedAt" } } ],
  "truncated": false }   // 最多 500 筆
```

- 錯誤：
  - 種類或狀態不合格 → `400 invalid_input`，`details.field` 是 `relationKind` / `status`。
  - ibis 關著 → `404 feature_disabled`。
  - 別的租戶或不存在的線 → `404 line_not_found`。
- F8 的 `ArgReviewCard` 可以改用 `tag-drafts`：一次讀整棵樹，不必只看已載入的線。S2 的「復原」用 `PUT {kind, status: "draft"}`。
  - 「全部確認」仍是逐則 `PUT {kind}`；這次沒有做批次確認。
- F8 用 label 猜「矛盾」的作法可以換成 `relationKind === "contradicts"`。B15 之前建的關聯都是 `related`，舊資料用 label 猜到的矛盾要使用者自己改種類。
- :8120 要用新的二進位重啟才有 migration 015 與新路由；啟動時會自動跑 migration。

## 審查修正（B15）

- `PATCH /lines/{id}/relations/{rid}` 的 `relationKind: ""`（或只有空白）改成 `400 invalid_input`（`details.field: relationKind`，和不認得的種類同一個形狀）；建立時「空 = `related`」不變。domain 新增 `ParseRelationKind`（改的時候用，空字串不合格），`NormalizeRelationKind` 只給建立用。測試：domain、store、httpapi 路由。
- `GET /lines/{id}/tag-drafts` 的 `content` 改成摘錄：最多 `domain.TagDraftContentRunes`（200）個 rune，超過時用 `domain.CutRunes` 切成 199 字加「…」。SQL 只讀 `left(m.content, 201)`（多一個字才知道有沒有被切），不再搬整則訊息。測試含一則 250 字的中文訊息與剛好 200 字的訊息。API.md 已註明。
- `tag-drafts` 不再列已捨棄（`discarded`）支線上的草稿；`merged`、`promoted`、`open` 照列（`b.status IS NULL OR b.status <> 'discarded'`，主線沒有 branch 列）。測試：一條捨棄、一條合併的支線。
- `ParseRelationSuggestions` 讀模型給的 `kind` 時放寬：轉小寫、`-` 與空白（含連續空白）換成 `_` 再比對，所以 `Contradicts`、`depends-on`、`depends on` 都認得；認不得仍是 `related`。只有解析器這樣做，API 仍然大小寫有別。
- 移除沒有人用的 `UpdateLinkLabel` 查詢（`store/queries/groups.sql`），重跑 `make sqlc`。
- 附註：
  - 使用者用 `PUT /messages/{mid}/tag {status: draft}` 改回草稿時，存成 `source=ai` 且沒有 `source_job_id`。這是刻意的（API.md 已寫明），草稿一律算模型的。
  - B15 拿掉了 `store/db.PutUserTag`。它是 sqlc 產生的程式，不算公開契約。


## Part B · F9（前端）

> 在獨立 worktree（`../tangent-f9`，分支 `f9`）裡做。B.1、B.2 由協調者做；B.3、B.4 由兩個背景 agent 平行做（檔案不重疊），協調者接線與驗收。
> 沒有碰 :8120、:5183，也沒有呼叫付費模型。e2e 的 mock 伺服器用自己挑的空閒 port。

### 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 5 個專案全部通過 |
| vitest（逐一套件） | fonts **10**、client **924**、react **899**、demo **159**，全部通過 |
| `pnpm -C web build` | 通過。主 JS **146.16 kB gzip**（F8 結束時 179.77，上限 172） |
| Playwright `e2e:mock --workers=4` | **137 passed、3 skipped、0 failed**（含新的 S12 關聯種類、S2 復原） |
| 截圖 | `docs/devlog/screenshots/F9/`：`relation-kind-1440.png`、`arg-undo-1440.png` |

### B.1 主程式瘦身（179.77 → 146.16 kB）

用 sourcemap 逐模組量（`attrib.mjs`），最大的一塊是 Base UI 的 Tooltip 與 Dialog 帶進來的 floating-ui 與 focus 管理（約 19 kB gzip），其次是側欄 sheet。

- **IconButton 的提示改成延遲載入**（`components/tooltip-hint.tsx`）：第一次指到或聚焦按鈕時才載入 Base UI Tooltip。
  - 開關由按鈕自己的事件決定：滑鼠停 500 ms 開；鍵盤聚焦（`:focus-visible`）立即開；從一顆移到下一顆 400 ms 內立即開（原本 Provider 的行為）；觸控不開；按下、離開、失焦、Esc 關。
  - 載入完成時若游標或焦點已在按鈕上，直接接著開。
  - 移除 `TangentRoot` 裡的 `TooltipPrimitive.Provider`。
- **側欄的 sheet（窄螢幕的底部抽屜）延遲載入**：`layout/side-panel-sheet.tsx`，桌面版不載入。
- 新測試 `components/icon-button-hint.test.tsx`。

### B.2 對接 B15

| 項目 | 做法 |
|---|---|
| client | `RELATION_KINDS`、`Link.relationKind?`（伺服器有給才有這個鍵；spinoff 沒有）、`CreateRelationInput.relationKind?`、`UpdateRelationInput {label?, relationKind?}`、`TagMessageInput.status?`。<br>新檔 `b15-routes.ts`：`listTagDrafts`、`TagDraft`、`TAG_DRAFTS_MAX = 500`、`TAG_DRAFT_CONTENT_CHARS = 200`。<br>`relationSuggestionOf` 多了 `relationKind`（沒有或認不得 → `related`）。<br>契約測試：三個新樣本加進 `EXPECTED_SAMPLES`，新路由加進 `ROUTES` |
| mock | 照 Go 的規則：建立時空 = `related`、修改時空字串 400、不合格 400（`field: relationKind`）；PATCH 沒給的欄位保留；建議的 payload 帶 `relationKind`。<br>`tagDrafts`：主線在前、支線依建立順序、線內依 seq；跳過捨棄的支線；內容用和 `domain.CutRunes` 一樣的規則切到 200 字。<br>`tag(…, status: draft)` 寫成 `source: ai`。新測試 `mock-b15.test.ts`、`b15-routes.test.ts` |
| `stale-reasons.ts` | 有 `relationKind` 時只看它是不是 `contradicts`；沒有（B15 之前的伺服器）才看 label |
| 關聯 UI | `p2/relation-kinds.tsx`：四種的切換（相關、支持、矛盾、依賴；預設相關）與小標籤（相關不顯示；矛盾用警告色）。<br>`RelationDialog` 加「種類」，選矛盾時說明會標「前提已更新」。<br>關聯清單顯示種類；「改說明」展開時可以改種類，選了就存。刪除後的復原會帶回原本的種類。AI 建議也顯示提議的種類 |
| S2 `ArgReviewCard` | 改讀 `GET /tag-drafts`：整棵樹（含沒打開的支線）。每列標出主線或支線名稱；該線已載入時再加 #n。點一列跳到那條線的那則訊息（宿主的 `navigate`）。<br>「全部確認」後顯示「已確認 N 則論證類型」與「復原」10 秒；復原逐則送 `PUT {kind, status: "draft"}`，部分失敗時說明幾則沒改回。超過 500 則時說明只列前 500 則。<br>`useTagDrafts`（`keys.tagDrafts(root)`）；標記的 mutation 與 `message.updated`（類型或狀態有變時）會讓它重讀 |
| e2e | S2 加上復原；新的「S12 (B15)」：從結構分頁新增一條「矛盾」關聯到已帶回的支線，大綱與結論卡出現「前提已更新」，理由寫「和這張卡矛盾」 |

### B.3 手機與平板（背景 agent）

- **地圖雙指縮放**（`structure/use-map-pinch.ts`）：兩根手指時進入縮放、暫停單指拖曳；倍率 `clampZoom(start × 距離比)`，範圍 0.5–1.6，兩指中點在畫面上不動；觸發 `onManualMove`。測試 `map-pinch.test.tsx`。
- **窄螢幕的「樹狀地圖」入口**：`StructurePanel` 的 `onOpenTreeMap`，只在 `< 768px` 且不在專注模式時由 demo 傳入；按下後關掉抽屜、進專注模式的「地圖」分頁。字串在延遲載入的 `tree-map-messages.ts`。測試 `tree-map-entry.test.tsx`。
- **字型 `local()`**：`fonts/scripts/build.mjs` 在 `url()` 前加系統字型。黑體依字重先放 `PingFang TC-Regular / -Medium / -Semibold`，再放 `Noto Sans CJK TC`、`Heiti TC`、`Microsoft JhengHei`；襯線放 `Songti TC`、`Noto Serif CJK TC`、`PMingLiU`。重新產生 `tc.css`、`serif.css`，`build.test.ts` 跟著更新。

### B.4 收尾（背景 agent）

- **大綱的已結束支線分組**：同一個父節點下已結束（`merged` / `discarded`）的支線 ≥ 6 條（`OUTLINE_ENDED_GROUP_MIN`）時，底部多一列「收合已結束支線（依收尾類型分組）」。收合後依收尾類型（決定、答案、結論、死路、其他）各一列，展開看全部。方向鍵照常（`use-outline-keys.ts` 的 `onExpand`）。字串在延遲載入的 `outline-groups-messages.ts`。
- **設定的快速套用與分組**：設定對話框頂部三顆「標準推薦」「深度研究與決策」「輕量學習紀要」；功能開關分成「核心支線與導覽」「深度討論與多方案收斂」「學習紀錄與重點整理」「背景 AI 與進階記憶」。
  - mock 模式：套用後換 mock 的功能組（`scenario-nas.ts` 的 `standard | research | learning`）並重新載入。
  - http 模式：伺服器只在啟動時讀功能，所以顯示一行 `TANGENT_FEATURES=…` 讓使用者複製，頁面不改伺服器。

### 和工作單不同的地方

1. **「全部確認」的提示放在卡片位置，不是全域 Toast。** 卡片在 react 套件的待處理面板裡，面板沒有 Toast；確認後清單清空，同一個 `role="status"` 區域留著「已確認 N 則論證類型」與「復原」10 秒。
2. **「輕量學習筆記」改名「輕量學習紀要」**：介面用語不用「筆記」。
3. **功能開關是 22 個，不是 18 個**（B13、B14 之後的數量），四組照工作單分。
4. **「改說明」同時可以改種類**，沒有另開一個編輯對話框。
5. **「知道了，這兩項不再提醒」改成「知道了，這些不再提醒」**：理由可能只有一項。
6. **mock 的關聯建議一律帶 `relationKind: "related"`**，和 Go 一樣（解析後一定有種類）。

### 審查與修正（唯讀 TypeScript 審查）

- **採納並修好：**
  - 地圖上拉關聯線時第二根手指落下（雙指縮放）會在最後放開的位置建出關聯；`pointercancel` 會讓拖曳卡住。現在另一根手指落下或指標被取消時，拖曳直接結束、不建關聯（`cancelDrag`）。
  - 三根手指時縮放的起點過期：手指數變動後，用還在的兩根重新定錨；縮放結束時清掉還沒套用的捲動。
  - 「復原」會蓋掉使用者在 10 秒內自己改過的類型：復原前先看已載入的訊息，已經不是「確認、同一種類」的就保留，並說明幾則保留。
  - 第二次「全部確認」會讓第一批無法復原：同一個時間窗內累加；復原失敗的那幾則留著可以再按一次。
  - 沒載入的線上的標記被清掉時，草稿清單不會重讀：沒有可比對的快取時一律重讀。
  - 滑鼠停留打開的提示在焦點不在按鈕上時按 Esc 關不掉（WCAG 1.4.13）：提示打開時在 document 上聽 Esc。
- **沒有採納：** 每列的 #n 只在列表或大綱變動時更新（不會因為之後載入那條線而補上），可以接受；縮放後 350 ms 內的點擊會被吞掉，是刻意的（放開的手指不能按到節點）；「全部確認」每一則各重讀一次草稿清單，查詢會合併，影響不大。
- 新測試：`relation-layer.test.tsx`（第二根手指與取消）、`map-pinch.test.tsx`（三根手指）、`f8-parts.test.tsx`（復原保留使用者的改動）、`icon-button-hint.test.tsx`（Esc）。

### 給下一步

- 主 JS 剩約 26 kB 空間。新的介面照舊做成延遲載入，字串放在各自的 bundle。
- 舊資料：B15 之前用 label 寫「矛盾」的關聯，種類是 `related`，前提已更新的標記會消失；要使用者在關聯清單把種類改成「矛盾」。
