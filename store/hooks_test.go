package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

var errHostRefused = errors.New("host refused")

// requireHookRollback checks a write failed with the hook's error, wrapped.
func requireHookRollback(t *testing.T, name string, err error) {
	t.Helper()
	if !errors.Is(err, errHostRefused) || !strings.HasPrefix(err.Error(), "tx hook: ") {
		t.Fatalf("%s with a failing hook = %v", name, err)
	}
}

func TestHooks_AFailingHookRollsEveryWriteBack(t *testing.T) {
	f := newFixture(t)
	fail := failingHook(errHostRefused)

	t.Run("CompleteTurn", func(t *testing.T) {
		line, _ := f.mainLine()
		turn := f.busy(line.ID)
		_, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: turn.Pending.ID, Outcome: domain.ResolveTurnOutcome("ok", "")}, fail)
		requireHookRollback(t, "CompleteTurn", err)
		if got := f.line(line.ID); got.Status != domain.LineStatusThinking {
			t.Fatalf("line = %+v", got)
		}
		f.answer(turn.Pending.ID, "ok")
	})
	t.Run("CancelTurn", func(t *testing.T) {
		line, _ := f.mainLine()
		f.busy(line.ID)
		_, err := f.store.CancelTurn(f.ctx, tenant, line.ID, "part", fail)
		requireHookRollback(t, "CancelTurn", err)
		if f.count(`SELECT count(*) FROM tangent_message WHERE line_id = $1 AND status = 'pending'`, line.ID) != 1 {
			t.Fatal("the cancel survived a failed hook")
		}
	})
	t.Run("MoveToBranch", func(t *testing.T) {
		line, _ := f.mainLine()
		f.exchange(line.ID, "q2", "a2")
		_, err := f.store.MoveToBranch(f.ctx, f.moveInput(line.ID, 2), fail)
		requireHookRollback(t, "MoveToBranch", err)
		if len(f.texts(line.ID)) != 4 || f.count(`SELECT count(*) FROM tangent_branch WHERE root_line_id = $1`, line.ID) != 0 {
			t.Fatal("the move survived a failed hook")
		}
	})
	t.Run("PromoteBranch", func(t *testing.T) {
		root, branch := f.openBranch()
		_, err := f.store.PromoteBranch(f.ctx, tenant, branch.ID, fail)
		requireHookRollback(t, "PromoteBranch", err)
		if f.branchView(branch.ID).Status != domain.BranchStatusOpen || len(f.texts(root.ID)) != 2 {
			t.Fatal("the promotion survived a failed hook")
		}
	})
	t.Run("FinishBranchDraft", func(t *testing.T) {
		_, branch := f.openBranch()
		claim, err := f.store.ClaimBranchDraft(f.ctx, tenant, branch.ID)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.store.FinishBranchDraft(f.ctx, claim.Job.ID, domain.DraftFailed(domain.DraftUnusableText), fail)
		requireHookRollback(t, "FinishBranchDraft", err)
		if job, _ := f.store.GetJob(f.ctx, claim.Job.ID); job.Status != store.JobPending {
			t.Fatalf("job = %+v", job)
		}
		if view := f.branchView(branch.ID); view.DraftStatus != domain.BranchDraftDrafting {
			t.Fatalf("draft = %+v", view)
		}
	})
	t.Run("SaveSummary", func(t *testing.T) {
		line, anchor := f.mainLine()
		_, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: tenant, LineID: line.ID, Summary: domain.Summary{Topic: "t"}, UptoSeq: anchor.Seq}, fail)
		requireHookRollback(t, "SaveSummary", err)
		if got := f.line(line.ID); got.SummaryUptoSeq != 0 || got.Summary.Topic != "" {
			t.Fatalf("summary = %+v", got.Summary)
		}
		if f.count(`SELECT count(*) FROM tangent_chapter_cut WHERE line_id = $1`, line.ID) != 0 {
			t.Fatal("the topic cut survived a failed hook")
		}
	})
	t.Run("ArchiveTree", func(t *testing.T) {
		line, _ := f.mainLine()
		_, err := f.store.ArchiveTree(f.ctx, tenant, line.ID, true, fail)
		requireHookRollback(t, "ArchiveTree", err)
		if f.line(line.ID).ArchivedAt != nil {
			t.Fatal("the archive survived a failed hook")
		}
	})
	t.Run("FinishJob", func(t *testing.T) {
		job, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: "leaf"})
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.store.FinishJob(f.ctx, job.ID, store.JobDone, "", fail)
		requireHookRollback(t, "FinishJob", err)
		if got, _ := f.store.GetJob(f.ctx, job.ID); got.Status != store.JobPending {
			t.Fatalf("job = %+v", got)
		}
	})
}

