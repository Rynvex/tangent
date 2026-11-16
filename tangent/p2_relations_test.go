package tangent_test

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

func TestRelations_CreateListDeleteAcrossTrees(t *testing.T) {
	e, _ := p2Env(t, tangent.ModeManual)
	main := e.mainLine()
	reply := e.turn(main.ID, "q", "a")
	other := e.mainLine()
	e.rollsBack("create relation", func(opt tangent.TxOption) error {
		_, err := e.engine.CreateRelation(e.ctx, scopeA, main.ID, tangent.RelationInput{To: tangent.RelationEnd{LineID: other.ID}}, opt)
		return err
	})
	e.events.Reset()
	created, err := e.engine.CreateRelation(e.ctx, scopeA, main.ID, tangent.RelationInput{
		From: tangent.RelationEnd{MessageID: reply.Message.ID}, To: tangent.RelationEnd{LineID: other.ID}, Label: "see also",
	})
	if err != nil || created.Link.FromLineID != main.ID || created.Link.FromMessageID != reply.Message.ID || created.Link.Label != "see also" {
		t.Fatalf("created = %+v %v", created, err)
	}
	e.wantTypes(tangent.EventLinkChanged, tangent.EventLinkChanged)
	roots := []string{}
	for _, ev := range e.events.OfType(tangent.EventLinkChanged) {
		change := ev.Data.(tangent.LinkChange)
		roots = append(roots, change.RootLineID)
		if change.Link.ID != created.Link.ID || change.Deleted {
			t.Fatalf("link.changed = %+v", change)
		}
	}
	if !slices.Equal(roots, []string{main.ID, other.ID}) {
		t.Fatalf("both conversations hear of it: %v", roots)
	}
	for _, line := range []string{main.ID, other.ID} {
		if listed, err := e.engine.ListRelations(e.ctx, scopeA, line); err != nil || len(listed) != 1 {
			t.Fatalf("listed from %s: %+v %v", line, listed, err)
		}
	}
	_, err = e.engine.ListRelations(e.ctx, scopeB, main.ID)
	wantCode(t, err, domain.CodeLineNotFound)
	_, err = e.engine.CreateRelation(e.ctx, scopeB, main.ID, tangent.RelationInput{To: tangent.RelationEnd{LineID: other.ID}})
	wantCode(t, err, domain.CodeLineNotFound)
	e.rollsBack("delete relation", func(opt tangent.TxOption) error {
		_, err := e.engine.DeleteRelation(e.ctx, scopeA, other.ID, created.Link.ID, opt)
		return err
	})
	e.events.Reset()
	if _, err := e.engine.DeleteRelation(e.ctx, scopeA, other.ID, created.Link.ID); err != nil {
		t.Fatal(err)
	}
	if changes := e.events.OfType(tangent.EventLinkChanged); len(changes) != 2 || !changes[0].Data.(tangent.LinkChange).Deleted {
		t.Fatalf("deleted: %v", e.events.Types())
	}
}

func TestRelations_LinksListTheKindsWhoseFeatureIsOn(t *testing.T) {
	e := newEnvWith(t, append(tangent.AllFeatures(), tangent.Relations(tangent.ModeManual)))
	main := e.mainLine()
	other := e.mainLine()
	if _, err := e.engine.CreateRelation(e.ctx, scopeA, main.ID, tangent.RelationInput{To: tangent.RelationEnd{LineID: other.ID}}); err != nil {
		t.Fatal(err)
	}
	e.exec(`INSERT INTO tangent_link (tenant_id, kind, from_line_id, to_line_id) VALUES ($1, 'spinoff', $2, $3)`, scopeA.Tenant, main.ID, other.ID)
	links, err := e.engine.ListLinks(e.ctx, scopeA, main.ID)
	if err != nil || len(links) != 1 || links[0].Kind != domain.LinkKindRelation {
		t.Fatalf("relations on, spinoff off: %+v %v", links, err)
	}
	both := newEnvWith(t, p2Features(tangent.ModeManual))
	bothMain, bothOther := both.mainLine(), both.mainLine()
	both.engine.CreateRelation(both.ctx, scopeA, bothMain.ID, tangent.RelationInput{To: tangent.RelationEnd{LineID: bothOther.ID}})
	both.exec(`INSERT INTO tangent_link (tenant_id, kind, from_line_id, to_line_id) VALUES ($1, 'spinoff', $2, $3)`, scopeA.Tenant, bothMain.ID, bothOther.ID)
	if links, _ := both.engine.ListLinks(both.ctx, scopeA, bothMain.ID); len(links) != 2 {
		t.Fatalf("both kinds: %+v", links)
	}
	none := newEnv(t)
	_, err = none.engine.ListLinks(none.ctx, scopeA, none.mainLine().ID)
	wantCode(t, err, domain.CodeFeatureDisabled)
	_, err = none.engine.ListRelations(none.ctx, scopeA, none.mainLine().ID)
	wantCode(t, err, domain.CodeFeatureDisabled)
}

