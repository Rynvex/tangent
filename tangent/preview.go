package tangent

import (
	"context"
	"strings"

	"github.com/Rynvex/tangent/domain"
)

// Keys of preview blocks that are not prompt sections.
const (
	PreviewSummary     = "summary"
	PreviewEarlier     = "earlier"
	PreviewHistory     = "history"
	PreviewUserMessage = "user_message"
)

// PreviewBlock is one rendered block of a prompt with its token estimate.
// Key is the section key, or one of the Preview* keys; Role is set on a
// history block.
type PreviewBlock struct {
	Key     string `json:"key"`
	Role    string `json:"role,omitempty"`
	Content string `json:"content"`
	Tokens  int    `json:"tokens"`
}

// Preview is the prompt the next turn of a line would send, block by block,
// in the order Prompt.Chat sends them (sections, summary, trailing
// sections, condensed history, history, the operator's message).
type Preview struct {
	Prompt      domain.Prompt  `json:"prompt"`
	Blocks      []PreviewBlock `json:"blocks"`
	TotalTokens int            `json:"totalTokens"`
	Provider    string         `json:"provider"`
	Model       string         `json:"model"`
	// EstimatedCostUSD is the prompt's input cost when the model has a price
	// (WithPricing); the reply's output is not included.
	EstimatedCostUSD *float64 `json:"estimatedCostUsd,omitempty"`
	// Budget is how the prompt's shared token budget was spent.
	Budget PromptBudget `json:"budget"`
	// Fisheye is what the fisheye context chose (nil while it is off).
	Fisheye *FisheyeReport `json:"fisheye,omitempty"`
	// Folds are the folds whose summaries stood for their messages (absent
	// without any).
	Folds []domain.AppliedFold `json:"folds,omitempty"`
	// Memories are the memories the prompt recalled (absent without any;
	// DESIGN §12: a turn's recalled memories show only here).
	Memories []domain.RecalledMemory `json:"memories,omitempty"`
}

// PreviewTurn builds the prompt the line's next turn would send with
// content as the operator's message, without writing anything.
func (e *Engine) PreviewTurn(ctx context.Context, scope Scope, lineID, content string) (Preview, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return Preview{}, err
	}
	line, err := e.store.GetLine(ctx, scope.Tenant, lineID)
	if err != nil {
		return Preview{}, err
	}
	src, err := e.previewSource(ctx, scope, line, strings.TrimSpace(content))
	if err != nil {
		return Preview{}, err
	}
	built, err := e.assemblePrompt(ctx, src)
	if err != nil {
		return Preview{}, err
	}
	prompt := built.prompt
	blocks := previewBlocks(prompt)
	total := 0
	for _, block := range blocks {
		total += block.Tokens
	}
	return Preview{
		Prompt: prompt, Blocks: blocks, TotalTokens: total, Provider: line.Provider, Model: line.Model,
		EstimatedCostUSD: e.estimateCost(line.Model, total), Budget: built.budget, Fisheye: built.fisheye, Folds: built.folds, Memories: built.memories,
	}, nil
}

// previewSource reads what the next turn would carry, as BeginTurn would
// choose it under the lock.
func (e *Engine) previewSource(ctx context.Context, scope Scope, line domain.LineView, content string) (promptSource, error) {
	cards, err := e.store.UndeliveredBranchCards(ctx, scope.Tenant, line.ID, e.limits.Branch.NoticeMaxPerTurn)
	if err != nil {
		return promptSource{}, err
	}
	return promptSource{scope: scope, modes: e.modesFor(ctx, scope), line: line, cards: cards, userMessage: content}, nil
}

// previewBlocks renders every block exactly as Prompt.Chat renders it.
func previewBlocks(p domain.Prompt) []PreviewBlock {
	blocks := []PreviewBlock{}
	add := func(key, role, content string) {
		if content != "" {
			blocks = append(blocks, PreviewBlock{Key: key, Role: role, Content: content, Tokens: domain.EstimateTokens(content)})
		}
	}
	for _, section := range p.Sections {
		add(section.Key, "", systemOf(domain.Prompt{Sections: []domain.PromptSection{section}}))
	}
	if p.Summary != nil {
		add(PreviewSummary, "", systemOf(domain.Prompt{Summary: p.Summary}))
	}
	for _, section := range p.Trailing {
		add(section.Key, "", systemOf(domain.Prompt{Trailing: []domain.PromptSection{section}}))
	}
	add(PreviewEarlier, "", systemOf(domain.Prompt{Earlier: p.Earlier}))
	for _, entry := range p.History {
		add(PreviewHistory, entry.Role, entry.Content)
	}
	add(PreviewUserMessage, domain.ChatRoleUser, strings.TrimSpace(p.UserMessage))
	return blocks
}

// systemOf renders the system part of a partial prompt.
func systemOf(p domain.Prompt) string {
	p.UserMessage = "-"
	system, _ := p.Chat()
	return system
}
