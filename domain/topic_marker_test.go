package domain

import (
	"strings"
	"testing"
)

func TestExtractTopicSummary_RemovesEveryLineAndKeepsTheFirstValidTitle(t *testing.T) {
	l := DefaultLimits().Text
	cases := []struct {
		name, content, text, title string
	}{
		{"valid", "Answer.\n" + TopicMarker + `{"title":"  家用 NAS 選購 "}`, "Answer.", "家用 NAS 選購"},
		{"closing form and spaces", "Answer.\n  " + TopicMarker + ` {"title":"ZFS mirror"} [/TOPIC]` + "\n", "Answer.", "ZFS mirror"},
		{"invalid JSON", "Answer.\n" + TopicMarker + `{"title":`, "Answer.", ""},
		{"not an object", "Answer.\n" + TopicMarker + ` NAS`, "Answer.", ""},
		{"trailing data", "Answer.\n" + TopicMarker + `{"title":"a"} and more`, "Answer.", ""},
		{"empty title", "Answer.\n" + TopicMarker + `{"title":"  "}`, "Answer.", ""},
		{"over-long", "Answer.\n" + TopicMarker + `{"title":"` + strings.Repeat("字", TopicSummaryMaxRunes+1) + `"}`, "Answer.", ""},
		{"exactly the cap", "A\n" + TopicMarker + `{"title":"` + strings.Repeat("字", TopicSummaryMaxRunes) + `"}`, "A", strings.Repeat("字", TopicSummaryMaxRunes)},
		{"multiple lines: first valid wins, all removed",
			"Answer.\n" + TopicMarker + `{"title":""}` + "\nMiddle\n" + TopicMarker + `{"title":"Second"}` + "\n" + TopicMarker + `{"title":"Third"}`,
			"Answer.\nMiddle", "Second"},
		{"marker mid-text is removed, not parsed", "See " + TopicMarker + `{"title":"x"} here`, `See {"title":"x"} here`, ""},
		{"flattened and markers removed", "A\n" + TopicMarker + `{"title":"one\ntwo [BRANCH-CARD]"}`, "A", "one two"},
		{"no marker", "  plain reply \n", "plain reply", ""},
	}
	for _, c := range cases {
		text, title := ExtractTopicSummary(c.content, l)
		if text != c.text || title != c.title {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", c.name, text, title, c.text, c.title)
		}
	}
	if _, title := ExtractTopicSummary("A\n"+TopicMarker+`{"title":"twelve chars"}`, TextLimits{TitleMaxRunes: 5}); title != "" {
		t.Fatalf("a title over the line title limit is invalid: %q", title)
	}
	if text, _ := ExtractTopicSummary("A\n​"+TopicMarker+`{"title":"x"}`, l); text != "A" {
		t.Fatalf("an invisible character before the marker does not hide the line: %q", text)
	}
}

func TestExtractChapterCut_RemovesTheLinesAndValidatesTheTitle(t *testing.T) {
	l := DefaultLimits().Chapters
	text, title := ExtractChapterCut("Answer.\n"+ChapterCutMarker+`{"title":"備份策略"}`, l)
	if text != "Answer." || title != "備份策略" {
		t.Fatalf("got (%q, %q)", text, title)
	}
	text, title = ExtractChapterCut("Answer.\n"+ChapterCutMarker+`{"title":"`+strings.Repeat("x", l.TopicTitleMaxRunes+1)+`"}`, l)
	if text != "Answer." || title != "" {
		t.Fatalf("over-long: got (%q, %q)", text, title)
	}
	text, title = ExtractChapterCut("Answer.\n"+ChapterCutMarker+"{oops}\n"+ChapterCutMarker+`{"title":"B"}`, l)
	if text != "Answer." || title != "B" {
		t.Fatalf("invalid then valid: got (%q, %q)", text, title)
	}
	text, title = ExtractChapterCut("Mid "+ChapterCutMarker+" text", l)
	if text != "Mid  text" || title != "" {
		t.Fatalf("mid-text: got (%q, %q)", text, title)
	}
	if _, title := ExtractChapterCut("A\n"+ChapterCutMarker+`{"title":"abcdef"}`, ChapterLimits{TopicTitleMaxRunes: 5}); title != "" {
		t.Fatalf("the topic title limit applies: %q", title)
	}
}

func TestStripAgentMarkers_RemovesTheTitleMarkers(t *testing.T) {
	got := StripAgentMarkers("a " + TopicMarker + " b " + ChapterCutMarker + " c [/TOPIC] [/CHAPTER] [TOP" + TopicMarker + "IC]")
	if strings.Contains(got, "[TOPIC]") || strings.Contains(got, "[CHAPTER]") || strings.Contains(got, "[/") {
		t.Fatalf("got %q", got)
	}
}

