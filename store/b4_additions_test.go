package store_test

import (
	"errors"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestB4_LinesCarryTheirAccumulatedUsage(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	begun, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "a"})
	if err != nil {
		t.Fatal(err)
	}
	usage := domain.Usage{InputTokens: 120, OutputTokens: 30, CostUSD: 0.25, CacheReadTokens: 100, CacheWriteTokens: 10}
	if _, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: begun.Pending.ID, Outcome: domain.ResolveTurnOutcome("done", ""), Usage: &usage}); err != nil {
		t.Fatal(err)
	}
	got, err := f.store.GetLine(f.ctx, tenant, line.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := domain.Usage{InputTokens: 120, OutputTokens: 30, CostUSD: 0.25}
	if got.Usage != want {
		t.Fatalf("line usage = %+v, want %+v", got.Usage, want)
	}
	messages, err := f.store.ListMessages(f.ctx, tenant, line.ID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	reply := messages[len(messages)-1]
	if reply.Meta.Usage == nil || reply.Meta.Usage.CacheReadTokens != 100 || reply.Meta.Usage.CacheWriteTokens != 10 {
		t.Fatalf("the reply keeps the cache buckets: %+v", reply.Meta.Usage)
	}
}

func TestB4_AwaitingReviewCountsOpenBranchesBelowWithAReadyDraft(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	first := f.branch(main.ID, anchor.ID)
	nested := f.branch(first.ID, f.reply(first.ID).ID)
	second := f.branch(main.ID, anchor.ID)
	closed := f.branch(main.ID, anchor.ID)
	f.exec(`UPDATE tangent_branch SET draft_status = 'ready' WHERE line_id = ANY($1::uuid[])`, []string{first.ID, nested.ID, closed.ID})
	f.exec(`UPDATE tangent_branch SET draft_status = 'drafting' WHERE line_id = $1`, second.ID)
	f.exec(`UPDATE tangent_branch SET status = 'discarded', closed_at = now() WHERE line_id = $1`, closed.ID)

	cases := map[string]int{main.ID: 2, first.ID: 1, nested.ID: 0, second.ID: 0}
	for id, want := range cases {
		got, err := f.store.GetLine(f.ctx, tenant, id)
		if err != nil {
			t.Fatal(err)
		}
		if got.AwaitingReview != want {
			t.Errorf("line %s awaitingReview = %d, want %d", id, got.AwaitingReview, want)
		}
	}
	page, err := f.store.ListLines(f.ctx, store.ListLinesInput{Tenant: tenant})
	if err != nil || len(page.Lines) != 1 || page.Lines[0].AwaitingReview != 2 {
		t.Fatalf("the list carries the total too: %+v %v", page.Lines, err)
	}
}

// failedTurn begins a turn on the line and fails it; it returns the turn.
func (f *fixture) failedTurn(lineID, content string) store.BegunTurn {
	f.t.Helper()
	begun, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: lineID, Content: content})
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: begun.Pending.ID, Outcome: domain.ResolveTurnOutcome("", "boom")}); err != nil {
		f.t.Fatal(err)
	}
	return begun
}

func TestB41_RetryTurnReusesTheOperatorMessage(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	failed := f.failedTurn(line.ID, "try me")
	retried, err := f.store.RetryTurn(f.ctx, store.RetryTurnInput{Tenant: tenant, LineID: line.ID, Actor: "chang"})
	if err != nil {
		t.Fatal(err)
	}
	if retried.User.ID != failed.User.ID || retried.Pending.ID == failed.Pending.ID || retried.Pending.Status != domain.MessagePending {
		t.Fatalf("retried = %+v", retried)
	}
	if retried.Line.Status != domain.LineStatusThinking || retried.Pending.Meta.Actor != "chang" {
		t.Fatalf("line %s actor %q", retried.Line.Status, retried.Pending.Meta.Actor)
	}
	if n := f.count(`SELECT count(*) FROM tangent_message WHERE line_id = $1 AND role = 'user' AND content = 'try me'`, line.ID); n != 1 {
		t.Fatalf("the operator's message is not duplicated: %d", n)
	}
	if n := f.count(`SELECT count(*) FROM tangent_message WHERE id = $1 AND status = 'error'`, failed.Pending.ID); n != 1 {
		t.Fatal("the failed reply stays as an error")
	}
	if _, err := f.store.RetryTurn(f.ctx, store.RetryTurnInput{Tenant: tenant, LineID: line.ID}); !errors.Is(err, domain.ErrTurnPending) {
		t.Fatalf("a pending turn refuses a retry: %v", err)
	}
}

