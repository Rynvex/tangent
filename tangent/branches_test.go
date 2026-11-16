package tangent_test

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

func TestBranches_CreateBuildsThePackAndPublishesInOrder(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "which queue?", "Kafka or NATS")
	e.turn(main.ID, "later on", "the main line moved on")
	e.events.Reset()

	created, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{
		AnchorMessageID: anchor.Message.ID, Purpose: "  compare queues ", Excerpt: "Kafka", Kind: domain.BranchKindInvestigate,
		IncludeLater: true, Model: "haiku",
	})
	if err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventLineCreated, tangent.EventLineUpdated, tangent.EventBranchChanged)
	parent := e.events.Events()[1].Data.(domain.LineView)
	if parent.ID != main.ID || parent.BranchCounts.Open != 1 {
		t.Fatalf("parent update = %+v", parent)
	}
	if created.Branch.Origin != domain.BranchOriginSelection || created.Branch.Purpose != "compare queues" || created.Line.Model != "haiku" || created.Line.Provider != "anthropic" {
		t.Fatalf("branch = %+v line = %+v", created.Branch, created.Line)
	}
	if !strings.Contains(created.Pack.Rendered, "Kafka or NATS") || !created.Pack.LaterIncluded || created.Pack.AnchorMessageID != anchor.Message.ID {
		t.Fatalf("pack = %+v", created.Pack)
	}
	detail, err := e.engine.GetBranch(e.ctx, scopeA, created.Line.ID)
	if err != nil || detail.Pack.Rendered != created.Pack.Rendered {
		t.Fatalf("stored pack differs: %v", err)
	}
	views, err := e.engine.ListBranches(e.ctx, scopeA, main.ID, false)
	if err != nil || len(views) != 1 || views[0].LineID != created.Line.ID {
		t.Fatalf("outline = %+v, %v", views, err)
	}
}

func TestBranches_CreateRefusals(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	refusals := map[string]tangent.BranchInput{
		domain.CodeAnchorNotFound:  {AnchorMessageID: uuid.NewString(), Purpose: "p", Kind: domain.BranchKindInvestigate},
		domain.CodeInvalidInput:    {AnchorMessageID: anchor.Message.ID, Purpose: " ", Kind: domain.BranchKindInvestigate},
		domain.CodeKindUnsupported: {AnchorMessageID: anchor.Message.ID, Purpose: "p", Kind: "tangent"},
	}
	for code, in := range refusals {
		_, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, in)
		wantCode(t, err, code)
	}
	_, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{
		AnchorMessageID: anchor.Message.ID, Purpose: "p", Kind: domain.BranchKindInvestigate, Excerpt: strings.Repeat("x", 5000),
	})
	wantCode(t, err, domain.CodeInvalidInput)
	_, err = e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{
		AnchorMessageID: e.userMessageOf(main.ID), Purpose: "p", Kind: domain.BranchKindInvestigate,
	})
	if err != nil {
		t.Fatalf("an operator message is a valid anchor: %v", err)
	}
	_, err = e.engine.CreateBranch(e.ctx, scopeB, main.ID, tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Purpose: "p", Kind: domain.BranchKindInvestigate})
	wantCode(t, err, domain.CodeLineNotFound)
}

// userMessageOf is the id of the first operator message of a line.
func (e *env) userMessageOf(lineID string) string {
	e.t.Helper()
	messages, err := e.engine.ListMessages(e.ctx, scopeA, lineID, 0, 10)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, message := range messages {
		if message.Role == domain.RoleUser {
			return message.ID
		}
	}
	e.t.Fatal("no operator message")
	return ""
}

