package tangent_test

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// withLeaf replaces the leaf feature of a feature list.
func withLeaf(mode tangent.Mode) func([]tangent.Feature) []tangent.Feature {
	return func(features []tangent.Feature) []tangent.Feature {
		out := []tangent.Feature{}
		for _, f := range features {
			if f.Name() != tangent.FeatureLeaf {
				out = append(out, f)
			}
		}
		return append(out, tangent.Leaf(mode))
	}
}

// branchWithTurn opens a branch on a fresh main line and runs one turn in it.
func (e *env) branchWithTurn(purpose string) (domain.LineView, tangent.CreatedBranch) {
	e.t.Helper()
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, purpose)
	e.turn(branch.Line.ID, "inside", "found it")
	return main, branch
}

func (e *env) mergeWithCard(lineID string, card domain.BranchCard) tangent.MergedBranch {
	e.t.Helper()
	detail, err := e.engine.GetBranch(e.ctx, scopeA, lineID)
	if err != nil {
		e.t.Fatal(err)
	}
	merged, err := e.engine.MergeBranch(e.ctx, scopeA, lineID, tangent.MergeInput{Card: card, ParentTipMessageID: detail.ParentTipMessageID})
	if err != nil {
		e.t.Fatal(err)
	}
	return merged
}

func TestLeaf_AMergeLeavesTheCardsConclusion(t *testing.T) {
	e := newEnvWith(t, p1Features())
	_, branch := e.branchWithTurn("hotels")
	if _, err := e.engine.PutLeaf(e.ctx, scopeA, branch.Line.ID, domain.LeafInput{Kind: domain.LeafKindToContinue, Line: "half way"}); err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	merged := e.mergeWithCard(branch.Line.ID, domain.BranchCard{Question: "Which hotel?", Conclusion: "The ryokan"})
	leaf, err := e.engine.GetLeaf(e.ctx, scopeA, branch.Line.ID)
	if err != nil || leaf == nil || leaf.Kind != domain.LeafKindConclusion || leaf.Line != "The ryokan" || leaf.Body != "Which hotel?" ||
		leaf.Status != domain.LeafStatusConfirmed || leaf.CreatedBy != scopeA.Actor || leaf.AIDrafted {
		t.Fatalf("leaf = %+v %v", leaf, err)
	}
	types := e.events.Types()
	if i := slices.Index(types, tangent.EventLeafChanged); i < slices.Index(types, tangent.EventBranchChanged) {
		t.Fatalf("leaf.changed after the branch: %v", types)
	}
	if merged.Branch.Leaf == nil || merged.Branch.Leaf.Line != "The ryokan" {
		t.Fatalf("the merge's view shows the new leaf: %+v", merged.Branch.Leaf)
	}
	outline, _ := e.engine.ListBranches(e.ctx, scopeA, branch.Line.ID, false)
	if outline[0].Leaf == nil || outline[0].Leaf.Line != "The ryokan" {
		t.Fatalf("outline = %+v", outline[0].Leaf)
	}
	if strings.Contains(e.lastSystem(), "The ryokan") {
		t.Fatal("unreachable: no turn ran since")
	}
	e.turn(branch.Branch.ParentLineID, "next", "ok")
	if strings.Contains(e.lastSystem(), "Leaf") || strings.Contains(e.lastSystem(), domain.LeafDraftMarker) {
		t.Fatalf("a leaf never enters a turn prompt:\n%s", e.lastSystem())
	}
}

