package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// UpdatedCard is what a card edit changed.
type UpdatedCard = store.UpdatedCard

// UpdateBranchCard replaces the conclusion card of a merged branch (B17).
// The card is checked as a merge checks it (invalid_card with every
// problem), rendered onto the same card message and marked undelivered,
// so the next turn of the line that holds it carries the edited card once,
// in the card notice. The branch's conclusion line follows, and so does its
// leaf while it is still the one the merge wrote from the card and the leaf
// feature is on. Nothing else derived from the old card is rewritten
// (memories, a rolling summary, a group summary, the pack of a branch
// opened on the card).
// It publishes message.updated, branch.changed{merged} and, when the leaf
// followed, leaf.changed.
// InTx hooks receive store.UpdatedCard.
func (e *Engine) UpdateBranchCard(ctx context.Context, scope Scope, lineID string, card domain.BranchCard, opts ...TxOption) (UpdatedCard, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return UpdatedCard{}, err
	}
	detail, err := e.store.GetBranch(ctx, scope.Tenant, lineID)
	if err != nil {
		return UpdatedCard{}, err
	}
	if detail.Branch.Status != domain.BranchStatusMerged || detail.Branch.CardMessageID == "" {
		return UpdatedCard{}, domain.ErrCardNotEditable
	}
	checked, err := e.checkedCard(ctx, scope, detail, card)
	if err != nil {
		return UpdatedCard{}, err
	}
	updated, err := e.store.UpdateBranchCard(ctx, store.UpdateBranchCardInput{
		Tenant: scope.Tenant, LineID: lineID, Card: checked, Content: domain.RenderBranchCardMarkdown(checked, detail.Branch.Purpose), Actor: scope.Actor,
		FollowLeaf: e.modesFor(ctx, scope).of(FeatureLeaf) != ModeOff,
	}, hooksOf(opts)...)
	if err != nil {
		return UpdatedCard{}, err
	}
	events := []Event{
		messageEvent(EventMessageUpdated, scope.Tenant, updated.RootLineID, updated.Message),
		branchEvent(scope.Tenant, BranchMerged, updated.Branch),
	}
	if leaf := updated.Leaf; leaf != nil {
		events = append(events, leafEvent(scope, leaf.LineID, leaf.RootLineID, leaf))
	}
	e.publish(ctx, events...)
	return updated, nil
}
