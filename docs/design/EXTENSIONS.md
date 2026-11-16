# Tangent · 功能模組清單

> 機制見 `docs/DESIGN.md` §11。這份文件列出每個功能模組的用途、依賴、資料、API 與優先順序。
> 2026-10-15 與使用者討論後確認：全部功能都要做，且都做成可選模組。
> 設計依據：未收尾的岔題會持續佔用注意力（Zeigarnik、Masicampo & Baumeister 2011、Leroy 2009）；
> 脈絡越長模型越不可靠（Laban et al. 2025、Chroma 2025）；記憶要可追溯、可取代、不靜默刪除（Mem0 的教訓）；
> 結構參考 XMind（摘要、外框、關聯線、浮動主題）、IBIS 論證地圖、Furnas 魚眼視圖。
> 後端細節（資料表、API、job、驗收）以 `docs/plan/BACKEND_PLAN.md` §4 B8–B10 為準；介面用語以 `docs/design/UI_DESIGN_BRIEF.md` §3 為準（leaf 在介面上叫「收尾」，notes 叫「紀要」）。
> 所有「建議」模式的功能共用建議匣（`tangent_suggestion`，B8）。

## 總表

| 功能 | 名稱 | AI 模式 | 依賴 | 階段 | 來源 |
|---|---|---|---|---|---|
| 筆記 | `notes` | — | — | S3 | 核心 |
| 章節 | `chapters` | —（開 / 關；主線回覆可帶 `[CHAPTER]` 行切章，隨回合、不另外呼叫，B16） | — | S3 | 核心 |
| 岔題 | `aside` | — | — | S3 | 核心 |
| 滾動摘要 | `summary` | 有 | — | S3 | 核心 |
| 結論卡草稿 | `card_draft` | 有 | — | S3 | 核心 |
| AI 建議開支線 | `branch_suggest` | 有 | — | S3 | 核心 |
| 結論節點 | `leaf` | 有 | — | P1 | 新 |
| 支線獨立成新對話 | `spinoff` | — | — | P1 | 新 |
| 念頭停車場 | `parking` | — | — | P1 | 新 |
| 備忘（不給 AI） | `memo` | — | — | B13 | 新（專注模式） |
| 名詞表 | `glossary` | —（開 / 關；在 `AllFeatures()`） | — | B24 | 新（學習時冒出的名詞） |
| 樹平衡提示 | `rebalance` | 有 | `leaf` | P1 | 新 |
| 魚眼脈絡 | `fisheye` | — | `leaf` | P2 | 新 |
| 群組摘要與支線合併 | `group` | 有 | `leaf` | P2 | 新 |
| 關聯線 | `relations` | 有 | — | P2 | 新 |
| 對話目標與偏題偵測 | `goal` | 有 | — | P2 | 新 |
| 未完成清單 | `open_loops` | — | — | P2 | 新 |
| 跨對話記憶 | `memory` | 有 | `notes` | P3 | 新 |
| 論證節點類型 | `ibis` | 有 | — | P3 | 新 |
| 發散 / 收斂模式 | `diverge` | 有 | `leaf` | P3 | 新 |
| 折疊 | `fold` | 有 | — | P3 | 新 |

核心行為（不是模組）：送出前預覽與 token 計量（`PreviewTurn`）、prompt 快取友善的排序（不變的區塊在前，背景包建好後不可改）、一條線第一輪的主題要約（回覆末行 `[TOPIC]`，改主線標題或支線目的，B16）。
純 UI、沒有後端的：專注模式（只顯示根到目前位置的路徑）、多種檢視（心智圖 / 大綱 / 時間軸）、匯出（Markdown 大綱、OPML、Mermaid mindmap）。

## P1

### `leaf` 結論節點
- 每條結束的支線都留一個 leaf：類型 `conclusion | decision | answer | dead_end | to_continue`、一句話 `line`、可選的詳細 `body`。
- merge = leaf + 結論卡；discard 也留 leaf（死路的原因是有價值的記憶，避免重複討論）。
- 模式：manual（使用者寫）/ suggest（離開支線時便宜模型起草，使用者確認）/ auto。
- 資料：`tangent_leaf(line_id PK, kind, line, body, source_job_id, created_by, ...)`。
- leaf 是兄弟支線與遠處節點看到這條支線的唯一內容（`fisheye`、`group` 都用它）。

### `spinoff` 支線獨立成新對話
- 從任一節點開新的主線，帶「膠囊」：根到分岔點的路徑摘要、相關筆記（複製並記錄出處）、該支線的 leaf；可選擇把支線的訊息一起搬過去。
- 原本的樹留 `branch_marker` 類的「已獨立 →」標記；兩邊互相連結。
- 資料：`tangent_link(id, tenant_id, from_line_id, from_message_id, to_line_id, kind)`，kind `spinoff`（`relations` 共用這張表）。

### `parking` 念頭停車場
- 一鍵把念頭存成「種子」：不開支線、不呼叫 AI、0 token。之後可以展開成支線、轉成筆記或丟掉。
- 資料：`tangent_seed(id, tenant_id, root_line_id, anchor_message_id NULL, text, status open|expanded|dropped, ...)`。

