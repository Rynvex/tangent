package tangent_test

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// syncBuffer is a log sink safe for the engine's goroutines.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// B11 soak: an Auto goal proposal whose conversation was archived while the
// job ran finished the job (done) but returned the archived refusal, so the
// dispatcher logged "job result not recorded" at ERROR although the result
// was recorded. The goal is not written (an archived tree takes no writes),
// FinishJob succeeds and the skipped write is a warning.
func TestB11_AnAutoGoalForAnArchivedConversationIsSkippedNotAnError(t *testing.T) {
	logs := &syncBuffer{}
	e, _ := p2Env(t, tangent.ModeAuto, tangent.WithLogger(slog.New(slog.NewTextHandler(logs, nil))))
	main := e.mainLine()
	e.turn(main.ID, "q", "a")
	jobs := jobsOf(tangent.JobKindGoalPropose, e.turn(main.ID, "q2", "a2").Jobs...)
	if len(jobs) != 1 {
		t.Fatalf("goal jobs %v", jobs)
	}
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, main.ID, true); err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, jobs[0].ID, domain.GoalProposeMarker+`{"goal":"Too late"}`, nil); err != nil {
		t.Fatalf("finishing the job: %v", err)
	}
	if goal, err := e.engine.GetGoal(e.ctx, scopeA, main.ID); err != nil || goal != nil {
		t.Fatalf("no goal on an archived tree: %+v %v", goal, err)
	}
	if types := e.events.Types(); len(types) != 0 {
		t.Fatalf("events %v", types)
	}
	if text := logs.String(); strings.Contains(text, "level=ERROR") || !strings.Contains(text, "automatic goal was not written") {
		t.Fatalf("logs:\n%s", text)
	}
	if err := e.engine.FinishJob(e.ctx, jobs[0].ID, domain.GoalProposeMarker+`{"goal":"again"}`, nil); err == nil {
		t.Fatal("the job is done: a second result is refused")
	}
}

// relationSetup merges a branch with an open sibling, so a relation job
// names both; it returns the job, the sibling and the key the job's prompt
// gives the sibling.
func relationSetup(t *testing.T, e *env, sink *recordingDispatcher) (tangent.Job, string, string) {
	t.Helper()
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	hotels := e.branch(main.ID, anchor.Message.ID, "Hotel prices")
	ryokan := e.branch(main.ID, anchor.Message.ID, "Ryokan prices")
	e.turn(ryokan.Line.ID, "how much?", "30,000 yen")
	sink.jobs = nil
	e.mergeWithCard(ryokan.Line.ID, domain.BranchCard{Question: "Ryokan cost?", Conclusion: "About 30,000 yen"})
	jobs := jobsOf(tangent.JobKindRelationSuggest, sink.jobs...)
	if len(jobs) != 1 {
		t.Fatalf("relation jobs %+v", sink.jobs)
	}
	key := ""
	for _, line := range strings.Split(jobs[0].Prompt.UserMessage, "\n") {
		if strings.Contains(line, "Hotel prices") {
			key = strings.TrimSpace(strings.SplitN(strings.TrimPrefix(line, "> "), ":", 2)[0])
		}
	}
	return jobs[0], hotels.Line.ID, key
}

// B11 soak: a relation suggestion named a branch that a detach then took
// to its own tree; it stayed open and accepting it answered 400
// invalid_input. The detach expires it (suggestion.changed), and accepting
// it is suggestion_not_open.
func TestB11_ADetachExpiresTheRelationSuggestionsNamingTheBranch(t *testing.T) {
	e, sink := p2Env(t, tangent.ModeSuggest)
	job, hotels, key := relationSetup(t, e, sink)
	if err := e.engine.FinishJob(e.ctx, job.ID, domain.RelationSuggestMarker+`{"relations":[{"to":"`+key+`","label":"Both lodging"}]}`, nil); err != nil {
		t.Fatal(err)
	}
	raised := e.events.OfType(tangent.EventSuggestionChanged)
	if len(raised) == 0 {
		t.Fatal("no relation suggestion")
	}
	s := raised[len(raised)-1].Data.(tangent.SuggestionChange).Suggestion
	e.events.Reset()
	if _, err := e.engine.Spinoff(e.ctx, scopeA, hotels, tangent.SpinoffInput{Mode: domain.SpinoffDetach}); err != nil {
		t.Fatal(err)
	}
	expired := false
	for _, ev := range e.events.OfType(tangent.EventSuggestionChanged) {
		got := ev.Data.(tangent.SuggestionChange).Suggestion
		expired = expired || (got.ID == s.ID && got.Status == domain.SuggestionExpired)
	}
	if !expired {
		t.Fatalf("the detach did not expire %s: %v", s.ID, e.events.Types())
	}
	if _, err := e.engine.AcceptSuggestion(e.ctx, scopeA, s.ID, nil); domain.CodeOf(err) != "suggestion_not_open" {
		t.Fatalf("accepting the expired relation: %v", err)
	}
}

