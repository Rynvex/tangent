# UI 原型審查與前端實作規劃

日期：2026-10-15　來源：`Tangent_prototype_checkpoint.zip`（Claude Design，設計 v2 定案），已放進 `docs/design/prototype-v2/`
依據：`docs/design/UI_DESIGN_BRIEF.md`（需求）、`docs/DESIGN.md`（契約）、`docs/plan/BACKEND_PLAN.md`（後端里程碑與同步點）

## 1. 審查結論

**可以進入實作。** 需求 §5 的 35 個畫面全部有對應位置（交接 `handoff/README.md` 的編號表），§9 八題都有答案與理由，
10/15 回覆的 16 題也已反映在設計中。交接包把規格整理成文字（元件表、互動規格、快捷鍵、token、待後端確認清單），實作以交接文字為準、原型為視覺參考。

怎麼看原型：在 `docs/design/prototype-v2/` 執行 `python3 -m http.server`，開 `Tangent 原型.dc.html`
（參數 `?frame=desktop|embed|mobile`、`?theme=light|dark|host`、`?state=loading|empty|reconnecting|aiError|readonly|limit|forkGone|full8`）。
`file://` 直接開會載不到 support.js。

已用無頭瀏覽器檢查 1440 淺色 / 深色、420 宿主主題、375 手機、C–D 畫面與色票頁，版面與內容符合需求。

**token**：`handoff/tokens.css` 是現有 `styles.css` 的嚴格超集（原有名稱與值都沒變），新增 28 個：
收尾類型 5、論證類型 5、`primary-text`、`highlight`、`suggestion(-soft)`、`success-soft`、`warning-soft`、字級 7、閱讀寬度與行高、圓角 3、`shadow-overlay`。
另加 `data-theme="host"`（宿主深色主題與 Geist）。

## 2. 實作時要修正的問題（不需退回設計）

| # | 問題 | 位置 | 處理 |
|---|---|---|---|
| 1 | 輸入框、選擇框用 `--tg-border-strong`，對比只有 1.5–1.7:1；表單元件邊界需要 3:1（WCAG 1.4.11） | 原型 57 處、色票頁已標「不足」 | 新增 `--tg-border-input`（三套主題各 ≥ 3:1），表單元件改用它；裝飾性邊框維持原樣 |
| 2 | 手機版程式碼區塊沒有橫向捲動，長指令被截斷 | A2 手機 | 程式碼區塊 `overflow-x: auto`，並提供複製按鈕 |
| 3 | 手機與觸控裝置仍顯示「Enter 送出・⌘B 開支線」鍵盤提示 | 輸入框 | `(hover: none)` 時隱藏快捷鍵提示 |
| 4 | 主線則數在原型兩處不一致（33 則 / 41 則） | A8 大綱、C1 | 假資料問題，實作用真資料，不處理 |
| 5 | Google Fonts 只用於原型；正式版必須自架（交接已寫明） | 全部 | 用 npm 套件打包字體（`@ibm/plex-sans`、`@ibm/plex-mono`、`@ibm/plex-sans-tc`、Source Serif 4、Noto 系列、Geist），子集化後 preload 主要字重 |

## 3. 交接包「待後端確認」15 項的答覆

| # | 項目 | 答覆 | 落在哪裡 |
|---|---|---|---|
| 1 | 草稿的基準點 | 已有：`draft_parent_tip_message_id`。v1 只顯示「主線多了 n 則」與那幾則的連結；「其中幾則可能相關」需要 AI 判斷，延後 | B3（已完成資料） |
| 2 | 單輪估算 API | 用 `POST /lines/{id}/preview`（不寫入）。金額需要價格表：Engine 新增 `WithPricing(map[model]Price)`，有價格時回傳 `estimatedCostUsd` | B4 |
| 3 | 費用門檻存哪 | 前端的使用者偏好（瀏覽器儲存）；宿主可透過 `TangentProvider` 的 `defaultCostThreshold` 預設或鎖定 | 前端 |
| 4 | 「等你」的定義 | = 支線有未讀，或結論卡草稿已就緒待審。`LineView` 的彙總加 `awaitingReview` 數量 | B4 |
| 5 | 紀要「新」標記 | 前端依條目 `createdAt` 與本機記錄的最後檢視時間判斷；後端不存每位使用者的檢視時間 | 前端 |
| 6 | 釘選訊息 | `Message.pinned` + `POST/DELETE /messages/{mid}/pin`（fisheye 模組） | B9 |
| 7 | 合併時的矛盾選擇 | 合併請求帶每個矛盾項的選擇（採用 A / 採用 B / 都保留）；「都保留」寫入紀要「待確認」 | B9 |
| 8 | 搬移後改掛 | 已有：move 會把掛在被搬訊息上的支線改掛到新支線並重算深度 | S2（已完成） |
| 9 | 建議的持久化 | 建議匣 `tangent_suggestion`：忽略後冷卻期間不再提；樹平衡「維持」= 忽略該建議 | B8 |
| 10 | 比較表的決定 | 新增 `POST /comparisons/{cid}/decide`：同一交易內替選定支線建「決定」收尾、其他兄弟支線設為未帶回並加「死路」收尾 | B10 |
| 11 | 記憶比對 | 相關性 × 近期 × 重要性（有 Embedder 用 embedding 相似度）；開新對話與開支線時各取前 3 筆 | B10 |
| 12 | 開太久的支線 | 改用「進行中且超過 N 天（預設 3）沒有活動」，依 `last_activity_at`；「待處理」數量由 `open_loops` 提供 | B9 |
| 13 | 順口問保存 | 「記進紀要」寫入「已確認的事實」；紀要條目新增 `sourceLabel`（寫入時存來源的文字快照），來源被清除後仍顯示文字 | B8 |
| 14 | 論證類型 | 已規劃：`tangent_message_tag(kind, source ai/user)`；使用者改過的不被 AI 覆蓋 | B10 |
| 15 | 折疊 | 已規劃的 `tangent_fold` 加 `tokens_original`、`tokens_summary` 兩欄 | B10 |

