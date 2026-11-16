package domain

import (
	"errors"
	"strings"
	"testing"
)

func TestTextLimits_DefaultAndValidate(t *testing.T) {
	d := DefaultLimits().Text
	if d.TitleMaxRunes != 200 || d.ModelMaxRunes != 100 || d.MessageMaxRunes != 32000 {
		t.Fatalf("defaults = %+v", d)
	}
	if got := (Limits{Text: TextLimits{MessageMaxRunes: 10}}).WithDefaults().Text; got.MessageMaxRunes != 10 || got.TitleMaxRunes != 200 {
		t.Fatalf("field by field: %+v", got)
	}
	if err := (Limits{Text: TextLimits{TitleMaxRunes: -1}}).Validate(); err == nil {
		t.Fatal("negative text limits are refused")
	}
}

func TestCheckRunes_RefusesTooLongFieldsWithTheField(t *testing.T) {
	if err := CheckRunes("title", "héllo", 5); err != nil {
		t.Fatalf("five runes fit: %v", err)
	}
	err := CheckRunes("title", "héllo!", 5)
	e := AsError(err, DefaultLimits())
	if e == nil || e.Code != CodeTooLong || e.Extra["field"] != "title" || e.Extra["max"] != 5 || !errors.Is(err, ErrTooLong) {
		t.Fatalf("err = %#v", e)
	}
}

func TestChatBlocks_SplitsTheSystemIntoStableAndVolatile(t *testing.T) {
	summary := Summary{Topic: "trip"}
	p := Prompt{
		Sections: []PromptSection{{Key: SectionRules, Body: "rules"}, {Key: SectionNotes, Body: "notes"}},
		Summary:  &summary, Trailing: []PromptSection{{Key: SectionBranchCards, Body: "cards"}},
		Earlier: "older", History: []ChatMessage{{Role: ChatRoleUser, Content: "q"}}, UserMessage: "now",
	}
	stable, volatile, messages := p.ChatBlocks()
	system, want := p.Chat()
	if stable+"\n\n"+volatile != system {
		t.Fatalf("the blocks joined are Chat's system:\n%q\n%q", stable+"\n\n"+volatile, system)
	}
	if strings.Contains(stable, "trip") || strings.Contains(stable, "cards") || strings.Contains(stable, "older") || !strings.Contains(volatile, "cards") {
		t.Fatalf("stable %q volatile %q", stable, volatile)
	}
	if len(messages) != len(want) {
		t.Fatalf("messages = %v", messages)
	}
	onlyStable := Prompt{Sections: p.Sections, UserMessage: "x"}
	if s, v, _ := onlyStable.ChatBlocks(); v != "" || s+"" != func() string { sys, _ := onlyStable.Chat(); return sys }() {
		t.Fatalf("without volatile parts: %q %q", s, v)
	}
}

func TestBuildHistory_LeavesFailedRepliesOut(t *testing.T) {
	history := []Message{
		{ID: "1", Seq: 1, Role: RoleUser, Status: MessageDone, Content: "question"},
		{ID: "2", Seq: 2, Role: RoleAssistant, Status: MessageError, Content: "partial", Meta: MessageMeta{Error: "boom"}},
		{ID: "3", Seq: 3, Role: RoleAssistant, Status: MessageDone, Content: "answer"},
	}
	_, entries := buildHistory(history, DefaultLimits().History)
	for _, e := range entries {
		if strings.Contains(e.Content, "partial") {
			t.Fatalf("a failed reply is in the history: %v", entries)
		}
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %v", entries)
	}
}
