package tangent

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// ComparisonChange is the data of comparison.changed.
type ComparisonChange struct {
	RootLineID string            `json:"rootLineId"`
	Comparison domain.Comparison `json:"comparison"`
}

func comparisonEvent(tenant string, c domain.Comparison) Event {
	return Event{Type: EventComparisonChanged, Tenant: tenant, RootLineID: c.RootLineID, LineID: c.ParentLineID, Data: ComparisonChange{RootLineID: c.RootLineID, Comparison: c}}
}

// ConvergeInput compares open sibling branches of the line; Criteria are
// the operator's (the model proposes them when there are none).
type ConvergeInput struct {
	LineIDs  []string
	Criteria []string
}

// ConvergeStarted is a new comparison (drafting) and the converge job the
// caller runs (httpapi hands it to its Dispatcher).
type ConvergeStarted struct {
	Comparison domain.Comparison
	Job        Job
}

// Converge compares 2–5 open, non-aside branches of the line (the parent):
// a drafting comparison and its converge job, which fills the matrix.
// Refusals: invalid_comparison (count, another parent, an aside, not a
// branch), branch_closed, archived; criteria over the limits (invalid_input,
// too_long).
// InTx hooks receive store.ComparisonWrite.
func (e *Engine) Converge(ctx context.Context, scope Scope, parentLineID string, in ConvergeInput, opts ...TxOption) (ConvergeStarted, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureDiverge)
	if err != nil {
		return ConvergeStarted{}, err
	}
	parent, err := e.store.GetLine(ctx, scope.Tenant, parentLineID)
	if err != nil {
		return ConvergeStarted{}, err
	}
	options, err := e.convergeOptions(ctx, scope, parentLineID, in.LineIDs)
	if err != nil {
		return ConvergeStarted{}, err
	}
	written, err := e.store.CreateComparison(ctx, store.CreateComparisonInput{
		Tenant: scope.Tenant, ParentLineID: parentLineID, LineIDs: optionIDs(options), Criteria: in.Criteria, Actor: scope.Actor, Feature: FeatureDiverge,
	}, hooksOf(opts)...)
	if err != nil {
		return ConvergeStarted{}, err
	}
	written.Comparison.RootLineID = written.RootLineID
	e.publish(ctx, comparisonEvent(scope.Tenant, written.Comparison))
	text := domain.BuildConvergePrompt(domain.ConvergeInput{Options: options, Criteria: written.Comparison.Criteria, ExtraMarkers: e.markers})
	return ConvergeStarted{Comparison: written.Comparison, Job: e.lineJob(*written.Job, scope, FeatureDiverge, parent, text)}, nil
}

// convergeOptions reads each distinct branch (purpose, leaf, newest
// messages) under its key O1, O2… in the caller's order.
func (e *Engine) convergeOptions(ctx context.Context, scope Scope, parentLineID string, lineIDs []string) ([]domain.ConvergeOption, error) {
	ids := []string{}
	for _, id := range lineIDs {
		if id = strings.TrimSpace(id); !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	l := e.limits.Diverge
	if len(ids) < l.MinCount || len(ids) > l.MaxCount {
		return nil, domain.InvalidComparison(fmt.Sprintf("a comparison has %d to %d branches", l.MinCount, l.MaxCount))
	}
	out := make([]domain.ConvergeOption, 0, len(ids))
	for i, id := range ids {
		detail, err := e.store.GetBranch(ctx, scope.Tenant, id)
		if err != nil || detail.Branch.ParentLineID != parentLineID {
			return nil, domain.InvalidComparison("only branches of this line are compared")
		}
		recent, err := e.store.RecentMessages(ctx, scope.Tenant, id, l.ContextMessages)
		if err != nil {
			return nil, err
		}
		option := domain.ConvergeOption{Key: fmt.Sprintf("O%d", i+1), LineID: id, Purpose: detail.Branch.Purpose, Messages: conversationOnly(recent)}
		if detail.Branch.Leaf != nil {
			option.Leaf = detail.Branch.Leaf.Line
		}
		out = append(out, option)
	}
	return out, nil
}

func optionIDs(options []domain.ConvergeOption) []string {
	ids := make([]string, 0, len(options))
	for _, o := range options {
		ids = append(ids, o.LineID)
	}
	return ids
}

// comparisonJobInput is what a converge job remembers (store writes it).
type comparisonJobInput struct {
	ComparisonID string `json:"comparisonId"`
}

// finishConverge writes the matrix (ready), or marks the comparison failed.
func finishConverge(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
	var in comparisonJobInput
	_ = json.Unmarshal(job.Input, &in)
	var matrix *domain.ComparisonMatrix
	failure := domain.JobRunFailedText
	if runErr == nil {
		m, err := e.parseConvergence(ctx, job.TenantID, in.ComparisonID, raw)
		failure = foldFailure(nil, err)
		if err == nil {
			matrix = &m
		}
	}
	result, err := e.store.FinishComparison(ctx, job.ID, matrix, failure)
	if err != nil {
		return err
	}
	if result.Written {
		e.publish(ctx, comparisonEvent(job.TenantID, result.Comparison))
	}
	if failure != "" {
		e.publishJobFailed(ctx, job, failure)
	}
	return nil
}

// parseConvergence reads a converge reply against the comparison's options
// (labelled with their purposes) and criteria.
func (e *Engine) parseConvergence(ctx context.Context, tenant, comparisonID, raw string) (domain.ComparisonMatrix, error) {
	c, err := e.store.GetComparison(ctx, tenant, comparisonID)
	if err != nil {
		return domain.ComparisonMatrix{}, err
	}
	purposes, err := e.store.BranchPurposes(ctx, tenant, c.LineIDs)
	if err != nil {
		return domain.ComparisonMatrix{}, err
	}
	options := make([]domain.ConvergeOption, 0, len(c.LineIDs))
	for i, id := range c.LineIDs {
		options = append(options, domain.ConvergeOption{Key: fmt.Sprintf("O%d", i+1), LineID: id, Purpose: purposes[id]})
	}
	return domain.ParseConvergence(raw, options, c.Criteria, e.limits)
}

// staleConverge marks the comparison of a timed-out converge job failed.
func staleConverge(ctx context.Context, e *Engine, job JobRecord) {
	failed, err := e.store.FailComparisonOfJob(ctx, job.ID)
	if err != nil {
		e.log.Warn("tangent: a timed-out comparison was not marked", "job", job.ID, "error", err)
	}
	if failed != nil {
		e.publish(ctx, comparisonEvent(job.TenantID, failed.Comparison))
	}
	e.publishJobFailed(ctx, job, job.Error)
}

// ComparisonList is a line's comparisons.
type ComparisonList = store.ComparisonList

// ListComparisons lists the comparisons of the line's branches, newest first.
func (e *Engine) ListComparisons(ctx context.Context, scope Scope, lineID string) (ComparisonList, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureDiverge)
	if err != nil {
		return ComparisonList{}, err
	}
	return e.store.ListComparisons(ctx, scope.Tenant, lineID)
}

// GetComparison reads a comparison.
func (e *Engine) GetComparison(ctx context.Context, scope Scope, comparisonID string) (domain.Comparison, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureDiverge)
	if err != nil {
		return domain.Comparison{}, err
	}
	return e.store.GetComparison(ctx, scope.Tenant, comparisonID)
}
