package store_test

import (
	"context"
	"errors"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestB3_CancelTurnForOnlyCancelsTheNamedTurn(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	first, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "a"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: first.Pending.ID, Outcome: domain.ResolveTurnOutcome("done", "")}); err != nil {
		t.Fatal(err)
	}
	second, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "b"})
	if err != nil {
		t.Fatal(err)
	}
	stale, err := f.store.CancelTurnFor(f.ctx, tenant, line.ID, first.Pending.ID, "text of the first turn")
	if err != nil || stale.Cancelled {
		t.Fatalf("cancelling a finished turn must change nothing: %+v %v", stale, err)
	}
	if pending, ok, _ := f.store.PendingTurn(f.ctx, tenant, line.ID); !ok || pending.ID != second.Pending.ID {
		t.Fatal("the second turn must still be pending")
	}
	out, err := f.store.CancelTurnFor(f.ctx, tenant, line.ID, second.Pending.ID, "partial b")
	if err != nil || !out.Cancelled || out.Message.Content != "partial b" {
		t.Fatalf("cancel = %+v %v", out, err)
	}
}

func TestB3_SaveSummaryCanSkipTheTopicCut(t *testing.T) {
	f := newFixture(t)
	line, reply := f.mainLine()
	saved, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{
		Tenant: tenant, LineID: line.ID, Summary: domain.Summary{Topic: "new topic"}, UptoSeq: reply.Seq, SkipTopicCut: true,
	})
	if err != nil || saved.TopicCut != nil || f.count(`SELECT count(*) FROM tangent_chapter_cut`) != 0 {
		t.Fatalf("saved = %+v, %v", saved, err)
	}
}

func TestB3_DeleteTreeAndPurgeReportThePendingJobsThatWent(t *testing.T) {
	f := newFixture(t)
	line, anchor := f.mainLine()
	branch := f.branch(line.ID, anchor.ID)
	f.reply(branch.ID)
	claim, err := f.store.ClaimBranchDraft(f.ctx, tenant, branch.ID)
	if err != nil {
		t.Fatal(err)
	}
	deleted, err := f.store.DeleteTree(f.ctx, tenant, line.ID)
	if err != nil || len(deleted.PendingJobIDs) != 1 || deleted.PendingJobIDs[0] != claim.Job.ID {
		t.Fatalf("deleted = %+v, %v", deleted.PendingJobIDs, err)
	}
}

func TestB3_RecordTurnUsageAddsToAFinishedTurnOnce(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	begun, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "a"})
	if err != nil {
		t.Fatal(err)
	}
	usage := domain.Usage{InputTokens: 100, OutputTokens: 7, CostUSD: 0.01}
	if _, err := f.store.RecordTurnUsage(f.ctx, begun.Pending.ID, usage); !errors.Is(err, domain.ErrTurnPending) {
		t.Fatalf("a pending turn records usage with CompleteTurn: %v", err)
	}
	if _, err := f.store.CancelTurn(f.ctx, tenant, line.ID, "part"); err != nil {
		t.Fatal(err)
	}
	recorded, err := f.store.RecordTurnUsage(f.ctx, begun.Pending.ID, usage)
	if err != nil || !recorded.Recorded || recorded.Message.Meta.Usage == nil || recorded.Message.Meta.Usage.InputTokens != 100 {
		t.Fatalf("recorded = %+v, %v", recorded, err)
	}
	again, err := f.store.RecordTurnUsage(f.ctx, begun.Pending.ID, usage)
	if err != nil || again.Recorded {
		t.Fatalf("usage must be recorded once: %+v %v", again, err)
	}
	if f.count(`SELECT input_tokens + output_tokens FROM tangent_line WHERE id = $1`, line.ID) != 107 {
		t.Fatal("the line totals must include the usage once")
	}
	if _, err := f.store.RecordTurnUsage(f.ctx, "nope", usage); !errors.Is(err, domain.ErrTurnNotPending) {
		t.Fatalf("unknown turn err = %v", err)
	}
}

