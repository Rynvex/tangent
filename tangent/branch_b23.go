package tangent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// B23: what happens to an aside after its answer. It can be kept from the
// purge (KeepBranch), continued as an ordinary branch (ContinueAside) or
// deleted at once (DeleteBranch, which also deletes discarded branches).

// KeepBranch keeps an aside from the purge (keep) or lets the purge have it
// again (the aside feature). An aside that is still open may be kept before
// its answer. Released, it is purged when it would have been: its end plus
// the retention. It publishes branch.changed{kept} when the state changed;
// keeping a kept aside publishes nothing.
// InTx hooks receive store.KeptBranch.
func (e *Engine) KeepBranch(ctx context.Context, scope Scope, lineID string, keep bool, opts ...TxOption) (domain.BranchView, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureAside)
	if err != nil {
		return domain.BranchView{}, err
	}
	ctx = e.inbox(ctx, modes)
	kept, err := e.store.KeepBranch(ctx, scope.Tenant, lineID, keep, hooksOf(opts)...)
	if err != nil {
		return domain.BranchView{}, err
	}
	if kept.Changed {
		e.publish(ctx, branchEvent(scope.Tenant, BranchKept, kept.Branch))
	}
	return kept.Branch, nil
}

// ContinueAsideInput continues an answered aside as a branch. Purpose
// defaults to the aside's; Kind is investigate (the default) or
// alternative.
type ContinueAsideInput struct {
	Purpose       string
	Kind          string
	ConfirmDeeper bool
	HostMeta      json.RawMessage
}

// ContinuedAside is what continuing an aside changed.
type ContinuedAside = store.ContinuedAside

// ContinueAside turns an ended, answered aside into an ordinary open branch
// on the same anchor (the aside feature): a new branch is opened, the
// aside's finished messages move into it with their seq, and the aside is
// deleted. The ended aside is never reopened (branch states are final). The
// pack is an ordinary branch's, built outside the locks like CreateBranch's
// (an aside's own pack is smaller). The new branch keeps the aside's
// origin, excerpt, provider and model. Memos written on the aside stay in
// the tree without a node. The features' branch-created hooks run; the
// branch-closed ones do not (the aside is replaced, not ended).
// InTx hooks receive store.ContinuedAside.
func (e *Engine) ContinueAside(ctx context.Context, scope Scope, lineID string, in ContinueAsideInput, opts ...TxOption) (ContinuedAside, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureAside)
	if err != nil {
		return ContinuedAside{}, err
	}
	ctx = e.inbox(ctx, modes)
	storeIn, err := e.continueInput(ctx, scope, modes, lineID, in)
	if err != nil {
		return ContinuedAside{}, err
	}
	call := newTxCall(modes, scope, commitBranchCreated, in)
	out, err := e.store.ContinueAside(ctx, storeIn, e.txHooks(call, e.features.onBranchCreated, opts)...)
	if err != nil {
		return ContinuedAside{}, err
	}
	e.forgetLines(scope.Tenant, out.Gone.LineIDs, out.Gone.PendingJobIDs)
	e.publish(ctx, e.continuedEvents(ctx, scope, modes, out)...)
	e.dispatchOrphanJobs(ctx, e.commit(ctx, &commitEvent{kind: commitBranchCreated, scope: scope, modes: modes, change: BranchCreated, branch: &out.Branch, out: call.out}))
	return out, nil
}

// continueInput reads where the aside hangs and builds the new branch's
// pack from its parent, outside the locks; the store checks under its locks
// that the aside still hangs there.
func (e *Engine) continueInput(ctx context.Context, scope Scope, modes modeSet, lineID string, in ContinueAsideInput) (store.ContinueAsideInput, error) {
	kind, err := domain.NormalizeContinueKind(in.Kind)
	if err != nil {
		return store.ContinueAsideInput{}, err
	}
	detail, err := e.store.GetBranch(ctx, scope.Tenant, lineID)
	if err != nil {
		return store.ContinueAsideInput{}, err
	}
	aside := detail.Branch
	if aside.Kind != domain.BranchKindAside {
		return store.ContinueAsideInput{}, domain.ErrContinueNotAside
	}
	purpose := aside.Purpose
	if strings.TrimSpace(in.Purpose) != "" {
		var ok bool
		if purpose, ok = domain.NormalizeBranchPurpose(in.Purpose, e.limits.Branch); !ok {
			return store.ContinueAsideInput{}, domain.ErrInvalidPurpose
		}
	}
	pack, err := e.buildPack(ctx, scope, e.packUsesSummary(modes), aside.ParentLineID, BranchInput{
		AnchorMessageID: aside.AnchorMessageID, Purpose: purpose, Excerpt: aside.Excerpt, Kind: kind,
	})
	if err != nil {
		return store.ContinueAsideInput{}, err
	}
	return store.ContinueAsideInput{
		Tenant: scope.Tenant, LineID: lineID, Purpose: purpose, Kind: kind, ConfirmDeeper: in.ConfirmDeeper, CreatedBy: scope.Actor,
		ParentLineID: aside.ParentLineID, AnchorMessageID: aside.AnchorMessageID, Pack: pack, HostMeta: in.HostMeta,
	}, nil
}

