# B12 · 命令列 AI 工具的 runner（Claude Code、Codex、Antigravity CLI）

> 2026-10-23。工作單：已歸檔。
> 沒有 commit；沒有動 `web/`、`scripts/soak/`（B11 同時在改）、`docs/DESIGN.md`、`宿主專案`（只唯讀參考 `internal/daemon/adapters/builtin.go`、`acp/proc_*.go`、`adapters/env.go`）。
> **沒有呼叫任何 AI**：只跑過 `claude --version`（2.1.308）與 `claude --help`。這台沒有 `codex`、`gemini`，沒有安裝任何東西。

## 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...`、`gofmt -l .` | 通過 / 無輸出 |
| `go test ./... -count=1` | 通過：**942** 個頂層測試 PASS、0 FAIL、6 SKIP（多的一個是本步的 `TestRealCLISmoke`）；DB 測試實際連 :5444；`scripts/soak` 這次能編譯也通過 |
| `-race` | `./runner/cli ./cmd/tangent-server` 通過 |
| `runner/cli` 覆蓋率 | 90.7% |
| `scripts/smoke.sh` | 通過（704 個事件；smoke 用 fake provider，碰不到 CLI runner） |

**TDD**：先寫 `runner/cli` 的假 CLI 與串流、失敗、殺程序的測試，再補實作；第一次全跑紅在三處：沒登入 / 崩潰的非零結束被當成「串流沒有結尾」
（`codex-noauth`、`gemini-noauth`、`crash`）→ 改成非零結束時以結束碼與 stderr 分類優先；`gemini-tool` 因為 runner 在報告寫出前就殺掉程序 → 假 CLI 一啟動就先寫報告。
伺服器端的設定測試與實作同時寫。

## 檔案

- `runner/cli/`（新套件，只用標準函式庫 + 既有的 `runner/internal/httpstream.ReplyBuffer`）
  - `cli.go`：`Config`、`New`、`Runner.Run`（並行名額 → 找執行檔 → 逾時 → 私有目錄 → 程序 → 分類）。
  - `process.go`：私有目錄（`tangent-cli-*/work` 是空的工作目錄，system prompt / policy 檔放在它旁邊）、啟動、逐行讀 stdout、殺程序群組、stderr 只留尾端 8 KiB。
  - `claude.go`、`codex.go`、`agy.go`（B12.1 取代 `gemini.go`）：各 CLI 的參數與串流解析。`backend.go`：共用的型別。`reply.go`：累積回覆、delta、用量。
  - `env.go`：環境變數白名單。`errors.go`：錯誤分類、公開文字、log 摘錄的遮蔽。`prompt.go`：組 stdin 文字。
  - `proc_linux.go` / `proc_bsd.go` / `proc_unix.go` / `proc_other.go`：程序群組（Linux 另加 `Pdeathsig`）。
  - 測試：`cli_test.go`、`failures_test.go`、`kill_linux_test.go`、`units_test.go`、`fake_cli_test.go`（假 CLI）、`smoke_test.go`（真的 CLI，預設跳過）。
- `cmd/tangent-server/cli.go`（新）、`config.go`、`models.go`、`runners.go`、`realsmoke_test.go`、`cli_test.go`（新）。
- `.env.example`、`docs/EMBEDDING.md`（套件表、§3 runner 表、新 §3.5）、`CHANGELOG.md`（0.1.0 的 runner 一項）。

## 1. 各 CLI 的旗標與出處

驗證等級：**H** = 本機 `claude --help`（2.1.308）看得到；**D** = 官方文件；**S** = 官方原始碼；**U** = 沒能實際驗證（沒有該 CLI、或沒呼叫模型）。
三家都沒有真的跑過一輪（不能呼叫模型），所以「旗標組合在一起能不能跑」全部要靠協調者的冒煙測試確認。

### Claude Code（`claude`）

