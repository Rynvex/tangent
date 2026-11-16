# G4 · GitHub 開源釋出配套（Quickstart、啟動摘要、CI 與衛生檢查）

> 2026-11-16。工單（§2 啟動體驗、§3 `.env.example`／README、§4 CI 與衛生、§5 驗收）。
> 建立在未 commit 的 G1／G2／G3 之上，**未 commit、未 push**。
> 零付費呼叫：沒有對真的 `claude`／`codex`／`agy` 送過任何 prompt，沒有呼叫任何模型 API；乾淨啟動只用 `TANGENT_DEV=1`，一個回合都沒送。

## 改了什麼

| 檔案 | 內容 |
|---|---|
| `cmd/tangent-server/startup.go`（新） | `startupSummary(cfg, url) []string`（純函式）、`logStartupSummary`、`explainStartupError(err) string` |
| `cmd/tangent-server/startup_test.go`（新） | 8 支測試，見下 |
| `cmd/tangent-server/main.go` | 錯誤輸出改走 `explainStartupError(err)`（一行） |
| `cmd/tangent-server/server.go` | **邊界外的最小改動**：`run()` 在既有的 `listening` log 之後加一行 `logStartupSummary(log, cfg, "http://"+ln.Addr().String())`。原因：摘要要的 `cfg` 與實際監聽位址只在 `run()` 裡有，`main.go` 拿不到 |
| `.env.example` | 開頭加四組情境 A–D；新增 `TANGENT_CLI_AUTODETECT`、`TANGENT_FALLBACK_MODEL`；`TANGENT_ALLOWED_MODELS` 重寫（嚴格白名單、內建清單、別名） |
| `README.md` | 重寫：簡介、5 分鐘 Quickstart（含實際啟動摘要）、模型來源情境、CLI 訂閱與沙盒、Web 設定與快捷鍵、開發指令與 CI、嵌入索引、授權 |
| `.github/workflows/ci.yml`（新） | 4 個 job：`go`、`web-typecheck`、`web-vitest`（4 套件的 matrix）、`web-build` |
| `.gitignore` | 補 `coverage/`、`*.log`、`.DS_Store`、`Thumbs.db`、`.idea/`、`.vscode/`、`*.swp`、`web/e2e/test-results/`、`web/e2e/playwright-report/` |

### 啟動摘要

啟動時（沿用既有的 `listening` log 之後）每行一筆 INFO，內容：監聽位址、存取方式（dev 無 token／需要 token、是否有唯讀 token）、各 provider 與模型數（`claude-cli: 4 models (ready)`、`codex-cli: skipped (codex binary not found)`；設了但找不到的 `not ready: binary not found`；沒開自動偵測也沒設模型的 `off (...)`）、預設模型、Job 模型、Fallback 模型、Web UI（有 `TANGENT_STATIC_DIR` 時為服務位址，否則提示 `VITE_TANGENT_API=http pnpm -C web dev` 與 `http://localhost:5183`）。不含任何 token 或 key（有測試）。

### 友善錯誤

`explainStartupError` 只在 `main()` 套用（`run()` 的錯誤原樣不變，既有測試 `TestRun_ExplainsWhatIsMissing` 不受影響），比對三種開頭：

- `TANGENT_TOKEN is required`、`TANGENT_PROVIDER is required`：附上三種開始方式（`TANGENT_DEV=1 make serve`、CLI 訂閱 `TANGENT_CLAUDE_CLI_MODEL`／`TANGENT_CODEX_CLI_MODEL`、API key）並指向 `.env.example`。
- `cannot reach the database`：提示 `make db-up`／`TANGENT_DATABASE_URL`。
- 其他錯誤原樣輸出。

比對字串寫在 `startup.go` 的常數，測試用真的 `loadConfig` 的拒絕訊息驗證，所以改了 `config.go` 的字句會讓測試失敗而不是靜默失效。

### 測試（`startup_test.go`）

