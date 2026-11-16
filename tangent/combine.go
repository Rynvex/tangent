package tangent

import (
	"cmp"
	"context"
	"slices"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// combineRecentMessages is how many of each branch's newest messages a
// combined branch's background reads.
const combineRecentMessages = 8

// CombineInput combines open sibling branches into one (the group
// feature): Purpose and Kind (investigate by default) are the new branch's;
// Conflicts are the ones the operator settled.
type CombineInput struct {
	LineIDs   []string
	Purpose   string
	Kind      string
	Conflicts []domain.Conflict
}

// CombinedBranches is a combine: the new branch (origin merge) with its
// pack, the branches it took (discarded, mergedIntoLineId set) and the
// notes keepBoth wrote.
type CombinedBranches struct {
	Created  CreatedBranch       `json:"created"`
	Combined []domain.BranchView `json:"combined"`
	// Reparented are the combined branches' open children, now hanging on
	// the new branch (anchors and depths unchanged), in id order.
	Reparented []string          `json:"reparented"`
	Notes      NotesWrite        `json:"notes"`
	Pack       domain.BranchPack `json:"-"`
}

// CombineBranches combines open branches of one parent into a new branch
// anchored on the newest of their anchors, and their open children are
// re-hung on it (keeping the message they forked from as their anchor). Its pack is the parent's
// background at that anchor plus each branch's purpose, leaf and newest
// messages, and what the operator settled. The old branches are discarded
// (open suggestions about them expire) in the same transaction.
// InTx hooks receive store.CombinedBranches.
func (e *Engine) CombineBranches(ctx context.Context, scope Scope, parentLineID string, in CombineInput, opts ...TxOption) (CombinedBranches, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureGroup)
	if err != nil {
		return CombinedBranches{}, err
	}
	ctx = e.inbox(ctx, modes)
	in.Kind = cmp.Or(strings.TrimSpace(in.Kind), domain.BranchKindInvestigate)
	settled, err := e.settle(ctx, scope, modes, in.LineIDs, in.Conflicts)
	if err != nil {
		return CombinedBranches{}, err
	}
	pack, anchor, err := e.combinedPack(ctx, scope, modes, parentLineID, in, settled)
	if err != nil {
		return CombinedBranches{}, err
	}
	var expired []domain.Suggestion
	expire := inTxFirst(func(ctx context.Context, tx store.Tx, _ any) (err error) {
		expired, err = store.ExpireSuggestions(ctx, tx, in.LineIDs)
		return err
	})
	branch := BranchInput{AnchorMessageID: anchor, Purpose: in.Purpose, Kind: in.Kind}
	call := newTxCall(modes, scope, commitBranchCreated, branch)
	out, err := e.store.CombineBranches(ctx, store.CombineInput{
		Tenant: scope.Tenant, ParentLineID: parentLineID, LineIDs: in.LineIDs, AnchorMessageID: anchor, Purpose: in.Purpose, Kind: in.Kind,
		Pack: pack, Notes: settled.notes, Actor: scope.Actor,
	}, e.txHooks(call, e.features.onBranchCreated, append([]TxOption{expire}, opts...))...)
	if err != nil {
		return CombinedBranches{}, err
	}
	e.publishCombined(ctx, scope, out, expired)
	e.dispatchOrphanJobs(ctx, e.commit(ctx, &commitEvent{kind: commitBranchCreated, scope: scope, modes: modes, change: BranchCreated, branch: &out.Created.Branch, out: call.out}))
	created := CreatedBranch{Line: out.Created.Line, Branch: out.Created.Branch, Pack: pack}
	return CombinedBranches{Created: created, Combined: out.Combined, Reparented: out.Reparented, Notes: out.Notes, Pack: pack}, nil
}

// publishCombined: the new branch's events, each old branch's
// branch.changed{discarded}, the re-hung children's branch.changed{moved}
// with the lines that lost them, the notes and the expired suggestions.
func (e *Engine) publishCombined(ctx context.Context, scope Scope, out store.CombinedBranches, expired []domain.Suggestion) {
	events := e.createdEvents(ctx, scope, out.Created.Line, out.Created.Branch)
	for _, old := range out.Combined {
		events = append(events, branchEvent(scope.Tenant, BranchDiscarded, old))
	}
	if len(out.Reparented) > 0 {
		events = append(events, e.branchEvents(ctx, scope, BranchMoved, out.Reparented)...)
		for _, old := range out.Combined {
			events = append(events, e.lineEvents(ctx, scope, old.LineID)...)
		}
	}
	events = append(events, notesEvents(scope, out.Notes)...)
	e.publish(ctx, append(events, e.suggestionEvents(ctx, scope, expired...)...)...)
}