| 旗標 | 作用 | 出處 |
|---|---|---|
| `-p` | 非互動，跑完就結束；沒給 prompt 參數時讀 stdin | H、D（headless：「Non-interactive mode reads stdin」） |
| `--output-format stream-json --verbose --include-partial-messages` | 每個事件一行 JSON，含 token delta | H、D（headless「Stream responses」的範例正是這三個一起） |
| `--tools ""` | 關掉所有內建工具 | H、D（CLI reference：`""` disables all） |
| `--strict-mcp-config` | 只用 `--mcp-config` 的 MCP（沒給 = 沒有） | H、D |
| `--safe-mode` | 不載入 CLAUDE.md、skills、plugins、hooks、MCP、auto memory；登入照常 | H、D（明寫與 `--bare` 不同：`--bare` 不讀 OAuth，訂閱登入會失效，所以不用 `--bare`） |
| `--disable-slash-commands` | 不載入 skills / commands | H、D |
| `--permission-mode dontAsk` | 任何會詢問的動作都拒絕 | H、D |
| `--no-session-persistence` | 不把 transcript 寫到磁碟 | H、D |
| `--system-prompt-file <file>` | 用 tangent 的 system prompt 取代 Claude Code 的程式代理 prompt | D（CLI reference；`--help` 沒列，但 `--bare` 的說明提到 `--system-prompt[-file]`，文件說 `--help` 不列全部旗標）— **U** |
| `--model <model>` | 有設才給 | H |

串流（D：Agent SDK TypeScript 參考的 `SDKMessage`；headless 頁的 `system/api_retry` 表）：

- `{"type":"system","subtype":"init","model":…,"tools":[…]}`：記模型；**`tools` 不是空的就殺掉程序**（`ErrToolUse`）。
- `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta"|"thinking_delta",…}}}` → `text` / `reasoning` delta。
- `{"type":"assistant","message":{content…},"error"?:…}`：有 token delta 時只取模型；沒有時（舊版）整段當 delta；`error`（`authentication_failed`、`rate_limit`、`billing_error`…）記成失敗；內容有 `tool_use` 就殺掉。
- `{"type":"system","subtype":"api_retry","attempt","max_retries","retry_delay_ms","error"}` → `OnRetry`；`error` 是額度 / 登入類就**立刻殺掉、不讓它自己重試**。
- `{"type":"result","subtype","is_error","result","usage","api_error_status"?,"errors"?}`：最後全文與用量；`is_error` 或 subtype 不是 `success` 依 `api_error_status` 與文字分類。
- `parent_tool_use_id` 不是空的（子代理）一律略過。

### Codex（`codex exec`）— 全部 **U**（沒裝）

| 旗標 | 作用 | 出處 |
|---|---|---|
| `exec … -` | 非互動；`-` = 從 stdin 讀 prompt | D（non-interactive mode）、S（`codex-rs/exec/src/cli.rs`） |
| `--json` | stdout 是 JSONL 事件 | D、S |
| `--color never` | | S |
| `--skip-git-repo-check` | 工作目錄不是 git repo | D、S |
| `--ephemeral` | 不存 session 檔 | D、S |
| `--ignore-user-config` | 不讀 `$CODEX_HOME/config.toml`（使用者的 MCP、profile）；登入照常用 `CODEX_HOME` | D、S |
| `--ignore-rules` | 不讀 execpolicy `.rules` | D、S |
| `--sandbox read-only` | 唯讀沙箱（exec 預設也是） | D；宿主的 `ReadOnlyArgs` 也用它 |
| `-c approval_policy="never"` | 不等核准 | D（config reference） |
| `-c features.shell_tool=false`、`-c features.unified_exec=false` | 關掉執行指令的工具 | D（config reference：`features.shell_tool`「Enable command execution tools」；文件沒明說設 false 就移除，**U**） |
| `-c web_search="disabled"` | 移除網搜工具 | D（「`disabled` to remove the tool」） |
| `-c history.persistence="none"` | 不寫 `history.jsonl` | D |
| `-C <work>`、`-m <model>` | 工作目錄、模型 | 宿主 用法與 Codex 文件；`SharedCliOptions` 沒有逐字看到 |

