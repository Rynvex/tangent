# F13 · 資料夾與標籤、外部對話匯入、中段抽成支線、拆解建議（設計稿 S1～S5）

> 2026-10-30。工單（已歸檔），設計交付包。基線 `main` @ `ae9a9af`（已含後端 B18，見 `docs/devlog/B18-import-extract-organize.md`）。
> 純前端，只改 `web/` 與 `docs/`；沒有改 Go、schema、migration 或 `httpapi/testdata`。在獨立 worktree（`../tangent-f13`，分支 `f13`）由一個實作 agent 完成，未 commit，交協調者驗證。
> 沒有碰 宿主；開發期間沒有動 :8120、:5183（看畫面用另一個 port 的 mock dev server，e2e 自己挑 port）；沒有呼叫付費模型。

## 驗收

| 檢查 | 結果 |
|---|---|
| `pnpm -C web typecheck` | 5 個專案全部通過 |
| vitest（逐一套件） | fonts **10**、client **1052**、react **1007**、demo **197**（開工時 10、**936＋53 個失敗**、987、189） |
| `pnpm -C web build` | 通過。主 JS **164.7 kB gzip**（`gzip -c` 主入口 `index-*.js \| wc -c` = 164,742 bytes；vite 報 165.48 kB；開工時約 161.1，上限 172） |
| Playwright `e2e:mock --workers=4` | **154 passed、3 skipped、0 failed**（新增 `f13.spec.ts` 6 個測試） |
| client 契約測試 | B18 留下的 53 筆（`contract.test.ts` 27、`mock-contract.test.ts` 26）全過 |

延遲載入的 chunk（都不進主程式）：`import-dialog`（匯入對話框＋表單）、`extract-branch-dialog`（抽成支線，訊息選單與拆解面板都從這裡載）、`f13-host`（拆解面板與匯入橫幅）、`folder-tags-popover`、`f13-messages`（套件用語）。

## 做了什麼

### §2 對接 B18（`@tangent/client`、mock、hooks）
- `Line.folder`（預設 `""`）、`Line.tags`（永遠是陣列）；`BRANCH_ORIGINS` 加 `import`；`CreateLineInput` / `UpdateLineInput` 可帶 `folder`、`tags`（PATCH 的空 patch 檢查也認這兩個）；`listLines` 可帶 `folder`（含 `__unfiled__`）、`tag`。
- `b18-routes.ts`：四條路由（`renameFolder`、`importConversation`、`extractBranch`、`decomposeLine`）的型別與 normalizer；`normalizeTag(s)`、`normalizeFolder` 照 `domain/line_org.go`；`classifyExtractError`；限制常數都對照 `domain/import.go`、`domain/limits.go`、`httpapi/api.go`（主線 200、支線 100 則、20 條、每則 32,000 字、body 16 MiB、檔案 20 MB、每個父線 8 條進行中、抽出 40 則、目的 200 字）。
- `normalizeDecomposePlan` 原樣保留伺服器的 `suggestedTags`。
- mock（`mock-b18.ts`、`mock-decompose.ts`）：
  - 資料夾與標籤的正規化、`__unfiled__` 保留字、對支線給非空值回 400、列表篩選、改名與解散（封存的也算，各發 `line.updated`）。
  - 匯入：一次寫完，支線 `origin: import`、預設 `alternative` / `discarded`，錯誤碼與欄位名同伺服器（`invalid_input` + `field`、`too_long` 422、超過 8 條進行中 `branch_limit` 409），事件順序同 API.md。
  - 抽出：規則與順序照 `store/branch_extract.go`（`source_busy` 409；`move_must_start_with_user`、`move_no_anchor`、`move_protected_message`、`invalid_count` 都是 400；`kind_unsupported`；`invalid_card` 422），範圍最後一則換新 seq、標記或已送達的結論卡寫在它空出來的 seq；帶卡時支線直接 `merged`，leaf 開著時寫結論收尾。
  - decompose：把 `domain/decompose.go` 與 `decompose_text.go` 的規則照搬（同樣的雙字切詞），所以 demo 會出現和真伺服器一樣的中文碎片，`filterSuggestedTags` 才有東西可以測。
