package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangenttest"
)

func TestReview_InsertMessageRefusesPendingAndEndedOrArchivedLines(t *testing.T) {
	f := newFixture(t)
	root, branch := f.openBranch()
	if _, err := f.store.InsertMessage(f.ctx, tenant, root.ID, store.NewMessage{Role: domain.RoleAssistant, Status: domain.MessagePending}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("a pending message = %v", err)
	}
	if _, err := f.store.DiscardBranch(f.ctx, tenant, branch.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.InsertMessage(f.ctx, tenant, branch.ID, store.NewMessage{Role: domain.RoleSystem, Content: "late"}); !errors.Is(err, domain.ErrBranchClosed) {
		t.Fatalf("a message into a closed branch = %v", err)
	}
	if _, err := f.store.ArchiveTree(f.ctx, tenant, root.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.InsertMessage(f.ctx, tenant, root.ID, store.NewMessage{Role: domain.RoleSystem, Content: "late"}); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("a message into an archived line = %v", err)
	}
}

func TestReview_OnePendingAssistantTurnPerLineIsEnforcedByTheSchema(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	f.busy(line.ID)
	_, err := f.pool.Exec(f.ctx, `INSERT INTO tangent_message (line_id, tenant_id, role, status) VALUES ($1, $2, 'assistant', 'pending')`, line.ID, tenant)
	if err == nil || !strings.Contains(err.Error(), "idx_tangent_message_one_pending") {
		t.Fatalf("a second pending turn = %v", err)
	}
}

func TestReview_ArchivedMainLineRefusesTurnsAndBranches(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	if _, err := f.store.ArchiveTree(f.ctx, tenant, root.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: root.ID, Content: "x"}); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("a turn on an archived main line = %v", err)
	}
	if _, err := f.store.CreateBranch(f.ctx, f.branchInput(root.ID, anchor.ID)); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("a branch of an archived main line = %v", err)
	}
	if _, err := f.store.ArchiveTree(f.ctx, tenant, root.ID, false); err != nil {
		t.Fatal(err)
	}
	f.busy(root.ID)
}

// A write whose result cannot be read must not have committed: the result is
// read inside the transaction.
func TestReview_AWriteThatCannotReadItsResultRollsBack(t *testing.T) {
	f := newFixture(t)
	f.exec(`ALTER TABLE tangent_branch RENAME TO tangent_branch_gone`)
	before := f.count(`SELECT count(*) FROM tangent_line`)
	if _, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant}); err == nil {
		t.Fatal("the result could not be read, so the write must fail")
	}
	if f.count(`SELECT count(*) FROM tangent_line`) != before {
		t.Fatal("the write committed although it reported an error")
	}
}

func TestReview_IndexesServeTheHotReads(t *testing.T) {
	f := newFixture(t)
	for _, name := range []string{
		"idx_tangent_note_superseded_by", "idx_tangent_chapter_cut_line", "idx_tangent_line_active",
		"idx_tangent_line_archived", "idx_tangent_message_cards", "idx_tangent_message_one_pending", "idx_tangent_job_pending",
	} {
		if f.count(`SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`, name) != 1 {
			t.Fatalf("index %s is missing", name)
		}
	}
	plan := func(sql string) string {
		tx, err := f.pool.Begin(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(f.ctx) }()
		if _, err := tx.Exec(f.ctx, `SET LOCAL enable_seqscan = off`); err != nil {
			t.Fatal(err)
		}
		rows, err := tx.Query(f.ctx, "EXPLAIN "+sql)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out strings.Builder
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatal(err)
			}
			out.WriteString(line + "\n")
		}
		return out.String()
	}
	if got := plan(`SELECT * FROM tangent_line l WHERE l.tenant_id = 't' AND l.archived_at IS NULL ORDER BY l.last_activity_at DESC, l.id DESC LIMIT 10`); !strings.Contains(got, "idx_tangent_line_active") {
		t.Fatalf("active list plan:\n%s", got)
	}
	if got := plan(`SELECT * FROM tangent_line l WHERE l.tenant_id = 't' AND l.archived_at IS NOT NULL ORDER BY l.last_activity_at DESC, l.id DESC LIMIT 10`); !strings.Contains(got, "idx_tangent_line_archived") {
		t.Fatalf("archived list plan:\n%s", got)
	}
}

