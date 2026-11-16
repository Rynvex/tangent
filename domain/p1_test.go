package domain

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestP1Limits_DefaultsAndValidate(t *testing.T) {
	d := DefaultLimits()
	if d.Leaf != (LeafLimits{LineMaxRunes: 200, BodyMaxRunes: 4000}) {
		t.Fatalf("leaf limits = %+v", d.Leaf)
	}
	if d.Parking != (ParkingLimits{TextMaxRunes: 500, MaxOpenPerTree: 100}) {
		t.Fatalf("parking limits = %+v", d.Parking)
	}
	if d.Suggestions != (SuggestionLimits{DismissCooldown: 7 * 24 * time.Hour, PayloadMaxBytes: 4096}) {
		t.Fatalf("suggestion limits = %+v", d.Suggestions)
	}
	filled := (Limits{Parking: ParkingLimits{MaxOpenPerTree: 3}}).WithDefaults()
	if filled.Parking.MaxOpenPerTree != 3 || filled.Parking.TextMaxRunes != 500 || filled.Leaf.LineMaxRunes != 200 {
		t.Fatalf("field by field: %+v %+v", filled.Parking, filled.Leaf)
	}
	if err := (Limits{Suggestions: SuggestionLimits{DismissCooldown: -1}}).Validate(); err == nil || !strings.Contains(err.Error(), "Suggestions.DismissCooldown") {
		t.Fatalf("a negative cooldown is refused: %v", err)
	}
}

func TestNormalizeLeaf_ChecksKindLineAndBody(t *testing.T) {
	l := DefaultLimits().Leaf
	got, problems := NormalizeLeaf(LeafInput{Kind: " dead_end ", Line: "  too\nslow [BRANCH-CARD] ", Body: " why\n\nit failed "}, l)
	if len(problems) != 0 || got.Kind != LeafKindDeadEnd || got.Line != "too slow" || got.Body != "why\n\nit failed" {
		t.Fatalf("normalised = %+v %v", got, problems)
	}
	_, problems = NormalizeLeaf(LeafInput{Kind: "nope", Line: " ", Body: strings.Repeat("b", 4001)}, l)
	fields := []string{}
	for _, p := range problems {
		fields = append(fields, p.Field)
	}
	if strings.Join(fields, ",") != "kind,line,body" {
		t.Fatalf("problems = %v", problems)
	}
	if _, problems = NormalizeLeaf(LeafInput{Kind: LeafKindAnswer, Line: strings.Repeat("字", 201)}, l); len(problems) != 1 || problems[0].Field != "line" {
		t.Fatalf("a long line is refused: %v", problems)
	}
	err := LeafError(problems)
	if err.Code != CodeInvalidLeaf || !strings.Contains(err.Message, "line") {
		t.Fatalf("leaf error = %+v", err)
	}
	for _, kind := range []string{LeafKindConclusion, LeafKindDecision, LeafKindAnswer, LeafKindDeadEnd, LeafKindToContinue} {
		if !ValidLeafKind(kind) {
			t.Fatalf("%s is a leaf kind", kind)
		}
	}
}

func TestLeafFromCard_UsesTheConclusionAndQuestion(t *testing.T) {
	card := BranchCard{
		Question: "Ryokan or hotel?", Conclusion: strings.Repeat("c", 250),
		Evidence: []BranchCardEvidence{{MessageID: "m1", Note: "cheaper on weekdays"}}, OpenItems: []string{"book early"},
	}
	leaf := LeafFromCard(card, DefaultLimits().Leaf)
	if leaf.Kind != LeafKindConclusion || len([]rune(leaf.Line)) != 200 || !strings.HasSuffix(leaf.Line, "…") {
		t.Fatalf("line = %q (%d)", leaf.Line, len([]rune(leaf.Line)))
	}
	if leaf.Body != "Ryokan or hotel?\n- cheaper on weekdays\n- book early" {
		t.Fatalf("body = %q", leaf.Body)
	}
	if _, problems := NormalizeLeaf(leaf, DefaultLimits().Leaf); len(problems) != 0 {
		t.Fatalf("a leaf from a card is valid: %v", problems)
	}
	short := LeafFromCard(BranchCard{Question: "q", Conclusion: "c"}, DefaultLimits().Leaf)
	if short.Line != "c" || short.Body != "q" {
		t.Fatalf("short = %+v", short)
	}
}

