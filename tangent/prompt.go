package tangent

import (
	"context"
	"fmt"

	"github.com/Rynvex/tangent/domain"
)

// promptSource is what a turn prompt is built from. begun is nil for a
// preview.
type promptSource struct {
	scope       Scope
	modes       modeSet
	line        domain.LineView
	begun       *beginInfo
	cards       []domain.Message
	userMessage string
}

// assembledPrompt is a built prompt with how its budget was shared and,
// when the fisheye chose the history, what it chose.
type assembledPrompt struct {
	prompt   domain.Prompt
	budget   PromptBudget
	fisheye  *FisheyeReport
	folds    []domain.AppliedFold
	memories []domain.RecalledMemory
	asks     turnAsks
}

// assemblePrompt builds the structured prompt of a turn in the order the
// shared budget is spent: the fixed blocks (branch pack, origin capsule,
// undelivered cards), what the features' ContextProviders add, the host's
// sections, then the history (the HistorySelector's, or the newest
// HistoryScan messages) in what is left; the sections end up in the fixed
// cache-friendly order (DESIGN §12).
func (e *Engine) assemblePrompt(ctx context.Context, src promptSource) (assembledPrompt, error) {
	in := domain.PromptInput{
		UserMessage: src.userMessage, ExtraMarkers: e.markers, Limits: e.limits.History,
		// The rule asks for [BRANCH-SUGGEST] lines; only a feature that parses them puts it back.
		OmitBranchSuggestRules: true,
	}
	pc := &promptContext{scope: src.scope, modes: src.modes, line: src.line, begun: src.begun, in: &in, budget: newContextBudget(e.limits.Context.TokenBudget)}
	var err error
	if in.Branch, err = e.branchContext(ctx, src.scope, src.line); err != nil {
		return assembledPrompt{}, err
	}
	if src.line.Capsule != nil {
		in.OriginCapsule = src.line.Capsule.Rendered
	}
	in.Cards = e.cardNotices(ctx, src.scope, src.cards)
	pc.budget.spend(BudgetCore, domain.EstimateInputTokens(in))
	if err := e.provideContext(ctx, pc); err != nil {
		return assembledPrompt{}, err
	}
	if err := pc.budget.measured(BudgetHost, &in, func() error { return e.hostSections(ctx, src, &in) }); err != nil {
		return assembledPrompt{}, err
	}
	if err := e.chooseHistory(ctx, pc); err != nil {
		return assembledPrompt{}, err
	}
	in.RequestTopicSummary = domain.WantsTopicSummary(in, src.line.Title)
	prompt := arranged(domain.BuildPrompt(in))
	pc.budget.spend(BudgetHistory, historyTokens(prompt)+domain.EstimateTokens(in.BranchConclusions))
	asks := turnAsks{topic: in.RequestTopicSummary, chapterCut: in.AllowChapterCut && in.Branch == nil}
	if src.begun != nil {
		asks.userMessageID = src.begun.userID
	}
	if asks.topic {
		asks.seen = src.line.Title
		if in.Branch != nil {
			asks.seen = in.Branch.Purpose
		}
	}
	return assembledPrompt{prompt: prompt, budget: pc.budget.report, fisheye: pc.fisheye, folds: pc.folds, memories: pc.memories, asks: asks}, nil
}

// hostSections adds the host's PromptContributor sections.
func (e *Engine) hostSections(ctx context.Context, src promptSource, in *domain.PromptInput) error {
	if e.contributor == nil {
		return nil
	}
	host, err := e.contributor.Contribute(ctx, src.scope, src.line)
	if err != nil {
		return fmt.Errorf("prompt contributor: %w", err)
	}
	in.HostSections = append(in.HostSections, host...)
	return nil
}

// historyTokens is what a built prompt's history costs: the condensed
// paragraph and the verbatim entries.
func historyTokens(p domain.Prompt) int {
	total := domain.EstimateTokens(p.Earlier)
	for _, entry := range p.History {
		total += domain.EstimateTokens(entry.Content)
	}
	return total
}

