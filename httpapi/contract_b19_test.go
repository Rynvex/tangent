package httpapi_test

import (
	"net/http"
)

// b19Import is an assembled import (B19): dated messages (one left undated,
// the third question after a 45-minute pause), two milestone chapter cuts
// and a branch already brought back with its card.
func b19Import() map[string]any {
	return map[string]any{
		"title": "MVCC 筆記（組裝）", "provider": "fake", "model": "fake-1", "source": "chatgpt", "createdAt": "2025-03-01T09:00:00Z",
		"messages": []map[string]any{
			{"externalId": "s1-1", "role": "user", "content": "請解釋 PostgreSQL 的 MVCC 機制", "createdAt": "2025-03-01T09:00:00Z"},
			{"externalId": "s1-2", "role": "assistant", "content": "每個交易看到自己的快照。", "createdAt": "2025-03-01T09:01:00Z"},
			{"externalId": "s1-3", "role": "user", "content": "VACUUM 什麼時候會跑？", "createdAt": "2025-03-01T09:02:00Z"},
			{"externalId": "s1-4", "role": "assistant", "content": "dead tuples 超過門檻時。"},
			{"externalId": "s2-1", "role": "user", "content": "索引膨脹怎麼處理？", "createdAt": "2025-03-01T17:47:00+08:00"},
			{"externalId": "s2-2", "role": "assistant", "content": "用 REINDEX CONCURRENTLY 重建。", "createdAt": "2025-03-01T09:48:00Z"},
		},
		"branches": []map[string]any{{
			"anchorExternalId": "s1-2", "purpose": "如果改用 Table Lock 會怎樣？", "status": "merged", "createdAt": "2025-03-01T09:03:00Z",
			"card": map[string]any{"conclusion": "讀寫會互相阻塞，併發度大幅下降。", "openItems": []string{"量測鎖等待時間"}},
			"messages": []map[string]any{
				{"role": "user", "content": "如果不用 MVCC 改用 Table Lock 會怎樣？"},
				{"role": "assistant", "content": "讀寫會互相阻塞。", "createdAt": "2025-03-01T09:05:00Z"},
			},
		}},
		"chapterCuts": []map[string]any{{"anchorExternalId": "s1-1", "title": "§1 MVCC 與 VACUUM"}, {"anchorExternalId": "s2-1", "title": "§2 索引"}},
	}
}

// b19 imports an assembled conversation: the request shape with every
// new field (the answer has the same shape as any import's).
func (f *flow) b19() {
	f.call("lines.import.assembled", http.StatusCreated, http.MethodPost, "/lines/import", b19Import())
}
