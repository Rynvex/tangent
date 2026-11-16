package tangent_test

import (
	"context"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// TestPrompt_ConsecutiveBranchTurnsShareTheirStablePrefix: the rules and
// the pack never move, so the system text of a branch's next turn starts
// with the previous one byte for byte, a newly arrived card only appends,
// and once delivered the system text is exactly the first one again.
func TestPrompt_ConsecutiveBranchTurnsShareTheirStablePrefix(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "which database?", "Postgres or SQLite")
	branch := e.branch(main.ID, anchor.Message.ID, "evaluate SQLite")
	e.turn(branch.Line.ID, "is it fast enough?", "yes for one writer")
	firstReq := e.runner.Requests()[len(e.runner.Requests())-1]

	// A sub-branch of the branch comes back with a card in between.
	inner := e.branch(branch.Line.ID, e.lastReply(branch.Line.ID), "check WAL mode")
	reply := e.turn(inner.Line.ID, "WAL?", "WAL allows readers during writes")
	detail, err := e.engine.GetBranch(e.ctx, scopeA, inner.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	card := domain.BranchCard{Question: "WAL?", Conclusion: "Use WAL.", Evidence: []domain.BranchCardEvidence{{MessageID: reply.Message.ID}}}
	if _, err := e.engine.MergeBranch(e.ctx, scopeA, inner.Line.ID, tangent.MergeInput{Card: card, ParentTipMessageID: detail.ParentTipMessageID}); err != nil {
		t.Fatal(err)
	}

	e.turn(branch.Line.ID, "and backups?", "copy the file")
	secondReq := e.runner.Requests()[len(e.runner.Requests())-1]
	if !strings.HasPrefix(secondReq.System, firstReq.System) || len(secondReq.System) == len(firstReq.System) {
		t.Fatalf("the card must only append to the stable prefix:\nfirst:\n%s\nsecond:\n%s", firstReq.System, secondReq.System)
	}
	for i, message := range firstReq.Messages {
		if secondReq.Messages[i] != message {
			t.Fatalf("message %d changed between turns: %+v vs %+v", i, message, secondReq.Messages[i])
		}
	}

	e.turn(branch.Line.ID, "restore?", "copy it back")
	thirdReq := e.runner.Requests()[len(e.runner.Requests())-1]
	if thirdReq.System != firstReq.System {
		t.Fatalf("once delivered the system text must be the stable one again:\n%s", thirdReq.System)
	}
}

// lastReply is the id of the newest assistant message of a line.
func (e *env) lastReply(lineID string) string {
	e.t.Helper()
	messages, err := e.engine.ListMessages(e.ctx, scopeA, lineID, 0, 100)
	if err != nil {
		e.t.Fatal(err)
	}
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == domain.RoleAssistant {
			return messages[i].ID
		}
	}
	e.t.Fatal("no reply")
	return ""
}

