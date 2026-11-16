package main

import (
	"context"
	"fmt"
	"slices"
	"time"
)

// ibisKinds are the argument tags.
var ibisKinds = []string{"question", "idea", "pro", "con", "decision"}

// taggable reports whether a message can carry a tag (or be pinned or
// folded): a finished chat message of the operator or the assistant.
func taggable(m message) bool {
	return m.Status == "done" && m.Kind == "chat" && (m.Role == "user" || m.Role == "assistant")
}

// tags confirms an AI-drafted tag when there is one, or sets, changes or
// clears a tag of a finished message.
func (w *worker) tags(ctx context.Context, _ *tree, line string) {
	messages, err := w.messages(ctx, line, 0)
	if err != nil {
		w.st.classify("read messages", err)
		return
	}
	candidates := slices.DeleteFunc(messages, func(m message) bool { return !taggable(m) })
	if len(candidates) == 0 {
		w.st.op("tags", "skipped: no message")
		return
	}
	if i := slices.IndexFunc(candidates, func(m message) bool { return m.Tag != nil && m.Tag.Source == "ai" && m.Tag.Status == "draft" }); i >= 0 && w.rng.IntN(3) > 0 {
		w.putTag(ctx, "tag confirm ai draft", candidates[i].ID, candidates[i].Tag.Kind)
		return
	}
	m := candidates[w.rng.IntN(len(candidates))]
	switch {
	case m.Tag == nil:
		w.putTag(ctx, "tag set", m.ID, ibisKinds[w.rng.IntN(len(ibisKinds))])
	case w.rng.IntN(2) == 0:
		other := slices.DeleteFunc(slices.Clone(ibisKinds), func(k string) bool { return k == m.Tag.Kind })
		w.putTag(ctx, "tag change", m.ID, other[w.rng.IntN(len(other))])
	default:
		var out struct {
			Message message `json:"message"`
		}
		if err := w.c.call(ctx, "DELETE", "/messages/"+m.ID+"/tag", nil, &out); w.st.classify("tag clear", err) && err == nil && out.Message.Tag != nil {
			w.st.fail("tag clear", "message %s keeps its tag %+v", m.ID, out.Message.Tag)
		}
	}
}

// putTag writes the operator's tag and checks it is the operator's now.
func (w *worker) putTag(ctx context.Context, op, messageID, kind string) {
	var out struct {
		Message message `json:"message"`
	}
	err := w.c.call(ctx, "PUT", "/messages/"+messageID+"/tag", map[string]any{"kind": kind}, &out)
	if !w.st.classify(op, err) || err != nil {
		return
	}
	if tag := out.Message.Tag; tag == nil || tag.Kind != kind || tag.Source != "user" || tag.Status != "confirmed" {
		w.st.fail(op, "message %s has tag %+v after %s %s", messageID, tag, op, kind)
	}
}

// fold is one folded stretch of a line.
type fold struct {
	ID      string `json:"id"`
	Status  string `json:"status"`
	FromSeq int64  `json:"fromSeq"`
	ToSeq   int64  `json:"toSeq"`
}

// folds folds a stretch of the line (with a summary, or drafted by the
// AI), edits or removes a fold.
func (w *worker) folds(ctx context.Context, _ *tree, line string) {
	var list struct {
		Folds []fold `json:"folds"`
	}
	if err := w.c.call(ctx, "GET", "/lines/"+line+"/folds", nil, &list); !w.st.classify("fold list", err) || err != nil {
		return
	}
	if len(list.Folds) > 0 && w.rng.IntN(2) == 0 {
		f := list.Folds[w.rng.IntN(len(list.Folds))]
		if w.rng.IntN(2) == 0 {
			w.st.classify("fold edit", w.c.call(ctx, "PATCH", "/folds/"+f.ID, map[string]any{"summary": fmt.Sprintf("摺疊 edited %d", w.rng.IntN(1e6))}, nil), "fold_not_found")
		} else {
			w.st.classify("fold delete", w.c.call(ctx, "DELETE", "/folds/"+f.ID, nil, nil), "fold_not_found")
		}
		return
	}
	w.newFold(ctx, line)
}

// newFold folds 2–6 finished messages of the line; a fold written with its
// summary must show in the next preview (with the fisheye when it is on).
func (w *worker) newFold(ctx context.Context, line string) {
	messages, err := w.messages(ctx, line, 0)
	if err != nil {
		w.st.classify("read messages", err)
		return
	}
	if len(messages) < 2 {
		w.st.op("folds", "skipped: too few messages")
		return
	}
	// Only within the newest messages, which every prompt scans (200).
	recent := max(0, len(messages)-foldRecentMessages)
	from := recent + w.rng.IntN(len(messages)-recent-1)
	to := min(len(messages)-1, from+1+w.rng.IntN(5))
	body := map[string]any{"fromMessageId": messages[from].ID, "toMessageId": messages[to].ID}
	op := "fold create drafting"
	if w.rng.IntN(2) == 0 {
		body["summary"] = fmt.Sprintf("這段摺疊 folded by the soak %d", w.rng.IntN(1e6))
		op = "fold create"
	}
	var out struct {
		Fold fold `json:"fold"`
	}
	err = w.c.call(ctx, "POST", "/lines/"+line+"/folds", body, &out)
	if !w.st.classify(op, err, "fold_overlap", "fold_limit", "invalid_fold") || err != nil {
		return
	}
	want := map[string]string{"fold create": "active", "fold create drafting": "drafting"}[op]
	if out.Fold.Status != want {
		w.st.fail(op, "the new fold is %s, not %s", out.Fold.Status, want)
		return
	}
	if want != "active" {
		return
	}
	preview, ok := w.previewWith(ctx, line, "fold preview", "and the folded part?")
	if !ok {
		return
	}
	if !slices.ContainsFunc(preview.Folds, func(f appliedFold) bool { return f.FoldID == out.Fold.ID }) {
		w.inv.violate("line %s: the active fold %s is not in the preview (%+v)", line, out.Fold.ID, preview.Folds)
		return
	}
	if preview.Fisheye != nil {
		w.st.op("fold with fisheye", "ok")
	}
}

