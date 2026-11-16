package tangent

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Job and suggestion kinds of the relations feature.
const (
	// JobKindRelationSuggest: a cheap model relates a branch that ended to
	// the other branches of its tree.
	JobKindRelationSuggest = "relation_suggest"
	// SuggestionKindRelation is a proposed relation (payload RelationPayload).
	SuggestionKindRelation = "relation"
)

// relationCandidatesMax bounds the branches one relation job compares.
const relationCandidatesMax = 30

// Relations draws labelled lines between two places (a line, or a message
// on it) of the tenant's conversations, in one tree or across two (DESIGN
// §12 B9); they are links of kind relation, listed by /links too. Suggest
// (and Auto, which behaves alike: a relation is drawn only when the
// operator accepts it) asks a cheap model, when a branch is merged or
// discarded, which other branches of the tree it relates to, and raises
// each as a relation suggestion. Manual: drawn by hand only. Off: the
// relation calls return feature_disabled; stored relations are kept.
func Relations(mode Mode, opts ...FeatureOption) Feature {
	return aiFeature(FeatureRelations, mode, opts, registerRelations)
}

func registerRelations(r *registry, _ *module) {
	r.addAfterCommit(relationsAfterClose)
	r.addJobHandler(JobKindRelationSuggest, jobHandler{timeout: goalJobTimeout, finish: finishRelationSuggest, onStale: staleJobFailed})
	r.addSuggestionKind(SuggestionKindRelation, suggestionKind{accept: acceptRelation})
}

// Relation types, as the store takes and returns them.
type (
	RelationEnd    = store.RelationEnd
	RelationChange = store.RelationChange
	RelationEdit   = store.RelationEdit
)

// RelationInput relates two places: From (its line defaults to the line
// the call is made on, whose conversation it must be in) and To (any
// conversation of the tenant), with an optional one-line label and an
// optional kind (domain.RelationKinds; empty is related).
type RelationInput struct {
	From         RelationEnd
	To           RelationEnd
	Label        string
	RelationKind string
}

// CreateRelation draws a relation and publishes link.changed to each
// conversation it touches.
// InTx hooks receive store.RelationChange.
func (e *Engine) CreateRelation(ctx context.Context, scope Scope, lineID string, in RelationInput, opts ...TxOption) (RelationChange, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureRelations)
	if err != nil {
		return RelationChange{}, err
	}
	change, err := e.store.CreateRelation(ctx, store.CreateRelationInput{
		Tenant: scope.Tenant, LineID: lineID, From: in.From, To: in.To, Label: in.Label, RelationKind: in.RelationKind, Actor: scope.Actor,
	}, hooksOf(opts)...)
	if err != nil {
		return RelationChange{}, err
	}
	e.publish(ctx, linkEvents(scope, change, false)...)
	return change, nil
}

// DeleteRelation removes a relation one of whose ends is in the line's
// conversation (relation_not_found otherwise).
// InTx hooks receive store.RelationChange.
func (e *Engine) DeleteRelation(ctx context.Context, scope Scope, lineID, relationID string, opts ...TxOption) (RelationChange, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureRelations)
	if err != nil {
		return RelationChange{}, err
	}
	change, err := e.store.DeleteRelation(ctx, scope.Tenant, lineID, relationID, hooksOf(opts)...)
	if err != nil {
		return RelationChange{}, err
	}
	e.publish(ctx, linkEvents(scope, change, true)...)
	return change, nil
}

// ListRelations lists the relations touching the line's conversation,
// newest first.
func (e *Engine) ListRelations(ctx context.Context, scope Scope, lineID string) ([]domain.Link, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureRelations)
	if err != nil {
		return nil, err
	}
	return e.store.ListLinks(ctx, scope.Tenant, lineID, []string{domain.LinkKindRelation})
}

// linkEvents are link.changed for each conversation a relation touches.
func linkEvents(scope Scope, change RelationChange, deleted bool) []Event {
	events := make([]Event, 0, len(change.RootLineIDs))
	for _, root := range change.RootLineIDs {
		events = append(events, Event{
			Type: EventLinkChanged, Tenant: scope.Tenant, RootLineID: root, LineID: root,
			Data: LinkChange{RootLineID: root, Link: change.Link, Deleted: deleted},
		})
	}
	return events
}

