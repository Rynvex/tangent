package store_test

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestTurns_LifecycleAndPendingGuard(t *testing.T) {
	f := newFixture(t)
	line, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant, Provider: "anthropic", Model: "sonnet"})
	if err != nil {
		t.Fatal(err)
	}

	turn, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "what next?"})
	if err != nil {
		t.Fatal(err)
	}
	if turn.Line.Status != domain.LineStatusThinking || turn.User.Role != domain.RoleUser || turn.User.Content != "what next?" ||
		turn.Pending.Status != domain.MessagePending || turn.Pending.Role != domain.RoleAssistant || turn.Pending.Meta.Provider != "anthropic" ||
		turn.Pending.Seq <= turn.User.Seq || turn.RootLineID != line.ID {
		t.Fatalf("begin turn = %+v", turn)
	}
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "again"}); !errors.Is(err, domain.ErrTurnPending) {
		t.Fatalf("second turn = %v, want ErrTurnPending", err)
	}

	usage := &domain.Usage{InputTokens: 100, OutputTokens: 20, CostUSD: 0.05}
	done, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{
		TurnID: turn.Pending.ID, Outcome: domain.ResolveTurnOutcome("Wait for it.", ""), Usage: usage, DurationMs: 1200,
		Suggestions: []domain.BranchSuggestion{{Purpose: "dig", Kind: domain.BranchKindInvestigate}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if done.Line.Status != domain.LineStatusIdle || done.Line.Unread != 1 || done.Message.Status != domain.MessageDone ||
		done.Message.Content != "Wait for it." || done.Message.Meta.Usage == nil || done.Message.Meta.Usage.OutputTokens != 20 ||
		done.Message.Meta.DurationMs != 1200 || len(done.Message.Meta.Suggestions) != 1 || done.Message.Meta.Provider != "anthropic" {
		t.Fatalf("completed = %+v", done)
	}
	if got := f.count(`SELECT (input_tokens + output_tokens)::int FROM tangent_line WHERE id = $1`, line.ID); got != 120 {
		t.Fatalf("line tokens = %d", got)
	}
	if _, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: turn.Pending.ID, Outcome: domain.ResolveTurnOutcome("again", "")}); !errors.Is(err, domain.ErrTurnNotPending) {
		t.Fatalf("completing twice = %v, want ErrTurnNotPending", err)
	}

	second, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "go on"})
	if err != nil {
		t.Fatal(err)
	}
	failed, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: second.Pending.ID, Outcome: domain.ResolveTurnOutcome("", "runner exploded")})
	if err != nil || failed.Line.Status != domain.LineStatusError || failed.Line.StatusDetail != "runner exploded" || failed.Message.Status != domain.MessageError {
		t.Fatalf("failed turn = %+v err=%v", failed, err)
	}

	all, err := f.store.ListMessages(f.ctx, tenant, line.ID, 0, 0)
	if err != nil || len(all) != 4 {
		t.Fatalf("messages = %d err=%v", len(all), err)
	}
	after, err := f.store.ListMessages(f.ctx, tenant, line.ID, all[1].Seq, 10)
	if err != nil || len(after) != 2 || after[0].ID != all[2].ID {
		t.Fatalf("after the cursor = %+v err=%v", after, err)
	}
	recent, _ := f.store.RecentMessages(f.ctx, tenant, line.ID, 2)
	if len(recent) != 2 || recent[0].ID != all[2].ID || recent[1].ID != all[3].ID {
		t.Fatalf("recent = %+v", recent)
	}
}

