package tangent

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// MergeInput brings a branch back with a confirmed conclusion card.
// ParentTipMessageID is the newest parent message the operator saw
// (BranchDetail.ParentTipMessageID); ConfirmParentMoved accepts that the
// parent moved on since. NoteChanges (notes feature) are written in the same
// transaction; without the feature they are refused with feature_disabled.
type MergeInput struct {
	Card               domain.BranchCard
	ParentTipMessageID string
	ConfirmParentMoved bool
	NoteChanges        []domain.NoteChange
}

// MergedBranch is what a merge changed.
type MergedBranch = store.MergedBranch

// MergeBranch checks the card (shape first, then every message it cites),
// renders it and writes it as the parent's newest message while the branch
// closes. Invalid cards return invalid_card with every problem.
// InTx hooks receive store.MergedBranch.
func (e *Engine) MergeBranch(ctx context.Context, scope Scope, lineID string, in MergeInput, opts ...TxOption) (MergedBranch, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return MergedBranch{}, err
	}
	tip := strings.TrimSpace(in.ParentTipMessageID)
	if _, err := uuid.Parse(tip); err != nil {
		return MergedBranch{}, domain.ErrBranchParentTipUnknown
	}
	detail, err := e.store.GetBranch(ctx, scope.Tenant, lineID)
	if err != nil {
		return MergedBranch{}, err
	}
	if detail.Branch.Status != domain.BranchStatusOpen {
		return MergedBranch{}, domain.ErrBranchClosed
	}
	modes := e.modesFor(ctx, scope)
	ctx = e.inbox(ctx, modes)
	if len(in.NoteChanges) > 0 {
		if err := requireInput(modes, inputNoteChanges); err != nil {
			return MergedBranch{}, err
		}
	}
	card, err := e.checkedCard(ctx, scope, detail, in.Card)
	if err != nil {
		return MergedBranch{}, err
	}
	call := newTxCall(modes, scope, commitBranchClosed, in)
	merged, err := e.store.MergeBranch(ctx, store.MergeBranchInput{
		Tenant: scope.Tenant, LineID: lineID, Card: card, Content: domain.RenderBranchCardMarkdown(card, detail.Branch.Purpose),
		ParentTipMessageID: tip, ConfirmParentMoved: in.ConfirmParentMoved, NoteChanges: in.NoteChanges, Actor: scope.Actor,
	}, e.txHooks(call, e.features.onBranchClosed, opts)...)
	if err != nil {
		return MergedBranch{}, err
	}
	merged.Branch = e.reloadBranch(ctx, scope, merged.Branch)
	events := []Event{
		messageEvent(EventMessageCreated, scope.Tenant, merged.RootLineID, merged.Card),
		branchEvent(scope.Tenant, BranchMerged, merged.Branch),
	}
	e.publish(ctx, append(events, e.lineEvents(ctx, scope, merged.ParentLineID, merged.Branch.LineID)...)...)
	ev := &commitEvent{kind: commitBranchClosed, scope: scope, modes: modes, change: BranchMerged, branch: &merged.Branch, merged: &merged, request: in, out: call.out}
	e.dispatchOrphanJobs(ctx, e.commit(ctx, ev))
	return merged, nil
}

// checkedCard validates a confirmed card: counts and lengths first (nothing
// is looked up for a card that is too big), then the messages it cites.
func (e *Engine) checkedCard(ctx context.Context, scope Scope, detail domain.BranchDetail, card domain.BranchCard) (domain.BranchCard, error) {
	if problems := domain.CheckBranchCardShape(card); len(problems) > 0 {
		return domain.BranchCard{}, domain.CardError(problems)
	}
	refs, err := e.cardRefs(ctx, scope, detail, card)
	if err != nil {
		return domain.BranchCard{}, err
	}
	checked, problems := domain.ValidateBranchCard(card, refs)
	if len(problems) > 0 {
		return domain.BranchCard{}, domain.CardError(problems)
	}
	return checked, nil
}

// cardRefs loads exactly the messages a card cites (at most
// BranchCardMaxReferences). Branch-side ids must be finished operator or
// assistant messages of the branch, or parent messages quoted in its pack;
// parent-side ids must be relevant parent messages after the anchor (by seq).
func (e *Engine) cardRefs(ctx context.Context, scope Scope, detail domain.BranchDetail, card domain.BranchCard) (domain.BranchCardRefs, error) {
	refs := domain.BranchCardRefs{Messages: map[string]string{}, ParentAfterAnchor: map[string]bool{}}
	packIDs := map[string]bool{}
	for _, recent := range detail.Pack.Recent {
		packIDs[recent.ID] = true
	}
	branchIDs, parentIDs := card.CappedReferencedIDs()
	for _, id := range branchIDs {
		content, found, err := e.citable(ctx, scope, detail.Branch.LineID, id)
		if err == nil && !found && packIDs[id] {
			content, found, err = e.citable(ctx, scope, detail.Branch.ParentLineID, id)
		}
		if err != nil {
			return refs, err
		}
		if found {
			refs.Messages[id] = content
		}
	}
	return refs, e.parentAfterAnchor(ctx, scope, detail.Branch, parentIDs, &refs)
}

// citable returns the content of a finished operator or assistant message
// of the line; found is false for any other id.
func (e *Engine) citable(ctx context.Context, scope Scope, lineID, id string) (string, bool, error) {
	message, err := e.store.GetMessage(ctx, scope.Tenant, lineID, id)
	if errors.Is(err, domain.ErrMessageNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if message.Status != domain.MessageDone || (message.Role != domain.RoleUser && message.Role != domain.RoleAssistant) {
		return "", false, nil
	}
	return message.Content, true, nil
}

// parentAfterAnchor marks which ids are finished parent messages (operator,
// assistant or card) written after the anchor.
func (e *Engine) parentAfterAnchor(ctx context.Context, scope Scope, view domain.BranchView, ids []string, refs *domain.BranchCardRefs) error {
	if len(ids) == 0 {
		return nil
	}
	anchor, err := e.store.GetMessage(ctx, scope.Tenant, view.ParentLineID, view.AnchorMessageID)
	if errors.Is(err, domain.ErrMessageNotFound) {
		return nil // the anchor moved away: nothing can be "after" it
	}
	if err != nil {
		return err
	}
	for _, id := range ids {
		message, err := e.store.GetMessage(ctx, scope.Tenant, view.ParentLineID, id)
		if errors.Is(err, domain.ErrMessageNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		relevant := message.Role != domain.RoleSystem || message.IsCard()
		if message.Status == domain.MessageDone && relevant && message.Seq > anchor.Seq {
			refs.ParentAfterAnchor[id] = true
		}
	}
	return nil
}