func TestLeaf_ADiscardCarriesADeadEndOrIsRefusedWithoutTheFeature(t *testing.T) {
	e := newEnvWith(t, p1Features())
	_, branch := e.branchWithTurn("osaka")
	bad := &domain.LeafInput{Kind: "nope", Line: "x"}
	_, err := e.engine.DiscardBranchWith(e.ctx, scopeA, branch.Line.ID, tangent.DiscardInput{Leaf: bad})
	wantCode(t, err, domain.CodeInvalidLeaf)
	if detail, _ := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID); detail.Branch.Status != domain.BranchStatusOpen {
		t.Fatal("an invalid leaf rolls the discard back")
	}
	e.events.Reset()
	view, err := e.engine.DiscardBranchWith(e.ctx, scopeA, branch.Line.ID, tangent.DiscardInput{Leaf: &domain.LeafInput{Line: "too far"}})
	if err != nil || view.Status != domain.BranchStatusDiscarded {
		t.Fatalf("discard = %+v %v", view, err)
	}
	leaf, _ := e.engine.GetLeaf(e.ctx, scopeA, branch.Line.ID)
	if leaf == nil || leaf.Kind != domain.LeafKindDeadEnd || leaf.Line != "too far" || len(e.events.OfType(tangent.EventLeafChanged)) != 1 {
		t.Fatalf("leaf = %+v, events %v", leaf, e.events.Types())
	}

	off := newEnvWith(t, tangent.AllFeatures())
	_, other := off.branchWithTurn("osaka")
	_, err = off.engine.DiscardBranchWith(off.ctx, scopeA, other.Line.ID, tangent.DiscardInput{Leaf: &domain.LeafInput{Line: "x"}})
	wantCode(t, err, domain.CodeFeatureDisabled)
	for _, call := range []func() error{
		func() error { _, err := off.engine.GetLeaf(off.ctx, scopeA, other.Line.ID); return err },
		func() error {
			_, err := off.engine.PutLeaf(off.ctx, scopeA, other.Line.ID, domain.LeafInput{Kind: "answer", Line: "x"})
			return err
		},
		func() error { _, err := off.engine.DeleteLeaf(off.ctx, scopeA, other.Line.ID); return err },
		func() error { _, err := off.engine.StartLeafDraft(off.ctx, scopeA, other.Line.ID); return err },
	} {
		wantCode(t, call(), domain.CodeFeatureDisabled)
	}
	off.mergeWithCard(other.Line.ID, domain.BranchCard{Question: "q", Conclusion: "c"})
	if n := off.count(`SELECT count(*) FROM tangent_leaf`); n != 0 {
		t.Fatalf("no leaf without the feature: %d", n)
	}
}

func TestLeaf_SuggestModeDraftsForADiscardAndAPromotion(t *testing.T) {
	e := newEnvWith(t, p1Features())
	sink := &recordingDispatcher{}
	e.engine.SetJobDispatcher(sink)
	main, discarded := e.branchWithTurn("osaka")
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, discarded.Line.ID); err != nil {
		t.Fatal(err)
	}
	if len(sink.jobs) != 1 || sink.jobs[0].Kind != tangent.JobKindLeafDraft || sink.jobs[0].LineID != discarded.Line.ID {
		t.Fatalf("jobs = %+v", sink.jobs)
	}
	job := sink.jobs[0]
	if !strings.Contains(job.Prompt.UserMessage, "found it") || !strings.Contains(job.Prompt.UserMessage, domain.LeafDraftMarker) {
		t.Fatalf("prompt = %s", job.Prompt.UserMessage)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, job.ID, domain.LeafDraftMarker+`{"kind":"dead_end","line":"too far away"}`, nil); err != nil {
		t.Fatal(err)
	}
	leaf, _ := e.engine.GetLeaf(e.ctx, scopeA, discarded.Line.ID)
	if leaf == nil || leaf.Status != domain.LeafStatusDraft || !leaf.AIDrafted || len(e.events.OfType(tangent.EventLeafChanged)) != 1 {
		t.Fatalf("draft = %+v", leaf)
	}
	anchor := e.turn(main.ID, "more", "sure")
	promoted := e.branch(main.ID, anchor.Message.ID, "spring")
	e.turn(main.ID, "old tail", "kept")
	e.turn(promoted.Line.ID, "spring?", "yes")
	result, err := e.engine.PromoteBranch(e.ctx, scopeA, promoted.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(sink.jobs) != 2 || sink.jobs[1].LineID != result.PreviousID {
		t.Fatalf("the previous main line is drafted: %+v", sink.jobs)
	}
}

