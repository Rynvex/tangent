package httpapi_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

// mainMessages are the ids of a line's messages in order.
func (h *harness) mainMessages(lineID string) []string {
	h.t.Helper()
	page := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+lineID+"/messages", nil))
	ids := []string{}
	for _, m := range page["messages"].([]any) {
		ids = append(ids, m.(map[string]any)["id"].(string))
	}
	return ids
}

// p3Seed tags the main line's first reply and folds its first exchange;
// the second exchange is left to fold.
func (h *harness) p3Seed(s *seeded) {
	h.t.Helper()
	ids := h.mainMessages(s.main)
	h.ok(http.StatusOK, h.do(http.MethodPut, "/messages/"+s.reply+"/tag", map[string]any{"kind": "idea"}))
	created := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+s.main+"/folds", map[string]any{"fromMessageId": ids[0], "toMessageId": ids[1], "summary": "The first exchange."}))
	s.fold = field(created, "fold", "id").(string)
	s.firstMessage, s.secondQuestion, s.secondReply = ids[0], ids[2], ids[3]
}

// p3Routes are the B10 part A routes: argument tags and folds.
func p3Routes(s seeded) []routeCase {
	line, tag := "/lines/"+s.main, "/messages/"+s.reply+"/tag"
	return []routeCase{
		{name: "tag message", method: "PUT", path: tag, body: map[string]any{"kind": "question"}, write: true, lineScoped: true, feature: tangent.FeatureIbis,
			bad: badRequest{body: map[string]any{"kind": "nope"}, status: 400, code: "invalid_input"}},
		{name: "untag message", method: "DELETE", path: tag, write: true, lineScoped: true, feature: tangent.FeatureIbis,
			bad: badRequest{path: "/messages/x/tag", status: 404, code: "message_not_found"}},
		{name: "list folds", method: "GET", path: line + "/folds", lineScoped: true, feature: tangent.FeatureFold,
			bad: badRequest{path: "/lines/not-a-uuid/folds", status: 404, code: "line_not_found"}},
		{name: "create fold", method: "POST", path: line + "/folds", body: map[string]any{"fromMessageId": s.secondQuestion, "toMessageId": s.secondReply, "summary": "The second exchange."},
			write: true, lineScoped: true, feature: tangent.FeatureFold,
			bad: badRequest{body: map[string]any{"fromMessageId": s.firstMessage, "toMessageId": s.secondQuestion, "summary": "x"}, status: 409, code: "fold_overlap"}},
		{name: "update fold", method: "PATCH", path: "/folds/" + s.fold, body: map[string]any{"summary": "Edited by hand."}, write: true, lineScoped: true, feature: tangent.FeatureFold,
			bad: badRequest{body: map[string]any{"summary": " "}, status: 400, code: "invalid_input"}},
		{name: "delete fold", method: "DELETE", path: "/folds/" + s.fold, write: true, lineScoped: true, feature: tangent.FeatureFold,
			bad: badRequest{path: "/folds/x", status: 404, code: "fold_not_found"}},
	}
}

func TestP3Routes_BodiesAreChecked(t *testing.T) {
	h := newHarness(t)
	s := h.seed()
	ids := h.mainMessages(s.main)
	h.wantError(h.do(http.MethodPut, "/messages/"+s.reply+"/tag", nil), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodPost, "/lines/"+s.main+"/folds", map[string]any{"fromMessageId": ids[2], "toMessageId": ids[2], "summary": "x"}), http.StatusUnprocessableEntity, "invalid_fold")
	h.wantError(h.do(http.MethodPost, "/lines/"+s.main+"/folds", map[string]any{"fromMessageId": ids[2], "toMessageId": ids[3], "summary": strings.Repeat("s", 1001)}), http.StatusUnprocessableEntity, "too_long")
	h.wantError(h.do(http.MethodPost, "/lines/"+s.main+"/folds", map[string]any{"fromMessageId": "x", "toMessageId": ids[3]}), http.StatusNotFound, "message_not_found")
	drafted := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+s.main+"/folds", map[string]any{"fromMessageId": ids[2], "toMessageId": ids[3]}))
	if field(drafted, "fold", "status") != "drafting" || field(drafted, "job", "kind") != tangent.JobKindFoldSummary {
		t.Fatalf("drafted = %v", drafted)
	}
	h.dispatcher.Wait()
	list := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+s.main+"/folds", nil))
	folds := list["folds"].([]any)
	if len(folds) != 2 || folds[1].(map[string]any)["status"] != "active" || field(list, "limits", "maxActivePerLine") != float64(50) {
		t.Fatalf("the dispatcher ran the draft: %v", list)
	}
	h.ok(http.StatusNoContent, h.do(http.MethodDelete, "/folds/"+s.fold, nil))
	h.wantError(h.do(http.MethodDelete, "/folds/"+s.fold, nil), http.StatusNotFound, "fold_not_found")
}

func TestP3Routes_ADraftTheDispatcherRefusesFailsTheFold(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) {
		c.wrap = func(d tangent.Dispatcher) tangent.Dispatcher { return refusing{Dispatcher: d, jobs: true} }
	})
	main := h.line()
	h.turn(main, "q")
	ids := h.mainMessages(main)
	h.wantError(h.do(http.MethodPost, "/lines/"+main+"/folds", map[string]any{"fromMessageId": ids[0], "toMessageId": ids[1]}), http.StatusServiceUnavailable, "unavailable")
	list := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/folds", nil))
	folds := list["folds"].([]any)
	if len(folds) != 1 || folds[0].(map[string]any)["status"] != "failed" {
		t.Fatalf("the refused draft is failed: %v", list)
	}
}
