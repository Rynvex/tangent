package main

import (
	"context"
	"fmt"
	"slices"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// builtSample is a sample written through the Engine: each line's id and
// the reply id of each of its exchanges.
type builtSample struct {
	lines   map[string]string
	replies map[string][]string
}

// buildSample writes a sample as a conversation of the scope: the main
// line's exchanges and pins, every branch with its exchanges, then the
// branches' endings, the deepest first (a parent cannot end before its
// children are written).
func buildSample(ctx context.Context, e *tangent.Engine, scope tangent.Scope, s Sample) (builtSample, error) {
	out := builtSample{lines: map[string]string{}, replies: map[string][]string{}}
	main, err := e.CreateLine(ctx, scope, tangent.LineInput{Title: s.Title, Provider: "fake", Model: "fake-1"})
	if err != nil {
		return out, err
	}
	out.lines[mainLineName] = main.ID
	if out.replies[mainLineName], err = runExchanges(ctx, e, scope, main.ID, s.Main); err != nil {
		return out, err
	}
	for _, pin := range s.Pins {
		if _, err := e.PinMessage(ctx, scope, out.replies[mainLineName][pin], true); err != nil {
			return out, err
		}
	}
	for _, b := range s.Branches {
		if err := out.openBranch(ctx, e, scope, b); err != nil {
			return out, fmt.Errorf("branch %s: %w", b.Name, err)
		}
	}
	for _, b := range slices.Backward(s.Branches) {
		if err := endBranch(ctx, e, scope, out.lines[b.Name], b); err != nil {
			return out, fmt.Errorf("end %s: %w", b.Name, err)
		}
	}
	return out, nil
}

// runExchanges runs each exchange as a turn with the scripted reply and
// returns the replies' ids.
func runExchanges(ctx context.Context, e *tangent.Engine, scope tangent.Scope, lineID string, exchanges []Exchange) ([]string, error) {
	replies := make([]string, 0, len(exchanges))
	for _, ex := range exchanges {
		turn, err := e.BeginTurn(ctx, scope, lineID, tangent.TurnInput{Content: ex.User})
		if err != nil {
			return nil, err
		}
		if _, err := e.CompleteTurn(ctx, turn.ID, tangent.TurnResult{Content: ex.Assistant}); err != nil {
			return nil, err
		}
		replies = append(replies, turn.ID)
	}
	return replies, nil
}

// openBranch opens a branch on its parent's reply and runs its exchanges.
func (b *builtSample) openBranch(ctx context.Context, e *tangent.Engine, scope tangent.Scope, branch SampleBranch) error {
	created, err := e.CreateBranch(ctx, scope, b.lines[branch.Parent], tangent.BranchInput{
		AnchorMessageID: b.replies[branch.Parent][branch.At], Purpose: branch.Purpose, Kind: domain.BranchKindInvestigate, ConfirmDeeper: true,
	})
	if err != nil {
		return err
	}
	b.lines[branch.Name] = created.Line.ID
	b.replies[branch.Name], err = runExchanges(ctx, e, scope, created.Line.ID, branch.Exchanges)
	return err
}

// endBranch merges (with the card, then the sample's leaf over the card's),
// discards (with the leaf) or leaves the branch open.
func endBranch(ctx context.Context, e *tangent.Engine, scope tangent.Scope, lineID string, branch SampleBranch) error {
	var leaf *domain.LeafInput
	if branch.Leaf != nil {
		leaf = &domain.LeafInput{Kind: branch.Leaf.Kind, Line: branch.Leaf.Line}
	}
	switch branch.End {
	case endDiscard:
		_, err := e.DiscardBranchWith(ctx, scope, lineID, tangent.DiscardInput{Leaf: leaf})
		return err
	case endMerge:
		detail, err := e.GetBranch(ctx, scope, lineID)
		if err != nil {
			return err
		}
		card := domain.BranchCard{Question: branch.Card.Question, Conclusion: branch.Card.Conclusion}
		if _, err := e.MergeBranch(ctx, scope, lineID, tangent.MergeInput{Card: card, ParentTipMessageID: detail.ParentTipMessageID}); err != nil {
			return err
		}
		if leaf != nil {
			_, err = e.PutLeaf(ctx, scope, lineID, *leaf)
		}
		return err
	}
	return nil
}
