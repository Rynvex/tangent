package store_test

import (
	"errors"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestSummary_RoundTripAndMessagesAfterTheCursor(t *testing.T) {
	f := newFixture(t)
	line, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant})
	if err != nil {
		t.Fatal(err)
	}
	first := f.message(line.ID, domain.RoleUser, "hello there")
	second := f.message(line.ID, domain.RoleAssistant, "general kenobi")
	saved, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: tenant, LineID: line.ID, Summary: domain.Summary{Topic: "greetings"}, UptoSeq: first.Seq})
	if err != nil || saved.Line.Summary.Topic != "greetings" || saved.Line.SummaryUptoSeq != first.Seq || saved.Line.Summary.Decisions == nil {
		t.Fatalf("save = %+v err=%v", saved, err)
	}
	after, err := f.store.MessagesAfterSummary(f.ctx, tenant, line.ID)
	if err != nil || len(after) != 1 || after[0].ID != second.ID {
		t.Fatalf("after the summary = %+v err=%v", after, err)
	}
	if _, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: tenant, LineID: line.ID, Summary: domain.Summary{Topic: "x"}, UptoSeq: second.Seq + 1000}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("a cursor that is not a message of the line = %v", err)
	}
	if _, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: otherTenant, LineID: line.ID, Summary: domain.Summary{Topic: "x"}}); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant = %v", err)
	}
}

func TestSummary_RecordsATopicCutAtTheReportedOrFirstMessage(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	msgs := f.fillLine(line.ID, 5)

	saved, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: tenant, LineID: line.ID, Summary: domain.Summary{Topic: "retry policy"},
		UptoSeq: msgs[5].Seq, ReportedTopicStart: msgs[3].ID})
	if err != nil || saved.TopicCut == nil || saved.TopicCut.MessageID != msgs[3].ID {
		t.Fatalf("reported cut = %+v err=%v", saved, err)
	}
	got := f.chapters(line.ID).Chapters
	if len(got) != 2 || got[1].StartMessageID != msgs[3].ID || got[1].Title != "retry policy" || got[1].Kind != domain.ChapterKindTopic {
		t.Fatalf("chapters = %+v", got)
	}
	// An id outside the input (an earlier message) falls back to the first
	// message after the previous cursor.
	saved, err = f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: tenant, LineID: line.ID, Summary: domain.Summary{Topic: "caching"},
		UptoSeq: msgs[len(msgs)-1].Seq, ReportedTopicStart: msgs[2].ID})
	if err != nil || saved.TopicCut == nil || saved.TopicCut.MessageID != msgs[6].ID || saved.TopicCut.Title != "caching" {
		t.Fatalf("fallback cut = %+v err=%v", saved.TopicCut, err)
	}
}

func TestSummary_WithoutAnIDAndWithoutATopicChangeAddsNoCut(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	msgs := f.fillLine(line.ID, 5)
	if _, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: tenant, LineID: line.ID, Summary: domain.Summary{Topic: "same topic"},
		UptoSeq: msgs[5].Seq, ReportedTopicStart: msgs[4].ID}); err != nil {
		t.Fatal(err)
	}
	saved, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: tenant, LineID: line.ID, Summary: domain.Summary{Topic: "Same Topic"}, UptoSeq: msgs[len(msgs)-1].Seq})
	if err != nil || saved.TopicCut != nil {
		t.Fatalf("second save = %+v err=%v", saved, err)
	}
	if got := f.chapters(line.ID).Chapters; len(got) != 2 {
		t.Fatalf("chapters = %+v", got)
	}
}

func TestSummary_AJobResultIsWrittenOnlyWhileTheJobIsPending(t *testing.T) {
	f := newFixture(t)
	line, anchor := f.mainLine()
	job, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: store.JobKindSummary, LineID: line.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: tenant, LineID: line.ID, JobID: job.ID, Summary: domain.Summary{Topic: "t"}, UptoSeq: anchor.Seq}); err != nil {
		t.Fatal(err)
	}
	if done, _ := f.store.GetJob(f.ctx, job.ID); done.Status != store.JobDone {
		t.Fatalf("job = %+v", done)
	}
	if _, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: tenant, LineID: line.ID, JobID: job.ID, Summary: domain.Summary{Topic: "late"}, UptoSeq: anchor.Seq}); !errors.Is(err, domain.ErrJobNotPending) {
		t.Fatalf("a second result for the job = %v", err)
	}
	if got := f.line(line.ID); got.Summary.Topic != "t" {
		t.Fatalf("summary = %+v", got.Summary)
	}
	other, _ := f.mainLine()
	foreign, _ := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: store.JobKindSummary, LineID: other.ID})
	if _, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: tenant, LineID: line.ID, JobID: foreign.ID, Summary: domain.Summary{Topic: "x"}}); !errors.Is(err, domain.ErrJobNotPending) {
		t.Fatalf("a job of another line = %v", err)
	}
}
