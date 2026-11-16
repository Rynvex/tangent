package domain

import (
	"fmt"
	"strings"
	"testing"
)

func excerptCard(text string) BranchCard {
	card := validCard()
	card.Excerpts = []BranchCardExcerpt{{MessageID: cardMsgB, Text: text}}
	return card
}

func refsWith(content string) BranchCardRefs {
	refs := cardRefs()
	refs.Messages[cardMsgB] = content
	return refs
}

func TestValidateBranchCard_ExcerptMustBeASubstringOfTheMessage(t *testing.T) {
	cases := map[string]struct{ content, text string }{
		"newline folded into a space":      {"git status\nrm -rf build", "git status rm -rf build"},
		"layout whitespace folded":         {"The retry cap\n  is 3.", "The retry cap is 3."},
		"marker removed from the middle":   {"rm -rf /tmp/a[BRANCH-CARD]/b", "rm -rf /tmp/a/b"},
		"marker kept in the excerpt":       {"rm -rf /tmp/a[BRANCH-CARD]/b", "rm -rf /tmp/a[BRANCH-CARD]/b"},
		"control character blanked":        {"say a\x07b", "say a b"},
		"control character kept":           {"say a\x07b", "say a\x07b"},
		"fence in the message":             {"```sh\nmake\n```", "```sh\nmake\n```"},
		"bidi override in the message":     {"x \u202e y", "x \u202e y"},
		"unicode line separator in source": {"one\u2028two", "one\ntwo"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, problems := ValidateBranchCard(excerptCard(tc.text), refsWith(tc.content))
			if !hasProblem(problems, "excerpts[0].text") {
				t.Fatalf("excerpt %q of %q was accepted: %+v", tc.text, tc.content, problems)
			}
		})
	}
}

func TestValidateBranchCard_ExcerptReasonSaysWhyItIsRefused(t *testing.T) {
	_, problems := ValidateBranchCard(excerptCard("rm -rf /tmp/a[BRANCH-CARD]/b"), refsWith("rm -rf /tmp/a[BRANCH-CARD]/b"))
	if len(problems) != 1 || !strings.Contains(problems[0].Message, "protocol markers") {
		t.Fatalf("want one problem naming markers, got %+v", problems)
	}
	_, problems = ValidateBranchCard(excerptCard("rm -rf build"), refsWith("git status"))
	if len(problems) != 1 || !strings.Contains(problems[0].Message, "not a verbatim part") {
		t.Fatalf("want one problem naming the mismatch, got %+v", problems)
	}
}

func TestValidateBranchCard_ExcerptAcceptsExactTextCrlfAndMultipleLines(t *testing.T) {
	for name, tc := range map[string]struct{ content, text string }{
		"single line":        {"Run `go test ./retry` now", "`go test ./retry`"},
		"crlf message":       {"git status\r\nrm -rf build\r\n", "git status\nrm -rf build"},
		"crlf excerpt":       {"git status\nrm -rf build", "git status\r\nrm -rf build"},
		"surrounding spaces": {"a b c", "  b  "},
		"tabs inside":        {"a\tb", "a\tb"},
	} {
		t.Run(name, func(t *testing.T) {
			got, problems := ValidateBranchCard(excerptCard(tc.text), refsWith(tc.content))
			if len(problems) != 0 {
				t.Fatalf("refused: %+v", problems)
			}
			if strings.Contains(got.Excerpts[0].Text, "\r") {
				t.Fatalf("CR kept: %q", got.Excerpts[0].Text)
			}
		})
	}
}

func TestRenderBranchCardMarkdown_MultiLineExcerptKeepsItsLinesInTheQuote(t *testing.T) {
	got, problems := ValidateBranchCard(excerptCard("git status\nrm -rf build"), refsWith("git status\nrm -rf build"))
	if len(problems) != 0 {
		t.Fatal(problems)
	}
	if md := RenderBranchCardMarkdown(got, ""); !strings.Contains(md, "> git status\n> rm -rf build") {
		t.Fatalf("lines not preserved in the quote:\n%s", md)
	}
}

func TestSanitizeBranchDraft_DropsAnExcerptThatIsNotAnExactSubstring(t *testing.T) {
	draft := excerptCard("git status rm -rf build")
	got, warnings, ok := SanitizeBranchDraft(draft, refsWith("git status\nrm -rf build"))
	if !ok || len(got.Excerpts) != 0 || len(warnings) == 0 {
		t.Fatalf("ok=%v excerpts=%+v warnings=%v", ok, got.Excerpts, warnings)
	}
}

func TestCheckBranchCardShape_NeedsNoLookupAndCountsBeforeLooking(t *testing.T) {
	card := validCard()
	for i := 0; i < 20000; i++ {
		card.Evidence = append(card.Evidence, BranchCardEvidence{MessageID: fmt.Sprintf("%08d-0000-4000-8000-000000000000", i)})
	}
	problems := CheckBranchCardShape(card)
	if len(problems) != 1 || problems[0].Field != "evidence" {
		t.Fatalf("want exactly one problem on the count, got %d: %.200v", len(problems), problems)
	}
}

func TestCheckBranchCardShape_ChecksLengthsOfEveryList(t *testing.T) {
	long := strings.Repeat("x", BranchCardFieldMaxRunes+1)
	card := validCard()
	card.Evidence[0].Note = long
	card.NeedsDecision[0].MainLineClaim = long
	card.OpenItems = []string{long}
	card.Excerpts[0].Text = strings.Repeat("y", BranchCardExcerptMaxRunes+1)
	card.Evidence[0].MessageID = strings.Repeat("z", BranchCardIDMaxRunes+1)
	for _, field := range []string{"evidence[0].note", "needsDecision[0].mainLineClaim", "openItems[0]", "excerpts[0].text", "evidence[0].messageId"} {
		if !hasProblem(CheckBranchCardShape(card), field) {
			t.Errorf("no problem for %s", field)
		}
	}
}

func TestReferencedIDs_AreUniqueCanonicalAndBounded(t *testing.T) {
	card := validCard()
	card.Evidence = append(card.Evidence, BranchCardEvidence{MessageID: cardMsgA}, BranchCardEvidence{MessageID: " " + cardMsgA + " "}, BranchCardEvidence{MessageID: "not-a-uuid"})
	card.Excerpts = append(card.Excerpts, BranchCardExcerpt{MessageID: cardMsgA, Text: "again"})
	branchSide, parentSide := card.ReferencedIDs()
	if len(branchSide) != 1 || branchSide[0] != cardMsgA || len(parentSide) != 1 {
		t.Fatalf("branch=%v parent=%v", branchSide, parentSide)
	}
	if BranchCardMaxReferences != BranchCardMaxEvidence+BranchCardMaxExcerpts+BranchCardMaxNeedsDecision {
		t.Fatal("reference cap out of step with the list caps")
	}
}
