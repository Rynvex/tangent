package store_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// exchanges adds n exchanges to the line and returns their messages in
// order (operator, assistant, operator, …).
func (f *fixture) exchanges(lineID string, n int) []domain.Message {
	f.t.Helper()
	out := []domain.Message{}
	for i := range n {
		out = append(out, f.message(lineID, domain.RoleUser, fmt.Sprintf("question %d", i)), f.message(lineID, domain.RoleAssistant, fmt.Sprintf("answer %d", i)))
	}
	return out
}

func (f *fixture) fold(lineID, from, to, summary string) (store.FoldWrite, error) {
	f.t.Helper()
	return f.store.CreateFold(f.ctx, store.CreateFoldInput{
		Tenant: tenant, LineID: lineID, FromMessageID: from, ToMessageID: to, Summary: summary, Actor: "chang", Feature: "fold",
	})
}

func TestFolds_CreateWithASummaryListAndRemove(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	m := f.exchanges(main.ID, 3)
	written, err := f.fold(main.ID, m[3].ID, m[0].ID, " We compared disks. ")
	fold := written.Fold
	if err != nil || written.Job != nil || written.RootLineID != main.ID || fold.Status != domain.FoldActive || fold.Summary != "We compared disks." ||
		fold.FromMessageID != m[0].ID || fold.ToMessageID != m[3].ID || fold.FromSeq != m[0].Seq || fold.ToSeq != m[3].Seq || fold.MessageCount != 4 ||
		fold.TokensOriginal != domain.FoldTokens(m[:4]) || fold.TokensSummary != domain.EstimateTokens("We compared disks.") || fold.AIDrafted || fold.CreatedBy != "chang" {
		t.Fatalf("written = %+v %v", written, err)
	}
	list, err := f.store.ListFolds(f.ctx, tenant, main.ID)
	if err != nil || list.LineID != main.ID || list.RootLineID != main.ID || len(list.Folds) != 1 || list.Folds[0].ID != fold.ID {
		t.Fatalf("list = %+v %v", list, err)
	}
	live, err := f.store.LiveFolds(f.ctx, main.ID)
	if err != nil || len(live) != 1 {
		t.Fatalf("live = %+v %v", live, err)
	}
	removed, err := f.store.RemoveFold(f.ctx, tenant, fold.ID)
	if err != nil || removed.Fold.Status != domain.FoldRemoved || removed.RootLineID != main.ID {
		t.Fatalf("removed = %+v %v", removed, err)
	}
	if _, err := f.store.RemoveFold(f.ctx, tenant, fold.ID); domain.CodeOf(err) != domain.CodeFoldNotFound {
		t.Fatalf("twice: %v", err)
	}
	if again, err := f.fold(main.ID, m[0].ID, m[3].ID, "again"); err != nil || again.Fold.Status != domain.FoldActive {
		t.Fatalf("a removed fold no longer covers the range: %+v %v", again, err)
	}
}

func TestFolds_WithoutASummaryADraftJobStarts(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	m := f.exchanges(main.ID, 2)
	written, err := f.fold(main.ID, m[0].ID, m[3].ID, "")
	if err != nil || written.Fold.Status != domain.FoldDrafting || written.Job == nil || written.Job.Kind != store.JobKindFoldSummary || written.Job.Feature != "fold" ||
		len(written.Messages) != 4 || written.Messages[0].ID != m[0].ID {
		t.Fatalf("written = %+v %v", written, err)
	}
	if live, _ := f.store.LiveFolds(f.ctx, main.ID); len(live) != 1 {
		t.Fatalf("a drafting fold holds its range: %+v", live)
	}
	result, err := f.store.FinishFoldSummary(f.ctx, written.Job.ID, "Two exchanges.", "")
	if err != nil || !result.Written || result.Fold.Status != domain.FoldActive || result.Fold.Summary != "Two exchanges." || !result.Fold.AIDrafted ||
		result.Fold.TokensSummary != domain.EstimateTokens("Two exchanges.") || result.Job.Status != store.JobDone {
		t.Fatalf("result = %+v %v", result, err)
	}
	if _, err := f.store.FinishFoldSummary(f.ctx, written.Job.ID, "late", ""); domain.CodeOf(err) != domain.CodeJobNotPending {
		t.Fatalf("once: %v", err)
	}
}

