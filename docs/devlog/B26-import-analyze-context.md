# B26 — 匯入分析的上下文抽取（模型端）

日期：2026-11-13　工單：已歸檔（工單 34）　規格來源：`docs/plan/import-analyze-over-merge.md` §2（實作紀錄在 §2.3）

沒有 migration，沒有改 `web/`、`store/`。全程離線：只用 fake runner 與純函式測試，**沒有呼叫任何真模型**；
真模型的評測見 §5，由協調者取得使用者同意後再跑。

## 1. 做了什麼

- **`domain/import_analyze.go`**：輸入上限拆成 `ImportAnalyzeQuestionRunes` 600、`ImportAnalyzeAnswerRunes` 2,000（超過仍是截斷）。
  `ImportAnalyzeTextRunes`（300）保留，改指確定性演算法與修補讀的摘錄：新的 `analyzeExcerpts` 把正規化後的問題與回答再截成 300 字，
  `AnalyzeImportDeterministic` 與 `ParseImportAnalyzeOutput`（`import_analyze_parse.go`）都先過它。
  `CutRunes(CutRunes(x, N), 300) == CutRunes(x, 300)`（N ≥ 300、x 已去掉前後空白），所以兩者的輸出與之前逐字相同。
- **`domain/import_analyze_context.go`**（新）：純函式。
  - `questionExcerpt`／`questionWithin`：≤ 400 字全文，更長是前 300 ＋「 … 」＋後 100；縮到任意字數時前後 3:1。
  - `answerSentences`／`answerEnds`：首句與末句。斷在換行、。！？、後面是空白或結尾的 .!?（`1.5`、`asyncio.gather` 不斷）；
    code fence（```、正規化後的 '''、~~~）整塊算一句、不在裡面斷，沒關的 fence 到結尾；沒有字母或數字的片段（`---`、`**`）不算句子。
    首句末句各壓成一行、≤ 120 字，只有一句時末句是空的。
  - `analyzeGap`／`formatGap`／`analyzeUnitGaps`：與前一個**有時間**的單元相隔超過 30 分鐘時標 `+31m`、`+3h`、`+1h 5m`、`+2d 3h`、`+7d`；
    剛好 30 分鐘、倒退、沒有時間都不標；沒有時間的單元不重設起點。
- **`domain/import_analyze_keywords.go`**（新）：回答的關鍵詞。
  - 候選是回答的話題詞（`importTopicTermsAt`，確定性演算法的同一套詞），去掉問題與標題已有的。
  - 分數 = 權重 × 在回答裡出現的次數（英數字詞以整詞計：`nas` 不算在 `dynasty` 裡），同分依出現順序，最多 8 個，每個 ≤ 30 字，整行 ≤ 80 字。
  - 權重二選一（`ImportAnalyzeKeywordRanking`）：`weights`（預設）是 fallback v2 的 `analyzeTermWeights`（呼叫，不改；它沒讀到的、回答 300 字之後的詞依書寫系統給 1.5／1.0）；
    `idf` 是 `ln(1 + 單元數 / df)`，df 算在每個單元的標題＋問題＋回答。
  - 漢字：以雙字排序，但顯示它所在的「不含虛詞字的整段漢字」（`hanPhraseCandidates`），超過 6 字取最佳雙字附近 6 字；被已選詞組包含的跳過。
    第一版直接列雙字，金樣裡出現「庫之、間放、礑步、區逛」這種跨詞的雙字，對模型是雜訊，所以改成詞組（§3）。
- **`domain/import_analyze_prompt.go`／`import_analyze_prompt_unit.go`**：
  - `BuildImportAnalyzePrompt(in)` 不變的簽名，等於 `BuildImportAnalyzePromptWith(in, ImportAnalyzePromptOptions{})`；
    `ImportAnalyzePromptOptions.Keywords` 只給 Go 呼叫者（`tangent-eval`）用，引擎與 HTTP 都用預設。
  - 單元的段落：`### U2 (2 messages, +2d 3h)`、`Title:`、`Question:`、`Answer, first sentence:`、`Answer, last sentence:`、`Answer key terms:`，
    內容都經 `branchQuote`（`> ` 開頭的引用資料）；沒有回答寫 `Answer: none`。
  - 預算 `importAnalyzePromptBudgetRunes` = 60,000 字，算**整個 prompt**（`Prompt.Chat()` 的系統段＋使用者訊息）。
    每單元配額 = （預算 − 指示與標頭）÷ 單元數，下限 150（`importAnalyzeUnitFloorRunes`）。
    放不下時：去掉末句 → 去掉首句 → 最小形（標題截 40 字、問題壓成一行並依剩下的配額縮成前後 3:1、至少 40 字，加關鍵詞）。
  - 指示文字（`importAnalyzeInstructions`）第一段改成說明單元的新內容與間隔標記；「Deciding each unit」加一句：
    長間隔是換題的提示、不是證據，回指前面單元的仍是延續。