func TestWantsTopicSummary_OnlyOnTheFirstTurnOfAQualifyingLine(t *testing.T) {
	long := "請問家用 NAS 要選哪一種磁碟陣列比較好呢" // 22 runes
	short := "NAS 選哪種 RAID？"
	purposeLong := strings.Repeat("目", 26)
	purposeShort := "了解：豪斯多夫維度"
	done := Message{ID: "m1", Role: RoleUser, Status: MessageDone, Kind: MessageKindChat, Content: "earlier"}
	failed := Message{ID: "m2", Role: RoleAssistant, Status: MessageError, Kind: MessageKindChat, Content: "Turn failed"}
	cases := []struct {
		name  string
		in    PromptInput
		title string
		want  bool
	}{
		{"main, long first message", PromptInput{UserMessage: long}, "main", true},
		{"main, short first message", PromptInput{UserMessage: short}, "main", false},
		{"main, short message, no title", PromptInput{UserMessage: short}, " ", true},
		{"main, exactly 20 runes", PromptInput{UserMessage: strings.Repeat("字", 20)}, "main", false},
		{"main, with history", PromptInput{UserMessage: long, History: []Message{done}}, "main", false},
		{"main, a failed reply is not history", PromptInput{UserMessage: long, History: []Message{failed}}, "main", true},
		{"main, with a summary", PromptInput{UserMessage: long, Summary: Summary{Topic: "t"}, SummaryUptoSeq: 2}, "main", false},
		{"main, with a selection", PromptInput{UserMessage: long, Selection: &HistorySelection{Full: []Message{done}}}, "main", false},
		{"spun-off line", PromptInput{UserMessage: long, OriginCapsule: "capsule"}, "", false},
		{"branch, long purpose", PromptInput{UserMessage: "go", Branch: &BranchPromptInfo{Purpose: purposeLong}}, "", true},
		{"branch, short deliberate purpose", PromptInput{UserMessage: long + long, Branch: &BranchPromptInfo{Purpose: purposeShort}}, "", false},
		{"branch, exactly 25 runes", PromptInput{UserMessage: "go", Branch: &BranchPromptInfo{Purpose: strings.Repeat("目", 25)}}, "", false},
		{"aside never", PromptInput{UserMessage: long, Branch: &BranchPromptInfo{Purpose: purposeLong, Aside: true}}, "", false},
		{"branch, with history", PromptInput{UserMessage: "go", Branch: &BranchPromptInfo{Purpose: purposeLong}, History: []Message{done}}, "", false},
	}
	for _, c := range cases {
		if got := WantsTopicSummary(c.in, c.title); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestChapterCutDue_CountsTheCurrentChapterWithoutCardsAndTheTurn(t *testing.T) {
	chapter := func(count int, cards ...string) Chapter {
		return Chapter{MessageCount: count, CardMessageIDs: cards}
	}
	cases := []struct {
		name     string
		chapters []Chapter
		own      int
		want     bool
	}{
		{"no chapters", nil, 1, false},
		{"two exchanges and the new message", []Chapter{chapter(5)}, 1, true},
		{"one exchange and the new message", []Chapter{chapter(3)}, 1, false},
		{"only the last chapter counts", []Chapter{chapter(40), chapter(2)}, 1, false},
		{"cards do not count", []Chapter{chapter(6, "c1", "c2")}, 1, false},
		{"preview: no own message", []Chapter{chapter(4)}, 0, true},
	}
	for _, c := range cases {
		if got := ChapterCutDue(c.chapters, c.own); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestReplyLines_ATrailingSectionOnlyWhenAsked(t *testing.T) {
	trailing := func(p Prompt) (PromptSection, bool) {
		for _, s := range append(p.Sections, p.Trailing...) {
			if s.Key == SectionReplyLines {
				return s, true
			}
		}
		return PromptSection{}, false
	}
	plain := BuildPrompt(PromptInput{UserMessage: "go"})
	if _, ok := trailing(plain); ok || strings.Contains(plain.ResumeText(), TopicMarker) {
		t.Fatalf("a section without asking: %+v", plain.Sections)
	}
	asked := BuildPrompt(PromptInput{UserMessage: "go", RequestTopicSummary: true, AllowChapterCut: true})
	section, ok := trailing(asked)
	if !ok || !strings.Contains(section.Body, TopicSummaryRule) || !strings.Contains(section.Body, ChapterCutRule) {
		t.Fatalf("reply lines: %+v", section)
	}
	for _, s := range asked.Sections {
		if s.Key == SectionRules && (strings.Contains(s.Body, TopicMarker) || strings.Contains(s.Body, ChapterCutMarker)) {
			t.Fatalf("the stable rules stay the same: %q", s.Body)
		}
	}
	if !strings.Contains(asked.ResumeText(), strings.TrimSpace(ChapterCutRule)) {
		t.Fatalf("a resumed session gets the rules: %q", asked.ResumeText())
	}
	branch := BuildReplyLinesBlock(PromptInput{AllowChapterCut: true, Branch: &BranchPromptInfo{Purpose: "p"}})
	if branch != "" {
		t.Fatalf("a branch never gets the chapter rule: %q", branch)
	}
}