func TestFolds_AFailedOrRemovedDraftWritesNothing(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	m := f.exchanges(main.ID, 3)
	failed, _ := f.fold(main.ID, m[0].ID, m[1].ID, "")
	result, err := f.store.FinishFoldSummary(f.ctx, failed.Job.ID, "", domain.JobRunFailedText)
	if err != nil || !result.Written || result.Fold.Status != domain.FoldFailed || result.Job.Status != store.JobFailed {
		t.Fatalf("failed = %+v %v", result, err)
	}
	removed, _ := f.fold(main.ID, m[2].ID, m[3].ID, "")
	if _, err := f.store.RemoveFold(f.ctx, tenant, removed.Fold.ID); err != nil {
		t.Fatal(err)
	}
	late, err := f.store.FinishFoldSummary(f.ctx, removed.Job.ID, "late", "")
	if err != nil || late.Written || late.Fold.Status != domain.FoldRemoved || late.Job.Status != store.JobDone {
		t.Fatalf("late = %+v %v", late, err)
	}
	timedOut, _ := f.fold(main.ID, m[4].ID, m[5].ID, "")
	stale, err := f.store.FailFoldOfJob(f.ctx, timedOut.Job.ID)
	if err != nil || stale == nil || stale.Fold.Status != domain.FoldFailed || stale.RootLineID != main.ID {
		t.Fatalf("stale = %+v %v", stale, err)
	}
	if none, err := f.store.FailFoldOfJob(f.ctx, timedOut.Job.ID); err != nil || none != nil {
		t.Fatalf("nothing waits on it any more: %+v %v", none, err)
	}
	list, _ := f.store.ListFolds(f.ctx, tenant, main.ID)
	if len(list.Folds) != 2 {
		t.Fatalf("failed folds are listed, removed ones not: %+v", list.Folds)
	}
	if _, err := f.fold(main.ID, m[0].ID, m[1].ID, "retry"); err != nil {
		t.Fatalf("a failed fold does not hold its range: %v", err)
	}
}

// smallFolds is a fixture whose lines take two folds of at most six
// messages.
func smallFolds(t *testing.T) *fixture {
	t.Helper()
	f := newFixture(t)
	limits := domain.DefaultLimits()
	limits.Fold.MaxActivePerLine, limits.Fold.MaxMessages = 2, 6
	small, err := store.New(f.pool, limits)
	if err != nil {
		t.Fatal(err)
	}
	f.store = small
	return f
}

func TestFolds_Refusals(t *testing.T) {
	f := smallFolds(t)
	main, reply := f.mainLine()
	m := f.exchanges(main.ID, 5)
	other, otherReply := f.mainLine()
	if _, err := f.fold(main.ID, m[0].ID, m[3].ID, "first"); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, line, from, to, summary, code string
	}{
		{"overlap", main.ID, m[3].ID, m[5].ID, "x", domain.CodeFoldOverlap},
		{"one message", main.ID, m[4].ID, m[4].ID, "x", domain.CodeInvalidFold},
		{"too many", main.ID, reply.ID, m[9].ID, "x", domain.CodeInvalidFold},
		{"another line's message", main.ID, m[4].ID, otherReply.ID, "x", domain.CodeMessageNotFound},
		{"another tenant", other.ID, otherReply.ID, otherReply.ID, "x", domain.CodeLineNotFound},
		{"too long", main.ID, m[4].ID, m[5].ID, strings.Repeat("s", 1001), domain.CodeTooLong},
	}
	for _, c := range cases {
		in := store.CreateFoldInput{Tenant: tenant, LineID: c.line, FromMessageID: c.from, ToMessageID: c.to, Summary: c.summary, Feature: "fold"}
		if c.name == "another tenant" {
			in.Tenant = otherTenant
		}
		if _, err := f.store.CreateFold(f.ctx, in); domain.CodeOf(err) != c.code {
			t.Fatalf("%s: %v", c.name, err)
		}
	}
	var overlap *domain.Error
	if _, err := f.fold(main.ID, m[2].ID, m[5].ID, "x"); !errors.As(err, &overlap) || overlap.Extra["foldId"] == nil {
		t.Fatalf("the overlap names the fold: %v", err)
	}
}