- `spinoff.fresh` 先前的 `$.branch: extra` / `$.notes: missing`：那是因為 mock 契約測試對同一條路由「有任何一次呼叫的形狀對得上就算過」，fresh 與 detach 共用 `POST /spinoff`。B18 加欄位後兩次都對不上，所以報了最後一次（detach）的差異；補上 `folder` / `tags` 後 fresh 那次又對得上了。沒有改這個規則，也沒有加任何允許清單。
- hooks（`data/b18-hooks.ts`）：`useUpdateLineOrganization`、`useRenameFolder`、`useImportConversation`、`useExtractBranch`、`useDecompose`。
  - **抽出之後**：`resetAfterExtract` 對來源線與新支線的 `messages`、`folds`、`stream` 做 `resetQueries`（清掉再讀，不是合併），並 invalidate 大綱、章節、兩條線、被改掛的支線與預覽。標記的 seq 比快取讀過的舊，`afterSeq` 補抓拿不到，有測試（`f13.test.tsx`）。
  - `useDecompose` 一次打開一份快照（`staleTime: Infinity`、`gcTime: 0`），套用項目時建議不會在使用者眼前變動。
  - `event-sync`：`line.updated` 的資料夾或標籤變了，列表重讀（篩選結果可能進出）；`keys.lines` 加入 `folder`、`tag`。

### 純函式
- `import-parsers.ts`（＋`import-tree.ts`、`import-transcript.ts`、`import-html.ts`）：
  - ChatGPT `conversations.json`：從 `current_node` 沿 `parent` 往上走出主線；跳過隱藏、工具呼叫（`recipient` 不是 `all`）、非文字內容；分岔點上不在主線的其他子節點（往最新的子節點走到底）就是另一版：第一則是 user 的算「重問」、是 assistant 的算「重新生成」，掛在分岔點以上最近一則主線訊息；被改過的那則主線訊息標「n 版」。第一則提問的重問前面沒有可掛的訊息，計入 `skippedBranches`。ChatGPT 的 `chat.html` 讀它 script 裡的 `jsonData`。
  - Claude `conversations.json`：只取 `text` 區塊（tool_use、thinking 不要）；有 `parent_message_uuid` 時建樹，主線取到最新一則訊息為止（匯出檔沒有記錄畫面上是哪一版），其他版本同上。
  - Gemini：Takeout 的 `MyActivity.json` 與 `MyActivity.html`（每個 Prompted 項目一輪；HTML 用 `DOMParser` 解成不會執行的文件，只讀文字），API 的 `contents`（user / model），以及 Markdown 對話稿（標記是 Gemini 時來源記為 Gemini）。都沒有分支。
  - Tangent 備份（匯出對話框存的 `GET /export` JSON）：主線＋掛在主線上的一階支線（目的、種類、狀態照備份）；順口問、更深的支線、掛在結論卡上的支線不匯入並計數；資料夾與標籤帶回來。
  - 純文字 / Markdown：行首的發言者標記（`User:`、`**ChatGPT:**`、`## You`、`ChatGPT said:`、`你：`、`AI：`…）開始一則；code fence 裡的不算；沒有任何標記時依空行交替分成你與 AI，並提示要檢查角色。
  - 多篇的檔案依更新時間由新到舊；未知結構回 `unsupported`，沒有訊息回 `noMessages`。
- `import-plan.ts`：把解析結果與預覽裡的修改（切換角色、移除）組成 `POST /lines/import` 的 body，送出前檢查所有限制（見下「和工單不同」1、2）；`importBodyBytes` 以 UTF-8 計算。
- `suggested-tags.ts` `filterSuggestedTags(rawTags, title, existingTenantTags, exclude?)`：英數字詞與其他對話用過的標籤保留；落在標題同一個主題詞裡的雙字詞依重疊接回原詞（微分＋分幾＋幾何 → 微分幾何）；標題以標點、英數字、連接詞（與、的、在、為什麼…）切詞；其餘的雙字詞連續接得上就接，開頭或結尾是功能字（在、的、要、怎…）的丟掉。dev server 的真實例子 `["微分","分幾","幾何","何在","研究"]`（標題「微分幾何在物理研究中的應用」）得到 `["微分幾何","研究"]`。
- `extract-range.ts`：起點（AI 回覆往上對齊到這一輪的提問；第一輪沒有錨點；被已帶回且卡片還在這條線上的支線掛著的訊息受保護）、終點選項（到下一張結論卡、搬移標記、失敗或未完成的訊息、宿主系統訊息、章節切點、受保護的錨點之前，最多 40 則）、預設終點（邊界前最後一則回覆）、`firstSentence`。
- `line-organization.ts`：`tagCounts`、`folderNames`、`groupByFolder`、`visibleTags`。

