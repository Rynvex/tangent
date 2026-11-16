package httpapi_test

import (
	"net/http"

	"github.com/Rynvex/tangent/tangent"
)

// p2c walks the B9 part C routes on an engine of its own with group in
// suggest mode: the suggestions a discard raises (accepted as a group and
// as a combine), the group routes, a direct combine and a summary that
// fails (job.failed).
func (f *flow) p2c() *harness {
	h := newHarness(f.t, func(c *harnessConfig) {
		c.features = append(without(c.features, tangent.FeatureGroup), tangent.Group(tangent.ModeSuggest), tangent.Fisheye())
	})
	g := &flow{harness: h, s: f.s}
	g.main = g.ok(http.StatusCreated, g.do(http.MethodPost, "/lines", map[string]any{"title": "Home server", "provider": "fake", "model": "fake-1"}))["id"].(string)
	g.turn(g.main, "Which disks for the home server?")
	g.reply = g.turn(g.main, "And the case?")
	a := g.harness.endedBranch(g.main, g.reply, "New disks")
	g.harness.endedBranch(g.main, g.reply, "Used disks")
	for _, purpose := range []string{"Four-bay case", "Six-bay case"} {
		g.turn(g.harness.branch(g.main, g.reply, purpose), "Is it quiet?")
	}
	g.harness.endedBranch(g.main, g.reply, "Cables")
	g.dispatcher.Wait()
	g.stableCall("suggestions.list.group", http.MethodGet, "/lines/"+g.main+"/suggestions", nil)
	ended, open := g.groupSuggestions()
	g.stableCall("suggestions.accept.group", http.MethodPost, "/suggestions/"+ended+"/accept", map[string]any{"choices": map[string]any{"c1": "keepBoth"}})
	g.stableCall("suggestions.accept.combine", http.MethodPost, "/suggestions/"+open+"/accept", map[string]any{"action": "combine", "purpose": "Pick the case"})
	g.dispatcher.Wait()
	g.p2cGroups(a)
	g.p2cCombine()
	return h
}

// groupSuggestions are the open group suggestions of ended and of open
// branches.
func (f *flow) groupSuggestions() (ended, open string) {
	f.t.Helper()
	list := f.ok(http.StatusOK, f.do(http.MethodGet, "/lines/"+f.main+"/suggestions", nil))
	for _, s := range list["suggestions"].([]any) {
		s := s.(map[string]any)
		if s["kind"] != tangent.SuggestionKindGroup {
			continue
		}
		members := s["payload"].(map[string]any)["members"].([]any)
		if members[0].(map[string]any)["ended"] == true {
			ended = s["id"].(string)
		} else {
			open = s["id"].(string)
		}
	}
	if ended == "" || open == "" {
		f.t.Fatalf("two group suggestions: %v", list)
	}
	return ended, open
}

func (f *flow) p2cGroups(free string) {
	other := f.harness.endedBranch(f.main, f.reply, "Power supply")
	created := f.call("groups.create", http.StatusCreated, http.MethodPost, "/lines/"+f.main+"/groups", map[string]any{
		"memberLineIds": []string{free, other}, "title": "Parts",
		"conflicts": []map[string]any{{"branch": map[string]any{"lineId": free, "claim": "new disks"}, "other": map[string]any{"lineId": other, "claim": "a 500W supply"}, "choice": "keepBoth"}},
	})
	f.fail("error.invalid_group", http.StatusUnprocessableEntity, http.MethodPost, "/lines/"+f.main+"/groups", map[string]any{"memberLineIds": []string{free}, "title": "One"})
	f.dispatcher.Wait()
	id := field(created, "group", "id").(string)
	f.call("groups.list", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/groups", nil)
	f.call("groups.get", http.StatusOK, http.MethodGet, "/groups/"+id, nil)
	f.call("groups.rename", http.StatusOK, http.MethodPatch, "/groups/"+id, map[string]any{"title": "Server parts"})
	f.call("groups.summarize", http.StatusAccepted, http.MethodPost, "/groups/"+id+"/summarize", nil)
	f.dispatcher.Wait()
	f.call("preview.group", http.StatusOK, http.MethodPost, "/lines/"+f.main+"/preview", map[string]any{"content": "So?"})
	f.call("groups.dissolve", http.StatusOK, http.MethodPost, "/groups/"+id+"/dissolve", nil)
	f.fail("error.group_not_active", http.StatusConflict, http.MethodPost, "/groups/"+id+"/dissolve", nil)
	broken1 := f.harness.branch(f.main, f.reply, "Broken one")
	f.turn(broken1, "x")
	f.ok(http.StatusOK, f.do(http.MethodPost, "/lines/"+broken1+"/branch/discard", map[string]any{"leaf": map[string]any{"line": "[fake:job-error] cannot summarise"}}))
	broken2 := f.harness.endedBranch(f.main, f.reply, "Broken two")
	f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines/"+f.main+"/groups", map[string]any{"memberLineIds": []string{broken1, broken2}, "title": "Broken"}))
	f.dispatcher.Wait()
}

func (f *flow) p2cCombine() {
	x, y := f.harness.branch(f.main, f.reply, "Router A"), f.harness.branch(f.main, f.reply, "Router B")
	onX := f.turn(x, "Wi-Fi 6?")
	f.turn(y, "Wi-Fi 7?")
	f.harness.branch(x, onX, "Mesh for Router A")
	f.call("branches.combine", http.StatusCreated, http.MethodPost, "/lines/"+f.main+"/branches/combine", map[string]any{
		"lineIds": []string{x, y}, "purpose": "Pick the router",
		"conflicts": []map[string]any{{"branch": map[string]any{"lineId": x, "claim": "Wi-Fi 6 is enough"}, "other": map[string]any{"lineId": y, "claim": "Wi-Fi 7 lasts longer"}, "choice": "adoptOther"}},
	})
}

// stableCall is call (200) with the suggestions' target keys made stable.
func (f *flow) stableCall(name, method, path string, body any) {
	f.t.Helper()
	r := f.do(method, path, body)
	f.ok(http.StatusOK, r)
	f.s.route(name, method, path, body, fromToTarget(f.t, r))
}
