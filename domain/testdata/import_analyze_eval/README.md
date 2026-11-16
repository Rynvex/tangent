# 匯入分析評測集

每個 `*.json` 是一份人工標好的對話（`domain.ImportAnalyzeEvalSample`）：`units` 是分析輸入，
`gold` 是它應該得到的節點（每個單元恰好在一個節點；`role` 可省略；`note` 寫為什麼這樣分）。

- `go test ./domain -run ImportAnalyzeEval -v` 用確定性演算法跑每一份，印出 pairwise precision／recall／F1
  與角色命中，並與 `baseline.json` 比對：低於基準就失敗；演算法改進後用
  `go test ./domain -run ImportAnalyzeEval -update-analyze-baseline` 重寫基準。
- `go run ./cmd/tangent-eval -mode import` 另外用模型跑（`TANGENT_EVAL_IMPORT_MODEL=claude-cli:sonnet`
  或 `anthropic:claude-haiku-4-5` 等；沒設就只跑確定性演算法）。模型呼叫要花錢或額度，每份一次，開跑前會印出次數；
  任何一次失敗就以 exit 1 結束。`-min-import-f1` 是門檻（百分比）。`-import-keywords weights|idf` 選 prompt 裡回答關鍵詞的排序
  （B26；預設 `weights` 是伺服器用的），兩種各跑一次就能比較；只影響模型，確定性演算法的分數不變。
- 新增樣本：`go run ./cmd/tangent-eval -mode import-convert -export conversations.json -out-dir <目錄>`
  把 ChatGPT／Claude 匯出檔轉成每篇一份、每單元一個節點的草稿（`"draft": true`，評測會拒絕），
  手動合併 `gold`、填 `role`、拿掉 `draft` 後才算樣本。草稿含整段對話原文，放進 repo 前先確認內容可以公開。
  避開 prompt 範例用過的素材（weekend、NAS／asyncio）。

precision 低 = 不該合的合了；recall 低 = 該合的拆了。