### S1 左側清單
- 頂列「匯入對話」（`FileUp`）在「新對話」左邊，唯讀身分不顯示。
- 搜尋框下單選的 `#tag (n)` 膠囊列（依使用次數，先列 8 個，其餘在「更多 n 個」選單），左右鍵切換；選了之後 `TagFilterBanner`「篩選標籤：#postgres（3 篇）清除」，清單改用伺服器的 `?tag=` 篩選，空資料夾隱藏，沒有資料夾的列在「未分類」。
- 資料夾在置頂下面、時間分組上面：收合箭頭、`Folder`／`FolderOpen`、名稱、篇數；收合狀態存在這台裝置（`localStorage`，失敗就不記）。資料夾內縮排 12px＋1px 導線。只剩封存對話的資料夾仍顯示（0 篇）。
- `FolderMenu`：重新命名資料夾…（原地輸入，Enter 儲存、Esc 放棄、失敗保留文字並說明）、解散資料夾（說明「對話移回未分類，不會刪除」，完成後提示幾篇移回）。唯讀身分沒有選單。
- 對話列第二行狀態後面最多 2 顆 `#tag`，再多顯示 `+n`；篩選中的標籤用 primary。

### S2 匯入對話框（`import-dialog.tsx`、`import-form.tsx`、`tag-input.tsx`）
- 寬 640，手機全螢幕；分段「貼上對話文字／Markdown」｜「上傳匯出檔」（預設上傳）；拖檔進來整塊變 primary 虛線。
- 上傳：超過 20 MB 不讀直接說明；讀檔失敗、看不懂、沒有訊息都有 alert。識別後顯示檔名、大小、篇數與「已識別：ChatGPT 匯出檔」等徽章；多篇時「匯入哪一篇」（預選最新）。
- 有重問／重新生成時出現 primary 外框的核取區（預設勾選），寫出在哪幾則；第一則提問的重問、超過上限的、被關掉的、被截斷的都另外說明。Gemini 與對話稿不出現這一塊（決定 #10）。
- 訊息預覽：`#n`、角色膠囊（點一下 你 ⇄ AI）、摘要、「n 版」、移除／恢復（只剩一則不能移除）。設計狀態表的 R / Delete 快速鍵沒有做（見「和工單不同」12）。
- 標題（預填）、放入資料夾（既有、未分類或新資料夾）、標籤（`TagInput`：晶片、打字列出既有標籤與篇數、新增「#x」、上限 12）。建議標籤是「這個租戶已在用、而且出現在標題或前 6 則中至少 2 則」的標籤，用虛線，可移除；不呼叫模型。
- 底部「n 則・k 條支線・不呼叫模型」、取消、純匯入、匯入並開啟拆解建議（`Sparkles`）。
- 匯入後切到新對話：「純匯入」在頂部顯示 `ImportedBanner`（「已匯入 N 則訊息・有 K 項拆解與支線建議」，可打開建議、可關閉）；「匯入並開啟拆解建議」直接打開面板。兩者都不呼叫模型（決定 #6：decompose 本身也是規則）。

