package httpapi_test

import (
	"net/http"
	"strings"

	"github.com/Rynvex/tangent/tangent"
)

// endedBranch opens a branch on the reply, gives it an exchange and
// discards it with a leaf.
func (h *harness) endedBranch(main, reply, purpose string) string {
	h.t.Helper()
	id := h.branch(main, reply, purpose)
	h.turn(id, "about "+purpose)
	h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+id+"/branch/discard", map[string]any{"leaf": map[string]any{"kind": "decision", "line": purpose + " settled"}}))
	return id
}

// p2cSeed groups two ended branches and leaves two more ended ones and a
// second open branch.
func (h *harness) p2cSeed(s *seeded) {
	h.t.Helper()
	g1, g2 := h.endedBranch(s.main, s.reply, "grouped one"), h.endedBranch(s.main, s.reply, "grouped two")
	created := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+s.main+"/groups", map[string]any{"memberLineIds": []string{g1, g2}, "title": "Grouped"}))
	s.group = field(created, "group", "id").(string)
	s.free1, s.free2 = h.endedBranch(s.main, s.reply, "free one"), h.endedBranch(s.main, s.reply, "free two")
	s.open2 = h.branch(s.main, s.reply, "second open")
}

// p2cRoutes are the B9 part C routes: groups, combine and a relation's label.
func p2cRoutes(s seeded) []routeCase {
	line, group := "/lines/"+s.main, "/groups/"+s.group
	return []routeCase{
		{name: "list groups", method: "GET", path: line + "/groups", lineScoped: true, feature: tangent.FeatureGroup,
			bad: badRequest{path: line + "/groups?status=nope", status: 400, code: "invalid_input"}},
		{name: "create group", method: "POST", path: line + "/groups", body: map[string]any{"memberLineIds": []string{s.free1, s.free2}, "title": "Free"}, write: true,
			lineScoped: true, feature: tangent.FeatureGroup, bad: badRequest{body: map[string]any{"memberLineIds": []string{s.free1}, "title": "x"}, status: 422, code: "invalid_group"}},
		{name: "get group", method: "GET", path: group, lineScoped: true, feature: tangent.FeatureGroup,
			bad: badRequest{path: "/groups/x", status: 404, code: "group_not_found"}},
		{name: "rename group", method: "PATCH", path: group, body: map[string]any{"title": "Renamed"}, write: true, lineScoped: true, feature: tangent.FeatureGroup,
			bad: badRequest{body: map[string]any{"title": " "}, status: 400, code: "invalid_input"}},
		{name: "dissolve group", method: "POST", path: group + "/dissolve", write: true, lineScoped: true, feature: tangent.FeatureGroup,
			bad: badRequest{path: "/groups/" + unknownID + "/dissolve", status: 404, code: "group_not_found"}},
		{name: "summarize group", method: "POST", path: group + "/summarize", write: true, lineScoped: true, feature: tangent.FeatureGroup,
			bad: badRequest{path: "/groups/x/summarize", status: 404, code: "group_not_found"}},
		{name: "combine", method: "POST", path: line + "/branches/combine", body: map[string]any{"lineIds": []string{s.branch, s.open2}, "purpose": "together"}, write: true,
			lineScoped: true, feature: tangent.FeatureGroup, bad: badRequest{body: map[string]any{"lineIds": []string{s.branch}, "purpose": "x"}, status: 422, code: "invalid_group"}},
		{name: "update relation", method: "PATCH", path: line + "/relations/" + s.relation, body: map[string]any{"label": "renamed"}, write: true, lineScoped: true,
			feature: tangent.FeatureRelations, bad: badRequest{body: map[string]any{"label": strings.Repeat("l", 201)}, status: 422, code: "too_long"}},
	}
}
