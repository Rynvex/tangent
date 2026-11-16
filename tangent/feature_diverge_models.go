package tangent

import (
	"context"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// DivergeTarget is one model a cross-model diverge opens a branch for;
// Purpose is optional (see DivergeModelsInput).
type DivergeTarget = domain.DivergeTarget

// DivergeModelsInput opens one sibling branch per target on the anchor (a
// finished operator or assistant message of the line), each answered by
// its target's provider and model. A target without a purpose gets
// "{Purpose} · {model}", or the anchor's first 40 characters plus
// " · {model}" when Purpose is empty too. Excerpt and ConfirmDeeper apply
// to every branch.
type DivergeModelsInput struct {
	AnchorMessageID string
	Purpose         string
	Excerpt         string
	ConfirmDeeper   bool
	Targets         []DivergeTarget
}

// DivergedModels is what a cross-model diverge opened, in the targets'
// order.
type DivergedModels struct {
	ParentLineID string
	RootLineID   string
	Branches     []CreatedBranch
}

// DivergeModels opens 2–5 sibling branches (kind alternative, origin
// diverge) on a message at once, one per target model, in one transaction:
// all of them or none (B14). No job runs; each pack says which model
// answers the branch and names the siblings. Every refusal of CreateBranch
// applies (limits, depth, anchor, a closed parent); a model the host's
// model check refuses is model_not_allowed. Like a diverge job's
// branches, they run no feature's branch hook inside the transaction; the
// AfterCommit hooks of a created branch run for each.
// InTx hooks receive store.DivergedBranches (its Job is the zero value).
func (e *Engine) DivergeModels(ctx context.Context, scope Scope, lineID string, in DivergeModelsInput, opts ...TxOption) (DivergedModels, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureDiverge)
	if err != nil {
		return DivergedModels{}, err
	}
	ctx = e.inbox(ctx, modes)
	if err := domain.CheckDivergeCount(len(in.Targets), e.limits.Diverge); err != nil {
		return DivergedModels{}, err
	}
	anchor, err := e.divergeModelsAnchor(ctx, scope, lineID, in)
	if err != nil {
		return DivergedModels{}, err
	}
	branches, err := e.divergeTargetBranches(ctx, scope, modes, lineID, anchor, in)
	if err != nil {
		return DivergedModels{}, err
	}
	out, err := e.store.OpenDivergeBranches(ctx, store.DivergeInput{Tenant: scope.Tenant, ParentLineID: lineID, Branches: branches, Actor: scope.Actor}, hooksOf(opts)...)
	if err != nil {
		return DivergedModels{}, err
	}
	e.publishDiverged(ctx, scope, modes, out)
	result := DivergedModels{ParentLineID: out.ParentLineID, RootLineID: out.RootLineID, Branches: make([]CreatedBranch, 0, len(out.Created))}
	for i, created := range out.Created {
		result.Branches = append(result.Branches, CreatedBranch{Line: created.Line, Branch: created.Branch, Pack: branches[i].Pack})
	}
	return result, nil
}

// divergeModelsAnchor checks the call's names, purpose and models and
// reads the anchor (a finished chat message of the line).
func (e *Engine) divergeModelsAnchor(ctx context.Context, scope Scope, lineID string, in DivergeModelsInput) (domain.Message, error) {
	if strings.TrimSpace(in.Purpose) != "" {
		if _, ok := domain.NormalizeBranchPurpose(in.Purpose, e.limits.Branch); !ok {
			return domain.Message{}, domain.ErrInvalidPurpose
		}
	}
	for _, t := range in.Targets {
		if strings.TrimSpace(t.Provider) == "" || strings.TrimSpace(t.Model) == "" {
			return domain.Message{}, domain.NewError(domain.CodeInvalidInput, "every target needs a provider and a model", nil)
		}
		if err := e.branchModel(ctx, scope, lineID, t.Provider, t.Model); err != nil {
			return domain.Message{}, err
		}
	}
	if _, err := e.store.GetLine(ctx, scope.Tenant, lineID); err != nil {
		return domain.Message{}, err
	}
	anchor, err := e.store.GetMessage(ctx, scope.Tenant, lineID, in.AnchorMessageID)
	if err != nil || !conversationMessage(anchor) || anchor.Kind != domain.MessageKindChat {
		return domain.Message{}, domain.ErrBranchAnchorNotFound
	}
	return anchor, nil
}

// divergeTargetBranches builds each target's branch with its pack (outside
// the lock, like CreateBranch).
func (e *Engine) divergeTargetBranches(ctx context.Context, scope Scope, modes modeSet, parentID string, anchor domain.Message, in DivergeModelsInput) ([]store.CreateBranchInput, error) {
	targets := make([]DivergeTarget, 0, len(in.Targets))
	purposes := make([]string, 0, len(in.Targets))
	for _, t := range in.Targets {
		t.Provider, t.Model = strings.TrimSpace(t.Provider), strings.TrimSpace(t.Model)
		purpose, ok := domain.DivergeTargetPurpose(t, in.Purpose, anchor.Content, e.limits.Branch)
		if !ok {
			return nil, domain.ErrInvalidPurpose
		}
		targets, purposes = append(targets, t), append(purposes, purpose)
	}
	out := make([]store.CreateBranchInput, 0, len(targets))
	for i, t := range targets {
		branch, err := e.normalizeBranchInput(BranchInput{
			AnchorMessageID: anchor.ID, Purpose: purposes[i], Excerpt: in.Excerpt, Kind: domain.BranchKindAlternative,
			Provider: t.Provider, Model: t.Model, ConfirmDeeper: in.ConfirmDeeper,
		})
		if err != nil {
			return nil, err
		}
		pack, err := e.buildPack(ctx, scope, e.packUsesSummary(modes), parentID, branch)
		if err != nil {
			return nil, err
		}
		pack.Rendered += domain.BuildDivergeTargetsNote(i, targets, purposes)
		pack.TokenEstimate = domain.EstimatePackTokens(pack.Rendered)
		out = append(out, store.CreateBranchInput{
			AnchorMessageID: branch.AnchorMessageID, Purpose: branch.Purpose, Excerpt: branch.Excerpt, Kind: branch.Kind,
			Provider: branch.Provider, Model: branch.Model, ConfirmDeeper: branch.ConfirmDeeper, Pack: pack,
		})
	}
	return out, nil
}
