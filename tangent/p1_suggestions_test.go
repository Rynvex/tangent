package tangent_test

import (
	"encoding/json"
	"sync"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// p1Features is every first-batch feature plus the P1 ones and the probe
// that raises suggestions.
func p1Features(mutate ...func([]tangent.Feature) []tangent.Feature) []tangent.Feature {
	features := append(tangent.AllFeatures(), tangent.Leaf(tangent.ModeSuggest), tangent.Parking(), tangent.SuggestionProbe())
	for _, m := range mutate {
		features = m(features)
	}
	return features
}

// probed runs a turn whose reply asks the probe for a suggestion and
// returns the suggestion it raised.
func (e *env) probed(lineID, directive string) domain.Suggestion {
	e.t.Helper()
	e.events.Reset()
	e.turn(lineID, "q", "sure "+directive)
	changed := e.events.OfType(tangent.EventSuggestionChanged)
	if len(changed) != 1 {
		e.t.Fatalf("one suggestion.changed, got %v", e.events.Types())
	}
	return changed[0].Data.(tangent.SuggestionChange).Suggestion
}

func TestInbox_TheProbeRaisesOneOpenSuggestionPerTarget(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main := e.mainLine()
	s := e.probed(main.ID, tangent.ProbeDirective)
	if s.Status != domain.SuggestionOpen || s.Feature != tangent.FeatureSuggestionProbe || s.Kind != tangent.ProbeKind || s.TargetKey != "line:"+main.ID {
		t.Fatalf("suggestion = %+v", s)
	}
	types := e.events.Types()
	if types[len(types)-1] != tangent.EventLineUpdated {
		t.Fatalf("the main line's count is republished last: %v", types)
	}
	line, _ := e.engine.GetLine(e.ctx, scopeA, main.ID)
	if line.OpenSuggestions != 1 {
		t.Fatalf("open suggestions = %d", line.OpenSuggestions)
	}
	e.events.Reset()
	e.turn(main.ID, "q", "again "+tangent.ProbeDirective)
	if len(e.events.OfType(tangent.EventSuggestionChanged)) != 0 {
		t.Fatal("a target has one open suggestion")
	}
	list, err := e.engine.ListSuggestions(e.ctx, scopeA, main.ID, nil)
	if err != nil || len(list.Suggestions) != 1 || list.RootLineID != main.ID {
		t.Fatalf("list = %+v %v", list, err)
	}
	if _, err := e.engine.ListSuggestions(e.ctx, scopeA, main.ID, []string{"nope"}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("bad status: %v", err)
	}
	caps, _ := e.engine.Capabilities(e.ctx, scopeA)
	if !capability(caps, tangent.FeatureSuggestions).Enabled || !e.engine.FeatureConfigured(tangent.FeatureSuggestions) {
		t.Fatalf("the inbox is on: %+v", caps)
	}
}

func capability(caps []tangent.Capability, name string) tangent.Capability {
	for _, c := range caps {
		if c.Name == name {
			return c
		}
	}
	return tangent.Capability{}
}

func TestInbox_AcceptRunsInOneTransactionAndOnce(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main := e.mainLine()
	s := e.probed(main.ID, tangent.ProbeDirective)
	e.rollsBack("accept", func(opt tangent.TxOption) error {
		_, err := e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, nil, opt)
		return err
	})
	e.events.Reset()
	accepted, err := e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, json.RawMessage(`{}`))
	if err != nil || accepted.Suggestion.Status != domain.SuggestionAccepted || accepted.Suggestion.DecidedAt == nil {
		t.Fatalf("accepted = %+v %v", accepted, err)
	}
	if result, ok := accepted.Result.(map[string]bool); !ok || !result["accepted"] {
		t.Fatalf("result = %#v", accepted.Result)
	}
	e.wantTypes(tangent.EventSuggestionChanged, tangent.EventLineUpdated)
	_, err = e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, nil)
	wantCode(t, err, domain.CodeSuggestionNotOpen)
	_, err = e.engine.DismissSuggestion(e.ctx, scopeA, s.ID)
	wantCode(t, err, domain.CodeSuggestionNotOpen)
	_, err = e.engine.AcceptSuggestion(e.ctx, scopeB, s.ID, nil)
	wantCode(t, err, domain.CodeSuggestionNotFound)
}

