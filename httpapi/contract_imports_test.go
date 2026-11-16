package httpapi_test

import "net/http"

// contractBatchID is the import batch of the contract flow (a client picks
// it; normalised in the samples like every id).
const contractBatchID = "6f1c2a4e-8b3d-4c5e-9a7f-0d1e2f3a4b5c"

// importsAndPins walks the B25 routes: two imports in one batch, the batch
// list, an undo that keeps the conversation used since, and the pinned
// list.
func (f *flow) importsAndPins() {
	body := func(title, question, answer string) map[string]any {
		return map[string]any{
			"title": title, "provider": "fake", "model": "fake-1", "source": "chatgpt", "batchId": contractBatchID, "batchLabel": "conversations.json",
			"messages": []map[string]any{{"role": "user", "content": question}, {"role": "assistant", "content": answer}},
		}
	}
	f.call("lines.import.batch", http.StatusCreated, http.MethodPost, "/lines/import", body("京都賞楓", "十一月去京都看楓葉適合嗎？", "十一月中下旬是京都紅葉的高峰。"))
	used := field(f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines/import", body("大阪美食", "大阪必吃什麼？", "章魚燒與大阪燒。"))), "line", "id").(string)
	f.call("imports.list", http.StatusOK, http.MethodGet, "/imports?limit=20", nil)
	f.turn(used, "哪一家章魚燒最有名？")
	f.call("imports.delete", http.StatusOK, http.MethodDelete, "/imports/"+contractBatchID, nil)
	f.ok(http.StatusOK, f.do(http.MethodPatch, "/lines/"+used, map[string]any{"pinned": true}))
	f.call("lines.list.pinned", http.StatusOK, http.MethodGet, "/lines?pinned=true", nil)
}
