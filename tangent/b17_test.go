package tangent_test

import (
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// B17: dismissing a tree's whole inbox, editing a merged branch's card and
// opening a branch on a card.

func TestDismissAll_DismissesEveryOpenSuggestionOfTheTreeAtOnce(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main, branch := e.branchWithTurn("look")
	first := e.probed(main.ID, tangent.ProbeDirective)
	second := e.probed(branch.Line.ID, tangent.ProbeDirective)
	// A suggestion of a feature that is not on stays as it is.
	if _, err := e.rawStore().ProposeSuggestion(e.ctx, store.ProposeInput{
		Tenant: scopeA.Tenant, LineID: main.ID, Feature: "elsewhere", Kind: "other", TargetKey: "t",
	}); err != nil {
		t.Fatal(err)
	}
	e.rollsBack("DismissAllSuggestions", func(opt tangent.TxOption) error {
		_, err := e.engine.DismissAllSuggestions(e.ctx, scopeA, main.ID, opt)
		return err
	})

	e.events.Reset()
	out, err := e.engine.DismissAllSuggestions(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if out.RootLineID != main.ID || len(out.Suggestions) != 2 || out.Suggestions[0].ID != second.ID || out.Suggestions[1].ID != first.ID {
		t.Fatalf("dismissed (newest first) = %+v", out)
	}
	for _, s := range out.Suggestions {
		if s.Status != domain.SuggestionDismissed || s.DecidedAt == nil {
			t.Fatalf("dismissed = %+v", s)
		}
	}
	e.wantTypes(tangent.EventSuggestionChanged, tangent.EventSuggestionChanged, tangent.EventLineUpdated)
	if line := e.events.OfType(tangent.EventLineUpdated)[0].Data.(domain.LineView); line.ID != main.ID || line.OpenSuggestions != 0 {
		t.Fatalf("line.updated = %+v", line)
	}
	if n := e.count(`SELECT count(*) FROM tangent_suggestion WHERE status = 'open' AND feature = 'elsewhere'`); n != 1 {
		t.Fatalf("the other feature's suggestion is still open: %d", n)
	}

	// A dismissal holds the same suggestion back, as one by one does.
	e.events.Reset()
	e.turn(main.ID, "q", "again "+tangent.ProbeDirective)
	if len(e.events.OfType(tangent.EventSuggestionChanged)) != 0 {
		t.Fatalf("the cooldown applies: %v", e.events.Types())
	}
	e.events.Reset()
	none, err := e.engine.DismissAllSuggestions(e.ctx, scopeA, main.ID)
	if err != nil || none.RootLineID != main.ID || none.Suggestions == nil || len(none.Suggestions) != 0 {
		t.Fatalf("nothing open = %+v %v", none, err)
	}
	e.wantTypes()
}

func TestDismissAll_Refusals(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main := e.mainLine()
	_, err := e.engine.DismissAllSuggestions(e.ctx, scopeB, main.ID)
	wantCode(t, err, domain.CodeLineNotFound)
	_, err = e.engine.DismissAllSuggestions(e.ctx, scopeA, "nope")
	wantCode(t, err, domain.CodeLineNotFound)
	off := newEnv(t)
	line := off.mainLine()
	_, err = off.engine.DismissAllSuggestions(off.ctx, scopeA, line.ID)
	wantCode(t, err, domain.CodeFeatureDisabled)
}

// mergedCard opens a branch on a fresh main line, merges it with a card and
// runs one more parent turn, so the card is delivered.
func (e *env) mergedCard() (domain.LineView, tangent.CreatedBranch, tangent.MergedBranch) {
	e.t.Helper()
	main, branch := e.branchWithTurn("hotels")
	merged := e.mergeWithCard(branch.Line.ID, domain.BranchCard{Question: "Which hotel?", Conclusion: "The business hotel", OpenItems: []string{"Check the price"}})
	e.turn(main.ID, "noted", "ok")
	return main, branch, merged
}

func TestCardEdit_RewritesTheCardAndItsConclusion(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main, branch, merged := e.mergedCard()
	before, err := e.engine.GetLine(e.ctx, scopeA, main.ID)
	if err != nil {
		t.Fatal(err)
	}
	if card := e.messageOf(main.ID, merged.Card.ID); !card.Meta.Delivered {
		t.Fatalf("the card was delivered: %+v", card.Meta)
	}
	edited := domain.BranchCard{Question: "Which hotel?", Conclusion: "The ryokan, two nights", Impact: "Book early", OpenItems: []string{"Pay the deposit"}}
	e.rollsBack("UpdateBranchCard", func(opt tangent.TxOption) error {
		_, err := e.engine.UpdateBranchCard(e.ctx, scopeA, branch.Line.ID, edited, opt)
		return err
	})

	e.events.Reset()
	out, err := e.engine.UpdateBranchCard(e.ctx, scopeA, branch.Line.ID, edited)
	if err != nil {
		t.Fatal(err)
	}
	message := out.Message
	if message.ID != merged.Card.ID || message.Kind != domain.MessageKindBranchCard || message.Meta.Delivered ||
		message.Meta.BranchLineID != branch.Line.ID || message.Meta.Card == nil || message.Meta.Card.Conclusion != "The ryokan, two nights" ||
		message.Content != domain.RenderBranchCardMarkdown(edited, "hotels") || message.Seq != merged.Card.Seq {
		t.Fatalf("card message = %+v", message)
	}
	if out.ParentLineID != main.ID || out.RootLineID != main.ID || out.Branch.ConclusionLine != "The ryokan, two nights" ||
		out.Branch.Status != domain.BranchStatusMerged || out.Branch.CardMessageID != merged.Card.ID {
		t.Fatalf("updated = %+v", out)
	}
	if out.Leaf == nil || out.Leaf.Kind != domain.LeafKindConclusion || out.Leaf.Line != "The ryokan, two nights" || out.Leaf.Body != "Which hotel?\n- Pay the deposit" ||
		out.Branch.Leaf == nil || out.Branch.Leaf.Line != "The ryokan, two nights" {
		t.Fatalf("the merge's leaf follows the card: %+v / %+v", out.Leaf, out.Branch.Leaf)
	}
	e.wantTypes(tangent.EventMessageUpdated, tangent.EventBranchChanged, tangent.EventLeafChanged)
	if change := e.events.OfType(tangent.EventBranchChanged)[0].Data.(tangent.BranchChange); change.Change != tangent.BranchMerged {
		t.Fatalf("branch.changed = %+v", change)
	}
	if stored := e.messageOf(main.ID, merged.Card.ID); stored.Meta.Delivered || stored.Meta.Card.Impact != "Book early" {
		t.Fatalf("stored card = %+v", stored.Meta)
	}
	if raw := e.count(`SELECT count(*) FROM tangent_message WHERE id = $1 AND meta ? 'branchLineId' AND NOT meta ? 'delivered'`, merged.Card.ID); raw != 1 {
		t.Fatal("meta keeps its other keys and loses delivered")
	}
	after, err := e.engine.GetLine(e.ctx, scopeA, main.ID)
	if err != nil || after.Unread != before.Unread {
		t.Fatalf("an edit is not a new message: unread %d → %d (%v)", before.Unread, after.Unread, err)
	}
}

func TestCardEdit_TheNextTurnCarriesTheEditedCardOnce(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main, branch, _ := e.mergedCard()
	if _, err := e.engine.UpdateBranchCard(e.ctx, scopeA, branch.Line.ID, domain.BranchCard{Question: "Which hotel?", Conclusion: "Walrus inn after all"}); err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	e.turn(main.ID, "so?", "noted the change")
	request := e.runner.Requests()[len(e.runner.Requests())-1]
	if !strings.Contains(request.System, "Operator-confirmed branch conclusions") || !strings.Contains(request.System, "Walrus inn after all") {
		t.Fatalf("the notice carries the edited card: %q", request.System)
	}
	if prompt := promptText(request); strings.Contains(prompt, "The business hotel") || strings.Count(prompt, "Walrus inn after all") != 1 {
		t.Fatalf("only the edited card, once: %q", prompt)
	}
	delivered := false
	for _, ev := range e.events.OfType(tangent.EventMessageUpdated) {
		if m := ev.Data.(domain.Message); m.IsCard() && m.Meta.Delivered {
			delivered = true
		}
	}
	if !delivered {
		t.Fatalf("the turn marks the card delivered again: %v", e.events.Types())
	}

	e.turn(main.ID, "and now?", "fine")
	request = e.runner.Requests()[len(e.runner.Requests())-1]
	prompt := promptText(request)
	if strings.Contains(request.System, "Operator-confirmed branch conclusions") || !strings.Contains(prompt, "Walrus inn after all") || strings.Contains(prompt, "The business hotel") {
		t.Fatalf("afterwards the history shows the edited card: %q", prompt)
	}
}

// promptText is a request's system text and messages in one string.
func promptText(r tangent.RunRequest) string {
	var b strings.Builder
	b.WriteString(r.System)
	for _, m := range r.Messages {
		b.WriteString("\n" + m.Content)
	}
	return b.String()
}

// messageOf reads one message of a line.
func (e *env) messageOf(lineID, id string) domain.Message {
	e.t.Helper()
	messages, err := e.engine.ListMessages(e.ctx, scopeA, lineID, 0, 200)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, message := range messages {
		if message.ID == id {
			return message
		}
	}
	e.t.Fatalf("no message %s on %s", id, lineID)
	return domain.Message{}
}

func TestCardEdit_ALeafTheOperatorRewroteIsKept(t *testing.T) {
	e := newEnvWith(t, p1Features())
	_, branch, _ := e.mergedCard()
	if _, err := e.engine.PutLeaf(e.ctx, scopeA, branch.Line.ID, domain.LeafInput{Kind: domain.LeafKindDecision, Line: "Mine"}); err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	out, err := e.engine.UpdateBranchCard(e.ctx, scopeA, branch.Line.ID, domain.BranchCard{Question: "q", Conclusion: "Something else"})
	if err != nil || out.Leaf != nil || out.Branch.Leaf == nil || out.Branch.Leaf.Line != "Mine" || out.Branch.ConclusionLine != "Something else" {
		t.Fatalf("updated = %+v %v", out, err)
	}
	e.wantTypes(tangent.EventMessageUpdated, tangent.EventBranchChanged)
}

func TestCardEdit_Refusals(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main, merged, _ := e.mergedCard()
	card := domain.BranchCard{Question: "q", Conclusion: "c"}
	open := e.branch(main.ID, e.turn(main.ID, "more", "more").Message.ID, "open one")
	_, err := e.engine.UpdateBranchCard(e.ctx, scopeA, open.Line.ID, card)
	wantCode(t, err, domain.CodeBranchClosed)
	discarded := e.branch(main.ID, e.turn(main.ID, "again", "again").Message.ID, "dropped")
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, discarded.Line.ID); err != nil {
		t.Fatal(err)
	}
	_, err = e.engine.UpdateBranchCard(e.ctx, scopeA, discarded.Line.ID, card)
	wantCode(t, err, domain.CodeBranchClosed)
	_, err = e.engine.UpdateBranchCard(e.ctx, scopeA, main.ID, card)
	wantCode(t, err, domain.CodeBranchNotFound)
	_, err = e.engine.UpdateBranchCard(e.ctx, scopeB, merged.Line.ID, card)
	wantCode(t, err, domain.CodeBranchNotFound)
	_, err = e.engine.UpdateBranchCard(e.ctx, scopeA, merged.Line.ID, domain.BranchCard{Question: "q"})
	wantCode(t, err, domain.CodeInvalidCard)
	_, err = e.engine.UpdateBranchCard(e.ctx, scopeA, merged.Line.ID, domain.BranchCard{Question: "q", Conclusion: "c", Evidence: []domain.BranchCardEvidence{{MessageID: main.ID, Note: "n"}}})
	wantCode(t, err, domain.CodeInvalidCard)

	// The line holding the card is answering: its turn may carry the old card.
	e.runner.Queue(tangenttest.Reply{Content: "slow"})
	if _, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "busy"}); err != nil {
		t.Fatal(err)
	}
	_, err = e.engine.UpdateBranchCard(e.ctx, scopeA, merged.Line.ID, card)
	wantCode(t, err, domain.CodeParentBusy)
	if _, err := e.engine.CancelTurn(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, main.ID, true); err != nil {
		t.Fatal(err)
	}
	_, err = e.engine.UpdateBranchCard(e.ctx, scopeA, merged.Line.ID, card)
	wantCode(t, err, domain.CodeArchived)
}

