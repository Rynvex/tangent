package domain

import (
	"fmt"
	"strings"
	"testing"
)

// Token baselines of the three prompts of a branch's life (open, card
// draft, leaf draft) on one long conversation. The numbers before G3 are in
// docs/devlog/G3-prompt-optimization.md; these tests pin the new bounds and
// that the head and the tail of the information survive.

func g3Conversation(prefix string, n, words int) []Message {
	out := []Message{}
	for i := 1; i <= n; i++ {
		role := RoleUser
		if i%2 == 0 {
			role = RoleAssistant
		}
		out = append(out, Message{
			ID: fmt.Sprintf("%08x-0000-4000-8000-%012d", len(prefix)*1000+i, i), Seq: int64(i), Role: role, Kind: MessageKindChat, Status: MessageDone,
			Content: fmt.Sprintf("%s-%02d %s", prefix, i, strings.Repeat("lorem ipsum dolor ", words/3)),
		})
	}
	return out
}

func TestG3Budget_BranchPack(t *testing.T) {
	main := g3Conversation("main", 20, 600)
	without := BuildBranchPack(BranchPackInput{Purpose: "check the retry loop", Messages: main})
	with := BuildBranchPack(BranchPackInput{Purpose: "check the retry loop", Excerpt: "retry cap is 3", Messages: main})
	t.Logf("pack tokens: without excerpt %d, with excerpt %d", without.TokenEstimate, with.TokenEstimate)
	if with.TokenEstimate*100 > without.TokenEstimate*65 {
		t.Fatalf("an excerpt pack must be at most 65%% of the full one: %d vs %d", with.TokenEstimate, without.TokenEstimate)
	}
	if with.AnchorMessageID != main[19].ID || !strings.Contains(with.Rendered, "> main-20") || !strings.Contains(with.Rendered, "> retry cap is 3") {
		t.Fatal("the anchor and the selection must be in the pack")
	}
	if !strings.Contains(with.Rendered, "main-17") {
		t.Fatal("the messages before the window are still named in the digests")
	}
}

func TestG3Budget_CardDraft(t *testing.T) {
	main := g3Conversation("main", 20, 600)
	pack := BuildBranchPack(BranchPackInput{Purpose: "check the retry loop", Excerpt: "retry cap is 3", Messages: main})
	branch := g3Conversation("branch", 12, 800)
	since := g3Conversation("since", 15, 400)
	in := BranchDraftInput{Purpose: "check the retry loop", Excerpt: "retry cap is 3", Anchor: &main[19], Pack: pack.Rendered, BranchMessages: branch, ParentSince: since}
	prompt := BuildBranchDraftPrompt(in)
	conversation := strings.Index(prompt, "## Branch conversation")
	head := EstimatePackTokens(prompt[:conversation])
	t.Logf("card draft tokens: total %d, head (instructions, purpose, start) %d", EstimatePackTokens(prompt), head)
	if head > 800 {
		t.Fatalf("the head before the branch conversation is %d tokens", head)
	}
	if strings.Contains(prompt, "## Branch background") || EstimatePackTokens(prompt) > BranchDraftInputTokenBudget {
		t.Fatal("the pack is not repeated and the prompt stays in budget")
	}
	// Head and tail: every branch message (B1 … B12) and the whole main line
	// since the fork (M1 … M10 as digests, M11 … M15 whole).
	for i := 1; i <= 12; i++ {
		if !strings.Contains(prompt, fmt.Sprintf("### [B%d] branch message", i)) {
			t.Fatalf("branch message B%d missing", i)
		}
	}
	for i := 1; i <= 15; i++ {
		whole, digest := fmt.Sprintf("### [M%d] main-line message", i), fmt.Sprintf("> [M%d] ", i)
		if (i > 10) != strings.Contains(prompt, whole) || (i <= 10) != strings.Contains(prompt, digest) {
			t.Fatalf("M%d is not shown as expected", i)
		}
	}

	short := BuildBranchDraftPrompt(BranchDraftInput{Purpose: "p", Pack: BuildBranchPack(BranchPackInput{Purpose: "p", Messages: main}).Rendered, BranchMessages: branch[:2]})
	shortHead := EstimatePackTokens(short[:strings.Index(short, "## Branch conversation")])
	t.Logf("card draft of a two-message branch without selection: head %d tokens", shortHead)
	if shortHead > branchDraftBackgroundTokens+800 {
		t.Fatalf("the fallback background is bounded: head %d", shortHead)
	}
}

func TestG3Budget_LeafDraft(t *testing.T) {
	messages := g3Conversation("leaf", 30, 600)
	prompt := BuildLeafDraftPrompt(LeafDraftInput{Purpose: "check the retry loop", Status: BranchStatusDiscarded, Messages: messages})
	t.Logf("leaf draft tokens: %d", EstimatePackTokens(prompt))
	if got := EstimatePackTokens(prompt); got > leafDraftInputTokenBudget+500 {
		t.Fatalf("leaf draft is %d tokens", got)
	}
	for _, want := range []string{"> leaf-01", "> leaf-27", "> leaf-30"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("leaf draft lacks %q", want)
		}
	}
}

func TestG3Budget_BranchRules(t *testing.T) {
	pack := BuildBranchPack(BranchPackInput{Purpose: "p", Messages: g3Conversation("main", 20, 600)}).Rendered
	main, _ := BuildPrompt(PromptInput{UserMessage: "go"}).section(SectionRules)
	for _, kind := range []string{"", BranchKindInvestigate, BranchKindAlternative} {
		rules, _ := BuildPrompt(PromptInput{UserMessage: "go", Branch: &BranchPromptInfo{Purpose: "check the retry loop", Pack: pack, Kind: kind}}).section(SectionRules)
		t.Logf("rules tokens, branch kind %q: %d (main line %d)", kind, EstimatePackTokens(rules.Body), EstimatePackTokens(main.Body))
		if EstimatePackTokens(rules.Body) >= EstimatePackTokens(main.Body)+EstimatePackTokens(branchRules(&BranchPromptInfo{Purpose: "check the retry loop", Kind: kind})) {
			t.Fatalf("a branch's rules must not carry the suggestion rule (kind %q)", kind)
		}
	}
}
