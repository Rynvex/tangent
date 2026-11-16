package httpapi_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// B25: import batches and pinned conversations.

// batchBody is a two-message import in batch id.
func batchBody(title, id, label string) map[string]any {
	return map[string]any{
		"title": title, "batchId": id, "batchLabel": label,
		"messages": []map[string]any{{"role": "user", "content": "q " + title}, {"role": "assistant", "content": "a " + title}},
	}
}

// importSeed imports one conversation in a batch of tenant A.
func (h *harness) importSeed(s *seeded) {
	h.t.Helper()
	s.importBatch = uuid.NewString()
	h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/import", batchBody("imported", s.importBatch, "seed.json")))
}

// importRoutes are the import batch routes.
func importRoutes(s seeded) []routeCase {
	return []routeCase{
		{name: "list imports", method: "GET", path: "/imports", bad: badRequest{path: "/imports?cursor=nope", status: 400, code: "invalid_input"}},
		{name: "delete import", method: "DELETE", path: "/imports/" + s.importBatch, write: true, lineScoped: true,
			bad: badRequest{path: "/imports/not-a-uuid", status: 404, code: "import_batch_not_found"}},
	}
}

func TestImportRoutes_BatchListAndUndo(t *testing.T) {
	h := newHarness(t)
	id := uuid.NewString()
	first := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/import", batchBody("one", id, "chats.json")))
	if field(first, "line", "importBatchId") != id {
		t.Fatalf("the imported line names its batch: %v", first["line"])
	}
	used := field(h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/import", batchBody("two", id, ""))), "line", "id").(string)
	plain := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/import", batchBody("three", "", "")))
	if _, has := plain["line"].(map[string]any)["importBatchId"]; has {
		t.Fatalf("a line of no batch has no importBatchId: %v", plain["line"])
	}
	h.wantError(h.do(http.MethodPost, "/lines/import", batchBody("theirs", id, ""), as(tenantB)), http.StatusNotFound, "import_batch_not_found")
	h.wantError(h.do(http.MethodPost, "/lines/import", batchBody("x", "batch-1", "")), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodPost, "/lines/import", batchBody("x", uuid.NewString(), strings.Repeat("x", 121))), http.StatusBadRequest, "invalid_input")

	page := h.ok(http.StatusOK, h.do(http.MethodGet, "/imports?limit=10", nil))
	batches := page["imports"].([]any)
	if len(batches) != 1 || page["nextCursor"] != "" {
		t.Fatalf("imports = %v", page)
	}
	batch := batches[0].(map[string]any)
	if batch["id"] != id || batch["label"] != "chats.json" || batch["lineCount"] != float64(2) || batch["standaloneCount"] != float64(2) {
		t.Fatalf("batch = %v", batch)
	}
	if other := h.ok(http.StatusOK, h.do(http.MethodGet, "/imports", nil, as(tenantB))); len(other["imports"].([]any)) != 0 {
		t.Fatalf("tenant B lists no batch: %v", other)
	}

	h.turn(used, "a question after the import")
	kept := h.ok(http.StatusOK, h.do(http.MethodDelete, "/imports/"+id, nil))
	if len(kept["deleted"].([]any)) != 1 || field(kept["kept"].([]any)[0].(map[string]any), "reason") != "changed" {
		t.Fatalf("the used one is kept: %v", kept)
	}
	h.wantError(h.do(http.MethodDelete, "/imports/"+id+"?force=maybe", nil), http.StatusBadRequest, "invalid_input")
	forced := h.ok(http.StatusOK, h.do(http.MethodDelete, "/imports/"+id+"?force=true", nil))
	if len(forced["deleted"].([]any)) != 1 || len(forced["kept"].([]any)) != 0 {
		t.Fatalf("force deletes it: %v", forced)
	}
	h.wantError(h.do(http.MethodDelete, "/imports/"+id, nil), http.StatusNotFound, "import_batch_not_found")
}

func TestLineRoutes_PinAndListPinned(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	reply := h.turn(main, "q")
	branch := h.branch(main, reply, "side")
	h.line()
	pinned := h.ok(http.StatusOK, h.do(http.MethodPatch, "/lines/"+main, map[string]any{"pinned": true}))
	if pinned["pinnedAt"] == nil {
		t.Fatalf("pinned = %v", pinned)
	}
	h.wantError(h.do(http.MethodPatch, "/lines/"+branch, map[string]any{"pinned": true}), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodPatch, "/lines/"+main, map[string]any{"pinned": "yes"}), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodPost, "/lines", map[string]any{"title": "x", "pinned": true}), http.StatusBadRequest, "invalid_input")
	list := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines?pinned=true", nil))
	if lines := list["lines"].([]any); len(lines) != 1 || lines[0].(map[string]any)["id"] != main || list["nextCursor"] != "" {
		t.Fatalf("pinned list = %v", list)
	}
	if all := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines?pinned=false", nil)); len(all["lines"].([]any)) != 2 {
		t.Fatalf("pinned=false does not filter: %v", all)
	}
	h.wantError(h.do(http.MethodGet, "/lines?pinned=sure", nil), http.StatusBadRequest, "invalid_input")
	unpinned := h.ok(http.StatusOK, h.do(http.MethodPatch, "/lines/"+main, map[string]any{"pinned": false}))
	if _, has := unpinned["pinnedAt"]; has {
		t.Fatalf("unpinned = %v", unpinned)
	}
}
