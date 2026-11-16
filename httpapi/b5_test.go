package httpapi_test

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

func TestB5_SearchAnswersHitsAndChecksItsParameters(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	h.turn(main, "我們討論分岔對話的設計")
	path := "/search?q=" + url.QueryEscape("分岔對話")
	body := h.ok(http.StatusOK, h.do(http.MethodGet, path, nil))
	hits := body["hits"].([]any)
	if body["query"] != "分岔對話" || len(hits) != 2 { // the question and the fake echo
		t.Fatalf("search %v", body)
	}
	hit := hits[0].(map[string]any)
	if hit["rootLineId"] != main || hit["kind"] != "message" || len(hit["highlights"].([]any)) != 1 {
		t.Fatalf("hit %v", hit)
	}
	if other := h.ok(http.StatusOK, h.do(http.MethodGet, path, nil, as(tenantB))); len(other["hits"].([]any)) != 0 {
		t.Fatalf("tenant B: %v", other)
	}
	if archived := h.ok(http.StatusOK, h.do(http.MethodGet, path+"&archived=true", nil)); len(archived["hits"].([]any)) != 0 {
		t.Fatalf("archive: %v", archived)
	}
	if one := h.ok(http.StatusOK, h.do(http.MethodGet, path+"&limit=1", nil, readOnly())); len(one["hits"].([]any)) != 1 {
		t.Fatalf("limit and read-only: %v", one)
	}
	h.wantError(h.do(http.MethodGet, "/search", nil), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodGet, path+"&limit=51", nil), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodGet, path+"&archived=maybe", nil), http.StatusBadRequest, "invalid_input")
	r := h.do(http.MethodGet, "/search?q="+strings.Repeat("x", 201), nil)
	h.wantError(r, http.StatusUnprocessableEntity, "too_long")
	if r.json(t)["field"] != "q" {
		t.Fatalf("too_long names q: %s", r.raw)
	}
	h.wantError(h.do(http.MethodGet, path, nil, as(tenantOff)), http.StatusNotFound, "feature_disabled")
}

func TestB5_SearchIsNotMountedWithoutTheFeature(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) { c.features = tangent.AllFeatures() })
	h.wantError(h.do(http.MethodGet, "/search?q=anything", nil), http.StatusNotFound, "not_found")
}

func TestB5_BranchPreviewAndRename(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	reply := h.turn(main, "first question")
	preview := h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+main+"/branches/preview",
		map[string]any{"anchorMessageId": reply, "kind": "investigate"}, readOnly()))
	if preview["text"] == "" || preview["tokenEstimate"].(float64) <= 0 || field(preview, "pack", "anchorMessageId") != reply {
		t.Fatalf("preview %v", preview)
	}
	h.wantError(h.do(http.MethodPost, "/lines/"+main+"/branches/preview", map[string]any{"anchorMessageId": reply, "kind": "investigate", "hostMeta": map[string]any{"a": 1}}),
		http.StatusBadRequest, "invalid_input")
	branch := h.branch(main, reply, "look closer")
	h.events.Reset()
	renamed := h.ok(http.StatusOK, h.do(http.MethodPatch, "/lines/"+branch+"/branch", map[string]any{"purpose": " look much closer "}))
	if field(renamed, "branch", "purpose") != "look much closer" {
		t.Fatalf("renamed %v", renamed)
	}
	if got := h.events.Types(); len(got) != 2 || got[0] != tangent.EventBranchChanged {
		t.Fatalf("events %v", got)
	}
	h.wantError(h.do(http.MethodPatch, "/lines/"+branch+"/branch", map[string]any{}), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodPatch, "/lines/"+main+"/branch", map[string]any{"purpose": "x y"}), http.StatusNotFound, "branch_not_found")
	h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+branch+"/branch/discard", nil))
	// B13: an ended branch can still be renamed.
	h.ok(http.StatusOK, h.do(http.MethodPatch, "/lines/"+branch+"/branch", map[string]any{"purpose": "after the end"}))
}

func TestB5_CapabilitiesListTheModelsAndJobsNameTheirModel(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) {
		c.engineOpts = append(c.engineOpts, tangent.WithModelCatalog(tangent.ModelGroup{Provider: "fake", Models: []string{"fake-1"}}))
	})
	caps := h.ok(http.StatusOK, h.do(http.MethodGet, "/capabilities", nil))
	models := caps["models"].([]any)
	if len(models) != 1 || models[0].(map[string]any)["provider"] != "fake" {
		t.Fatalf("models %v", caps["models"])
	}
	plain := newHarness(t)
	if got := plain.ok(http.StatusOK, plain.do(http.MethodGet, "/capabilities", nil))["models"]; got == nil || len(got.([]any)) != 0 {
		t.Fatalf("no catalog is an empty list: %v", got)
	}
	main := h.line()
	reply := h.turn(main, "q")
	branch := h.branch(main, reply, "side")
	h.turn(branch, "in the branch")
	started := h.ok(http.StatusAccepted, h.do(http.MethodPost, "/lines/"+branch+"/branch/draft", nil))
	if started["provider"] != "fake" || started["model"] != "fake-1" {
		t.Fatalf("draft 202 %v", started)
	}
	h.dispatcher.Wait()
}

func TestB5_NotesLimitsCarryTheTokenBudget(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	notes := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/notes", nil))
	if got := field(notes, "limits", "tokenBudget"); got != float64(h.engine.Limits().Notes.TokenBudget) || got == float64(0) {
		t.Fatalf("limits %v", notes["limits"])
	}
}