func TestTurns_ConcurrentBeginsLeaveOnePendingTurn(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	var wg sync.WaitGroup
	errs := make([]error, 6)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "hi"})
		}()
	}
	wg.Wait()
	started := 0
	for _, err := range errs {
		switch {
		case err == nil:
			started++
		case !errors.Is(err, domain.ErrTurnPending):
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if started != 1 || f.count(`SELECT count(*) FROM tangent_message WHERE line_id = $1 AND status = 'pending'`, line.ID) != 1 {
		t.Fatalf("started %d turns", started)
	}
}

func TestTurns_FailStaleTurns(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	f := newFixture(t, store.WithClock(clock.Now))
	line, _ := f.mainLine()
	f.busy(line.ID)
	if stale, err := f.store.FailStaleTurns(f.ctx, time.Hour); err != nil || len(stale) != 0 {
		t.Fatalf("a fresh turn must not be reaped: %+v err=%v", stale, err)
	}
	if _, err := f.store.FailStaleTurns(f.ctx, 0); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("a zero max age = %v", err)
	}
	clock.now = clock.now.Add(2 * time.Hour)
	stale, err := f.store.FailStaleTurns(f.ctx, time.Hour)
	if err != nil || len(stale) != 1 {
		t.Fatalf("stale = %+v err=%v", stale, err)
	}
	if stale[0].Tenant != tenant || stale[0].Line.Status != domain.LineStatusError || stale[0].Line.StatusDetail != store.StaleTurnDetail ||
		stale[0].Message.Status != domain.MessageError {
		t.Fatalf("reaped turn = %+v", stale[0])
	}
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "retry"}); err != nil {
		t.Fatalf("a turn after the reap must be allowed: %v", err)
	}
}

func TestTurns_CancelKeepsThePartialTextAndIsIdempotent(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	turn := f.busy(line.ID)
	cancelled, err := f.store.CancelTurn(f.ctx, tenant, line.ID, "half an ans")
	if err != nil {
		t.Fatal(err)
	}
	if !cancelled.Cancelled || cancelled.Line.Status != domain.LineStatusIdle || cancelled.Message.ID != turn.Pending.ID ||
		cancelled.Message.Status != domain.MessageDone || !cancelled.Message.Meta.Cancelled || cancelled.Message.Content != "half an ans" {
		t.Fatalf("cancel = %+v", cancelled)
	}
	again, err := f.store.CancelTurn(f.ctx, tenant, line.ID, "")
	if err != nil || again.Cancelled {
		t.Fatalf("second cancel = %+v err=%v", again, err)
	}
	if _, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: turn.Pending.ID, Outcome: domain.ResolveTurnOutcome("late", "")}); !errors.Is(err, domain.ErrTurnNotPending) {
		t.Fatalf("a late result after cancel = %v", err)
	}
	if _, err := f.store.CancelTurn(f.ctx, otherTenant, line.ID, ""); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("cancel from another tenant = %v", err)
	}
}

func TestTurns_OnlyASuccessfulTurnMarksItsCardsDelivered(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	card := f.card(line.ID)

	failing := f.busy(line.ID)
	if len(failing.Cards) != 1 || failing.Cards[0].ID != card.ID || len(failing.Pending.Meta.DeliversCards) != 1 {
		t.Fatalf("the turn does not carry the card: %+v", failing)
	}
	if _, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: failing.Pending.ID, Outcome: domain.ResolveTurnOutcome("", "boom")}); err != nil {
		t.Fatal(err)
	}
	if undelivered, _ := f.store.UndeliveredBranchCards(f.ctx, tenant, line.ID, 10); len(undelivered) != 1 {
		t.Fatal("a failed turn must leave the card undelivered")
	}

	cancelled := f.busy(line.ID)
	if _, err := f.store.CancelTurn(f.ctx, tenant, line.ID, ""); err != nil {
		t.Fatal(err)
	}
	_ = cancelled
	if undelivered, _ := f.store.UndeliveredBranchCards(f.ctx, tenant, line.ID, 10); len(undelivered) != 1 {
		t.Fatal("a cancelled turn must leave the card undelivered")
	}

	ok := f.busy(line.ID)
	f.answer(ok.Pending.ID, "fine")
	if undelivered, _ := f.store.UndeliveredBranchCards(f.ctx, tenant, line.ID, 10); len(undelivered) != 0 {
		t.Fatal("a successful turn delivers the card")
	}
	got, err := f.store.GetMessage(f.ctx, tenant, line.ID, card.ID)
	if err != nil || !got.Meta.Delivered || got.Meta.Card == nil {
		t.Fatalf("card after delivery = %+v err=%v", got, err)
	}
}

