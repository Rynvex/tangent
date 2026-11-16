package httpapi_test

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/tangent"
)

// p2 walks the B9 part A routes on the main flow's engine (goal and
// relations in manual mode): the goal and the propose button, relations,
// pins and open loops, with their error answers.
func (f *flow) p2() {
	f.p2Goal()
	f.p2Relations()
	f.call("messages.pin", http.StatusOK, http.MethodPost, "/messages/"+f.firstReply()+"/pin", nil)
	f.call("messages.unpin", http.StatusOK, http.MethodDelete, "/messages/"+f.firstReply()+"/pin", nil)
	stale := f.branch2("Book the ryokan")
	if _, err := f.pool.Exec(f.ctx, `UPDATE tangent_line SET last_activity_at = now() - interval '5 days' WHERE id = $1`, stale); err != nil {
		f.t.Fatal(err)
	}
	f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines/"+f.main+"/notes", map[string]any{"section": "to_confirm", "text": "Is the ryokan refundable?"}))
	f.call("open_loops.list", http.StatusOK, http.MethodGet, "/open-loops", nil)
	f.call("open_loops.root", http.StatusOK, http.MethodGet, "/open-loops?root="+f.main+"&staleDays=4", nil)
}

func (f *flow) p2Goal() {
	goal := "/lines/" + f.main + "/goal"
	f.call("goal.get.none", http.StatusOK, http.MethodGet, goal, nil)
	f.call("goal.put", http.StatusOK, http.MethodPut, goal, map[string]any{"text": "Plan a week in Kyoto in spring"})
	f.call("goal.get", http.StatusOK, http.MethodGet, goal, nil)
	f.call("goal.propose", http.StatusAccepted, http.MethodPost, goal+"/propose", nil)
	f.dispatcher.Wait()
	id := f.suggestionOf(f.main, tangent.SuggestionKindGoalPropose)
	f.call("suggestions.accept.goal", http.StatusOK, http.MethodPost, "/suggestions/"+id+"/accept", map[string]any{})
	f.call("goal.delete", http.StatusNoContent, http.MethodDelete, goal, nil)
	f.fail("error.goal_not_found", http.StatusNotFound, http.MethodDelete, goal, nil)
}