func TestB3_FailJobEndsAnyKindIncludingDrafts(t *testing.T) {
	f := newFixture(t)
	line, anchor := f.mainLine()
	branch := f.branch(line.ID, anchor.ID)
	f.reply(branch.ID)
	claim, err := f.store.ClaimBranchDraft(f.ctx, tenant, branch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.store.FailJob(f.ctx, claim.Job.ID, "no handler"); err != nil {
		t.Fatal(err)
	}
	draft, _ := f.store.GetBranchDraft(f.ctx, tenant, branch.ID)
	if draft.Status != domain.BranchDraftFailed || draft.Error != "no handler" {
		t.Fatalf("draft = %+v", draft)
	}
	job, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: "other", LineID: line.ID})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.store.FailJob(f.ctx, job.ID, "no handler"); err != nil {
		t.Fatal(err)
	}
	if err := f.store.FailJob(f.ctx, job.ID, "again"); !errors.Is(err, domain.ErrJobNotPending) {
		t.Fatalf("second fail err = %v", err)
	}
}

func TestB3_NotesRevisionSentIsLeftToTheCaller(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: line.ID, Changes: []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "x"}}}); err != nil {
		t.Fatal(err)
	}
	begun, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "q", Actor: "chang"})
	if err != nil || begun.Pending.Meta.Actor != "chang" {
		t.Fatalf("begun = %+v, %v", begun.Pending.Meta, err)
	}
	if ref, err := f.store.GetTurn(f.ctx, begun.Pending.ID); err != nil || ref.Actor != "chang" {
		t.Fatalf("ref = %+v, %v", ref, err)
	}
	marked := false
	hook := func(ctx context.Context, tx store.Tx, result any) error {
		marked = true
		return store.MarkNotesRevisionSent(ctx, tx, line.ID, begun.Pending.Meta.NotesRevision)
	}
	if _, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: begun.Pending.ID, Outcome: domain.ResolveTurnOutcome("a", ""), SkipNotesRevision: true}); err != nil {
		t.Fatal(err)
	}
	if f.count(`SELECT notes_revision_sent FROM tangent_line WHERE id = $1`, line.ID) != 0 {
		t.Fatal("SkipNotesRevision must leave the revision unsent")
	}
	second, _ := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "q2"})
	if _, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: second.Pending.ID, Outcome: domain.ResolveTurnOutcome("a", ""), SkipNotesRevision: true}, hook); err != nil || !marked {
		t.Fatal(err)
	}
	if f.count(`SELECT notes_revision_sent FROM tangent_line WHERE id = $1`, line.ID) != 1 {
		t.Fatal("the hook must record the revision")
	}
}

func TestB3_CheapReadsForTheEngine(t *testing.T) {
	f := newFixture(t)
	line, anchor := f.mainLine()
	branch := f.branch(line.ID, anchor.ID)
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: line.ID, Changes: []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "x"}}}); err != nil {
		t.Fatal(err)
	}
	notes, err := f.store.ActiveNotes(f.ctx, line.ID)
	if err != nil || len(notes) != 1 {
		t.Fatalf("notes = %+v, %v", notes, err)
	}
	if _, err := f.store.ActiveNotes(f.ctx, "bad"); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("bad root err = %v", err)
	}
	purposes, err := f.store.BranchPurposes(f.ctx, tenant, []string{branch.ID, "bad", line.ID})
	if err != nil || len(purposes) != 1 || purposes[branch.ID] != "check it" {
		t.Fatalf("purposes = %v, %v", purposes, err)
	}
	if other, _ := f.store.BranchPurposes(f.ctx, otherTenant, []string{branch.ID}); len(other) != 0 {
		t.Fatal("another tenant must see no purposes")
	}
	size, err := f.store.UnsummarizedSize(f.ctx, tenant, line.ID)
	if err != nil || size.Messages != 2 || size.Chars != int64(len("question")+len("answer")) {
		t.Fatalf("size = %+v, %v", size, err)
	}
	f.card(line.ID)
	f.reply(line.ID)
	if after, _ := f.store.UnsummarizedSize(f.ctx, tenant, line.ID); after.Messages != 2 {
		t.Fatalf("messages after an undelivered card must not count: %+v", after)
	}
}
