package tangent

import (
	"context"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Parking keeps thoughts for later (DESIGN §12 B8): a seed costs no tokens
// (no branch, no model call, never in a prompt). A seed is expanded into a
// branch (origin seed), written into the notes (needs notes) or dropped;
// each ends it for good. Off: the seed calls return feature_disabled;
// stored seeds are kept.
func Parking() Feature { return onOff(FeatureParking, nil) }

// SeedsChange is the data of seeds.changed.
type SeedsChange struct {
	RootLineID string `json:"rootLineId"`
}

// seedEvents are seeds.changed and the main line's line.updated (its open
// count changed).
func (e *Engine) seedEvents(ctx context.Context, scope Scope, rootLineID string) []Event {
	events := []Event{{Type: EventSeedsChanged, Tenant: scope.Tenant, RootLineID: rootLineID, LineID: rootLineID, Data: SeedsChange{RootLineID: rootLineID}}}
	return append(events, e.lineEvents(ctx, scope, rootLineID)...)
}

// SeedList is a conversation's seeds.
type SeedList = store.SeedList

// ListSeeds lists the seeds of the line's conversation, newest first;
// statuses default to open.
func (e *Engine) ListSeeds(ctx context.Context, scope Scope, lineID string, statuses []string) (SeedList, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureParking)
	if err != nil {
		return SeedList{}, err
	}
	wanted := make([]string, 0, len(statuses))
	for _, status := range statuses {
		status = strings.TrimSpace(status)
		if !domain.ValidSeedStatus(status) {
			return SeedList{}, domain.NewError(domain.CodeInvalidInput, "status must be open, expanded, noted or dropped", nil)
		}
		wanted = append(wanted, status)
	}
	return e.store.ListSeeds(ctx, store.SeedQuery{Tenant: scope.Tenant, LineID: lineID, Statuses: wanted})
}

// SeedInput parks a thought on a line; AnchorMessageID is optional (the
// line's newest chat message otherwise).
type SeedInput struct {
	Text            string
	AnchorMessageID string
}

// CreateSeed parks a thought.
// InTx hooks receive domain.Seed.
func (e *Engine) CreateSeed(ctx context.Context, scope Scope, lineID string, in SeedInput, opts ...TxOption) (domain.Seed, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureParking)
	if err != nil {
		return domain.Seed{}, err
	}
	ctx = e.inbox(ctx, modes)
	seed, err := e.store.CreateSeed(ctx, store.CreateSeedInput{
		Tenant: scope.Tenant, LineID: lineID, AnchorMessageID: in.AnchorMessageID, Text: in.Text, Actor: scope.Actor,
	}, hooksOf(opts)...)
	if err != nil {
		return domain.Seed{}, err
	}
	e.publish(ctx, e.seedEvents(ctx, scope, seed.RootLineID)...)
	return seed, nil
}

// SeedsInput parks several thoughts on a line at once (1 to
// domain.SeedBatchMax; an outline or a to-do list); AnchorMessageID is
// SeedInput's, shared by all of them.
type SeedsInput struct {
	Texts           []string
	AnchorMessageID string
}

// CreatedSeeds is what a batch parked, in the order of its texts.
type CreatedSeeds = store.CreatedSeeds

// CreateSeeds parks a batch of thoughts in one transaction, all or none:
// CreateSeed's refusals apply to each, and the open-seed cap counts the
// whole batch (seed_limit). One seeds.changed follows.
// InTx hooks receive store.CreatedSeeds.
func (e *Engine) CreateSeeds(ctx context.Context, scope Scope, lineID string, in SeedsInput, opts ...TxOption) (CreatedSeeds, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureParking)
	if err != nil {
		return CreatedSeeds{}, err
	}
	ctx = e.inbox(ctx, modes)
	created, err := e.store.CreateSeeds(ctx, store.CreateSeedsInput{
		Tenant: scope.Tenant, LineID: lineID, AnchorMessageID: in.AnchorMessageID, Texts: in.Texts, Actor: scope.Actor,
	}, hooksOf(opts)...)
	if err != nil {
		return CreatedSeeds{}, err
	}
	e.publish(ctx, e.seedEvents(ctx, scope, created.RootLineID)...)
	return created, nil
}

// DropSeed ends an open seed without doing anything with it.
// InTx hooks receive domain.Seed.
func (e *Engine) DropSeed(ctx context.Context, scope Scope, seedID string, opts ...TxOption) (domain.Seed, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureParking)
	if err != nil {
		return domain.Seed{}, err
	}
	ctx = e.inbox(ctx, modes)
	seed, err := e.store.DropSeed(ctx, scope.Tenant, seedID, hooksOf(opts)...)
	if err != nil {
		return domain.Seed{}, err
	}
	e.publish(ctx, e.seedEvents(ctx, scope, seed.RootLineID)...)
	return seed, nil
}

