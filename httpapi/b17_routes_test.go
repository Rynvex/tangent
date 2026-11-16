package httpapi_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

// b17Routes are the B17 routes: dismissing a tree's whole inbox and editing
// a merged branch's card.
func b17Routes(s seeded) []routeCase {
	return []routeCase{
		{name: "dismiss all suggestions", method: "POST", path: "/lines/" + s.main + "/suggestions/dismiss-all", write: true, lineScoped: true, feature: tangent.FeatureSuggestions,
			bad: badRequest{path: "/lines/not-a-uuid/suggestions/dismiss-all", status: 404, code: "line_not_found"}},
		{name: "update card", method: "PATCH", path: "/lines/" + s.branch + "/branch/card", body: map[string]any{"card": map[string]any{"question": "q", "conclusion": "c"}},
			write: true, lineScoped: true, bad: badRequest{body: map[string]any{"card": "text"}, status: 422, code: "invalid_card"}},
	}
}

func TestB17Routes_DismissAll(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	reply := h.turn(main, "first "+tangent.ProbeDirective)
	branch := h.branch(main, reply, "look")
	h.turn(branch, "second "+tangent.ProbeDirective)
	if got := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main, nil))["openSuggestions"]; got != float64(2) {
		t.Fatalf("two open suggestions: %v", got)
	}
	path := "/lines/" + branch + "/suggestions/dismiss-all"
	h.wantError(h.do(http.MethodPost, path, nil, readOnly()), http.StatusForbidden, "forbidden")
	h.wantError(h.do(http.MethodPost, path, `[1]`), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodPost, path, nil, as(tenantOff)), http.StatusNotFound, "feature_disabled")

	h.events.Reset()
	out := h.ok(http.StatusOK, h.do(http.MethodPost, path, map[string]any{}))
	dismissed := out["suggestions"].([]any)
	if out["rootLineId"] != main || len(dismissed) != 2 {
		t.Fatalf("dismiss-all = %v", out)
	}
	for _, s := range dismissed {
		if s.(map[string]any)["status"] != "dismissed" {
			t.Fatalf("dismissed = %v", s)
		}
	}
	if got := len(h.events.OfType(tangent.EventSuggestionChanged)); got != 2 || len(h.events.OfType(tangent.EventLineUpdated)) != 1 {
		t.Fatalf("events = %v", h.events.Types())
	}
	if got := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main, nil))["openSuggestions"]; got != float64(0) {
		t.Fatalf("no open suggestion left: %v", got)
	}

	h.events.Reset()
	r := h.do(http.MethodPost, path, nil)
	h.ok(http.StatusOK, r)
	if !strings.Contains(string(r.raw), `"suggestions":[]`) || len(h.events.Events()) != 0 {
		t.Fatalf("nothing open: %s, events %v", r.raw, h.events.Types())
	}
}

// mergedBranch opens a branch on a fresh main line, merges it with a card
// and returns the main line, the branch and the card message's id.
func (h *harness) mergedBranch() (string, string, string) {
	h.t.Helper()
	main := h.line()
	reply := h.turn(main, "which hotel?")
	branch := h.branch(main, reply, "hotels")
	h.turn(branch, "ryokan?")
	detail := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+branch+"/branch", nil))
	merged := h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+branch+"/branch/merge", map[string]any{
		"card": map[string]any{"question": "Which hotel?", "conclusion": "The business hotel"}, "parentTipMessageId": detail["parentTipMessageId"],
	}))
	return main, branch, field(merged, "message", "id").(string)
}

func TestB17Routes_UpdateCard(t *testing.T) {
	h := newHarness(t)
	main, branch, cardID := h.mergedBranch()
	h.turn(main, "noted")
	path := "/lines/" + branch + "/branch/card"
	edited := map[string]any{"card": map[string]any{"question": "Which hotel?", "conclusion": "The ryokan", "impact": "Book early", "openItems": []string{"Pay the deposit"}}}

	h.events.Reset()
	out := h.ok(http.StatusOK, h.do(http.MethodPatch, path, edited))
	message := out["message"].(map[string]any)
	meta := message["meta"].(map[string]any)
	if message["id"] != cardID || message["kind"] != "branch_card" || meta["delivered"] != nil || meta["branchLineId"] != branch ||
		field(meta, "card", "conclusion") != "The ryokan" || !strings.Contains(message["content"].(string), "> The ryokan") {
		t.Fatalf("message = %v", message)
	}
	if field(out, "branch", "conclusionLine") != "The ryokan" || field(out, "branch", "status") != "merged" || field(out, "branch", "leaf", "line") != "The ryokan" {
		t.Fatalf("branch = %v", out["branch"])
	}
	if len(out) != 2 {
		t.Fatalf("the answer is {branch, message}: %v", out)
	}
	types := h.events.Types()
	if len(types) != 3 || types[0] != tangent.EventMessageUpdated || types[1] != tangent.EventBranchChanged || types[2] != tangent.EventLeafChanged {
		t.Fatalf("events = %v", types)
	}
	if change := h.events.OfType(tangent.EventBranchChanged)[0].Data.(tangent.BranchChange); change.Change != tangent.BranchMerged {
		t.Fatalf("branch.changed = %+v", change)
	}

	h.wantError(h.do(http.MethodPatch, path, map[string]any{"card": map[string]any{"question": "q", "conclusion": "c", "extra": 1}}), http.StatusUnprocessableEntity, "invalid_card")
	h.wantError(h.do(http.MethodPatch, path, map[string]any{"card": map[string]any{"question": "q", "conclusion": " "}}), http.StatusUnprocessableEntity, "invalid_card")
	h.wantError(h.do(http.MethodPatch, path, map[string]any{}), http.StatusUnprocessableEntity, "invalid_card")
	h.wantError(h.do(http.MethodPatch, path, nil), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodPatch, "/lines/"+unknownID+"/branch/card", edited), http.StatusNotFound, "branch_not_found")
	h.wantError(h.do(http.MethodPatch, "/lines/"+main+"/branch/card", edited), http.StatusNotFound, "branch_not_found")
	h.wantError(h.do(http.MethodPatch, path, edited, as(tenantB)), http.StatusNotFound, "branch_not_found")

	reply := h.turn(main, "more?")
	open := h.branch(main, reply, "still open")
	h.wantError(h.do(http.MethodPatch, "/lines/"+open+"/branch/card", edited), http.StatusConflict, "branch_closed")
	discarded := h.branch(main, reply, "dropped")
	h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+discarded+"/branch/discard", nil))
	h.wantError(h.do(http.MethodPatch, "/lines/"+discarded+"/branch/card", edited), http.StatusConflict, "branch_closed")
	h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+main+"/archive", nil))
	h.wantError(h.do(http.MethodPatch, path, edited), http.StatusConflict, "archived")
}