### S3 抽成支線（套件 `ExtractBranchDialog`）
- 使用者訊息與 AI 回覆的 ⋯ 都有「從這則抽成支線…」（`Scissors`）。demo 用它取代原本的「從這則起搬成支線」（尾段只是其中一種範圍；`MoveBranchDialog` 仍在套件裡給其他宿主用）。
- 寬 560，手機全螢幕。「從」唯讀；從 AI 回覆打開時對齊到這一輪的提問並說明；第一輪停用並說明原因；範圍只有提問一則時主按鈕停用並說明。
- 「到」只列可以的終點，預選邊界前最後一則回覆；下方「抽出 n 則訊息・新支線從 #a 岔出・主線上 #x～#y 會以外框標示」。
- 開著時主線上的範圍加 `--tg-primary` 外框、其他訊息淡出（`RangeHighlight`：以 `data-tg-message` 寫一段限定在 `[data-tg-root]` 的樣式，不重繪訊息列）。
- 種類（查證／另一條路）、目的（預填）、「直接標為已帶回，主線原位留一張結論卡」預設勾選並預填結論（範圍最後一則回覆的第一句，註明沒有呼叫 AI）；不勾時說明會留標記。主按鈕跟著變；底部估計主線少幾則與下一輪約省多少 token。
- 錯誤各有說明；範圍變了（`move_protected_message` 等）會重讀訊息，終點自動縮回；深度軟上限可以「仍要開」。
- 成功後切到來源線並捲到留下的卡或標記，提示「已把 n 則訊息抽成…」＋「前往支線」。

### S4 拆解與整理建議（套件 `DecomposePanel`，demo `f13-host.tsx`）
- 桌面是右側 400px，開著時取代側欄（頂列側欄按鈕顯示為按下；按它會關面板、回到側欄）；手機是從頂部 96px 起的大面板；換到別的對話就關閉（決定 #7）。
- 標頭「依規則產生、不呼叫模型・待你確認・已套用 a / n」。卡片：還沒處理是 suggestion 虛線，套用後實線灰底＋「已套用」，可以復原的有「復原」。
  - ① 中段岔題：範圍、主題、預覽結論；「抽成支線並留結論卡」打開 S3 並預填終點、目的、結論（成功後「已抽成支線」＋「看支線」）；「原地折疊成摘要」直接用 `createFold` 帶入建議的範圍與摘要（決定 #8，可復原 = 刪除摺疊）；「略過」。滑過或 focus 時主線上的範圍加外框。
  - ② 主線章節切點：§1 與每個建議切點（話題轉換、間隔很久）；「一鍵建立 n 個章節切點」逐一 `addMilestone`，可復原。
  - ③ 標籤與待辦：`filterSuggestedTags` 之後的標籤，點一下貼到主線（變實線 primary 加勾，再點一下拿掉，上限 12）；未解問題預設全勾，「存入停車場（n 項）」逐一 `createSeed`（錨在原訊息），可復原 = 丟棄。
  - ④ 相關對話與拆分：同資料夾或共有標籤的對話，「建立跨對話關聯」（可復原）、「前往查看」；最後一個話題轉換切點在 #3 以後時，警示卡「從 #n 獨立成新對話…」打開既有的 spinoff 對話框。
- 每個動作看功能（fold、chapters、parking、relations、spinoff）與寫入權限；唯讀身分只能看。

### S5 對話選單與資料夾與標籤
- 對話選單在重新命名、置頂之後加「資料夾與標籤…」（`Folder`）與「拆解與整理建議…」（`Sparkles`），用分隔線隔開，第一次用之前標「新」（存在這台裝置）。
- `FolderTagsPopover`：寬 360，清單中貼在對話列右邊、頂列中在選單按鈕下；手機是底部表。資料夾單選膠囊（未分類＋既有＋虛線「新增資料夾」變輸入框）、標籤晶片輸入（`n / 12`、儲存中…）、常用標籤快選。改了就存；失敗時把那一項還原並說明；Esc 或點外面關閉。
- 彈窗放在清單層而不是那一列的選單裡：改資料夾會讓那一列搬到別的群組（重新掛載），放在列裡會把彈窗一起關掉。

### i18n
- 設計稿用語表全部加進中英文：套件的放 `i18n/f13-messages.ts`（只隨延遲載入的部分），demo 的放 `frame/f13-shell-messages.ts`、`frame/f13-import-messages.ts`。
- 全部用 lucide 圖示，沒有系統表情符號。

### 測試
- client：`import-parsers.test.ts`（jsdom；含「HTML 裡的 script 不會執行」）、`import-plan.test.ts`、`suggested-tags.test.ts`、`extract-range.test.ts`、`b18-routes.test.ts`、`testing/mock-b18.test.ts`；`contract.test.ts` 與 `mock-contract.test.ts` 加入四條路由與演練。
- react：`f13/f13.test.tsx`（抽出後兩條線的訊息重置、標籤與資料夾、抽成支線對話框三種情況、拆解面板的折疊／標籤／停車場／唯讀、模型、外框樣式、選單項目）。
- demo：`frame/f13-frame.test.tsx`（資料夾、篩選、解散、唯讀、彈窗存檔與失敗還原、貼上匯入、20 MB 與不支援的檔案、ChatGPT 多篇與還原分支）。
- e2e：`f13.spec.ts`（S1、S2＋S4＋S3、第一輪、S5、唯讀、375 手機），fixture `web/e2e/fixtures/chatgpt-conversations.json`。

