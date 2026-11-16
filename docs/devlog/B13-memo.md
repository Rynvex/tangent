# B13 · 備忘、結束的支線改名（專注模式階段二）

> 2026-10-25。工作單；規格 `docs/design/FOCUS_MODE.md` §7.2、§8。
> 使用者指定由協調者自己開發（不派 agent），並說「一次做完預計開發的部分跟做檢查」，所以後端、前端套件與畫面一起做完。
> 在獨立 worktree（`../tangent-b13`，分支 `b13-memo`）裡做。Go 測試用 `tangent_test`，smoke 用 :8121 與 `tangent_smoke`，e2e 用 Playwright 自己挑的 port 與 `tangent_e2e_<port>`；沒有碰 :8120、:5183，沒有呼叫付費模型。
> 工作單要求「先回報 DESIGN 的 diff、協調者同意後再實作」：這次協調者就是實作者，DESIGN 的改動（§4、§6 事件、§7 路由、§12.10 兩列決定）和程式一起進來，理由寫在下面。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...`、`gofmt -l`（`store/db` 以外） | 通過、無輸出 |
| `make sqlc` 後 `sqlc diff` | 無差異 |
| `go test ./... -count=1`（DB 測試實際執行） | 全部 ok；新的 `TestB13_*` 9 個（含 store 的 `TestB13_RenameRefusesPromotedAndPreviousMainLine`） |
| `scripts/smoke.sh`（:8121） | `SMOKE PASSED (704 events)`（smoke 沒有加備忘的步驟，備忘由 Go 測試、契約與 e2e 涵蓋） |
| web | typecheck 通過；vitest：fonts 9、client 857、react 844、demo 112（見最後一節的全套數字）；主 JS **178.20 kB gzip**（上限 180） |
| Playwright | 見最後一節 |

## 後端

### 備忘（`memo`）
| 項目 | 內容 |
|---|---|
| 功能 | `tangent.Memo()`，只有開或關；參考伺服器預設開（`defaultFeatures` 加 `memo`）。不註冊 `ContextProvider`、不碰 job |
| 資料表 | migration `014_memo`：`tangent_memo`，`root_line_id` CASCADE、`line_id` SET NULL、`source_label` 快照、索引 `(root_line_id, created_at)`。文字長度上限不放在 CHECK（只檢查非空），由 `Limits.Memo.TextMaxRunes` 管，宿主可以改 |
| 上限 | `Limits.Memo{TextMaxRunes: 4000, MaxPerTree: 500}`；`409 memo_limit{limit}` |
| 路由 | `GET/POST /lines/{id}/memos`（`?lineId=`、`{lineId?, text}`）、`PATCH/DELETE /memos/{mid}`；ops `memos.create/update/delete` |
| 事件 | `memo.changed {rootLineId, memoId, change}`，commit 後發，信封 `lineId` 是節點 |
| 錯誤碼 | `memo_not_found`（404）、`memo_limit`（409）。宿主 沒有同義字串（唯讀查過） |
| 鎖 | 寫入只鎖主線那一列（不改線的狀態）；修改與刪除先讀備忘找到主線、鎖主線、在鎖下再讀一次（併發刪除 → `memo_not_found`） |
| 封存 | 寫入拒絕（`409 archived`），讀取照常 |
| 出處 | `source_label` 用紀要的規則（`主線`、`查證・目的`…），寫入時的快照，改名不影響（有測試） |
| detach | 寫在搬走的線上的備忘跟著搬到新對話（`RehomeMemos`，同種子與收尾）；fresh 不複製 |

**不進 prompt 的證明**：`TestB13_MemosNeverReachThePrompt` 在紀要也開著時寫一則備忘，檢查 `PreviewTurn` 的整個 JSON 與 fake runner 實際收到的 system＋messages 都不含那段文字。mock 也有同樣的測試。

### 結束的支線改名
- `RenameOpenBranch` 改成 `RenameBranch`：`status IN ('open','merged','discarded') AND origin <> 'previous_main_line'`；Go 這邊 `domain.BranchRenamable`。
- **升為主線的支線**與**先前的主線**仍回 `branch_closed`（工作單寫「promoted 也放寬」，這裡沒有照做）：promote 之後那條支線的訊息已經搬到主線，只剩一條空線，改它的名字不會改到主線；先前的主線在介面上一律顯示固定名稱「原本的主線」，紀要標籤也不看目的。改了沒有任何效果，所以維持拒絕。
- 查到的「讀當下目的」的地方（請一個唯讀 agent 全面查過，102 處讀取分類）：

| 類別 | 地方 | 改名後 |
|---|---|---|
| 之後的 prompt／job 讀當下的值 | `prompt.go` 結論卡通知（`BranchPurposes`）、魚眼、群組摘要（`memberSource`）、AI 的關聯與群組建議、收尾草稿（已結束的支線也能重新起草） | 用新名字（刻意的；也會讓那一段 prompt 快取失效） |
| 寫入時的快照 | 結論卡與標記訊息的內容、背景包、紀要／種子／備忘的 `source_label`、記憶的標籤、獨立的膠囊與 `spunOffFrom`、建議匣 payload 的文字、比較表的選項名 | 不變 |
| 只是顯示 | `BranchView`、大綱、搜尋、連結的標題 | 新名字 |
| 會改寫歷史 | 沒有 | — |

- 一個要知道的差異：**還沒送達的結論卡**，改名後通知用新名字，但卡片訊息的內容是舊名字。這是接受「之後的回合用新名字」的結果，寫進了 DESIGN §12.10。

## 前端
| 層 | 內容 |
|---|---|
| client | `memo-routes.ts`（型別、正規化）、`listMemos`／`createMemo`／`updateMemo`／`deleteMemo`、`memo.changed`、`FEATURE_NAMES` 加 `memo`、錯誤碼；`canRenameBranch`（同伺服器規則）。mock：`mock-memos.ts`（同伺服器的規則與事件、不進預覽），情境在 ZFS 支線放一則備忘；mock 的改名改成新規則；刪除對話一起刪備忘 |
| react | `useMemos`／`useCreateMemo`／`useUpdateMemo`／`useDeleteMemo`，`memo.changed` 失效重抓；`NodeMemos`（點一下改、Enter 存、⇧Enter 換行、Esc 取消；選單：帶進這一輪、從這裡繼續談、轉成紀要…、刪除＋5 秒復原）；節點面板的「紀要（給 AI）n｜備忘（不給 AI）m」；N 在備忘開著時寫備忘；結束的支線可以改標題，編輯時有提示（帶回的寫結論卡來源、不帶回的寫一般說明）；大綱的 F2 也照新規則；地圖標記把備忘算進去，名稱念「n 則紀要、m 則備忘」；選取工具列「記成備忘」（只在專注模式、備忘開著時）；設定頁的功能名稱；`memo_limit` 的說明文字 |
| demo | 專注模式的地圖算備忘數；「記成備忘」寫在目前所在的線，用 toast 回報 |

## 和規格不同的地方
| 項目 | 規格 | 實作 | 理由 |
|---|---|---|---|
| 升為主線的支線改名 | 工作單寫 promoted 也放寬 | 仍拒絕 | 見上；改了沒有效果 |
| 「已轉成紀要」的標記 | 備忘標「已轉成紀要」並保留 | 標記只在這次瀏覽有效（沒有存在伺服器） | 存下來要多一個欄位；之後若需要再加 `converted_note_id` |
| 刪除的復原 | 5 秒可復原 | 用原文再建一則（新的 id、新的時間） | 後端是真的刪除；備忘沒有歷史可以保留 |
| 記成備忘的位置 | 「存到目前所在的線的節點」 | 同 | — |

## 最後一節：全套驗證
- Go：`go test ./... -count=1` 全部 ok（最後一次在前端完成之後重跑）。
- vitest（審查修正後）：fonts 9、client 857、react 845、demo 112（react 的全套在 Go 測試剛跑完、機器很忙時有一次 1 個失敗，重跑全過；同一個計時測試之前也這樣過）。
- 審查修正後再跑：Go `go test ./...` 全部 ok、`sqlc diff` 無差異；mock e2e 全套 **121 passed、3 skipped**；主 JS 178.22 kB gzip。
- Playwright 全套三組（mock、api、api-core，`--workers=3`，真 API 伺服器從這個分支建置）：**216 passed、64 skipped、1 failed**。失敗的是 `f5.spec.ts` 的「待處理審閱」（5 秒內頁面還沒出現訊息；機器很忙），單獨連跑 3 次都過，和這次的改動無關。skip 是原本就有的（只開核心的伺服器沒有那些功能等）。
- `focus.spec.ts`（mock，含 B13 的 3 個新案例）連跑 2 輪 **26 passed**。
- 截圖看過：1440 淺色與深色的備忘分頁、帶回支線改名時的提示；沒有頁面錯誤。

## 審查

完成後請兩個唯讀審查 agent（Go、TypeScript）看 `58093a0..HEAD`。成立並已修正：
1. （Go）`CreateMemo` 先讀主線再鎖主線：中間若剛好有 detach 把那條線搬到新的對話，會鎖到舊的主線、把備忘寫進錯的樹，新樹的上限也沒有被鎖住。`lockSeedRoot` 在鎖到之後再讀一次那條線的主線，不同就回 `409 concurrent_change`（種子也走同一個函式，一起變安全）。
2. （Go）`lockMemo` 同樣：鎖完再讀備忘時，若它已經被 detach 搬到別棵樹，回 `concurrent_change`。
3. （web）`NodeMemos` 沒有依節點重設：在 A 刪掉一則備忘再選 B，B 會顯示「已刪除・復原」；在 A 開著新增框再選 B 會寫到 B。現在 `NodeMemos`、`NodeNotes` 以節點為 key（有測試）。
4. （web）錯誤訊息出現後不會消失；復原失敗（例如上限）時備忘就找不回來。現在下一個動作會清掉錯誤，復原失敗時「復原」仍然可以再按。
5. （web）唯讀身分按 N 會切到備忘分頁卻什麼都不做；封存的對話同樣。現在直接不動作。

記下但沒改：5 秒內連刪兩則，只有最後一則能復原；「已轉成紀要」的標記只在這次瀏覽有效（再點一次會多建一則紀要）；分段控制的名稱含數字；`line.deleted` 沒有讓備忘重抓（只有刪整棵樹才會刪線，備忘跟著刪）。

## 過程
- 第一次全套 Go 測試的失敗都是預期中的：舊的改名測試（已結束不能改）、文件測試（API.md、EMBEDDING.md 的路由／事件／錯誤碼／op／功能表）、契約樣本（`go test ./httpapi -update` 重寫，`capabilities` 多了 `memo`）、預設功能數、`TestInTx_*`（新的寫入要跑一次）。
- 前端第一次 e2e：mock 的改名還是舊規則（已結束的支線回 `branch_closed`），改成 `canRenameBranch`；另一個是新增後輸入框還沒收起時同一段文字短暫出現兩次，測試改成找清單項目。
- 設定頁的功能名稱測試抓到 `feature.memo` 沒有中英文名稱，補上。
