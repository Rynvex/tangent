# B18 · 匯入對話、中段抽成支線、資料夾與標籤、拆解建議

> 2026-10-30。工單（已歸檔）。基線 `main` @ `9d2578f`。
> 只改後端（Go、migration `016`、`docs/`、`httpapi/testdata/contract/*.json`），`web/` 一個檔案都沒動，前端由 F13 負責。
> 在獨立 worktree（`../tangent-b18`，分支 `b18`）由一個實作 agent 完成；協調者看過 diff、在 worktree 重跑全部檢查後合併。
> 沒有碰 宿主；開發期間沒有動 :8120、:5183，合併後重啟 :8120（會跑 migration 016）；沒有呼叫付費模型。

## 驗收

| 檢查 | 結果 |
|---|---|
| `~/go/bin/sqlc diff` | 沒有差異 |
| `go vet ./...`、`gofmt -l .` | 通過、沒有輸出 |
| `go test ./... -count=1` | 全部 ok（含契約樣本、路由表、`TestAPIDoc_*`、`TestInTx_TheGuideListsTheResultEveryWritePasses`）；agent 另跑過 root、`store`、`httpapi` 的 `-race` |
| `bash scripts/smoke.sh` | `SMOKE PASSED (899 events)`（B17.1 後 870）；新步驟涵蓋匯入、篩選、改名、decompose、兩種 extract |
| migration 016 用真資料試跑 | agent 用 `pg_dump` 把 dev 資料庫 `tangent` 複製到暫存資料庫，在 :8122 起 B18 伺服器套用 016，既有的線讀回 `"folder": ""`、`"tags": []`，之後刪掉暫存資料庫 |
| web client vitest（只讀確認） | **53 failed、936 passed（989）**，全部是新欄位、新樣本、新路由造成，F13 補上前是預期的（清單見下） |
| web react vitest | 987/987（沒變） |

### 契約樣本

- 26 個既有樣本變了，每一處都只是多一行 `"folder": ""` 或 `"tags": []`（98 行新增，0 行刪改）。
- 新增 4 個（`httpapi/contract_b18_test.go`）：`route.lines.import.json`、`route.lines.folders.rename.json`、`route.branches.extract.json`（帶結論卡）、`route.lines.decompose.json`。

### F13 前預期失敗的 web client 測試

- `contract.test.ts`（27 筆）：事件樣本 `event.line.created`、`event.line.updated`；路由樣本 `route.branches.combine`、`branches.create`、`branches.extract`、`branches.move`、`branch.merge`、`branch.promote`、`cancel`、`diverge.models`、`lines.archive`、`lines.create`、`lines.create.rich`、`lines.decompose`、`lines.export`、`lines.folders.rename`、`lines.get.inbox`、`lines.get`、`lines.get.rich`、`lines.import`、`lines.list`、`lines.read`、`lines.unarchive`、`lines.update`、`seeds.expand`、`spinoff.detach`、`spinoff.fresh`。
- `src/testing/mock-contract.test.ts`（26 筆）：上面 25 個路由樣本（不含事件），加「simulates every route a successful sample shows, except the listed ones」。
- `spinoff.fresh` 的 diff 另外列出 `$.branch: extra`、`$.notes: missing`：這兩個差異本來就有，只是現在沒有任何一次呼叫對得上，測試改報最後一次呼叫的 diff。

## 做了什麼

### Migration `016_line_organization`

- `tangent_line` 加 `folder TEXT NOT NULL DEFAULT ''`、`tags TEXT[] NOT NULL DEFAULT '{}'`。常數預設值，不改寫既有資料列。
- 索引：`(tenant_id, folder) WHERE folder <> ''` 部分索引、`tags` 的 GIN 索引。
- `tangent_branch.origin` 的 CHECK 加 `import`。down 把 `import` 改回 `button` 再還原 CHECK、刪索引與欄位。

### 資料夾與標籤（只屬於主線）