## 和工單／設計不同的地方

1. **超過 200 則的長對話分段匯入**（設計沒寫）：保留的訊息超過 200 則時說明「這篇有 N 則…請分段匯入」，並提供「第 1～200 則／第 201～400 則…」選單，一次匯入一段；掛在其他段的支線不匯入並計數。不截斷、不自動丟資料。
2. **超過上限的支線**：超過 20 條的不匯入、超過 100 則的只留前 100 則、Tangent 備份裡超過 8 條進行中的改成已結束匯入（還原的重問本來就是 `discarded`，不佔進行中名額），都在核取區說明，所以匯入不會整筆以 `branch_limit` 失敗。單則超過 32,000 字不自動截斷，列出是哪幾則，移除後才能匯入；body 超過 16 MiB 同樣先擋。
3. **標籤的篇數**：伺服器沒有計數路由，膠囊上的數字是這個頁面已載入的主線（`GET /lines` 第一頁，預設 50）裡的數；篩選後的提示列是伺服器篩選結果的筆數（同樣是第一頁）。租戶很大時數字可能偏小。
4. **「AI 建議」的字樣**：面板與結論預填都不是模型產生的（決定 #6），所以標頭寫「依規則產生、不呼叫模型」，結論寫「預填自 #n 的第一句（沒有呼叫 AI）」，不寫「AI 草稿」。
5. **抽成支線的卡片問題**：設計只畫結論欄；伺服器要求卡片有問題，所以問題送範圍第一則提問（壓成一行、最多 300 字），不另外顯示。
6. **從 AI 回覆打開**：設計稿寫起點就是那則回覆；照協調者決定 #4 對齊到這一輪的提問並說明。
7. **訊息選單**：「從這則抽成支線…」取代 demo 原本的「從這則起搬成支線」；`branches.spec` 的搬移測試改走新對話框（取消勾選、留標記，驗證同樣的結果），`features.spec`、`f8.spec` 的選單清單加上新項目。
8. **對話列標籤**：照工單「最多 2 顆＋`+n`」（設計稿文字是「第 2 顆位置改成 +n」，畫面畫了 3 顆）。
9. **ImportedBanner** 只在這次匯入的對話上顯示，關掉或換頁後不再出現（沒有存到伺服器或 localStorage）。
10. **章節切點**用 milestone（`addMilestone`）建立；切點的復原是刪除這些 milestone。
11. Claude 匯出檔沒有記錄畫面上是哪一版，主線取到最新一則訊息為止。Gemini Takeout 沒有對話 id，相隔 30 分鐘以上的提問分成不同篇。
12. **預覽列的 R / Delete 快速鍵**（設計狀態表）沒有做：預覽列本身不是焦點停駐點，掛在列上的快速鍵會在焦點落在列內按鈕時誤觸（審查指出），所以只保留可見的按鈕。
13. **資料夾選擇**是一組 `aria-pressed` 的切換按鈕，不是 radio（沒有方向鍵的 radio 會讓螢幕閱讀器報出不能用的操作方式）。

## 審查與修正