// relationJobInput maps the keys a relation job showed the model to the
// branches (B0 is the branch that ended).
type relationJobInput struct {
	Branches map[string]relationJobBranch `json:"branches"`
}

type relationJobBranch struct {
	LineID  string `json:"lineId"`
	Purpose string `json:"purpose"`
}

// relationBranchKey is the key of the branch that ended.
const relationBranchKey = "B0"

// relationsAfterClose starts a relation job when a branch (not an aside)
// was merged or discarded and its tree has other branches.
func relationsAfterClose(ctx context.Context, e *Engine, mode Mode, ev *commitEvent) ([]Event, []Job) {
	if ev.kind != commitBranchClosed || mode < ModeSuggest || ev.branch == nil || ev.branch.Kind == domain.BranchKindAside {
		return nil, nil
	}
	if ev.change != BranchMerged && ev.change != BranchDiscarded {
		return nil, nil
	}
	job, ok, err := e.startRelationSuggest(ctx, ev.scope, *ev.branch)
	if err != nil {
		e.log.Warn("tangent: a relation job was not started", "line", ev.branch.LineID, "error", err)
	}
	if !ok {
		return nil, nil
	}
	return nil, []Job{job}
}

// startRelationSuggest records a relation job for a branch that ended; ok
// is false when its tree has no other branch to relate it to.
func (e *Engine) startRelationSuggest(ctx context.Context, scope Scope, branch domain.BranchView) (Job, bool, error) {
	tree, err := e.store.FisheyeTree(ctx, scope.Tenant, branch.RootLineID)
	if err != nil {
		return Job{}, false, err
	}
	in := relationJobInput{Branches: map[string]relationJobBranch{relationBranchKey: {LineID: branch.LineID, Purpose: branch.Purpose}}}
	ended := branch.ConclusionLine
	if branch.Leaf != nil {
		ended = branch.Leaf.Line
	}
	prompt := domain.RelationSuggestInput{Branch: domain.RelationCandidate{Key: relationBranchKey, Purpose: branch.Purpose, Leaf: ended}, ExtraMarkers: e.markers}
	for _, b := range slices.Backward(tree.Branches) { // newest first
		if b.LineID == branch.LineID || b.Kind == domain.BranchKindAside || len(prompt.Others) == relationCandidatesMax {
			continue
		}
		key := fmt.Sprintf("B%d", len(prompt.Others)+1)
		in.Branches[key] = relationJobBranch{LineID: b.LineID, Purpose: b.Purpose}
		prompt.Others = append(prompt.Others, domain.RelationCandidate{Key: key, Purpose: b.Purpose, Leaf: treeLeaf(b)})
	}
	if len(prompt.Others) == 0 {
		return Job{}, false, nil
	}
	input, _ := json.Marshal(in)
	record, err := e.startJob(ctx, scope, store.CreateJobInput{Kind: JobKindRelationSuggest, Feature: FeatureRelations, LineID: branch.RootLineID, Input: input}, nil)
	if err != nil {
		return Job{}, false, err
	}
	provider, model := e.configOf(FeatureRelations).jobModel(branch.Provider, branch.Model)
	return Job{
		ID: record.ID, Kind: JobKindRelationSuggest, Feature: FeatureRelations, Scope: scope, LineID: branch.RootLineID,
		Prompt: jobPrompt(domain.BuildRelationSuggestPrompt(prompt)), Provider: provider, Model: model,
	}, true, nil
}

// treeLeaf is what a branch ended with: its leaf, else its card's
// conclusion ("" for neither).
func treeLeaf(b store.FisheyeTreeBranch) string {
	if b.LeafLine != "" {
		return b.LeafLine
	}
	return b.ConclusionLine
}

// RelationPayload is the payload of a relation suggestion: from the branch
// that ended to another, with the branches' purposes, the label and the
// kind (B15; a suggestion raised before it has none and is related).
type RelationPayload struct {
	FromLineID   string `json:"fromLineId"`
	ToLineID     string `json:"toLineId"`
	FromTitle    string `json:"fromTitle"`
	ToTitle      string `json:"toTitle"`
	Label        string `json:"label"`
	RelationKind string `json:"relationKind,omitempty"`
}

