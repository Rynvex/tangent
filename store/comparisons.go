package store

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// CreateComparisonInput compares open sibling branches of one parent; a
// converge job of Feature fills the matrix.
type CreateComparisonInput struct {
	Tenant       string
	ParentLineID string
	LineIDs      []string
	Criteria     []string
	Actor        string
	Feature      string
}

// ComparisonWrite is a comparison after a write, its conversation and the
// converge job started for it (nil unless one was).
type ComparisonWrite struct {
	Comparison domain.Comparison
	RootLineID string
	Job        *Job
}

// comparisonJobInput is what a converge job remembers.
type comparisonJobInput struct {
	ComparisonID string `json:"comparisonId"`
}

// CreateComparison records a drafting comparison and its converge job under
// the locks root → parent → the branches in id order: MinCount..MaxCount
// distinct branches of the parent, open and not asides (invalid_comparison,
// branch_closed); archived conversations are read-only.
func (s *Store) CreateComparison(ctx context.Context, in CreateComparisonInput, hooks ...TxHook) (ComparisonWrite, error) {
	ids, err := s.comparedIDs(in.LineIDs)
	if err != nil {
		return ComparisonWrite{}, err
	}
	criteria, err := domain.NormalizeCriteria(in.Criteria, s.limits.Diverge)
	if err != nil {
		return ComparisonWrite{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (ComparisonWrite, error) {
		parent, err := s.lockParent(ctx, q, in.Tenant, in.ParentLineID)
		if err != nil {
			return ComparisonWrite{}, err
		}
		if parent.line.ArchivedAt.Valid {
			return ComparisonWrite{}, domain.ErrLineArchived
		}
		if err := lockInOrder(ctx, q, ids); err != nil {
			return ComparisonWrite{}, err
		}
		if err := checkCompared(ctx, q, parent, ids); err != nil {
			return ComparisonWrite{}, err
		}
		return s.insertComparison(ctx, q, parent, in, ids, criteria)
	})
}

// comparedIDs are the distinct ids, in the caller's order, within the
// limits.
func (s *Store) comparedIDs(raw []string) ([]uuid.UUID, error) {
	l := s.limits.Diverge
	out := []uuid.UUID{}
	for _, r := range raw {
		id, ok := parseID(r)
		if !ok {
			return nil, domain.InvalidComparison("every option is a branch of this line")
		}
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	if len(out) < l.MinCount || len(out) > l.MaxCount {
		return nil, domain.InvalidComparison(fmt.Sprintf("a comparison has %d to %d branches", l.MinCount, l.MaxCount))
	}
	return out, nil
}

// checkCompared: every branch is an open, non-aside child of the parent.
func checkCompared(ctx context.Context, q *db.Queries, parent lockedParent, ids []uuid.UUID) error {
	for _, id := range ids {
		row, isBranch, err := branchRowFor(ctx, q, id)
		switch {
		case err != nil:
			return err
		case !isBranch || row.ParentLineID != parent.line.ID || row.TenantID != parent.line.TenantID:
			return domain.InvalidComparison("only branches of this line are compared")
		case row.Kind == domain.BranchKindAside:
			return domain.InvalidComparison("an aside is not compared")
		case row.Status != domain.BranchStatusOpen:
			return domain.ErrBranchClosed
		}
	}
	return nil
}

func (s *Store) insertComparison(ctx context.Context, q *db.Queries, parent lockedParent, in CreateComparisonInput, ids []uuid.UUID, criteria []string) (ComparisonWrite, error) {
	rawCriteria, _ := json.Marshal(criteria)
	row, err := q.InsertComparison(ctx, db.InsertComparisonParams{TenantID: parent.line.TenantID, ParentLineID: parent.line.ID, LineIds: ids, Criteria: rawCriteria, CreatedBy: in.Actor})
	if err != nil {
		return ComparisonWrite{}, fmt.Errorf("insert comparison: %w", err)
	}
	input, _ := json.Marshal(comparisonJobInput{ComparisonID: row.ID.String()})
	job, err := s.createJob(ctx, q, CreateJobInput{Tenant: parent.line.TenantID, Kind: JobKindConverge, Feature: in.Feature, LineID: parent.line.ID.String(), Input: input})
	if err != nil {
		return ComparisonWrite{}, err
	}
	if row, err = q.SetComparisonJob(ctx, db.SetComparisonJobParams{ID: row.ID, JobID: uuid.NullUUID{UUID: job.ID, Valid: true}}); err != nil {
		return ComparisonWrite{}, fmt.Errorf("set the comparison's job: %w", err)
	}
	started := jobFromRow(job)
	return ComparisonWrite{Comparison: comparisonFromRow(row), RootLineID: parent.rootID.String(), Job: &started}, nil
}

func comparisonFromRow(row db.TangentComparison) domain.Comparison {
	out := domain.Comparison{
		ID: row.ID.String(), ParentLineID: row.ParentLineID.String(), LineIDs: idStrings(row.LineIds), Criteria: []string{}, Status: row.Status,
		DecidedLineID: idString(row.DecidedLineID), CreatedBy: row.CreatedBy, DecidedBy: row.DecidedBy,
		CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(), DecidedAt: timePtr(row.DecidedAt),
	}
	_ = json.Unmarshal(row.Criteria, &out.Criteria)
	if len(row.Matrix) > 0 {
		var m domain.ComparisonMatrix
		if json.Unmarshal(row.Matrix, &m) == nil {
			out.Matrix = &m
		}
	}
	return out
}

// comparisonWrite completes a comparison with its conversation.
func comparisonWrite(ctx context.Context, q *db.Queries, row db.TangentComparison) (ComparisonWrite, error) {
	root, err := rootOf(ctx, q, row.ParentLineID)
	if err != nil {
		return ComparisonWrite{}, err
	}
	c := comparisonFromRow(row)
	c.RootLineID = root.String()
	return ComparisonWrite{Comparison: c, RootLineID: c.RootLineID}, nil
}

// comparisonOfTenant reads a comparison of the tenant.
func comparisonOfTenant(ctx context.Context, q *db.Queries, tenant, comparisonID string) (db.TangentComparison, error) {
	id, ok := parseID(comparisonID)
	if !ok {
		return db.TangentComparison{}, domain.ErrComparisonNotFound
	}
	row, err := q.GetComparison(ctx, id)
	if err != nil {
		return db.TangentComparison{}, lookup(err, domain.ErrComparisonNotFound, "get comparison")
	}
	if tenant != "" && row.TenantID != tenant {
		return db.TangentComparison{}, domain.ErrComparisonNotFound
	}
	return row, nil
}

// GetComparison reads a comparison of the tenant.
func (s *Store) GetComparison(ctx context.Context, tenant, comparisonID string) (domain.Comparison, error) {
	row, err := comparisonOfTenant(ctx, s.q, tenant, comparisonID)
	if err != nil {
		return domain.Comparison{}, err
	}
	out, err := comparisonWrite(ctx, s.q, row)
	return out.Comparison, err
}

// ComparisonList is the comparisons of branches of one line.
type ComparisonList struct {
	LineID      string
	RootLineID  string
	Comparisons []domain.Comparison
}

// comparisonListCap bounds one listing.
const comparisonListCap = 100

// ListComparisons lists the comparisons of the line's branches, newest first.
func (s *Store) ListComparisons(ctx context.Context, tenant, lineID string) (ComparisonList, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return ComparisonList{}, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return ComparisonList{}, err
	}
	rows, err := s.q.ListComparisonsOfLine(ctx, db.ListComparisonsOfLineParams{ParentLineID: line.ID, RowLimit: comparisonListCap})
	if err != nil {
		return ComparisonList{}, fmt.Errorf("list comparisons: %w", err)
	}
	out := ComparisonList{LineID: line.ID.String(), RootLineID: root.String(), Comparisons: []domain.Comparison{}}
	for _, row := range rows {
		c := comparisonFromRow(row)
		c.RootLineID = out.RootLineID
		out.Comparisons = append(out.Comparisons, c)
	}
	return out, nil
}

// ComparisonResult is a finished converge job: Written is false when the
// comparison no longer waited on it.
type ComparisonResult struct {
	Comparison domain.Comparison
	RootLineID string
	Job        Job
	Written    bool
}

// FinishComparison ends a converge job under the locks parent → comparison
// → job: done with the matrix (ready), or failed with failure (failed).
func (s *Store) FinishComparison(ctx context.Context, jobID string, matrix *domain.ComparisonMatrix, failure string, hooks ...TxHook) (ComparisonResult, error) {
	peek, err := s.GetJob(ctx, jobID)
	if err != nil {
		return ComparisonResult{}, err
	}
	var input comparisonJobInput
	_ = json.Unmarshal(peek.Input, &input)
	return runTx(ctx, s, hooks, func(q *db.Queries) (ComparisonResult, error) {
		row, err := comparisonOfTenant(ctx, q, "", input.ComparisonID)
		if err != nil {
			return ComparisonResult{}, err
		}
		if _, err := lockLineByID(ctx, q, row.ParentLineID); err != nil {
			return ComparisonResult{}, err
		}
		if row, err = q.GetComparisonForUpdate(ctx, row.ID); err != nil {
			return ComparisonResult{}, fmt.Errorf("lock comparison: %w", err)
		}
		job, err := lockJob(ctx, q, jobID)
		if err != nil {
			return ComparisonResult{}, err
		}
		return finishComparison(ctx, q, row, job, matrix, failure)
	})
}

func finishComparison(ctx context.Context, q *db.Queries, row db.TangentComparison, job db.TangentJob, matrix *domain.ComparisonMatrix, failure string) (ComparisonResult, error) {
	status, jobStatus, raw := domain.ComparisonReady, JobDone, []byte(nil)
	if failure != "" || matrix == nil {
		status, jobStatus = domain.ComparisonFailed, JobFailed
	} else {
		raw, _ = json.Marshal(matrix)
	}
	done, err := finishJob(ctx, q, job.ID, jobStatus, failure)
	if err != nil {
		return ComparisonResult{}, err
	}
	out := ComparisonResult{Job: jobFromRow(done), Written: true}
	updated, err := q.FinishComparison(ctx, db.FinishComparisonParams{Matrix: raw, Status: status, ID: row.ID, JobID: uuid.NullUUID{UUID: job.ID, Valid: true}})
	switch {
	case noRows(err):
		updated, out.Written = row, false
	case err != nil:
		return ComparisonResult{}, fmt.Errorf("write the comparison: %w", err)
	}
	write, err := comparisonWrite(ctx, q, updated)
	out.Comparison, out.RootLineID = write.Comparison, write.RootLineID
	return out, err
}

// FailComparisonOfJob marks the drafting comparison whose converge job timed
// out failed; nil when none waits on it.
func (s *Store) FailComparisonOfJob(ctx context.Context, jobID string) (*ComparisonWrite, error) {
	id, ok := parseID(jobID)
	if !ok {
		return nil, nil
	}
	row, err := s.q.FailComparisonOfJob(ctx, uuid.NullUUID{UUID: id, Valid: true})
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("fail the comparison: %w", err)
	}
	write, err := comparisonWrite(ctx, s.q, row)
	return &write, err
}