唯讀 TypeScript 審查 agent：沒有 CRITICAL。修掉的：
- HIGH：資料夾與標籤彈窗的自動存檔在連續修改時會互相覆蓋（後到的回應清掉較新的草稿）→ 改成一次一筆依序送出最新的完整狀態；失敗時還原並說明。修的過程中又抓到：線還沒讀到就送出會把既有標籤清空 → 讀到之前不顯示控制項、不送出。
- HIGH：匯入表單的 key 對貼上文字永遠是同一個，換一段文字會沿用上一段的移除、角色與標題 → 每次解析（與每次讀檔）有自己的版本號。
- MEDIUM：匯入計畫每次 render 都序列化整個 body（改 `useMemo`）；貼上文字每次 render 重新解析、選第二個檔案時舊的讀取會蓋掉新的（加版本號）；JSON 解析的 try 包住整個解析器，一個超出範圍的時間戳就讓整個 ChatGPT 檔變「看不懂」（拆開，`isoTime` 檢查 Invalid Date）；發言者標記的 regex 對超長空白行是 O(n²)（先 `trimStart`、只比對行首 200 字、改寫 regex）；別的分頁替對話加了新標籤時，那個標籤的篩選列表不會重讀（`event-sync` 比對已知的資料夾與標籤，變了或不知道時重讀有篩選的列表；有測試）；選中的標籤消失時膠囊列沒有可 Tab 到的項目；解散資料夾後群組卸載、提示不見（改用 `mutateAsync`）；章節切點中途失敗時已建的沒有復原（保留已建的與復原，並顯示原因）；資料夾選擇用 radio 角色卻沒有方向鍵（改成 `aria-pressed` 按鈕）。
- LOW：匯入中可以關掉對話框而不會切到新對話（改用 `mutateAsync`、取消鈕停用）；預覽列的 R / Delete 隱藏快速鍵在焦點在按鈕上時也會觸發（拿掉，只留按鈕）；換對話時外框沒清掉；「已套用」把本來就有的標籤也算進去；換終點時結論不跟著換（沒手改過就跟著換）。
- 沒有改的：沒有用 worker 解析大檔（20 MB 以內在主執行緒同步解析）；彈窗關掉後才失敗的儲存不再提示（下次打開看得到伺服器的值）；註解裡的中文 UI 字串沿用 F8 以來的寫法。

另外看截圖時修的：資料夾改了之後那一列換到別的群組（重新掛載），彈窗原本留在舊位置 → 錨點改成每次量測都重新找那一列的虛擬元素。

開發中自己抓到並修掉的：
- 抽出成功後 `resetQueries` 讓 `useMessages` 暫時沒有資料，宿主元件回傳 `null` 卸載了對話框，`mutate` 的 callback 因此沒跑、對話框又以 `#0` 重新出現；拆解面板也被卸載、套用狀態遺失。改成：hook 的 `onSuccess` 不 await 重載，對話框用 `mutateAsync` 的 promise，宿主用 `useSticky` 保留最後一份資料。
- 資料夾與標籤彈窗原本掛在對話列的選單裡，改資料夾時那一列換群組重新掛載，彈窗跟著關掉；移到清單層。
- 匯入表單的資料夾選單用 `""` 當「未分類」，Base UI Select 把它當成沒選；改用保留字 `__unfiled__`。
- 手機匯入對話框的訊息預覽被壓扁（flex 子項縮小）；改成不縮。

## 留著的

- 標籤篇數只算已載入的第一頁（見上 3）。
- `shell.tsx` 約 700 行（F13 的狀態與接線約 90 行）；之後可以抽成 `useF13Frame`。
- 拆解面板打開時若在別的分頁對同一條線做了大改動，計畫不會自動更新（刻意的快照）；關掉再開會重讀。
- 抽出時跨過範圍的摺疊、移到標記上的章節切點，mock 沒有模擬（伺服器有，前端照事件重讀）。
- 大檔（接近 20 MB）在主執行緒同步解析，可能卡一下；之後可以移到 Web Worker。

## 截圖

`docs/devlog/screenshots/F13/`（`UPDATE_SCREENSHOTS=1` 跑 `f13.spec.ts` 產生，淺色）：
- `filter-1440.png`：S1 標籤篩選與提示列；`folders-menu-1440.png`：資料夾選單；`list-375.png`：手機清單抽屜
- `import-1440.png`、`import-375.png`：S2 匯入 ChatGPT 匯出檔（識別、選篇、還原分支、預覽、資料夾與標籤）
- `decompose-1440.png`、`decompose-375.png`：S4 匯入後的拆解面板與橫幅
- `extract-from-panel-1440.png`：從面板打開、預填好的 S3；`extract-dialog-1440.png`：從 AI 回覆打開、起點對齊；`extract-375.png`
- `conversation-menu-1440.png`：S5 對話選單的兩個新項目；`folder-tags-1440.png`、`folder-tags-375.png`：資料夾與標籤彈窗／底部表