- 正規化在 `domain/line_org.go`（`NormalizeFolder`、`NormalizeTag(s)`、`NormalizeOrganization`），有單元測試。`__unfiled__` 是保留名（`GET /lines?folder=__unfiled__` 代表未分類），拿來當資料夾名稱回 400。
- 支線永遠是 `""` / `[]`。對支線 PATCH 非空值回 400，空值當作沒改。所有 `Line` 都經過同一個轉換函式，`tags` 永遠是 `[]`，不會是 `null`（事件也檢查了）。
- `GET /lines`：沒有篩選時走原本的查詢與部分索引；有 `folder` / `tag` 時走另一個查詢，游標格式相同。
- `POST /lines/folders/rename`：依 id 順序鎖住這個租戶在 `from` 資料夾的主線（含封存的），一次改好。`from` = `to` 時什麼都不做，回 `{updated: 0}`。
- Spinoff（detach 與 fresh）新主線繼承來源對話的資料夾與標籤。
- 所有新查詢都限定租戶。

### `POST /lines/import`

- 一個 transaction，不呼叫 runner（有測試）。
- 限制：主線 1～200 則；每條支線 1～100 則（下限 1 是 agent 加的）；最多 20 條支線；每則內容上限 `Limits.Text.MessageMaxRunes`（預設 32,000，同 DESIGN §12.5），超過回 `422 too_long`。角色只接受 `user` / `assistant`。
- 內容經過 `CleanSystemText`：拿掉系統標記與控制字元，程式碼區塊保留。
- 標題空白時用第一則使用者訊息，截到 60 字（程式庫沒有 `SummarizeTopic`）。
- 支線背景包用 `BuildBranchPack` 從主線開頭組到錨點；可以直接標成已捨棄。
- 事件在 commit 之後才發。
- 不跑任何功能 hook，`tangent_job` 維持空的（有測試）。匯入的訊息沒有用量也沒有模型；下一輪照常計量，retry 回 `nothing_to_retry`。很長的匯入線之後的第一個真回合，可能照一般規則觸發摘要、目標或 IBIS 的週期；匯入本身不觸發。
- body 上限另外設：`httpapi.Config.MaxImportBodyBytes`，預設 16 MiB，不小於 `MaxBodyBytes`。1 MiB 裝不下真實的匯入。

### `POST /lines/{id}/branches/extract`

- 規則同 move（`MoveToBranch`），但可以抽任何連續的一段，包括中段。主線和支線都可以抽，支線種類只能是 investigate 或 alternative。
- **標記的位置**：`seq` 是全域唯一、自動產生的，範圍兩側之間沒有空的 seq 可用。
  - 範圍最後一則訊息換一個新的 seq（`UPDATE … SET seq = DEFAULT`）。它仍是支線裡最新的一則，順序不變。
  - 標記（或結論卡）寫在空出來的 `to.seq`（`OVERRIDING SYSTEM VALUE`），時間用那則訊息的 `created_at`，閒置切章不會看到時間跳躍。
  - 結束在被換號訊息上的摺疊跟著改 seq。
  - 測試檢查順序是 `q1 a1 marker q3 …`、標記的 seq 等於原本的 `to.seq`、prompt 歷史在原位顯示 `system: 2 message(s) moved…`。
- **連帶的資料**：
  - 範圍內開出的下層支線連同子樹一起移過去，深度 +1，超過硬上限就拒絕。
  - 摘要涵蓋到範圍時重設，排隊中的摘要工作作廢。
  - 摺疊：跨過範圍兩端或包住範圍的移除，範圍內的移到新支線（在 core 的 transaction 裡做）；fold 功能開著才發 `fold.changed`。
  - 章節：範圍後面還有訊息時，範圍內每一種切點中最新的那個移到標記上，後面的訊息留在同一章；抽尾段時不移（同 move）。chapters 開著才發 `chapters.changed`。
  - 釘選、標籤、停車種子、關聯端點跟著訊息走。紀要來源線、指名被移訊息的收件匣建議、範圍後面的 move 標記，和 move 一樣不動。
- **拒絕**：
  - 來源回覆中或有排隊回合：`409 source_busy`。
  - 已封存：`archived`。
  - 已結束的支線：`parent_closed`。
  - aside 種類：`kind_unsupported`。
  - `from` 在 `to` 後面：`invalid_input`。
  - 端點不在這條線上：`message_not_found`。
  - 範圍不是以使用者訊息開頭：`move_must_start_with_user`。
  - 前面沒有可掛的錨點：`move_no_anchor`。
  - 範圍裡有失敗的回覆、主機系統訊息，或範圍內開出、結論卡卻留在這條線上的已帶回支線：`move_protected_message`。最後一種是審查時發現的漏洞：抽尾段不會遇到，中段會把支線帶走、卡片留在範圍後面。