func TestFolds_LimitArchiveAndRemoveRefusals(t *testing.T) {
	f := smallFolds(t)
	main, _ := f.mainLine()
	m := f.exchanges(main.ID, 5)
	if _, err := f.fold(main.ID, m[0].ID, m[3].ID, "first"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fold(main.ID, m[4].ID, m[5].ID, "second"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fold(main.ID, m[6].ID, m[7].ID, "third"); domain.CodeOf(err) != domain.CodeFoldLimit {
		t.Fatalf("limit: %v", err)
	}
	f.exec(`UPDATE tangent_line SET archived_at = now() WHERE id = $1`, main.ID)
	if _, err := f.fold(main.ID, m[8].ID, m[9].ID, "x"); domain.CodeOf(err) != domain.CodeArchived {
		t.Fatalf("archived: %v", err)
	}
	refused := errors.New("no")
	f.exec(`UPDATE tangent_line SET archived_at = NULL WHERE id = $1`, main.ID)
	if _, err := f.store.RemoveFold(f.ctx, tenant, "x"); domain.CodeOf(err) != domain.CodeFoldNotFound {
		t.Fatalf("bad id: %v", err)
	}
	list, _ := f.store.ListFolds(f.ctx, tenant, main.ID)
	if _, err := f.store.RemoveFold(f.ctx, otherTenant, list.Folds[0].ID); domain.CodeOf(err) != domain.CodeFoldNotFound {
		t.Fatalf("another tenant: %v", err)
	}
	if _, err := f.store.RemoveFold(f.ctx, tenant, list.Folds[0].ID, func(context.Context, store.Tx, any) error { return refused }); !errors.Is(err, refused) {
		t.Fatalf("a hook rolls back: %v", err)
	}
	if n := f.count(`SELECT count(*) FROM tangent_fold WHERE status = 'active'`); n != 2 {
		t.Fatalf("%d active folds", n)
	}
}

func TestFolds_FollowTheirMessagesOnAMove(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	m := f.exchanges(main.ID, 4)
	kept, _ := f.fold(main.ID, m[0].ID, m[1].ID, "stays")
	split, _ := f.fold(main.ID, m[3].ID, m[4].ID, "split")
	tail, _ := f.fold(main.ID, m[6].ID, m[7].ID, "moves")
	var changed []domain.Fold
	in := f.moveInput(main.ID, 4)
	moved, err := f.store.MoveToBranch(f.ctx, in, func(ctx context.Context, tx store.Tx, result any) error {
		moved := result.(store.MovedBranch)
		var err error
		changed, err = store.ReconcileFolds(ctx, tx, []string{moved.SourceLineID, moved.Line.ID})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]domain.Fold{}
	for _, fold := range changed {
		byID[fold.ID] = fold
	}
	if len(changed) != 2 || byID[split.Fold.ID].Status != domain.FoldRemoved || byID[tail.Fold.ID].LineID != moved.Line.ID {
		t.Fatalf("changed = %+v", changed)
	}
	source, _ := f.store.LiveFolds(f.ctx, main.ID)
	branch, _ := f.store.LiveFolds(f.ctx, moved.Line.ID)
	if len(source) != 1 || source[0].ID != kept.Fold.ID || len(branch) != 1 || branch[0].ID != tail.Fold.ID {
		t.Fatalf("source %+v branch %+v", source, branch)
	}
}

func TestFolds_WhoseEndsLeftTheLineDoNotCount(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	m := f.exchanges(main.ID, 2)
	if _, err := f.fold(main.ID, m[2].ID, m[3].ID, "tail"); err != nil {
		t.Fatal(err)
	}
	f.move(main.ID, 2)
	if live, _ := f.store.LiveFolds(f.ctx, main.ID); len(live) != 0 {
		t.Fatalf("a fold left behind by a move (fold off) does not apply: %+v", live)
	}
	if list, _ := f.store.ListFolds(f.ctx, tenant, main.ID); len(list.Folds) != 0 {
		t.Fatalf("nor is it listed: %+v", list)
	}
}

func TestFolds_FollowTheirMessagesOnAPromotion(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	tailMain := f.exchanges(main.ID, 1)
	branch := f.branch(main.ID, anchor.ID)
	m := f.exchanges(branch.ID, 2)
	onBranch, _ := f.fold(branch.ID, m[0].ID, m[1].ID, "branch part")
	onTail, _ := f.fold(main.ID, tailMain[0].ID, tailMain[1].ID, "old tail")
	var changed []domain.Fold
	promoted, err := f.store.PromoteBranch(f.ctx, tenant, branch.ID, func(ctx context.Context, tx store.Tx, result any) error {
		p := result.(store.PromotedBranch)
		var err error
		changed, err = store.ReconcileFolds(ctx, tx, []string{p.MainLineID, p.PromotedID, p.PreviousID})
		return err
	})
	if err != nil || len(changed) != 2 {
		t.Fatalf("promoted %+v changed %+v %v", promoted, changed, err)
	}
	live, _ := f.store.LiveFolds(f.ctx, main.ID)
	previous, _ := f.store.LiveFolds(f.ctx, promoted.PreviousID)
	if len(live) != 1 || live[0].ID != onBranch.Fold.ID || len(previous) != 1 || previous[0].ID != onTail.Fold.ID {
		t.Fatalf("main %+v previous %+v", live, previous)
	}
}

func TestFolds_MessagesBetweenAndTakenTargets(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	m := f.exchanges(main.ID, 2)
	between, err := f.store.LineMessagesBetween(f.ctx, tenant, main.ID, m[1].ID, m[3].ID, 10)
	if err != nil || len(between) != 3 || between[0].ID != m[1].ID {
		t.Fatalf("between = %+v %v", between, err)
	}
	if _, err := f.store.LineMessagesBetween(f.ctx, tenant, main.ID, m[1].ID, "x", 10); domain.CodeOf(err) != domain.CodeMessageNotFound {
		t.Fatalf("bad end: %v", err)
	}
	if _, err := f.store.ProposeSuggestion(f.ctx, store.ProposeInput{Tenant: tenant, LineID: main.ID, Feature: "fold", Kind: "fold", TargetKey: "fold:a"}); err != nil {
		t.Fatal(err)
	}
	taken, err := f.store.TakenSuggestionTargets(f.ctx, main.ID, "fold", "fold", []string{"fold:a", "fold:b"})
	if err != nil || !taken["fold:a"] || taken["fold:b"] {
		t.Fatalf("taken = %v %v", taken, err)
	}
}

func TestP3Concurrency_OverlappingFoldsOneWins(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	m := f.exchanges(main.ID, 4)
	for round := range 5 {
		errs := race(
			func() error { _, err := f.fold(main.ID, m[0].ID, m[3].ID, "a"); return err },
			func() error { _, err := f.fold(main.ID, m[2].ID, m[5].ID, "b"); return err },
			func() error { _, err := f.fold(main.ID, m[1].ID, m[7].ID, "c"); return err },
		)
		won := 0
		for _, err := range errs {
			switch domain.CodeOf(err) {
			case "":
				if err != nil {
					t.Fatalf("round %d: %v", round, err)
				}
				won++
			case domain.CodeFoldOverlap:
			default:
				t.Fatalf("round %d: %v", round, err)
			}
		}
		if won != 1 {
			t.Fatalf("round %d: %d folds won", round, won)
		}
		f.exec(`UPDATE tangent_fold SET status = 'removed'`)
	}
}

func TestP3Concurrency_ATagFollowsAMessageMovedMeanwhile(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	for round := range 5 {
		question := f.message(main.ID, domain.RoleUser, fmt.Sprintf("move %d", round))
		f.message(main.ID, domain.RoleAssistant, "moved")
		var moved store.MovedBranch
		errs := race(
			func() error {
				_, err := f.store.TagMessage(f.ctx, tenant, question.ID, domain.TagQuestion, "chang")
				return err
			},
			func() (err error) { moved, err = f.store.MoveToBranch(f.ctx, f.moveInput(main.ID, 2)); return err },
		)
		if errs[0] != nil || errs[1] != nil {
			t.Fatalf("round %d: %v", round, errs)
		}
		if tags := f.tagsOf(moved.Line.ID); tags[question.ID] != domain.TagQuestion {
			t.Fatalf("round %d: the tag is on the moved message: %v", round, tags)
		}
	}
}

func TestFolds_UpdateWritesTheOperatorsSummary(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	m := f.exchanges(main.ID, 2)
	drafted, _ := f.fold(main.ID, m[0].ID, m[1].ID, "")
	updated, err := f.store.UpdateFold(f.ctx, tenant, drafted.Fold.ID, " Mine. ")
	if err != nil || updated.Fold.Status != domain.FoldActive || updated.Fold.Summary != "Mine." || updated.Fold.AIDrafted || updated.RootLineID != main.ID {
		t.Fatalf("updated = %+v %v", updated, err)
	}
	late, err := f.store.FinishFoldSummary(f.ctx, drafted.Job.ID, "AI", "")
	if err != nil || late.Written || late.Fold.Summary != "Mine." {
		t.Fatalf("the draft's job no longer writes: %+v %v", late, err)
	}
	refused := errors.New("no")
	if _, err := f.store.UpdateFold(f.ctx, tenant, drafted.Fold.ID, "x", func(context.Context, store.Tx, any) error { return refused }); !errors.Is(err, refused) {
		t.Fatalf("a hook rolls back: %v", err)
	}
	f.exec(`UPDATE tangent_line SET archived_at = now() WHERE id = $1`, main.ID)
	if _, err := f.store.UpdateFold(f.ctx, tenant, drafted.Fold.ID, "x"); domain.CodeOf(err) != domain.CodeArchived {
		t.Fatalf("archived: %v", err)
	}
	if _, err := f.store.UpdateFold(f.ctx, tenant, "x", "x"); domain.CodeOf(err) != domain.CodeFoldNotFound {
		t.Fatalf("bad id: %v", err)
	}
}
