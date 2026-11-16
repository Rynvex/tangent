# G1 · CLI 多模型 catalog、思考深度透傳、開局選模型

> 2026-11-15。工單（§2 catalog／自動偵測／fallback、§3 reasoning effort、§4 capabilities 擴充與 Composer 模型 pill、§5 測試）。
> 基線 `70f0dae`，與 G3 同一個 checkout 平行進行，**未 commit、未 push**。
> 零付費呼叫：沒有用 prompt 執行真的 `claude`／`codex`／`agy`，沒有呼叫任何模型 API。CLI 參數用 `prepare` 直接組出來驗證；端到端用一個寫參數檔的 shell 假 claude；smoke 用 `TANGENT_DEV=1` 的 fake provider。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...` | 通過 |
| `go test ./... -count=1` | 除 `httpapi` 外全部通過。`httpapi` 的 `TestContract_EveryRouteAndEventAgainstTheSamples` 失敗：`route.spinoff.detach`、`route.suggestions.accept.spinoff`、`route.lines.archive`、`route.lines.unarchive` 四個樣本只有 `usage.inputTokens`／`costUsd` 不同（prompt 變短），來自 G3 正在改的 `prompt.go`／`domain/prompt_build.go`，不是 G1 的變更（G1 沒有動 prompt，也沒有改 httpapi 的任何檔） |
| `pnpm -C web typecheck` | 通過（5 個專案） |
| `packages/client` `npx vitest run` | 98 檔 1359 測試：1349 通過、**10 失敗，全部是基線就有的 B25**（`route.imports.*`、`route.lines.import.batch`、`route.lines.list.pinned` 的 client／mock 契約，與 `DOMAIN_ERROR_CODES` 少 `import_batch_not_found`；F19 devlog 記錄的同一批） |
| `packages/react` `npx vitest run` | 104 檔 1115 測試通過 |
| `apps/demo` `npx vitest run` | 55 檔 376 測試通過 |
| `pnpm -C web build`（mock） | 通過；主 JS gzip **161.30 → 163.68 kB**（上限 172；+2.38）。選單 chunk `model-pill-menu` 1.38 kB gzip |
| `VITE_TANGENT_API=http pnpm -C web build` | 通過；主 JS gzip **173.62 → 176.25 kB**（上限 185；+2.63） |
| smoke（`TANGENT_DEV=1`，fake，:8120，結束後已停） | 啟動 log：`claude-cli`、`agy-cli` ready、`codex-cli skipped: executable not found`；`/api/capabilities` 有 `ready` 與 `details`；`POST /lines {reasoningEffort:"high"}` → `hostMeta.reasoningEffort=high`；`PATCH {reasoningEffort:"ultra"}` → 400 `invalid_input`；`PATCH low` 後送訊息，使用者訊息的 `hostMeta` 是 `{"reasoningEffort":"low"}`，fake 正常回覆；測試對話已刪除 |

## 決策

### 1. 思考深度怎麼從網頁帶到 runner（不改 DB）

選擇：**線的 `host_meta` 存對話的選擇，送出時複製到使用者訊息的 `host_meta`，函式庫把訊息的 `host_meta` 原樣放進 `RunRequest.HostMeta`，參考伺服器的 `routedRunner` 讀出來填 `RunRequest.ReasoningEffort`。**

流程：

1. 網頁 `PATCH /lines/{id}`（或 `POST /lines`）送 `reasoningEffort`。httpapi 照舊忽略不認得的欄位；參考伺服器的 `httpapi.Config.HostMeta` 掛勾（`cmd/tangent-server/hostmeta.go` `effortMeta`）從本文讀出來，驗證（`low`/`medium`/`high`/`xhigh`/`max` 或 `""` 清除，其他 400 `invalid_input`），寫進線的 `host_meta.reasoningEffort`（`lines.update` 先讀現有 `host_meta` 合併，只動這個 key）。
2. `POST /lines/{id}/messages`（op `turns.send`）時，同一個掛勾決定使用者訊息的 `host_meta`：本文的 `reasoningEffort` 優先，否則用線的，支線沒有設定時用主線的；都沒有就不寫。
3. 函式庫：`Turn.Request()` 把 `Turn.UserMessage.HostMeta`（不是空的 `{}` 時）複製到新欄位 `RunRequest.HostMeta`；函式庫不讀它的內容。
4. `routedRunner.Run`：`ReasoningEffort` 已有值就用，否則讀 `HostMeta.reasoningEffort`；只有該模型接受這個等級時才留下（Claude 的 `max` 與 Codex 的 `xhigh` 互為等價，降級時換成對方的名字），其他清空。
5. `runner/cli`：`claude` 加 `--effort <level>`（`low`/`medium`/`high`/`max`，`xhigh` 視為 `max`），`codex` 加 `-c model_reasoning_effort="<level>"`（`low`/`medium`/`high`/`xhigh`，`max` 視為 `xhigh`）；不認得的值不加參數；`agy` 不支援，忽略。

理由：

- **不改 schema**：`store/`、`domain/` 不在範圍內；`host_meta` 本來就是「宿主自己的資料」，參考伺服器就是宿主。
- **客戶端仍然不能寫 `hostMeta`**（DESIGN 的既有規則）：網頁送的是一般欄位 `reasoningEffort`，由宿主掛勾決定寫什麼。
- **跨行程與重試都對**：effort 跟著使用者訊息存在資料庫，`LoadTurn`（遠端 worker）與 `POST /retry` 重建的 `Turn` 都帶著同一個 `UserMessage`，所以同一回合永遠用送出當下的 effort；每則使用者訊息也留下「用哪個 effort 跑的」紀錄。
- **不增加回合的查詢數**：`RunTurn` 不必讀線；額外的讀取只發生在 HTTP 送出請求的掛勾裡（`GetLine` 一次，支線沒設定時再讀主線一次），`turn_queries_test` 量的 BeginTurn＋CompleteTurn 不變。
- **`@tangent/react` 的 `useSendMessage` 不用改**：它只送 `{content}`，effort 由伺服器從線上補。
- 沒選的方案：model 名稱加後綴（會污染 `allowModel`、定價、顯示）；`RunRequest` 加 `LineID` 讓 runner 自己讀線（每回合多一次查詢、job 也會被套用、跨行程要再查）；只放在 `POST /messages` 本文（react 的送出 hook 不在範圍內，且無法存成對話的預設）。

### 2. Go 嵌入契約（向後相容）

- `tangent.RunRequest` 新增 `ReasoningEffort string` 與 `HostMeta json.RawMessage`，零值等於以前的行為；`ChatRequest`、`Job.Request()` 不帶 `HostMeta`；`Turn.Request()` 只在使用者訊息的 `host_meta` 不是空的（`""`、`null`、`{}`）時才帶，所以沒有 host_meta 的回合 `Turn.Request()` 仍然等於 `ChatRequest(...)`（`TestChatRequest_IsWhatRunTurnSends` 不變）。
- `tangent.ModelGroup` 新增選填 `Ready *bool`、`Reason string`、`Details []ModelDetail`，全部 `omitempty`，舊宿主的 catalog JSON 一字不差（`TestModelGroup_OldShapeWithoutDetails`）。`ModelDetail{Model, DisplayName, Status, EffortLevels}`，`Status` 是 `tangent.ModelCurrent`／`tangent.ModelLegacy`。`WithModelCatalog` 丟掉沒列在 `Models` 的 detail 與重複的；`ModelCatalog()` 回深拷貝。
- `runner/cli.EffortLevels(Backend) []string`（回拷貝；Agy 是 nil）。

### 3. CLI preset catalog（`cmd/tangent-server/catalog.go`）

- 沒設 `TANGENT_ALLOWED_MODELS` 時，每個**有 runner 的** CLI provider 自動帶入 preset：
  - `claude-cli`：`claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`、`claude-fable-5-2`；別名 `opus`、`sonnet`、`haiku`、`fable` 通過 `allowModel` 但不列在 catalog（避免重複）。
  - `codex-cli`：`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-luna`、`gpt-5.4-mini`（legacy）。
  - `agy-cli`：`gemini-4-carbon`、`gemini-4-argon`、`gemini-3.8-flash`、`-high`、`-medium`、`-low`（3.8 系列標 legacy）。
- 設了 `TANGENT_ALLOWED_MODELS` 仍是嚴格白名單：不加 preset，也不認別名（`Allowlisted`）。
- 排序：CLI provider 內，`TANGENT_<NAME>_CLI_MODEL`（或 `TANGENT_MODEL`）設定的模型排第一（即使是 preset 以外的名稱或別名，例如 `sonnet`），其次 preset 的順序，其餘依名稱。非 CLI provider 照舊依名稱排序。
- `details`：preset 有顯示名稱與狀態（別名顯示為「Claude Sonnet 5.5 (sonnet)」）；`effortLevels`：claude 的模型是 `low/medium/high/max`，**`claude-haiku-5-5` 不給**（保守：不確定 Haiku 接受 `--effort`，不提供就不會有沒作用的開關）；codex 的模型是 `low/medium/high/xhigh`；agy、openai、anthropic、fake 都沒有（它們的 runner 沒有這個設定）。preset 以外的 CLI 模型給該 CLI 的等級、沒有顯示名稱。
- `ready`／`reason`：CLI provider 以啟動時 `exec.LookPath` 的結果回報（`reason: "binary not found"`）；API／fake provider 不回報（`ready` 不出現）。runner 每次執行仍會重新找執行檔，所以之後才安裝也能用，只是 capabilities 要重啟才會變成 ready。

### 4. 自動偵測與 fallback

- `TANGENT_CLI_AUTODETECT`：`1/true/on/yes` 開、`0/false/off/no` 關，其他值啟動失敗；**未設定時跟著 `TANGENT_DEV`**（dev 預設開）。開著時，啟動時找得到執行檔（`TANGENT_<NAME>_CLI_PATH` 或 `claude`／`codex`／`agy`）的 CLI provider 都註冊 runner、帶入 preset。
- 找不到執行檔永遠不會讓 server 起不來：已設定（預設 provider、有模型、job／fallback 用它）但找不到的印 WARN，自動偵測略過的印 INFO（`CLI provider skipped: executable not found`），找到的印 INFO ready（`logCLIStatus`）。
- `TANGENT_FALLBACK_MODEL=provider:model`：驗證同 `TANGENT_JOB_MODEL`（格式、已知 provider、anthropic 要 API key）；它的 provider 會註冊 runner，沒有白名單時也加進允許清單。`routedRunner` 在主呼叫失敗且**還沒有串出任何 delta**、錯誤是用量／速率上限（`cli.ErrUsageLimit`，或 API runner 公開文字含 `HTTP 429`——`httpstream.ProviderError` 在 internal 套件，cmd 無法 `errors.As`）、fallback 有 runner 且不是剛失敗的同一個 provider:model 時，記一筆 `slog.Warn` 後用 fallback 重跑一次；成功時 `RunResult.Model` 是 fallback 的模型（訊息記錄實際的模型）。只重試一次。已串出內容就不重試（避免同一則回覆混兩個模型的文字）。
- 修正：`routedRunner` 包 `OnDelta` 只在原本有 `OnDelta` 時（fake runner 以 `OnDelta == nil` 判斷 job）。

### 5. 網頁

- `@tangent/client`
  - `capabilities.ts`：`CapabilityModels` 多選填 `ready`、`reason`、`details`；新型別 `CapabilityModelDetail`、`ModelStatus`。
  - `capabilities-normalize.ts`：只在伺服器有送時才加欄位（舊格式 `toStrictEqual` 不變）；`ready` 只接受 boolean；detail 只留列在 `models` 的、不重複的；未知 `status` 丟掉；`effortLevels` 去空字串、去重複。
  - 新檔 `model-catalog.ts`（從 index 匯出）：`REASONING_EFFORTS`、`isReasoningEffort`、`ModelInfo`、`modelInfo(caps, provider, model)`、`modelInfos(caps)`、`effectiveEffort(info, effort)`。
  - `api-types.ts`：`CreateLineInput`／`UpdateLineInput`／`SendMessageInput` 多選填 `reasoningEffort`（註明 httpapi 忽略、參考伺服器使用）。
  - mock：`createLine`／`updateLine` 跟參考伺服器一樣把 `reasoningEffort` 存進 `hostMeta`（`""` 清除、只送 `reasoningEffort` 也是合法的更新）。
- `@tangent/react`：`Composer` 多選填 `modelControl?: ReactNode`，放在工具列最前面（沒傳時不渲染任何東西，既有測試不變）。
- demo
  - `frame/model-prefs.ts`（給 G2，見下節）。
  - `frame/model-pill.tsx`（主 chunk）：`ModelPill`（按鈕顯示「模型名・思考深度」，provider 未就緒時有警示點與 title 說明；按下才 lazy 載入選單）、`useLineModel`、`hostMetaEffort`、`LineModelNote`（空對話的「這個對話使用 X・思考深度 Y」）、`useNewConversation`、`effortName`、`MODEL_PILL_MESSAGES`（en／zh-TW）。
  - `frame/model-pill-menu.tsx`（lazy chunk）：選單——模型（隱藏的拿掉、目前使用的永遠在；常用排最前，其餘依 provider 分組、伺服器順序；legacy 標「舊版」、未就緒標「無法使用」）、思考深度（只有模型有 `effortLevels` 才出現：「模型預設」＋各等級）、「設為新對話的預設」（已是預設時停用）。
  - 換模型或 effort 立刻 `useUpdateLine`（mutation 放在 pill 而不是選單裡：選單點了就關閉卸載，放在選單裡會收不到錯誤回呼）；失敗用對話的 toast 說「沒有變更：…」。
  - `shell.tsx` 的「新對話」改用 `useNewConversation()`：預設模型仍在伺服器清單裡才帶 `provider`／`model`；預設 effort 在該模型接受時一起送（沒有預設模型時照送，伺服器只在模型接受時才傳給 CLI）。
  - `conversation-view.tsx`：Composer 傳 `modelControl={<ModelPill …/>}`；支線另外讀主線（`useLine(rootId)`，只有支線才查）以顯示繼承的 effort；`EmptyGuide` 多選填 `modelNote`。
  - 選單沒有放進主 chunk 的原因：`ConversationMenu` 本來就是 lazy chunk，Base UI 的 menu 不在主 chunk；第一版直接在 pill 用 `Menu` 讓主 JS 變成 205 kB，所以改成和 `message-actions` 的「⋯」一樣的 lazy 選單。

## 新環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `TANGENT_CLI_AUTODETECT` | `TANGENT_DEV=1` 時開，否則關 | 啟動時偵測 `claude`／`codex`／`agy`，找得到的自動啟用並帶入 preset |
| `TANGENT_FALLBACK_MODEL` | 無 | `provider:model`；遇到用量／速率上限（且尚未串出內容）時用它重跑一次 |

既有變數的行為變更：沒有 `TANGENT_ALLOWED_MODELS` 時，啟用的 CLI provider 允許並列出 preset（以前只有設定的那一個模型）。

## 給 G2 的介面

### `web/apps/demo/src/frame/model-prefs.ts`

localStorage key `tangent:model-prefs`，值 `{"version":1, defaultModel?, defaultEffort?, favorites, hidden}`。

```ts
interface ModelRef { provider: string; model: string }
interface ModelPrefs {
  defaultModel?: ModelRef;      // 新對話的模型
  defaultEffort?: string;       // REASONING_EFFORTS 之一
  favorites: readonly ModelRef[]; // 依此順序排最前
  hidden: readonly ModelRef[];    // pill 不列（目前使用的除外）
}
const MODEL_PREFS_KEY = "tangent:model-prefs", MODEL_PREFS_VERSION = 1, MODEL_LIST_MAX = 200;
const EMPTY_MODEL_PREFS: ModelPrefs;
parseModelPrefs(raw: string | null): ModelPrefs;      // 版本不同、壞 JSON → 空；部分壞的欄位丟掉
serializeModelPrefs(prefs): string;
sameModel(a, b): boolean;
withDefaultModel(prefs, ref | null), withDefaultEffort(prefs, effort | null),
withFavorite(prefs, ref, on), withHidden(prefs, ref, on): ModelPrefs; // 都回新物件
arrangeModelChoices<T extends ModelRef>(choices, prefs, keep?): T[];  // 去掉 hidden（keep 除外）、favorites 在前
newLineInput(prefs, capabilities): { provider?, model?, reasoningEffort? };
interface ModelPrefsStore { get(): ModelPrefs; set(next): void; subscribe(listener): () => void }
createModelPrefsStore(storage: () => ModelPrefsStorage | null): ModelPrefsStore; // 寫入失敗時本頁仍有效；監聽其他分頁
const modelPrefs: ModelPrefsStore;  // 頁面的 store
useModelPrefs(store = modelPrefs): ModelPrefs;
```

`set` 會用與讀取相同的驗證清理傳入值。G2 的 Providers／Threads 設定頁直接用 `useModelPrefs` 讀、`modelPrefs.set(withFavorite(...))` 等寫，pill 會自動更新。

### Client 型別（`@tangent/client`）

```ts
type ModelStatus = "current" | "legacy";
interface CapabilityModelDetail { model: string; displayName?: string; status?: ModelStatus; effortLevels?: string[] }
interface CapabilityModels { provider: string; models: string[]; ready?: boolean; reason?: string; details?: CapabilityModelDetail[] }
const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
interface ModelInfo { provider; model; label; status: ModelStatus | null; effortLevels: readonly string[]; ready: boolean | null; reason: string | null }
modelInfo(caps, provider, model): ModelInfo; modelInfos(caps): ModelInfo[] | null; effectiveEffort(info, effort): string | null;
```

線目前的 effort：`hostMetaEffort(line)`（demo `model-pill.tsx`），或 `useLineModel(line, rootLine)`（含支線繼承與「模型不接受就不顯示」）。

## 測試

- Go
  - `runner/cli/effort_test.go`：claude／codex 有無 effort、映射（`xhigh→max`、`max→xhigh`）、不合法值不加參數、模型與 stdin 參數不變、agy 忽略、`EffortLevels` 回拷貝。
  - `branch_b5_internal_test.go`：`cleanCatalog` 的 detail 清理、`Ready` 拷貝、舊 JSON 形狀、`ModelCatalog` 深拷貝、`Turn.Request` 帶／不帶 `HostMeta`（空值不帶、拷貝）。
  - `cmd/tangent-server/g1_models_test.go`：preset＋自訂模型排序＋details＋未就緒、白名單嚴格、自動偵測（dev 預設、`=0`、非 dev `=1`、壞值、自訂 PATH）、fallback 解析與錯誤、`routedRunner` 降級（CLI 上限、API 429、其他錯誤不降級、已串流不降級、沒設、同模型）、effort 從 host_meta 取得與依模型過濾、job 不被當成 turn、`effortMeta` 掛勾 12 種情況與不合法值、端到端（假 claude 腳本收到 `--effort high --model claude-opus-5-5`，使用者訊息留 `hostMeta`，capabilities 有 `ready` 與 `effortLevels`）。
  - `g1_lookpath_test.go`：測試一律把 `lookPath` 換成「找不到」，不受跑測試的機器裝了哪些 CLI 影響。
  - 修改既有測試：`cli_test.go` 的 `TestLoadConfig_CLIProvidersMixWithAPIProviders` 改成新的 preset 行為（別名可用、codex 列 preset）；`access_test.go` 欄位改名 `fallback → defaultProvider`。
- Web
  - client `model-catalog.test.ts`（G1 格式正規化、舊格式不變、`modelChoices`、`modelInfo(s)`、`effectiveEffort`）、`testing/mock-effort.test.ts`。
  - react `composer.test.tsx` 新增一支：`modelControl` 在工具列第一個、不傳就沒有。
  - demo `model-prefs.test.ts`（15 支：解析、驗證、上限、更新、排序、`newLineInput`、store 與失敗的 storage）、`model-pill.test.tsx`（11 支：顯示與切換模型、effort 選項與寫入、不支援的 effort 不顯示、設為預設、隱藏與常用、錯誤回報、沒有 catalog 不顯示、EmptyGuide 的模型說明、`useNewConversation` 帶入預設與伺服器不再列出時不帶）。

## 偏離工單與注意事項

- 新增 demo 檔是三個：`model-prefs.ts`、`model-pill.tsx`、`model-pill-menu.tsx`（後者是為了把 Base UI menu 留在 lazy chunk，守住主 JS 上限）。
- `httpapi/` 沒有改：capabilities 直接回 `engine.ModelCatalog()`，擴充自動生效；effort 走既有的 `Config.HostMeta` 掛勾。
- `claude-haiku-5-5` 不提供 effort（見 §3）；若確認 Claude Code 對 Haiku 也接受 `--effort`，把 `catalog.go` 的 `noEffort` 拿掉即可。
- API provider（openai／anthropic）不傳 effort：它們的 runner 沒有對應欄位，UI 也不顯示。
- dev 模式現在預設自動偵測：本機裝了 `claude`／`agy` 時，dev server 的模型選單會出現它們（選了就會用訂閱額度跑）；不想要時設 `TANGENT_CLI_AUTODETECT=0`。
- 沒有做 Playwright／瀏覽器實測（只有 vitest 與 API smoke）。

## DESIGN.md／文件需要更新（本工單不能改）

1. §7／httpapi 契約：`GET /capabilities` 的 `models[]` 多選填 `ready`、`reason`、`details[{model, displayName?, status?, effortLevels?}]`。
2. Runner 契約：`RunRequest.ReasoningEffort`、`RunRequest.HostMeta`（`Turn.Request` 帶使用者訊息的非空 `host_meta`；函式庫不讀）；`runner/cli` 的 `--effort`／`model_reasoning_effort` 映射。
3. 參考伺服器：`host_meta.reasoningEffort`（線＝對話選擇、使用者訊息＝那一回合用的）；`POST /lines`、`PATCH /lines/{id}`、`POST /lines/{id}/messages` 的 `reasoningEffort` 欄位（httpapi 忽略、參考伺服器讀）。
4. 環境變數表（DESIGN／`docs/EMBEDDING.md` 列 `TANGENT_JOB_MODEL` 的地方）：`TANGENT_CLI_AUTODETECT`、`TANGENT_FALLBACK_MODEL`，以及沒有白名單時 CLI preset 的行為。