Codex 沒有能從 stdin 分開收的 system prompt（`developer_instructions` 只能放在 `-c` 參數裡，會被 `ps` 看到；`model_instructions_file` 的語意文件寫得不清楚），所以 system 與對話組成一段文字送 stdin。

串流（S：`codex-rs/exec/src/exec_events.rs`）：`thread.started`、`turn.started`、`item.started|updated|completed`（`item.type`：`agent_message` → `text`，
每則整段一個 delta，多則之間空一行；`reasoning` → `reasoning`；**`command_execution`、`file_change`、`mcp_tool_call`、`collab_tool_call`、`web_search` 一出現就殺掉**；
`todo_list`、`error` 項目略過）、`turn.completed{usage{input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens}}`、`turn.failed{error{message}}`、
`error{message}`（只有回合沒完成時才算失敗，Codex 也會報它自己恢復的錯誤，例如 reconnecting）。

### Gemini CLI — B12.1 移除

B12 原本接的是 Gemini CLI（`gemini`）；使用者實際用的是 Antigravity CLI（`agy`），B12.1 把 gemini backend、provider `gemini-cli`、它的測試與文件全部換成 agy，見 §7。

## 2. 安全設計

- **prompt 走 stdin**：參數裡只有旗標、模型名與私有檔案的路徑（測試檢查參數不含任何訊息或 system 文字）。
- **模型名驗證**：`^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]*$`、最多 200 字元，`New` 與每次 `Run` 都檢查，擋掉 `--dangerously-skip-permissions` 這類參數注入
  （請求的模型可能來自函式庫使用者，參考伺服器另外有 allowlist）。
- **只聊天**：見上表；第二道防線是串流裡出現工具就 `SIGKILL` 整個程序群組（fail closed）。Claude 的 init 若列出任何工具也直接殺掉——若真的 Claude Code 在 `--tools ""` 下仍列出某個無害的工具，冒煙測試會以 `ErrToolUse` 失敗，再決定要不要放行那個名字。
- **空的工作目錄**：`os.MkdirTemp("", "tangent-cli-*")`（0700）裡的 `work/`；system prompt、policy 檔放在 `work/` 旁邊（0600），整個目錄 `defer` 刪除（測試檢查 CLI 看到的 cwd 是空的、跑完不存在）。
- **環境變數白名單**：`PATH HOME USER LOGNAME LANG LANGUAGE TZ TMPDIR XDG_{CONFIG,DATA,CACHE,STATE}_HOME`、`LC_*`、代理（大小寫）、`SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS`，
  加上各 CLI 自己的：Claude `CLAUDE_CONFIG_DIR`、Codex `CODEX_HOME`、agy `AGY_ADC_AUTH GOOGLE_CLOUD_PROJECT`（B12.1；原本 Gemini 的 `GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_LOCATION`）。`Config.Env` / `TANGENT_CLI_ENV` 可多給名字（例如 `CLAUDE_CODE_OAUTH_TOKEN`），
  但 `TANGENT_*`、含 `DATABASE_URL`、`API_KEY`、`SECRET`、`PASSWORD` 的名字永遠不給，設定時就拒絕。不給 API key 也讓 CLI 一定走訂閱，不會悄悄改成按 token 計費。
  沒有預設給 `DBUS_SESSION_BUS_ADDRESS`：Codex 若設定成把登入存在系統 keyring，要用 `TANGENT_CLI_ENV` 加上。
- **取消與逾時**：`Setpgid`，`exec.CommandContext` 的 `Cancel` 對整個群組送 `SIGKILL`，`WaitDelay`（預設 3 秒）防止孫程序握住 pipe；`Wait` 之後再殺一次群組。
  測試用一個會再開子程序（並握住 stdout）的假 CLI，確認取消、逾時、工具三種情況下兩個 pid 都消失、沒有殭屍、目錄刪除。
- **錯誤**：公開文字固定（`the Claude Code CLI is not logged in on this server` 之類），不含 CLI 輸出；`RunnerError.Err` 只帶 stderr 最後 3 行（或串流的錯誤訊息），
  壓成一行、截到 200 字元、遮掉 `sk-…`、`Bearer …` 與 32 字元以上不間斷的字串。逾時 / 取消回 context 的錯誤，交給引擎的固定文字。