// chooseHistory fills the history within what the budget left: the
// HistorySelector's when one is on, otherwise the newest HistoryScan
// messages before the turn, as the history rewriters left them.
func (e *Engine) chooseHistory(ctx context.Context, pc *promptContext) error {
	pc.historyBudget = pc.budget.grantHistory(e.limits.History.TokenBudget)
	pc.in.Limits.TokenBudget = pc.historyBudget
	if selected, err := e.selectHistory(ctx, pc); err != nil || selected {
		return err
	}
	limit, pendingID, userID := e.limits.HistoryScan, "", ""
	if pc.begun != nil {
		limit, pendingID, userID = limit+historyMargin, pc.begun.pendingID, pc.begun.userID
	}
	recent, err := e.store.RecentMessages(ctx, pc.scope.Tenant, pc.line.ID, limit)
	if err != nil {
		return err
	}
	pc.in.History, err = e.rewriteHistory(ctx, pc, domain.HistoryBeforeTurn(recent, pendingID, userID))
	return err
}

// branchContext is what a branch line adds to its prompt: its purpose and
// the stored pack (fixed once the branch exists). nil for a main line.
func (e *Engine) branchContext(ctx context.Context, scope Scope, line domain.LineView) (*domain.BranchPromptInfo, error) {
	if line.ConversationBranch == nil {
		return nil, nil
	}
	detail, err := e.store.GetBranch(ctx, scope.Tenant, line.ID)
	if err != nil {
		return nil, err
	}
	return &domain.BranchPromptInfo{
		Purpose: detail.Branch.Purpose, Pack: detail.Pack.Rendered, Aside: detail.Branch.Kind == domain.BranchKindAside, Kind: detail.Branch.Kind,
	}, nil
}

// cardNotices turns the cards a turn carries into notice items with the
// purpose of the branch each came from, read in one query. A card whose
// branch cannot be read is still shown, without a purpose.
func (e *Engine) cardNotices(ctx context.Context, scope Scope, cards []domain.Message) []domain.BranchCardNoticeItem {
	items := make([]domain.BranchCardNoticeItem, 0, len(cards))
	if len(cards) == 0 {
		return items
	}
	ids := make([]string, 0, len(cards))
	for _, message := range cards {
		ids = append(ids, message.Meta.BranchLineID)
	}
	purposes, err := e.store.BranchPurposes(ctx, scope.Tenant, ids)
	if err != nil {
		e.log.Warn("tangent: card purposes unavailable", "error", err)
	}
	for _, message := range cards {
		if message.Meta.Card != nil {
			items = append(items, domain.BranchCardNoticeItem{MessageID: message.ID, Purpose: purposes[message.Meta.BranchLineID], Card: *message.Meta.Card})
		}
	}
	return items
}

// stableSectionOrder is the order of the built-in sections that change
// rarely (DESIGN §12: rules → the goal → pack, or a spun-off line's origin
// capsule → notes → host sections → summary → card notice → recent history).
var stableSectionOrder = []string{
	domain.SectionInstructions, domain.SectionRules, domain.SectionGoal, domain.SectionBranchPack, domain.SectionOriginCapsule, domain.SectionNotes,
}

// trailingSections move behind the summary: they change from turn to turn
// (the card notice, the recalled memories, the [TOPIC] / [CHAPTER] rules),
// as branches end (the fisheye's conclusions) or as terms are saved (the
// glossary).
var trailingSections = map[string]bool{
	domain.SectionBranchConclusions: true, domain.SectionBranchCards: true, domain.SectionMemory: true, domain.SectionGlossary: true,
	domain.SectionReplyLines: true,
}

// arranged puts the sections in that order: the stable built-ins, then the
// host's in their own order; the card notice, the volatile built-ins and
// the host sections marked Trailing move behind the summary
// (Prompt.Trailing), keeping their relative order. BuildPrompt has already
// renamed a host section that used a built-in key to "host:<key>", so it
// stays among the host's.
func arranged(p domain.Prompt) domain.Prompt {
	out := make([]domain.PromptSection, 0, len(p.Sections))
	placed := map[int]bool{}
	for _, key := range stableSectionOrder {
		for i, section := range p.Sections {
			if section.Key == key && !placed[i] {
				out, placed[i] = append(out, section), true
			}
		}
	}
	trailing := append([]domain.PromptSection{}, p.Trailing...)
	for i, section := range p.Sections {
		switch {
		case placed[i]:
		case trailingSections[section.Key] || section.Trailing:
			trailing = append(trailing, section)
		default:
			out = append(out, section)
		}
	}
	p.Sections, p.Trailing = out, trailing
	return p
}
