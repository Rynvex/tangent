package httpapi_test

import (
	"net/http"
	"strings"

	"github.com/Rynvex/tangent/tangent"
)

// p1 walks the B8 routes: the suggestion inbox (the probe raises them),
// leaves and seeds, with their error answers.
func (f *flow) p1() {
	f.p1Suggestions()
	f.p1Leaves()
	f.p1Seeds()
}

func (f *flow) p1Suggestions() {
	f.turn(f.main, "Any structural advice? "+tangent.ProbeDirective)
	list := f.call("suggestions.list", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/suggestions", nil)
	id := list["suggestions"].([]any)[0].(map[string]any)["id"].(string)
	f.call("suggestions.accept", http.StatusOK, http.MethodPost, "/suggestions/"+id+"/accept", map[string]any{})
	f.fail("error.suggestion_not_open", http.StatusConflict, http.MethodPost, "/suggestions/"+id+"/dismiss", nil)
	branch := f.branch2("Ask the probe again")
	f.turn(branch, "And here? "+tangent.ProbeDirective)
	open := f.ok(http.StatusOK, f.do(http.MethodGet, "/lines/"+f.main+"/suggestions", nil))["suggestions"].([]any)
	f.call("suggestions.dismiss", http.StatusOK, http.MethodPost, "/suggestions/"+open[0].(map[string]any)["id"].(string)+"/dismiss", nil)
	f.call("suggestions.list.all", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/suggestions?status=all", nil)
}

func (f *flow) p1Leaves() {
	branch := f.branch2("Check ryokan prices")
	f.turn(branch, "How much is a night?")
	f.call("leaf.get.none", http.StatusOK, http.MethodGet, "/lines/"+branch+"/leaf", nil)
	f.call("leaf.draft", http.StatusAccepted, http.MethodPost, "/lines/"+branch+"/leaf/draft", nil)
	f.dispatcher.Wait()
	f.call("leaf.get", http.StatusOK, http.MethodGet, "/lines/"+branch+"/leaf", nil)
	f.call("leaf.put", http.StatusOK, http.MethodPut, "/lines/"+branch+"/leaf", map[string]any{
		"kind": "answer", "line": "About 30,000 yen a night with dinner", "body": "Cheaper midweek.",
	})
	f.fail("error.invalid_leaf", http.StatusUnprocessableEntity, http.MethodPut, "/lines/"+branch+"/leaf", map[string]any{"kind": "maybe", "line": strings.Repeat("x", 201)})
	f.call("leaf.delete", http.StatusNoContent, http.MethodDelete, "/lines/"+branch+"/leaf", nil)
	f.call("branch.discard.leaf", http.StatusOK, http.MethodPost, "/lines/"+branch+"/branch/discard", map[string]any{
		"leaf": map[string]any{"line": "Too expensive for this trip"},
	})
	failing := f.branch2("A draft that fails")
	f.turn(failing, "Please [fake:job-error] the leaf")
	f.ok(http.StatusAccepted, f.do(http.MethodPost, "/lines/"+failing+"/leaf/draft", nil))
	f.dispatcher.Wait()
	f.call("leaf.get.draft_error", http.StatusOK, http.MethodGet, "/lines/"+failing+"/leaf", nil)
	for _, ev := range f.events.OfType(tangent.EventLeafChanged) {
		if ev.Data.(tangent.LeafChange).DraftError != nil {
			f.s.write("event.leaf.changed.draft_error", ev)
			return
		}
	}
	f.t.Fatal("no leaf.changed with a draftError")
}

func (f *flow) p1Seeds() {
	created := f.call("seeds.create", http.StatusCreated, http.MethodPost, "/lines/"+f.main+"/seeds", map[string]any{
		"text": "Is a rail pass worth it?", "anchorMessageId": f.reply,
	})
	seed := created["seed"].(map[string]any)["id"].(string)
	noted := f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines/"+f.main+"/seeds", map[string]any{"text": "Check the visa rules"}))
	dropped := f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines/"+f.main+"/seeds", map[string]any{"text": "Maybe Osaka too"}))
	f.call("seeds.list", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/seeds", nil)
	f.turn(f.main, "One more probe "+tangent.ProbeDirective)
	f.call("lines.get.inbox", http.StatusOK, http.MethodGet, "/lines/"+f.main, nil)
	f.call("seeds.expand", http.StatusCreated, http.MethodPost, "/seeds/"+seed+"/expand", map[string]any{})
	f.call("seeds.to_note", http.StatusCreated, http.MethodPost, "/seeds/"+noted["seed"].(map[string]any)["id"].(string)+"/to-note", map[string]any{})
	f.call("seeds.drop", http.StatusOK, http.MethodPost, "/seeds/"+dropped["seed"].(map[string]any)["id"].(string)+"/drop", nil)
	f.fail("error.seed_not_open", http.StatusConflict, http.MethodPost, "/seeds/"+seed+"/drop", nil)
	f.call("seeds.list.all", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/seeds?status=all", nil)
}

// p1b walks the B8 part B routes: both spinoff modes, the links and a
// rebalance suggestion accepted as a spinoff.
func (f *flow) p1b() {
	f.call("spinoff.preview", http.StatusOK, http.MethodPost, "/lines/"+f.main+"/spinoff/preview", map[string]any{
		"mode": "fresh", "atMessageId": f.firstReply(), "copyNotes": true,
	})
	f.call("spinoff.fresh", http.StatusCreated, http.MethodPost, "/lines/"+f.main+"/spinoff", map[string]any{
		"mode": "fresh", "atMessageId": f.firstReply(), "title": "Kyoto, the short version", "copyNotes": true,
	})
	day := f.branch2("Day trips")
	f.turn(day, "Nara or Uji?")
	f.call("spinoff.detach", http.StatusCreated, http.MethodPost, "/lines/"+day+"/spinoff", map[string]any{"mode": "detach", "title": "Day trips from Kyoto"})
	f.call("links.list", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/links", nil)
	rail := f.branch2("Rail route")
	for _, q := range []string{"Shinkansen?", "Which pass?", "Reserved seats?", "Luggage?", "Night trains?"} {
		f.turn(rail, q)
	}
	list := f.call("suggestions.list.rebalance", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/suggestions", nil)
	id := ""
	for _, s := range list["suggestions"].([]any) {
		if s.(map[string]any)["kind"] == tangent.SuggestionKindRebalance {
			id = s.(map[string]any)["id"].(string)
		}
	}
	if id == "" {
		f.t.Fatalf("no rebalance suggestion: %v", list)
	}
	f.call("suggestions.accept.spinoff", http.StatusOK, http.MethodPost, "/suggestions/"+id+"/accept", map[string]any{"action": "spinoff", "title": "Rail route"})
}
