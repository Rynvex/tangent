# F8 · 深度討論、學習紀錄與專案管理強化（前端階段一～三）

> 2026-10-25。工作單（交接包 `6_FRONTEND_F8.md`，含 §0 的 15 項設計決定）；設計稿已收錄。
> 使用者指定由協調者自己做：在獨立副本 `暫存工作副本 `tangent-f8-work``（`b189cb6` 的 `git archive`）開發，整理交付檔，使用者看過後合併進 `main`。
> 三個背景 agent 平行做互不重疊的檔案：mock 的 B14 路由與契約測試、匯出（產生器、預覽、對話框）、快捷鍵說明與對話清單。其餘由協調者做，最後再由唯讀 TypeScript 審查 agent 檢查。
> 只動了 `web/` 與本檔、工單、`docs/HANDOFF.md`；沒有改 Go；沒有碰 :8120、:5183；沒有呼叫付費模型。

## 驗收（合併到 `main` 後重跑）

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 5 個專案全部通過 |
| vitest（逐一套件） | fonts **9**、client **899**、react **878**、demo **146**。client 開工時 857 通過，8 個 B14 契約測試失敗 |
| `pnpm -C web build` | 通過。主 JS **179.77 kB gzip**（開工時 178.22，上限 180） |
| Playwright `e2e:mock --workers=4` | **136 passed、3 skipped、0 failed**。新的 `f8.spec.ts` 有 15 條：S1–S12，1440／420／375，含 axe |
| Go | `go vet`、`gofmt` 乾淨，`go test ./...` 全部 ok（沒有改 Go） |

- 真 API 的 Playwright project 沒有跑；`f8.spec.ts` 在 api project 會跳過，流程用 mock 的情境一。
- 機器上有別人的 Python 工作，load average 約 25。

## 做了什麼

### client
- **`b14-routes.ts`：** `TreeExport`、`DivergeModelsInput / Result`、`CreateSeedsBatchInput`、`SeedsBatchResult` 與 normalizer。
  - 常數：`EXPORT_MAX_MESSAGES_PER_LINE = 500`、`DIVERGE_MODELS_COUNT`、`SEED_BATCH_MAX = 20`。
- **`api.ts`：** 新增 `exportTree`、`divergeModels`、`createSeedsBatch`；`search({ root })`。四份 B14 契約樣本在 `contract.test.ts` 通過。
- **mock（`testing/mock-b14.ts`）：** 照 Go 的拒絕順序與事件。
  - 匯出遵守 500 筆與 `truncated`。
  - 跨模型：數量不對 400 `invalid_input`；模型不在清單 422 `model_not_allowed`；全開或全不開。
  - 批次種子：全存或全不存（409 `seed_limit`），只發一次 `seeds.changed`。
  - `mock-search.ts` 支援 `root`（含折疊裡的訊息，支線 id 404）。
  - 新指令 `[fake:list]`：只在 mock 有，回覆一段 Markdown 清單，給 S11 用。
- **純邏輯：**
  - `f8-turns.ts`：分岔點的規則（決定 #3、#4、#10）；「目的 · 模型」的截法和後端 `DivergeTargetPurpose` 一致，保留模型名稱。
  - `list-items.ts`：從回覆抓 Markdown 清單項目。
  - `stale-reasons.ts`：前提已更新的原因。
  - `tree-search.ts`：本機搜尋與命中位置（主線、支線、順口問、在折疊 #a–#b 裡）。
  - `tree-export.ts`：完整報告、備份 JSON、ADR、閃卡 `.md` / `.tsv`。