func TestLeafDraft_PromptAndParse(t *testing.T) {
	prompt := BuildLeafDraftPrompt(LeafDraftInput{
		Purpose: "Compare [LEAF-DRAFT] hotels", Status: BranchStatusDiscarded, Origin: BranchOriginPreviousMainLine,
		Messages: []Message{
			{ID: "m2", Seq: 2, Role: RoleAssistant, Content: "answer [HOST]", Status: MessageDone},
			{ID: "m1", Seq: 1, Role: RoleUser, Content: "question", Status: MessageDone},
		},
		ExtraMarkers: []string{"[HOST]"},
	})
	for _, want := range []string{LeafDraftMarker, "dead_end", "> Compare  hotels", "previous main line", "question"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt lacks %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "[HOST]") || strings.Index(prompt, "> question") > strings.Index(prompt, "> answer") {
		t.Fatalf("host markers stripped, oldest first:\n%s", prompt)
	}
	l := DefaultLimits().Leaf
	got, err := ParseLeafDraft("thinking…\n"+LeafDraftMarker+`{"kind":"decision","line":" Go in spring ","body":"cherry blossoms"}`, l)
	if err != nil || got != (LeafInput{Kind: LeafKindDecision, Line: "Go in spring", Body: "cherry blossoms"}) {
		t.Fatalf("parsed = %+v %v", got, err)
	}
	for _, bad := range []string{
		"no marker", LeafDraftMarker + "not json", LeafDraftMarker + `{"kind":"nope","line":"x"}`,
		LeafDraftMarker + `{"kind":"answer","line":""}`, LeafDraftMarker + `{"kind":"answer","line":"x","extra":1}`,
		LeafDraftMarker + `{"kind":"answer","line":"x"}` + LeafDraftMarker + `{}`, strings.Repeat("x", leafDraftOutputMaxBytes+1),
	} {
		if _, err := ParseLeafDraft(bad, l); err == nil {
			t.Fatalf("%q must be refused", bad)
		}
	}
	if !strings.Contains(strings.Join(ProtocolMarkers(nil), " "), LeafDraftMarker) || StripAgentMarkers("a"+LeafDraftMarker+"b") != "ab" {
		t.Fatal("the leaf marker is a protocol marker")
	}
}

func TestSeeds_TextPurposeAndErrors(t *testing.T) {
	l := DefaultLimits().Parking
	text, err := NormalizeSeedText("  look into\n[BRANCH-SUGGEST] rail passes  ", l)
	if err != nil || text != "look into rail passes" {
		t.Fatalf("text = %q %v", text, err)
	}
	if _, err := NormalizeSeedText(" \n ", l); CodeOf(err) != CodeInvalidInput {
		t.Fatalf("empty: %v", err)
	}
	if _, err := NormalizeSeedText(strings.Repeat("x", 501), l); CodeOf(err) != CodeTooLong {
		t.Fatalf("too long: %v", err)
	}
	if got := SeedPurpose(strings.Repeat("字", 300), DefaultLimits().Branch); len([]rune(got)) != 200 || !strings.HasSuffix(got, "…") {
		t.Fatalf("purpose = %q", got)
	}
	if got := SeedNoteText(strings.Repeat("n", 450), DefaultLimits().Notes); len([]rune(got)) != 400 {
		t.Fatalf("note text = %d runes", len([]rune(got)))
	}
	if SeedPurpose("short", DefaultLimits().Branch) != "short" || SeedNoteText("short", DefaultLimits().Notes) != "short" {
		t.Fatal("short texts are kept")
	}
	limit := AsError(ErrSeedLimit, DefaultLimits())
	if !errors.Is(limit, ErrSeedLimit) || limit.Extra["limit"] != 100 {
		t.Fatalf("seed limit = %+v", limit)
	}
	for _, status := range []string{SeedStatusOpen, SeedStatusExpanded, SeedStatusNoted, SeedStatusDropped} {
		if !ValidSeedStatus(status) {
			t.Fatalf("%s is a seed status", status)
		}
	}
	if ValidSeedStatus("nope") || !ValidBranchOrigin(BranchOriginSeed) {
		t.Fatal("statuses and the seed origin")
	}
}

