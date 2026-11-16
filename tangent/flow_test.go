package tangent_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// draftReply is a drafting model's output citing one branch message.
func draftReply(t *testing.T, evidenceID string) string {
	t.Helper()
	card := domain.BranchCard{
		Question: "Which cache?", Conclusion: "Use the LRU cache.",
		Evidence: []domain.BranchCardEvidence{{MessageID: evidenceID, Note: "benchmark"}},
	}
	raw, err := json.Marshal(card)
	if err != nil {
		t.Fatal(err)
	}
	return domain.BranchCardMarker + "\n" + string(raw)
}

func hasSection(p domain.Prompt, key string) bool {
	for _, section := range append(p.Sections, p.Trailing...) {
		if section.Key == key {
			return true
		}
	}
	return false
}

// TestFlow_MainLineToDeleteTree walks the whole path with every first-batch
// feature on and with all of them off: main line, two turns, a branch, a
// card (drafted, or written by hand without card_draft), merge, the card
// carried by the next turn and marked delivered, promote, move and deleting
// the whole tree.
func TestFlow_MainLineToDeleteTree(t *testing.T) {
	for name, features := range map[string][]tangent.Feature{"all on": tangent.AllFeatures(), "all off": nil} {
		t.Run(name, func(t *testing.T) { runFlow(t, newEnvWith(t, features), features != nil) })
	}
}

func runFlow(t *testing.T, e *env, drafts bool) {
	main := e.mainLine()
	e.runner.Queue(tangenttest.Reply{Chunks: []string{"Hel", "lo"}})
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	first, err := e.engine.RunTurn(e.ctx, turn, e.runner)
	if err != nil || first.Message.Content != "Hello" || first.Line.Status != domain.LineStatusIdle {
		t.Fatalf("first turn = %+v, %v", first, err)
	}
	if tail, _ := e.engine.StreamSince(e.ctx, scopeA, main.ID, 0); len(tail.Deltas) != 2 || tail.Deltas[1].Text != "lo" || tail.Truncated {
		t.Fatalf("streamed deltas = %+v", tail)
	}
	second := e.turn(main.ID, "which cache should we use?", "LRU or LFU, let us check")
	branch := e.branch(main.ID, second.Message.ID, "compare caches")
	inBranch := e.turn(branch.Line.ID, "benchmark them", "LRU wins by 20%")
	card := flowCard(t, e, branch.Line.ID, inBranch.Message.ID, drafts)
	detail, err := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	flowMergeAndDeliver(t, e, main.ID, branch.Line.ID, card, detail.ParentTipMessageID)
	flowPromoteMoveDelete(t, e, main.ID)
}

// flowCard drafts the card with card_draft, or writes it by hand (and checks
// drafting is refused) without it.
func flowCard(t *testing.T, e *env, branchID, evidenceID string, drafts bool) domain.BranchCard {
	t.Helper()
	job, err := e.engine.StartDraft(e.ctx, scopeA, branchID)
	if !drafts {
		wantCode(t, err, domain.CodeFeatureDisabled)
		return domain.BranchCard{Question: "Which cache?", Conclusion: "LRU", Evidence: []domain.BranchCardEvidence{{MessageID: evidenceID}}}
	}
	if err != nil {
		t.Fatal(err)
	}
	// G3: the prompt names messages by short ids ([B2]) instead of UUIDs; the
	// reply below still cites the real id, which keeps working.
	if job.Kind != tangent.JobKindCardDraft || !strings.Contains(job.Prompt.UserMessage, "### [B2] branch message (agent)") || strings.Contains(job.Prompt.UserMessage, evidenceID) {
		t.Fatalf("draft job = %+v", job)
	}
	if err := e.engine.FinishJob(e.ctx, job.ID, draftReply(t, evidenceID), nil); err != nil {
		t.Fatal(err)
	}
	detail, err := e.engine.GetBranch(e.ctx, scopeA, branchID)
	if err != nil || detail.Draft.Status != domain.BranchDraftReady || detail.Draft.Card == nil {
		t.Fatalf("draft = %+v, %v", detail.Draft, err)
	}
	return *detail.Draft.Card
}

// flowMergeAndDeliver merges the card; the next main-line turn carries it
// and marks it delivered, the one after does not announce it again.
func flowMergeAndDeliver(t *testing.T, e *env, mainID, branchID string, card domain.BranchCard, tip string) {
	t.Helper()
	merged, err := e.engine.MergeBranch(e.ctx, scopeA, branchID, tangent.MergeInput{Card: card, ParentTipMessageID: tip})
	if err != nil {
		t.Fatal(err)
	}
	carrying, err := e.engine.BeginTurn(e.ctx, scopeA, mainID, tangent.TurnInput{Content: "so?"})
	if err != nil {
		t.Fatal(err)
	}
	if !hasSection(carrying.Prompt, domain.SectionBranchCards) {
		t.Fatalf("the turn after a merge must carry the card: %+v", carrying.Prompt.Sections)
	}
	e.runner.Queue(tangenttest.Reply{Content: "noted"})
	if _, err := e.engine.RunTurn(e.ctx, carrying, e.runner); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM tangent_message WHERE id = $1 AND (meta->>'delivered')::bool`, merged.Card.ID) != 1 {
		t.Fatal("the card must be marked delivered after the turn that carried it")
	}
	if next := e.turn(mainID, "and now?", "go"); next.Message.Status != domain.MessageDone {
		t.Fatal("follow-up turn failed")
	}
	if last := e.runner.Requests(); strings.Contains(last[len(last)-1].System, "Operator-confirmed branch conclusions") {
		t.Fatal("a delivered card must not be announced again")
	}
}

func flowPromoteMoveDelete(t *testing.T, e *env, mainID string) {
	t.Helper()
	anchor := e.turn(mainID, "another idea?", "maybe a skip list")
	alt := e.branch(mainID, anchor.Message.ID, "try the skip list")
	e.turn(alt.Line.ID, "try it", "skip list is fine")
	promoted, err := e.engine.PromoteBranch(e.ctx, scopeA, alt.Line.ID)
	if err != nil || promoted.MainLineID != mainID {
		t.Fatalf("promote = %+v, %v", promoted, err)
	}
	e.turn(mainID, "move these", "ok")
	moved, err := e.engine.MoveToBranch(e.ctx, scopeA, mainID, tangent.MoveInput{Count: 2, Purpose: "moved tail"})
	if err != nil || len(moved.MovedMessageIDs) != 2 {
		t.Fatalf("move = %+v, %v", moved, err)
	}
	e.events.Reset()
	deleted, err := e.engine.DeleteTree(e.ctx, scopeA, mainID)
	if err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM tangent_line`) != 0 || len(deleted.LineIDs) < 4 {
		t.Fatalf("delete left lines; deleted %v", deleted.LineIDs)
	}
	e.wantTypes(tangent.EventLineDeleted)
	data := e.events.Events()[0].Data.(tangent.LinesDeleted)
	if data.RootLineID != mainID || fmt.Sprint(data.LineIDs) != fmt.Sprint(deleted.LineIDs) {
		t.Fatalf("line.deleted = %+v", data)
	}
}
