package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Jobs and the suggestion kind of the fold feature.
const (
	// JobKindFoldSummary writes the summary of a drafting fold.
	JobKindFoldSummary = store.JobKindFoldSummary
	// JobKindFoldSuggest summarizes a closed chapter to propose folding it.
	JobKindFoldSuggest = "fold_suggest"
	// SuggestionKindFold is a proposed fold (payload FoldSuggestion).
	SuggestionKindFold = "fold"
)

// Fold folds a stretch of a line into one summary (DESIGN §12 B10): the
// messages stay where they are, but every later prompt of the line carries
// the summary in their place (applied before the HistorySelector, so the
// fisheye weighs the fold as one entry). The operator folds a range with a
// summary of their own or asks a model to draft one (a fold_summary job,
// any mode); PreviewTurn lists the folds it applied. Folds follow their
// messages when a move or a promotion takes them to another line, and a
// fold whose ends were split no longer applies. Suggest (Auto alike: a fold
// changes what the model sees, so nothing is folded by itself) also
// summarizes, every Limits.Fold.SuggestEvery replies of a line, its oldest
// closed chapter worth folding (fold_suggest → the inbox; a dismissed
// chapter is not proposed again). Off: the fold calls return
// feature_disabled and prompts carry every message; stored folds are kept.
func Fold(mode Mode, opts ...FeatureOption) Feature {
	return aiFeature(FeatureFold, mode, opts, registerFold)
}

func registerFold(r *registry, _ *module) {
	r.addHistoryRewriter(foldHistory)
	r.addOnBranchCreated(reconcileFoldsOnMove)
	r.addOnBranchClosed(reconcileFoldsOnPromote)
	r.addAfterCommit(foldSuggestAfterTurn)
	r.addJobHandler(JobKindFoldSummary, jobHandler{timeout: goalJobTimeout, finish: finishFoldSummary, onStale: staleFoldSummary})
	r.addJobHandler(JobKindFoldSuggest, jobHandler{timeout: goalJobTimeout, finish: finishFoldSuggest, onStale: staleJobFailed})
	r.addSuggestionKind(SuggestionKindFold, suggestionKind{permanentDismiss: true, accept: acceptFold})
}

// FoldChange is the data of fold.changed.
type FoldChange struct {
	LineID     string      `json:"lineId"`
	RootLineID string      `json:"rootLineId"`
	Fold       domain.Fold `json:"fold"`
}

func foldEvent(tenant, rootLineID string, f domain.Fold) Event {
	return Event{Type: EventFoldChanged, Tenant: tenant, RootLineID: rootLineID, LineID: f.LineID, Data: FoldChange{LineID: f.LineID, RootLineID: rootLineID, Fold: f}}
}

// FoldInput folds the messages of a line from one message to another
// (either order); an empty Summary asks a model to draft it.
type FoldInput struct {
	FromMessageID string
	ToMessageID   string
	Summary       string
}

// FoldCreated is a new fold and, for a draft, the fold_summary job the
// caller runs (httpapi hands it to its Dispatcher).
type FoldCreated struct {
	Fold domain.Fold
	Job  *Job
}

// CreateFold folds a stretch of the line: active with the operator's
// summary, or drafting with a fold_summary job (any mode). Refusals: an end
// not on the line (message_not_found), a range outside
// Limits.Fold.MinMessages..MaxMessages or with a pending reply
// (invalid_fold), an overlap with another fold (fold_overlap), too many
// folds (fold_limit), a summary over the limit (too_long), archived.
// InTx hooks receive store.FoldWrite.
func (e *Engine) CreateFold(ctx context.Context, scope Scope, lineID string, in FoldInput, opts ...TxOption) (FoldCreated, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureFold)
	if err != nil {
		return FoldCreated{}, err
	}
	return e.createFold(ctx, scope, lineID, in, "", opts)
}

