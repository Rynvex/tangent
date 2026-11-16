package httpapi_test

import (
	"net/http"
	"strings"
	"testing"
)

func TestFeatures_RoutesOfUnconfiguredFeaturesAreNotMounted(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) { c.features = nil })
	s := seededCore(h)
	for _, rc := range routeTable(s) {
		if rc.feature == "" {
			continue
		}
		h.wantError(h.do(rc.method, rc.path, rc.body), http.StatusNotFound, "not_found")
	}
	caps := h.ok(http.StatusOK, h.do(http.MethodGet, "/capabilities", nil))
	for _, f := range caps["features"].([]any) {
		if f.(map[string]any)["enabled"] != false {
			t.Fatalf("nothing is enabled: %v", caps)
		}
	}
	// Core routes keep working, and the feature inputs of core routes are refused.
	h.wantError(h.do(http.MethodPost, "/lines/"+s.main+"/branches", map[string]any{"anchorMessageId": s.reply, "purpose": "q", "kind": "aside"}),
		http.StatusNotFound, "feature_disabled")
	h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+s.main+"/branches", map[string]any{"anchorMessageId": s.reply, "purpose": "q", "kind": "alternative"}))
	h.wantError(h.do(http.MethodPost, "/lines/"+s.branch+"/branch/discard", map[string]any{"leaf": map[string]any{"line": "dead end"}}),
		http.StatusNotFound, "feature_disabled")
	h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+s.branch+"/branch/discard", map[string]any{}))
}

func TestFeatures_APolicyThatSwitchesAFeatureOffAnswersFeatureDisabled(t *testing.T) {
	h := newHarness(t)
	s := h.seed()
	mine := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines", map[string]any{"title": "off"}, as(tenantOff)))["id"].(string)
	reply := h.ok(http.StatusAccepted, h.do(http.MethodPost, "/lines/"+mine+"/messages", map[string]any{"content": "q"}, as(tenantOff)))["turnId"].(string)
	h.dispatcher.Wait()
	branch := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+mine+"/branches", map[string]any{"anchorMessageId": reply, "purpose": "p", "kind": "investigate"}, as(tenantOff)))
	branchID := field(branch, "line", "id").(string)
	paths := map[string]string{s.main: mine, s.branch: branchID}
	for _, rc := range routeTable(s) {
		if rc.feature == "" {
			continue
		}
		path := rc.path
		for from, to := range paths {
			path = strings.ReplaceAll(path, from, to)
		}
		r := h.do(rc.method, path, rc.body, as(tenantOff))
		h.wantError(r, http.StatusNotFound, "feature_disabled")
		if r.json(t)["feature"] != rc.feature {
			t.Errorf("%s: the refusal names the feature: %s", rc.name, r.raw)
		}
	}
	caps := h.ok(http.StatusOK, h.do(http.MethodGet, "/capabilities", nil, as(tenantOff)))
	if field(caps, "features") == nil || caps["features"].([]any)[0].(map[string]any)["enabled"] != false {
		t.Fatalf("capabilities follow the policy: %v", caps)
	}
	merge := map[string]any{
		"card": map[string]any{"question": "q", "conclusion": "c"}, "parentTipMessageId": reply,
		"noteChanges": []map[string]any{{"op": "add", "section": "fact", "text": "x"}},
	}
	h.wantError(h.do(http.MethodPost, "/lines/"+branchID+"/branch/merge", merge, as(tenantOff)), http.StatusNotFound, "feature_disabled")
}

// seededCore is a main line with an exchange, for engines without features.
func seededCore(h *harness) seeded {
	h.t.Helper()
	s := seeded{main: h.line()}
	s.reply = h.turn(s.main, "q")
	s.branch = h.branch(s.main, s.reply, "b")
	s.note, s.milestone, s.suggestion, s.seed, s.relation = unknownID, unknownID, unknownID, unknownID, unknownID
	s.group, s.free1, s.free2, s.open2 = unknownID, unknownID, unknownID, unknownID
	s.fold, s.firstMessage, s.secondQuestion, s.secondReply = unknownID, unknownID, unknownID, unknownID
	s.diverged1, s.diverged2, s.comparison = unknownID, unknownID, unknownID
	s.arena, s.arenaReply = s.main, s.reply
	s.aside, s.discarded = unknownID, unknownID
	s.term = unknownID
	return s
}
