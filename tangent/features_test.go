package tangent_test

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// without is AllFeatures minus one feature.
func without(name string) []tangent.Feature {
	out := []tangent.Feature{}
	for _, f := range tangent.AllFeatures() {
		if f.Name() != name {
			out = append(out, f)
		}
	}
	return out
}

// rawStore is a store over the env's pool, for data a disabled feature
// would have written earlier.
func (e *env) rawStore() *store.Store {
	e.t.Helper()
	s, err := store.New(e.pool, domain.DefaultLimits())
	if err != nil {
		e.t.Fatal(err)
	}
	return s
}

// lastSystem is the system text of the runner's newest request.
func (e *env) lastSystem() string {
	requests := e.runner.Requests()
	return requests[len(requests)-1].System
}

func TestNotes_OnCarriesAndPublishesNotes(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	e.events.Reset()
	write, err := e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionDecided, Text: "use Postgres"}})
	if err != nil || write.Revision != 1 {
		t.Fatalf("write = %+v, %v", write, err)
	}
	e.wantTypes(tangent.EventNotesChanged)
	e.turn(main.ID, "q", "a")
	if !strings.Contains(e.lastSystem(), "use Postgres") {
		t.Fatalf("the prompt must carry the notes:\n%s", e.lastSystem())
	}
	text := "use Postgres 17"
	update, err := e.engine.UpdateNote(e.ctx, scopeA, main.ID, write.Created[0].ID, tangent.NotePatch{Text: &text})
	if err != nil || update.Note.Text != text {
		t.Fatalf("update = %+v, %v", update, err)
	}
	superseded, err := e.engine.SupersedeNote(e.ctx, scopeA, main.ID, write.Created[0].ID, tangent.NoteInput{Text: "use Postgres 18"})
	if err != nil || len(superseded.Superseded) != 1 {
		t.Fatalf("supersede = %+v, %v", superseded, err)
	}
	view, err := e.engine.ListNotes(e.ctx, scopeA, main.ID)
	if err != nil || view.Revision != 3 || len(view.Notes) != 2 {
		t.Fatalf("view = %+v, %v", view, err)
	}
}

func TestNotes_OffKeepsNotesOutOfThePromptAndRefusesNoteWrites(t *testing.T) {
	e := newEnvWith(t, without(tangent.FeatureNotes))
	main := e.mainLine()
	if _, err := e.rawStore().ApplyNoteChanges(e.ctx, store.ApplyNotesInput{Tenant: scopeA.Tenant, LineID: main.ID, Changes: []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "stored earlier"}}}); err != nil {
		t.Fatal(err)
	}
	anchor := e.turn(main.ID, "q", "a")
	if strings.Contains(e.lastSystem(), "stored earlier") {
		t.Fatal("notes must not reach the prompt when the feature is off")
	}
	_, err := e.engine.ListNotes(e.ctx, scopeA, main.ID)
	wantCode(t, err, domain.CodeFeatureDisabled)
	branch := e.branch(main.ID, anchor.Message.ID, "side")
	reply := e.turn(branch.Line.ID, "bq", "ba")
	detail, _ := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	_, err = e.engine.MergeBranch(e.ctx, scopeA, branch.Line.ID, tangent.MergeInput{
		Card:               domain.BranchCard{Question: "q", Conclusion: "c", Evidence: []domain.BranchCardEvidence{{MessageID: reply.Message.ID}}},
		ParentTipMessageID: detail.ParentTipMessageID, NoteChanges: []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "x"}},
	})
	wantCode(t, err, domain.CodeFeatureDisabled)
}

// summarized gives a line a stored summary through the summary job.
func (e *env) summarized(lineID string) {
	e.t.Helper()
	job, err := e.engine.StartSummary(e.ctx, scopeA, lineID)
	if err != nil {
		e.t.Fatal(err)
	}
	reply := domain.SummaryMarker + "\n" + `{"topic":"brand new topic","decisions":["remember the summary"]}`
	if err := e.engine.FinishJob(e.ctx, job.ID, reply, nil); err != nil {
		e.t.Fatal(err)
	}
}