func TestRelations_SuggestedWhenABranchEndsAndAcceptingDrawsThem(t *testing.T) {
	e, sink := p2Env(t, tangent.ModeSuggest)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	lonely := e.branch(main.ID, anchor.Message.ID, "Alone")
	e.turn(lonely.Line.ID, "x", "y")
	if _, err := e.engine.DiscardBranchWith(e.ctx, scopeA, lonely.Line.ID, tangent.DiscardInput{Leaf: &domain.LeafInput{Line: "dead end"}}); err != nil {
		t.Fatal(err)
	}
	hotels := e.branch(main.ID, anchor.Message.ID, "Hotel prices")
	ryokan := e.branch(main.ID, anchor.Message.ID, "Ryokan prices")
	e.turn(ryokan.Line.ID, "how much?", "30,000 yen")
	sink.jobs = nil
	merged := e.mergeWithCard(ryokan.Line.ID, domain.BranchCard{Question: "Ryokan cost?", Conclusion: "About 30,000 yen"})
	_ = merged
	jobs := jobsOf(tangent.JobKindRelationSuggest, sink.jobs...)
	if len(jobs) != 1 || !strings.Contains(jobs[0].Prompt.UserMessage, "Ryokan prices") || !strings.Contains(jobs[0].Prompt.UserMessage, "Hotel prices") ||
		!strings.Contains(jobs[0].Prompt.UserMessage, "About 30,000 yen") {
		t.Fatalf("a relation job after the merge: %+v", sink.jobs)
	}
	key := ""
	for _, line := range strings.Split(jobs[0].Prompt.UserMessage, "\n") {
		if strings.Contains(line, "Hotel prices") {
			key = strings.TrimSpace(strings.SplitN(strings.TrimPrefix(line, "> "), ":", 2)[0])
		}
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, jobs[0].ID, domain.RelationSuggestMarker+`{"relations":[{"to":"`+key+`","label":"Both are lodging costs","kind":"supports"}]}`, nil); err != nil {
		t.Fatal(err)
	}
	s := e.events.OfType(tangent.EventSuggestionChanged)[0].Data.(tangent.SuggestionChange).Suggestion
	var payload tangent.RelationPayload
	if s.Kind != tangent.SuggestionKindRelation || s.LineID != main.ID || json.Unmarshal(s.Payload, &payload) != nil ||
		payload.FromLineID != ryokan.Line.ID || payload.ToLineID != hotels.Line.ID || payload.Label != "Both are lodging costs" || payload.ToTitle == "" ||
		payload.RelationKind != domain.RelationKindSupports {
		t.Fatalf("suggestion = %+v %+v", s, payload)
	}
	accepted, err := e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, json.RawMessage(`{"label":"Same budget line"}`))
	if err != nil {
		t.Fatal(err)
	}
	link := accepted.Result.(tangent.RelationAccepted).Link
	if link.FromLineID != ryokan.Line.ID || link.ToLineID != hotels.Line.ID || link.Label != "Same budget line" || link.RelationKind != domain.RelationKindSupports {
		t.Fatalf("drawn with the proposed kind: %+v", link)
	}
	if e.count(`SELECT count(*) FROM tangent_link WHERE kind = 'relation'`) != 1 {
		t.Fatal("one relation")
	}
}

func TestRelations_ManualSuggestsNothing(t *testing.T) {
	e, sink := p2Env(t, tangent.ModeManual)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	e.branch(main.ID, anchor.Message.ID, "other")
	done := e.branch(main.ID, anchor.Message.ID, "done")
	e.turn(done.Line.ID, "x", "y")
	e.mergeWithCard(done.Line.ID, domain.BranchCard{Question: "q", Conclusion: "c"})
	if len(jobsOf(tangent.JobKindRelationSuggest, sink.jobs...)) != 0 {
		t.Fatalf("manual: %+v", sink.jobs)
	}
}