- **`cmd/tangent-eval`**：`-import-keywords weights|idf`（預設 `weights`，其他值 exit 2），開跑前印出的呼叫次數那行與報告的 Model 行會寫用了哪一種。
- **測試**（全部離線）
  - `domain/import_analyze_context_test.go`：首句／末句（中文、英文、混合、只有程式碼、程式碼在中間、沒關的 fence、空回答、只有空白、單句、小數、長句截斷）、
    問題摘錄、時間間隔（剛好 30 分鐘、31 分鐘、時區、倒退）與有時間／沒時間混合。
  - `domain/import_analyze_keywords_test.go`：去掉問題的詞、次數優先、詞組顯示、長詞組取窗、只有問題詞的詞組不列、整詞計數、最多 8 個、只有程式碼、空回答、
    兩種排序在「每個單元都有的詞」上結果相反、未知的排序等於預設、行長上限。
  - `domain/import_analyze_budget_test.go`：1、20、200 個「所有欄位都到上限」的單元都 ≤ 60,000 字，每個單元都有問題與關鍵詞，1 與 20 個保有首句末句，
    200 個沒有句子；200 個一般大小的單元保有完整問題；單一單元依配額逐級降級的順序；間隔標記與 `Answer: none`；指示有提到新內容；
    兩份 golden（`testdata/import_analyze_weekend.prompt.txt`、新增輸入 `import_analyze_context.input.json` 的 `import_analyze_context.prompt.txt`，
    `-update-analyze-prompt` 重寫）；確定性演算法與修補對「長文字」與「先截成 300 字」的輸入結果相同。
  - `domain/import_analyze_test.go`：截斷測試改成 600／2,000。
  - `cmd/tangent-eval/import_eval_test.go`：模型收到的 prompt 等於指定排序的 `BuildImportAnalyzePromptWith`；未知排序 exit 2；報告寫出排序。

## 2. 數字

| 情境 | 之前（99e7901） | 之後 |
|---|---|---|
| 200 個單元、所有欄位到上限（系統＋使用者訊息） | 5,136 + 110,920 = **116,056** 字（沒有預算） | 5,504 + 54,454 = **59,958** 字 |
| 20 個單元、所有欄位到上限 | — | 22,172 字（全套，首句末句都在） |
| 1 個單元、所有欄位到上限 | — | 6,569 字 |
| 200 個一般單元（問題 60 字、回答 800 字） | — | 54,877 字（問題完整，句子去掉） |
| 評測樣本 cooling（6 單元） | 5,841 | 6,586（`idf` 6,586） |
| 評測樣本 mvcc（9 單元） | 6,381 | 7,445（`idf` 7,446） |
| 評測樣本 pgpool（15 單元） | 7,087 | 8,626（`idf` 8,623） |

系統指示從 5,136 字增為 5,504 字。

## 3. 一個單元改前改後（`domain/testdata/import_analyze_context.input.json` 的 U3：貼了 traceback 的長問題）