func TestChapters_OnRecordsCutsAndMilestones(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	first := e.turn(main.ID, "q", "a")
	e.events.Reset()
	e.summarized(main.ID)
	if len(e.events.OfType(tangent.EventChaptersChanged)) != 1 {
		t.Fatalf("a topic cut must publish chapters.changed: %v", e.events.Types())
	}
	change, err := e.engine.AddMilestone(e.ctx, scopeA, main.ID, tangent.MilestoneInput{MessageID: first.Message.ID, Title: "start"})
	if err != nil {
		t.Fatal(err)
	}
	view, err := e.engine.ListChapters(e.ctx, scopeA, main.ID)
	if err != nil || len(view.Milestones) != 1 {
		t.Fatalf("view = %+v, %v", view, err)
	}
	if root, err := e.engine.DeleteMilestone(e.ctx, scopeA, main.ID, change.Cut.ID); err != nil || root != main.ID {
		t.Fatalf("delete = %q, %v", root, err)
	}
	if len(e.events.OfType(tangent.EventChaptersChanged)) != 3 {
		t.Fatalf("events = %v", e.events.Types())
	}
}

func TestChapters_OffRecordsNoCutAndRefusesChapterCalls(t *testing.T) {
	e := newEnvWith(t, without(tangent.FeatureChapters))
	main := e.mainLine()
	e.turn(main.ID, "q", "a")
	e.summarized(main.ID)
	if e.count(`SELECT count(*) FROM tangent_chapter_cut`) != 0 || len(e.events.OfType(tangent.EventChaptersChanged)) != 0 {
		t.Fatal("no topic cut may be recorded with chapters off")
	}
	_, err := e.engine.ListChapters(e.ctx, scopeA, main.ID)
	wantCode(t, err, domain.CodeFeatureDisabled)
	_, err = e.engine.AddMilestone(e.ctx, scopeA, main.ID, tangent.MilestoneInput{})
	wantCode(t, err, domain.CodeFeatureDisabled)
	_, err = e.engine.DeleteMilestone(e.ctx, scopeA, main.ID, "x")
	wantCode(t, err, domain.CodeFeatureDisabled)
}

func TestAside_OnPurgesExpiredAsidesThroughMaintain(t *testing.T) {
	shift := time.Duration(0)
	e := newEnv(t, tangent.WithClock(func() time.Time { return time.Now().Add(shift) }))
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	aside, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Purpose: "quick", Kind: domain.BranchKindAside})
	if err != nil {
		t.Fatal(err)
	}
	e.turn(aside.Line.ID, "2+2?", "4")
	shift = 8 * 24 * time.Hour
	e.events.Reset()
	report, err := e.engine.Maintain(e.ctx)
	if err != nil || report.Tasks[tangent.TaskPurgeAsides] != 1 {
		t.Fatalf("report = %+v, %v", report, err)
	}
	e.wantTypes(tangent.EventLineDeleted)
	if purged, err := e.engine.PurgeExpiredAsides(e.ctx); err != nil || len(purged) != 0 {
		t.Fatalf("second purge = %+v, %v", purged, err)
	}
}

func TestAside_OffRefusesAsides(t *testing.T) {
	e := newEnvWith(t, without(tangent.FeatureAside))
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	_, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Purpose: "quick", Kind: domain.BranchKindAside})
	wantCode(t, err, domain.CodeFeatureDisabled)
	e.turn(main.ID, "q2", "a2")
	_, err = e.engine.MoveToBranch(e.ctx, scopeA, main.ID, tangent.MoveInput{Count: 2, Purpose: "m", Kind: domain.BranchKindAside})
	wantCode(t, err, domain.CodeFeatureDisabled)
	_, err = e.engine.PurgeExpiredAsides(e.ctx)
	wantCode(t, err, domain.CodeFeatureDisabled)
	if report, err := e.engine.Maintain(e.ctx); err != nil || report.Tasks[tangent.TaskPurgeAsides] != 0 {
		t.Fatalf("report = %+v, %v", report, err)
	}
}