- **額度用完不重試**：runner 本身從不重試；Claude 的 `api_retry` 若是 `rate_limit` / `billing_error` / 登入失敗，立刻殺掉，不讓 CLI 自己重試。
- **並行上限**：每個 provider 一個 semaphore（預設 2）；排隊時看 `ctx`。
- 輸出上限：回覆 1 MiB（`MaxReplyBytes`），單行上限 4 倍回覆加 256 KiB，超過就殺掉。

## 3. 參考伺服器

- provider `claude-cli`、`codex-cli`、`agy-cli`（B12.1 前是 `gemini-cli`）。變數：`TANGENT_<CLAUDE|CODEX|AGY>_CLI_PATH`（預設命令名）、`_MODEL`、`_MAX_CONCURRENT`（預設 2），共用的 `TANGENT_CLI_ENV`。
- 啟用條件：是 `TANGENT_PROVIDER`、有 `_MODEL`、或是 `TANGENT_JOB_MODEL` 的 provider。當預設 provider 時需要模型（`TANGENT_MODEL` 或 `_MODEL`），跟 openai / anthropic 一樣。
- 可混用：例如 `TANGENT_PROVIDER=claude-cli TANGENT_MODEL=sonnet ANTHROPIC_API_KEY=… TANGENT_JOB_MODEL=anthropic:claude-haiku-4-5`；`/capabilities` 的 `models` 依預設 provider 優先列出（測試檢查）。
- 執行檔在啟動時不檢查（之後才裝也不用重啟）；沒裝時每一輪回 `the … CLI is not installed on this server`。
- `TestRealModelSmoke` 也讀 CLI provider 的變數與 `TANGENT_JOB_MODEL`、`TANGENT_CLI_ENV`，可以用 CLI provider 跑完整流程（約 5 次呼叫）。
- `TestServer_TurnThroughACLIProvider` 用一個 `/bin/sh` 寫的假 `claude` 跑一整輪（真的連 DB）。

## 4. 沒能驗證的地方

1. 三家都沒有真的跑過；Claude 旗標組合（尤其 `--system-prompt-file` 與 `--safe-mode` 同時、`--tools ""` 下 init 的 `tools` 是否真的是空的）要靠冒煙測試。
2. Claude 沒登入 / 額度用完時的實際文字與 `error` 欄位：依 SDK 型別與已知訊息（`Not logged in · Please run /login`、`You've hit your limit`、`usage limit reached`）寫，文字比對是後備。
3. Codex：`features.shell_tool=false` 是否真的移除工具、`-C`/`-m` 的確切拼法、沒登入 / 額度用完的錯誤文字。
4. （Gemini 的項目隨 B12.1 移除；agy 的見 §7.4。）
5. 用量：Claude 的 `usage` 只算主迴圈（文件建議看 `modelUsage`）；沒有工具就只有一個迴圈，應該一致。

## 5. 給協調者的冒煙測試（要先問使用者：會用掉一次 Claude 訂閱額度）

```bash
cd .
claude auth status --text          # 不連模型；確認已登入
TANGENT_CLI_SMOKE=claude go test ./runner/cli -run TestRealCLISmoke -count=1 -v
# 可選：TANGENT_CLI_SMOKE_MODEL=haiku（較省）、TANGENT_CLI_SMOKE_PATH=/path/to/claude
```

只呼叫一次模型、不重試；成功時 log 一行回覆、模型、用量與 delta 數。失敗時看錯誤：
`ErrToolUse`（init 列了工具 → 把該名字回報給我）、`not logged in`、`usage limit`、或 `the Claude Code CLI failed: exit status N: …`（多半是某個旗標這個版本不認得）。
完整流程（約 5 次呼叫）：`TANGENT_REAL_SMOKE=1 TANGENT_PROVIDER=claude-cli TANGENT_MODEL=haiku go test ./cmd/tangent-server -run TestRealModelSmoke -count=1 -v`。

