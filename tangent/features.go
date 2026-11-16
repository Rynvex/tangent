package tangent

import (
	"context"
	"strings"

	"github.com/Rynvex/tangent/domain"
)

// Feature modules (DESIGN §11): built-in, optional modules chosen with
// WithFeatures. A feature attaches itself to the engine through the
// extension points of registry (feature_hooks.go); the core calls those
// points at fixed places.

// Mode is how an AI feature runs. Features without AI are on (ModeAuto) or
// off.
type Mode int

const (
	// ModeOff: the feature does nothing.
	ModeOff Mode = iota
	// ModeManual: only when the operator asks.
	ModeManual
	// ModeSuggest: the AI proposes, the operator confirms.
	ModeSuggest
	// ModeAuto: the AI does it.
	ModeAuto
)

// String names the mode as the API shows it.
func (m Mode) String() string {
	switch m {
	case ModeManual:
		return "manual"
	case ModeSuggest:
		return "suggest"
	case ModeAuto:
		return "auto"
	}
	return "off"
}

// Feature is one built-in optional module. The set is closed: only this
// package implements it (Notes, Chapters, Aside, Summary, CardDraft,
// BranchSuggest, Search, Leaf, Parking, Spinoff, Rebalance, Goal,
// Relations, OpenLoops, Fisheye, Group, Ibis, Fold, Diverge, Memory, Memo,
// Glossary, and SuggestionProbe for tests).
type Feature interface {
	// Name is the feature's stable name (for example "notes").
	Name() string
	// Requires names the features it cannot work without.
	Requires() []string
	// AI reports whether the feature calls a model (and so has a Mode).
	AI() bool
	// mode is the configured mode (ModeAuto for a feature without AI).
	mode() Mode
	// register attaches the feature's extension points.
	register(r *registry)
}

// FeaturePolicy narrows the configured features per tenant or conversation.
// It can only narrow: the effective mode is the lower of the configured one
// and the policy's, so a feature that was not configured stays off.
type FeaturePolicy interface {
	Mode(ctx context.Context, scope Scope, feature string) Mode
}

// WithFeatures enables features, in the order their extension points run.
func WithFeatures(features ...Feature) Option {
	return func(c *config) { c.features = append(c.features, features...) }
}

// WithFeaturePolicy narrows the enabled features at run time.
func WithFeaturePolicy(p FeaturePolicy) Option {
	return func(c *config) {
		if p != nil {
			c.policy = p
		}
	}
}

// openPolicy leaves every configured feature as configured.
type openPolicy struct{}

func (openPolicy) Mode(context.Context, Scope, string) Mode { return ModeAuto }

// FeatureOption configures one AI feature.
type FeatureOption func(*featureConfig)

// featureConfig is what an AI feature is configured with.
type featureConfig struct {
	provider string
	model    string
}

// JobModel names the provider and model the feature's jobs ask for (for
// example a cheap model); empty means the conversation's own.
func JobModel(provider, model string) FeatureOption {
	return func(c *featureConfig) {
		c.provider, c.model = strings.TrimSpace(provider), strings.TrimSpace(model)
	}
}

func newFeatureConfig(opts []FeatureOption) featureConfig {
	cfg := featureConfig{}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	return cfg
}

// jobModel is the provider and model a feature job asks for: the
// configured ones, else the conversation's own.
func (c featureConfig) jobModel(provider, model string) (string, string) {
	if c.provider != "" || c.model != "" {
		return c.provider, c.model
	}
	return provider, model
}