func TestInbox_ConcurrentDecisionsLeaveOneWinner(t *testing.T) {
	e := newEnvWith(t, p1Features())
	s := e.probed(e.mainLine().ID, tangent.ProbeDirective)
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	for i := range 6 {
		wg.Go(func() {
			var err error
			if i%2 == 0 {
				_, err = e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, nil)
			} else {
				_, err = e.engine.DismissSuggestion(e.ctx, scopeA, s.ID)
			}
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				wins++
			case domain.CodeOf(err) != domain.CodeSuggestionNotOpen:
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("%d decisions won", wins)
	}
}

func TestInbox_DismissCoolsDownOrEndsForGood(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main := e.mainLine()
	s := e.probed(main.ID, tangent.ProbeDirective)
	e.rollsBack("dismiss", func(opt tangent.TxOption) error {
		_, err := e.engine.DismissSuggestion(e.ctx, scopeA, s.ID, opt)
		return err
	})
	if dismissed, err := e.engine.DismissSuggestion(e.ctx, scopeA, s.ID); err != nil || dismissed.Status != domain.SuggestionDismissed {
		t.Fatalf("dismissed = %+v %v", dismissed, err)
	}
	e.events.Reset()
	e.turn(main.ID, "q", tangent.ProbeDirective)
	if len(e.events.OfType(tangent.EventSuggestionChanged)) != 0 {
		t.Fatal("not raised again during the cooldown")
	}
	permanent := e.probed(main.ID, tangent.ProbeDirectivePermanent)
	if _, err := e.engine.DismissSuggestion(e.ctx, scopeA, permanent.ID); err != nil {
		t.Fatal(err)
	}
	e.exec(`UPDATE tangent_suggestion SET decided_at = now() - interval '400 days' WHERE status = 'dismissed'`)
	e.events.Reset()
	e.turn(main.ID, "q", tangent.ProbeDirectivePermanent)
	if got := e.events.OfType(tangent.EventSuggestionChanged); len(got) != 0 {
		t.Fatalf("a permanent dismissal never returns: %v", got)
	}
	if again := e.probed(main.ID, tangent.ProbeDirective); again.Kind != tangent.ProbeKind {
		t.Fatalf("the cooled-down one returns: %+v", again)
	}
	list, _ := e.engine.ListSuggestions(e.ctx, scopeA, main.ID, []string{domain.SuggestionDismissed})
	if len(list.Suggestions) != 2 {
		t.Fatalf("dismissed = %+v", list.Suggestions)
	}
}

func TestInbox_AnEndingBranchExpiresItsSuggestionsAfterTheCommit(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "look")
	s := e.probed(branch.Line.ID, tangent.ProbeDirective)
	e.rollsBack("discard", func(opt tangent.TxOption) error {
		_, err := e.engine.DiscardBranch(e.ctx, scopeA, branch.Line.ID, opt)
		return err
	})
	e.events.Reset()
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, branch.Line.ID); err != nil {
		t.Fatal(err)
	}
	changed := e.events.OfType(tangent.EventSuggestionChanged)
	if len(changed) != 1 || changed[0].Data.(tangent.SuggestionChange).Suggestion.Status != domain.SuggestionExpired {
		t.Fatalf("expired = %v", e.events.Types())
	}
	types := e.events.Types()
	if types[0] != tangent.EventBranchChanged {
		t.Fatalf("the branch first, the suggestion after: %v", types)
	}
	if got, _ := e.engine.ListSuggestions(e.ctx, scopeA, main.ID, []string{domain.SuggestionExpired}); len(got.Suggestions) != 1 || got.Suggestions[0].ID != s.ID {
		t.Fatalf("expired list = %+v", got)
	}
}