dev 無 key（三個 CLI 皆 skipped）、偵測到 `claude`（`4 models (ready)`）、設了但找不到的 CLI（`not ready`，且非 dev 沒有 fake）、token／viewer／job／fallback／靜態目錄／自動偵測關閉、摘要不含任何 secret、兩種真實拒絕都附上引導、資料庫連不上提示 `make db-up`、其他錯誤不變。`lookPath` 一律替換，不受機器上裝了哪些 CLI 影響。

## CI 設計

- **Go**：service `pgvector/pgvector:pg17`（與 `docker-compose.yml` 同一個映像：`memory` 需要 `vector`，`search` 需要 `pg_trgm`，後者是 Postgres 內建 contrib）。測試讀 `TANGENT_TEST_DATABASE_URL`（`tangenttest/db.go`；預設是 `localhost:5444/tangent_test`），所以 service 的 `POSTGRES_DB` 直接設成 `tangent_test`，不需要 `scripts/init-test-db.sql`；每個測試自己開一個 schema。`TANGENT_TEST_REQUIRE_DB=1` 讓連不到資料庫時失敗而不是 skip。`go vet ./...`、`go test ./... -count=1`。
- **Web**：Node 22、pnpm 9.15.0（對應 `packageManager`）、`pnpm -C web install --frozen-lockfile`、`pnpm -C web typecheck`。vitest 每個套件**一個獨立 job**（matrix，`fail-fast: false`），不是同一個 job 內串接：這樣 `packages/client` 的紅燈不會讓後面套件沒跑（`pnpm -r test` 也有這個問題，見 HANDOFF）。build 兩次：mock（預算 172,000 bytes gzip）與 `VITE_TANGENT_API=http`（預算 185,000，HANDOFF 的既有規則；工單只列 172，多檢一個是因為 http build 才是實際使用的）。
- **主 JS 檢查**：挑 `web/apps/demo/dist/assets/` 裡**最大的** `index-*.js`，`gzip -9 -c | wc -c`，超過預算 `exit 1`。腳本以 job 層級 env（`CHECK_BUNDLE`）共用，因為邊界不允許新增 `.github/scripts/`。
- 沒有 `continue-on-error`、沒有跳過測試。Playwright e2e 不在 CI（需要瀏覽器與參考伺服器，不在工單範圍）。

### 已知：CI 的 client vitest 會是紅的

`web/packages/client` 有 **10 個測試在 HEAD 就失敗**（B25 的缺口：client 沒有實作 imports／pinned 路由與 `import_batch_not_found` 錯誤碼；失敗檔案 `contract.test.ts`、`errors.test.ts`、`testing/mock-contract.test.ts`）。CI 照工單寫、不遮蓋，所以 `Web vitest (packages/client)` 這個 job 會失敗，直到有人補上 B25 的 client 實作。其他三個套件（fonts 10、react 1130、demo 480）全綠，彼此不受影響。建議在第一次推上 GitHub 之前先修這個缺口，否則首頁會顯示紅叉。

## 驗收（本機實跑）

| 指令 | 結果 |
|---|---|
| `go vet ./...` | 通過 |
| `TANGENT_TEST_REQUIRE_DB=1 go test ./... -count=1` | 全部 ok（含新的 startup 測試；根套件 91 s、store 56 s、httpapi 29 s） |
| `gofmt -l cmd/` | 無輸出 |
| `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` | 通過；jobs：`go`、`web-typecheck`、`web-vitest`、`web-build` |
| `pnpm -C web install --frozen-lockfile` | 通過（lockfile 無變動） |
| `pnpm -C web typecheck` | 通過（5 個專案） |
| `npx vitest run` fonts／client／react／demo | 10／**1349 過、10 失敗（基線同一批）**／1130／480 |
| `pnpm -C web build` + 檢查腳本（172000） | 主 chunk `index-IyMHCI4Y.js` gzip **165,420**，通過；預算故意設 100000 時 `exit 1`（over by 65,420） |
| `VITE_TANGENT_API=http pnpm -C web build` + 腳本（185000） | gzip **177,824**，通過 |
| 乾淨啟動 | 見下 |

