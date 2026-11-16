package main

import (
	"context"
	"fmt"
	"slices"
)

// suggestion is one row of the inbox.
type suggestion struct {
	ID      string         `json:"id"`
	Feature string         `json:"feature"`
	Kind    string         `json:"kind"`
	LineID  string         `json:"lineId"`
	Status  string         `json:"status"`
	Payload map[string]any `json:"payload"`
}

// inbox reads the tree's open suggestions and accepts or dismisses one.
func (w *worker) inbox(ctx context.Context, t *tree, _ string) {
	var list struct {
		Suggestions []suggestion `json:"suggestions"`
	}
	if err := w.c.call(ctx, "GET", "/lines/"+t.main+"/suggestions", nil, &list); !w.st.classify("list suggestions", err) || err != nil {
		return
	}
	if len(list.Suggestions) == 0 {
		w.st.op("inbox", "skipped: empty")
		return
	}
	s := list.Suggestions[w.rng.IntN(len(list.Suggestions))]
	if s.Status != "open" {
		w.st.fail("list suggestions", "suggestion %s listed as open is %s", s.ID, s.Status)
		return
	}
	if w.rng.IntN(3) == 0 {
		w.decideSuggestion(ctx, "dismiss suggestion", "/suggestions/"+s.ID+"/dismiss", nil, "dismissed")
		return
	}
	body, allowed := acceptBody(w, s)
	if !w.decideSuggestion(ctx, "accept "+s.Kind, "/suggestions/"+s.ID+"/accept", body, "accepted", allowed...) {
		return
	}
	if s.Kind == "promote_or_spinoff" && body["action"] == "spinoff" {
		t.others = append(t.others, s.LineID) // the branch became its own conversation
	}
	w.refreshLines(ctx, t)
}

// decideSuggestion accepts or dismisses one suggestion and checks the
// answer names it with the new status.
func (w *worker) decideSuggestion(ctx context.Context, op, path string, body map[string]any, want string, allowed ...string) bool {
	var out struct {
		Suggestion suggestion `json:"suggestion"`
	}
	err := w.c.call(ctx, "POST", path, body, &out)
	if !w.st.classify(op, err, append(allowed, "suggestion_not_open")...) || err != nil {
		return false
	}
	if out.Suggestion.Status != want {
		w.st.fail(op, "the suggestion is %q after %s", out.Suggestion.Status, op)
		return false
	}
	return true
}

// acceptBody is the accept body for a suggestion's kind and the refusals
// accepting it may meet in a busy run.
func acceptBody(w *worker, s suggestion) (map[string]any, []string) {
	switch s.Kind {
	case "promote_or_spinoff":
		actions, _ := s.Payload["actions"].([]any)
		if len(actions) == 0 {
			return map[string]any{"action": "promote"}, nil
		}
		return map[string]any{"action": actions[w.rng.IntN(len(actions))]}, nil
	case "relation":
		return map[string]any{}, []string{"relation_exists", "relation_limit"}
	case "group":
		return map[string]any{}, []string{"invalid_group", "group_limit"}
	case "fold":
		return map[string]any{}, []string{"fold_overlap", "fold_limit", "invalid_fold", "message_not_found"}
	case "memory", "memory_consolidate":
		return map[string]any{"importance": 1 + w.rng.IntN(10)}, []string{"memory_superseded"}
	}
	return map[string]any{}, nil
}

// branchesWhere are the tree's branches (as last read) that match.
func (t *tree) branchesWhere(keep func(branchView) bool) []branchView {
	var out []branchView
	for _, b := range t.branches {
		if keep(b) {
			out = append(out, b)
		}
	}
	return out
}

// leafKinds are the kinds of a branch's closing note.
var leafKinds = []string{"conclusion", "decision", "answer", "dead_end", "to_continue"}

// leaf writes, reads, deletes or asks a draft of a branch's leaf.
func (w *worker) leaf(ctx context.Context, t *tree, _ string) {
	branches := t.branchesWhere(func(b branchView) bool { return b.Kind != "aside" })
	if len(branches) == 0 {
		w.st.op("leaf", "skipped: no branch")
		return
	}
	b := branches[w.rng.IntN(len(branches))]
	path := "/lines/" + b.LineID + "/leaf"
	switch roll := w.rng.IntN(100); {
	case roll < 40:
		body := map[string]any{"kind": leafKinds[w.rng.IntN(len(leafKinds))], "line": fmt.Sprintf("收尾 leaf %d", w.rng.IntN(1e6)), "body": "written by the soak"}
		var out struct {
			Leaf *leafView `json:"leaf"`
		}
		if err := w.c.call(ctx, "PUT", path, body, &out); w.st.classify("leaf put", err) && err == nil && (out.Leaf == nil || out.Leaf.Status != "confirmed") {
			w.st.fail("leaf put", "the written leaf is %+v", out.Leaf)
		}
	case roll < 60:
		w.st.classify("leaf delete", w.c.call(ctx, "DELETE", path, nil, nil), "leaf_not_found")
	case roll < 85:
		w.st.classify("leaf draft", w.c.call(ctx, "POST", path+"/draft", nil, nil))
	default:
		w.st.classify("leaf get", w.c.call(ctx, "GET", path, nil, nil))
	}
}

