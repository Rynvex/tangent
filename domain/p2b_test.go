package domain

import (
	"fmt"
	"strings"
	"testing"
)

func TestP2bLimits_DefaultsAndValidate(t *testing.T) {
	d := DefaultLimits()
	if d.Context != (ContextLimits{TokenBudget: 40000}) {
		t.Fatalf("context limits = %+v", d.Context)
	}
	if d.Fisheye != (FisheyeLimits{FullExchanges: 4, SummaryExchanges: 20, BranchReach: 3, MaxBranches: 20}) {
		t.Fatalf("fisheye limits = %+v", d.Fisheye)
	}
	if filled := (Limits{Fisheye: FisheyeLimits{FullExchanges: 2}}).WithDefaults(); filled.Fisheye.FullExchanges != 2 || filled.Fisheye.MaxBranches != 20 || filled.Context.TokenBudget != 40000 {
		t.Fatalf("field by field: %+v %+v", filled.Fisheye, filled.Context)
	}
	if err := (Limits{Fisheye: FisheyeLimits{BranchReach: -1}}).Validate(); err == nil || !strings.Contains(err.Error(), "Fisheye.BranchReach") {
		t.Fatalf("a negative reach is refused: %v", err)
	}
}

// exchanges builds n operator / assistant pairs, oldest first, seq from 1.
func exchanges(n int) []Message {
	out := []Message{}
	for i := range n {
		out = append(out,
			Message{ID: fmt.Sprintf("u%d", i), Seq: int64(2*i + 1), Role: RoleUser, Kind: MessageKindChat, Status: MessageDone, Content: fmt.Sprintf("question %d", i)},
			Message{ID: fmt.Sprintf("a%d", i), Seq: int64(2*i + 2), Role: RoleAssistant, Kind: MessageKindChat, Status: MessageDone, Content: fmt.Sprintf("answer %d", i)})
	}
	return out
}

func levels(sel FisheyeSelection) map[string]string {
	out := map[string]string{}
	for _, item := range sel.Items {
		out[item.ID] = item.Level
	}
	return out
}

func TestSelectFisheye_MessagesFadeWithDistance(t *testing.T) {
	messages := exchanges(30)
	sel := SelectFisheye(FisheyeInput{Messages: messages, TokenBudget: 100000, Limits: DefaultLimits()})
	got := levels(sel)
	cases := map[string]string{"a29": FisheyeFull, "u26": FisheyeFull, "a25": FisheyeSummary, "u10": FisheyeSummary, "a9": FisheyeHidden, "u0": FisheyeHidden}
	for id, want := range cases {
		if got[id] != want {
			t.Errorf("%s = %s, want %s", id, got[id], want)
		}
	}
	if len(sel.Full) != 8 || sel.Full[0].ID != "u26" || len(sel.Condensed) != 32 || sel.Condensed[0].ID != "u10" {
		t.Fatalf("full %d (%s…), condensed %d", len(sel.Full), sel.Full[0].ID, len(sel.Condensed))
	}
	for _, item := range sel.Items {
		if item.ID == "a29" && (item.Score != 0 || item.Kind != FisheyeItemMessage || item.Tokens == 0) {
			t.Fatalf("the newest reply: %+v", item)
		}
		if item.ID == "u0" && item.Score != -29 {
			t.Fatalf("score = importance − exchanges back: %+v", item)
		}
	}
}

func TestSelectFisheye_PinnedReferencedCardsAndTheSummary(t *testing.T) {
	messages := exchanges(30)
	messages[0].Pinned = true
	card := BranchCard{Question: "q", Conclusion: "use the ryokan"}
	messages[11] = Message{ID: "card", Seq: messages[11].Seq, Role: RoleSystem, Kind: MessageKindBranchCard, Status: MessageDone, Meta: MessageMeta{Card: &card, Delivered: true}}
	sel := SelectFisheye(FisheyeInput{
		Messages: messages, Referenced: map[string]bool{"u7": true}, SummaryUptoSeq: 12, TokenBudget: 100000, Limits: DefaultLimits(),
	})
	got := levels(sel)
	if got["u0"] != FisheyeFull || sel.Full[0].ID != "u0" {
		t.Fatalf("a pinned message is kept whole, even under the summary: %v", got["u0"])
	}
	if got["u3"] != FisheyeSummary || got["u5"] != FisheyeSummary {
		t.Fatalf("the rolling summary covers what it summarised: %v %v", got["u3"], got["u5"])
	}
	for _, m := range sel.Condensed {
		if m.Seq <= 12 {
			t.Fatalf("covered messages are not condensed again: %+v", m)
		}
	}
	if got["u7"] != FisheyeSummary {
		t.Fatalf("a referenced message reaches further: %v", got["u7"])
	}
	for _, item := range sel.Items {
		if item.ID == "card" && item.Score != 6-24 {
			t.Fatalf("a card has a head start: %+v", item)
		}
	}
}

