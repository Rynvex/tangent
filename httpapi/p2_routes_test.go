package httpapi_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

// p2Seed draws a relation from the main line's first reply to the branch
// and returns its id.
func (h *harness) p2Seed(s seeded) string {
	h.t.Helper()
	created := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+s.main+"/relations", map[string]any{
		"fromMessageId": s.reply, "toLineId": s.branch, "label": "closer look",
	}))
	return field(created, "relation", "id").(string)
}

// p2Routes are the B9 part A routes: the goal, relations, open loops and
// pins.
func p2Routes(s seeded) []routeCase {
	line, goal := "/lines/"+s.main, "/lines/"+s.main+"/goal"
	message := "/messages/" + s.reply + "/pin"
	badMessage := badRequest{path: "/messages/x/pin", status: 404, code: "message_not_found"}
	return []routeCase{
		{name: "get goal", method: "GET", path: goal, lineScoped: true, feature: tangent.FeatureGoal,
			bad: badRequest{path: "/lines/not-a-uuid/goal", status: 404, code: "line_not_found"}},
		{name: "put goal", method: "PUT", path: goal, body: map[string]any{"text": "Settle the plan"}, write: true, lineScoped: true, feature: tangent.FeatureGoal,
			bad: badRequest{body: map[string]any{"text": " "}, status: 400, code: "invalid_input"}},
		{name: "delete goal", method: "DELETE", path: goal, write: true, lineScoped: true, feature: tangent.FeatureGoal,
			bad: badRequest{path: "/lines/not-a-uuid/goal", status: 404, code: "line_not_found"}},
		{name: "propose goal", method: "POST", path: goal + "/propose", write: true, lineScoped: true, feature: tangent.FeatureGoal,
			bad: badRequest{path: "/lines/" + unknownID + "/goal/propose", status: 404, code: "line_not_found"}},
		{name: "list relations", method: "GET", path: line + "/relations", lineScoped: true, feature: tangent.FeatureRelations,
			bad: badRequest{path: "/lines/not-a-uuid/relations", status: 404, code: "line_not_found"}},
		{name: "create relation", method: "POST", path: line + "/relations", body: map[string]any{"toLineId": s.branch, "label": "again"}, write: true, lineScoped: true,
			feature: tangent.FeatureRelations, bad: badRequest{body: map[string]any{"toLineId": s.branch, "label": strings.Repeat("l", 201)}, status: 422, code: "too_long"}},
		{name: "delete relation", method: "DELETE", path: line + "/relations/" + s.relation, write: true, lineScoped: true, feature: tangent.FeatureRelations,
			bad: badRequest{path: line + "/relations/x", status: 404, code: "relation_not_found"}},
		{name: "open loops", method: "GET", path: "/open-loops?root=" + s.main, lineScoped: true, feature: tangent.FeatureOpenLoops,
			bad: badRequest{path: "/open-loops?staleDays=400", status: 400, code: "invalid_input"}},
		{name: "pin", method: "POST", path: message, write: true, lineScoped: true, bad: badMessage},
		{name: "unpin", method: "DELETE", path: message, write: true, lineScoped: true, bad: badMessage},
	}
}

func TestP2Routes_LinksAreMountedForRelationsAlone(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) { c.features = []tangent.Feature{tangent.Relations(tangent.ModeManual)} })
	main := h.line()
	other := h.line()
	h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+main+"/relations", map[string]any{"toLineId": other}))
	links := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/links", nil))
	if got := links["links"].([]any); len(got) != 1 || got[0].(map[string]any)["kind"] != "relation" {
		t.Fatalf("links = %v", links)
	}
	r := h.do(http.MethodGet, "/lines/"+main+"/links", nil, as(tenantOff))
	h.wantError(r, http.StatusNotFound, "feature_disabled")
	if r.json(t)["feature"] != tangent.FeatureRelations {
		t.Fatalf("the refusal names relations: %s", r.raw)
	}
}

func TestP2Routes_PinIsCoreAndBodiesAreChecked(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) { c.features = nil })
	s := seededCore(h)
	pinned := h.ok(http.StatusOK, h.do(http.MethodPost, "/messages/"+s.reply+"/pin", nil))
	if field(pinned, "message", "pinned") != true {
		t.Fatalf("pinned = %v", pinned)
	}
	full := newHarness(t)
	main := full.line()
	full.wantError(full.do(http.MethodPost, "/lines/"+main+"/relations", map[string]any{"toLineId": main, "extra": 1}), http.StatusBadRequest, "invalid_input")
	full.wantError(full.do(http.MethodPut, "/lines/"+main+"/goal", map[string]any{"text": strings.Repeat("g", 301)}), http.StatusUnprocessableEntity, "too_long")
	full.wantError(full.do(http.MethodGet, "/open-loops?staleDays=x", nil), http.StatusBadRequest, "invalid_input")
	full.wantError(full.do(http.MethodGet, "/open-loops?root=not-a-uuid", nil), http.StatusNotFound, "line_not_found")
}
