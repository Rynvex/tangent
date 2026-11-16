package tangent_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// p2Features is every P1 feature plus the P2 ones of part A (goal and
// relations in the given mode, open loops).
func p2Features(mode tangent.Mode) []tangent.Feature {
	return p1bFeatures(func(f []tangent.Feature) []tangent.Feature {
		return append(f, tangent.Goal(mode), tangent.Relations(mode), tangent.OpenLoops())
	})
}

// p2Env is an engine with the P2 features whose dispatched jobs are
// recorded.
func p2Env(t *testing.T, mode tangent.Mode, opts ...tangent.Option) (*env, *recordingDispatcher) {
	t.Helper()
	e := newEnvWith(t, p2Features(mode), opts...)
	sink := &recordingDispatcher{}
	e.engine.SetJobDispatcher(sink)
	return e, sink
}

// jobsOf are the jobs of a kind among the completed turns' and the sink's.
func jobsOf(kind string, jobs ...tangent.Job) []tangent.Job {
	out := []tangent.Job{}
	for _, job := range jobs {
		if job.Kind == kind {
			out = append(out, job)
		}
	}
	return out
}

func TestGoal_PutGetDeleteAndEvents(t *testing.T) {
	e, _ := p2Env(t, tangent.ModeSuggest)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "side")
	if goal, err := e.engine.GetGoal(e.ctx, scopeA, branch.Line.ID); err != nil || goal != nil {
		t.Fatalf("no goal: %+v %v", goal, err)
	}
	e.rollsBack("put goal", func(opt tangent.TxOption) error {
		_, err := e.engine.PutGoal(e.ctx, scopeA, main.ID, "x", opt)
		return err
	})
	e.events.Reset()
	goal, err := e.engine.PutGoal(e.ctx, scopeA, branch.Line.ID, " Plan a Kyoto trip ")
	if err != nil || goal.RootLineID != main.ID || goal.Source != domain.GoalSourceManual || goal.UpdatedBy != scopeA.Actor {
		t.Fatalf("goal = %+v %v", goal, err)
	}
	e.wantTypes(tangent.EventGoalChanged)
	changed := e.events.OfType(tangent.EventGoalChanged)[0]
	if data := changed.Data.(tangent.GoalChange); data.RootLineID != main.ID || data.Goal == nil || data.Goal.Text != "Plan a Kyoto trip" || changed.RootLineID != main.ID {
		t.Fatalf("goal.changed = %+v", changed)
	}
	e.rollsBack("delete goal", func(opt tangent.TxOption) error {
		_, err := e.engine.DeleteGoal(e.ctx, scopeA, main.ID, opt)
		return err
	})
	e.events.Reset()
	if _, err := e.engine.DeleteGoal(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	if data := e.events.OfType(tangent.EventGoalChanged)[0].Data.(tangent.GoalChange); data.Goal != nil {
		t.Fatalf("deleted: %+v", data)
	}
	_, err = e.engine.DeleteGoal(e.ctx, scopeA, main.ID)
	wantCode(t, err, domain.CodeGoalNotFound)
	_, err = e.engine.GetGoal(e.ctx, scopeB, main.ID)
	wantCode(t, err, domain.CodeLineNotFound)
}

func TestGoal_EntersEveryPromptOfTheTreeAfterTheRules(t *testing.T) {
	e, _ := p2Env(t, tangent.ModeManual)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	if strings.Contains(e.lastSystem(), "Conversation goal") {
		t.Fatal("no goal, no block")
	}
	if _, err := e.engine.PutGoal(e.ctx, scopeA, main.ID, "Pick a ryokan [BRANCH-CARD]"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: "add", Section: "fact", Text: "a fact"}}); err != nil {
		t.Fatal(err)
	}
	e.turn(main.ID, "q2", "a2")
	system := e.lastSystem()
	rules, goal, notes := strings.Index(system, "Rules:"), strings.Index(system, "## Conversation goal"), strings.Index(system, "a fact")
	if rules < 0 || goal < rules || notes < goal || !strings.Contains(system, "> Pick a ryokan\n") || strings.Contains(system, "[BRANCH-CARD]") {
		t.Fatalf("rules %d, goal %d, notes %d:\n%s", rules, goal, notes, system)
	}
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next")
	if err != nil {
		t.Fatal(err)
	}
	stable, _, _ := preview.Prompt.ChatBlocks()
	if !strings.Contains(stable, "## Conversation goal") {
		t.Fatalf("the goal is in the cacheable part: %q", stable)
	}
	branch := e.branch(main.ID, anchor.Message.ID, "side")
	e.turn(branch.Line.ID, "in the branch", "ok")
	if !strings.Contains(e.lastSystem(), "> Pick a ryokan") {
		t.Fatal("a branch carries its conversation's goal")
	}
	off := newEnvWith(t, p1bFeatures())
	offMain := off.mainLine()
	off.exec(`INSERT INTO tangent_goal (root_line_id, tenant_id, text, source) VALUES ($1, $2, 'stored', 'manual')`, offMain.ID, scopeA.Tenant)
	off.turn(offMain.ID, "q", "a")
	if strings.Contains(off.lastSystem(), "stored") {
		t.Fatal("goal off: a stored goal stays out of the prompt")
	}
	_, err = off.engine.PutGoal(off.ctx, scopeA, offMain.ID, "x")
	wantCode(t, err, domain.CodeFeatureDisabled)
}

