package tangent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// MoveInput moves the last Count messages of a line into a new branch of it.
// Kind defaults to investigate.
type MoveInput struct {
	Count         int
	Purpose       string
	Kind          string
	Provider      string
	Model         string
	ConfirmDeeper bool
	HostMeta      json.RawMessage
}

// MovedBranch is what a move changed.
type MovedBranch = store.MovedBranch

// MoveToBranch moves the tail of a line into a new branch. The pack is built
// under the lock, once the anchor (the newest message that stays) is known.
// Clients must reload the source's and the branch's messages afterwards:
// moved messages keep their seq.
// InTx hooks receive store.MovedBranch.
func (e *Engine) MoveToBranch(ctx context.Context, scope Scope, lineID string, in MoveInput, opts ...TxOption) (MovedBranch, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return MovedBranch{}, err
	}
	kind := strings.TrimSpace(in.Kind)
	if kind == "" {
		kind = domain.BranchKindInvestigate
	}
	purpose, ok := domain.NormalizeBranchPurpose(in.Purpose, e.limits.Branch)
	if !ok {
		return MovedBranch{}, domain.ErrInvalidPurpose
	}
	if err := e.branchModel(ctx, scope, lineID, in.Provider, in.Model); err != nil {
		return MovedBranch{}, err
	}
	modes := e.modesFor(ctx, scope)
	ctx = e.inbox(ctx, modes)
	if err := requireInput(modes, inputBranchKind(kind)); err != nil {
		return MovedBranch{}, err
	}
	withSummary := e.packUsesSummary(modes)
	call := newTxCall(modes, scope, commitBranchCreated, in)
	moved, err := e.store.MoveToBranch(ctx, store.MoveToBranchInput{
		CreateBranchInput: store.CreateBranchInput{
			Tenant: scope.Tenant, ParentLineID: lineID, Purpose: purpose, Kind: kind, Provider: in.Provider,
			Model: in.Model, CreatedBy: scope.Actor, ConfirmDeeper: in.ConfirmDeeper, HostMeta: in.HostMeta,
		},
		Count:     in.Count,
		BuildPack: func(base store.MovePackBase) domain.BranchPack { return e.movePack(base, purpose, kind, withSummary) },
	}, e.txHooks(call, e.features.onBranchCreated, opts)...)
	if err != nil {
		return MovedBranch{}, err
	}
	e.publish(ctx, e.moveEvents(ctx, scope, moved)...)
	e.dispatchOrphanJobs(ctx, e.commit(ctx, &commitEvent{kind: commitBranchCreated, scope: scope, modes: modes, change: BranchMoved, branch: &moved.Branch, out: call.out}))
	return moved, nil
}

// movePack builds a moved branch's pack from what stays on the source; the
// source's summary only when a feature lets summaries into packs.
func (e *Engine) movePack(base store.MovePackBase, purpose, kind string, withSummary bool) domain.BranchPack {
	in := domain.BranchPackInput{
		Aside: kind == domain.BranchKindAside, Purpose: purpose, Messages: base.Remaining,
		AnchorMessageID: base.Anchor.ID, ExtraMarkers: e.markers, Limits: e.limits.Pack,
	}
	if withSummary {
		in.Summary, in.SummaryUptoSeq = base.Summary, base.SummaryUptoSeq
	}
	return domain.BuildBranchPack(in)
}

// moveEvents: the new branch line, the marker on the source, the source
// line, the new branch and every branch that moved along with the messages.
func (e *Engine) moveEvents(ctx context.Context, scope Scope, moved MovedBranch) []Event {
	events := []Event{
		lineEvent(EventLineCreated, moved.Line),
		messageEvent(EventMessageCreated, scope.Tenant, moved.RootLineID, moved.Marker),
	}
	events = append(events, e.lineEvents(ctx, scope, moved.SourceLineID)...)
	events = append(events, branchEvent(scope.Tenant, BranchMoved, moved.Branch))
	return append(events, e.branchEvents(ctx, scope, BranchMoved, moved.Reparented)...)
}

// branchEvents re-reads branches after a commit (one query) and returns
// their branch.changed events; one that cannot be read is skipped.
func (e *Engine) branchEvents(ctx context.Context, scope Scope, change string, lineIDs []string) []Event {
	if len(lineIDs) == 0 {
		return nil
	}
	views, err := e.store.BranchViews(ctx, scope.Tenant, lineIDs)
	if err != nil {
		e.log.Warn("tangent: reload of changed branches failed", "lines", len(lineIDs), "error", err)
		return nil
	}
	events := make([]Event, 0, len(views))
	for _, view := range views {
		events = append(events, branchEvent(scope.Tenant, change, view))
	}
	return events
}

// PromotedBranch is what a promotion changed.
type PromotedBranch = store.PromotedBranch

// PromoteBranch makes a direct branch of the main line the main line. The
// main line keeps its id; its old tail becomes a discarded "previous main
// line" branch. Clients must reload the transcripts afterwards.
// InTx hooks receive store.PromotedBranch.
func (e *Engine) PromoteBranch(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (PromotedBranch, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return PromotedBranch{}, err
	}
	modes := e.modesFor(ctx, scope)
	ctx = e.inbox(ctx, modes)
	call := newTxCall(modes, scope, commitBranchClosed, nil)
	promoted, err := e.store.PromoteBranch(ctx, scope.Tenant, lineID, e.txHooks(call, e.features.onBranchClosed, opts)...)
	if err != nil {
		return PromotedBranch{}, err
	}
	events := e.lineEvents(ctx, scope, promoted.MainLineID, promoted.PromotedID)
	if previous, err := e.store.GetLine(ctx, scope.Tenant, promoted.PreviousID); err == nil {
		events = append(events, lineEvent(EventLineCreated, previous))
	}
	events = append(events, e.branchEvents(ctx, scope, BranchPromoted, []string{promoted.PromotedID})...)
	events = append(events, e.branchEvents(ctx, scope, BranchCreated, []string{promoted.PreviousID})...)
	events = append(events, e.branchEvents(ctx, scope, BranchMoved, promoted.Reparented)...)
	e.publish(ctx, events...)
	detail, err := e.store.GetBranch(ctx, scope.Tenant, promoted.PromotedID)
	if err != nil {
		e.log.Error("tangent: AfterCommit of a promotion skipped: the branch could not be read", "line", promoted.PromotedID, "error", err)
		return promoted, nil
	}
	ev := &commitEvent{kind: commitBranchClosed, scope: scope, modes: modes, change: BranchPromoted, branch: &detail.Branch, promoted: &promoted, out: call.out}
	e.dispatchOrphanJobs(ctx, e.commit(ctx, ev))
	return promoted, nil
}
