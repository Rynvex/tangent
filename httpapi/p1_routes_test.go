package httpapi_test

import (
	"net/http"

	"github.com/Rynvex/tangent/tangent"
)

// p1Seed raises a suggestion (the probe, through the fake runner's echo)
// and parks a seed on the main line; it returns their ids.
func (h *harness) p1Seed(main string) (suggestion, seed string) {
	h.t.Helper()
	h.turn(main, "please "+tangent.ProbeDirective)
	list := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/suggestions", nil))
	suggestions := list["suggestions"].([]any)
	if len(suggestions) != 1 {
		h.t.Fatalf("the probe raised one suggestion: %v", list)
	}
	created := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+main+"/seeds", map[string]any{"text": "a thought for later"}))
	return suggestions[0].(map[string]any)["id"].(string), field(created, "seed", "id").(string)
}

// p1Routes are the B8 routes: the suggestion inbox, leaves and seeds.
func p1Routes(s seeded) []routeCase {
	line, branch := "/lines/"+s.main, "/lines/"+s.branch
	suggestion, seed := "/suggestions/"+s.suggestion, "/seeds/"+s.seed
	return []routeCase{
		{name: "list suggestions", method: "GET", path: line + "/suggestions", lineScoped: true, feature: tangent.FeatureSuggestions,
			bad: badRequest{path: line + "/suggestions?status=nope", status: 400, code: "invalid_input"}},
		{name: "accept suggestion", method: "POST", path: suggestion + "/accept", body: map[string]any{}, write: true, lineScoped: true, feature: tangent.FeatureSuggestions,
			bad: badRequest{path: "/suggestions/x/accept", status: 404, code: "suggestion_not_found"}},
		{name: "dismiss suggestion", method: "POST", path: suggestion + "/dismiss", write: true, lineScoped: true, feature: tangent.FeatureSuggestions,
			bad: badRequest{path: "/suggestions/" + unknownID + "/dismiss", status: 404, code: "suggestion_not_found"}},
		{name: "get leaf", method: "GET", path: branch + "/leaf", lineScoped: true, feature: tangent.FeatureLeaf,
			bad: badRequest{path: line + "/leaf", status: 404, code: "branch_not_found"}},
		{name: "put leaf", method: "PUT", path: branch + "/leaf", body: map[string]any{"kind": "answer", "line": "found it"}, write: true, lineScoped: true, feature: tangent.FeatureLeaf,
			bad: badRequest{body: map[string]any{"kind": "nope", "line": "x"}, status: 422, code: "invalid_leaf"}},
		{name: "delete leaf", method: "DELETE", path: branch + "/leaf", write: true, lineScoped: true, feature: tangent.FeatureLeaf,
			bad: badRequest{path: line + "/leaf", status: 404, code: "branch_not_found"}},
		{name: "draft leaf", method: "POST", path: branch + "/leaf/draft", write: true, lineScoped: true, feature: tangent.FeatureLeaf,
			bad: badRequest{path: line + "/leaf/draft", status: 404, code: "branch_not_found"}},
		{name: "list seeds", method: "GET", path: line + "/seeds", lineScoped: true, feature: tangent.FeatureParking,
			bad: badRequest{path: line + "/seeds?status=nope", status: 400, code: "invalid_input"}},
		{name: "create seed", method: "POST", path: line + "/seeds", body: map[string]any{"text": "another thought"}, write: true, lineScoped: true, feature: tangent.FeatureParking,
			bad: badRequest{body: map[string]any{"text": " "}, status: 400, code: "invalid_input"}},
		{name: "expand seed", method: "POST", path: seed + "/expand", body: map[string]any{"purpose": "look into it"}, write: true, lineScoped: true, feature: tangent.FeatureParking,
			bad: badRequest{body: map[string]any{"kind": "nope"}, status: 400, code: "kind_unsupported"}},
		{name: "seed to note", method: "POST", path: seed + "/to-note", write: true, lineScoped: true, feature: tangent.FeatureParking,
			bad: badRequest{path: "/seeds/" + unknownID + "/to-note", status: 404, code: "seed_not_found"}},
		{name: "drop seed", method: "POST", path: seed + "/drop", write: true, lineScoped: true, feature: tangent.FeatureParking,
			bad: badRequest{path: "/seeds/x/drop", status: 404, code: "seed_not_found"}},
		{name: "spinoff", method: "POST", path: line + "/spinoff", body: map[string]any{"mode": "fresh", "atMessageId": s.reply}, write: true, lineScoped: true,
			feature: tangent.FeatureSpinoff, bad: badRequest{body: map[string]any{"mode": "copy"}, status: 400, code: "invalid_input"}},
		{name: "preview spinoff", method: "POST", path: line + "/spinoff/preview", body: map[string]any{"mode": "fresh", "atMessageId": s.reply}, lineScoped: true,
			feature: tangent.FeatureSpinoff, bad: badRequest{body: map[string]any{"mode": "detach"}, status: 404, code: "branch_not_found"}},
		{name: "list links", method: "GET", path: line + "/links", lineScoped: true, feature: tangent.FeatureSpinoff,
			bad: badRequest{path: "/lines/not-a-uuid/links", status: 404, code: "line_not_found"}},
	}
}