func TestSelectFisheye_TheBudgetDowngradesTheLowestFirst(t *testing.T) {
	messages := exchanges(6)
	for i := range messages {
		messages[i].Content = strings.Repeat("w ", 400)
	}
	sel := SelectFisheye(FisheyeInput{Messages: messages, TokenBudget: 500, Limits: DefaultLimits()})
	got := levels(sel)
	if got["a5"] != FisheyeFull || got["u5"] != FisheyeFull || got["a4"] != FisheyeSummary || got["u0"] != FisheyeHidden {
		t.Fatalf("levels = %v", got)
	}
	if sel.Tokens > 500 {
		t.Fatalf("over budget: %d", sel.Tokens)
	}
	tiny := SelectFisheye(FisheyeInput{Messages: messages, TokenBudget: 1, Limits: DefaultLimits()})
	if len(tiny.Full) != 1 || tiny.Full[0].ID != "a5" {
		t.Fatalf("the newest message always stays: %+v", tiny.Full)
	}
}

func TestSelectFisheye_BranchesShowTheirLeafByImportanceAndDistance(t *testing.T) {
	branches := []FisheyeBranch{
		{LineID: "near", Purpose: "Ryokan prices", LeafKind: LeafKindDecision, Line: "Book the ryokan", Distance: 1},
		{LineID: "far", Purpose: "Rail pass", LeafKind: LeafKindDeadEnd, Line: "Not worth it", Distance: 5},
		{LineID: "farDecision", Purpose: "Dates", LeafKind: LeafKindDecision, Line: "Go in April", Distance: 8},
		{LineID: "bare", Purpose: "Open question", Distance: 1},
		{LineID: "card", Purpose: "Budget", Line: "About 2,000 a day", Distance: 2},
	}
	sel := SelectFisheye(FisheyeInput{Messages: exchanges(1), Branches: branches, TokenBudget: 100000, Limits: DefaultLimits()})
	got := levels(sel)
	want := map[string]string{"near": FisheyeLeafOnly, "far": FisheyeHidden, "farDecision": FisheyeLeafOnly, "bare": FisheyeHidden, "card": FisheyeLeafOnly}
	for id, level := range want {
		if got[id] != level {
			t.Errorf("%s = %s, want %s", id, got[id], level)
		}
	}
	if len(sel.Conclusions) != 3 || sel.Conclusions[0].LineID != "near" {
		t.Fatalf("conclusions by score: %+v", sel.Conclusions)
	}
	block := BuildBranchConclusions(sel.Conclusions, nil)
	if !strings.HasPrefix(block, "## Other branches' conclusions\n") || !strings.Contains(block, "> [decision] Ryokan prices — Book the ryokan") ||
		!strings.Contains(block, "> Budget — About 2,000 a day") {
		t.Fatalf("block = %q", block)
	}
	if BuildBranchConclusions(nil, nil) != "" {
		t.Fatal("no conclusions, no block")
	}
	limits := DefaultLimits()
	limits.Fisheye.MaxBranches = 1
	if capped := SelectFisheye(FisheyeInput{Branches: branches, TokenBudget: 100000, Limits: limits}); len(capped.Conclusions) != 1 {
		t.Fatalf("capped: %+v", capped.Conclusions)
	}
}

func TestBuildPrompt_AFisheyeSelection(t *testing.T) {
	messages := exchanges(3)
	p := BuildPrompt(PromptInput{
		UserMessage: "next", Selection: &HistorySelection{Full: messages[4:], Condensed: messages[:4]},
		BranchConclusions: "## Other branches' conclusions\n\n> x\n",
	})
	if len(p.History) != 2 || p.History[0].Content != "question 2" || !strings.Contains(p.Earlier, "Earlier in this session (4 messages") {
		t.Fatalf("history %+v, earlier %q", p.History, p.Earlier)
	}
	if section, ok := p.section(SectionBranchConclusions); !ok || !strings.Contains(section.Body, "> x") {
		t.Fatalf("sections %+v", p.Sections)
	}
	empty := BuildPrompt(PromptInput{UserMessage: "q", Selection: &HistorySelection{}})
	if len(empty.History) != 0 || empty.Earlier != "" {
		t.Fatalf("empty = %+v", empty)
	}
}

func TestEstimateInputTokens_CountsTheVariableBlocks(t *testing.T) {
	base := EstimateInputTokens(PromptInput{})
	with := EstimateInputTokens(PromptInput{
		Goal: "a goal", NotesBlock: "notes", Summary: Summary{Topic: "topic"}, SummaryUptoSeq: 3, OriginCapsule: "capsule",
		Branch: &BranchPromptInfo{Pack: "pack"}, HostSections: []PromptSection{{Key: "h", Body: "host"}}, BranchConclusions: "c",
		Cards: []BranchCardNoticeItem{{MessageID: "m", Card: BranchCard{Question: "q", Conclusion: "c"}}},
	})
	if base != 0 || with <= 20 {
		t.Fatalf("base %d, with %d", base, with)
	}
}

func TestBuildPrompt_ASelectionCondensesEveryLineItChose(t *testing.T) {
	messages := exchanges(40)
	for i := range messages {
		messages[i].Content += " " + strings.Repeat("detail ", 15)
	}
	p := BuildPrompt(PromptInput{UserMessage: "q", Selection: &HistorySelection{Condensed: messages}})
	if strings.Contains(p.Earlier, "omitted") || !strings.Contains(p.Earlier, "question 0") || !strings.Contains(p.Earlier, "answer 39") {
		t.Fatalf("every chosen line is there (the fisheye budget bounds them): %q", p.Earlier)
	}
}
