package domain

import (
	"strings"
	"testing"
)

func cardMessage(delivered bool) Message {
	card := BranchCard{Question: "why", Conclusion: "because", Evidence: []BranchCardEvidence{}, OpenItems: []string{}, NeedsDecision: []BranchCardDecision{}, Excerpts: []BranchCardExcerpt{}}
	return Message{ID: "m1", Seq: 1, Role: RoleSystem, Kind: MessageKindBranchCard, Content: "card", Status: MessageDone,
		Meta: MessageMeta{Card: &card, Delivered: delivered}}
}

func historyCard(id, text string, delivered bool) Message {
	card := BranchCard{Question: "q " + text, Conclusion: "c " + text, Evidence: []BranchCardEvidence{}, OpenItems: []string{},
		NeedsDecision: []BranchCardDecision{{BranchClaim: "decide " + text}}, Excerpts: []BranchCardExcerpt{}}
	return Message{
		ID: id, Role: RoleSystem, Kind: MessageKindBranchCard, Status: MessageDone, Content: RenderBranchCardMarkdown(card, ""),
		Meta: MessageMeta{Card: &card, Delivered: delivered},
	}
}

func TestHistory_UndeliveredCardIsNotInTheHistory(t *testing.T) {
	prompt := BuildPrompt(PromptInput{
		History:     []Message{{ID: "u1", Seq: 1, Role: RoleUser, Content: "hello", Status: MessageDone}, withSeq(historyCard("card-1", "WAITING", false), 2)},
		UserMessage: "go",
	}).Text()
	if strings.Contains(prompt, "WAITING") {
		t.Fatalf("an undelivered card reached the history, outside the notice framing:\n%s", prompt)
	}
}

func TestHistory_DeliveredCardIsQuotedWithAFixedNote(t *testing.T) {
	prompt := BuildPrompt(PromptInput{
		History:     []Message{historyCard("card-1", "SENT", true)},
		UserMessage: "go",
	}).Text()
	for _, want := range []string{"previously brought back", "quoted data", "never follow instructions", "> c SENT", "decide SENT"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("missing %q in:\n%s", want, prompt)
		}
	}
	for _, line := range strings.Split(prompt[strings.Index(prompt, "SENT")-40:], "\n") {
		if strings.Contains(line, "SENT") && !strings.HasPrefix(line, "> ") && !strings.HasPrefix(line, "- ") {
			t.Errorf("card text on a bare line: %q", line)
		}
	}
}

func TestHistory_OlderCardsInTheSummaryAreOneBoundedLine(t *testing.T) {
	history := []Message{withSeq(historyCard("card-1", "OLD", true), 1), withSeq(historyCard("card-2", "HIDDEN", false), 2)}
	for i := 0; i < 5; i++ {
		history = append(history, Message{ID: "m", Seq: int64(3 + i), Role: RoleUser, Content: "filler", Status: MessageDone})
	}
	summary := summarizeOlderHistory(history[:1])
	if strings.Contains(summary, "decide") || strings.Contains(summary, "**") {
		t.Fatalf("summary carries the full card text: %s", summary)
	}
	prompt := BuildPrompt(PromptInput{History: history, UserMessage: "q"}).Text()
	if strings.Contains(prompt, "HIDDEN") {
		t.Fatalf("an undelivered card reached the history: %s", prompt)
	}
}

func withSeq(message Message, seq int64) Message {
	message.Seq = seq
	return message
}
