package main

import (
	"context"
	"fmt"
	"slices"
	"time"
)

// anchor picks a finished operator or assistant message of the line.
func (w *worker) anchor(ctx context.Context, line string) (string, bool) {
	messages, err := w.messages(ctx, line, 0)
	if err != nil {
		w.st.classify("read messages", err)
		return "", false
	}
	var ids []string
	for _, m := range messages {
		if m.Status == "done" && m.Kind == "chat" && (m.Role == "user" || m.Role == "assistant") {
			ids = append(ids, m.ID)
		}
	}
	if len(ids) == 0 {
		return "", false
	}
	return ids[w.rng.IntN(len(ids))], true
}

// openBranch opens a branch (sometimes an aside) on the line and talks in it.
func (w *worker) openBranch(ctx context.Context, t *tree, line string) {
	anchor, ok := w.anchor(ctx, line)
	if !ok {
		w.turn(ctx, line)
		return
	}
	kinds := []string{"investigate", "investigate", "alternative", "aside"}
	var created struct {
		Line lineView `json:"line"`
	}
	body := map[string]any{"anchorMessageId": anchor, "purpose": fmt.Sprintf("支線 branch %d", w.rng.IntN(1e6)), "kind": kinds[w.rng.IntN(len(kinds))], "confirmDeeper": true}
	err := w.c.call(ctx, "POST", "/lines/"+line+"/branches", body, &created)
	if !w.st.classify("branch", err) || err != nil {
		return
	}
	w.st.outcome("branch opened")
	t.lines = append(t.lines, created.Line.ID)
	w.turn(ctx, created.Line.ID)
}

// endBranch ends a random open branch of the tree: a merge (drafted card,
// sometimes with its note proposals), a discard or a promotion.
func (w *worker) endBranch(ctx context.Context, t *tree, how string) {
	if len(t.lines) < 2 {
		return
	}
	line := t.lines[1+w.rng.IntN(len(t.lines)-1)]
	var err error
	switch how {
	case "merge":
		err = w.merge(ctx, line)
	case "discard":
		var body any // no body at all, or one with a leaf
		if w.feats.on("leaf") && w.rng.IntN(2) == 0 {
			body = map[string]any{"leaf": map[string]any{"kind": "dead_end", "line": fmt.Sprintf("沒走通 dead end %d", w.rng.IntN(1e6))}}
		}
		err = w.c.call(ctx, "POST", "/lines/"+line+"/branch/discard", body, nil)
	case "promote":
		err = w.c.call(ctx, "POST", "/lines/"+line+"/branch/promote", map[string]any{"confirm": true}, nil)
	}
	if w.st.classify(how, err) && err == nil {
		w.st.outcome(map[string]string{"merge": "branch merged", "discard": "branch discarded", "promote": "branch promoted"}[how])
	}
	w.refreshLines(ctx, t)
}

// merge drafts a card, waits for it and brings it back; a failed draft is
// replaced by a hand-written card.
func (w *worker) merge(ctx context.Context, line string) error {
	if err := w.c.call(ctx, "POST", "/lines/"+line+"/branch/draft", nil, nil); err != nil {
		return err
	}
	var detail branchDetail
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		if err := w.c.call(ctx, "GET", "/lines/"+line+"/branch", nil, &detail); err != nil {
			return err
		}
		if status, _ := detail.Draft["status"].(string); status != "drafting" {
			break
		}
		sleep(ctx, 100*time.Millisecond)
	}
	card, _ := detail.Draft["card"].(map[string]any)
	if card == nil {
		card = map[string]any{"question": "What did we find?", "conclusion": "Written by hand after a failed draft."}
	}
	body := map[string]any{"card": card, "parentTipMessageId": detail.ParentTipMessageID, "confirmParentMoved": w.rng.IntN(2) == 0}
	if changes, ok := detail.Draft["noteChanges"].([]any); ok && len(changes) > 0 && w.rng.IntN(2) == 0 {
		body["noteChanges"] = changes
	}
	return w.c.call(ctx, "POST", "/lines/"+line+"/branch/merge", body, nil)
}

// move turns the last two messages of a line into a branch.
func (w *worker) move(ctx context.Context, t *tree, line string) {
	err := w.c.call(ctx, "POST", "/lines/"+line+"/branches/move", map[string]any{"count": 2, "purpose": "moved aside", "confirmDeeper": true}, nil)
	if w.st.classify("move", err) && err == nil {
		w.st.outcome("branch moved")
	}
	w.refreshLines(ctx, t)
}

// refreshLines re-reads the outline: the open branches become the lines a
// worker acts on, and the outline goes through the invariant check.
func (w *worker) refreshLines(ctx context.Context, t *tree) {
	var outline struct {
		Branches []branchView `json:"branches"`
	}
	if err := w.c.call(ctx, "GET", "/lines/"+t.main+"/branches?includeAside=true", nil, &outline); err != nil {
		w.st.classify("outline", err)
		return
	}
	w.inv.observeBranches(outline.Branches)
	t.branches = outline.Branches
	lines := []string{t.main}
	for _, b := range outline.Branches {
		if b.Status == "open" && b.Kind != "aside" {
			lines = append(lines, b.LineID)
		}
	}
	t.lines = lines
}

// checkTree reads the outline and every open line's messages.
func (w *worker) checkTree(ctx context.Context, t *tree) {
	w.refreshLines(ctx, t)
	for _, line := range slices.Clone(t.lines) {
		if _, err := w.messages(ctx, line, 0); err != nil {
			w.st.classify("read messages", err)
		}
	}
}

// finish waits for the tree to go quiet, checks it and deletes it (most of
// the time) or leaves it archived; the conversations it spun off are
// deleted.
func (w *worker) finish(ctx context.Context, t *tree) {
	w.checkTree(ctx, t)
	for _, other := range t.others {
		w.deleteTree(ctx, other)
	}
	if w.rng.IntN(10) < 3 {
		w.st.classify("archive tree", w.c.call(ctx, "POST", "/lines/"+t.main+"/archive", nil, nil))
		return
	}
	w.deleteTree(ctx, t.main)
}

// deleteTree deletes a conversation, waiting while a turn or job holds it.
func (w *worker) deleteTree(ctx context.Context, root string) {
	for range 20 {
		err := w.c.call(ctx, "DELETE", "/lines/"+root, nil, nil)
		if err == nil {
			w.st.op("delete", "ok")
			w.st.outcome("tree deleted")
			return
		}
		if !w.st.classify("delete", err) {
			return
		}
		sleep(ctx, 500*time.Millisecond) // a turn or draft is still running
	}
	w.st.outcome("tree left (busy)")
}