### `memo` 備忘（B13）
- 專注模式節點面板的「備忘」：寫在節點上、不給 AI 的筆記（不進 prompt、預覽與背景工作）。讀得到對話的人都讀得到，不是私人的。
- 資料：`tangent_memo(id, tenant_id, root_line_id, line_id NULL, source_label, text, created_by, created_at, updated_at)`；每棵樹 500 則、一則 4,000 字。
- 路由 `GET/POST /lines/{id}/memos`、`PATCH/DELETE /memos/{mid}`，事件 `memo.changed`。規格 `docs/design/FOCUS_MODE.md` §8。

### `glossary` 名詞表（B24）
- 學習時一直冒出新名詞：一棵樹一份「名詞 → 解釋」，可以跨對話查（`GET /terms`）。紀要（每輪全文進 prompt）與備忘（不給 AI）都不適合放幾十個名詞。
- **進 prompt 的只有名詞本身**：尾段區塊 `glossary`（記憶之後、`reply_lines` 之前，不在快取段），最多 300 token、超過時留最近更新的，要模型不必再解釋。解釋只給使用者看。
- 從順口問存名詞會在同一個交易把順口問設成保留（B23），存下來的順口問不會在 7 天後消失。
- 資料：`tangent_term(id, tenant_id, root_line_id, term, term_key, explanation, source_line_id NULL, source_message_id NULL, source_label, created_by, created_at, updated_at)`，`UNIQUE (root_line_id, term_key)`；每棵樹 300 筆、名詞 60 字、解釋 1,000 字。
- 路由 `GET/POST /lines/{id}/terms`、`PATCH/DELETE /terms/{tid}`、`GET /terms`，事件 `terms.changed`。第一版沒有 AI（不自動抽名詞）。決定見 DESIGN §12.10（B24 D1–D4）。

### `rebalance` 樹平衡提示
- 偵測：支線在分岔點之後的輪數 / token 超過主線、最近 N 輪都在支線、（可選）便宜模型判斷支線比主線更接近對話目標。
- 提示三選一：升為主線（promote，先替舊主線後半段生成 leaf）／獨立成新對話（spinoff）／維持並不再提醒。
- 只提示，不自動改結構；`ModeAuto` 在這個功能等同 suggest。

## P2

### `fisheye` 魚眼脈絡
- 以 `HistorySelector` 取代預設挑選：關注度 = 先天重要性 − 樹上距離（Furnas 1986）。
  祖先線近的給全文、遠的給摘要；兄弟與遠處支線只給 leaf 一句話。在 token 預算內挑最高分的內容。
- 先天重要性：leaf 類型（decision > conclusion > …）、筆記引用、使用者標記。

### `group` 群組摘要與支線合併
- 群組摘要（預設，非破壞性）：選多條支線生成一段共同摘要，prompt 只帶這段；原支線保留。對應 XMind 的「摘要」。
- 真正合併：新開一條支線帶合併後的背景，舊支線關閉並記錄 `merged_into`。
- 建議：依支線目的與 leaf 的相似度（有 Embedder 用 embedding，否則便宜模型分群）；合併前做衝突偵測（決定互相矛盾時標出）。
- 資料：`tangent_group(id, root_line_id, title, summary, ...)`、`tangent_group_member(group_id, line_id)`。

### `relations` 關聯線
- 任意兩個節點（訊息或支線）之間拉線並寫說明（XMind relationship）。AI 模式下可建議關聯；也是 `group` 的建議依據。
- 資料：`tangent_link`，kind `relation`。

### `goal` 對話目標與偏題偵測
- 每條主線一句目標（可由 AI 從前幾輪提出）。每輪完成後便宜模型判斷是否偏題，偏題時建議開岔題或支線（擴充 `branch_suggest`）。
- 資料：`tangent_goal(root_line_id PK, text, updated_at)`。

### `open_loops` 未完成清單
- 列出：開著且閒置超過 N 天的支線、`to_confirm` 筆記、未處理的種子。每項可結束 / 暫存 / 繼續（GTD 每週回顧）。
- 只讀查詢 + 既有操作，不需要新資料表。

## P3

### `memory` 跨對話記憶
- 三層：工作記憶（目前路徑）、情節（leaf、結論卡）、語意（筆記 + 跨對話知識庫）。
- 知識庫條目都有出處（來源 leaf / 筆記）；開新對話或支線時依「近期 × 重要性 × 相關性」（Generative Agents）提示相關記憶。
- 整併：定期合併重複、偵測矛盾；只能「取代」，不能刪除。
- 需要 `Embedder` 介面與 pgvector（功能專屬 migration）。

### `ibis` 論證節點類型
- 節點標記為 問題 / 想法 / 贊成 / 反對 / 決定（IBIS），便宜模型自動標記，使用者可改；樹狀圖依類型顯示。

### `diverge` 發散 / 收斂模式
- 發散：AI 一次提出多個方向，各開成兄弟支線。收斂：AI 以「條件 × 選項」比較表評估，產出 `decision` leaf。

### `fold` 折疊
- 把一段連續訊息折疊成摘要節點：訊息不搬動，送給 AI 時以摘要取代，畫面上收合。可依章節的話題切點建議折疊範圍。
- 用來整理已經很亂的線性對話（不能把中間的訊息搬走，因為後面的回覆建立在它們之上）。
