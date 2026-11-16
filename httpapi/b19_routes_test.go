package httpapi_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

// B19: POST /lines/import keeps createdAt, writes chapterCuts and merged
// branches with their card; every new field is optional.

func TestB19Routes_ImportKeepsDatesAndAssembles(t *testing.T) {
	h := newHarness(t)
	out := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/import", b19Import()))
	if got := field(out, "line", "createdAt"); got != "2025-03-01T09:00:00Z" {
		t.Fatalf("line.createdAt = %v", got)
	}
	if got := field(out, "line", "lastActivityAt"); got != "2025-03-01T09:48:00Z" {
		t.Fatalf("line.lastActivityAt = %v", got)
	}
	branches := out["branches"].([]any)
	merged := branches[0].(map[string]any)
	if merged["status"] != "merged" || merged["cardMessageId"] == "" || merged["createdAt"] != "2025-03-01T09:03:00Z" || out["messageCount"] != float64(6) {
		t.Fatalf("merged = %v count %v", merged, out["messageCount"])
	}
	main := field(out, "line", "id").(string)
	messages := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/messages", nil))["messages"].([]any)
	card := messages[2].(map[string]any)
	if len(messages) != 7 || card["kind"] != "branch_card" || card["id"] != merged["cardMessageId"] || card["createdAt"] != "2025-03-01T09:01:00Z" {
		t.Fatalf("messages = %v", messages)
	}
	chapters := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/chapters", nil))
	if milestones := chapters["milestones"].([]any); len(milestones) != 2 {
		t.Fatalf("milestones = %v", milestones)
	}
}

func TestB19Routes_NullNewFieldsAreLeftOut(t *testing.T) {
	h := newHarness(t)
	body := b18Import()
	body["createdAt"], body["chapterCuts"] = nil, nil
	branch(body, 0)["card"], branch(body, 0)["createdAt"] = nil, nil
	message(body, 0)["createdAt"] = nil
	out := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/import", body))
	if branches := out["branches"].([]any); branches[0].(map[string]any)["status"] != "discarded" || out["messageCount"] != float64(8) {
		t.Fatalf("imported = %v", out)
	}
}

func TestB19Routes_ImportRefusesTheNewFields(t *testing.T) {
	h := newHarness(t)
	cases := []struct {
		name, field, code string
		status            int
		mutate            func(body map[string]any)
	}{
		{"a date that is not RFC 3339", "messages[0].createdAt", "invalid_input", http.StatusBadRequest, func(b map[string]any) { message(b, 0)["createdAt"] = "yesterday" }},
		{"a date as a number", "createdAt", "invalid_input", http.StatusBadRequest, func(b map[string]any) { b["createdAt"] = 1700000000 }},
		{"a date before 1970", "createdAt", "invalid_input", http.StatusBadRequest, func(b map[string]any) { b["createdAt"] = "1969-12-31T23:59:59Z" }},
		{"a branch date in the far future", "branches[0].createdAt", "invalid_input", http.StatusBadRequest, func(b map[string]any) { branch(b, 0)["createdAt"] = "2999-01-01T00:00:00Z" }},
		{"a branch message date", "branches[0].messages[1].createdAt", "invalid_input", http.StatusBadRequest, func(b map[string]any) {
			branch(b, 0)["messages"].([]map[string]any)[1]["createdAt"] = "2025-03-01"
		}},
		{"a merged branch without a card", "branches[0].card", "invalid_input", http.StatusBadRequest, func(b map[string]any) { delete(branch(b, 0), "card") }},
		{"a null card on a merged branch", "branches[0].card", "invalid_input", http.StatusBadRequest, func(b map[string]any) { branch(b, 0)["card"] = nil }},
		{"a card on a discarded branch", "branches[0].card", "invalid_input", http.StatusBadRequest, func(b map[string]any) { branch(b, 0)["status"] = "discarded" }},
		{"a cut on an unknown message", "chapterCuts[0].anchorExternalId", "invalid_input", http.StatusBadRequest, func(b map[string]any) {
			b["chapterCuts"].([]map[string]any)[0]["anchorExternalId"] = "zz"
		}},
		{"a cut without a title", "chapterCuts[1].title", "invalid_input", http.StatusBadRequest, func(b map[string]any) { b["chapterCuts"].([]map[string]any)[1]["title"] = " " }},
	}
	for _, c := range cases {
		body := b19Import()
		c.mutate(body)
		r := h.do(http.MethodPost, "/lines/import", body)
		h.wantError(r, c.status, c.code)
		if got := r.json(t)["field"]; got != c.field {
			t.Fatalf("%s: field = %v, want %s", c.name, got, c.field)
		}
	}
	cards := []struct {
		name, field string
		card        any
	}{
		{"an unknown card field", "branches[0].card", map[string]any{"question": "q", "conclusion": "c", "extra": 1}},
		{"a card that is not an object", "branches[0].card", "card"},
		{"a card without a conclusion", "branches[0].card.conclusion", map[string]any{"question": "q"}},
		{"a card citing a message", "branches[0].card.evidence[0].messageId", map[string]any{
			"question": "q", "conclusion": "c", "evidence": []map[string]any{{"messageId": "0b9c3e0e-1c47-4c8e-9a51-6f0d2b1f7a10", "note": "n"}},
		}},
	}
	for _, c := range cards {
		body := b19Import()
		branch(body, 0)["card"] = c.card
		r := h.do(http.MethodPost, "/lines/import", body)
		h.wantError(r, http.StatusUnprocessableEntity, "invalid_card")
		var problems struct {
			Problems []struct {
				Field string `json:"field"`
			} `json:"problems"`
		}
		if err := json.Unmarshal(r.raw, &problems); err != nil || len(problems.Problems) == 0 || problems.Problems[0].Field != c.field {
			t.Fatalf("%s: %s", c.name, r.raw)
		}
	}
	lines := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines", nil))["lines"].([]any)
	if len(lines) != 0 {
		t.Fatalf("refused imports left %d lines", len(lines))
	}
}

func message(body map[string]any, i int) map[string]any {
	return body["messages"].([]map[string]any)[i]
}

func branch(body map[string]any, i int) map[string]any {
	return body["branches"].([]map[string]any)[i]
}
