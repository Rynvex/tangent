# minimal-host

一個嵌入 tangent 的小服務（`package main`，同一個 Go module），示範宿主該做的事：

- **自己的路由**：標準函式庫 `ServeMux`；`GET /health`（公開）、`GET /whoami`（宿主自己的路由），tangent 的 API 掛在 `/api` 底下，SSE 在 `/api/events`。
- **自己的認證**：固定的 API key 對應 tenant（`Authorization: Bearer <key>`），接在 `httpapi.Config.Scope`；key 只以 SHA-256 比對，actor 是 key 雜湊的前 8 碼。
- **fake runner**：不連網、不用金鑰，回覆會回顯你的訊息，起草結論卡與摘要都會得到合法的結果。換成 `runner/openai` 或 `runner/anthropic` 就是真的 AI。
- 啟動時 `store.Migrate`、每分鐘 `Engine.Maintain`、關機時排空請求並讓執行中的回合寫回。

程式：`host.go`（組裝與認證）、`main.go`（設定、伺服器、維護迴圈）。測試 `host_test.go` 用 `tangenttest` 跑過
「建主線 → 一輪 → 開支線 → 支線裡一輪 → 起草結論卡 → merge → 下一輪帶出卡片」，以及租戶隔離、認證、SSE。

## 執行

需要 Postgres :5444（`make db-up`）。範例用自己的資料庫 `tangent_example`，第一次先建立：

```bash
make db-up
docker exec tangent-postgres psql -U tangent -d tangent -c "CREATE DATABASE tangent_example OWNER tangent"
```

API key 只從環境變數讀（`tenant:key`，逗號分隔，每個 key 至少 16 字元）：

```bash
export EXAMPLE_API_KEYS="acme:$(openssl rand -hex 16),beta:$(openssl rand -hex 16)"
go run ./examples/minimal-host        # http://127.0.0.1:8122
```

| 變數 | 預設 |
|---|---|
| `EXAMPLE_API_KEYS` | 必填 |
| `EXAMPLE_DATABASE_URL` | `postgres://tangent:tangent@localhost:5444/tangent_example?sslmode=disable` |
| `EXAMPLE_ADDR` | `127.0.0.1:8122`（已登記在 `service_board` 的 tangent 段） |

試一下：

```bash
KEY="${EXAMPLE_API_KEYS#acme:}"; KEY="${KEY%%,*}"
AUTH="Authorization: Bearer $KEY"
curl -s localhost:8122/whoami -H "$AUTH"
LINE=$(curl -s localhost:8122/api/lines -H "$AUTH" -H 'Content-Type: application/json' -d '{"title":"Kyoto"}' | jq -r .id)
curl -s localhost:8122/api/lines/$LINE/messages -H "$AUTH" -H 'Content-Type: application/json' -d '{"content":"When should I go?"}'
curl -s "localhost:8122/api/lines/$LINE/messages" -H "$AUTH" | jq '.messages[] | {role, status, content}'
curl -sN localhost:8122/api/events -H "$AUTH"   # 另開一個終端看事件
```

## 測試

```bash
go test ./examples/minimal-host -count=1   # 每個測試用 tangent_test 裡一個乾淨的 schema；連不到 :5444 就 skip
```

路由與事件的完整說明見 `docs/API.md`，嵌入的各種做法見 `docs/EMBEDDING.md`。