- **帶結論卡**：
  - 卡片的檢查同合併：支線端引用要在範圍內，父線端引用要在範圍後面。
  - 支線立刻是 `merged`，寫好 `conclusion_line`、`card_message_id`；leaf 開著時寫確認過的結論葉（`leaf.changed`）。
  - 卡片訊息 `meta.delivered: true`：它代表的對話本來就在主線上，所以 preview 沒有 `branch_cards` 段，歷史在原位顯示卡片，下一輪的 `deliversCards` 是空的，也不加未讀。
  - 只跑 branch-created hook（同 move），不跑 branch-closed，所以不會開 AI 工作。

### `GET /lines/{id}/decompose`

- 純函式、結果固定（打亂輸入測過）。core 的讀取，viewer token 也能叫。
- 讀最舊的 400 則，超過時 `truncated: true`；每則最多看 4,000 字。每個清單都有上限，不會是 `null`。
- 中英提示詞列在 `domain/decompose_text.go`。相關對話只找同一個租戶、用主線的標籤或資料夾。

### 文件

- `docs/API.md`：四條新路由、`Line.folder` / `tags`、`GET /lines` 篩選、`origin: import`、匯入 body 上限。
- `docs/EMBEDDING.md`：§4.4 三個新寫入的 InTx 列、§4.5 B18 注意事項。
- `docs/DESIGN.md`：§4 欄位、§5 extract 不變式、§6、§7、§12.10 四列決定；同樣四列加到 `docs/design/DECISIONS_LOG.md`。
- `scripts/smoke.sh`：匯入帶支線、資料夾與標籤篩選、PATCH 標籤、資料夾改名、decompose、帶結論卡抽出建議的離題、不帶卡抽尾段、卡片與標記在範圍原位、preview 歷史有卡片而沒有 `branch_cards`。

## 和工單不同的地方

1. **錯誤碼沿用既有的** `move_protected_message`、`move_must_start_with_user`、`move_no_anchor`，狀態碼是它們原本的 **400**，不是工單寫的 409。`source_busy` 是 409。
2. **extract 多兩種拒絕**：範圍要以使用者訊息開頭（同 move，DESIGN §5）；範圍內的失敗回覆與主機系統訊息也是 `move_protected_message`。
3. **有一則訊息的 seq 會變**：範圍最後一則換新 seq；其他訊息「保留原 seq」照工單。
4. **匯入的支線用新的 origin `import`**（工單沒指定）。
5. **extract 回應多了** `sourceLineId`、`rootLineId`、`reparented`、`summaryReset`（同 move）。
6. **decompose 回應多了** `lineId`、`truncated`；`seedCandidates` 每項是 `{messageId, text, reason}`。
7. **`messageCount` 只算主線訊息**（同工單範例）。
8. **`source` 不存進資料庫**，只傳給 InTx hook（`store.ImportedLine.Source`）。
9. **新設定 `httpapi.Config.MaxImportBodyBytes`**（預設 16 MiB）。
10. **`__unfiled__` 是保留資料夾名**；rename 的 `from` = `to` 回 `{updated: 0}`。
11. extract 只接受 investigate、alternative；三個新寫入不向 `Config.HostMeta` 要 host_meta。

## 留著的小事

- **訊息分頁**：抽出之後客戶端要重新載入來源線與新支線。標記的 seq 比客戶端讀過的都舊，`afterSeq` 游標拿不到它，只有 `message.created` 事件帶得到。已寫進 API.md，F13 要照做。
- **有篩選的列表**不走 archived / active 的部分索引；一般租戶大小沒問題。
- **decompose 的啟發式很粗**：中文雙字詞會切出怪標籤（範例裡的「機制」、「容器」）。
- 審查剩下的 LOW：卡片引用在上鎖前讀（同合併）；匯入的開放支線超過每個父線的上限（8）時整筆以 `branch_limit` 失敗。