func TestLeaf_AutoConfirmsManualOnlyWhenAsked(t *testing.T) {
	auto := newEnvWith(t, p1Features(withLeaf(tangent.ModeAuto)))
	sink := &recordingDispatcher{}
	auto.engine.SetJobDispatcher(sink)
	_, branch := auto.branchWithTurn("osaka")
	if _, err := auto.engine.DiscardBranch(auto.ctx, scopeA, branch.Line.ID); err != nil {
		t.Fatal(err)
	}
	if err := auto.engine.FinishJob(auto.ctx, sink.jobs[0].ID, domain.LeafDraftMarker+`{"kind":"answer","line":"it is far"}`, nil); err != nil {
		t.Fatal(err)
	}
	if leaf, _ := auto.engine.GetLeaf(auto.ctx, scopeA, branch.Line.ID); leaf == nil || leaf.Status != domain.LeafStatusConfirmed || !leaf.AIDrafted {
		t.Fatalf("auto = %+v", leaf)
	}

	manual := newEnvWith(t, p1Features(withLeaf(tangent.ModeManual)))
	manualSink := &recordingDispatcher{}
	manual.engine.SetJobDispatcher(manualSink)
	_, other := manual.branchWithTurn("osaka")
	if _, err := manual.engine.DiscardBranch(manual.ctx, scopeA, other.Line.ID); err != nil || len(manualSink.jobs) != 0 {
		t.Fatalf("manual drafts nothing by itself: %+v %v", manualSink.jobs, err)
	}
	job, err := manual.engine.StartLeafDraft(manual.ctx, scopeA, other.Line.ID)
	if err != nil || job.Kind != tangent.JobKindLeafDraft {
		t.Fatalf("job = %+v %v", job, err)
	}
	empty := manual.mainLine()
	anchor := manual.turn(empty.ID, "q", "a")
	bare := manual.branch(empty.ID, anchor.Message.ID, "nothing yet")
	_, err = manual.engine.StartLeafDraft(manual.ctx, scopeA, bare.Line.ID)
	wantCode(t, err, domain.CodeNoMessages)
	_, err = manual.engine.StartLeafDraft(manual.ctx, scopeA, empty.ID)
	wantCode(t, err, domain.CodeBranchNotFound)
}

func TestLeaf_DraftsYieldToTheOperatorAndFailCleanly(t *testing.T) {
	e := newEnvWith(t, p1Features())
	_, branch := e.branchWithTurn("osaka")
	first, err := e.engine.StartLeafDraft(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.PutLeaf(e.ctx, scopeA, branch.Line.ID, domain.LeafInput{Kind: "decision", Line: "mine"}); err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, first.ID, domain.LeafDraftMarker+`{"kind":"answer","line":"ai"}`, nil); err != nil {
		t.Fatal(err)
	}
	if leaf, _ := e.engine.GetLeaf(e.ctx, scopeA, branch.Line.ID); leaf.Line != "mine" || len(e.events.Events()) != 0 {
		t.Fatalf("the operator's leaf stays: %+v %v", leaf, e.events.Types())
	}
	failed, _ := e.engine.StartLeafDraft(e.ctx, scopeA, branch.Line.ID)
	if err := e.engine.FinishJob(e.ctx, failed.ID, "", errors.New("down")); err != nil {
		t.Fatal(err)
	}
	unusable, _ := e.engine.StartLeafDraft(e.ctx, scopeA, branch.Line.ID)
	if err := e.engine.FinishJob(e.ctx, unusable.ID, "no marker here", nil); err != nil {
		t.Fatal(err)
	}
	if n := e.count(`SELECT count(*) FROM tangent_job WHERE kind = 'leaf_draft' AND status = 'failed'`); n != 2 {
		t.Fatalf("failed jobs = %d", n)
	}
	err = e.engine.FinishJob(e.ctx, failed.ID, domain.LeafDraftMarker+`{"kind":"answer","line":"late"}`, nil)
	wantCode(t, err, domain.CodeJobNotPending)
	e.rollsBack("delete leaf", func(opt tangent.TxOption) error {
		_, err := e.engine.DeleteLeaf(e.ctx, scopeA, branch.Line.ID, opt)
		return err
	})
	e.rollsBack("start leaf draft", func(opt tangent.TxOption) error {
		_, err := e.engine.StartLeafDraft(e.ctx, scopeA, branch.Line.ID, opt)
		return err
	})
	deleted, err := e.engine.DeleteLeaf(e.ctx, scopeA, branch.Line.ID)
	if err != nil || deleted.Line != "mine" {
		t.Fatalf("deleted = %+v %v", deleted, err)
	}
	if leaf, err := e.engine.GetLeaf(e.ctx, scopeA, branch.Line.ID); err != nil || leaf != nil {
		t.Fatalf("gone: %+v %v", leaf, err)
	}
	e.rollsBack("put leaf", func(opt tangent.TxOption) error {
		_, err := e.engine.PutLeaf(e.ctx, scopeA, branch.Line.ID, domain.LeafInput{Kind: "answer", Line: "x"}, opt)
		return err
	})
}
