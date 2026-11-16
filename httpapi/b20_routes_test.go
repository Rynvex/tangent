package httpapi_test

import (
	"net/http"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

// B20: POST /lines/{id}/attach hangs another conversation on a line.

func TestB20Routes_AttachOpenAndMerged(t *testing.T) {
	h := newHarness(t)
	target := h.line()
	h.turn(target, "how big a pool?")
	source := field(h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/import", b20Source())), "line", "id").(string)
	out := h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+target+"/attach", map[string]any{"sourceLineId": source}))
	if out["cardMessage"] != nil || field(out, "branch", "status") != "open" || field(out, "branch", "parentLineId") != target ||
		field(out, "branchLine", "id") != source || field(out, "branchLine", "folder") != "" || field(out, "targetLine", "id") != target {
		t.Fatalf("attached = %v", out)
	}
	if reparented, ok := out["reparented"].([]any); !ok || len(reparented) != 0 {
		t.Fatalf("reparented = %v", out["reparented"])
	}
	page := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines", nil))
	for _, line := range page["lines"].([]any) {
		if line.(map[string]any)["id"] == source {
			t.Fatalf("the attached line is no main line any more: %v", page)
		}
	}
	if len(h.events.OfType(tangent.EventBranchChanged)) == 0 {
		t.Fatal("no branch.changed")
	}
	// A second conversation, merged with its card.
	second := field(h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/import", b20Source())), "line", "id").(string)
	merged := h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+target+"/attach", map[string]any{
		"sourceLineId": second, "status": "merged", "purpose": "pool mode", "card": map[string]any{"conclusion": "transaction"},
	}))
	if field(merged, "cardMessage", "kind") != "branch_card" || field(merged, "branch", "status") != "merged" || field(merged, "cardMessage", "meta", "card", "question") != "pool mode" {
		t.Fatalf("merged = %v", merged)
	}
}

func TestB20Routes_AttachRefusals(t *testing.T) {
	h := newHarness(t)
	target := h.line()
	h.turn(target, "q")
	source := field(h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/import", b20Source())), "line", "id").(string)
	path := "/lines/" + target + "/attach"
	cases := []struct {
		name, code, field string
		status            int
		body              map[string]any
	}{
		{"no source", "invalid_input", "sourceLineId", http.StatusBadRequest, map[string]any{}},
		{"itself", "invalid_input", "sourceLineId", http.StatusBadRequest, map[string]any{"sourceLineId": target}},
		{"merged without a card", "invalid_input", "card", http.StatusBadRequest, map[string]any{"sourceLineId": source, "status": "merged"}},
		{"a card on an open attach", "invalid_input", "card", http.StatusBadRequest, map[string]any{"sourceLineId": source, "card": map[string]any{"conclusion": "c"}}},
		{"a bad status", "invalid_input", "status", http.StatusBadRequest, map[string]any{"sourceLineId": source, "status": "promoted"}},
		{"unknown source", "line_not_found", "", http.StatusNotFound, map[string]any{"sourceLineId": unknownID}},
		{"an aside", "kind_unsupported", "", http.StatusBadRequest, map[string]any{"sourceLineId": source, "kind": "aside"}},
		{"an anchor elsewhere", "anchor_not_found", "", http.StatusNotFound, map[string]any{"sourceLineId": source, "anchorMessageId": unknownID}},
	}
	for _, c := range cases {
		r := h.do(http.MethodPost, path, c.body)
		h.wantError(r, c.status, c.code)
		if c.field != "" && r.json(t)["field"] != c.field {
			t.Fatalf("%s: field = %v", c.name, r.json(t)["field"])
		}
	}
	r := h.do(http.MethodPost, path, map[string]any{"sourceLineId": source, "status": "merged", "card": map[string]any{"conclusion": "c", "conclusion ": 1}})
	h.wantError(r, http.StatusUnprocessableEntity, "invalid_card")
}
