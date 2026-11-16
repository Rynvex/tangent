package tangent

import (
	"context"
	"errors"
	"strings"

	"github.com/Rynvex/tangent/domain"
)

// RenameBranch changes the purpose of an open branch (its line's title
// follows) and publishes branch.changed{renamed} and the branch line's
// line.updated. The pack keeps the purpose it was built with.
// InTx hooks receive domain.BranchView.
func (e *Engine) RenameBranch(ctx context.Context, scope Scope, lineID, purpose string, opts ...TxOption) (domain.BranchView, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return domain.BranchView{}, err
	}
	ctx = e.inboxFor(ctx, scope)
	view, err := e.store.RenameBranch(ctx, scope.Tenant, lineID, purpose, hooksOf(opts)...)
	if err != nil {
		return domain.BranchView{}, err
	}
	e.publish(ctx, append([]Event{branchEvent(scope.Tenant, BranchRenamed, view)}, e.lineEvents(ctx, scope, view.LineID)...)...)
	return view, nil
}

// BranchPreview is the background a new branch would start from, built as
// CreateBranch builds it, without writing anything. Text is the pack's
// rendered text (what the model receives); TokenEstimate its size.
type BranchPreview struct {
	Pack          domain.BranchPack `json:"pack"`
	Text          string            `json:"text"`
	TokenEstimate int               `json:"tokenEstimate"`
}

// PreviewBranch builds the pack CreateBranch would build for the same
// input (anchor, kind, excerpt, purpose, includeLater) and writes nothing.
// The purpose may still be empty. It refuses what CreateBranch would refuse
// about the input and the anchor; the limits are checked only by
// CreateBranch.
func (e *Engine) PreviewBranch(ctx context.Context, scope Scope, parentLineID string, in BranchInput) (BranchPreview, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return BranchPreview{}, err
	}
	if in, err = e.normalizePreviewInput(in); err != nil {
		return BranchPreview{}, err
	}
	modes := e.modesFor(ctx, scope)
	if err := requireInput(modes, inputBranchKind(in.Kind)); err != nil {
		return BranchPreview{}, err
	}
	if err := e.requirePreviewAnchor(ctx, scope, parentLineID, in.AnchorMessageID); err != nil {
		return BranchPreview{}, err
	}
	pack, err := e.buildPack(ctx, scope, e.packUsesSummary(modes), parentLineID, in)
	if err != nil {
		return BranchPreview{}, err
	}
	return BranchPreview{Pack: pack, Text: pack.Rendered, TokenEstimate: pack.TokenEstimate}, nil
}

// normalizePreviewInput is normalizeBranchInput that lets the purpose be
// empty (a dialog previews before the operator names the branch).
func (e *Engine) normalizePreviewInput(in BranchInput) (BranchInput, error) {
	if strings.TrimSpace(in.Purpose) != "" {
		return e.normalizeBranchInput(in)
	}
	in.Purpose = "-"
	in, err := e.normalizeBranchInput(in)
	in.Purpose = ""
	return in, err
}

// requirePreviewAnchor refuses an anchor that is not a finished operator or
// assistant message of the parent, or a conclusion card on it (as the store
// does when it creates).
func (e *Engine) requirePreviewAnchor(ctx context.Context, scope Scope, parentLineID, anchorID string) error {
	if _, err := e.store.GetLine(ctx, scope.Tenant, parentLineID); err != nil {
		return err
	}
	anchor, err := e.store.GetMessage(ctx, scope.Tenant, parentLineID, anchorID)
	if errors.Is(err, domain.ErrMessageNotFound) {
		return domain.ErrBranchAnchorNotFound
	}
	if err != nil {
		return err
	}
	if !domain.CanAnchorBranch(anchor.Role, anchor.Kind, anchor.Status) {
		return domain.ErrBranchAnchorNotFound
	}
	return nil
}

// ModelGroup is one provider and the models a host lets conversations pick
// (GET /capabilities lists them). Ready, Reason and Details are optional
// (zero values are left out of the JSON, so an older host's catalog looks
// as it did).
type ModelGroup struct {
	Provider string   `json:"provider"`
	Models   []string `json:"models"`
	// Ready says whether the provider can run now (for example a CLI found
	// on this machine); nil when the host does not say.
	Ready *bool `json:"ready,omitempty"`
	// Reason says why the provider is not ready (for example "binary not
	// found"); empty when it is ready or the host does not say.
	Reason string `json:"reason,omitempty"`
	// Details describe some of Models (in any order); a model without one
	// shows by its name.
	Details []ModelDetail `json:"details,omitempty"`
}

// ModelDetail describes one model of a ModelGroup.
type ModelDetail struct {
	Model string `json:"model"`
	// DisplayName is how a client names the model; empty: its name.
	DisplayName string `json:"displayName,omitempty"`
	// Status is ModelCurrent or ModelLegacy; empty when the host does not say.
	Status string `json:"status,omitempty"`
	// EffortLevels are the reasoning efforts the host's runner passes on for
	// this model, from least to most; empty when it takes none.
	EffortLevels []string `json:"effortLevels,omitempty"`
}

// Model statuses of a ModelDetail.
const (
	ModelCurrent = "current"
	ModelLegacy  = "legacy"
)

// WithModelCatalog names the providers and models clients may offer. Blank
// names are dropped and repeated models kept once; a provider may have no
// models listed (any model, as the host's model check decides). Details of
// models the group does not list, and repeated ones, are dropped. It does
// not enforce anything: WithModelCheck does.
func WithModelCatalog(groups ...ModelGroup) Option {
	return func(c *config) { c.catalog = cleanCatalog(groups) }
}

func cleanCatalog(groups []ModelGroup) []ModelGroup {
	out := []ModelGroup{}
	for _, group := range groups {
		provider := strings.TrimSpace(group.Provider)
		if provider == "" {
			continue
		}
		models := []string{}
		seen := map[string]bool{}
		for _, model := range group.Models {
			if model = strings.TrimSpace(model); model != "" && !seen[model] {
				seen[model] = true
				models = append(models, model)
			}
		}
		clean := ModelGroup{Provider: provider, Models: models, Ready: copyBool(group.Ready), Reason: strings.TrimSpace(group.Reason)}
		clean.Details = cleanDetails(group.Details, seen)
		out = append(out, clean)
	}
	return out
}

// cleanDetails keeps one detail per listed model, trimmed, with its own
// copy of the effort levels.
func cleanDetails(details []ModelDetail, listed map[string]bool) []ModelDetail {
	var out []ModelDetail
	described := map[string]bool{}
	for _, d := range details {
		model := strings.TrimSpace(d.Model)
		if !listed[model] || described[model] {
			continue
		}
		described[model] = true
		levels := []string{}
		for _, level := range d.EffortLevels {
			if level = strings.TrimSpace(level); level != "" {
				levels = append(levels, level)
			}
		}
		if len(levels) == 0 {
			levels = nil
		}
		out = append(out, ModelDetail{Model: model, DisplayName: strings.TrimSpace(d.DisplayName), Status: strings.TrimSpace(d.Status), EffortLevels: levels})
	}
	return out
}

func copyBool(b *bool) *bool {
	if b == nil {
		return nil
	}
	v := *b
	return &v
}

// ModelCatalog returns a copy of the WithModelCatalog groups; empty, never
// nil, without one.
func (e *Engine) ModelCatalog() []ModelGroup {
	out := make([]ModelGroup, 0, len(e.catalog))
	for _, group := range e.catalog {
		out = append(out, cleanCatalog([]ModelGroup{group})...)
	}
	return out
}
