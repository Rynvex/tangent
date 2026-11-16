package tangent_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

func TestEngine_NewRefusesWhatCannotWork(t *testing.T) {
	if _, err := tangent.New(nil); err == nil {
		t.Fatal("a nil pool must be refused")
	}
	pool := tangenttest.Open(t)
	bad := domain.DefaultLimits()
	bad.Branch.MaxOpenPerParent = -1
	if _, err := tangent.New(pool, tangent.WithLimits(bad)); err == nil {
		t.Fatal("negative limits must be refused")
	}
	engine, err := tangent.New(pool, tangent.WithFeatures(), tangent.WithFeaturePolicy(nil), tangent.WithLogger(nil),
		tangent.WithClock(nil), tangent.WithPublisher(nil), nil)
	if err != nil {
		t.Fatalf("an engine without features must work: %v", err)
	}
	if engine.Limits().HistoryScan != 200 {
		t.Fatalf("limits = %+v", engine.Limits())
	}
}

func TestEngine_EveryCallNeedsATenant(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	none := tangent.Scope{Actor: "x"}
	calls := map[string]func() error{
		"CreateLine":   func() error { _, err := e.engine.CreateLine(e.ctx, none, tangent.LineInput{}); return err },
		"GetLine":      func() error { _, err := e.engine.GetLine(e.ctx, none, main.ID); return err },
		"ListLines":    func() error { _, err := e.engine.ListLines(e.ctx, none, tangent.LineQuery{}); return err },
		"ListMessages": func() error { _, err := e.engine.ListMessages(e.ctx, none, main.ID, 0, 0); return err },
		"UpdateLine":   func() error { _, err := e.engine.UpdateLine(e.ctx, none, main.ID, tangent.LinePatch{}); return err },
		"MarkRead":     func() error { _, err := e.engine.MarkRead(e.ctx, none, main.ID); return err },
		"ArchiveTree":  func() error { _, err := e.engine.ArchiveTree(e.ctx, none, main.ID, true); return err },
		"DeleteTree":   func() error { _, err := e.engine.DeleteTree(e.ctx, none, main.ID); return err },
		"BeginTurn": func() error {
			_, err := e.engine.BeginTurn(e.ctx, none, main.ID, tangent.TurnInput{Content: "q"})
			return err
		},
		"StreamSince":  func() error { _, err := e.engine.StreamSince(e.ctx, none, main.ID, 0); return err },
		"CancelTurn":   func() error { _, err := e.engine.CancelTurn(e.ctx, none, main.ID); return err },
		"PreviewTurn":  func() error { _, err := e.engine.PreviewTurn(e.ctx, none, main.ID, "q"); return err },
		"CreateBranch": func() error { _, err := e.engine.CreateBranch(e.ctx, none, main.ID, tangent.BranchInput{}); return err },
		"ListBranches": func() error { _, err := e.engine.ListBranches(e.ctx, none, main.ID, true); return err },
		"GetBranch":    func() error { _, err := e.engine.GetBranch(e.ctx, none, main.ID); return err },
		"MergeBranch":  func() error { _, err := e.engine.MergeBranch(e.ctx, none, main.ID, tangent.MergeInput{}); return err },
		"Discard":      func() error { _, err := e.engine.DiscardBranch(e.ctx, none, main.ID); return err },
		"Move":         func() error { _, err := e.engine.MoveToBranch(e.ctx, none, main.ID, tangent.MoveInput{}); return err },
		"Promote":      func() error { _, err := e.engine.PromoteBranch(e.ctx, none, main.ID); return err },
		"StartDraft":   func() error { _, err := e.engine.StartDraft(e.ctx, none, main.ID); return err },
		"StartSummary": func() error { _, err := e.engine.StartSummary(e.ctx, none, main.ID); return err },
	}
	for name, call := range calls {
		if err := call(); domain.CodeOf(err) != domain.CodeInvalidInput || !strings.Contains(err.Error(), "tenant") {
			t.Fatalf("%s: err = %v", name, err)
		}
	}
}

func TestLines_LifecyclePublishesEveryChange(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	if main.Title != "main" || main.CreatedBy != scopeA.Actor {
		t.Fatalf("line = %+v", main)
	}
	e.wantTypes(tangent.EventLineCreated)
	title := "renamed"
	updated, err := e.engine.UpdateLine(e.ctx, scopeA, main.ID, tangent.LinePatch{Title: &title})
	if err != nil || updated.Title != title {
		t.Fatalf("update = %+v, %v", updated, err)
	}
	if _, err := e.engine.MarkRead(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	page, err := e.engine.ListLines(e.ctx, scopeA, tangent.LineQuery{Tenant: "ignored"})
	if err != nil || len(page.Lines) != 1 || page.Lines[0].ID != main.ID {
		t.Fatalf("page = %+v, %v", page, err)
	}
	if other, _ := e.engine.ListLines(e.ctx, scopeB, tangent.LineQuery{}); len(other.Lines) != 0 {
		t.Fatal("another tenant must see no lines")
	}
	anchor := e.turn(main.ID, "q", "a")
	e.branch(main.ID, anchor.Message.ID, "side")
	e.events.Reset()
	archived, err := e.engine.ArchiveTree(e.ctx, scopeA, main.ID, true)
	if err != nil || len(archived) != 2 || archived[0].ArchivedAt == nil {
		t.Fatalf("archive = %+v, %v", archived, err)
	}
	e.wantTypes(tangent.EventLineUpdated, tangent.EventLineUpdated)
	_, err = e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	wantCode(t, err, domain.CodeArchived)
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, main.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.GetLine(e.ctx, scopeB, main.ID); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant read the line: %v", err)
	}
	messages, err := e.engine.ListMessages(e.ctx, scopeA, main.ID, 0, 0)
	if err != nil || len(messages) != 2 {
		t.Fatalf("messages = %+v, %v", messages, err)
	}
}

