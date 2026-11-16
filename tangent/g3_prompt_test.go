package tangent_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// g3DraftReply is a drafting model's card that cites messages by the
// prompt's short ids, by a real id and by a short id that does not exist.
func g3DraftReply(t *testing.T, realBranchID string) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"question": "Kafka or NATS?", "conclusion": "NATS is lighter.",
		"evidence": []map[string]string{
			{"messageId": "B2", "note": "Kafka needs a cluster"}, {"messageId": realBranchID, "note": "NATS is one binary"},
			{"messageId": "B999", "note": "made up"},
		},
		"needsDecision": []map[string]string{{"branchClaim": "NATS", "mainLineClaim": "NATS too", "mainLineMessageId": "M2"}},
		"excerpts":      []map[string]string{{"messageId": "[B2]", "text": "run `make bench` to see."}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return domain.BranchCardMarker + "\n" + string(raw)
}

func TestG3_CardDraftNamesMessagesByShortIDsAndMapsThemBack(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "which queue?", "Kafka or NATS, both work.")
	created, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{
		AnchorMessageID: anchor.Message.ID, Purpose: "compare queues", Excerpt: "Kafka or NATS", Kind: domain.BranchKindInvestigate,
	})
	if err != nil {
		t.Fatal(err)
	}
	first := e.turn(created.Line.ID, "is Kafka heavier?", "Kafka needs a cluster; run `make bench` to see.")
	second := e.turn(created.Line.ID, "and NATS?", "NATS is a single binary.")
	moved := e.turn(main.ID, "we pick NATS", "NATS it is.")

	job, err := e.engine.StartDraft(e.ctx, scopeA, created.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	prompt := job.Prompt.UserMessage
	for _, want := range []string{
		"### [B1] branch message (operator)", "### [B4] branch message (agent)", "### [M1] main-line message (operator)", "### [M2] main-line message (agent)",
		"Text the operator selected when opening the branch:\n> Kafka or NATS", "hangs on (agent, condensed):\n> Kafka or NATS, both work.",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("draft prompt lacks %q:\n%s", want, prompt)
		}
	}
	for _, id := range []string{first.Message.ID, second.Message.ID, moved.Message.ID} {
		if strings.Contains(prompt, id) {
			t.Fatalf("message id %s is spelled out in the prompt", id)
		}
	}
	if strings.Contains(prompt, "## Background the branch started from") {
		t.Fatal("a branch with selected text and four messages does not repeat the pack")
	}

	// The main line moves on while the draft runs: M ids keep their meaning.
	e.turn(main.ID, "one more thing", "sure")
	if err := e.engine.FinishJob(e.ctx, job.ID, g3DraftReply(t, second.Message.ID), nil); err != nil {
		t.Fatal(err)
	}
	detail, err := e.engine.GetBranch(e.ctx, scopeA, created.Line.ID)
	if err != nil || detail.Draft.Status != domain.BranchDraftReady {
		t.Fatalf("draft %+v, %v", detail.Draft, err)
	}
	card := detail.Draft.Card
	if len(card.Evidence) != 2 || card.Evidence[0].MessageID != first.Message.ID || card.Evidence[1].MessageID != second.Message.ID {
		t.Fatalf("evidence = %+v", card.Evidence)
	}
	if card.NeedsDecision[0].MainLineMessageID != moved.Message.ID || len(card.Excerpts) != 1 || card.Excerpts[0].MessageID != first.Message.ID {
		t.Fatalf("decision %+v excerpts %+v", card.NeedsDecision, card.Excerpts)
	}
	if len(detail.Draft.Warnings) != 1 || !strings.Contains(detail.Draft.Warnings[0], "evidence") {
		t.Fatalf("only the made-up id is dropped: %v", detail.Draft.Warnings)
	}
	if _, err := e.engine.MergeBranch(e.ctx, scopeA, created.Line.ID, tangent.MergeInput{Card: *card, ParentTipMessageID: detail.ParentTipMessageID}); err != nil {
		t.Fatalf("a resolved draft merges as it is: %v", err)
	}
}

func TestG3_ShortBranchWithoutSelectionKeepsAShortBackground(t *testing.T) {
	e := newEnv(t)
	_, branch, _ := e.draftable()
	job, err := e.engine.StartDraft(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if prompt := job.Prompt.UserMessage; !strings.Contains(prompt, "## Background the branch started from") || !strings.Contains(prompt, "### [B2] branch message (agent)") {
		t.Fatalf("draft prompt:\n%s", prompt)
	}
}

func TestG3_BranchTurnsGetTheirKindRuleAndNoSuggestionRule(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	if !strings.Contains(e.lastSystem(), domain.BranchSuggestMarker) {
		t.Fatal("the main line keeps the suggestion rule")
	}
	investigate := e.branch(main.ID, anchor.Message.ID, "dig in")
	e.turn(investigate.Line.ID, "bq", "ba")
	if system := e.lastSystem(); !strings.Contains(system, "unconfirmed guesses") || strings.Contains(system, domain.BranchSuggestMarker) {
		t.Fatalf("investigate branch system:\n%s", system)
	}
	alternative, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Purpose: "other way", Kind: domain.BranchKindAlternative})
	if err != nil {
		t.Fatal(err)
	}
	e.turn(alternative.Line.ID, "bq", "ba")
	if system := e.lastSystem(); !strings.Contains(system, "the assumptions behind each") || strings.Contains(system, "unconfirmed guesses") || strings.Contains(system, domain.BranchSuggestMarker) {
		t.Fatalf("alternative branch system:\n%s", system)
	}
}

func TestG3_LeafDraftCarriesTheSelection(t *testing.T) {
	e := newEnvWith(t, p1Features())
	main := e.mainLine()
	anchor := e.turn(main.ID, "which queue?", "Kafka or NATS")
	created, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{
		AnchorMessageID: anchor.Message.ID, Purpose: "compare queues", Excerpt: "Kafka", Kind: domain.BranchKindInvestigate,
	})
	if err != nil {
		t.Fatal(err)
	}
	e.turn(created.Line.ID, "is it heavy?", "yes")
	job, err := e.engine.StartLeafDraft(e.ctx, scopeA, created.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(job.Prompt.UserMessage, "Text the operator selected when opening the branch:\n> Kafka") {
		t.Fatalf("leaf prompt:\n%s", job.Prompt.UserMessage)
	}
}