// finishRelationSuggest raises each proposed relation in the inbox.
func finishRelationSuggest(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
	var in relationJobInput
	_ = json.Unmarshal(job.Input, &in)
	known := map[string]bool{}
	for key := range in.Branches {
		known[key] = key != relationBranchKey
	}
	proposals, parseErr := domain.ParseRelationSuggestions(raw, known, e.limits.Relations)
	if ok, err := e.finishFeatureJob(ctx, job, runErr, parseErr); !ok {
		return err
	}
	scope := Scope{Tenant: job.TenantID}
	if e.modesFor(ctx, scope).of(FeatureRelations) < ModeSuggest {
		return nil
	}
	from := in.Branches[relationBranchKey]
	for _, p := range proposals {
		to := in.Branches[p.To]
		payload, _ := json.Marshal(RelationPayload{FromLineID: from.LineID, ToLineID: to.LineID, FromTitle: from.Purpose, ToTitle: to.Purpose, Label: p.Label, RelationKind: p.Kind})
		e.publish(ctx, e.proposeSuggestion(ctx, scope, suggestionProposal{
			lineID: job.LineID, kind: SuggestionKindRelation, targetKey: relationTarget(from.LineID, to.LineID), payload: payload,
		})...)
	}
	return nil
}

// relationTarget names a pair of lines whichever way round.
func relationTarget(a, b string) string {
	pair := []string{a, b}
	slices.Sort(pair)
	return "relation:" + strings.Join(pair, ":")
}

// RelationAccepted is what accepting a relation suggestion did.
type RelationAccepted struct {
	Link domain.Link `json:"link"`
}

// relationChoice is the body of accepting a relation: Label and
// RelationKind replace the proposed ones.
type relationChoice struct {
	Label        string `json:"label"`
	RelationKind string `json:"relationKind"`
}

func acceptRelation(ctx context.Context, e *Engine, scope Scope, s domain.Suggestion, body json.RawMessage, mark TxOption, opts []TxOption) (any, error) {
	var payload RelationPayload
	var choice relationChoice
	if err := decodeChoice(s.Payload, &payload); err != nil {
		return nil, err
	}
	if err := decodeChoice(body, &choice); err != nil {
		return nil, err
	}
	change, err := e.CreateRelation(ctx, scope, s.RootLineID, RelationInput{
		From: RelationEnd{LineID: payload.FromLineID}, To: RelationEnd{LineID: payload.ToLineID}, Label: cmp.Or(strings.TrimSpace(choice.Label), payload.Label),
		RelationKind: cmp.Or(strings.TrimSpace(choice.RelationKind), payload.RelationKind),
	}, append([]TxOption{mark}, opts...)...)
	if err != nil {
		return nil, err
	}
	return RelationAccepted{Link: change.Link}, nil
}

// UpdateRelation changes the label of a relation one of whose ends is in
// the line's conversation and keeps its kind; see EditRelation.
// InTx hooks receive store.RelationChange.
func (e *Engine) UpdateRelation(ctx context.Context, scope Scope, lineID, relationID, label string, opts ...TxOption) (RelationChange, error) {
	return e.EditRelation(ctx, scope, lineID, relationID, RelationEdit{Label: &label}, opts...)
}

// EditRelation changes the label and/or the kind of a relation one of
// whose ends is in the line's conversation (a nil field keeps the stored
// value) and publishes link.changed to each conversation it touches.
// InTx hooks receive store.RelationChange.
func (e *Engine) EditRelation(ctx context.Context, scope Scope, lineID, relationID string, edit RelationEdit, opts ...TxOption) (RelationChange, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureRelations)
	if err != nil {
		return RelationChange{}, err
	}
	change, err := e.store.UpdateRelation(ctx, scope.Tenant, lineID, relationID, edit, hooksOf(opts)...)
	if err != nil {
		return RelationChange{}, err
	}
	e.publish(ctx, linkEvents(scope, change, false)...)
	return change, nil
}
