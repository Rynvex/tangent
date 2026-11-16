package tangent_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// rebalanced runs branch turns until the rebalance suggestion appears
// (failing past max turns) and returns it with the turns it took.
func (e *env) rebalanced(lineID string, max int) (domain.Suggestion, int) {
	e.t.Helper()
	for i := 1; i <= max; i++ {
		e.events.Reset()
		e.turn(lineID, fmt.Sprintf("q%d", i), fmt.Sprintf("a%d", i))
		for _, ev := range e.events.OfType(tangent.EventSuggestionChanged) {
			if s := ev.Data.(tangent.SuggestionChange).Suggestion; s.Kind == tangent.SuggestionKindRebalance {
				return s, i
			}
		}
	}
	e.t.Fatalf("no rebalance suggestion after %d turns", max)
	return domain.Suggestion{}, 0
}

func payloadOf(t *testing.T, s domain.Suggestion) tangent.RebalancePayload {
	t.Helper()
	var p tangent.RebalancePayload
	if err := json.Unmarshal(s.Payload, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRebalance_TheRecentTurnsAndTheShare(t *testing.T) {
	e := newEnvWith(t, p1bFeatures())
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "taking over")
	s, turns := e.rebalanced(branch.Line.ID, 6)
	p := payloadOf(t, s)
	if turns != 5 || p.Reason != domain.RebalanceReasonRecent || !p.RecentInBranch || s.TargetKey != "branch:"+branch.Line.ID ||
		len(p.Actions) != 2 || p.Actions[0] != tangent.RebalancePromote || p.Actions[1] != tangent.RebalanceSpinoff {
		t.Fatalf("after %d turns: %+v %+v", turns, s, p)
	}

	other := e.branch(main.ID, anchor.Message.ID, "the share")
	for i := range 3 {
		e.turn(main.ID, fmt.Sprintf("main %d", i), "ok")
	}
	for i := range 4 {
		e.turn(other.Line.ID, fmt.Sprintf("b%d", i), "ok")
	}
	e.turn(main.ID, "main again", "ok")
	s, turns = e.rebalanced(other.Line.ID, 4)
	if p := payloadOf(t, s); turns != 4 || p.Reason != domain.RebalanceReasonShare || p.BranchTurns != 8 || p.ParentTurns != 4 {
		t.Fatalf("share after %d more: %+v", turns, p)
	}
}

func TestRebalance_KeepIsFinal(t *testing.T) {
	e := newEnvWith(t, p1bFeatures())
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "b")
	s, _ := e.rebalanced(branch.Line.ID, 6)
	e.events.Reset()
	e.turn(branch.Line.ID, "more", "ok")
	if len(e.events.OfType(tangent.EventSuggestionChanged)) != 0 {
		t.Fatal("one open suggestion per branch")
	}
	if _, err := e.engine.DismissSuggestion(e.ctx, scopeA, s.ID); err != nil {
		t.Fatal(err)
	}
	e.exec(`UPDATE tangent_suggestion SET decided_at = now() - interval '100 days'`)
	e.events.Reset()
	for range 3 {
		e.turn(branch.Line.ID, "still here", "ok")
	}
	if len(e.events.OfType(tangent.EventSuggestionChanged)) != 0 {
		t.Fatal("keeping a branch is final")
	}
}

func TestRebalance_AcceptPromotes(t *testing.T) {
	e := newEnvWith(t, p1bFeatures())
	sink := &recordingDispatcher{}
	e.engine.SetJobDispatcher(sink)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	e.turn(main.ID, "old tail", "kept")
	branch := e.branch(main.ID, anchor.Message.ID, "the new way")
	s, _ := e.rebalanced(branch.Line.ID, 6)
	_, err := e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, json.RawMessage(`{"action":"sideways"}`))
	wantCode(t, err, domain.CodeInvalidInput)
	accepted, err := e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, json.RawMessage(`{"action":"promote"}`))
	if err != nil || accepted.Suggestion.Status != domain.SuggestionAccepted {
		t.Fatalf("accepted = %+v %v", accepted, err)
	}
	result := accepted.Result.(tangent.RebalanceResult)
	if result.Action != tangent.RebalancePromote || result.Branch.Status != domain.BranchStatusPromoted || result.Line.ID != main.ID {
		t.Fatalf("result = %+v", result)
	}
	if len(sink.jobs) != 1 || sink.jobs[0].Kind != tangent.JobKindLeafDraft || sink.jobs[0].LineID != result.PreviousMainLine.LineID {
		t.Fatalf("the previous main line gets a leaf draft: %+v", sink.jobs)
	}
}