func TestReview_BranchRowsCheckTheirOwnState(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	branch := f.branch(root.ID, anchor.ID)
	if _, err := f.pool.Exec(f.ctx, `UPDATE tangent_branch SET status = 'merged' WHERE line_id = $1`, branch.ID); err == nil {
		t.Fatal("an ended branch without closed_at was accepted")
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE tangent_branch SET parent_line_id = line_id WHERE line_id = $1`, branch.ID); err == nil {
		t.Fatal("a branch that is its own parent was accepted")
	}
}

// A corrupt parent chain (a cycle) must not hang the recursive reads.
func TestReview_RecursiveReadsStopAtTheDepthGuard(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	a := f.branch(root.ID, anchor.ID)
	b := f.branch(a.ID, f.reply(a.ID).ID)
	f.exec(`UPDATE tangent_branch SET parent_line_id = $2 WHERE line_id = $1`, a.ID, b.ID)
	ctx, cancel := context.WithTimeout(f.ctx, 5*time.Second)
	defer cancel()
	if _, err := f.store.GetLine(ctx, tenant, a.ID); err != nil {
		t.Fatalf("hydrating a line of a cyclic chain = %v", err)
	}
	if _, err := f.store.BranchSubtree(ctx, tenant, a.ID); err != nil {
		t.Fatalf("the subtree of a cyclic chain = %v", err)
	}
}

// A tree larger than any recursion cap is archived and deleted whole.
func TestReview_ATreeOfOverAThousandBranchesIsArchivedAndDeletedWhole(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	f.exec(`WITH lines AS (
		INSERT INTO tangent_line (tenant_id, title) SELECT $2, 'b' || g FROM generate_series(1, 1100) g RETURNING id)
		INSERT INTO tangent_branch (line_id, tenant_id, parent_line_id, root_line_id, anchor_message_id, purpose, kind, depth, origin, status, closed_at)
		SELECT id, $2, $1, $1, $3, 'p', 'investigate', 1, 'button', 'discarded', now() FROM lines`, root.ID, tenant, anchor.ID)
	archived, err := f.store.ArchiveTree(f.ctx, tenant, root.ID, true)
	if err != nil || len(archived) != 1101 {
		t.Fatalf("archived %d err=%v", len(archived), err)
	}
	deleted, err := f.store.DeleteTree(f.ctx, tenant, root.ID)
	if err != nil || len(deleted.LineIDs) != 1101 {
		t.Fatalf("deleted %d err=%v", len(deleted.LineIDs), err)
	}
	if left := f.count(`SELECT count(*) FROM tangent_line WHERE tenant_id = $1`, tenant); left != 0 {
		t.Fatalf("%d orphan line(s) left", left)
	}
}

func TestReview_SummaryCursorNeverMovesBackwards(t *testing.T) {
	f := newFixture(t)
	line, anchor := f.mainLine()
	later := f.reply(line.ID)
	f.setSummary(line.ID, "now", later.Seq)
	for _, upto := range []int64{anchor.Seq, 0} {
		if _, err := f.store.SaveSummary(f.ctx, store.SaveSummaryInput{Tenant: tenant, LineID: line.ID, Summary: domain.Summary{Topic: "late"}, UptoSeq: upto}); domain.CodeOf(err) != domain.CodeInvalidInput {
			t.Fatalf("a cursor of %d after %d = %v", upto, later.Seq, err)
		}
	}
	if got := f.line(line.ID); got.SummaryUptoSeq != later.Seq || got.Summary.Topic != "now" {
		t.Fatalf("summary = %+v at %d", got.Summary, got.SummaryUptoSeq)
	}
}

func TestReview_FinishJobLeavesCardDraftsToFinishBranchDraft(t *testing.T) {
	f := newFixture(t)
	_, branch := f.openBranch()
	claim, err := f.store.ClaimBranchDraft(f.ctx, tenant, branch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.FinishJob(f.ctx, claim.Job.ID, store.JobDone, ""); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("finishing a card draft generically = %v", err)
	}
	if job, _ := f.store.GetJob(f.ctx, claim.Job.ID); job.Status != store.JobPending {
		t.Fatalf("job = %+v", job)
	}
}

func TestReview_FailStaleJobsUsesTheTimeoutOfEachKind(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	f := newFixture(t, store.WithClock(clock.Now))
	line, _ := f.mainLine()
	summary, _ := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: store.JobKindSummary, LineID: line.ID})
	leaf, _ := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: "leaf", LineID: line.ID})
	clock.now = clock.now.Add(4 * time.Minute)
	if failed, err := f.store.FailStaleJobs(f.ctx, nil); err != nil || len(failed) != 0 {
		t.Fatalf("after 4 minutes = %+v err=%v", failed, err)
	}
	clock.now = clock.now.Add(2 * time.Minute)
	failed, err := f.store.FailStaleJobs(f.ctx, nil)
	if err != nil || len(failed) != 1 || failed[0].ID != summary.ID || failed[0].Status != store.JobFailed || failed[0].Error != store.StaleJobError {
		t.Fatalf("after 6 minutes = %+v err=%v", failed, err)
	}
	if job, _ := f.store.GetJob(f.ctx, leaf.ID); job.Status != store.JobPending {
		t.Fatal("a kind without a timeout is left alone")
	}
	if failed, err := f.store.FailStaleJobs(f.ctx, map[string]time.Duration{"leaf": time.Minute}); err != nil || len(failed) != 1 || failed[0].ID != leaf.ID {
		t.Fatalf("a configured kind = %+v err=%v", failed, err)
	}
	if _, err := f.store.FailStaleJobs(f.ctx, map[string]time.Duration{"leaf": 0}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("a zero timeout = %v", err)
	}
}

// A failure in the middle of a sweep stops it and returns what was already
// committed; the turns after it stay pending for the next sweep.
func TestReview_FailStaleTurnsReturnsThePartialResultOnAnError(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	f := newFixture(t, store.WithClock(clock.Now))
	var lines []domain.LineView
	for range 3 {
		line, _ := f.mainLine()
		f.busy(line.ID)
		lines = append(lines, line)
	}
	f.exec(`CREATE FUNCTION refuse_line() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.id = '` + lines[1].ID + `'::uuid THEN RAISE EXCEPTION 'refused by the test'; END IF; RETURN NEW; END $$`)
	f.exec(`CREATE TRIGGER refuse_line BEFORE UPDATE ON tangent_line FOR EACH ROW EXECUTE FUNCTION refuse_line()`)
	clock.now = clock.now.Add(time.Hour)
	stale, err := f.store.FailStaleTurns(f.ctx, time.Minute)
	if err == nil || len(stale) != 1 || stale[0].Line.ID != lines[0].ID {
		t.Fatalf("stale = %+v err=%v", stale, err)
	}
	if got := f.count(`SELECT count(*) FROM tangent_message WHERE status = 'pending'`); got != 2 {
		t.Fatalf("pending turns left = %d, want the failing one and the one after it", got)
	}
}

func TestReview_ACancelledAsideTurnIsNotAnAnswer(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	aside := f.aside(root.ID, anchor.ID)
	f.busy(aside.ID)
	if _, err := f.store.CancelTurn(f.ctx, tenant, aside.ID, "half"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: aside.ID, Content: "again"}); err != nil {
		t.Fatalf("an aside whose only reply was cancelled = %v", err)
	}
}

func TestReview_DraftEdgeCases(t *testing.T) {
	f := newFixture(t)
	_, branch := f.openBranch()
	claim, err := f.store.ClaimBranchDraft(f.ctx, tenant, branch.ID)
	if err != nil {
		t.Fatal(err)
	}
	f.exec(`UPDATE tangent_branch SET draft = '[1]' WHERE line_id = $1`, branch.ID)
	if _, err := f.store.GetBranchDraft(f.ctx, tenant, branch.ID); err == nil {
		t.Fatal("a corrupt stored draft must be an error, not an empty draft")
	}
	// The branch row goes away (the line stays): its draft result is stale.
	f.exec(`DELETE FROM tangent_branch WHERE line_id = $1`, branch.ID)
	if _, err := f.store.FinishBranchDraft(f.ctx, claim.Job.ID, domain.DraftFailed("x")); !errors.Is(err, domain.ErrDraftNotPending) {
		t.Fatalf("a draft result for a branch that is gone = %v", err)
	}
}

func TestReview_CompleteTurnValidatesTheOutcome(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	turn := f.busy(line.ID)
	ok := domain.ResolveTurnOutcome("fine", "")
	cases := map[string]store.CompleteTurnInput{
		"unknown status":     {Outcome: domain.TurnOutcome{Status: "thinking", Content: "x"}},
		"failed but idle":    {Outcome: domain.TurnOutcome{Status: domain.LineStatusIdle, Failed: true}},
		"error but not fail": {Outcome: domain.TurnOutcome{Status: domain.LineStatusError}},
		"negative duration":  {Outcome: ok, DurationMs: -1},
		"negative usage":     {Outcome: ok, Usage: &domain.Usage{OutputTokens: -5}},
	}
	for name, in := range cases {
		in.TurnID = turn.Pending.ID
		if _, err := f.store.CompleteTurn(f.ctx, in); domain.CodeOf(err) != domain.CodeInvalidInput {
			t.Errorf("%s = %v", name, err)
		}
	}
	f.answer(turn.Pending.ID, "fine")
}

func TestReview_MigratorRefusesABadTargetAndAMissingSchema(t *testing.T) {
	pool := tangenttest.Open(t)
	ctx := tangenttest.Context(t)
	if err := store.MigrateDown(ctx, pool, -1); err == nil {
		t.Fatal("a negative target must be refused")
	}
	cfg := pool.Config()
	cfg.ConnConfig.RuntimeParams["search_path"] = "tangent_no_such_schema"
	missing, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer missing.Close()
	if err := store.Migrate(ctx, missing); err == nil || !strings.Contains(err.Error(), "schema") {
		t.Fatalf("a search_path without a schema = %v", err)
	}
}