func TestSummary_ModesReportOrStartTheSummary(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.History.SummaryTriggerTokens = 5
	for _, mode := range []tangent.Mode{tangent.ModeManual, tangent.ModeSuggest, tangent.ModeAuto} {
		features := append(without(tangent.FeatureSummary), tangent.Summary(mode, tangent.JobModel("anthropic", "haiku")))
		e := newEnvWith(t, features, tangent.WithLimits(limits))
		main := e.mainLine()
		done := e.turn(main.ID, "a fairly long question about many things", "an equally long answer")
		if done.SummaryDue != (mode == tangent.ModeSuggest) || (len(done.Jobs) == 1) != (mode == tangent.ModeAuto) {
			t.Fatalf("%v: due %v jobs %+v", mode, done.SummaryDue, done.Jobs)
		}
		if mode == tangent.ModeAuto && (done.Jobs[0].Model != "haiku" || done.Jobs[0].Kind != tangent.JobKindSummary) {
			t.Fatalf("auto job = %+v", done.Jobs[0])
		}
	}
}

func TestSummary_AutoJobsAreDispatchedAfterTheTurn(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.History.SummaryTriggerTokens = 5
	e := newEnvWith(t, append(without(tangent.FeatureSummary), tangent.Summary(tangent.ModeAuto)), tangent.WithLimits(limits))
	main := e.mainLine()
	runner := tangenttest.NewFakeRunner(tangenttest.Reply{Content: "a long enough answer here"},
		tangenttest.Reply{Content: domain.SummaryMarker + `{"topic":"auto"}`})
	d := tangent.NewRunnerDispatcher(e.engine, runner)
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "a long enough question here"})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.DispatchTurn(e.ctx, turn); err != nil {
		t.Fatal(err)
	}
	if !e.events.WaitFor(tangent.EventLineUpdated, 3, 5*time.Second) {
		t.Fatal("no summary arrived")
	}
	if err := d.Shutdown(e.ctx); err != nil {
		t.Fatal(err)
	}
	line, _ := e.engine.GetLine(e.ctx, scopeA, main.ID)
	if line.Summary.Topic != "auto" {
		t.Fatalf("summary = %+v", line.Summary)
	}
}

func TestSummary_AFailedSummaryIsNotReportedDueAgainAtOnce(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.History.SummaryTriggerTokens = 5
	e := newEnv(t, tangent.WithLimits(limits))
	main := e.mainLine()
	e.turn(main.ID, "a fairly long question", "a fairly long answer")
	job, err := e.engine.StartSummary(e.ctx, scopeA, main.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.engine.FinishJob(e.ctx, job.ID, "garbage", nil); err != nil {
		t.Fatal(err)
	}
	if done := e.turn(main.ID, "more words", "more words"); done.SummaryDue {
		t.Fatal("a summary that just failed must back off")
	}
}

func TestSummary_TheCursorStopsBeforeAnUndeliveredCard(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "side")
	reply := e.turn(branch.Line.ID, "bq", "ba")
	detail, _ := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	card := domain.BranchCard{Question: "q", Conclusion: "c", Evidence: []domain.BranchCardEvidence{{MessageID: reply.Message.ID}}}
	if _, err := e.engine.MergeBranch(e.ctx, scopeA, branch.Line.ID, tangent.MergeInput{Card: card, ParentTipMessageID: detail.ParentTipMessageID}); err != nil {
		t.Fatal(err)
	}
	job, err := e.engine.StartSummary(e.ctx, scopeA, main.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.engine.FinishJob(e.ctx, job.ID, domain.SummaryMarker+`{"topic":"t"}`, nil); err != nil {
		t.Fatal(err)
	}
	line, _ := e.engine.GetLine(e.ctx, scopeA, main.ID)
	if line.SummaryUptoSeq != anchor.Message.Seq {
		t.Fatalf("cursor %d, want the reply before the card (%d)", line.SummaryUptoSeq, anchor.Message.Seq)
	}
}

func TestSummary_OffKeepsStoredSummariesOutOfPromptsAndPacks(t *testing.T) {
	e := newEnvWith(t, without(tangent.FeatureSummary))
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	if _, err := e.rawStore().SaveSummary(e.ctx, store.SaveSummaryInput{
		Tenant: scopeA.Tenant, LineID: main.ID, Summary: domain.Summary{Topic: "secret topic"}, UptoSeq: anchor.Message.Seq,
	}); err != nil {
		t.Fatal(err)
	}
	e.turn(main.ID, "q2", "a2")
	if strings.Contains(e.lastSystem(), "secret topic") {
		t.Fatal("a stored summary must not reach the prompt with summary off")
	}
	branch := e.branch(main.ID, anchor.Message.ID, "side")
	if strings.Contains(branch.Pack.Rendered, "secret topic") {
		t.Fatal("a stored summary must not reach a pack with summary off")
	}
	_, err := e.engine.StartSummary(e.ctx, scopeA, main.ID)
	wantCode(t, err, domain.CodeFeatureDisabled)
}

func TestBranchSuggest_ManualAndOffParseNothing(t *testing.T) {
	reply := "Sure.\n" + domain.BranchSuggestMarker + ` {"purpose":"look elsewhere","kind":"investigate"}`
	for name, features := range map[string][]tangent.Feature{
		"manual": append(without(tangent.FeatureBranchSuggest), tangent.BranchSuggest(tangent.ModeManual)),
		"off":    without(tangent.FeatureBranchSuggest),
	} {
		e := newEnvWith(t, features)
		main := e.mainLine()
		done := e.turn(main.ID, "q", reply)
		if strings.Contains(e.lastSystem(), domain.BranchSuggestMarker) || done.Message.Content != reply || len(done.Message.Meta.Suggestions) != 0 {
			t.Fatalf("%s: rule or parsing leaked: %+v", name, done.Message)
		}
		_, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{
			AnchorMessageID: done.Message.ID, Purpose: "look elsewhere", Kind: domain.BranchKindInvestigate, SuggestionMessageID: done.Message.ID,
		})
		want := domain.CodeSuggestionNotFound
		if name == "off" {
			want = domain.CodeFeatureDisabled
		}
		wantCode(t, err, want)
	}
}