func TestLines_AFailingHookRollsBackAndPublishesNothing(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "side")
	reply := e.turn(branch.Line.ID, "bq", "ba")
	e.turn(main.ID, "q2", "a2")
	title := "x"
	e.rollsBack("CreateLine", func(o tangent.TxOption) error {
		_, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Title: "t"}, o)
		return err
	})
	e.rollsBack("UpdateLine", func(o tangent.TxOption) error {
		_, err := e.engine.UpdateLine(e.ctx, scopeA, main.ID, tangent.LinePatch{Title: &title}, o)
		return err
	})
	e.rollsBack("MarkRead", func(o tangent.TxOption) error { _, err := e.engine.MarkRead(e.ctx, scopeA, main.ID, o); return err })
	e.rollsBack("ArchiveTree", func(o tangent.TxOption) error {
		_, err := e.engine.ArchiveTree(e.ctx, scopeA, main.ID, true, o)
		return err
	})
	e.rollsBack("DeleteTree", func(o tangent.TxOption) error { _, err := e.engine.DeleteTree(e.ctx, scopeA, main.ID, o); return err })
	e.branchWritesRollBack(main.ID, anchor.Message.ID, branch.Line.ID, reply.Message.ID)
}

// branchWritesRollBack checks the turn, branch and job writes roll back on a
// failing hook.
func (e *env) branchWritesRollBack(mainID, anchorID, branchID, replyID string) {
	e.t.Helper()
	e.rollsBack("BeginTurn", func(o tangent.TxOption) error {
		_, err := e.engine.BeginTurn(e.ctx, scopeA, mainID, tangent.TurnInput{Content: "q"}, o)
		return err
	})
	e.rollsBack("CreateBranch", func(o tangent.TxOption) error {
		_, err := e.engine.CreateBranch(e.ctx, scopeA, mainID, tangent.BranchInput{AnchorMessageID: anchorID, Purpose: "p", Kind: domain.BranchKindInvestigate}, o)
		return err
	})
	detail, _ := e.engine.GetBranch(e.ctx, scopeA, branchID)
	card := domain.BranchCard{Question: "q", Conclusion: "c", Evidence: []domain.BranchCardEvidence{{MessageID: replyID}}}
	e.rollsBack("MergeBranch", func(o tangent.TxOption) error {
		_, err := e.engine.MergeBranch(e.ctx, scopeA, branchID, tangent.MergeInput{Card: card, ParentTipMessageID: detail.ParentTipMessageID}, o)
		return err
	})
	e.rollsBack("DiscardBranch", func(o tangent.TxOption) error {
		_, err := e.engine.DiscardBranch(e.ctx, scopeA, branchID, o)
		return err
	})
	e.rollsBack("PromoteBranch", func(o tangent.TxOption) error {
		_, err := e.engine.PromoteBranch(e.ctx, scopeA, branchID, o)
		return err
	})
	e.rollsBack("MoveToBranch", func(o tangent.TxOption) error {
		_, err := e.engine.MoveToBranch(e.ctx, scopeA, mainID, tangent.MoveInput{Count: 2, Purpose: "m"}, o)
		return err
	})
	e.rollsBack("StartDraft", func(o tangent.TxOption) error {
		_, err := e.engine.StartDraft(e.ctx, scopeA, branchID, o)
		return err
	})
	e.rollsBack("StartSummary", func(o tangent.TxOption) error { _, err := e.engine.StartSummary(e.ctx, scopeA, mainID, o); return err })
	e.turnWritesRollBack(mainID)
}

// turnWritesRollBack checks completing and cancelling a turn roll back on a
// failing hook, and that nothing the failed writes did is left.
func (e *env) turnWritesRollBack(mainID string) {
	e.t.Helper()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, mainID, tangent.TurnInput{Content: "q"})
	if err != nil {
		e.t.Fatal(err)
	}
	e.rollsBack("CompleteTurn", func(o tangent.TxOption) error {
		_, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "a"}, o)
		return err
	})
	e.rollsBack("CancelTurn", func(o tangent.TxOption) error { _, err := e.engine.CancelTurn(e.ctx, scopeA, mainID, o); return err })
	if e.count(`SELECT count(*) FROM tangent_line`) != 2 || e.count(`SELECT count(*) FROM tangent_message WHERE status = 'pending'`) != 1 {
		e.t.Fatal("rolled-back writes left rows behind")
	}
}

func TestUpdateLine_ReplacesTheHostMeta(t *testing.T) {
	e := newEnv(t)
	line, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Title: "main", HostMeta: json.RawMessage(`{"a":1}`)})
	if err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	updated, err := e.engine.UpdateLine(e.ctx, scopeA, line.ID, tangent.LinePatch{HostMeta: json.RawMessage(`{"b":2}`)})
	if err != nil || string(updated.HostMeta) != `{"b": 2}` || updated.Title != "main" {
		t.Fatalf("updated = %s %q %v", updated.HostMeta, updated.Title, err)
	}
	if events := e.events.OfType(tangent.EventLineUpdated); len(events) != 1 {
		t.Fatalf("events = %v", e.events.Types())
	}
	if _, err := e.engine.UpdateLine(e.ctx, scopeA, line.ID, tangent.LinePatch{HostMeta: json.RawMessage(`[1]`)}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("a host meta that is not an object: %v", err)
	}
}
