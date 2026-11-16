package httpapi_test

import (
	"net/http"
)

// b20Source is a conversation imported on its own that turns out to belong
// to another one.
func b20Source() map[string]any {
	return map[string]any{
		"title": "PgBouncer 設定", "provider": "fake", "model": "fake-1", "folder": "資料庫研究", "tags": []string{"postgres"},
		"messages": []map[string]any{
			{"role": "user", "content": "PgBouncer 的 pool_mode 該選哪個？"},
			{"role": "assistant", "content": "多數服務用 transaction 模式。"},
		},
	}
}

// b20 attaches that conversation to the one it belongs to, brought back
// with its conclusion card (B20).
func (f *flow) b20() {
	target := f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines", map[string]any{"title": "連線池調校", "provider": "fake", "model": "fake-1"}))["id"].(string)
	f.turn(target, "PG 連線池要開多大？")
	source := field(f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines/import", b20Source())), "line", "id").(string)
	f.call("lines.attach", http.StatusOK, http.MethodPost, "/lines/"+target+"/attach", map[string]any{
		"sourceLineId": source, "status": "merged", "card": map[string]any{"conclusion": "用 transaction 模式，pool size 先設 20。"},
	})
}
