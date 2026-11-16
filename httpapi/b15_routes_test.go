package httpapi_test

import (
	"net/http"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

// b15Routes are the B15 routes: a tree's draft argument tags.
func b15Routes(s seeded) []routeCase {
	return []routeCase{
		{name: "tag drafts", method: "GET", path: "/lines/" + s.branch + "/tag-drafts", lineScoped: true, feature: tangent.FeatureIbis,
			bad: badRequest{path: "/lines/not-a-uuid/tag-drafts", status: 404, code: "line_not_found"}},
	}
}

func TestB15Routes_RelationKinds(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	reply := h.turn(main, "ring buffer or list?")
	a, b := h.branch(main, reply, "ring buffer"), h.branch(main, reply, "linked list")

	plain := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+main+"/relations", map[string]any{"fromLineId": a, "toLineId": b}))
	if field(plain, "relation", "relationKind") != "related" {
		t.Fatalf("no kind is related: %v", plain)
	}
	rid := field(plain, "relation", "id").(string)
	h.wantError(h.do(http.MethodPost, "/lines/"+main+"/relations", map[string]any{"fromLineId": main, "toLineId": a, "relationKind": "rivals"}), http.StatusBadRequest, "invalid_input")
	created := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+main+"/relations", map[string]any{"fromLineId": main, "toLineId": a, "label": "x", "relationKind": "contradicts"}))
	if field(created, "relation", "relationKind") != "contradicts" {
		t.Fatalf("created = %v", created)
	}

	path := "/lines/" + main + "/relations/" + rid
	kindOnly := h.ok(http.StatusOK, h.do(http.MethodPatch, path, map[string]any{"relationKind": "supports"}))
	labelOnly := h.ok(http.StatusOK, h.do(http.MethodPatch, path, map[string]any{"label": "same cache"}))
	if field(kindOnly, "relation", "relationKind") != "supports" || field(labelOnly, "relation", "label") != "same cache" || field(labelOnly, "relation", "relationKind") != "supports" {
		t.Fatalf("an absent field keeps the stored value: %v / %v", kindOnly, labelOnly)
	}
	nothing := h.ok(http.StatusOK, h.do(http.MethodPatch, path, map[string]any{"label": nil}))
	if field(nothing, "relation", "label") != "same cache" || field(nothing, "relation", "relationKind") != "supports" {
		t.Fatalf("null is absent: %v", nothing)
	}
	for _, bad := range []string{"Supports", "", "  "} {
		r := h.do(http.MethodPatch, path, map[string]any{"relationKind": bad})
		h.wantError(r, http.StatusBadRequest, "invalid_input")
		if r.json(t)["field"] != "relationKind" {
			t.Fatalf("the refusal names relationKind (%q): %s", bad, r.raw)
		}
	}
	if kept := h.ok(http.StatusOK, h.do(http.MethodPatch, path, map[string]any{})); field(kept, "relation", "relationKind") != "supports" {
		t.Fatalf("a refused empty kind keeps the stored one: %v", kept)
	}
	h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+main+"/relations", map[string]any{"fromLineId": main, "toLineId": b, "relationKind": ""}))
	h.wantError(h.do(http.MethodPatch, path, nil), http.StatusBadRequest, "invalid_input")

	relations := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+b+"/relations", nil))["relations"].([]any)
	links := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/links", nil))["links"].([]any)
	if len(relations) != 3 || len(links) != 3 {
		t.Fatalf("relations = %v, links = %v", relations, links)
	}
	for _, link := range append(relations, links...) {
		if _, ok := link.(map[string]any)["relationKind"]; !ok {
			t.Fatalf("every relation carries its kind: %v", link)
		}
	}
	out := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+a+"/export", nil))
	if len(out["links"].([]any)) != 3 || out["links"].([]any)[0].(map[string]any)["relationKind"] == nil {
		t.Fatalf("export links = %v", out["links"])
	}
}

func TestB15Routes_SpinoffLinksHaveNoKind(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	reply := h.turn(main, "start over?")
	h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+main+"/spinoff", map[string]any{"mode": "fresh", "atMessageId": reply}))
	links := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/links", nil))["links"].([]any)
	if len(links) != 1 {
		t.Fatalf("links = %v", links)
	}
	if _, ok := links[0].(map[string]any)["relationKind"]; ok {
		t.Fatalf("a spinoff link has no relationKind: %v", links[0])
	}
}

func TestB15Routes_TagDraftsAndPuttingATagBack(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	reply := h.turn(main, "why does it refuse?")
	branch := h.branch(main, reply, "the borrow")
	inBranch := h.turn(branch, "which borrow?")
	tag := "/messages/" + reply + "/tag"

	confirmed := h.ok(http.StatusOK, h.do(http.MethodPut, tag, map[string]any{"kind": "idea"}))
	if field(confirmed, "message", "tag", "source") != "user" || field(confirmed, "message", "tag", "status") != "confirmed" {
		t.Fatalf("no status is confirmed: %v", confirmed)
	}
	h.events.Reset()
	draft := h.ok(http.StatusOK, h.do(http.MethodPut, tag, map[string]any{"kind": "idea", "status": "draft"}))
	if field(draft, "message", "tag", "source") != "ai" || field(draft, "message", "tag", "status") != "draft" {
		t.Fatalf("back to a draft: %v", draft)
	}
	if got := h.events.OfType(tangent.EventMessageUpdated); len(got) != 1 {
		t.Fatalf("message.updated once: %v", h.events.Types())
	}
	h.ok(http.StatusOK, h.do(http.MethodPut, "/messages/"+inBranch+"/tag", map[string]any{"kind": "pro", "status": "draft"}))
	for _, bad := range []any{"Draft", "pending", 1} {
		h.wantError(h.do(http.MethodPut, tag, map[string]any{"kind": "idea", "status": bad}), http.StatusBadRequest, "invalid_input")
	}

	out := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+branch+"/tag-drafts", nil, readOnly()))
	drafts := out["drafts"].([]any)
	if out["rootLineId"] != main || out["truncated"] != false || len(drafts) != 2 {
		t.Fatalf("tag-drafts = %v", out)
	}
	first := drafts[0].(map[string]any)
	if first["lineId"] != main || first["messageId"] != reply || first["role"] != "assistant" || first["seq"] == nil || first["content"] == "" ||
		field(first, "tag", "kind") != "idea" || field(first, "tag", "status") != "draft" || field(first, "tag", "updatedAt") == nil ||
		drafts[1].(map[string]any)["lineId"] != branch {
		t.Fatalf("drafts = %v", drafts)
	}
	h.ok(http.StatusOK, h.do(http.MethodPut, tag, map[string]any{"kind": "idea", "status": "confirmed"}))
	if again := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/tag-drafts", nil))["drafts"].([]any); len(again) != 1 {
		t.Fatalf("a confirmed tag leaves the list: %v", again)
	}
}