// combinedPack builds the new branch's pack outside the lock and picks its
// anchor (the newest of the branches' anchors on the parent).
func (e *Engine) combinedPack(ctx context.Context, scope Scope, modes modeSet, parentLineID string, in CombineInput, settled settlement) (domain.BranchPack, string, error) {
	sources, anchor, err := e.combineSources(ctx, scope, parentLineID, in.LineIDs)
	if err != nil {
		return domain.BranchPack{}, "", err
	}
	branch, err := e.normalizeBranchInput(BranchInput{AnchorMessageID: anchor, Purpose: in.Purpose, Kind: in.Kind})
	if err != nil {
		return domain.BranchPack{}, "", err
	}
	pack, err := e.buildPack(ctx, scope, e.packUsesSummary(modes), parentLineID, branch)
	if err != nil {
		return domain.BranchPack{}, "", err
	}
	pack.Rendered += "\n" + domain.BuildCombinedBackground(domain.CombinedInput{
		Sources: sources, Settled: settled.settled, Open: settled.open, TokenBudget: e.limits.Group.CombineTokenBudget, ExtraMarkers: e.markers,
	})
	pack.TokenEstimate = domain.EstimatePackTokens(pack.Rendered)
	return pack, anchor, nil
}

// combineSources reads each branch (it must hang on the parent) and picks
// the newest anchor.
func (e *Engine) combineSources(ctx context.Context, scope Scope, parentLineID string, lineIDs []string) ([]domain.CombineSource, string, error) {
	if len(lineIDs) < 2 {
		return nil, "", domain.InvalidGroup("combine two or more branches")
	}
	sources := make([]domain.CombineSource, 0, len(lineIDs))
	anchor, newest := "", int64(-1)
	for _, id := range lineIDs {
		detail, err := e.store.GetBranch(ctx, scope.Tenant, id)
		if err != nil {
			return nil, "", err
		}
		if detail.Branch.ParentLineID != parentLineID {
			return nil, "", domain.InvalidGroup("only branches of the same parent are combined")
		}
		recent, err := e.store.RecentMessages(ctx, scope.Tenant, id, combineRecentMessages)
		if err != nil {
			return nil, "", err
		}
		source := domain.CombineSource{LineID: id, Purpose: detail.Branch.Purpose, Leaf: detail.Branch.ConclusionLine, Messages: conversationOnly(recent)}
		if detail.Branch.Leaf != nil {
			source.Leaf = detail.Branch.Leaf.Line
		}
		sources = append(sources, source)
		if at, err := e.store.GetMessage(ctx, scope.Tenant, parentLineID, detail.Branch.AnchorMessageID); err == nil && at.Seq > newest {
			anchor, newest = at.ID, at.Seq
		}
	}
	if anchor == "" {
		return e.parentFallbackAnchor(ctx, scope, parentLineID, sources)
	}
	return sources, anchor, nil
}

// errNoParentMessage: no source forked from a message on the parent (they
// were re-hung there by an earlier combine) and the parent has no finished
// message yet to hang the combined branch on.
var errNoParentMessage = domain.NewError(domain.CodeAnchorNotFound,
	"these branches were re-hung here by a combine and this line has no finished message yet to open the combined branch on; reply on it first", nil)

// parentFallbackAnchor is the parent's newest finished operator or
// assistant message (R8 E1: sources re-hung by a combine fork from messages
// of the branch they left, not of this parent).
func (e *Engine) parentFallbackAnchor(ctx context.Context, scope Scope, parentLineID string, sources []domain.CombineSource) ([]domain.CombineSource, string, error) {
	recent, err := e.store.RecentMessages(ctx, scope.Tenant, parentLineID, e.limits.HistoryScan)
	if err != nil {
		return nil, "", err
	}
	for _, message := range slices.Backward(recent) {
		if conversationMessage(message) {
			return sources, message.ID, nil
		}
	}
	return nil, "", errNoParentMessage
}