// seed is one parked thought.
type seed struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// seeds parks a thought, or expands, notes or drops an open one.
func (w *worker) seeds(ctx context.Context, t *tree, line string) {
	var list struct {
		Seeds []seed `json:"seeds"`
	}
	if err := w.c.call(ctx, "GET", "/lines/"+line+"/seeds", nil, &list); !w.st.classify("seed list", err) || err != nil {
		return
	}
	if len(list.Seeds) == 0 || w.rng.IntN(3) == 0 {
		var out struct {
			Seed seed `json:"seed"`
		}
		err := w.c.call(ctx, "POST", "/lines/"+line+"/seeds", map[string]any{"text": fmt.Sprintf("停車場 parked thought %d", w.rng.IntN(1e6))}, &out)
		if w.st.classify("seed create", err, "seed_limit") && err == nil && (out.Seed.ID == "" || out.Seed.Status != "open") {
			w.st.fail("seed create", "the new seed is %+v", out.Seed)
		}
		return
	}
	s := list.Seeds[w.rng.IntN(len(list.Seeds))]
	switch roll := w.rng.IntN(100); {
	case roll < 35:
		var out struct {
			Line lineView `json:"line"`
		}
		err := w.c.call(ctx, "POST", "/seeds/"+s.ID+"/expand", map[string]any{"confirmDeeper": true}, &out)
		if w.st.classify("seed expand", err, "seed_not_open") && err == nil {
			t.lines = append(t.lines, out.Line.ID)
		}
	case roll < 65 && w.feats.on("notes"):
		w.st.classify("seed to-note", w.c.call(ctx, "POST", "/seeds/"+s.ID+"/to-note", nil, nil), "seed_not_open")
	default:
		w.st.classify("seed drop", w.c.call(ctx, "POST", "/seeds/"+s.ID+"/drop", nil, nil), "seed_not_open")
	}
}

// spinoff previews or makes a new conversation: fresh from a message of
// the line, or a branch detached with its subtree.
func (w *worker) spinoff(ctx context.Context, t *tree, line string) {
	mode := "fresh"
	if line != t.main && w.rng.IntN(2) == 0 {
		mode = "detach"
	}
	body := map[string]any{"mode": mode, "copyNotes": w.rng.IntN(2) == 0, "title": fmt.Sprintf("獨立 spinoff %d", w.rng.IntN(1e6))}
	if mode == "fresh" {
		anchor, ok := w.anchor(ctx, line)
		if !ok {
			w.st.op("spinoff", "skipped: no message")
			return
		}
		body["atMessageId"] = anchor
	}
	if w.rng.IntN(3) == 0 {
		w.st.classify("spinoff preview", w.c.call(ctx, "POST", "/lines/"+line+"/spinoff/preview", body, nil))
		return
	}
	var out struct {
		Line lineView `json:"line"`
	}
	err := w.c.call(ctx, "POST", "/lines/"+line+"/spinoff", body, &out)
	if !w.st.classify("spinoff "+mode, err) || err != nil {
		return
	}
	if out.Line.ID == "" || (mode == "detach" && out.Line.ID != line) {
		w.st.fail("spinoff "+mode, "the new conversation is %q (from %s)", out.Line.ID, line)
		return
	}
	t.others = append(t.others, out.Line.ID)
	w.refreshLines(ctx, t)
}

// deepDive talks five turns in a row in one branch, so the tree looks
// lopsided and rebalance proposes promoting or spinning it off.
func (w *worker) deepDive(ctx context.Context, t *tree, _ string) {
	branches := slices.DeleteFunc(slices.Clone(t.lines), func(l string) bool { return l == t.main })
	if len(branches) == 0 {
		w.openBranch(ctx, t, t.main)
		w.st.op("deep dive", "opened a branch first")
		return
	}
	line := branches[w.rng.IntN(len(branches))]
	for i := range deepDiveTurns {
		if ctx.Err() != nil || w.plainTurn(ctx, line, fmt.Sprintf("deep dive %d #%d", i, w.rng.IntN(1e6))) != "done" {
			w.st.op("deep dive", "cut short")
			return
		}
	}
	w.st.op("deep dive", "ok")
}

// deepDiveTurns is enough for rebalance's "recent" trigger (5 replies).
const deepDiveTurns = 5

// plainTurn sends a message without directives and waits for the reply.
func (w *worker) plainTurn(ctx context.Context, line, content string) string {
	var started struct {
		TurnID      string  `json:"turnId"`
		UserMessage message `json:"userMessage"`
	}
	err := w.c.call(ctx, "POST", "/lines/"+line+"/messages", map[string]any{"content": content}, &started)
	if !w.st.classify("send", err) || err != nil {
		return "refused"
	}
	return w.waitReply(ctx, line, started.UserMessage.Seq, started.TurnID)
}