func TestB41_RetryTurnRefusesWhenTheLastTurnDidNotFail(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	if _, err := f.store.RetryTurn(f.ctx, store.RetryTurnInput{Tenant: tenant, LineID: line.ID}); !errors.Is(err, domain.ErrNothingToRetry) {
		t.Fatalf("err = %v", err)
	}
	empty, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.RetryTurn(f.ctx, store.RetryTurnInput{Tenant: tenant, LineID: empty.ID}); !errors.Is(err, domain.ErrNothingToRetry) {
		t.Fatalf("an empty line has nothing to retry: %v", err)
	}
	if _, err := f.store.RetryTurn(f.ctx, store.RetryTurnInput{Tenant: otherTenant, LineID: line.ID}); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
}

func TestB41_RetryTurnRacesOnlyOnce(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	f.failedTurn(line.ID, "again")
	errs := make(chan error, 4)
	for range 4 {
		go func() {
			_, err := f.store.RetryTurn(f.ctx, store.RetryTurnInput{Tenant: tenant, LineID: line.ID})
			errs <- err
		}()
	}
	ok := 0
	for range 4 {
		if err := <-errs; err == nil {
			ok++
		} else if !errors.Is(err, domain.ErrTurnPending) {
			t.Fatalf("err = %v", err)
		}
	}
	if ok != 1 {
		t.Fatalf("%d retries started", ok)
	}
}

func TestB41_MergeAndPromoteReturnTheirViewsFromTheTransaction(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	merged, err := f.store.MergeBranch(f.ctx, store.MergeBranchInput{
		Tenant: tenant, LineID: branch.ID, Card: domain.BranchCard{Question: "q", Conclusion: "c"}, Content: "card",
		ParentTipMessageID: f.parentTip(parent.ID),
	})
	if err != nil {
		t.Fatal(err)
	}
	if merged.Parent.ID != parent.ID || merged.Parent.BranchCounts.Merged != 1 {
		t.Fatalf("parent view = %+v", merged.Parent)
	}
	alt := f.branch(parent.ID, f.reply(parent.ID).ID)
	f.reply(alt.ID)
	promoted, err := f.store.PromoteBranch(f.ctx, tenant, alt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if promoted.Main.ID != parent.ID || promoted.Promoted.Status != domain.BranchStatusPromoted || promoted.Previous.LineID != promoted.PreviousID {
		t.Fatalf("promoted = %+v", promoted)
	}
}

func TestB42_SavePartialReplyOnlyTouchesAPendingReplyAndNeverGoesBack(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	begun, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	read := func() domain.Message {
		messages, err := f.store.ListMessages(f.ctx, tenant, line.ID, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		return messages[len(messages)-1]
	}
	if ok, err := f.store.SavePartialReply(f.ctx, begun.Pending.ID, "Hello wor", 20); !ok || err != nil {
		t.Fatalf("saved = %v %v", ok, err)
	}
	if ok, _ := f.store.SavePartialReply(f.ctx, begun.Pending.ID, "Hello", 10); ok {
		t.Fatal("an older partial does not replace a newer one")
	}
	if got := read(); got.Content != "Hello wor" || got.Meta.StreamSeq != 20 || got.Status != domain.MessagePending {
		t.Fatalf("pending = %+v", got)
	}
	if _, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: begun.Pending.ID, Outcome: domain.ResolveTurnOutcome("Hello world", "")}); err != nil {
		t.Fatal(err)
	}
	if ok, _ := f.store.SavePartialReply(f.ctx, begun.Pending.ID, "late", 99); ok {
		t.Fatal("a finished reply is never overwritten")
	}
	if got := read(); got.Content != "Hello world" || got.Meta.StreamSeq != 0 {
		t.Fatalf("done = %+v", got)
	}
	if ok, err := f.store.SavePartialReply(f.ctx, "not-an-id", "x", 1); ok || err != nil {
		t.Fatal("a bad id writes nothing")
	}
}