func TestTurns_AtMostTheNoticeLimitOfCardsPerTurnOldestFirst(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	limit := domain.DefaultLimits().Branch.NoticeMaxPerTurn
	var cards []domain.Message
	for range limit + 2 {
		cards = append(cards, f.card(line.ID))
	}
	first := f.busy(line.ID)
	if len(first.Cards) != limit || first.Cards[0].ID != cards[0].ID {
		t.Fatalf("first turn carries %d cards", len(first.Cards))
	}
	f.answer(first.Pending.ID, "ok")
	second := f.busy(line.ID)
	if len(second.Cards) != 2 || second.Cards[0].ID != cards[limit].ID {
		t.Fatalf("the cards over the cap wait for the next turn: %+v", second.Cards)
	}
}

func TestTurns_ForgedDeliveryIDsNeverMarkAnotherLinesCard(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	other, _ := f.mainLine()
	foreign := f.card(other.ID)
	turn := f.busy(line.ID)
	f.exec(`UPDATE tangent_message SET meta = jsonb_set(meta, '{deliversCards}', jsonb_build_array($2::text)) WHERE id = $1`, turn.Pending.ID, foreign.ID)
	f.answer(turn.Pending.ID, "ok")
	if undelivered, _ := f.store.UndeliveredBranchCards(f.ctx, tenant, other.ID, 10); len(undelivered) != 1 {
		t.Fatal("a card of another line was marked delivered")
	}
}

func TestTurns_NotesRevisionIsRecordedOnlyBySuccessfulTurns(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: line.ID,
		Changes: []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "x"}}}); err != nil {
		t.Fatal(err)
	}
	failing := f.busy(line.ID)
	if failing.NotesRevision != 1 || failing.NotesRevisionSent != 0 || failing.Pending.Meta.NotesRevision != 1 {
		t.Fatalf("turn notes = %+v", failing)
	}
	if _, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: failing.Pending.ID, Outcome: domain.ResolveTurnOutcome("", "boom")}); err != nil {
		t.Fatal(err)
	}
	if notes, _ := f.store.NotesForTurn(f.ctx, tenant, line.ID); notes.Sent != 0 {
		t.Fatalf("a failed turn recorded the revision: %+v", notes)
	}
	ok := f.busy(line.ID)
	f.answer(ok.Pending.ID, "fine")
	if notes, _ := f.store.NotesForTurn(f.ctx, tenant, line.ID); notes.Sent != 1 || notes.Revision != 1 || len(notes.Notes) != 1 {
		t.Fatalf("notes for the next turn = %+v", notes)
	}
}

func TestTurns_AnAsideTakesOneQuestionAndOneAnswer(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	in := f.branchInput(root.ID, anchor.ID)
	in.Kind = domain.BranchKindAside
	created, err := f.store.CreateBranch(f.ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	aside := created.Line
	turn := f.busy(aside.ID)
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: aside.ID, Content: "second"}); !errors.Is(err, domain.ErrTurnPending) {
		t.Fatalf("second message while pending = %v", err)
	}
	done := f.answer(turn.Pending.ID, "A growing wait between retries.")
	if done.EndedAsideLineID != aside.ID {
		t.Fatalf("completed = %+v", done)
	}
	if view := f.branchView(aside.ID); view.Status != domain.BranchStatusDiscarded || view.ClosedAt == nil {
		t.Fatalf("aside after the answer = %+v", view)
	}
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: aside.ID, Content: "and another?"}); !errors.Is(err, domain.ErrAsideAnswered) && !errors.Is(err, domain.ErrBranchClosed) {
		t.Fatalf("a message after the answer = %v", err)
	}
	if got := f.texts(root.ID); len(got) != 2 {
		t.Fatalf("an aside must not touch the main line: %v", got)
	}
}