### 乾淨啟動（依新 README 與 `.env.example`）

`cp .env.example .env`、`set -a; . ./.env; set +a`、執行編譯後的 `tangent-server`（等同 `make serve`），`:5444` 的 Postgres 已在跑。這台機器有裝 `claude` 與 `agy`（沒有 `codex`），所以那兩個是 ready：

```text
tangent-server ready
  address    http://127.0.0.1:8120
  access     dev mode: no token, loopback only
  providers
    fake: 1 model
    claude-cli: 4 models (ready)
    codex-cli: skipped (codex binary not found)
    agy-cli: 6 models (ready)
  default    fake:fake-1
  job model  same as the conversation's
  fallback   none
  web ui     not served here; run `VITE_TANGENT_API=http pnpm -C web dev` and open http://localhost:5183
```

`curl /health` → `{"status":"ok"}`；`curl /api/capabilities` 回 `models` 有 `fake`、`agy-cli`（`ready: true`、`details`）等。結束後停掉伺服器，`:8120` 已確認釋放。沒有送任何回合。README 範例輸出用的是「沒有任何 CLI」的版本，並註明裝了 CLI 的差異。

友善錯誤（`env -i`，沒有 provider、沒有 `TANGENT_DEV`）：

```text
tangent-server: TANGENT_TOKEN is required (clients send it as Authorization: Bearer <token>); set TANGENT_DEV=1 and listen on 127.0.0.1 to run without one

Nothing is configured yet. Pick one way to start:

  1. Try it with no key and no login (fake replies, loopback only, no token):
       TANGENT_DEV=1 make serve

  2. A Claude Code or Codex subscription (log in once with "claude login" or "codex login"):
       export TANGENT_TOKEN=$(openssl rand -hex 32)
       TANGENT_PROVIDER=claude-cli TANGENT_CLAUDE_CLI_MODEL=sonnet make serve
       (Codex: TANGENT_PROVIDER=codex-cli TANGENT_CODEX_CLI_MODEL=<model>)

  3. An API key:
       export TANGENT_TOKEN=$(openssl rand -hex 32)
       TANGENT_PROVIDER=openai OPENAI_API_KEY=<key> TANGENT_MODEL=<model> make serve
       (Anthropic: TANGENT_PROVIDER=anthropic ANTHROPIC_API_KEY=<key> TANGENT_MODEL=<model>)

.env.example has these as copy-and-paste scenarios A to D; README.md has the full quickstart.
```

設了 `TANGENT_TOKEN` 但沒有 `TANGENT_PROVIDER` 時同樣附上引導（開頭是 `TANGENT_PROVIDER is required: ...`）；資料庫連不到時附 `make db-up` 提示。

### 與文件對照時發現的行為（README／`.env.example` 已照實寫）

- 只設 `TANGENT_CLAUDE_CLI_MODEL` 而沒有 `TANGENT_PROVIDER` 在非 dev 模式仍會被拒絕（`TANGENT_PROVIDER` 一定要設）；所以情境 B／C 都明寫 `TANGENT_PROVIDER`。工單 §2 的「設定 `TANGENT_CLAUDE_CLI_MODEL`」引導因此一併寫了 `TANGENT_PROVIDER`。
- `.env.example` 原本 `TANGENT_ADDR=:8120` 是啟用狀態；在 `TANGENT_DEV=1` 且沒有 token 時會被拒絕（要 loopback），所以改成註解。
- `.env.example` 預設情境 A 啟用（`TANGENT_DEV=1`），`cp` 後直接可跑。
- 網頁 dev 預設是瀏覽器內 mock，接真伺服器必須 `VITE_TANGENT_API=http`；README 的 Quickstart 明寫。
- Web dev server 連有 token 的伺服器要 `TANGENT_API_TOKEN`（`vite.config.ts` 的 proxy）。

## 衛生檢查

範圍：`git ls-files -co --exclude-standard`（2416 個檔案）。

**個人路徑與使用者名稱**（都在邊界外，沒有修改）：

