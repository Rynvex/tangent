package tangent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// BranchInput opens a branch on a finished message of the parent line.
// Provider and Model default to the parent's. SuggestionMessageID names the
// assistant message whose [BRANCH-SUGGEST] the operator accepted; purpose
// and kind must match one of its suggestions. IncludeLater adds what the
// parent did after the anchor to the pack.
type BranchInput struct {
	AnchorMessageID     string
	Purpose             string
	Excerpt             string
	Kind                string
	Provider            string
	Model               string
	ConfirmDeeper       bool
	IncludeLater        bool
	SuggestionMessageID string
	HostMeta            json.RawMessage
	// Keep keeps a new aside from the purge from the start (B23); with any
	// other kind it is invalid_input (field keep).
	Keep bool
}

// CreatedBranch is a new branch: its line, its outline row and its pack.
type CreatedBranch struct {
	Line   domain.LineView   `json:"line"`
	Branch domain.BranchView `json:"branch"`
	Pack   domain.BranchPack `json:"pack"`
}

// CreateBranch opens a branch. The pack is built outside the lock from the
// parent's messages up to the anchor; the transaction re-checks the anchor
// and the limits.
// InTx hooks receive store.CreatedBranch.
func (e *Engine) CreateBranch(ctx context.Context, scope Scope, parentLineID string, in BranchInput, opts ...TxOption) (CreatedBranch, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return CreatedBranch{}, err
	}
	if in, err = e.normalizeBranchInput(in); err != nil {
		return CreatedBranch{}, err
	}
	modes := e.modesFor(ctx, scope)
	ctx = e.inbox(ctx, modes)
	if err := requireInput(modes, inputBranchKind(in.Kind)); err != nil {
		return CreatedBranch{}, err
	}
	if err := e.branchModel(ctx, scope, parentLineID, in.Provider, in.Model); err != nil {
		return CreatedBranch{}, err
	}
	origin, err := e.branchOrigin(ctx, scope, modes, parentLineID, &in)
	if err != nil {
		return CreatedBranch{}, err
	}
	pack, err := e.buildPack(ctx, scope, e.packUsesSummary(modes), parentLineID, in)
	if err != nil {
		return CreatedBranch{}, err
	}
	call := newTxCall(modes, scope, commitBranchCreated, in)
	created, err := e.store.CreateBranch(ctx, store.CreateBranchInput{
		Tenant: scope.Tenant, ParentLineID: parentLineID, AnchorMessageID: in.AnchorMessageID, Purpose: in.Purpose,
		Excerpt: in.Excerpt, Kind: in.Kind, Origin: origin, Provider: in.Provider, Model: in.Model, CreatedBy: scope.Actor,
		ConfirmDeeper: in.ConfirmDeeper, Pack: pack, HostMeta: in.HostMeta, Keep: in.Keep,
	}, e.txHooks(call, e.features.onBranchCreated, opts)...)
	if err != nil {
		return CreatedBranch{}, err
	}
	e.publish(ctx, e.createdEvents(ctx, scope, created.Line, created.Branch)...)
	e.dispatchOrphanJobs(ctx, e.commit(ctx, &commitEvent{kind: commitBranchCreated, scope: scope, modes: modes, change: BranchCreated, branch: &created.Branch, out: call.out}))
	return CreatedBranch{Line: created.Line, Branch: created.Branch, Pack: pack}, nil
}

// normalizeBranchInput checks purpose, excerpt and kind before anything is
// read, so the pack is built from what the store will keep.
func (e *Engine) normalizeBranchInput(in BranchInput) (BranchInput, error) {
	purpose, ok := domain.NormalizeBranchPurpose(in.Purpose, e.limits.Branch)
	if !ok {
		return in, domain.ErrInvalidPurpose
	}
	excerpt, ok := domain.NormalizeBranchExcerpt(in.Excerpt, e.limits.Branch)
	if !ok {
		return in, domain.ErrInvalidExcerpt
	}
	if !domain.ValidBranchKind(in.Kind) {
		return in, domain.ErrKindUnsupported
	}
	if in.Keep && in.Kind != domain.BranchKindAside {
		return in, domain.ErrKeepNeedsAside
	}
	in.Purpose, in.Excerpt, in.AnchorMessageID = purpose, excerpt, strings.TrimSpace(in.AnchorMessageID)
	return in, nil
}

// branchOrigin decides how the branch was opened: from an accepted
// suggestion, from selected text, or from a button.
func (e *Engine) branchOrigin(ctx context.Context, scope Scope, modes modeSet, parentLineID string, in *BranchInput) (string, error) {
	if strings.TrimSpace(in.SuggestionMessageID) != "" {
		if err := requireInput(modes, inputSuggestion); err != nil {
			return "", err
		}
		return domain.BranchOriginSuggestion, e.acceptSuggestion(ctx, scope, parentLineID, in)
	}
	if strings.TrimSpace(in.Excerpt) != "" {
		return domain.BranchOriginSelection, nil
	}
	return domain.BranchOriginButton, nil
}