func TestB17Routes_ABranchOnACard(t *testing.T) {
	h := newHarness(t)
	main, _, cardID := h.mergedBranch()
	body := map[string]any{"anchorMessageId": cardID, "purpose": "Ask about the hotel", "kind": "investigate"}
	preview := h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+main+"/branches/preview", body))
	recent := field(preview, "pack", "recent").([]any)
	if last := recent[len(recent)-1].(map[string]any); last["id"] != cardID || last["role"] != "system" ||
		!strings.Contains(preview["text"].(string), "branch conclusion card]") {
		t.Fatalf("preview = %v", preview)
	}
	created := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+main+"/branches", body))
	if field(created, "branch", "anchorMessageId") != cardID {
		t.Fatalf("created = %v", created)
	}
	other := h.line()
	h.wantError(h.do(http.MethodPost, "/lines/"+other+"/branches", body), http.StatusNotFound, "anchor_not_found")
}

// B17.1: the edit time shows on the card (meta.editedAt) and on its branch
// (cardEditedAt) in every read, survives the card's delivery and is later
// than a follow-up branch opened on the card before the edit.
func TestB17Routes_TheCardEditTime(t *testing.T) {
	h := newHarness(t)
	main, branch, cardID := h.mergedBranch()
	h.turn(main, "noted")
	if card := h.cardMessage(main, cardID); field(card, "meta", "editedAt") != nil {
		t.Fatalf("a card never edited has no editedAt: %v", card)
	}
	if view := h.branchView(main, branch); view["cardEditedAt"] != nil {
		t.Fatalf("a branch whose card was never edited has no cardEditedAt: %v", view)
	}
	followUp := h.branch(main, cardID, "more on the hotel")

	out := h.ok(http.StatusOK, h.do(http.MethodPatch, "/lines/"+branch+"/branch/card", map[string]any{"card": map[string]any{"question": "Which hotel?", "conclusion": "The ryokan"}}))
	editedAt, _ := field(out, "message", "meta", "editedAt").(string)
	parsed, err := time.Parse(time.RFC3339Nano, editedAt)
	if err != nil || field(out, "branch", "cardEditedAt") != editedAt || !strings.HasSuffix(editedAt, "Z") {
		t.Fatalf("editedAt %q (%v), branch.cardEditedAt %v", editedAt, err, field(out, "branch", "cardEditedAt"))
	}
	if got := h.branchView(main, branch)["cardEditedAt"]; got != editedAt {
		t.Fatalf("the outline shows the edit time: %v, want %s", got, editedAt)
	}
	if got := field(h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+branch+"/branch", nil)), "branch", "cardEditedAt"); got != editedAt {
		t.Fatalf("GET /branch shows the edit time: %v, want %s", got, editedAt)
	}
	opened, err := time.Parse(time.RFC3339Nano, h.branchView(main, followUp)["createdAt"].(string))
	if err != nil || !parsed.After(opened) {
		t.Fatalf("the edit is later than the follow-up opened before it: %v ≤ %v (%v)", parsed, opened, err)
	}

	h.turn(main, "so?")
	card := h.cardMessage(main, cardID)
	if field(card, "meta", "delivered") != true || field(card, "meta", "editedAt") != editedAt {
		t.Fatalf("a delivered edited card keeps editedAt: %v", card["meta"])
	}
}

// cardMessage reads a card message of a line.
func (h *harness) cardMessage(lineID, cardID string) map[string]any {
	h.t.Helper()
	page := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+lineID+"/messages", nil))
	for _, raw := range page["messages"].([]any) {
		if message := raw.(map[string]any); message["id"] == cardID {
			return message
		}
	}
	h.t.Fatalf("no card %s on %s", cardID, lineID)
	return nil
}

// branchView reads one branch of a main line's outline.
func (h *harness) branchView(mainID, branchID string) map[string]any {
	h.t.Helper()
	list := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+mainID+"/branches", nil))
	for _, raw := range list["branches"].([]any) {
		if view := raw.(map[string]any); view["lineId"] == branchID {
			return view
		}
	}
	h.t.Fatalf("no branch %s under %s", branchID, mainID)
	return nil
}