func TestHooks_SeeTheResultTheWriteWillReturn(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	var seenID string
	var seenStatus string
	hook := func(ctx context.Context, tx store.Tx, result any) error {
		turn, ok := result.(store.BegunTurn)
		if !ok {
			return errors.New("unexpected result type")
		}
		seenID = turn.Pending.ID
		return tx.QueryRow(ctx, `SELECT status FROM tangent_message WHERE id = $1`, turn.Pending.ID).Scan(&seenStatus)
	}
	turn, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "hi"}, hook)
	if err != nil {
		t.Fatal(err)
	}
	if seenID != turn.Pending.ID || seenStatus != domain.MessagePending {
		t.Fatalf("the hook saw %q (%s), the write returned %q", seenID, seenStatus, turn.Pending.ID)
	}
}

// A write that loses a race (deadlock, serialization failure) is run again
// from the start with a fresh result; past the attempts it reports
// concurrent_change, and a cancelled context stops it.
func TestHooks_RetryableFailuresRunTheWholeWriteAgain(t *testing.T) {
	f := newFixture(t)
	calls := 0
	var ids []string
	flaky := func(_ context.Context, _ store.Tx, result any) error {
		calls++
		ids = append(ids, result.(domain.LineView).ID)
		if calls < 3 {
			return &pgconn.PgError{Code: "40001", Message: "could not serialize access"}
		}
		return nil
	}
	line, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant}, flaky)
	if err != nil {
		t.Fatalf("a write that succeeds on the third attempt = %v", err)
	}
	if calls != 3 || line.ID != ids[2] {
		t.Fatalf("calls %d ids %v returned %s", calls, ids, line.ID)
	}
	if got := f.count(`SELECT count(*) FROM tangent_line WHERE id = ANY($1::uuid[])`, ids); got != 1 {
		t.Fatalf("lines left by the attempts = %d, want only the committed one", got)
	}
	// A retried merge writes one card, from the attempt that committed.
	root, branch := f.openBranch()
	var cardIDs []string
	merges := 0
	flakyMerge := func(_ context.Context, _ store.Tx, result any) error {
		merges++
		cardIDs = append(cardIDs, result.(store.MergedBranch).Card.ID)
		if merges < 2 {
			return &pgconn.PgError{Code: "40P01"}
		}
		return nil
	}
	merged, err := f.store.MergeBranch(f.ctx, f.mergeInput(branch.ID, f.parentTip(root.ID)), flakyMerge)
	if err != nil || merges != 2 || cardIDs[0] == cardIDs[1] || merged.Card.ID != cardIDs[1] || f.cardsIn(root.ID) != 1 {
		t.Fatalf("retried merge = %+v err=%v cards %v", merged.Card.ID, err, cardIDs)
	}

	always := func(context.Context, store.Tx, any) error {
		return &pgconn.PgError{Code: "40P01", Message: "deadlock detected"}
	}
	if _, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant}, always); !errors.Is(err, domain.ErrConcurrentChange) || domain.CodeOf(err) != domain.CodeConcurrentChange {
		t.Fatalf("a write that always deadlocks = %v", err)
	}

	ctx, cancel := context.WithCancel(f.ctx)
	cancelling := func(context.Context, store.Tx, any) error {
		cancel()
		return &pgconn.PgError{Code: "40001"}
	}
	before := f.count(`SELECT count(*) FROM tangent_line`)
	if _, err := f.store.CreateLine(ctx, store.CreateLineInput{Tenant: tenant}, cancelling); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled retry = %v", err)
	}
	if f.count(`SELECT count(*) FROM tangent_line`) != before {
		t.Fatal("a cancelled write left a line")
	}
}

// A context cancelled inside the transaction leaves no partial rows.
func TestHooks_ACancelledContextLeavesNoPartialRows(t *testing.T) {
	f := newFixture(t)
	root, branch := f.openBranch()
	ctx, cancel := context.WithCancel(f.ctx)
	cancelling := func(context.Context, store.Tx, any) error {
		cancel()
		return nil
	}
	if _, err := f.store.MergeBranch(ctx, f.mergeInput(branch.ID, f.parentTip(root.ID)), cancelling); err == nil {
		t.Fatal("a merge whose context was cancelled before the commit must fail")
	}
	if f.cardsIn(root.ID) != 0 || f.branchView(branch.ID).Status != domain.BranchStatusOpen {
		t.Fatal("a cancelled merge left rows behind")
	}
}
