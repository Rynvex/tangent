package tangent_test

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// p1bFeatures is p1Features plus spinoff and rebalance (suggest).
func p1bFeatures(mutate ...func([]tangent.Feature) []tangent.Feature) []tangent.Feature {
	return p1Features(append([]func([]tangent.Feature) []tangent.Feature{func(f []tangent.Feature) []tangent.Feature {
		return append(f, tangent.Spinoff(), tangent.Rebalance(tangent.ModeSuggest))
	}}, mutate...)...)
}

// dropFeature removes a feature from a list.
func dropFeature(name string) func([]tangent.Feature) []tangent.Feature {
	return func(features []tangent.Feature) []tangent.Feature {
		out := []tangent.Feature{}
		for _, f := range features {
			if f.Name() != name {
				out = append(out, f)
			}
		}
		return out
	}
}

func TestSpinoff_DetachMakesTheBranchAConversationOfItsOwn(t *testing.T) {
	e := newEnvWith(t, p1bFeatures())
	main, branch := e.branchWithTurn("Spring instead")
	inner := e.turn(branch.Line.ID, "cherry blossoms?", "early April")
	child := e.branch(branch.Line.ID, inner.Message.ID, "Which park")
	if _, err := e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: "add", Section: "decided", Text: "go in spring"}}); err != nil {
		t.Fatal(err)
	}
	e.rollsBack("detach", func(opt tangent.TxOption) error {
		_, err := e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach}, opt)
		return err
	})
	e.events.Reset()
	out, err := e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach, Title: "Spring trip", CopyNotes: true})
	if err != nil {
		t.Fatal(err)
	}
	if out.Line.ID != branch.Line.ID || out.Line.ConversationBranch != nil || out.Line.SpunOffFrom == nil || out.Line.SpunOffFrom.LineID != main.ID {
		t.Fatalf("line = %+v", out.Line)
	}
	types := e.events.Types()
	for _, want := range []string{tangent.EventLineCreated, tangent.EventMessageCreated, tangent.EventLinkChanged, tangent.EventBranchChanged, tangent.EventNotesChanged} {
		if !slices.Contains(types, want) {
			t.Fatalf("no %s: %v", want, types)
		}
	}
	changes := []string{}
	for _, ev := range e.events.OfType(tangent.EventBranchChanged) {
		changes = append(changes, ev.Data.(tangent.BranchChange).Change)
	}
	if !slices.Equal(changes, []string{tangent.BranchDetached, tangent.BranchMoved}) || len(e.events.OfType(tangent.EventLinkChanged)) != 2 {
		t.Fatalf("changes %v, events %v", changes, types)
	}
	moved := e.events.OfType(tangent.EventBranchChanged)[1].Data.(tangent.BranchChange).Branch
	if moved.LineID != child.Line.ID || moved.RootLineID != branch.Line.ID || moved.Depth != 1 {
		t.Fatalf("the child moved to the new tree: %+v", moved)
	}
	checkSpunOffPrompt(t, e, main.ID, out, inner.Message.ID)
}

// checkSpunOffPrompt checks the new main line's prompt, its links and that
// the old tree lost the branch.
func checkSpunOffPrompt(t *testing.T, e *env, mainID string, out tangent.SpunOff, innerID string) {
	t.Helper()
	e.turn(out.Line.ID, "go on", "sure")
	system := e.lastSystem()
	if !strings.Contains(system, "Where this conversation came from") || !strings.Contains(system, "go in spring") ||
		strings.Index(system, "Where this conversation came from") > strings.Index(system, "go in spring") {
		t.Fatalf("the prompt starts with the capsule, then the copied notes:\n%s", system)
	}
	links, err := e.engine.ListLinks(e.ctx, scopeA, mainID)
	if err != nil || len(links) != 1 || links[0].ToLineID != out.Line.ID {
		t.Fatalf("links = %+v %v", links, err)
	}
	outline, _ := e.engine.ListBranches(e.ctx, scopeA, mainID, true)
	if len(outline) != 0 {
		t.Fatalf("the old tree lost the branch: %+v", outline)
	}
	e.branch(out.Line.ID, innerID, "a new branch in the new tree")
}

func TestSpinoff_FreshCarriesThePathTheLeafAndTheBudget(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Spinoff.CapsuleTokenBudget = 400
	e := newEnvWith(t, p1bFeatures(), tangent.WithLimits(limits))
	_, branch := e.branchWithTurn("Hotels")
	at := e.turn(branch.Line.ID, strings.Repeat("long question ", 200), "the answer to keep")
	if _, err := e.engine.PutLeaf(e.ctx, scopeA, branch.Line.ID, domain.LeafInput{Kind: "to_continue", Line: "half way there"}); err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	out, err := e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffFresh, AtMessageID: at.Message.ID})
	if err != nil {
		t.Fatal(err)
	}
	capsule := out.Line.Capsule
	if out.Line.Title != "Hotels" || capsule == nil || !capsule.Truncated || capsule.TokenEstimate > 400 || !strings.Contains(capsule.Rendered, "half way there") {
		t.Fatalf("capsule = %+v", capsule)
	}
	if out.Branch.LineID != "" || len(e.events.OfType(tangent.EventBranchChanged)) != 0 {
		t.Fatal("a fresh spinoff changes no branch")
	}
	_, err = e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffFresh, AtMessageID: out.Line.ID})
	wantCode(t, err, domain.CodeAnchorNotFound)
	_, err = e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: "copy"})
	wantCode(t, err, domain.CodeInvalidInput)
	_, err = e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach, Title: strings.Repeat("t", 201)})
	wantCode(t, err, domain.CodeTooLong)
}