// continuedEvents: the aside's line.deleted, then a new branch's events
// (its line, its parent's line, the branch), the aside's branches that now
// hang on it, and what the tree lost with the aside's line.
func (e *Engine) continuedEvents(ctx context.Context, scope Scope, modes modeSet, out ContinuedAside) []Event {
	events := []Event{linesDeletedEvent(scope.Tenant, out.RootLineID, out.ReplacedLineID, out.Gone.LineIDs)}
	events = append(events, e.createdEvents(ctx, scope, out.Line, out.Branch)...)
	events = append(events, e.branchEvents(ctx, scope, BranchMoved, out.Reparented)...)
	return append(events, e.goneEvents(ctx, scope, modes, out.Gone)...)
}

// DeletedBranch is what DeleteBranch removed, with the host data of every
// deleted line and message so the host can clean up what it keeps
// elsewhere.
type DeletedBranch = store.DeletedBranch

// DeleteBranch deletes one ended branch with every branch below it (core):
// an ended aside, or a discarded branch that is neither the previous main
// line nor combined into another branch (branch_not_deletable otherwise).
// The rest of the conversation stays, the markers that name the branch on
// its parent included; a main line is deleted with DeleteTree. An open
// branch below it, or one still answering, refuses with branch_busy. The
// runs of jobs that went with the lines are stopped.
// InTx hooks receive store.DeletedBranch (before the rows go).
func (e *Engine) DeleteBranch(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (DeletedBranch, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return DeletedBranch{}, err
	}
	modes := e.modesFor(ctx, scope)
	ctx = e.inbox(ctx, modes)
	deleted, err := e.store.DeleteBranch(ctx, scope.Tenant, lineID, hooksOf(opts)...)
	if err != nil {
		return DeletedBranch{}, err
	}
	e.forgetLines(scope.Tenant, deleted.LineIDs, deleted.PendingJobIDs)
	events := []Event{linesDeletedEvent(scope.Tenant, deleted.RootLineID, deleted.LineID, deleted.LineIDs)}
	events = append(events, e.goneEvents(ctx, scope, modes, deleted.LinesGone)...)
	lines := []string{deleted.ParentLineID}
	if deleted.RootLineID != deleted.ParentLineID {
		lines = append(lines, deleted.RootLineID)
	}
	e.publish(ctx, append(events, e.lineEvents(ctx, scope, lines...)...)...)
	return deleted, nil
}

// linesDeletedEvent is line.deleted for lines deleted out of a tree that
// stays: the envelope's line is the one that was asked for.
func linesDeletedEvent(tenant, rootLineID, lineID string, lineIDs []string) Event {
	return Event{
		Type: EventLineDeleted, Tenant: tenant, RootLineID: rootLineID, LineID: lineID,
		Data: LinesDeleted{RootLineID: rootLineID, LineIDs: lineIDs},
	}
}

// goneEvents are the events of what a tree lost with deleted lines: the
// links that ended on them (to each conversation a link touched; with
// relations or spinoff on), the groups they left (the group feature) and
// the suggestions that named them.
func (e *Engine) goneEvents(ctx context.Context, scope Scope, modes modeSet, gone store.LinesGone) []Event {
	var events []Event
	if modes.of(FeatureRelations) != ModeOff || modes.of(FeatureSpinoff) != ModeOff {
		for _, link := range gone.DeletedLinks {
			events = append(events, linkEvents(scope, link, true)...)
		}
	}
	if modes.of(FeatureGroup) != ModeOff {
		for _, group := range gone.Groups {
			events = append(events, groupEvent(scope.Tenant, group))
		}
	}
	return append(events, e.suggestionEvents(ctx, scope, gone.ExpiredSuggestions...)...)
}
