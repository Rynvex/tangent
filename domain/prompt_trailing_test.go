package domain

import (
	"errors"
	"strings"
	"testing"
)

func TestPrompt_TrailingSectionsComeAfterTheSummary(t *testing.T) {
	summary := Summary{Topic: "retries"}
	p := Prompt{
		Sections:    []PromptSection{{Key: SectionRules, Body: "rules"}},
		Summary:     &summary,
		Trailing:    []PromptSection{{Key: SectionBranchCards, Body: "cards"}},
		UserMessage: "go",
	}
	system, _ := p.Chat()
	rules, sum, cards := strings.Index(system, "rules"), strings.Index(system, "## Conversation summary"), strings.Index(system, "cards")
	if rules < 0 || sum < rules || cards < sum {
		t.Fatalf("order rules=%d summary=%d cards=%d in\n%s", rules, sum, cards, system)
	}
	if text := p.Text(); strings.Index(text, "cards") < strings.Index(text, "## Conversation summary") {
		t.Fatalf("Text must use the same order:\n%s", text)
	}
	if resume := p.ResumeText(); !strings.HasPrefix(resume, "cards") {
		t.Fatalf("ResumeText must still find the cards among the trailing sections:\n%s", resume)
	}
}

func TestPrompt_WithoutTrailingNothingChanges(t *testing.T) {
	in := PromptInput{History: []Message{chatMessage(1, RoleUser, "hello")}, UserMessage: "next"}
	p := BuildPrompt(in)
	if len(p.Trailing) != 0 {
		t.Fatalf("BuildPrompt never fills Trailing: %+v", p.Trailing)
	}
}

func TestPrompt_SuggestRulesCanBeLeftOut(t *testing.T) {
	with := BuildPrompt(PromptInput{UserMessage: "go"})
	without := BuildPrompt(PromptInput{UserMessage: "go", OmitBranchSuggestRules: true})
	if !strings.Contains(with.Text(), BranchSuggestMarker) || strings.Contains(without.Text(), BranchSuggestMarker) {
		t.Fatalf("with:\n%s\nwithout:\n%s", with.Text(), without.Text())
	}
}

func TestFeatureDisabled_NamesTheFeature(t *testing.T) {
	err := FeatureDisabled("notes")
	if CodeOf(err) != CodeFeatureDisabled || err.Extra["feature"] != "notes" || !errors.Is(err, ErrFeatureDisabled) {
		t.Fatalf("err = %#v", err)
	}
	if copied := AsError(err, DefaultLimits()); copied.Extra["feature"] != "notes" {
		t.Fatalf("copy lost the feature: %#v", copied)
	}
}