| 位置 | 內容 |
|---|---|
| 工單、`G1-cli-models.md`、`G2-settings.md`、`G3-prompt-optimization.md` | 指向專案根目錄的 `file://` 絕對路徑連結（收尾已改為相對路徑） |
| 工單、`B19.md`、`B20.md`、`B21.md`、`B22.md`、`F14.md`、`F16_1.md`、`F17.md` | 同樣的本機 `file://` 絕對路徑連結（收尾已改為相對路徑） |
| `docs/HANDOFF.md:65` | 本機 Tailscale 主機名稱與本機暫存 log 路徑（收尾已移除） |
| `docs/devlog/B12-cli-runner.md:150` | 本機 home 目錄下的 `.local/bin/agy` 路徑（收尾已改為 `~/.local/bin/agy`） |
| `docs/devlog/P0-baseline-inventory.md:32` | 本機 worktree 絕對路徑（收尾已改為 `<worktree>/t3-31df4807`） |

**金鑰**：沒有真的 key。`sk-`／token 樣式只出現在 `runner/cli/fake_cli_test.go:129`（`sk-live-abcdef...`、`/home/someone/secret.txt`）與 `runner/cli/units_test.go:58`（`sk-proj-1234567890abcdef`），是測試「錯誤訊息要遮蔽」的假資料。`.env` 已被忽略、沒有被追蹤；`.env.example` 只有空值或 `<placeholder>`。

**其他**：`docs/devlog/screenshots/` 有 299 個已追蹤的 PNG（約 44 MB），是各步驟的設計比對截圖，不含個資但讓 clone 變大，由協調者決定是否保留。`web/e2e/test-results/` 已被 `web/e2e/.gitignore` 忽略。`web/apps/demo/dist/` 已被忽略。

## 工作區既有的未提交檔案（請協調者與使用者一起審核）

只讀沒改。這四項**不是** G1–G4 的產出，看起來是使用者自己的改動：

1. `web/apps/demo/vite.config.ts`（modified）：原本硬編碼允許特定 tailnet 網域；驗收收尾已改為讀取選填環境變數 `VITE_ALLOWED_HOSTS`（逗號分隔），未設定時維持預設。
2. `web/apps/demo/src/frame/conversation-list.tsx`（modified，+27 −4）：兩塊混在一起——(a) G2 的接線（`usePrefs().activityBadges`、`hour12For`，是 G2 devlog 記錄過的），(b) 側欄標題前加一個內嵌 SVG 的 logo（自己的 `useId`、漸層、顏色寫死 `#0D9488` 等）。(b) 不是 G2 的範圍，屬於使用者的品牌改動。
3. `web/apps/demo/index.html`（modified，+5 行）：`theme-color`、`favicon.svg`／`favicon-32x32.png`／`favicon.ico`／`apple-touch-icon.png` 的 `<link>`。
4. `web/apps/demo/public/`（untracked，4 個檔案：`favicon.svg` 719 B、`favicon-32x32.png`、`favicon.ico`、`apple-touch-icon.png` 6.5 KB）：上面 `index.html` 引用的圖示。

2–4 是同一組「logo／favicon」改動；`index.html` 的 `<link>` 與 `public/` 必須一起提交，否則 favicon 會 404。

## 驗收收尾狀態（已處理）

1. `@tangent/client` 的 B25 缺口（`route.imports.*`、`route.lines.import.batch`、`route.lines.list.pinned`、`import_batch_not_found` 及 mock 模擬）已補齊，client vitest 全數通過。
2. 所有本機個人路徑與主機名稱已從 `docs/` 清理。
3. `Makefile` 的 `web-check` 已改為逐套件跑 vitest 並收集狀態碼（與 CI 一致，不因首個套件失敗掩蓋後續套件）。
4. `docs/DESIGN.md`、`docs/EMBEDDING.md`、`docs/API.md` 與 `docs/design/DECISIONS_LOG.md` 已補齊 G1 與 G3 規格與決定紀錄。
5. 邊界例外清單：多動了 `cmd/tangent-server/server.go` 一行（見上）。