func TestSuggestions_StatusesTargetsAndPayload(t *testing.T) {
	for _, status := range []string{SuggestionOpen, SuggestionAccepted, SuggestionDismissed, SuggestionExpired} {
		if !ValidSuggestionStatus(status) {
			t.Fatalf("%s is a suggestion status", status)
		}
	}
	if ValidSuggestionStatus("nope") || SuggestionTargetLine("abc") != "line:abc" {
		t.Fatal("statuses and targets")
	}
	l := DefaultLimits().Suggestions
	for _, ok := range []string{"", " ", "{}", `{"a":1}`} {
		if _, err := SuggestionPayload([]byte(ok), l); err != nil {
			t.Fatalf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"[]", "1", "{", `{"a":"` + strings.Repeat("x", 5000) + `"}`} {
		if _, err := SuggestionPayload([]byte(bad), l); err == nil {
			t.Fatalf("%q must be refused", bad)
		}
	}
	if ErrSuggestionGone.Code != CodeSuggestionNotFound || ErrSuggestionNotOpen.Code != CodeSuggestionNotOpen {
		t.Fatal("suggestion codes")
	}
}

func TestNoteSourceLabels_MatchTheClient(t *testing.T) {
	zh, en := DefaultNoteSourceLabels(), EnglishNoteSourceLabels()
	cases := []struct {
		facts  NoteSourceFacts
		zh, en string
	}{
		{NoteSourceFacts{}, "", ""},
		{NoteSourceFacts{HasLine: true, OnRoot: true, MainNumber: 12}, "主線 #12", "Main line #12"},
		{NoteSourceFacts{HasLine: true, OnRoot: true}, "主線", "Main line"},
		{NoteSourceFacts{HasLine: true, Card: true, BranchKind: BranchKindInvestigate, BranchPurpose: "ECC"}, "結論卡・ECC", "Conclusion card · ECC"},
		{NoteSourceFacts{HasLine: true, BranchKind: BranchKindAside, BranchPurpose: "scrub"}, "順口問・scrub", "Aside · scrub"},
		{NoteSourceFacts{HasLine: true, BranchKind: BranchKindAlternative, BranchPurpose: "x"}, "另一條路・x", "Alternative · x"},
		{NoteSourceFacts{HasLine: true, BranchKind: BranchKindInvestigate, BranchPurpose: "x"}, "查證・x", "Investigate · x"},
		{NoteSourceFacts{HasLine: true, BranchKind: BranchKindAlternative, BranchOrigin: BranchOriginPreviousMainLine, BranchPurpose: "x"}, "另一條路・原本的主線", "Alternative · Previous main line"},
	}
	for _, c := range cases {
		if got := zh.Render(c.facts); got != c.zh {
			t.Errorf("zh %+v = %q, want %q", c.facts, got, c.zh)
		}
		if got := en.Render(c.facts); got != c.en {
			t.Errorf("en %+v = %q, want %q", c.facts, got, c.en)
		}
	}
	if got := (NoteSourceLabels{}).Render(NoteSourceFacts{HasLine: true, OnRoot: true}); got != "主線" {
		t.Fatalf("empty labels fall back to the defaults: %q", got)
	}
}