會改到契約的項目（2、4、7、10、13、15）已記在 `docs/DESIGN.md` §12，並更新 `docs/plan/BACKEND_PLAN.md`。

## 4. 前端實作規劃

原則：套件元件（`@tangent/react`）只用 `--tg-*` token、不碰路由與全域狀態；demo 專用的元件放 `apps/demo`。
每個階段的完成條件：`pnpm -C web typecheck test build` 綠、新元件有測試、Playwright 在 1440 / 420 / 375 各一條主要流程、axe 無嚴重問題、
與原型截圖並排檢查（存在 `docs/devlog/screenshots/`）、`typescript-reviewer` 審查的 HIGH 以上修完。

| 階段 | 內容 | 依賴 | 可開始 |
|---|---|---|---|
| **F0 基礎** | 換上 `tokens.css` v3 + 修正 #1；字體自架；基礎元件（Button、Dialog、Popover、Tabs、Tooltip、Menu，用 @base-ui/react）；三欄外框與寬度規則（`components.md`）；`CommandPalette`；快捷鍵框架（宿主可改鍵或停用）；`StatusBanner`；i18n 鍵；mock API（C1 前用暫定型別，C1 後改用契約樣本） | 無 | 現在 |
| **F1 對話** | `ConversationList`（demo）、`UserMessage`、`AssistantMessage`（Markdown、程式碼、數學、表格）、`MessageActions`、`Composer`、串流（SSE + `/stream` 補抓）、`UsageMeter`、`TurnPreview`、`ForkMarker`、AI 建議開支線、A14 全域狀態 | C1 | F0 後用 mock，C1 後接真 API |
| **F2 支線** | `OpenBranchDialog`、`KindRadio`、`BranchBar`、`ForkPeek`、`SelectionToolbar`、`BranchCardReview`、`BranchCard`、不帶回 / 升為主線 / 搬移對話框、`OutlineRow` 樹（`interactions.md` 的鍵盤規格）、`BranchMap`（沿用 client 的 layered layout）、章節 | C1 | 同上 |
| **F3 紀要與設定** | `NoteItem` 與紀要頁、`SideTabs`（依 capabilities 顯示）、`SettingsDialog`（demo）、功能模式的呈現規則、420 嵌入示範頁（宿主主題） | C1 | 同上 |
| **F4 P1** | `Leaf`、獨立成新對話、`SeedCard` 與停車場、樹平衡提示、`SuggestionCard` 與建議匣 | C2 | B8 之後 |
| **F5 P2** | 魚眼可視化（預覽與地圖圖層）、群組與合併、關聯線（`interactions.md`）、目標與偏題提示、`ReviewBoard`（demo） | C3 | B9 之後 |
| **F6 P3** | `MemoryRecall`、`MemoryFooter`、`MemoryLibrary`（demo）、`ArgTag`、`DivergeMarker`、`CompareTable`、`FoldBlock` | C4 | B10 之後 |

建議順序：F0 與後端 B3 / B4 平行；B4 完成（C1）後 F1–F3 接真 API 並補 e2e；之後每個後端同步點完成，就接著做對應的 F 階段。

## 5. 交給前端實作 agent 的材料

- `docs/design/prototype-v2/`（原型與交接包）、本文件 §2–§4。
- `docs/design/UI_DESIGN_BRIEF.md`（需求與用語）、`docs/DESIGN.md` §6–§8、§11、§12。
- `docs/devlog/W0-web.md`（現有前端結構與暫定型別）。