func TestPrompt_PreviewWritesNothingAndListsEveryBlock(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	e.turn(main.ID, "first", "reply")
	before := e.count(`SELECT count(*) FROM tangent_message`)
	e.events.Reset()

	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "  next question ")
	if err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM tangent_message`) != before || len(e.events.Events()) != 0 {
		t.Fatal("a preview must not write or publish")
	}
	keys := []string{}
	total := 0
	for _, block := range preview.Blocks {
		keys = append(keys, block.Key)
		total += block.Tokens
		if block.Tokens <= 0 || block.Content == "" {
			t.Fatalf("empty block %+v", block)
		}
	}
	if strings.Join(keys, ",") != "rules,history,history,user_message" || total != preview.TotalTokens {
		t.Fatalf("blocks = %v total %d/%d", keys, total, preview.TotalTokens)
	}
	if preview.Prompt.UserMessage != "next question" || preview.Provider != "anthropic" {
		t.Fatalf("preview = %+v", preview)
	}
	system, _ := preview.Prompt.Chat()
	if !strings.HasPrefix(system, preview.Blocks[0].Content) {
		t.Fatal("a section block must render exactly as Chat does")
	}
	_, err = e.engine.PreviewTurn(e.ctx, scopeB, main.ID, "x")
	wantCode(t, err, domain.CodeLineNotFound)
}

func TestPrompt_PreviewShowsSummaryCardsAndEarlierHistory(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.History.TokenBudget = 30
	e := newEnv(t, tangent.WithLimits(limits))
	main := e.mainLine()
	for range 3 {
		e.turn(main.ID, strings.Repeat("question words ", 5), strings.Repeat("answer words ", 5))
	}
	anchor := e.turn(main.ID, "fork here", "ok")
	branch := e.branch(main.ID, anchor.Message.ID, "side")
	reply := e.turn(branch.Line.ID, "q", "a")
	detail, _ := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	card := domain.BranchCard{Question: "q", Conclusion: "c", Evidence: []domain.BranchCardEvidence{{MessageID: reply.Message.ID}}}
	if _, err := e.engine.MergeBranch(e.ctx, scopeA, branch.Line.ID, tangent.MergeInput{Card: card, ParentTipMessageID: detail.ParentTipMessageID}); err != nil {
		t.Fatal(err)
	}
	job, err := e.engine.StartSummary(e.ctx, scopeA, main.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.engine.FinishJob(e.ctx, job.ID, domain.SummaryMarker+"\n"+`{"topic":"databases","decisions":["use Postgres"]}`, nil); err != nil {
		t.Fatal(err)
	}
	e.turn(main.ID, strings.Repeat("later words ", 10), strings.Repeat("later answer ", 10))

	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next")
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{}
	for _, block := range preview.Blocks {
		keys[block.Key] = true
	}
	for _, want := range []string{tangent.PreviewSummary, tangent.PreviewHistory, tangent.PreviewUserMessage} {
		if !keys[want] {
			t.Fatalf("missing %s in %v", want, keys)
		}
	}
}

// TestPrompt_BlocksFollowTheFixedOrder: rules → pack → notes → host
// sections → summary → card notice → recent history (DESIGN §12).
func TestPrompt_BlocksFollowTheFixedOrder(t *testing.T) {
	host := contributorFunc(func(context.Context, tangent.Scope, domain.LineView) ([]domain.PromptSection, error) {
		return []domain.PromptSection{{Key: "plan", Title: "Host plan", Body: "HOST-BLOCK"}}, nil
	})
	e := newEnv(t, tangent.WithPromptContributor(host))
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "side")
	if _, err := e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "NOTE-TEXT"}}); err != nil {
		t.Fatal(err)
	}
	e.turn(branch.Line.ID, "bq", "ba")
	e.summarized(branch.Line.ID)
	inner := e.branch(branch.Line.ID, e.lastReply(branch.Line.ID), "inner")
	reply := e.turn(inner.Line.ID, "iq", "ia")
	detail, _ := e.engine.GetBranch(e.ctx, scopeA, inner.Line.ID)
	card := domain.BranchCard{Question: "q", Conclusion: "CARD-CONCLUSION", Evidence: []domain.BranchCardEvidence{{MessageID: reply.Message.ID}}}
	if _, err := e.engine.MergeBranch(e.ctx, scopeA, inner.Line.ID, tangent.MergeInput{Card: card, ParentTipMessageID: detail.ParentTipMessageID}); err != nil {
		t.Fatal(err)
	}
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, branch.Line.ID, "next")
	if err != nil {
		t.Fatal(err)
	}
	system, _ := preview.Prompt.Chat()
	markers := []string{"Rules:", "## Branch background", "NOTE-TEXT", "HOST-BLOCK", "remember the summary", "CARD-CONCLUSION"}
	last := -1
	for _, marker := range markers {
		at := strings.Index(system, marker)
		if at <= last {
			t.Fatalf("%q at %d (after %d) in\n%s", marker, at, last, system)
		}
		last = at
	}
}
