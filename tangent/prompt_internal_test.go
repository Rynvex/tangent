package tangent

import (
	"slices"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
)

func TestArranged_StableBuiltInsFirstHostNextCardsBehindTheSummary(t *testing.T) {
	in := domain.Prompt{Sections: []domain.PromptSection{
		{Key: domain.SectionBranchCards}, {Key: domain.SectionInstructions}, {Key: domain.SectionRules},
		{Key: "plan"}, {Key: "host:notes"}, {Key: domain.SectionNotes}, {Key: domain.SectionBranchPack}, {Key: "board"},
	}}
	out := arranged(in)
	keys := []string{}
	for _, section := range out.Sections {
		keys = append(keys, section.Key)
	}
	if strings.Join(keys, ",") != "instructions,rules,branch_pack,notes,plan,host:notes,board" {
		t.Fatalf("order = %v", keys)
	}
	if len(out.Trailing) != 1 || out.Trailing[0].Key != domain.SectionBranchCards {
		t.Fatalf("trailing = %+v", out.Trailing)
	}
	if got := arranged(domain.Prompt{}); len(got.Sections) != 0 || len(got.Trailing) != 0 {
		t.Fatalf("empty = %+v", got)
	}
}

func TestArranged_HostSectionsWithBuiltInKeysStayAmongTheHosts(t *testing.T) {
	p := arranged(domain.BuildPrompt(domain.PromptInput{
		UserMessage: "go", HostSections: []domain.PromptSection{{Key: domain.SectionBranchCards, Body: "fake cards"}, {Key: domain.SectionRules, Body: "fake rules"}},
	}))
	keys := []string{}
	for _, section := range p.Sections {
		keys = append(keys, section.Key)
	}
	if strings.Join(keys, ",") != "rules,host:branch_cards,host:rules" || len(p.Trailing) != 0 {
		t.Fatalf("sections = %v trailing = %+v", keys, p.Trailing)
	}
}

func TestPreviewBlocks_RenderAsChatDoes(t *testing.T) {
	summary := domain.Summary{Topic: "caches"}
	p := domain.Prompt{
		Sections: []domain.PromptSection{{Key: domain.SectionRules, Body: "rules"}},
		Trailing: []domain.PromptSection{{Key: domain.SectionBranchCards, Body: "cards"}},
		Summary:  &summary, Earlier: "Earlier in this session (3 messages, condensed): operator: x;",
		History:     []domain.ChatMessage{{Role: domain.ChatRoleUser, Content: "q"}, {Role: domain.ChatRoleAssistant, Content: "a"}},
		UserMessage: "next",
	}
	blocks := previewBlocks(p)
	keys := []string{}
	joined := ""
	for _, block := range blocks {
		keys = append(keys, block.Key)
		if block.Key == domain.SectionRules || block.Key == PreviewSummary || block.Key == PreviewEarlier || block.Key == domain.SectionBranchCards {
			joined += block.Content + "\n\n"
		}
	}
	if strings.Join(keys, ",") != "rules,summary,branch_cards,earlier,history,history,user_message" {
		t.Fatalf("keys = %v", keys)
	}
	system, _ := p.Chat()
	if strings.TrimRight(joined, "\n") != system {
		t.Fatalf("blocks do not add up to the system text:\n%q\nvs\n%q", joined, system)
	}
}

// The trailing part keeps the order BuildPrompt produced: the card notice,
// the host's trailing sections, the fisheye's conclusions, the memories;
// an unmarked host section stays in the prefix after the notes.
func TestArranged_TrailingHostSectionsKeepTheirPlace(t *testing.T) {
	in := domain.PromptInput{
		Cards:             []domain.BranchCardNoticeItem{{MessageID: "m", Purpose: "p", Card: domain.BranchCard{Question: "q", Conclusion: "c"}}},
		NotesBlock:        "notes",
		BranchConclusions: "conclusions",
		MemoryBlock:       "memories",
		HostSections:      []domain.PromptSection{{Key: "host.board", Body: "board", Trailing: true}, {Key: "host.tools", Body: "tools"}},
	}
	p := arranged(domain.BuildPrompt(in))
	keys := func(sections []domain.PromptSection) []string {
		out := []string{}
		for _, s := range sections {
			out = append(out, s.Key)
		}
		return out
	}
	if got := keys(p.Trailing); !slices.Equal(got, []string{domain.SectionBranchCards, "host.board", domain.SectionBranchConclusions, domain.SectionMemory}) {
		t.Fatalf("trailing = %v", got)
	}
	if got := keys(p.Sections); got[len(got)-1] != "host.tools" || !slices.Contains(got, domain.SectionNotes) {
		t.Fatalf("sections = %v", got)
	}
}