// policy narrows features per tenant.
type policy map[string]tangent.Mode

func (p policy) Mode(_ context.Context, scope tangent.Scope, feature string) tangent.Mode {
	if mode, ok := p[scope.Tenant+"/"+feature]; ok {
		return mode
	}
	return tangent.ModeAuto
}

func TestPolicy_OnlyNarrows(t *testing.T) {
	features := []tangent.Feature{tangent.Notes(), tangent.Summary(tangent.ModeSuggest)}
	e := newEnvWith(t, features, tangent.WithFeaturePolicy(policy{
		"tenant-b/notes": tangent.ModeOff, "tenant-a/summary": tangent.ModeAuto, "tenant-b/summary": tangent.ModeManual,
	}))
	caps := func(scope tangent.Scope) string {
		list, err := e.engine.Capabilities(e.ctx, scope)
		if err != nil {
			t.Fatal(err)
		}
		parts := []string{}
		for _, c := range list {
			parts = append(parts, c.Name+"="+map[bool]string{true: "on", false: "off"}[c.Enabled]+c.Mode)
		}
		return strings.Join(parts, ",")
	}
	if got := caps(scopeA); got != "notes=on,chapters=off,aside=off,summary=onsuggest,card_draft=off,branch_suggest=offoff,search=off,leaf=offoff,parking=off,spinoff=off,rebalance=offoff,goal=offoff,relations=offoff,open_loops=off,fisheye=off,group=offoff,ibis=offoff,fold=offoff,diverge=offoff,memory=offoff,memo=off,glossary=off,suggestions=off" {
		t.Fatalf("tenant a: %s", got)
	}
	if got := caps(scopeB); got != "notes=off,chapters=off,aside=off,summary=onmanual,card_draft=off,branch_suggest=offoff,search=off,leaf=offoff,parking=off,spinoff=off,rebalance=offoff,goal=offoff,relations=offoff,open_loops=off,fisheye=off,group=offoff,ibis=offoff,fold=offoff,diverge=offoff,memory=offoff,memo=off,glossary=off,suggestions=off" {
		t.Fatalf("tenant b: %s", got)
	}
	line, err := e.engine.CreateLine(e.ctx, scopeB, tangent.LineInput{Title: "b"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.engine.ListNotes(e.ctx, scopeB, line.ID)
	wantCode(t, err, domain.CodeFeatureDisabled)
	_, err = e.engine.Capabilities(e.ctx, tangent.Scope{})
	wantCode(t, err, domain.CodeInvalidInput)
}

func TestHooks_RunInOrderAndRollBackTheirWrite(t *testing.T) {
	order := []string{}
	stub := func(name string, fail bool) tangent.Feature {
		hook := func(context.Context, store.Tx) error {
			order = append(order, name)
			if fail {
				return errHook
			}
			return nil
		}
		return tangent.StubFeature(tangent.StubSpec{Name: name, OnTurnCompleted: hook, OnBranchCreated: hook, OnBranchClosed: hook})
	}
	e := newEnvWith(t, []tangent.Feature{stub("first", false), stub("second", false)})
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "side")
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, branch.Line.ID); err != nil {
		t.Fatal(err)
	}
	if strings.Join(order, ",") != "first,second,first,second,first,second" {
		t.Fatalf("order = %v", order)
	}

	failing := newEnvWith(t, []tangent.Feature{stub("bad", true)})
	main = failing.mainLine()
	turn, err := failing.engine.BeginTurn(failing.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	failing.events.Reset()
	if _, err := failing.engine.CompleteTurn(failing.ctx, turn.ID, tangent.TurnResult{Content: "a"}); err == nil || !strings.Contains(err.Error(), "feature bad") {
		t.Fatalf("err = %v", err)
	}
	if len(failing.events.Events()) != 0 || failing.count(`SELECT count(*) FROM tangent_message WHERE status = 'pending'`) != 1 {
		t.Fatal("a failing feature hook must roll the write back and publish nothing")
	}
}

func TestHooks_HistorySectionsAfterCommitJobsAndMaintenance(t *testing.T) {
	var finished []string
	spec := tangent.StubSpec{
		Name:    "probe",
		Section: &domain.PromptSection{Key: "probe", Title: "Probe", Body: "from a feature"},
		History: func(string) []domain.Message {
			return []domain.Message{{ID: "x", Seq: 1, Role: domain.RoleUser, Kind: domain.MessageKindChat, Content: "selected history", Status: domain.MessageDone}}
		},
		AfterCommit: func(kind string) []tangent.Event { return []tangent.Event{{Type: "probe." + kind}} },
		JobKind:     "probe_job",
		FinishJob:   func(job tangent.JobRecord, raw string) error { finished = append(finished, raw); return nil },
		Maintain:    func() (int, error) { return 1, errHook },
	}
	e := newEnvWith(t, []tangent.Feature{tangent.StubFeature(spec)})
	main := e.mainLine()
	e.turn(main.ID, "q", "a")
	last := e.runner.Requests()[0]
	if !strings.Contains(last.System, "from a feature") || !strings.HasPrefix(last.Messages[0].Content, "selected history") {
		t.Fatalf("request = %+v", last)
	}
	if len(e.events.OfType("probe.turn_completed")) != 1 {
		t.Fatalf("events = %v", e.events.Types())
	}
	job, err := e.rawStore().CreateJob(e.ctx, store.CreateJobInput{Tenant: scopeA.Tenant, Kind: "probe_job", Feature: "probe", LineID: main.ID})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.engine.FinishJob(e.ctx, job.ID, "raw", nil); err != nil || !slices.Equal(finished, []string{"raw"}) {
		t.Fatalf("finished = %v, %v", finished, err)
	}
	if _, err := e.engine.Maintain(e.ctx); err == nil || !strings.Contains(err.Error(), "feature probe") {
		t.Fatalf("maintain err = %v", err)
	}
}

func TestHooks_APolicyOffFeatureIsSkipped(t *testing.T) {
	called := false
	spec := tangent.StubSpec{Name: "probe", AfterCommit: func(string) []tangent.Event { called = true; return nil }}
	e := newEnvWith(t, []tangent.Feature{tangent.StubFeature(spec)}, tangent.WithFeaturePolicy(policy{"tenant-a/probe": tangent.ModeOff}))
	e.turn(e.mainLine().ID, "q", "a")
	if called {
		t.Fatal("a feature the policy switched off must not run")
	}
}