## 6. DESIGN §12 建議文字（由協調者寫入）

> **命令列 AI 工具的 runner（B12）**：`runner/cli` 讓已用訂閱登入的 Claude Code、Codex、Antigravity CLI（`agy`）跑對話，每次 `Run` 一個非互動程序。
> 不變的規則：prompt 只走 stdin（參數只有旗標、驗證過的模型名與私有檔路徑）；只聊天——各 CLI 用自己的旗標關掉工具（agy 沒有這種旗標，靠 print 模式拒絕需要核准的動作），串流裡出現工具就殺掉整個程序群組並以 `ErrToolUse` 失敗；
> 工作目錄是每次新建的空暫存目錄；環境變數白名單，`TANGENT_*`、資料庫 URL、API key 永不傳入（也確保走訂閱而不是 API 計費）；`ctx` 結束就殺掉整個程序群組；
> 每個 provider 有並行上限（預設 2）；沒裝 / 沒登入 / 額度用完 / 其他失敗各有固定的公開文字，額度用完不重試；用量只記 token、不記費用。
> 定位：個人、單機使用；背景工作建議用 API 模型（`TANGENT_JOB_MODEL`）。參考伺服器的 provider 名稱是 `claude-cli`、`codex-cli`、`agy-cli`。

## 7. B12.1 · 以 Antigravity CLI（`agy`）取代 Gemini CLI

> 2026-10-23。使用者用的 Google CLI 是 `agy`（`~/.local/bin/agy`，1.4.5），不是 Gemini CLI。沒有 commit。
> **沒有送任何 prompt 給 agy**：只跑過 `agy --version`、`agy --help`、`agy help`、`agy changelog`、`agy models`（列模型，不生成）。
> 另外只列了 `~/.gemini/` 下的檔名（沒讀內容）。

### 7.1 驗收

| 檢查 | 結果 |
|---|---|
| `go vet ./...`、`gofmt -l .` | 通過 / 無輸出 |
| `go test ./... -count=1` | 通過：**942** 個頂層測試 PASS、0 FAIL、6 SKIP（數量不變：gemini 的測試換成 agy 的）；DB 測試實際連 :5444 |
| `-race` | `./runner/cli ./cmd/tangent-server` 通過 |
| `runner/cli` 覆蓋率 | 90.5% |
| `scripts/smoke.sh` | 通過（704 個事件） |

改動：刪 `runner/cli/gemini.go`，加 `runner/cli/agy.go`（`cli.Agy`，`Backend` 值 `"agy"`）；`backend.exitKinds` 只有 Gemini 用，一起拿掉；
錯誤分類多認 `credits balance`（agy 的「Your AI credits balance is too low」）與 `unauthenticated`（`AGY_ERROR` 的 canonical status）。
伺服器 provider `gemini-cli` → `agy-cli`，變數 `TANGENT_AGY_CLI_PATH`（預設 `agy`）、`_MODEL`、`_MAX_CONCURRENT`。測試、`.env.example`、EMBEDDING §3.5、CHANGELOG 同步；
gemini 的程式、測試、設定與文件已全部移除（devlog 的 B12 段落保留歷史）。

### 7.2 旗標與出處

出處：**H** = `agy --help`（1.4.5）；**C** = `agy changelog`（列出版本號）；**T** = 第三方 PHP SDK `develate/antigravity-cli-php`（`src/Transport/ArgumentBuilder.php`、`src/Event/*.php`，
只當資料讀，未執行）；**U** = 沒能實際驗證（沒送過 prompt）。