// NotedSeed is a seed written into the notes.
type NotedSeed = store.NotedSeed

// NoteSeed writes an open seed into the notes (section defaults to
// to_confirm); it needs the notes feature.
// InTx hooks receive store.NotedSeed.
func (e *Engine) NoteSeed(ctx context.Context, scope Scope, seedID, section string, opts ...TxOption) (NotedSeed, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureParking)
	if err != nil {
		return NotedSeed{}, err
	}
	ctx = e.inbox(ctx, modes)
	if err := requireFeature(modes, FeatureNotes); err != nil {
		return NotedSeed{}, err
	}
	noted, err := e.store.NoteSeed(ctx, store.NoteSeedInput{Tenant: scope.Tenant, SeedID: seedID, Section: section, Actor: scope.Actor}, hooksOf(opts)...)
	if err != nil {
		return NotedSeed{}, err
	}
	events := notesEvents(scope, noted.Notes)
	e.publish(ctx, append(events, e.seedEvents(ctx, scope, noted.Seed.RootLineID)...)...)
	return noted, nil
}

// ExpandInput opens a seed's branch: Purpose defaults to the seed's text
// (cut to the purpose limit), Kind to investigate.
type ExpandInput struct {
	Purpose       string
	Kind          string
	ConfirmDeeper bool
}

// ExpandedSeed is an expanded seed and its new branch.
type ExpandedSeed struct {
	Seed   domain.Seed
	Line   domain.LineView
	Branch domain.BranchView
	Pack   domain.BranchPack
}

// ExpandSeed opens a branch (origin seed) where the seed's anchor is now
// (or on the main line's newest message when the anchor is gone) and ends
// the seed in the same transaction. Every refusal of CreateBranch applies;
// the seed stays open when one does.
// InTx hooks receive store.ExpandedSeed.
func (e *Engine) ExpandSeed(ctx context.Context, scope Scope, seedID string, in ExpandInput, opts ...TxOption) (ExpandedSeed, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureParking)
	if err != nil {
		return ExpandedSeed{}, err
	}
	ctx = e.inbox(ctx, modes)
	plan, err := e.store.PlanSeedExpansion(ctx, scope.Tenant, seedID)
	if err != nil {
		return ExpandedSeed{}, err
	}
	branch, err := e.seedBranchInput(modes, plan, in)
	if err != nil {
		return ExpandedSeed{}, err
	}
	pack, err := e.buildPack(ctx, scope, e.packUsesSummary(modes), plan.ParentLineID, branch)
	if err != nil {
		return ExpandedSeed{}, err
	}
	call := newTxCall(modes, scope, commitBranchCreated, branch)
	expanded, err := e.store.ExpandSeed(ctx, store.ExpandSeedInput{SeedID: seedID, CreateBranchInput: store.CreateBranchInput{
		Tenant: scope.Tenant, ParentLineID: plan.ParentLineID, AnchorMessageID: branch.AnchorMessageID, Purpose: branch.Purpose,
		Kind: branch.Kind, CreatedBy: scope.Actor, ConfirmDeeper: branch.ConfirmDeeper, Pack: pack,
	}}, e.txHooks(call, e.features.onBranchCreated, opts)...)
	if err != nil {
		return ExpandedSeed{}, err
	}
	events := e.createdEvents(ctx, scope, expanded.Line, expanded.Branch)
	e.publish(ctx, append(events, e.seedEvents(ctx, scope, expanded.Seed.RootLineID)...)...)
	e.dispatchOrphanJobs(ctx, e.commit(ctx, &commitEvent{kind: commitBranchCreated, scope: scope, modes: modes, change: BranchCreated, branch: &expanded.Branch, out: call.out}))
	return ExpandedSeed{Seed: expanded.Seed, Line: expanded.Line, Branch: expanded.Branch, Pack: pack}, nil
}

// seedBranchInput is the branch a seed expands into, checked as
// CreateBranch checks its input (it inherits the parent's provider and
// model).
func (e *Engine) seedBranchInput(modes modeSet, plan store.SeedExpansion, in ExpandInput) (BranchInput, error) {
	branch := BranchInput{
		AnchorMessageID: plan.AnchorMessageID, Purpose: in.Purpose, Kind: strings.TrimSpace(in.Kind), ConfirmDeeper: in.ConfirmDeeper,
	}
	if strings.TrimSpace(branch.Purpose) == "" {
		branch.Purpose = domain.SeedPurpose(plan.Seed.Text, e.limits.Branch)
	}
	if branch.Kind == "" {
		branch.Kind = domain.BranchKindInvestigate
	}
	branch, err := e.normalizeBranchInput(branch)
	if err != nil {
		return BranchInput{}, err
	}
	if err := requireInput(modes, inputBranchKind(branch.Kind)); err != nil {
		return BranchInput{}, err
	}
	return branch, nil
}