func TestRebalance_AcceptSpinsOffAndTheSuggestionIsAcceptedNotExpired(t *testing.T) {
	e := newEnvWith(t, p1bFeatures())
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "its own thing")
	s, _ := e.rebalanced(branch.Line.ID, 6)
	accepted, err := e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, json.RawMessage(`{"action":"spinoff","title":"Separate"}`))
	if err != nil || accepted.Suggestion.Status != domain.SuggestionAccepted || accepted.Suggestion.RootLineID != main.ID {
		t.Fatalf("the accepted suggestion stays in the old tree: %+v %v", accepted, err)
	}
	if line, _ := e.engine.GetLine(e.ctx, scopeA, branch.Line.ID); line.OpenSuggestions != 0 {
		t.Fatalf("the new main line counts none: %d", line.OpenSuggestions)
	}
	if old, _ := e.engine.ListSuggestions(e.ctx, scopeA, main.ID, []string{domain.SuggestionAccepted}); len(old.Suggestions) != 1 {
		t.Fatalf("listed in the old tree: %+v", old)
	}
	result := accepted.Result.(tangent.RebalanceResult)
	if result.Action != tangent.RebalanceSpinoff || result.Line.ID != branch.Line.ID || result.Line.Title != "Separate" || result.Link == nil {
		t.Fatalf("result = %+v", result)
	}
}

func TestRebalance_WhatItCanOfferAndWhenItIsQuiet(t *testing.T) {
	noSpin := newEnvWith(t, p1bFeatures(dropFeature(tangent.FeatureSpinoff)))
	main := noSpin.mainLine()
	anchor := noSpin.turn(main.ID, "q", "a")
	top := noSpin.branch(main.ID, anchor.Message.ID, "top")
	s, _ := noSpin.rebalanced(top.Line.ID, 6)
	if p := payloadOf(t, s); len(p.Actions) != 1 || p.Actions[0] != tangent.RebalancePromote {
		t.Fatalf("only promote: %+v", p)
	}
	_, err := noSpin.engine.AcceptSuggestion(noSpin.ctx, scopeA, s.ID, json.RawMessage(`{"action":"spinoff"}`))
	wantCode(t, err, domain.CodeFeatureDisabled)
	inner := noSpin.turn(top.Line.ID, "inner", "x")
	deep := noSpin.branch(top.Line.ID, inner.Message.ID, "deep")
	noSpin.events.Reset()
	for i := range 6 {
		noSpin.turn(deep.Line.ID, fmt.Sprintf("d%d", i), "x")
	}
	if len(noSpin.events.OfType(tangent.EventSuggestionChanged)) != 0 {
		t.Fatal("a deep branch without spinoff has nothing to offer")
	}

	manual := newEnvWith(t, p1bFeatures(dropFeature(tangent.FeatureRebalance), func(f []tangent.Feature) []tangent.Feature {
		return append(f, tangent.Rebalance(tangent.ModeManual))
	}))
	line := manual.mainLine()
	a := manual.turn(line.ID, "q", "a")
	b := manual.branch(line.ID, a.Message.ID, "b")
	manual.events.Reset()
	for i := range 6 {
		manual.turn(b.Line.ID, fmt.Sprintf("m%d", i), "x")
	}
	if len(manual.events.OfType(tangent.EventSuggestionChanged)) != 0 {
		t.Fatal("manual raises nothing")
	}
	caps, _ := manual.engine.Capabilities(manual.ctx, scopeA)
	if capability(caps, tangent.FeatureRebalance).Mode != "manual" {
		t.Fatalf("caps = %+v", caps)
	}
	if _, err := tangent.New(manual.pool, tangent.WithFeatures(tangent.Rebalance(tangent.ModeSuggest))); err == nil {
		t.Fatal("rebalance needs leaf")
	}
}
