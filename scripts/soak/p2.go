package main

import (
	"context"
	"fmt"
	"slices"
)

// goal writes, reads, clears or asks the AI for the conversation's goal.
func (w *worker) goal(ctx context.Context, t *tree, line string) {
	path := "/lines/" + line + "/goal"
	switch roll := w.rng.IntN(100); {
	case roll < 40:
		var out struct {
			Goal struct {
				RootLineID string `json:"rootLineId"`
			} `json:"goal"`
		}
		err := w.c.call(ctx, "PUT", path, map[string]any{"text": fmt.Sprintf("目標 goal %d", w.rng.IntN(1e6))}, &out)
		if w.st.classify("goal put", err) && err == nil && out.Goal.RootLineID != t.main {
			w.st.fail("goal put", "the goal of %s is on %q", t.main, out.Goal.RootLineID)
		}
	case roll < 60:
		w.st.classify("goal delete", w.c.call(ctx, "DELETE", path, nil, nil), "goal_not_found")
	case roll < 85:
		w.st.classify("goal propose", w.c.call(ctx, "POST", path+"/propose", nil, nil))
	default:
		w.st.classify("goal get", w.c.call(ctx, "GET", path, nil, nil))
	}
}

// relation is one drawn link between two places.
type relation struct {
	ID string `json:"id"`
}

// relations draws a link between two lines (or a message and a line) of
// the tree or to a conversation it spun off, then sometimes relabels or
// deletes one of the tree's links.
func (w *worker) relations(ctx context.Context, t *tree, line string) {
	targets := slices.DeleteFunc(append(slices.Clone(t.lines), t.others...), func(l string) bool { return l == line })
	if len(targets) > 0 {
		body := map[string]any{"fromLineId": line, "toLineId": targets[w.rng.IntN(len(targets))], "label": "soak"}
		if anchor, ok := w.anchor(ctx, line); ok && w.rng.IntN(2) == 0 {
			body["fromMessageId"] = anchor
		}
		w.st.classify("relation create", w.c.call(ctx, "POST", "/lines/"+t.main+"/relations", body, nil), "relation_exists", "relation_limit")
	}
	var list struct {
		Relations []relation `json:"relations"`
	}
	if err := w.c.call(ctx, "GET", "/lines/"+t.main+"/relations", nil, &list); !w.st.classify("relation list", err) || err != nil {
		return
	}
	if len(list.Relations) == 0 || w.rng.IntN(3) == 0 {
		w.st.op("relations", "kept")
		return
	}
	r := list.Relations[w.rng.IntN(len(list.Relations))]
	if w.rng.IntN(2) == 0 {
		w.st.classify("relation label", w.c.call(ctx, "PATCH", "/lines/"+t.main+"/relations/"+r.ID, map[string]any{"label": fmt.Sprintf("關聯 label %d", w.rng.IntN(1000))}, nil), "relation_not_found")
	} else {
		w.st.classify("relation delete", w.c.call(ctx, "DELETE", "/lines/"+t.main+"/relations/"+r.ID, nil, nil), "relation_not_found")
	}
}

// openLoops reads the conversation's and the tenant's open loops.
func (w *worker) openLoops(ctx context.Context, t *tree, _ string) {
	var out struct {
		StaleBranches *struct {
			Total int `json:"total"`
		} `json:"staleBranches"`
	}
	path := "/open-loops"
	if w.rng.IntN(2) == 0 {
		path += "?staleDays=1&root=" + t.main
	}
	if err := w.c.call(ctx, "GET", path, nil, &out); w.st.classify("open loops", err) && err == nil && out.StaleBranches == nil {
		w.st.fail("open loops", "no staleBranches in the answer")
	}
}

// group is one group of ended branches.
type group struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// groups groups ended branches with a leaf, then sometimes renames,
// re-summarises or dissolves one of the tree's active groups.
func (w *worker) groups(ctx context.Context, t *tree, _ string) {
	ended := t.branchesWhere(func(b branchView) bool {
		return (b.Status == "merged" || b.Status == "discarded") && b.Kind != "aside" && (b.Leaf != nil || b.Status == "merged")
	})
	if len(ended) >= 2 {
		w.rng.Shuffle(len(ended), func(i, j int) { ended[i], ended[j] = ended[j], ended[i] })
		members := []string{}
		for _, b := range ended[:min(len(ended), 2+w.rng.IntN(2))] {
			members = append(members, b.LineID)
		}
		body := map[string]any{"memberLineIds": members, "title": fmt.Sprintf("群組 group %d", w.rng.IntN(1000))}
		w.st.classify("group create", w.c.call(ctx, "POST", "/lines/"+t.main+"/groups", body, nil), "invalid_group", "group_limit")
	}
	var list struct {
		Groups []group `json:"groups"`
	}
	if err := w.c.call(ctx, "GET", "/lines/"+t.main+"/groups", nil, &list); !w.st.classify("group list", err) || err != nil {
		return
	}
	if len(list.Groups) == 0 || w.rng.IntN(4) == 0 {
		w.st.op("groups", "kept")
		return
	}
	g := list.Groups[w.rng.IntN(len(list.Groups))]
	switch roll := w.rng.IntN(100); {
	case roll < 30:
		w.st.classify("group rename", w.c.call(ctx, "PATCH", "/groups/"+g.ID, map[string]any{"title": fmt.Sprintf("renamed group %d", w.rng.IntN(1000))}, nil), "group_not_active")
	case roll < 60:
		w.st.classify("group summarize", w.c.call(ctx, "POST", "/groups/"+g.ID+"/summarize", nil, nil))
	default:
		w.st.classify("group dissolve", w.c.call(ctx, "POST", "/groups/"+g.ID+"/dissolve", nil, nil), "group_not_active")
	}
}