改前（問題前 300 字、回答前 200 字；問句在後面，被切掉了）：

```text
### U3 (2 messages)
Question:
> 改成 transaction 之後跑 migrate 出現這個錯誤：
> 
> Traceback (most recent call last):
>   File "manage.py", line 22, in <module>
>     main()
>   File "/app/venv/lib/python3.12/site-packages/django/db/backends/utils.py", line 89, in _execute
>     return self.cursor.execute(sql, params)
> psycopg.errors.DuplicatePreparedSt…
Answer (start):
> 這是 psycopg 3 的伺服器端 prepared statement 與 transaction 模式衝突造成的。
> 
> 在 transaction 模式下，同一個客戶端的兩次交易可能落在不同的伺服器連線上，psycopg 自動準備的 _pg3_0 就會撞名。
> 
> 有兩種修法：在 Django 的 OPTIONS 加上 prepare_threshold: None 關掉自動準備；或升級到 Pg…
```

改後（輸入保留 600 字，問題前 300 … 後 100；首句、末句、關鍵詞）：

```text
### U3 (2 messages)
Question:
> 改成 transaction 之後跑 migrate 出現這個錯誤：
> 
> Traceback (most recent call last):
>   File "manage.py", line 22, in <module>
>     main()
>   File "/app/venv/lib/python3.12/site-packages/django/db/backends/utils.py", line 89, in _execute
>     return self.cursor.execute(sql, params)
> psycopg.errors.DuplicatePreparedSta … ，default_pool_size 20，max_prepared_statements 沒有設。本機直連 Postgres 不會出錯，只有經過 PgBouncer 才會，而且不是每次都出現，大概…
Answer, first sentence:
> 這是 psycopg 3 的伺服器端 prepared statement 與 transaction 模式衝突造成的。
Answer, last sentence:
> 有兩種修法：在 Django 的 OPTIONS 加上 prepare_threshold: None 關掉自動準備；或升級到 PgBouncer 1.21 以上並設定 max_prepared_statements = 100，讓 Pg…
Answer key terms:
> 伺服器端, 模式衝突造成, 模式下, 伺服器連線上, 自動準備, 關掉自動準備, prepare_threshold, none
```

這個例子的原問題 685 字，被 600 字的輸入上限截過一次，所以「後 100」是第 500–600 字而不是原文最後的問句（見 §4）。
U2（客套開頭＋程式碼區塊＋總結）改後的首句是「好的，這是個很常見的問題！」、末句是「總結：高併發短交易選 transaction 模式…」，
標頭是 `### U2 (2 messages, +2d 3h)`；改前看到的是客套話加上被切在 `[pgbounc…` 的程式碼。

## 4. 和工單／方案不同的地方

1. **`ImportAnalyzeTextRunes` 沒有刪**：改指確定性演算法與修補讀的 300 字摘錄。刪掉它會讓確定性演算法讀到更多字、輸出改變，違反「確定性演算法不變」；
   保留也讓網頁 `IMPORT_ANALYZE_TEXT_RUNES` 的註解仍然成立。修補（`ParseImportAnalyzeOutput`）也讀摘錄，工單要它的檢查與修補不變。
2. **網頁送的仍是 300 字、沒有 `startAt`**（不在這張工單的範圍，但影響效果）：`web/packages/client/src/import-analyze-apply.ts` 的 `unitOf`
   送出前就把問題與回答截成 300 字，也不帶 `startAt`。所以從網頁進來的分析，這次的改變只有「首句／末句／關鍵詞」的重新排列；
   600／2,000 字的材料與時間間隔標記要等網頁把 `unitOf` 改送更長的文字與每輪第一則訊息的時間（建議開一張網頁工單）。
   `tangent-eval` 與直接呼叫 API 的宿主不受影響。
