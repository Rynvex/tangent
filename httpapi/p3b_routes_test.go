package httpapi_test

import (
	"net/http"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

// p3bSeed diverges the main line's first reply into two branches and
// compares them (the comparison is ready). It runs the jobs on the
// harness's own dispatcher, so a test that wraps the API's still seeds.
func (h *harness) p3bSeed(s *seeded) {
	h.t.Helper()
	scope := tangent.Scope{Tenant: tenantA, Actor: actor}
	job, err := h.engine.StartDiverge(h.ctx, scope, s.main, tangent.DivergeInput{AnchorMessageID: s.reply, Count: 2})
	if err != nil {
		h.t.Fatal(err)
	}
	h.runJob(job)
	ids := h.divergedBranches(s.main)
	s.diverged1, s.diverged2 = ids[0], ids[1]
	started, err := h.engine.Converge(h.ctx, scope, s.main, tangent.ConvergeInput{LineIDs: ids})
	if err != nil {
		h.t.Fatal(err)
	}
	h.runJob(started.Job)
	s.comparison = started.Comparison.ID
}

// runJob runs a job on the harness's dispatcher and waits for it.
func (h *harness) runJob(job tangent.Job) {
	h.t.Helper()
	if err := h.dispatcher.DispatchJob(h.ctx, job); err != nil {
		h.t.Fatal(err)
	}
	h.dispatcher.Wait()
}

// divergedBranches are the ids of the line's diverged branches, by purpose.
func (h *harness) divergedBranches(lineID string) []string {
	h.t.Helper()
	outline := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+lineID+"/branches", nil))
	byPurpose := map[string]string{}
	for _, b := range outline["branches"].([]any) {
		b := b.(map[string]any)
		if b["origin"] == "diverge" {
			byPurpose[b["purpose"].(string)] = b["lineId"].(string)
		}
	}
	first, second := byPurpose["Direction 1 (fake runner)"], byPurpose["Direction 2 (fake runner)"]
	if first == "" || second == "" {
		h.t.Fatalf("the diverge opened two branches: %v", outline)
	}
	return []string{first, second}
}

// p3bRoutes are the B10 part B routes: diverge, converge and decide.
func p3bRoutes(s seeded) []routeCase {
	line, comparison := "/lines/"+s.main, "/comparisons/"+s.comparison
	return []routeCase{
		{name: "diverge", method: "POST", path: line + "/diverge", body: map[string]any{"anchorMessageId": s.reply, "count": 2}, write: true, lineScoped: true,
			feature: tangent.FeatureDiverge, bad: badRequest{body: map[string]any{"anchorMessageId": s.reply, "count": 9}, status: 400, code: "invalid_input"}},
		{name: "converge", method: "POST", path: line + "/converge", body: map[string]any{"lineIds": []string{s.diverged1, s.diverged2}}, write: true, lineScoped: true,
			feature: tangent.FeatureDiverge, bad: badRequest{body: map[string]any{"lineIds": []string{s.diverged1}}, status: 422, code: "invalid_comparison"}},
		{name: "list comparisons", method: "GET", path: line + "/comparisons", lineScoped: true, feature: tangent.FeatureDiverge,
			bad: badRequest{path: "/lines/not-a-uuid/comparisons", status: 404, code: "line_not_found"}},
		{name: "get comparison", method: "GET", path: comparison, lineScoped: true, feature: tangent.FeatureDiverge,
			bad: badRequest{path: "/comparisons/x", status: 404, code: "comparison_not_found"}},
		{name: "decide", method: "POST", path: comparison + "/decide", body: map[string]any{"lineId": s.diverged1}, write: true, lineScoped: true,
			feature: tangent.FeatureDiverge, bad: badRequest{body: map[string]any{"lineId": s.main}, status: 422, code: "invalid_comparison"}},
	}
}

func TestP3bRoutes_DecideEndsTheOthers(t *testing.T) {
	h := newHarness(t)
	s := h.seed()
	decided := h.ok(http.StatusOK, h.do(http.MethodPost, "/comparisons/"+s.comparison+"/decide", map[string]any{"lineId": s.diverged2, "line": "Two it is"}))
	if field(decided, "decision", "line") != "Two it is" || field(decided, "comparison", "status") != "decided" || len(decided["discarded"].([]any)) != 1 {
		t.Fatalf("decided = %v", decided)
	}
	h.wantError(h.do(http.MethodPost, "/comparisons/"+s.comparison+"/decide", map[string]any{"lineId": s.diverged2}), http.StatusConflict, "comparison_decided")
	h.wantError(h.do(http.MethodPost, "/lines/"+s.main+"/converge", map[string]any{"lineIds": []string{s.diverged1, s.diverged2}}), http.StatusConflict, "branch_closed")
	h.wantError(h.do(http.MethodPost, "/lines/"+s.main+"/diverge", map[string]any{"anchorMessageId": s.main, "count": 2}), http.StatusNotFound, "anchor_not_found")
}
