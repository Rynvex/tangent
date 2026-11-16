package httpapi_test

import (
	"net/http"
)

// p3b walks the B10 part B routes on an engine of its own: a diverge into
// three branches, a comparison that is decided, one whose job fails, and
// the refusals.
func (f *flow) p3b() *harness {
	h := newHarness(f.t)
	g := &flow{harness: h, s: f.s}
	g.main = g.ok(http.StatusCreated, g.do(http.MethodPost, "/lines", map[string]any{"title": "Linked lists", "provider": "fake", "model": "fake-1"}))["id"].(string)
	g.reply = g.turn(g.main, "Implement a singly linked list in Rust three ways")
	g.call("diverge", http.StatusAccepted, http.MethodPost, "/lines/"+g.main+"/diverge", map[string]any{"anchorMessageId": g.reply, "count": 3})
	g.dispatcher.Wait()
	g.call("branches.list.diverged", http.StatusOK, http.MethodGet, "/lines/"+g.main+"/branches", nil)
	ids := g.divergedBranches(g.main)
	third := g.thirdDirection()
	for _, id := range ids {
		g.turn(id, "How does this one look?")
	}
	g.turn(third, "Too tricky [fake:job-error]")
	created := g.call("converge", http.StatusCreated, http.MethodPost, "/lines/"+g.main+"/converge", map[string]any{"lineIds": ids, "criteria": []string{"Safety", "Speed"}})
	g.dispatcher.Wait()
	failing := g.ok(http.StatusCreated, g.do(http.MethodPost, "/lines/"+g.main+"/converge", map[string]any{"lineIds": []string{ids[1], third}}))
	g.dispatcher.Wait()
	id := field(created, "comparison", "id").(string)
	g.call("comparisons.get", http.StatusOK, http.MethodGet, "/comparisons/"+id, nil)
	g.call("comparisons.list", http.StatusOK, http.MethodGet, "/lines/"+g.main+"/comparisons", nil)
	g.fail("error.comparison_not_ready", http.StatusConflict, http.MethodPost, "/comparisons/"+field(failing, "comparison", "id").(string)+"/decide", map[string]any{"lineId": third})
	g.call("comparisons.decide", http.StatusOK, http.MethodPost, "/comparisons/"+id+"/decide", map[string]any{"lineId": ids[0]})
	g.fail("error.comparison_decided", http.StatusConflict, http.MethodPost, "/comparisons/"+id+"/decide", map[string]any{"lineId": ids[0]})
	g.fail("error.invalid_comparison", http.StatusUnprocessableEntity, http.MethodPost, "/lines/"+g.main+"/converge", map[string]any{"lineIds": []string{ids[0]}})
	g.fail("error.comparison_not_found", http.StatusNotFound, http.MethodGet, "/comparisons/"+unknownID, nil)
	return h
}

// thirdDirection is the line of the diverge's third direction.
func (f *flow) thirdDirection() string {
	outline := f.ok(http.StatusOK, f.do(http.MethodGet, "/lines/"+f.main+"/branches", nil))
	for _, b := range outline["branches"].([]any) {
		if b := b.(map[string]any); b["purpose"] == "Direction 3 (fake runner)" {
			return b["lineId"].(string)
		}
	}
	f.t.Fatalf("no third direction: %v", outline)
	return ""
}