// openSiblings are the open, non-aside branches right under parent.
func (t *tree) openSiblings(parent string) []branchView {
	return t.branchesWhere(func(b branchView) bool {
		return b.ParentLineID == parent && b.Status == "open" && b.Kind != "aside"
	})
}

// combine merges two open branches of one parent into a new one.
func (w *worker) combine(ctx context.Context, t *tree, line string) {
	siblings := t.openSiblings(line)
	if len(siblings) < 2 {
		w.st.op("combine", "skipped: fewer than two open branches")
		return
	}
	w.rng.Shuffle(len(siblings), func(i, j int) { siblings[i], siblings[j] = siblings[j], siblings[i] })
	body := map[string]any{"lineIds": []string{siblings[0].LineID, siblings[1].LineID}, "purpose": fmt.Sprintf("合併 combined %d", w.rng.IntN(1000))}
	if w.rng.IntN(2) == 0 {
		body["conflicts"] = []map[string]any{{
			"branch": map[string]any{"lineId": siblings[0].LineID, "claim": "this one"}, "other": map[string]any{"lineId": siblings[1].LineID, "claim": "that one"},
			"choice": []string{"adoptBranch", "adoptOther", "keepBoth"}[w.rng.IntN(3)],
		}}
	}
	var out struct {
		Branch   branchView   `json:"branch"`
		Combined []branchView `json:"combined"`
	}
	err := w.c.call(ctx, "POST", "/lines/"+line+"/branches/combine", body, &out)
	if w.st.classify("combine", err, "invalid_group") && err == nil {
		for _, old := range out.Combined {
			if old.Status != "discarded" || old.MergedIntoLineID != out.Branch.LineID {
				w.st.fail("combine", "combined branch %s is %s into %q, not into %s", old.LineID, old.Status, old.MergedIntoLineID, out.Branch.LineID)
			}
		}
	}
	w.refreshLines(ctx, t)
}

// pins pins a finished message and sometimes takes the pin back.
func (w *worker) pins(ctx context.Context, _ *tree, line string) {
	anchor, ok := w.anchor(ctx, line)
	if !ok {
		w.st.op("pins", "skipped: no message")
		return
	}
	var out struct {
		Message message `json:"message"`
	}
	if err := w.c.call(ctx, "POST", "/messages/"+anchor+"/pin", nil, &out); !w.st.classify("pin", err) || err != nil {
		return
	}
	if !out.Message.Pinned {
		w.st.fail("pin", "message %s is not pinned after a pin", anchor)
	}
	if w.rng.IntN(2) == 0 {
		w.st.classify("unpin", w.c.call(ctx, "DELETE", "/messages/"+anchor+"/pin", nil, nil))
	}
}

// appliedFold is a fold the preview says stood for its messages.
type appliedFold struct {
	FoldID string `json:"foldId"`
}

// previewView is what the driver reads of POST /preview.
type previewView struct {
	Fisheye *struct {
		Items []struct {
			Kind string `json:"kind"`
			ID   string `json:"id"`
		} `json:"items"`
	} `json:"fisheye"`
	Folds    []appliedFold `json:"folds"`
	Memories []struct {
		Memory struct {
			ID string `json:"id"`
		} `json:"memory"`
	} `json:"memories"`
}

// preview reads what the next turn would send; with fisheye on, the
// answer must carry the fisheye's choice.
func (w *worker) preview(ctx context.Context, line string) (previewView, bool) {
	return w.previewWith(ctx, line, "preview", "preview")
}

func (w *worker) previewWith(ctx context.Context, line, op, content string) (previewView, bool) {
	var out previewView
	err := w.c.call(ctx, "POST", "/lines/"+line+"/preview", map[string]any{"content": content}, &out)
	if !w.st.classify(op, err) || err != nil {
		return out, false
	}
	if w.feats.on("fisheye") {
		if out.Fisheye == nil {
			w.st.fail(op, "fisheye is on but the preview of %s has no fisheye", line)
			return out, false
		}
		w.st.op("fisheye preview", "ok")
	}
	return out, true
}