3. **關鍵詞**：分數乘上在回答裡出現的次數（純權重時漢字雙字幾乎都是 1.0，只能靠出現順序）；問題與標題已有的詞不列；
   漢字顯示成整段詞組而不是重疊的雙字（§1）。排序本身（權重或 IDF）照工單做成可切換。
4. **預算算整個 prompt**（含約 5,500 字的系統指示），而且在「只剩問題＋關鍵詞」之後再縮短問題與標題，這樣 ≤ 200 個單元時一定在預算內；
   方案估的「問題＋關鍵詞約 250 字」在問題本身就有 400 字時放不下 200 個單元。下限 150 照方案，只在呼叫者自訂更小的預算時才會用到。
5. **時間間隔**從前一個有時間的單元算；方案沒寫沒有時間的單元怎麼辦。
6. **超過 600 字的問題**：normalize 是從頭截，所以「後 100 字」是截斷後的最後 100 字，不是原文結尾。要保留原文結尾，normalize 得改成頭尾都留，
   這次沒做（輸入檢查的行為要盡量不動；網頁也只送 300 字）。

## 5. 待協調者執行的付費評測（需先取得使用者同意）

評測集目前 3 份樣本（cooling 6、mvcc 9、pgpool 15 個單元），`tangent-eval -mode import` 每份樣本呼叫一次模型，開跑前會印出次數。

```bash
# 1) 預設排序（伺服器用的）：3 次呼叫
TANGENT_EVAL_IMPORT_MODEL=claude-cli:sonnet go run ./cmd/tangent-eval -mode import -import-keywords weights -out /tmp/b26-weights.md
# 2) IDF 排序：3 次呼叫
TANGENT_EVAL_IMPORT_MODEL=claude-cli:sonnet go run ./cmd/tangent-eval -mode import -import-keywords idf -out /tmp/b26-idf.md
```

- 合計 **6 次**呼叫；每次輸入約 6.6k–8.6k 字（約 6–9k token）、輸出 0.4k–1k token。以 Anthropic API 的 Sonnet 計約每次 US$0.03–0.05，6 次約 US$0.3；
  用 `claude-cli` 則算進訂閱額度。
- 要和改前比，需要在 99e7901 的 checkout 上跑 1)（再 3 次，`-import-keywords` 那時還不存在，拿掉）。
- 注意：三份樣本的回答都很短（≤ 85 字）、沒有 `startAt`，所以這次評測主要量到「首句／末句＋關鍵詞」取代「回答前 200 字」的效果，
  時間間隔與長回答的部分量不到；兩種排序的差異預期也很小。要量到長回答與時間間隔，評測集需要加真實匯出檔（`-mode import-convert`）。

## 6. 驗證

- `go vet ./...`：通過。`gofmt -l .`：無輸出。
- `go test ./... -count=1`：全綠（Postgres :5444 可連，DB 測試有跑）；`-v` 下的 SKIP 只有既有、需要環境變數的 6 個
  （`TestPerf_*` 兩個、`TestPromote_Explain`、`TestSearch_Explain`、`TestRealCLISmoke`、`TestRealModelSmoke`）。
- `go test ./domain -run ImportAnalyzeEval`：通過，`baseline.json` 沒有變動；`git diff --stat` 裡沒有 `httpapi/testdata/contract/route.lines.import_analyze.json`
  與 `domain/testdata/import_analyze_eval/baseline.json`；weekend 的確定性金樣 `import_analyze_weekend.plan.json` 也沒變。
- `bash scripts/smoke.sh` 沒有跑（工作指示：固定的資料庫與 port，留給協調者）。

## 7. 觀察與後續

- 首句常是客套話（U2 的「好的，這是個很常見的問題！」）。工單照方案要首句；如果真模型評測顯示首句沒幫助，可以改成「第一個含話題詞且不只是客套的句子」，
  或把首句的配額讓給關鍵詞。
- 關鍵詞的詞組窗偶爾切在詞中間（「併發短交易選」）；可接受，模型讀得懂。
- 分窗（> 100 單元）仍是後續步驟。