func TestPin_IsCoreAndPublishesTheMessage(t *testing.T) {
	e := newEnvWith(t, nil)
	main := e.mainLine()
	reply := e.turn(main.ID, "q", "a")
	e.rollsBack("pin", func(opt tangent.TxOption) error {
		_, err := e.engine.PinMessage(e.ctx, scopeA, reply.Message.ID, true, opt)
		return err
	})
	e.events.Reset()
	pinned, err := e.engine.PinMessage(e.ctx, scopeA, reply.Message.ID, true)
	if err != nil || !pinned.Pinned {
		t.Fatalf("pinned = %+v %v", pinned, err)
	}
	e.wantTypes(tangent.EventMessageUpdated)
	if ev := e.events.OfType(tangent.EventMessageUpdated)[0]; ev.RootLineID != main.ID || !ev.Data.(domain.Message).Pinned {
		t.Fatalf("message.updated = %+v", ev)
	}
	e.events.Reset()
	if _, err := e.engine.PinMessage(e.ctx, scopeA, reply.Message.ID, true); err != nil || len(e.events.Types()) != 0 {
		t.Fatalf("no change, no event: %v %v", err, e.events.Types())
	}
	_, err = e.engine.PinMessage(e.ctx, scopeB, reply.Message.ID, false)
	wantCode(t, err, domain.CodeMessageNotFound)
	if unpinned, err := e.engine.PinMessage(e.ctx, scopeA, reply.Message.ID, false); err != nil || unpinned.Pinned {
		t.Fatalf("unpinned = %+v %v", unpinned, err)
	}
}

func TestOpenLoops_FollowTheFeaturesThatAreOn(t *testing.T) {
	e, _ := p2Env(t, tangent.ModeSuggest)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	stale := e.branch(main.ID, anchor.Message.ID, "stale")
	e.exec(`UPDATE tangent_line SET last_activity_at = now() - interval '4 days' WHERE id = $1`, stale.Line.ID)
	e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: "add", Section: "to_confirm", Text: "visa?"}})
	e.engine.CreateSeed(e.ctx, scopeA, main.ID, tangent.SeedInput{Text: "later"})
	e.probed(main.ID, tangent.ProbeDirective)
	loops, err := e.engine.OpenLoops(e.ctx, scopeA, tangent.OpenLoopsInput{})
	if err != nil || loops.StaleDays != 3 || loops.StaleBranches.Total != 1 || loops.ToConfirm.Total != 1 || loops.Seeds.Total != 1 || loops.Suggestions.Total != 1 {
		t.Fatalf("loops = %+v %v", loops, err)
	}
	if week, _ := e.engine.OpenLoops(e.ctx, scopeA, tangent.OpenLoopsInput{LineID: stale.Line.ID, StaleDays: 7}); week.StaleBranches.Total != 0 || week.RootLineID != main.ID || week.StaleDays != 7 {
		t.Fatalf("a week: %+v", week)
	}
	_, err = e.engine.OpenLoops(e.ctx, scopeA, tangent.OpenLoopsInput{StaleDays: 400})
	wantCode(t, err, domain.CodeInvalidInput)
	if line, _ := e.engine.GetLine(e.ctx, scopeA, main.ID); line.StaleBranches != 1 {
		t.Fatalf("the main line counts it: %d", line.StaleBranches)
	}
	bare := newEnvWith(t, append(tangent.AllFeatures(), tangent.OpenLoops()))
	bareMain := bare.mainLine()
	only, err := bare.engine.OpenLoops(bare.ctx, scopeA, tangent.OpenLoopsInput{LineID: bareMain.ID})
	if err != nil || only.ToConfirm == nil || only.Seeds != nil || only.Suggestions != nil {
		t.Fatalf("parking and the inbox off: %+v %v", only, err)
	}
	off := newEnv(t)
	_, err = off.engine.OpenLoops(off.ctx, scopeA, tangent.OpenLoopsInput{})
	wantCode(t, err, domain.CodeFeatureDisabled)
}

func TestP2_CapabilitiesListTheNewFeatures(t *testing.T) {
	e, _ := p2Env(t, tangent.ModeSuggest)
	caps, err := e.engine.Capabilities(e.ctx, scopeA)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]tangent.Capability{}
	for _, c := range caps {
		got[c.Name] = c
	}
	if got[tangent.FeatureGoal].Mode != "suggest" || got[tangent.FeatureRelations].Mode != "suggest" || !got[tangent.FeatureOpenLoops].Enabled || got[tangent.FeatureOpenLoops].Mode != "" {
		t.Fatalf("caps = %+v", got)
	}
	if _, err := tangent.New(e.pool, tangent.WithFeatures(tangent.Goal(tangent.ModeSuggest), tangent.Goal(tangent.ModeManual))); err == nil {
		t.Fatal("a feature is enabled once")
	}
}