func TestInbox_AMergeExpiresTheBranchAndLinesBelowAPromotionOnlyItself(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "look")
	inner := e.turn(branch.Line.ID, "q", "a")
	child := e.branch(branch.Line.ID, inner.Message.ID, "deeper")
	e.probed(child.Line.ID, tangent.ProbeDirective)
	promote := e.branch(main.ID, anchor.Message.ID, "promote me")
	e.probed(promote.Line.ID, tangent.ProbeDirective)
	e.events.Reset()
	if _, err := e.engine.PromoteBranch(e.ctx, scopeA, promote.Line.ID); err != nil {
		t.Fatal(err)
	}
	if n := len(e.events.OfType(tangent.EventSuggestionChanged)); n != 1 {
		t.Fatalf("the promoted branch's suggestion expires: %d", n)
	}
	tip, _ := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	e.events.Reset()
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, branch.Line.ID); err != nil {
		t.Fatal(err)
	}
	if n := len(e.events.OfType(tangent.EventSuggestionChanged)); n != 1 {
		t.Fatalf("the suggestion below the ended branch expires: %d (tip %s)", n, tip.ParentTipMessageID)
	}
}

func TestInbox_OffWithoutAProducerOrByPolicy(t *testing.T) {
	e := newEnvWith(t, tangent.AllFeatures())
	main := e.mainLine()
	_, err := e.engine.ListSuggestions(e.ctx, scopeA, main.ID, nil)
	wantCode(t, err, domain.CodeFeatureDisabled)
	caps, _ := e.engine.Capabilities(e.ctx, scopeA)
	if capability(caps, tangent.FeatureSuggestions).Enabled || e.engine.FeatureConfigured(tangent.FeatureSuggestions) {
		t.Fatal("no producer, no inbox")
	}
	p := newEnvWith(t, p1Features(), tangent.WithFeaturePolicy(policy{"tenant-b/" + tangent.FeatureSuggestionProbe: tangent.ModeOff}))
	line := p.mainLine()
	s := p.probed(line.ID, tangent.ProbeDirective)
	_, err = p.engine.ListSuggestions(p.ctx, scopeB, line.ID, nil)
	wantCode(t, err, domain.CodeFeatureDisabled)
	caps, _ = p.engine.Capabilities(p.ctx, scopeB)
	if capability(caps, tangent.FeatureSuggestions).Enabled {
		t.Fatal("the policy switched the only producer off")
	}
	_, err = p.engine.AcceptSuggestion(p.ctx, scopeB, s.ID, nil)
	wantCode(t, err, domain.CodeFeatureDisabled)
}

func TestInbox_MaintenanceExpiresWhatTheInboxMissed(t *testing.T) {
	e := newEnvWith(t, p1Features(), tangent.WithFeaturePolicy(policy{"tenant-a/" + tangent.FeatureSuggestionProbe: tangent.ModeOff}))
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "look")
	raw := e.rawStore()
	if _, err := raw.ProposeSuggestion(e.ctx, store.ProposeInput{Tenant: scopeA.Tenant, LineID: branch.Line.ID, Feature: tangent.FeatureSuggestionProbe, Kind: tangent.ProbeKind, TargetKey: "t"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, branch.Line.ID); err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	report, err := e.engine.Maintain(e.ctx)
	if err != nil || report.Tasks[tangent.TaskExpireSuggestions] != 1 || len(e.events.OfType(tangent.EventSuggestionChanged)) != 1 {
		t.Fatalf("report = %+v %v, events %v", report, err, e.events.Types())
	}
}

func TestInbox_AFailingProposalIsLoggedNotFatal(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main := e.mainLine()
	e.exec(`ALTER TABLE tangent_suggestion ADD CONSTRAINT no_probe CHECK (kind <> 'probe')`)
	done := e.turn(main.ID, "q", tangent.ProbeDirective)
	if done.Message.Status != domain.MessageDone || len(e.events.OfType(tangent.EventSuggestionChanged)) != 0 {
		t.Fatalf("the turn finished without a suggestion: %+v", done.Message)
	}
}