func TestCardEdit_ACardInAnEndedBranchIsNotEdited(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main := e.mainLine()
	middle := e.branch(main.ID, e.turn(main.ID, "q", "a").Message.ID, "middle")
	inner := e.branch(middle.Line.ID, e.turn(middle.Line.ID, "q", "a").Message.ID, "inner")
	e.turn(inner.Line.ID, "q", "a")
	e.mergeWithCard(inner.Line.ID, domain.BranchCard{Question: "q", Conclusion: "c"})
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, middle.Line.ID); err != nil {
		t.Fatal(err)
	}
	_, err := e.engine.UpdateBranchCard(e.ctx, scopeA, inner.Line.ID, domain.BranchCard{Question: "q", Conclusion: "d"})
	wantCode(t, err, domain.CodeParentClosed)
}

func TestCardAnchor_ABranchOpensOnACardAndQuotesIt(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main, _, merged := e.mergedCard()
	in := tangent.BranchInput{AnchorMessageID: merged.Card.ID, Purpose: "Ask more about the hotel", Kind: domain.BranchKindInvestigate, Excerpt: "business hotel"}
	preview, err := e.engine.PreviewBranch(e.ctx, scopeA, main.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	recent := preview.Pack.Recent
	if len(recent) < 2 || recent[len(recent)-1].ID != merged.Card.ID || recent[len(recent)-1].Role != domain.RoleSystem || preview.Pack.AnchorMessageID != merged.Card.ID {
		t.Fatalf("the card is the pack's last message: %+v", preview.Pack)
	}
	if !strings.Contains(preview.Text, "· branch conclusion card]") || !strings.Contains(preview.Text, "> > The business hotel") || strings.Contains(preview.Text, "noted") {
		t.Fatalf("pack text = %q", preview.Text)
	}
	created, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	if created.Branch.AnchorMessageID != merged.Card.ID || created.Pack.Rendered != preview.Text {
		t.Fatalf("created = %+v", created.Branch)
	}
	e.turn(created.Line.ID, "Is it near the station?", "yes")
	if system := e.lastSystem(); !strings.Contains(system, "The business hotel") || !strings.Contains(system, "Ask more about the hotel") {
		t.Fatalf("the branch's prompt carries the card: %q", system)
	}

	// Only a card of the parent itself, and not where only chat counts.
	other := e.mainLine()
	_, err = e.engine.CreateBranch(e.ctx, scopeA, other.ID, in)
	wantCode(t, err, domain.CodeAnchorNotFound)
	_, err = e.engine.PreviewBranch(e.ctx, scopeA, other.ID, in)
	wantCode(t, err, domain.CodeAnchorNotFound)
	spinoff := newEnvWith(t, p1Features(func(f []tangent.Feature) []tangent.Feature { return append(f, tangent.Spinoff()) }))
	sm, _, sc := spinoff.mergedCard()
	_, err = spinoff.engine.Spinoff(spinoff.ctx, scopeA, sm.ID, tangent.SpinoffInput{Mode: domain.SpinoffFresh, AtMessageID: sc.Card.ID})
	wantCode(t, err, domain.CodeAnchorNotFound)
}

func TestCardEdit_ACardAPromotionMovedAwayIsNotEdited(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main := e.mainLine()
	first := e.turn(main.ID, "q1", "a1")
	merged := e.branch(main.ID, first.Message.ID, "merged one")
	e.turn(merged.Line.ID, "q", "a")
	card := e.mergeWithCard(merged.Line.ID, domain.BranchCard{Question: "q", Conclusion: "c"})
	promote := e.branch(main.ID, first.Message.ID, "promoted one")
	e.turn(promote.Line.ID, "q", "a")
	promoted, err := e.engine.PromoteBranch(e.ctx, scopeA, promote.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	// The branch still hangs on the main line; its card went with the old
	// tail to the previous main line, which has ended.
	if detail, _ := e.engine.GetBranch(e.ctx, scopeA, merged.Line.ID); detail.Branch.ParentLineID != main.ID {
		t.Fatalf("the merged branch moved: %+v", detail.Branch)
	}
	e.messageOf(promoted.PreviousID, card.Card.ID)
	_, err = e.engine.UpdateBranchCard(e.ctx, scopeA, merged.Line.ID, domain.BranchCard{Question: "q", Conclusion: "d"})
	wantCode(t, err, domain.CodeParentClosed)
}

func TestCardEdit_TheLeafStaysWhileTheLeafFeatureIsOff(t *testing.T) {
	modes := policy{}
	e := newEnvWith(t, p1Features(), tangent.WithFeaturePolicy(modes))
	_, branch, _ := e.mergedCard()
	modes["tenant-a/"+tangent.FeatureLeaf] = tangent.ModeOff
	e.events.Reset()
	out, err := e.engine.UpdateBranchCard(e.ctx, scopeA, branch.Line.ID, domain.BranchCard{Question: "Which hotel?", Conclusion: "Elsewhere"})
	if err != nil || out.Leaf != nil || out.Branch.Leaf == nil || out.Branch.Leaf.Line != "The business hotel" || out.Branch.ConclusionLine != "Elsewhere" {
		t.Fatalf("updated = %+v %v", out, err)
	}
	e.wantTypes(tangent.EventMessageUpdated, tangent.EventBranchChanged)
}

// B17.1: an edit records when it happened, on the card (meta.editedAt) and
// on its branch (cardEditedAt); delivering the card keeps it.
func TestCardEdit_RecordsWhenTheCardWasEdited(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main, branch, merged := e.mergedCard()
	if card := e.messageOf(main.ID, merged.Card.ID); card.Meta.EditedAt != nil || merged.Branch.CardEditedAt != nil || e.cardEditedAt(main.ID, branch.Line.ID) != nil {
		t.Fatalf("a card never edited has no edit time: %+v / %v", card.Meta, merged.Branch.CardEditedAt)
	}
	followUp, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{AnchorMessageID: merged.Card.ID, Purpose: "More on the hotel", Kind: domain.BranchKindInvestigate})
	if err != nil {
		t.Fatal(err)
	}

	out, err := e.engine.UpdateBranchCard(e.ctx, scopeA, branch.Line.ID, domain.BranchCard{Question: "Which hotel?", Conclusion: "The ryokan"})
	if err != nil {
		t.Fatal(err)
	}
	editedAt := out.Message.Meta.EditedAt
	if editedAt == nil || out.Branch.CardEditedAt == nil || !out.Branch.CardEditedAt.Equal(*editedAt) || editedAt.Location() != time.UTC {
		t.Fatalf("the edit time is on the card and its branch: %v / %v", editedAt, out.Branch.CardEditedAt)
	}
	if !out.Branch.CardEditedAt.After(followUp.Branch.CreatedAt) {
		t.Fatalf("an edit after a follow-up opened is later than it: %v ≤ %v", out.Branch.CardEditedAt, followUp.Branch.CreatedAt)
	}
	stored := e.messageOf(main.ID, merged.Card.ID).Meta.EditedAt
	listed := e.cardEditedAt(main.ID, branch.Line.ID)
	detail, err := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored == nil || listed == nil || detail.Branch.CardEditedAt == nil || !stored.Equal(*editedAt) || !listed.Equal(*editedAt) || !detail.Branch.CardEditedAt.Equal(*editedAt) {
		t.Fatalf("every read shows the same edit time: %v / %v / %v (want %v)", stored, listed, detail.Branch.CardEditedAt, editedAt)
	}

	e.turn(main.ID, "so?", "noted the change")
	delivered := e.messageOf(main.ID, merged.Card.ID)
	if !delivered.Meta.Delivered || delivered.Meta.EditedAt == nil || !delivered.Meta.EditedAt.Equal(*editedAt) {
		t.Fatalf("delivering the card keeps its edit time: %+v", delivered.Meta)
	}

	again, err := e.engine.UpdateBranchCard(e.ctx, scopeA, branch.Line.ID, domain.BranchCard{Question: "Which hotel?", Conclusion: "The ryokan, two nights"})
	if err != nil {
		t.Fatal(err)
	}
	if again.Message.Meta.EditedAt == nil || !again.Message.Meta.EditedAt.After(*editedAt) || again.Message.Meta.Delivered {
		t.Fatalf("a second edit moves the time on: %+v", again.Message.Meta)
	}
}

// cardEditedAt is the card edit time the tree's outline shows for a branch.
func (e *env) cardEditedAt(mainID, branchID string) *time.Time {
	e.t.Helper()
	views, err := e.engine.ListBranches(e.ctx, scopeA, mainID, false)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, view := range views {
		if view.LineID == branchID {
			return view.CardEditedAt
		}
	}
	e.t.Fatalf("no branch %s under %s", branchID, mainID)
	return nil
}