func (e *Engine) createFold(ctx context.Context, scope Scope, lineID string, in FoldInput, sourceJobID string, opts []TxOption) (FoldCreated, error) {
	written, err := e.store.CreateFold(ctx, store.CreateFoldInput{
		Tenant: scope.Tenant, LineID: lineID, FromMessageID: in.FromMessageID, ToMessageID: in.ToMessageID, Summary: in.Summary,
		Actor: scope.Actor, Feature: FeatureFold, SourceJobID: sourceJobID,
	}, hooksOf(opts)...)
	if err != nil {
		return FoldCreated{}, err
	}
	e.publish(ctx, foldEvent(scope.Tenant, written.RootLineID, written.Fold))
	out := FoldCreated{Fold: written.Fold}
	if written.Job != nil {
		job, err := e.foldJob(ctx, scope, *written.Job, written.Messages, "")
		if err != nil {
			return FoldCreated{}, err
		}
		out.Job = &job
	}
	return out, nil
}

// FoldList is a line's folds.
type FoldList = store.FoldList

// ListFolds lists the line's folds that were not removed, in seq order.
func (e *Engine) ListFolds(ctx context.Context, scope Scope, lineID string) (FoldList, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureFold)
	if err != nil {
		return FoldList{}, err
	}
	return e.store.ListFolds(ctx, scope.Tenant, lineID)
}

// RemoveFold takes a fold back: its messages are in the prompt again (a
// drafting fold's job no longer writes).
// InTx hooks receive store.FoldWrite.
func (e *Engine) RemoveFold(ctx context.Context, scope Scope, foldID string, opts ...TxOption) (domain.Fold, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureFold)
	if err != nil {
		return domain.Fold{}, err
	}
	removed, err := e.store.RemoveFold(ctx, scope.Tenant, foldID, hooksOf(opts)...)
	if err != nil {
		return domain.Fold{}, err
	}
	e.publish(ctx, foldEvent(scope.Tenant, removed.RootLineID, removed.Fold))
	return removed.Fold, nil
}

// UpdateFold writes the operator's summary on a fold (any status but
// removed): it becomes active and no longer counts as drafted by a model; a
// drafting fold's job no longer writes. Refusals: an empty summary
// (invalid_input), one over the limit (too_long), fold_not_found, archived.
// InTx hooks receive store.FoldWrite.
func (e *Engine) UpdateFold(ctx context.Context, scope Scope, foldID, summary string, opts ...TxOption) (domain.Fold, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureFold)
	if err != nil {
		return domain.Fold{}, err
	}
	updated, err := e.store.UpdateFold(ctx, scope.Tenant, foldID, summary, hooksOf(opts)...)
	if err != nil {
		return domain.Fold{}, err
	}
	e.publish(ctx, foldEvent(scope.Tenant, updated.RootLineID, updated.Fold))
	return updated.Fold, nil
}

// foldHistory is fold's history rewriter: the line's active folds stand
// for their messages.
func foldHistory(ctx context.Context, e *Engine, _ Mode, pc *promptContext, history []domain.Message) ([]domain.Message, error) {
	folds, err := e.store.LiveFolds(ctx, pc.line.ID)
	if err != nil || len(folds) == 0 {
		return history, err
	}
	out, applied := domain.ApplyFolds(history, folds)
	pc.folds = applied
	return out, nil
}

// reconcileFoldsOnMove takes the folds of moved messages to the new branch.
func reconcileFoldsOnMove(ctx context.Context, e *Engine, _ Mode, tx store.Tx, ev txEvent) error {
	moved, ok := ev.result.(store.MovedBranch)
	if !ok {
		return nil
	}
	return e.reconcileFolds(ctx, tx, ev, moved.RootLineID, moved.SourceLineID, moved.Line.ID)
}

// reconcileFoldsOnPromote takes the folds of the lines whose messages a
// promotion swapped along with them.
func reconcileFoldsOnPromote(ctx context.Context, e *Engine, _ Mode, tx store.Tx, ev txEvent) error {
	promoted, ok := ev.result.(store.PromotedBranch)
	if !ok {
		return nil
	}
	return e.reconcileFolds(ctx, tx, ev, promoted.MainLineID, promoted.MainLineID, promoted.PromotedID, promoted.PreviousID)
}

func (e *Engine) reconcileFolds(ctx context.Context, tx store.Tx, ev txEvent, rootID string, lineIDs ...string) error {
	changed, err := store.ReconcileFolds(ctx, tx, lineIDs)
	if err != nil || len(changed) == 0 {
		return err
	}
	ev.out.after(func(context.Context) []Event {
		events := make([]Event, 0, len(changed))
		for _, fold := range changed {
			events = append(events, foldEvent(ev.scope.Tenant, rootID, fold))
		}
		return events
	})
	return nil
}
