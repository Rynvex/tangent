package tangent

import (
	"context"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// ExportMaxMessagesPerLine caps the messages an export carries for one
// line: the oldest ones, in seq order (the transcript page cap).
const ExportMaxMessagesPerLine = 500

// TreeExport is a whole conversation at once (B14): the main line, every
// branch (asides included, oldest first), each line's messages and the
// parts of the features on for the scope. A part whose feature is off is
// empty ([], null for Goal, {} for FoldsByLine), never feature_disabled.
// Truncated reports a part that was cut: a line with more than
// ExportMaxMessagesPerLine messages, an outline at store.OutlineCap
// branches or more than store.TreeComparisonCap comparisons. The parts are
// read one after another, not in one snapshot.
type TreeExport struct {
	RootLineID     string                      `json:"rootLineId"`
	ExportedAt     time.Time                   `json:"exportedAt"`
	Truncated      bool                        `json:"truncated"`
	RootLine       domain.LineView             `json:"rootLine"`
	Branches       []domain.BranchView         `json:"branches"`
	MessagesByLine map[string][]domain.Message `json:"messagesByLine"`
	Notes          []domain.Note               `json:"notes"`
	Memos          []domain.Memo               `json:"memos"`
	Terms          []domain.Term               `json:"terms"`
	Chapters       []domain.Chapter            `json:"chapters"`
	Goal           *domain.Goal                `json:"goal"`
	Comparisons    []domain.Comparison         `json:"comparisons"`
	Links          []domain.Link               `json:"links"`
	FoldsByLine    map[string][]domain.Fold    `json:"foldsByLine"`
}

// ExportTree reads the whole conversation of any of its lines; read-only
// callers may ask. Each part is one query whatever the number of lines.
func (e *Engine) ExportTree(ctx context.Context, scope Scope, lineID string) (TreeExport, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return TreeExport{}, err
	}
	out, lineIDs, err := e.exportCore(ctx, scope, lineID)
	if err != nil {
		return TreeExport{}, err
	}
	if err := e.exportFeatures(ctx, scope, e.modesFor(ctx, scope), &out, lineIDs); err != nil {
		return TreeExport{}, err
	}
	return out, nil
}

// exportCore reads the main line, the outline and the messages; it
// returns the tree's line ids.
func (e *Engine) exportCore(ctx context.Context, scope Scope, lineID string) (TreeExport, []string, error) {
	line, err := e.store.GetLine(ctx, scope.Tenant, lineID)
	if err != nil {
		return TreeExport{}, nil, err
	}
	rootID := line.ID
	if line.ConversationBranch != nil {
		rootID = line.ConversationBranch.RootLineID
	}
	root, err := e.store.GetLine(ctx, scope.Tenant, rootID)
	if err != nil {
		return TreeExport{}, nil, err
	}
	branches, err := e.store.ListBranches(ctx, scope.Tenant, rootID, true)
	if err != nil {
		return TreeExport{}, nil, err
	}
	lineIDs := make([]string, 0, len(branches)+1)
	lineIDs = append(lineIDs, rootID)
	for _, b := range branches {
		lineIDs = append(lineIDs, b.LineID)
	}
	messages, err := e.store.ListTreeMessages(ctx, scope.Tenant, lineIDs, ExportMaxMessagesPerLine)
	if err != nil {
		return TreeExport{}, nil, err
	}
	return TreeExport{
		RootLineID: rootID, ExportedAt: e.now().UTC(), Truncated: messages.Truncated || len(branches) >= store.OutlineCap, RootLine: root, Branches: nonNil(branches),
		MessagesByLine: messages.ByLine, Notes: []domain.Note{}, Memos: []domain.Memo{}, Terms: []domain.Term{}, Chapters: []domain.Chapter{},
		Comparisons: []domain.Comparison{}, Links: []domain.Link{}, FoldsByLine: map[string][]domain.Fold{},
	}, lineIDs, nil
}

// exportFeatures fills the parts of the features on for the scope.
func (e *Engine) exportFeatures(ctx context.Context, scope Scope, modes modeSet, out *TreeExport, lineIDs []string) error {
	on := func(feature string) bool { return modes.of(feature) != ModeOff }
	tenant, root := scope.Tenant, out.RootLineID
	var err error
	if on(FeatureNotes) {
		notes, readErr := e.store.ListNotes(ctx, tenant, root)
		out.Notes, err = nonNil(notes.Notes), readErr
	}
	if err == nil && on(FeatureMemo) {
		memos, readErr := e.store.ListMemos(ctx, tenant, root, "")
		out.Memos, err = nonNil(memos.Memos), readErr
	}
	if err == nil && on(FeatureGlossary) {
		terms, readErr := e.store.ListTerms(ctx, tenant, root)
		out.Terms, err = nonNil(terms.Terms), readErr
	}
	if err == nil && on(FeatureChapters) {
		chapters, readErr := e.store.ListChapters(ctx, tenant, root)
		out.Chapters, err = nonNil(chapters.Chapters), readErr
	}
	if err == nil && on(FeatureGoal) {
		out.Goal, err = e.store.GetGoal(ctx, tenant, root)
	}
	if err == nil && on(FeatureDiverge) {
		var cut bool
		out.Comparisons, cut, err = e.store.ListTreeComparisons(ctx, tenant, root, lineIDs)
		out.Truncated = out.Truncated || cut
	}
	if kinds := exportLinkKinds(on); err == nil && len(kinds) > 0 {
		links, readErr := e.store.ListLinks(ctx, tenant, root, kinds)
		out.Links, err = nonNil(links), readErr
	}
	if err == nil && on(FeatureFold) {
		out.FoldsByLine, err = e.store.ListTreeFolds(ctx, tenant, lineIDs)
	}
	return err
}

// exportLinkKinds are the link kinds whose feature is on.
func exportLinkKinds(on func(string) bool) []string {
	kinds := []string{}
	if on(FeatureSpinoff) {
		kinds = append(kinds, domain.LinkKindSpinoff)
	}
	if on(FeatureRelations) {
		kinds = append(kinds, domain.LinkKindRelation)
	}
	return kinds
}

// nonNil is s, or an empty slice for nil (JSON [] rather than null).
func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
