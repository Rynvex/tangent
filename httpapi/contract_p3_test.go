package httpapi_test

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// p3 walks the B10 part A routes on an engine of its own with ibis and fold
// in suggest mode (tags and a closed chapter every second reply): the
// tags a turn drafts, the operator's tags, a fold suggestion accepted, a
// drafted fold, the folded preview, the outline's anchor tags and the
// refusals.
func (f *flow) p3() *harness {
	limits := domain.DefaultLimits()
	limits.Fold.SuggestEvery, limits.Fold.SuggestMinMessages, limits.Fold.SuggestMinTokens = 2, 4, 1
	limits.Ibis.Every = 2
	h := newHarness(f.t, func(c *harnessConfig) {
		c.features = append(without(c.features, tangent.FeatureIbis, tangent.FeatureFold), tangent.Ibis(tangent.ModeSuggest), tangent.Fold(tangent.ModeSuggest))
		c.engineOpts = append(c.engineOpts, tangent.WithLimits(limits))
	})
	g := &flow{harness: h, s: f.s}
	g.main = g.ok(http.StatusCreated, g.do(http.MethodPost, "/lines", map[string]any{"title": "Home storage", "provider": "fake", "model": "fake-1"}))["id"].(string)
	g.turn(g.main, "Which file system for the NAS?")
	g.turn(g.main, "ZFS or Btrfs?")
	g.dispatcher.Wait()
	g.call("messages.list.tagged", http.StatusOK, http.MethodGet, "/lines/"+g.main+"/messages", nil)
	ids := g.mainMessages(g.main)
	g.call("messages.tag", http.StatusOK, http.MethodPut, "/messages/"+ids[1]+"/tag", map[string]any{"kind": "decision"})
	g.call("messages.untag", http.StatusOK, http.MethodDelete, "/messages/"+ids[3]+"/tag", nil)
	g.turn(g.main, "And the backups?")
	ids = g.mainMessages(g.main)
	g.ok(http.StatusCreated, g.do(http.MethodPost, "/lines/"+g.main+"/chapters/milestones", map[string]any{"messageId": ids[4], "title": "Backups"}))
	g.turn(g.main, "Offsite as well?")
	g.dispatcher.Wait()
	g.p3Folds(g.mainMessages(g.main))
	g.b15Tags(ids[1])
	return h
}

func (f *flow) p3Folds(ids []string) {
	list := f.call("suggestions.list.fold", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/suggestions", nil)
	suggestions := list["suggestions"].([]any)
	if len(suggestions) != 1 || suggestions[0].(map[string]any)["kind"] != tangent.SuggestionKindFold {
		f.t.Fatalf("one fold suggestion: %v", list)
	}
	id := suggestions[0].(map[string]any)["id"].(string)
	f.call("suggestions.accept.fold", http.StatusOK, http.MethodPost, "/suggestions/"+id+"/accept", map[string]any{})
	created := f.call("folds.create", http.StatusCreated, http.MethodPost, "/lines/"+f.main+"/folds", map[string]any{"fromMessageId": ids[4], "toMessageId": ids[5]})
	f.dispatcher.Wait()
	f.call("folds.list", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/folds", nil)
	f.call("folds.update", http.StatusOK, http.MethodPatch, "/folds/"+field(created, "fold", "id").(string), map[string]any{"summary": "Backups: offsite as well."})
	f.call("preview.folds", http.StatusOK, http.MethodPost, "/lines/"+f.main+"/preview", map[string]any{"content": "So, which one?"})
	f.harness.branch(f.main, ids[2], "Btrfs in depth")
	f.call("branches.list.anchor_tag", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/branches", nil)
	f.fail("error.fold_overlap", http.StatusConflict, http.MethodPost, "/lines/"+f.main+"/folds", map[string]any{"fromMessageId": ids[3], "toMessageId": ids[4], "summary": "x"})
	f.fail("error.invalid_fold", http.StatusUnprocessableEntity, http.MethodPost, "/lines/"+f.main+"/folds", map[string]any{"fromMessageId": ids[6], "toMessageId": ids[6], "summary": "x"})
	fold := field(created, "fold", "id").(string)
	f.call("folds.delete", http.StatusNoContent, http.MethodDelete, "/folds/"+fold, nil)
	f.fail("error.fold_not_found", http.StatusNotFound, http.MethodDelete, "/folds/"+fold, nil)
}