func TestBranches_MergeChecksTheCardAndItsReferences(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "side")
	reply := e.turn(branch.Line.ID, "bq", "the answer is 42")
	after := e.turn(main.ID, "meanwhile", "main moved")
	detail, _ := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)

	e.mergeRefusals(branch.Line.ID, anchor.Message.ID, reply.Message.ID, detail.ParentTipMessageID)

	card := domain.BranchCard{
		Question: "q", Conclusion: "42",
		Evidence:      []domain.BranchCardEvidence{{MessageID: reply.Message.ID}, {MessageID: anchor.Message.ID, Note: "from the pack"}},
		Excerpts:      []domain.BranchCardExcerpt{{MessageID: reply.Message.ID, Text: "42"}},
		NeedsDecision: []domain.BranchCardDecision{{BranchClaim: "42", MainLineClaim: "moved", MainLineMessageID: after.Message.ID}},
	}
	e.events.Reset()
	merged, err := e.engine.MergeBranch(e.ctx, scopeA, branch.Line.ID, tangent.MergeInput{
		Card: card, ParentTipMessageID: detail.ParentTipMessageID, ConfirmParentMoved: true,
		NoteChanges: []domain.NoteChange{{Op: "add", Section: "decided", Text: "the answer is 42"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventMessageCreated, tangent.EventBranchChanged, tangent.EventLineUpdated, tangent.EventLineUpdated, tangent.EventNotesChanged)
	if merged.Branch.Status != domain.BranchStatusMerged || merged.Card.LineID != main.ID || !strings.Contains(merged.Card.Content, "42") {
		t.Fatalf("merged = %+v", merged)
	}
	if notes := e.events.OfType(tangent.EventNotesChanged)[0].Data.(tangent.NotesChange); notes.Revision != 1 || notes.RootLineID != main.ID {
		t.Fatalf("notes.changed = %+v", notes)
	}
	_, err = e.engine.MergeBranch(e.ctx, scopeA, branch.Line.ID, tangent.MergeInput{Card: card, ParentTipMessageID: detail.ParentTipMessageID})
	wantCode(t, err, domain.CodeBranchClosed)
	_, err = e.engine.MergeBranch(e.ctx, scopeA, main.ID, tangent.MergeInput{Card: card, ParentTipMessageID: detail.ParentTipMessageID})
	wantCode(t, err, domain.CodeBranchNotFound)
}

// mergeRefusals checks the refusals of a merge, each with its code.
func (e *env) mergeRefusals(branchID, anchorID, replyID, tip string) {
	e.t.Helper()
	bad := []struct {
		code string
		in   tangent.MergeInput
	}{
		{domain.CodeInvalidParentTip, tangent.MergeInput{Card: domain.BranchCard{Question: "q", Conclusion: "c"}, ParentTipMessageID: "nope"}},
		{domain.CodeInvalidCard, tangent.MergeInput{Card: domain.BranchCard{Question: "q"}, ParentTipMessageID: tip}},
		{domain.CodeInvalidCard, tangent.MergeInput{Card: domain.BranchCard{Question: "q", Conclusion: "c",
			Evidence: []domain.BranchCardEvidence{{MessageID: uuid.NewString()}}}, ParentTipMessageID: tip}},
		{domain.CodeInvalidCard, tangent.MergeInput{Card: domain.BranchCard{Question: "q", Conclusion: "c",
			Excerpts: []domain.BranchCardExcerpt{{MessageID: replyID, Text: "not in there"}}}, ParentTipMessageID: tip}},
		{domain.CodeInvalidParentTip, tangent.MergeInput{Card: domain.BranchCard{Question: "q", Conclusion: "c"}, ParentTipMessageID: uuid.NewString()}},
		{domain.CodeParentMoved, tangent.MergeInput{Card: domain.BranchCard{Question: "q", Conclusion: "c"}, ParentTipMessageID: anchorID}},
	}
	for i, c := range bad {
		_, err := e.engine.MergeBranch(e.ctx, scopeA, branchID, c.in)
		if domain.CodeOf(err) != c.code {
			e.t.Fatalf("case %d: err = %v, want %s", i, err, c.code)
		}
	}
}

func TestBranches_DiscardMoveAndPromotePublishWhatChanged(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	discarded := e.branch(main.ID, anchor.Message.ID, "dead end")
	e.events.Reset()
	view, err := e.engine.DiscardBranch(e.ctx, scopeA, discarded.Line.ID)
	if err != nil || view.Status != domain.BranchStatusDiscarded {
		t.Fatalf("discard = %+v, %v", view, err)
	}
	e.wantTypes(tangent.EventBranchChanged, tangent.EventLineUpdated, tangent.EventLineUpdated)

	// A branch on a message that is about to move goes along with it.
	tail := e.turn(main.ID, "tail question", "tail answer")
	riding := e.branch(main.ID, tail.Message.ID, "rides along")
	e.events.Reset()
	moved, err := e.engine.MoveToBranch(e.ctx, scopeA, main.ID, tangent.MoveInput{Count: 2, Purpose: "move the tail"})
	if err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventLineCreated, tangent.EventMessageCreated, tangent.EventLineUpdated, tangent.EventBranchChanged, tangent.EventBranchChanged)
	if !slices.Equal(moved.Reparented, []string{riding.Line.ID}) || moved.Branch.Kind != domain.BranchKindInvestigate || moved.Marker.Kind != domain.MessageKindBranchMarker {
		t.Fatalf("moved = %+v", moved)
	}
	packed, _ := e.engine.GetBranch(e.ctx, scopeA, moved.Line.ID)
	if packed.Pack.AnchorMessageID != anchor.Message.ID || !strings.Contains(packed.Pack.Rendered, "move the tail") {
		t.Fatalf("move pack = %+v", packed.Pack)
	}

	e.events.Reset()
	promoted, err := e.engine.PromoteBranch(e.ctx, scopeA, moved.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	types := e.events.Types()
	want := []string{tangent.EventLineUpdated, tangent.EventLineUpdated, tangent.EventLineCreated, tangent.EventBranchChanged, tangent.EventBranchChanged, tangent.EventBranchChanged}
	if !slices.Equal(types, want) || promoted.PreviousID == "" {
		t.Fatalf("promote events = %v, promoted %+v", types, promoted)
	}
	changes := []string{}
	for _, ev := range e.events.OfType(tangent.EventBranchChanged) {
		changes = append(changes, ev.Data.(tangent.BranchChange).Change)
	}
	if !slices.Equal(changes, []string{tangent.BranchPromoted, tangent.BranchCreated, tangent.BranchMoved}) {
		t.Fatalf("changes = %v", changes)
	}
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, moved.Line.ID); !errors.Is(err, domain.ErrBranchClosed) {
		t.Fatalf("discarding a promoted branch: %v", err)
	}
}