// buildPack builds the branch's background from the parent's messages up to
// the anchor (and after it, with IncludeLater) and its rolling summary. The
// anchor may be a conclusion card (a follow-up on it): the card is quoted
// last.
func (e *Engine) buildPack(ctx context.Context, scope Scope, withSummary bool, parentLineID string, in BranchInput) (domain.BranchPack, error) {
	parent, err := e.store.GetLine(ctx, scope.Tenant, parentLineID)
	if err != nil {
		return domain.BranchPack{}, err
	}
	messages, err := e.store.MessagesUpToAnchor(ctx, scope.Tenant, parent.ID, in.AnchorMessageID)
	if errors.Is(err, domain.ErrMessageNotFound) {
		return domain.BranchPack{}, domain.ErrBranchAnchorNotFound
	}
	if err != nil {
		return domain.BranchPack{}, err
	}
	packIn := domain.BranchPackInput{
		Aside: in.Kind == domain.BranchKindAside, Purpose: in.Purpose, Excerpt: in.Excerpt, Messages: messages,
		AnchorMessageID: in.AnchorMessageID, CardAnchor: true, ExtraMarkers: e.markers, Limits: e.limits.Pack,
	}
	if withSummary {
		packIn.Summary, packIn.SummaryUptoSeq = parent.Summary, parent.SummaryUptoSeq
	}
	if in.IncludeLater {
		if packIn.Later, err = e.store.MessagesAfterAnchor(ctx, scope.Tenant, parent.ID, in.AnchorMessageID); err != nil {
			return domain.BranchPack{}, err
		}
		packIn.IncludeLater = true
	}
	if err := packIn.Check(); err != nil {
		return domain.BranchPack{}, err
	}
	return domain.BuildBranchPack(packIn), nil
}

// ListBranches returns the outline of the line's whole tree, oldest first;
// asides only when asked.
func (e *Engine) ListBranches(ctx context.Context, scope Scope, lineID string, includeAside bool) ([]domain.BranchView, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return nil, err
	}
	return e.store.ListBranches(ctx, scope.Tenant, lineID, includeAside)
}

// GetBranch reads one branch: outline row, pack, draft and the parent's tip
// (the parentTipMessageId a merge names).
func (e *Engine) GetBranch(ctx context.Context, scope Scope, lineID string) (domain.BranchDetail, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return domain.BranchDetail{}, err
	}
	return e.store.GetBranch(ctx, scope.Tenant, lineID)
}

// reloadBranch re-reads a branch after its write committed, so its view
// shows what the features' hooks wrote in the same transaction (a leaf);
// the store's view stays when the read fails.
func (e *Engine) reloadBranch(ctx context.Context, scope Scope, view domain.BranchView) domain.BranchView {
	views, err := e.store.BranchViews(ctx, scope.Tenant, []string{view.LineID})
	if err != nil || len(views) != 1 {
		e.log.Warn("tangent: reload of a closed branch failed", "line", view.LineID, "error", err)
		return view
	}
	return views[0]
}

// createdEvents are a new branch's: its line, its parent's line and the
// branch.
func (e *Engine) createdEvents(ctx context.Context, scope Scope, line domain.LineView, branch domain.BranchView) []Event {
	events := []Event{lineEvent(EventLineCreated, line)}
	events = append(events, e.lineEvents(ctx, scope, branch.ParentLineID)...)
	return append(events, branchEvent(scope.Tenant, BranchCreated, branch))
}

// DiscardInput ends a branch without bringing anything back. Leaf (the leaf
// feature) is written as the branch's leaf in the same transaction; its kind
// defaults to dead_end. Without the feature it is refused with
// feature_disabled.
type DiscardInput struct {
	Leaf *domain.LeafInput
}

// DiscardBranch ends a branch without bringing anything back.
// InTx hooks receive domain.BranchView.
func (e *Engine) DiscardBranch(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (domain.BranchView, error) {
	return e.DiscardBranchWith(ctx, scope, lineID, DiscardInput{}, opts...)
}

// DiscardBranchWith is DiscardBranch with the input of features (a dead-end
// leaf).
func (e *Engine) DiscardBranchWith(ctx context.Context, scope Scope, lineID string, in DiscardInput, opts ...TxOption) (domain.BranchView, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return domain.BranchView{}, err
	}
	modes := e.modesFor(ctx, scope)
	ctx = e.inbox(ctx, modes)
	if in.Leaf != nil {
		if err := requireInput(modes, inputDiscardLeaf); err != nil {
			return domain.BranchView{}, err
		}
	}
	call := newTxCall(modes, scope, commitBranchClosed, in)
	view, err := e.store.DiscardBranch(ctx, scope.Tenant, lineID, e.txHooks(call, e.features.onBranchClosed, opts)...)
	if err != nil {
		return domain.BranchView{}, err
	}
	view = e.reloadBranch(ctx, scope, view)
	events := []Event{branchEvent(scope.Tenant, BranchDiscarded, view)}
	e.publish(ctx, append(events, e.lineEvents(ctx, scope, view.ParentLineID, view.LineID)...)...)
	ev := &commitEvent{kind: commitBranchClosed, scope: scope, modes: modes, change: BranchDiscarded, branch: &view, request: in, out: call.out}
	e.dispatchOrphanJobs(ctx, e.commit(ctx, ev))
	return view, nil
}