func TestSpinoff_OffRefusesAndCapsulesStay(t *testing.T) {
	e := newEnvWith(t, p1bFeatures(dropFeature(tangent.FeatureRebalance), dropFeature(tangent.FeatureSpinoff)))
	main, branch := e.branchWithTurn("x")
	_, err := e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach})
	wantCode(t, err, domain.CodeFeatureDisabled)
	_, err = e.engine.ListLinks(e.ctx, scopeA, main.ID)
	wantCode(t, err, domain.CodeFeatureDisabled)
	caps, _ := e.engine.Capabilities(e.ctx, scopeA)
	if capability(caps, tangent.FeatureSpinoff).Enabled || capability(caps, tangent.FeatureRebalance).Mode != "off" {
		t.Fatalf("caps = %+v", caps)
	}
}

func TestSpinoff_ConcurrentDetachAndPromoteLeaveOneWinner(t *testing.T) {
	e := newEnvWith(t, p1bFeatures())
	for range 3 {
		_, branch := e.branchWithTurn("contested")
		var wg sync.WaitGroup
		errs := make([]error, 2)
		wg.Go(func() {
			_, errs[0] = e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach})
		})
		wg.Go(func() { _, errs[1] = e.engine.PromoteBranch(e.ctx, scopeA, branch.Line.ID) })
		wg.Wait()
		if (errs[0] == nil) == (errs[1] == nil) {
			t.Fatalf("one of detach / promote wins: %v", errs)
		}
	}
}

func TestInbox_TheOpenCountFollowsThePolicy(t *testing.T) {
	p := &switchPolicy{off: map[string]bool{}}
	e := newEnvWith(t, p1Features(), tangent.WithFeaturePolicy(p))
	main := e.mainLine()
	e.probed(main.ID, tangent.ProbeDirective)
	line, _ := e.engine.GetLine(e.ctx, scopeA, main.ID)
	if line.OpenSuggestions != 1 {
		t.Fatalf("on: %d", line.OpenSuggestions)
	}
	p.set(tangent.FeatureSuggestionProbe, true)
	line, _ = e.engine.GetLine(e.ctx, scopeA, main.ID)
	page, _ := e.engine.ListLines(e.ctx, scopeA, tangent.LineQuery{})
	if line.OpenSuggestions != 0 || page.Lines[0].OpenSuggestions != 0 {
		t.Fatalf("the probe is off for the tenant: %d / %d", line.OpenSuggestions, page.Lines[0].OpenSuggestions)
	}
}

// switchPolicy switches features off at run time.
type switchPolicy struct {
	mu  sync.Mutex
	off map[string]bool
}

func (p *switchPolicy) set(feature string, off bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.off[feature] = off
}

func (p *switchPolicy) Mode(_ context.Context, _ tangent.Scope, feature string) tangent.Mode {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.off[feature] {
		return tangent.ModeOff
	}
	return tangent.ModeAuto
}

func TestSpinoff_TheDetachedLinesOwnSuggestionsExpireInTheOldTree(t *testing.T) {
	e := newEnvWith(t, p1bFeatures())
	main, branch := e.branchWithTurn("detach me")
	own := e.probed(branch.Line.ID, tangent.ProbeDirective)
	inner := e.turn(branch.Line.ID, "inner", "x")
	child := e.branch(branch.Line.ID, inner.Message.ID, "below")
	below := e.probed(child.Line.ID, tangent.ProbeDirective)
	e.events.Reset()
	if _, err := e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach}); err != nil {
		t.Fatal(err)
	}
	changed := e.events.OfType(tangent.EventSuggestionChanged)
	if len(changed) != 1 {
		t.Fatalf("one suggestion.changed: %v", e.events.Types())
	}
	expired := changed[0].Data.(tangent.SuggestionChange)
	if expired.Suggestion.ID != own.ID || expired.Suggestion.Status != domain.SuggestionExpired || expired.RootLineID != main.ID || changed[0].RootLineID != main.ID {
		t.Fatalf("expired in the old tree: %+v", expired)
	}
	moved, _ := e.engine.ListSuggestions(e.ctx, scopeA, branch.Line.ID, nil)
	if len(moved.Suggestions) != 1 || moved.Suggestions[0].ID != below.ID || moved.RootLineID != branch.Line.ID {
		t.Fatalf("the subtree's suggestion moved: %+v", moved)
	}
	if line, _ := e.engine.GetLine(e.ctx, scopeA, branch.Line.ID); line.OpenSuggestions != 1 {
		t.Fatalf("the new tree counts the moved one only: %d", line.OpenSuggestions)
	}
}