### react
| 項目 | 內容 |
|---|---|
| S1 `MessageActions` | AI 回覆固定顯示「開支線、停車（停車關閉時換成釘選）、複製」；使用者訊息固定顯示「修改並分岔、複製、釘選」；其餘放進「⋯」。<br>工具列浮在訊息上方：AI 在右上；使用者在泡泡左側，窄欄時改到右上。<br>按鈕在第一次指到或聚焦訊息時才建立；Tab 只停一次，方向鍵在按鈕間移動。<br>「⋯」選單（`message-menu.tsx`）延遲載入，Esc 關閉後焦點回到「⋯」 |
| 觸控 | 工具列隱藏；標籤列的「⋯」打開底部動作表（`MessageSheet`），每列 44px；AI 草稿類型放在第一列 |
| `ArgTag` | 沒有類型就不顯示（從「⋯ › 標論證類型…」設定）。<br>已確認：實線徽章。AI 草稿：虛線加「待確認」，滑過或聚焦時展開「確認、改類型…、移除」 |
| S2 `ArgReviewCard` | 在待處理最上面：全部確認、逐一看；部分失敗時保留沒確認成的那幾則 |
| S3 `InTreeSearchBar` | 搜尋功能開著時用伺服器的 `search({ root })`，關著時只搜已載入的內容並說明範圍。<br>結果分組並標出位置；↑↓ 選、Enter 跳過去；跳進折疊時展開（`FoldBlock.forceOpen`），關閉搜尋後恢復 |
| S6 `EditBranchDialog` | 從 #k-1 開「另一條路」支線，送出改過的文字（`useBranchAndSend`） |
| S7 `RegenerateDialog` | 用單選卡片選模型；錨點 #u-1；在新支線重送 #u；只有一個模型時才預選 |
| S8 `DivergeDialog` | 「AI 提出幾個方向」與「跨模型平行比較」放在同一個對話框，記住上次的選擇。<br>`DivergeModelsPanel`：選 2–5 個模型；每個 target 的目的由前端組好；送出失敗的支線只重送不重開。<br>發散標記上顯示每條支線的模型 |
| S10 | `NodeMemos` 的選單加「請 AI 檢驗理解…」→ `NodePanel` 組出查證支線的請求，檢驗提示只填進輸入框（決定 #9） |
| S11 `SeedsBatchDialog` | 容量從 `limits.maxOpen` 讀；預設只勾到剩下的空位；最多 20 項；可以直接改文字 |
| S12 `StaleBadge` / `StaleReasons` / `StaleMark` | 結論卡（現在延遲載入）、大綱的 20px 標記、節點面板的警告區；「知道了」存在 localStorage |
| 其他 | `SegmentedControl` 的選項可以停用；`MenuContent` 可以指定 `anchor` 與 `finalFocus`；命令新增 9 個；`StructurePanel` 可以把匯出列換成一顆「匯出對話…」 |
| i18n | `f8-messages.ts`、`export-messages.ts` 是延遲載入的 bundle。<br>主字典只加了一直顯示的少數字：「更多動作」、「修改並分岔」、9 個命令名稱。<br>設定頁的英文（`settings.*`、`feature.*`）移到 `en.settings.ts`，由 `addEnglish` 在設定對話框與送出前預覽載入時才註冊（獨立 chunk，0.89 kB gzip） |

### demo
- **`f8-frame.tsx`：** 只放狀態與命令（搜尋列、對話框、輸入框上方的提示）；換對話時會重設。
  - `f8-slots.tsx`：延遲載入搜尋列、匯出對話框、快捷鍵說明。
- **`branch-flows`：** 新增 `editBranch`、`regenerate`、`seedsBatch`、`askAgain` 四種流程；開支線可以帶 `prefill`。
- **S4、S5（背景 agent）：**
  - `shortcuts-dialog.tsx`：依目前的綁定分組，標出 Firefox 不能用的鍵；純觸控又沒偵測到鍵盤時不提供入口（`has-keyboard.ts`）。
  - 置頂：`pinned-roots.ts`，localStorage `tangent:pinned-roots:v1`。
  - 改名：清單裡直接改，頂列選單開小對話框。
  - 清單底部固定「回顧」與「記憶庫」。