// The race the other way: the relation job finishes after the detach took
// the branch it names; nothing is raised.
func TestB11_ARelationJobFinishingAfterTheDetachRaisesNothing(t *testing.T) {
	e, sink := p2Env(t, tangent.ModeSuggest)
	job, hotels, key := relationSetup(t, e, sink)
	if _, err := e.engine.Spinoff(e.ctx, scopeA, hotels, tangent.SpinoffInput{Mode: domain.SpinoffDetach}); err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, job.ID, domain.RelationSuggestMarker+`{"relations":[{"to":"`+key+`","label":"Both lodging"}]}`, nil); err != nil {
		t.Fatal(err)
	}
	if got := e.events.OfType(tangent.EventSuggestionChanged); len(got) != 0 {
		t.Fatalf("raised %+v", got)
	}
}

// B11 soak: the consolidation sweep found a pair whose source line still
// existed, the conversation was deleted before the job started, and the
// whole maintenance task failed ("start memory_consolidate job:
// conversation not found", logged at ERROR every sweep), leaving the
// sweep's other pairs unstarted. The vanished pair is skipped.
func TestB11_ConsolidationSkipsAPairWhoseConversationWentInBetween(t *testing.T) {
	e, sink := memoryEnv(t, tangent.ModeSuggest, tangent.MemoryConfig{})
	gone, kept := e.mainLine(), e.mainLine()
	memory := func(line, text string) domain.Memory {
		m, err := e.engine.CreateMemory(e.ctx, scopeA, tangent.MemoryCreate{Memory: domain.MemoryInput{Kind: domain.MemoryFact, Text: text}, SourceLineID: line})
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	a, b := memory(gone.ID, "Use a ZFS mirror"), memory(gone.ID, "use a zfs mirror")
	c, d := memory(kept.ID, "Kyoto in spring"), memory(kept.ID, "kyoto in spring")
	if _, err := e.engine.DeleteTree(e.ctx, scopeA, gone.ID); err != nil {
		t.Fatal(err)
	}
	pairs := []store.MemoryPair{
		{Tenant: scopeA.Tenant, A: a, B: b, LineID: gone.ID, Key: a.ID + ":" + b.ID},
		{Tenant: scopeA.Tenant, A: c, B: d, LineID: kept.ID, Key: c.ID + ":" + d.ID},
	}
	started, err := e.engine.ConsolidatePairs(e.ctx, pairs)
	if err != nil || started != 1 {
		t.Fatalf("started %d, err %v", started, err)
	}
	if jobs := jobsOf(tangent.JobKindMemoryConsolidate, sink.jobs...); len(jobs) != 1 || jobs[0].LineID != kept.ID {
		t.Fatalf("jobs %+v", jobs)
	}
}

// B11 soak: an ibis_tag job's conversation was deleted after FinishJob read
// the job and before its handler locked the line; the handler answered
// line_not_found and the dispatcher logged "job result not recorded" at
// ERROR, although the job had simply gone with its conversation. A handler
// error for a job that no longer exists is job_not_found, which the
// dispatcher takes as nothing to record.
func TestB11_AJobWhoseConversationWentWhileFinishingIsNotFound(t *testing.T) {
	var e *env
	deleteFirst := true
	spec := tangent.StubSpec{
		Name: "probe", JobKind: "probe_job",
		FinishJob: func(job tangent.JobRecord, _ string) error {
			if deleteFirst {
				if _, err := e.engine.DeleteTree(e.ctx, scopeA, job.LineID); err != nil {
					return err
				}
			}
			return domain.ErrLineNotFound // what a handler that locks the line next sees
		},
	}
	e = newEnvWith(t, []tangent.Feature{tangent.StubFeature(spec)})
	job := func() tangent.JobRecord {
		record, err := e.rawStore().CreateJob(e.ctx, store.CreateJobInput{Tenant: scopeA.Tenant, Kind: "probe_job", Feature: "probe", LineID: e.mainLine().ID})
		if err != nil {
			t.Fatal(err)
		}
		return record
	}
	if err := e.engine.FinishJob(e.ctx, job().ID, "raw", nil); !errors.Is(err, domain.ErrJobNotFound) {
		t.Fatalf("finishing a job that went with its conversation: %v", err)
	}
	deleteFirst = false
	if err := e.engine.FinishJob(e.ctx, job().ID, "raw", nil); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("a job that is still there keeps its handler's error: %v", err)
	}
}