// Names of the built-in features.
const (
	FeatureNotes         = "notes"
	FeatureChapters      = "chapters"
	FeatureAside         = "aside"
	FeatureSummary       = "summary"
	FeatureCardDraft     = "card_draft"
	FeatureBranchSuggest = "branch_suggest"
	FeatureLeaf          = "leaf"
	FeatureParking       = "parking"
	FeatureSpinoff       = "spinoff"
	FeatureRebalance     = "rebalance"
	FeatureGoal          = "goal"
	FeatureRelations     = "relations"
	FeatureOpenLoops     = "open_loops"
	FeatureFisheye       = "fisheye"
	FeatureGroup         = "group"
	FeatureIbis          = "ibis"
	FeatureFold          = "fold"
	FeatureDiverge       = "diverge"
	FeatureMemory        = "memory"
	FeatureMemo          = "memo"
	// FeatureSuggestions is the suggestion inbox: not a feature of its own,
	// it is on while a feature that raises suggestions is on.
	FeatureSuggestions = "suggestions"
)

// Inputs of core calls that belong to a feature. Core guards them with
// requireInput and never names the feature; the catalog says who owns them.
const (
	inputNoteChanges = "merge.noteChanges"
	inputSuggestion  = "branch.suggestionMessageId"
	inputDiscardLeaf = "discard.leaf"
)

// inputBranchKind is the input of a branch kind (core kinds have no owner).
func inputBranchKind(kind string) string { return "branch.kind." + kind }

// catalogEntry describes a built-in feature: whether it has a mode beyond
// on / off, and the core inputs it owns.
type catalogEntry struct {
	name    string
	hasMode bool
	inputs  []string
}

// catalog is the closed set of built-in features, in the order Capabilities
// lists them.
var catalog = []catalogEntry{
	{name: FeatureNotes, inputs: []string{inputNoteChanges}},
	{name: FeatureChapters},
	{name: FeatureAside, inputs: []string{inputBranchKind(domain.BranchKindAside)}},
	{name: FeatureSummary, hasMode: true},
	{name: FeatureCardDraft},
	{name: FeatureBranchSuggest, hasMode: true, inputs: []string{inputSuggestion}},
	{name: FeatureSearch},
	{name: FeatureLeaf, hasMode: true, inputs: []string{inputDiscardLeaf}},
	{name: FeatureParking},
	{name: FeatureSpinoff},
	{name: FeatureRebalance, hasMode: true},
	{name: FeatureGoal, hasMode: true},
	{name: FeatureRelations, hasMode: true},
	{name: FeatureOpenLoops},
	{name: FeatureFisheye},
	{name: FeatureGroup, hasMode: true},
	{name: FeatureIbis, hasMode: true},
	{name: FeatureFold, hasMode: true},
	{name: FeatureDiverge, hasMode: true},
	{name: FeatureMemory, hasMode: true},
	{name: FeatureMemo},
	{name: FeatureGlossary},
	{name: FeatureSuggestions},
}

// AllFeatures is every first-batch feature: notes, chapters, asides and card
// drafts on, summaries suggested when due, branch suggestions, and the
// glossary (B24).
func AllFeatures() []Feature {
	return []Feature{Notes(), Chapters(), Aside(), Summary(ModeSuggest), CardDraft(), BranchSuggest(ModeSuggest), Glossary()}
}

// Capability is one built-in feature as a caller sees it. Mode is set only
// for features that have one beyond on / off (summary, branch_suggest,
// leaf, rebalance, goal, relations, group, ibis, fold, diverge, memory). "suggestions" is the inbox: enabled while a feature that raises
// suggestions is on.
type Capability struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	Mode    string `json:"mode,omitempty"`
}

// Capabilities lists every built-in feature with whether it is on for the
// scope and, where it has one, its effective mode.
func (e *Engine) Capabilities(ctx context.Context, scope Scope) ([]Capability, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return nil, err
	}
	modes := e.modesFor(ctx, scope)
	out := make([]Capability, 0, len(catalog))
	for _, entry := range catalog {
		mode := modes.of(entry.name)
		capability := Capability{Name: entry.name, Enabled: mode != ModeOff}
		if entry.hasMode {
			capability.Mode = mode.String()
		}
		out = append(out, capability)
	}
	return out, nil
}
