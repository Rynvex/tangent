package tangent_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// draftable is a main line with a branch that has one exchange.
func (e *env) draftable() (main domain.LineView, branch tangent.CreatedBranch, reply domain.Message) {
	e.t.Helper()
	main = e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch = e.branch(main.ID, anchor.Message.ID, "side")
	return main, branch, e.turn(branch.Line.ID, "bq", "ba").Message
}

func TestJobs_DraftFailuresAreStoredWithFixedReasons(t *testing.T) {
	e := newEnv(t)
	_, branch, _ := e.draftable()
	cases := []struct {
		raw    string
		runErr error
		want   string
	}{
		{"", errors.New("rate limited with key sk-123"), domain.DraftRunFailedText},
		{"no marker here", nil, domain.DraftUnusableText},
		{domain.BranchCardMarker + `{"question":"q","conclusion":"","evidence":[{"messageId":"` + uuid.NewString() + `"}]}`, nil, domain.DraftUnusableText},
	}
	for i, c := range cases {
		job, err := e.engine.StartDraft(e.ctx, scopeA, branch.Line.ID)
		if err != nil {
			t.Fatal(err)
		}
		_, err = e.engine.BeginTurn(e.ctx, scopeA, branch.Line.ID, tangent.TurnInput{Content: "while drafting"})
		wantCode(t, err, domain.CodeBranchDrafting)
		if err := e.engine.FinishJob(e.ctx, job.ID, c.raw, c.runErr); err != nil {
			t.Fatal(err)
		}
		detail, _ := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
		if detail.Draft.Status != domain.BranchDraftFailed || detail.Draft.Error != c.want {
			t.Fatalf("case %d: draft = %+v", i, detail.Draft)
		}
		if err := e.engine.FinishJob(e.ctx, job.ID, c.raw, nil); !errors.Is(err, domain.ErrJobNotPending) {
			t.Fatalf("case %d: second finish err = %v", i, err)
		}
	}
	if err := e.engine.FinishJob(e.ctx, uuid.NewString(), "", nil); !errors.Is(err, domain.ErrJobNotFound) {
		t.Fatalf("unknown job err = %v", err)
	}
	_, err := e.engine.StartDraft(e.ctx, scopeA, e.mainLine().ID)
	wantCode(t, err, domain.CodeBranchNotFound)
}

func TestJobs_ASupersededDraftWritesNothing(t *testing.T) {
	e := newEnv(t)
	_, branch, reply := e.draftable()
	first, err := e.engine.StartDraft(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, branch.Line.ID); err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	err = e.engine.FinishJob(e.ctx, first.ID, draftReply(t, reply.ID), nil)
	if !errors.Is(err, domain.ErrDraftNotPending) {
		t.Fatalf("err = %v", err)
	}
	e.wantTypes(tangent.EventBranchChanged)
}

func TestJobs_StaleDraftJobsFailAndRepublishTheBranch(t *testing.T) {
	shift := time.Duration(0)
	e := newEnv(t, tangent.WithClock(func() time.Time { return time.Now().Add(shift) }))
	_, branch, _ := e.draftable()
	job, err := e.engine.StartDraft(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	shift = time.Hour
	e.events.Reset()
	failed, err := e.engine.FailStaleJobs(e.ctx)
	if err != nil || len(failed) != 1 || failed[0].ID != job.ID || failed[0].Status != store.JobFailed {
		t.Fatalf("failed = %+v, %v", failed, err)
	}
	e.wantTypes(tangent.EventBranchChanged)
	if view := e.events.Events()[0].Data.(tangent.BranchChange).Branch; view.DraftStatus != domain.BranchDraftFailed {
		t.Fatalf("draft status = %q", view.DraftStatus)
	}
}

func TestJobs_SummaryIsStoredAndReplacesTheHistoryItCovers(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	_, err := e.engine.StartSummary(e.ctx, scopeA, main.ID)
	wantCode(t, err, domain.CodeNoMessages)
	first := e.turn(main.ID, "talk about databases", "Postgres is good")
	job, err := e.engine.StartSummary(e.ctx, scopeA, main.ID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Kind != tangent.JobKindSummary || !strings.Contains(job.Prompt.UserMessage, "Postgres is good") || job.Provider != "anthropic" {
		t.Fatalf("job = %+v", job)
	}
	e.events.Reset()
	reply := domain.SummaryMarker + "\n" + `{"topic":"databases","decisions":["use Postgres"],"topicStartMessageId":"` + first.Message.ID + `"}`
	if err := e.engine.FinishJob(e.ctx, job.ID, reply, nil); err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventLineUpdated, tangent.EventChaptersChanged)
	line := e.events.Events()[0].Data.(domain.LineView)
	if line.Summary.Topic != "databases" || line.SummaryUptoSeq != first.Message.Seq {
		t.Fatalf("summary = %+v upto %d", line.Summary, line.SummaryUptoSeq)
	}
	e.turn(main.ID, "next", "ok")
	last := e.runner.Requests()[len(e.runner.Requests())-1]
	if !strings.Contains(last.System, "use Postgres") || strings.Contains(last.System+last.Messages[0].Content, "Postgres is good") {
		t.Fatalf("the summary must stand for the history it covers:\n%s\n%+v", last.System, last.Messages)
	}
}

func TestJobs_FailedOrUnusableSummariesKeepThePreviousOne(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	e.turn(main.ID, "q", "a")
	for i, c := range []struct {
		raw    string
		runErr error
	}{{"", tangenttest.ErrFake}, {"not a summary", nil}} {
		job, err := e.engine.StartSummary(e.ctx, scopeA, main.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := e.engine.FinishJob(e.ctx, job.ID, c.raw, c.runErr); err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if e.count(`SELECT count(*) FROM tangent_job WHERE id = $1 AND status = 'failed'`, job.ID) != 1 {
			t.Fatalf("case %d: the job must be failed", i)
		}
	}
	line, _ := e.engine.GetLine(e.ctx, scopeA, main.ID)
	if line.SummaryUptoSeq != 0 {
		t.Fatal("a failed summary must not move the cursor")
	}
}

func TestJobs_AJobOfAnUnknownKindHasNoHandler(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	s, err := store.New(e.pool, domain.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	job, err := s.CreateJob(e.ctx, store.CreateJobInput{Tenant: scopeA.Tenant, Kind: "leaf_draft", Feature: "leaf", LineID: main.ID})
	if err != nil {
		t.Fatal(err)
	}
	err = e.engine.FinishJob(e.ctx, job.ID, "x", nil)
	wantCode(t, err, domain.CodeFeatureDisabled)
	if e.count(`SELECT count(*) FROM tangent_job WHERE id = $1 AND status = 'failed'`, job.ID) != 1 {
		t.Fatal("a job no feature handles must be failed, not left pending")
	}
}