// foldRecentMessages keeps a new fold among the messages a prompt reads.
const foldRecentMessages = 150

// comparison is a converge table of sibling branches.
type comparison struct {
	ID            string   `json:"id"`
	Status        string   `json:"status"`
	LineIDs       []string `json:"lineIds"`
	DecidedLineID string   `json:"decidedLineId"`
}

// divergeConvergeDecide opens 2–3 directions from a message of the line,
// compares two open branches of the line and (most of the time) decides.
func (w *worker) divergeConvergeDecide(ctx context.Context, t *tree, line string) {
	if anchor, ok := w.anchor(ctx, line); ok && w.rng.IntN(4) > 0 {
		err := w.c.call(ctx, "POST", "/lines/"+line+"/diverge", map[string]any{"anchorMessageId": anchor, "count": 2 + w.rng.IntN(2)}, nil)
		if w.st.classify("diverge", err) && err == nil {
			w.waitDiverged(ctx, t, line, anchor)
		}
	}
	w.refreshLines(ctx, t)
	siblings := t.openSiblings(line)
	if len(siblings) < 2 {
		w.st.op("converge", "skipped: fewer than two open branches")
		return
	}
	w.rng.Shuffle(len(siblings), func(i, j int) { siblings[i], siblings[j] = siblings[j], siblings[i] })
	body := map[string]any{"lineIds": []string{siblings[0].LineID, siblings[1].LineID}}
	if w.rng.IntN(2) == 0 {
		body["criteria"] = []string{"安全 safety", "speed"}
	}
	var out struct {
		Comparison comparison `json:"comparison"`
	}
	err := w.c.call(ctx, "POST", "/lines/"+line+"/converge", body, &out)
	if !w.st.classify("converge", err, "invalid_comparison") || err != nil {
		return
	}
	ready := w.waitComparison(ctx, out.Comparison.ID)
	if ready.Status != "ready" || w.rng.IntN(5) == 0 {
		w.st.op("converge", "left "+ready.Status)
		return
	}
	w.decide(ctx, t, line, ready)
}

// waitDiverged waits for the diverge job's branches on the anchor.
func (w *worker) waitDiverged(ctx context.Context, t *tree, line, anchor string) {
	deadline := time.Now().Add(jobTimeout)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		w.refreshLines(ctx, t)
		if slices.ContainsFunc(t.branches, func(b branchView) bool {
			return b.Origin == "diverge" && b.AnchorMessageID == anchor && b.ParentLineID == line
		}) {
			w.st.outcome("diverged")
			return
		}
		sleep(ctx, 200*time.Millisecond)
	}
	w.st.outcome("diverge opened nothing") // the job may fail (for example the parent filled up)
}

// jobTimeout is how long the driver waits for a job it asked for.
const jobTimeout = 30 * time.Second

// waitComparison polls a comparison until it is no longer drafting.
func (w *worker) waitComparison(ctx context.Context, id string) comparison {
	var out struct {
		Comparison comparison `json:"comparison"`
	}
	deadline := time.Now().Add(jobTimeout)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		if err := w.c.call(ctx, "GET", "/comparisons/"+id, nil, &out); !w.st.classify("comparison get", err) || err != nil {
			return out.Comparison
		}
		if out.Comparison.Status != "drafting" {
			return out.Comparison
		}
		sleep(ctx, 150*time.Millisecond)
	}
	return out.Comparison
}

// decide picks one option of a ready comparison and checks the siblings:
// the chosen one open with a decision leaf, the others that were open
// discarded with a dead end, and none of them open afterwards.
func (w *worker) decide(ctx context.Context, t *tree, line string, c comparison) {
	chosen := c.LineIDs[w.rng.IntN(len(c.LineIDs))]
	var out struct {
		Comparison comparison   `json:"comparison"`
		Chosen     branchView   `json:"chosen"`
		Discarded  []branchView `json:"discarded"`
	}
	err := w.c.call(ctx, "POST", "/comparisons/"+c.ID+"/decide", map[string]any{"lineId": chosen}, &out)
	if !w.st.classify("decide", err, "comparison_decided") || err != nil {
		return
	}
	if out.Comparison.Status != "decided" || out.Chosen.LineID != chosen || out.Chosen.Status != "open" || out.Chosen.Leaf == nil || out.Chosen.Leaf.Kind != "decision" {
		w.inv.violate("decide %s: comparison %s, chosen %+v", c.ID, out.Comparison.Status, out.Chosen)
	}
	for _, b := range out.Discarded {
		if b.Status != "discarded" || b.Leaf == nil || b.Leaf.Kind != "dead_end" || b.LineID == chosen {
			w.inv.violate("decide %s: a sibling left %+v", c.ID, b)
		}
	}
	w.refreshLines(ctx, t)
	for _, b := range t.branches {
		if b.LineID != chosen && slices.Contains(c.LineIDs, b.LineID) && b.ParentLineID == line && b.Status == "open" {
			w.inv.violate("decide %s: the sibling %s is still open", c.ID, b.LineID)
		}
	}
}