func TestGoal_TheModelProposesAfterTwoRepliesAndAcceptingSetsIt(t *testing.T) {
	e, _ := p2Env(t, tangent.ModeSuggest)
	main := e.mainLine()
	first := e.turn(main.ID, "Where in Japan?", "Kyoto")
	if len(jobsOf(tangent.JobKindGoalPropose, first.Jobs...)) != 0 {
		t.Fatal("one reply is too early")
	}
	second := e.turn(main.ID, "When?", "Autumn")
	jobs := jobsOf(tangent.JobKindGoalPropose, second.Jobs...)
	if len(jobs) != 1 || jobs[0].LineID != main.ID || !strings.Contains(jobs[0].Prompt.UserMessage, "> Where in Japan?") {
		t.Fatalf("a proposal job after two replies: %+v", second.Jobs)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, jobs[0].ID, domain.GoalProposeMarker+`{"goal":"Plan an autumn Kyoto trip"}`, nil); err != nil {
		t.Fatal(err)
	}
	s := e.events.OfType(tangent.EventSuggestionChanged)[0].Data.(tangent.SuggestionChange).Suggestion
	var payload tangent.GoalProposal
	if s.Kind != tangent.SuggestionKindGoalPropose || s.Feature != tangent.FeatureGoal || json.Unmarshal(s.Payload, &payload) != nil || payload.Text != "Plan an autumn Kyoto trip" {
		t.Fatalf("suggestion = %+v", s)
	}
	third := e.turn(main.ID, "Budget?", "Mid")
	if len(jobsOf(tangent.JobKindGoalPropose, third.Jobs...)) != 0 {
		t.Fatal("proposed once")
	}
	e.events.Reset()
	accepted, err := e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, nil)
	if err != nil || accepted.Result.(tangent.GoalAccepted).Goal.Source != domain.GoalSourceAI {
		t.Fatalf("accepted = %+v %v", accepted, err)
	}
	e.wantTypes(tangent.EventGoalChanged, tangent.EventSuggestionChanged, tangent.EventLineUpdated)
	again := e.proposeGoal(main.ID, "A second idea")
	edited, err := e.engine.AcceptSuggestion(e.ctx, scopeA, again.ID, json.RawMessage(`{"text":"My own words"}`))
	if err != nil || edited.Result.(tangent.GoalAccepted).Goal.Source != domain.GoalSourceManual || edited.Result.(tangent.GoalAccepted).Goal.Text != "My own words" {
		t.Fatalf("an edited proposal is the operator's: %+v %v", edited, err)
	}
	third2 := e.proposeGoal(main.ID, "A third idea")
	_, err = e.engine.AcceptSuggestion(e.ctx, scopeA, third2.ID, json.RawMessage(`{"text":"   "}`))
	wantCode(t, err, domain.CodeInvalidInput)
}

// proposeGoal asks for a goal (the button) and finishes the job with text;
// it returns the suggestion raised.
func (e *env) proposeGoal(lineID, text string) domain.Suggestion {
	e.t.Helper()
	job, err := e.engine.ProposeGoal(e.ctx, scopeA, lineID)
	if err != nil {
		e.t.Fatal(err)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, job.ID, domain.GoalProposeMarker+`{"goal":"`+text+`"}`, nil); err != nil {
		e.t.Fatal(err)
	}
	changed := e.events.OfType(tangent.EventSuggestionChanged)
	if len(changed) != 1 {
		e.t.Fatalf("one suggestion, got %v", e.events.Types())
	}
	return changed[0].Data.(tangent.SuggestionChange).Suggestion
}