| 旗標 | 作用 | 出處 |
|---|---|---|
| `--print=` | print 模式、命令列上沒有 prompt | H；C：「a valueless prompt flag swallowing the next flag」已修，T 為此一律用 `--flag=value` 形式——這裡全部旗標也都用附加的 `=` 形式 |
| `--input-format=stream-json` | 從 stdin 讀 NDJSON 訊息、每則一輪（需要 stream-json 輸出） | H、C 1.1.15；訊息形狀 `{"event":"user","message":{"content":"…"}}` 只有 T — **U** |
| `--output-format=stream-json` | `init` / `step_update` / `result` 事件 | H、C（1.1.8：typed `init`、`step_update`、terminal `result`，closed-vocabulary `step_type`） |
| `--mode=plan` | 蓋掉使用者存的 Agent Mode，確保不是 `accept-edits` / `auto`（那兩個會不問就核准編輯 / 指令） | H、C 1.1.12（`--mode` 在 `-p` 生效的修正；headless 會自動走過計畫審核，所以 plan 不會卡住）；plan 模式本身是否更唯讀 — **U**（T 也用 plan 當唯讀，並提醒它單靠不住） |
| `--sandbox` | 萬一有指令執行，限制在終端機沙箱 | H、C 1.0.6（`--sandbox` 在 print 模式生效的修正）— 是否會讓沙箱內的指令不經核准就跑 — **U**（第二道防線會在 `tool` 步驟出現時殺掉） |
| `--disable-slash-commands` | 以 `/` 開頭的訊息不會被當成指令或 skill 展開 | H、C |
| `--model=<slug>` | 有設才給；slug 用 `agy models` 列出（例如 `gemini-3.8-flash-medium`、`claude-sonnet-5-5-medium`）；認不得的模型在 print 模式直接失敗 | H、C、本機 `agy models` |
| 不用 | `--dangerously-skip-permissions`、`--new-project`、`--add-dir`、`--continue`/`--conversation`、`--print-timeout`（逾時由 runner 的 ctx 處理） | |

**只聊天怎麼成立**：agy 是代理，沒有移除工具的旗標（`init` 一定會列出工具，所以 agy 不能像 Claude 那樣看 init 的工具清單就失敗）。依 changelog：
print 模式對需要核准的工具「soft-deny」並在 stderr 註明（C 1.1.3：「hanging or silently auto-approving tools that require a permission confirmation… now soft-denies」）、
被拒的動作列在 `denied_actions`（C 1.1.27）；工作目錄是空的、沒有 `--add-dir`。第二道防線：任何 `step_type` 是 `tool`（或帶 `tool_name`）的 `step_update` 一出現就殺掉整個程序群組，
回 `ErrToolUse`。不需要核准的工具（例如讀工作區內的檔案、網搜）在 agy 可能會被模型自己呼叫 — 這時 run 會失敗而不是默默執行完；若實際上常發生，要再找 agy 的權限設定。

**stream-json 事件**（C 的事件名 + T 的欄位名，欄位 — **U**）：
- `{"event":"init","conversation_id":…,"init":{"model","cwd","tools":[…],"permission_mode"}}` → 記模型。
- `{"event":"step_update","step_update":{"conversation_id","step_index","state":"ACTIVE|DONE|ERROR","step_type":"user_input|agent_response|tool|system_message","text_delta","tool_name","tool_info","usage"}}`
  → `agent_response` 的 `text_delta` 是 `text` delta；`tool` 殺掉。沒有已知的思考事件，所以 agy 沒有 `reasoning` delta（**U**）。
- `{"event":"result","result":{"status":"SUCCESS|ERROR|CANCELLED","response","error","num_turns","usage":{"input_tokens","output_tokens","thinking_tokens","cache_read_tokens","total_tokens"},"denied_actions":[…]}}`
  → `response` 是最後全文；不是 `SUCCESS` 就依 `error` 文字分類。T 說 `usage` 是整個對話的累計；每次都是新對話、只有一輪，所以就是這一輪的用量。
  `input_tokens` 是否已含 `cache_read_tokens` — **U**（照 Codex 的方式當作已含）。
- 錯誤：C：模型 / 代理失敗時 stderr 印 `AGY_ERROR: {...}`（canonical status、HTTP / gRPC 碼）並以 3 結束；用法錯誤 2；額度：「Your AI credits balance is too low to continue.」、
  個人額度用完「reported right away instead of being retried」。沒登入時 truly headless 會「fail fast with an actionable message」— 實際文字 **U**（靠 `sign in` / `login` / `unauthenticated` 等字樣分類）。