func (f *flow) p2Relations() {
	other := f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines", map[string]any{"title": "Osaka side trip", "provider": "fake", "model": "fake-1"}))["id"].(string)
	body := map[string]any{"fromMessageId": f.firstReply(), "toLineId": other, "label": "Same trip, another city"}
	created := f.call("relations.create", http.StatusCreated, http.MethodPost, "/lines/"+f.main+"/relations", body)
	f.fail("error.relation_exists", http.StatusConflict, http.MethodPost, "/lines/"+f.main+"/relations", body)
	f.call("relations.list", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/relations", nil)
	f.call("links.list.relations", http.StatusOK, http.MethodGet, "/lines/"+other+"/links", nil)
	id := field(created, "relation", "id").(string)
	f.call("relations.update", http.StatusOK, http.MethodPatch, "/lines/"+f.main+"/relations/"+id, map[string]any{"label": "Same trip, Osaka for a day"})
	f.call("relations.delete", http.StatusNoContent, http.MethodDelete, "/lines/"+f.main+"/relations/"+id, nil)
	f.fail("error.relation_not_found", http.StatusNotFound, http.MethodDelete, "/lines/"+f.main+"/relations/"+id, nil)
	for _, ev := range f.events.OfType(tangent.EventLinkChanged) {
		if ev.Data.(tangent.LinkChange).Deleted {
			f.s.write("event.link.changed.deleted", ev)
			return
		}
	}
	f.t.Fatal("no link.changed for a deleted relation")
}

// suggestionOf is the id of the open suggestion of a kind in the line's inbox.
func (f *flow) suggestionOf(line, kind string) string {
	f.t.Helper()
	list := f.ok(http.StatusOK, f.do(http.MethodGet, "/lines/"+line+"/suggestions", nil))
	for _, s := range list["suggestions"].([]any) {
		if s.(map[string]any)["kind"] == kind {
			return s.(map[string]any)["id"].(string)
		}
	}
	f.t.Fatalf("no %s suggestion: %v", kind, list)
	return ""
}

// p2Suggest walks what goal and relations raise by themselves in suggest
// mode, on an engine of its own (so the main flow's inbox stays as it
// was): the goal after the second reply, a drift and a relation, each
// accepted.
func (f *flow) p2Suggest() *harness {
	h := newHarness(f.t, func(c *harnessConfig) {
		c.features = append(without(c.features, tangent.FeatureGoal, tangent.FeatureRelations), tangent.Goal(tangent.ModeSuggest), tangent.Relations(tangent.ModeSuggest))
	})
	g := &flow{harness: h, s: f.s}
	g.main = g.ok(http.StatusCreated, g.do(http.MethodPost, "/lines", map[string]any{"title": "Kyoto trip", "provider": "fake", "model": "fake-1"}))["id"].(string)
	g.turn(g.main, "I want to plan a trip to Kyoto.")
	g.turn(g.main, "Which month is best?")
	g.dispatcher.Wait()
	g.ok(http.StatusOK, g.do(http.MethodPost, "/suggestions/"+g.suggestionOf(g.main, tangent.SuggestionKindGoalPropose)+"/accept", map[string]any{"text": "Plan a Kyoto trip"}))
	g.turn(g.main, "Where should we stay?")
	g.turn(g.main, "By the way, the best ramen in Tokyo? "+fake.DirectiveDrift)
	g.dispatcher.Wait()
	g.call("suggestions.list.p2", http.StatusOK, http.MethodGet, "/lines/"+g.main+"/suggestions", nil)
	g.call("suggestions.accept.drift", http.StatusOK, http.MethodPost, "/suggestions/"+g.suggestionOf(g.main, tangent.SuggestionKindDrift)+"/accept", map[string]any{})
	g.branch2("Hotel prices")
	ryokan := g.branch2("Ryokan prices")
	g.turn(ryokan, "How much is a night?")
	g.ok(http.StatusOK, g.do(http.MethodPost, "/lines/"+ryokan+"/branch/discard", map[string]any{"leaf": map[string]any{"line": "Too expensive"}}))
	g.dispatcher.Wait()
	path := "/suggestions/" + g.suggestionOf(g.main, tangent.SuggestionKindRelation) + "/accept"
	r := g.do(http.MethodPost, path, map[string]any{})
	g.ok(http.StatusOK, r)
	g.s.route("suggestions.accept.relation", http.MethodPost, path, map[string]any{}, fromToTarget(g.t, r))
	return h
}

// fromToTarget rewrites the target keys of relation and group
// suggestions in a response from their payloads, in payload order: the
// keys name lines in id order, which differs from run to run (clients treat
// them as opaque).
func fromToTarget(t *testing.T, r response) response {
	t.Helper()
	var body any
	if err := json.Unmarshal(r.raw, &body); err != nil {
		t.Fatal(err)
	}
	stableTargets(body)
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r.raw = raw
	return r
}

func stableTargets(v any) {
	switch node := v.(type) {
	case []any:
		for _, item := range node {
			stableTargets(item)
		}
	case map[string]any:
		if key, ok := node["targetKey"].(string); ok {
			node["targetKey"] = stableTarget(key, node["payload"])
		}
		for _, child := range node {
			stableTargets(child)
		}
	}
}

func stableTarget(key string, payload any) string {
	p, _ := payload.(map[string]any)
	switch {
	case strings.HasPrefix(key, "relation:") && p != nil:
		return "relation:" + p["fromLineId"].(string) + ":" + p["toLineId"].(string)
	case strings.HasPrefix(key, "group:") && p != nil:
		ids := []string{}
		for _, m := range p["members"].([]any) {
			ids = append(ids, m.(map[string]any)["lineId"].(string))
		}
		return "group:" + strings.Join(ids, ",")
	}
	return key
}

// without drops the named features from a list.
func without(features []tangent.Feature, names ...string) []tangent.Feature {
	out := []tangent.Feature{}
	for _, f := range features {
		if !slices.Contains(names, f.Name()) {
			out = append(out, f)
		}
	}
	return out
}

// p2Fisheye records a preview with the fisheye context on, on an engine of
// its own (the main flow's prompts, and so its usage numbers, stay as
// they were).
func (f *flow) p2Fisheye() {
	h := newHarness(f.t, func(c *harnessConfig) { c.features = append(c.features, tangent.Fisheye()) })
	g := &flow{harness: h, s: f.s}
	g.main = g.ok(http.StatusCreated, g.do(http.MethodPost, "/lines", map[string]any{"title": "Kyoto trip", "provider": "fake", "model": "fake-1"}))["id"].(string)
	first := g.turn(g.main, "When should I go to Kyoto?")
	for _, q := range []string{"Where should I stay?", "How do I get around?", "What should I eat?", "Any day trips?", "What about temples?"} {
		g.turn(g.main, q)
	}
	g.ok(http.StatusOK, g.do(http.MethodPost, "/messages/"+first+"/pin", nil))
	osaka := g.branch2("Osaka side trip")
	g.turn(osaka, "Is Osaka worth a day?")
	g.ok(http.StatusOK, g.do(http.MethodPost, "/lines/"+osaka+"/branch/discard", map[string]any{"leaf": map[string]any{"line": "Too far for this trip"}}))
	g.call("preview.fisheye", http.StatusOK, http.MethodPost, "/lines/"+g.main+"/preview", map[string]any{"content": "So, the plan?"})
}