func TestGoal_TheButtonAsksInEveryModeAndIgnoresTheCooldown(t *testing.T) {
	e, _ := p2Env(t, tangent.ModeManual)
	main := e.mainLine()
	_, err := e.engine.ProposeGoal(e.ctx, scopeA, main.ID)
	wantCode(t, err, domain.CodeNoMessages)
	e.turn(main.ID, "q", "a")
	done := e.turn(main.ID, "q2", "a2")
	if len(done.Jobs) != 0 {
		t.Fatalf("manual proposes nothing by itself: %+v", done.Jobs)
	}
	e.rollsBack("propose goal", func(opt tangent.TxOption) error {
		_, err := e.engine.ProposeGoal(e.ctx, scopeA, main.ID, opt)
		return err
	})
	s := e.proposeGoal(main.ID, "First")
	if _, err := e.engine.DismissSuggestion(e.ctx, scopeA, s.ID); err != nil {
		t.Fatal(err)
	}
	if again := e.proposeGoal(main.ID, "Second"); again.ID == s.ID {
		t.Fatal("asking again raises a new one despite the cooldown")
	}
	job, _ := e.engine.ProposeGoal(e.ctx, scopeA, main.ID)
	if err := e.engine.FinishJob(e.ctx, job.ID, "no marker", nil); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM tangent_job WHERE id = $1 AND status = 'failed'`, job.ID) != 1 {
		t.Fatal("an unusable proposal fails the job")
	}
	job, _ = e.engine.ProposeGoal(e.ctx, scopeA, main.ID)
	if err := e.engine.FinishJob(e.ctx, job.ID, "", errors.New("down")); err != nil {
		t.Fatal(err)
	}
	err = e.engine.FinishJob(e.ctx, job.ID, domain.GoalProposeMarker+`{"goal":"late"}`, nil)
	wantCode(t, err, domain.CodeJobNotPending)
}

func TestGoal_AutoWritesTheGoalButNeverOverTheOperators(t *testing.T) {
	e, _ := p2Env(t, tangent.ModeAuto)
	main := e.mainLine()
	e.turn(main.ID, "q", "a")
	jobs := jobsOf(tangent.JobKindGoalPropose, e.turn(main.ID, "q2", "a2").Jobs...)
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, jobs[0].ID, domain.GoalProposeMarker+`{"goal":"The model's goal"}`, nil); err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventGoalChanged)
	if goal, _ := e.engine.GetGoal(e.ctx, scopeA, main.ID); goal.Source != domain.GoalSourceAI || goal.Text != "The model's goal" {
		t.Fatalf("goal = %+v", goal)
	}
	other := e.mainLine()
	e.turn(other.ID, "q", "a")
	jobs = jobsOf(tangent.JobKindGoalPropose, e.turn(other.ID, "q2", "a2").Jobs...)
	e.engine.PutGoal(e.ctx, scopeA, other.ID, "The operator's goal")
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, jobs[0].ID, domain.GoalProposeMarker+`{"goal":"The model's goal"}`, nil); err != nil {
		t.Fatal(err)
	}
	if goal, _ := e.engine.GetGoal(e.ctx, scopeA, other.ID); goal.Text != "The operator's goal" || len(e.events.Types()) != 0 {
		t.Fatalf("kept: %+v %v", goal, e.events.Types())
	}
	asked, _ := e.engine.ProposeGoal(e.ctx, scopeA, other.ID)
	if err := e.engine.FinishJob(e.ctx, asked.ID, domain.GoalProposeMarker+`{"goal":"Asked for"}`, nil); err != nil {
		t.Fatal(err)
	}
	if goal, _ := e.engine.GetGoal(e.ctx, scopeA, other.ID); goal.Text != "Asked for" {
		t.Fatalf("the button replaces it in auto: %+v", goal)
	}
}

func TestGoal_DriftIsCheckedEveryNMainLineRepliesAndAcceptingOpensABranch(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Goal.DriftEvery = 2
	e, _ := p2Env(t, tangent.ModeSuggest, tangent.WithLimits(limits))
	main := e.mainLine()
	first := e.turn(main.ID, "q", "a")
	if jobs := e.turn(main.ID, "q2", "a2").Jobs; len(jobsOf(tangent.JobKindDriftCheck, jobs...)) != 0 {
		t.Fatal("no goal, no drift check")
	}
	e.engine.PutGoal(e.ctx, scopeA, main.ID, "Plan Kyoto")
	branch := e.branch(main.ID, first.Message.ID, "side")
	for range 2 {
		if jobs := e.turn(branch.Line.ID, "b", "b").Jobs; len(jobsOf(tangent.JobKindDriftCheck, jobs...)) != 0 {
			t.Fatal("branches are not checked")
		}
	}
	if jobs := e.turn(main.ID, "q3", "a3").Jobs; len(jobsOf(tangent.JobKindDriftCheck, jobs...)) != 0 {
		t.Fatal("3 replies: not yet")
	}
	fourth := e.turn(main.ID, "What about Tokyo ramen?", "Try Ichiran")
	jobs := jobsOf(tangent.JobKindDriftCheck, fourth.Jobs...)
	if len(jobs) != 1 || !strings.Contains(jobs[0].Prompt.UserMessage, "> Plan Kyoto") || !strings.Contains(jobs[0].Prompt.UserMessage, "Tokyo ramen") {
		t.Fatalf("a drift check after 4 replies: %+v", fourth.Jobs)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, jobs[0].ID, domain.DriftCheckMarker+`{"drift":true,"kind":"aside","purpose":"Ramen in Tokyo","reason":"Tokyo is not the goal"}`, nil); err != nil {
		t.Fatal(err)
	}
	s := e.events.OfType(tangent.EventSuggestionChanged)[0].Data.(tangent.SuggestionChange).Suggestion
	var payload tangent.DriftPayload
	if s.Kind != tangent.SuggestionKindDrift || json.Unmarshal(s.Payload, &payload) != nil || payload.AnchorMessageID != fourth.Message.ID ||
		payload.Kind != domain.BranchKindAside || payload.Purpose != "Ramen in Tokyo" || payload.Goal != "Plan Kyoto" {
		t.Fatalf("drift = %+v %+v", s, payload)
	}
	accepted, err := e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, json.RawMessage(`{"kind":"investigate","purpose":"Tokyo food"}`))
	if err != nil {
		t.Fatal(err)
	}
	opened := accepted.Result.(tangent.DriftAccepted)
	if opened.Branch.AnchorMessageID != fourth.Message.ID || opened.Branch.Purpose != "Tokyo food" || opened.Branch.Kind != domain.BranchKindInvestigate || accepted.Suggestion.Status != domain.SuggestionAccepted {
		t.Fatalf("accepted = %+v", accepted)
	}
	e.turn(main.ID, "q5", "a5")
	on := jobsOf(tangent.JobKindDriftCheck, e.turn(main.ID, "q6", "a6").Jobs...)
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, on[0].ID, domain.DriftCheckMarker+`{"drift":false}`, nil); err != nil || len(e.events.OfType(tangent.EventSuggestionChanged)) != 0 {
		t.Fatalf("on topic raises nothing: %v %v", err, e.events.Types())
	}
}

func TestGoal_ConcurrentAcceptsOfOneProposalApplyOnce(t *testing.T) {
	e, _ := p2Env(t, tangent.ModeManual)
	main := e.mainLine()
	e.turn(main.ID, "q", "a")
	s := e.proposeGoal(main.ID, "Only once")
	results := make(chan error, 3)
	for _, text := range []string{"", "Mine", "Also mine"} {
		go func() {
			body := json.RawMessage(`{"text":"` + text + `"}`)
			_, err := e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, body)
			results <- err
		}()
	}
	won := 0
	for range 3 {
		switch err := <-results; {
		case err == nil:
			won++
		case domain.CodeOf(err) != domain.CodeSuggestionNotOpen:
			t.Fatalf("unexpected: %v", err)
		}
	}
	if won != 1 || e.count(`SELECT count(*) FROM tangent_suggestion WHERE id = $1 AND status = 'accepted'`, s.ID) != 1 {
		t.Fatalf("%d accepts won", won)
	}
}

func TestGoal_TheOperatorsGoalExpiresOpenProposals(t *testing.T) {
	e, _ := p2Env(t, tangent.ModeManual)
	main := e.mainLine()
	e.turn(main.ID, "q", "a")
	proposal := e.proposeGoal(main.ID, "The model's idea")
	other := e.mainLine()
	e.turn(other.ID, "q", "a")
	untouched := e.proposeGoal(other.ID, "Another conversation's idea")
	e.rollsBack("put goal", func(opt tangent.TxOption) error {
		_, err := e.engine.PutGoal(e.ctx, scopeA, main.ID, "rolled back", opt)
		return err
	})
	e.events.Reset()
	if _, err := e.engine.PutGoal(e.ctx, scopeA, main.ID, "My own goal"); err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventGoalChanged, tangent.EventSuggestionChanged, tangent.EventLineUpdated)
	if s := e.events.OfType(tangent.EventSuggestionChanged)[0].Data.(tangent.SuggestionChange).Suggestion; s.ID != proposal.ID || s.Status != domain.SuggestionExpired {
		t.Fatalf("expired = %+v", s)
	}
	_, err := e.engine.AcceptSuggestion(e.ctx, scopeA, proposal.ID, nil)
	wantCode(t, err, domain.CodeSuggestionNotOpen)
	if e.count(`SELECT count(*) FROM tangent_suggestion WHERE id = $1 AND status = 'open'`, untouched.ID) != 1 {
		t.Fatal("another conversation's proposal stays open")
	}
	e.events.Reset()
	if _, err := e.engine.PutGoal(e.ctx, scopeA, main.ID, "Again"); err != nil || len(e.events.OfType(tangent.EventSuggestionChanged)) != 0 {
		t.Fatalf("nothing left to expire: %v %v", err, e.events.Types())
	}
}