### 7.3 狀態與工作區

- `~/.gemini/antigravity-cli/` 存著登入（`antigravity-oauth-token`；`cache/antigravity-keyring-unavailable` 表示這台不用 keyring，所以不需要傳 `DBUS_SESSION_BUS_ADDRESS`；
  用 keyring 的機器可用 `TANGENT_CLI_ENV` 加上）、`conversations/`、`conversation_summaries.db`、`history.jsonl`、`cache/projects.json`（工作區 → project 的對照）、`settings.json`。
- **每次呼叫都會在 agy 的歷史裡留下一則對話**（C：print 模式會把對話寫到磁碟；沒有像 Claude `--no-session-persistence` 的旗標）。標題生成在 headless 已省略（C）。
  使用者在 agy 的 `/resume` 會看到這些對話；要清就在 agy 裡刪。
- **project**：C 1.0.12「project resolution logic to default regardless of the active workspace」— 不用 `--new-project` 就落在預設 project，不會每次建新的；
  但每個新的暫存目錄可能在 `cache/projects.json` 多一筆對照 — **U**。
- 不會寫進使用者真正的工作區：cwd 是空的暫存目錄、沒有 `--add-dir`、編輯類工具需要核准（headless 一律拒絕）。agy 仍會把 `~/.gemini/GEMINI.md`、`~/.gemini/config/` 的全域規則
  載入它自己的 context（這台的 `GEMINI.md` 是空的）。
- C 提到 headless 會讓「daemon background tasks」在結束後繼續跑；沒有指令工具就不會有。runner 結束時殺整個程序群組，但若 agy 把背景程序放進新的 session，就殺不到 — **U**。
- 環境：agy 自己的變數只給 `AGY_ADC_AUTH`（Business / ADC 登入的開關）與 `GOOGLE_CLOUD_PROJECT`；`GEMINI_API_KEY` 照舊被 `API_KEY` 規則擋掉（也避免改成 API 計費）。

### 7.4 沒能驗證的地方（agy）

1. stdin 的 NDJSON 訊息形狀與 `--print=` 搭配 `--input-format=stream-json` 能否跑（只有 T 的寫法）；stdin 結束後 agy 是否在一輪後自己結束。
2. 事件的欄位名（只有 T）；`text_delta` 是增量（照 T 的命名）而不是累計。
3. `--mode=plan` 加 `--sandbox` 在 headless 下的實際權限；不需核准的工具是否會被呼叫。
4. 沒登入 / 額度用完的實際文字與結束碼。
5. Codex 仍然沒裝，維持 B12 的 **U**。

### 7.5 給協調者的冒煙測試（要先問使用者：會用掉一次 agy 的額度）

```bash
cd .
TANGENT_CLI_SMOKE=agy TANGENT_CLI_SMOKE_MODEL=gemini-3.8-flash-low go test ./runner/cli -run TestRealCLISmoke -count=1 -v
```

只送一則 prompt、不重試；會在 agy 的歷史留下一則對話。失敗時：`ErrToolUse`（模型呼叫了工具 → 把 log 裡的步驟名回報給我）、
`ended without a reply`（多半是事件欄位名不對，或 agy 讀 stdin 後沒結束）、`exit status 2`（某個旗標寫法不被接受）、或 not logged in / usage limit。
完整流程（約 5 次呼叫）：`TANGENT_REAL_SMOKE=1 TANGENT_PROVIDER=agy-cli TANGENT_MODEL=gemini-3.8-flash-low go test ./cmd/tangent-server -run TestRealModelSmoke -count=1 -v`。

### 7.6 DESIGN §12 建議文字的更新

把 §6 建議文字裡的 Gemini CLI 換成 Antigravity CLI（`agy`、provider `agy-cli`），並加一句：「agy 沒有關掉工具的旗標，只聊天靠 print 模式拒絕需要核准的動作、
`--mode=plan`、`--sandbox`、空的工作目錄，以及出現 `tool` 步驟就殺掉；每次呼叫會在 agy 的歷史留下一則對話。」
