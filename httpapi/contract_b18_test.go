package httpapi_test

import (
	"net/http"
)

// b18Import is the conversation the B18 samples import: a detour about
// Docker in the middle, a shift cue, a closing question and a discarded
// earlier attempt on the first reply.
func b18Import() map[string]any {
	return map[string]any{
		"title": "PostgreSQL MVCC 與鎖定機制討論", "provider": "fake", "model": "fake-1", "folder": "資料庫研究", "tags": []string{"postgres", "mvcc"},
		"source": "chatgpt",
		"messages": []map[string]any{
			{"externalId": "m1", "role": "user", "content": "請解釋 PostgreSQL 的 MVCC 機制"},
			{"externalId": "m2", "role": "assistant", "content": "MVCC 讓每個交易看到自己的快照，PostgreSQL 靠 tuple 的 xmin 與 xmax 判斷可見性。"},
			{"externalId": "m3", "role": "user", "content": "Docker 容器連不上宿主機的 Postgres，出現 connection refused 錯誤"},
			{"externalId": "m4", "role": "assistant", "content": "改連 host.docker.internal 即可。也可以讓容器用 host network。"},
			{"externalId": "m5", "role": "user", "content": "回到 MVCC：PostgreSQL 的 VACUUM 什麼時候會跑？"},
			{"externalId": "m6", "role": "assistant", "content": "autovacuum 會在 dead tuples 超過門檻時執行。\n- 要不要調整 autovacuum_vacuum_scale_factor？\n你想看設定範例嗎？"},
			{"externalId": "m7", "role": "user", "content": "另外，索引膨脹怎麼處理？"},
			{"externalId": "m8", "role": "assistant", "content": "可以用 REINDEX CONCURRENTLY 重建索引。"},
		},
		"branches": []map[string]any{{
			"anchorExternalId": "m2", "purpose": "（歷史重問）如果不用 MVCC 改用 Table Lock 會怎樣？",
			"messages": []map[string]any{
				{"role": "user", "content": "如果不用 MVCC 改用 Table Lock 會怎樣？"},
				{"role": "assistant", "content": "讀寫會互相阻塞，併發度大幅下降。"},
			},
		}},
	}
}

// b18 imports a conversation, renames its folder, reads the tenant's
// folders and tags (B18.1) and its decompose plan
// and extracts the detour it proposes with a conclusion card.
func (f *flow) b18() {
	f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines", map[string]any{"title": "Postgres tuning", "provider": "fake", "model": "fake-1", "tags": []string{"Postgres"}}))
	imported := f.call("lines.import", http.StatusCreated, http.MethodPost, "/lines/import", b18Import())
	main := field(imported, "line", "id").(string)
	f.call("lines.folders.rename", http.StatusOK, http.MethodPost, "/lines/folders/rename", map[string]any{"from": "資料庫研究", "to": "Databases"})
	f.call("lines.organization", http.StatusOK, http.MethodGet, "/lines/organization", nil)
	plan := f.call("lines.decompose", http.StatusOK, http.MethodGet, "/lines/"+main+"/decompose", nil)
	detours := plan["detourRanges"].([]any)
	if len(detours) == 0 {
		f.t.Fatalf("the plan proposes no detour: %v", plan)
	}
	detour := detours[0].(map[string]any)
	f.call("branches.extract", http.StatusCreated, http.MethodPost, "/lines/"+main+"/branches/extract", map[string]any{
		"fromMessageId": detour["fromMessageId"], "toMessageId": detour["toMessageId"], "purpose": "排查 Docker 連線錯誤", "kind": "investigate",
		"card": map[string]any{"question": "為什麼容器連不上宿主機 Postgres？", "conclusion": "改用 host network 或連 host.docker.internal 即可解決。"},
	})
}