- **S9 `export-dialog.tsx`（背景 agent）：** 格式依用途分組；預覽就是會下載的內容；可以複製或下載；截斷時顯示提示。
- **提示可以帶一個動作**（「看停車場」，停留 6 秒）。

## 和工作單不同的地方
1. **矛盾關聯沒有欄位：** API 的關聯沒有 `relationKind`，目前用 label 判斷（含「矛盾／衝突／contradict」，排除「不矛盾」「does not contradict」）。
2. **紀要欄位名稱：** 工作單寫 `supersededByNoteId`，實際是 `supersededBy`。
3. **停車場上限：** 是 100，不是 20。前端照 `limits.maxOpen` 讀；一次批次最多 20 項。
4. **問題是這條線的第一則時：** 沒有 #u-1，跨模型比較的「建好後在每條支線送出」預設不勾，避免同一個問題問兩次。
5. **S2 沒有「復原」：** API 無法把類型改回 AI 草稿。卡片只讀已載入的主線與目前這條線。
6. **使用者訊息的工具列：** 放在泡泡左側，避免蓋住標籤與類型徽章。
   - 訊息列有 `content-visibility`，會裁掉超出的內容，所以列與列之間的 24px 改成 12px 間距加 12px 上方內距。
7. **只開核心時：** AI 回覆仍有「⋯」，因為裡面有屬於核心的「分岔重答」。
8. **大綱匯出 3 種：** 沒有 FreeMind。
9. **快捷鍵說明：** 第三組叫「紀要與停車」；對話框寬 760。
10. **頂列標題：** 不能雙擊或按 F2 改名，改從頂列選單改名。
11. **「看停車場」提示：** 不易用鍵盤操作（停車場也可以從側欄打開）。
12. **觸控判斷：** 每個頁面只讀一次 `pointer: coarse`（省主程式大小），可切換觸控的裝置在切換後要重新整理頁面。

## 審查與合併時的修正
- **唯讀 TypeScript 審查，採納並修好的：**
  - 跨模型送出失敗後重試會重開支線
  - 「改類型…」選單打開後失去錨點
  - 再按 ⌘F 沒有把焦點帶回搜尋框
  - 關閉搜尋或改名後焦點沒有回到原處
  - StrictMode 下「改問」會建兩次對話
  - 切換發散方式時整個對話框重新掛載
  - 輸入框聚焦的迴圈和使用者搶焦點
  - 換對話時搜尋與對話框的狀態沒有重設
  - 「不矛盾」被誤判為矛盾
  - 標題超過 200 字仍會送出
  - 其他分頁清除 storage 時，置頂沒有更新
- **審查認為 `enSettings` 會留在主程式：** build 確認它是獨立的 chunk，沒有採納。
- **合併到 `main` 時發現的效能問題：** `message-list.perf.test`（2000 則訊息）在負載下逾時。
  - 和基準比較，同樣負載下基準通過，單獨跑時 F8 慢約 15%；原因是每則使用者訊息都多了一個工具列。
  - 改成工具列的按鈕在第一次指到或聚焦訊息時才建立（設計稿本來就寫「hover／focus-within 才渲染」）。
  - 現在單獨跑約 2.0 秒，基準是 3.1 秒。相關的單元測試與 e2e helper 也改成先指到訊息再找按鈕。

## 需要後端（先不做，有需要再開 B15）
1. 關聯加上種類欄位（例如 `relationKind: "contradicts"`）。
2. 能列出整棵樹的 AI 草稿論證類型，也能把類型還原成草稿。

## 給下一步
- 主程式 JS 只剩約 0.2 kB，再加任何東西到主程式前要先瘦身。
  - 主字典裡只有延遲載入部分用到的英文，可以照 `en.settings.ts` 的做法再搬出去。
- 驗證 e2e 用 `e2e/tests/helpers.ts` 的 `messageAction`、`setArgType`、`argBadge`：它們會處理工具列、「⋯」選單與觸控動作表三種情況。
