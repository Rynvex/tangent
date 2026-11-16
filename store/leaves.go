package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Branch leaves. A leaf belongs to its branch line: writes lock that line
// (the last lock of root → parent → child), so a leaf written inside a merge
// or a discard needs no lock of its own. A leaf a draft job wrote keeps the
// job's id until the operator rewrites it; only such a leaf, or none, is
// replaced by a later draft.

// GetLeaf reads the leaf of a branch; nil when it has none.
func (s *Store) GetLeaf(ctx context.Context, tenant, lineID string) (*domain.Leaf, error) {
	row, err := s.branchOfTenant(ctx, s.q, tenant, lineID)
	if err != nil {
		return nil, err
	}
	leaf, err := s.q.GetLeaf(ctx, row.LineID)
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get leaf: %w", err)
	}
	out := leafFromRow(leaf)
	return &out, nil
}

// branchOfTenant reads a branch row of the tenant; ErrBranchNotFound for a
// main line or another tenant's line.
func (s *Store) branchOfTenant(ctx context.Context, q *db.Queries, tenant, lineID string) (db.TangentBranch, error) {
	id, ok := parseID(lineID)
	if !ok {
		return db.TangentBranch{}, domain.ErrBranchNotFound
	}
	row, isBranch, err := branchRowFor(ctx, q, id)
	if err != nil {
		return db.TangentBranch{}, err
	}
	if !isBranch || row.TenantID != tenant {
		return db.TangentBranch{}, domain.ErrBranchNotFound
	}
	return row, nil
}

// PutLeafInput is a leaf the operator writes or confirms.
type PutLeafInput struct {
	Tenant string
	LineID string
	Leaf   domain.LeafInput
	Actor  string
}

// PutLeaf writes the operator's leaf (confirmed) over whatever the branch
// had. An archived conversation is read-only.
func (s *Store) PutLeaf(ctx context.Context, in PutLeafInput, hooks ...TxHook) (domain.Leaf, error) {
	leaf, problems := domain.NormalizeLeaf(in.Leaf, s.limits.Leaf)
	if len(problems) > 0 {
		return domain.Leaf{}, domain.LeafError(problems)
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.Leaf, error) {
		held, err := s.lockLeafBranch(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return domain.Leaf{}, err
		}
		return upsertLeaf(ctx, q, held.row, leaf, domain.LeafStatusConfirmed, uuid.NullUUID{}, in.Actor)
	})
}

// DeleteLeaf removes a branch's leaf; ErrLeafNotFound when it has none.
func (s *Store) DeleteLeaf(ctx context.Context, tenant, lineID string, hooks ...TxHook) (domain.Leaf, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.Leaf, error) {
		held, err := s.lockLeafBranch(ctx, q, tenant, lineID)
		if err != nil {
			return domain.Leaf{}, err
		}
		row, err := q.DeleteLeaf(ctx, held.row.LineID)
		if err != nil {
			return domain.Leaf{}, lookup(err, domain.ErrLeafNotFound, "delete leaf")
		}
		return leafFromRow(row), nil
	})
}

// lockLeafBranch locks a branch line for a leaf write and refuses an
// archived conversation.
func (s *Store) lockLeafBranch(ctx context.Context, q *db.Queries, tenant, lineID string) (lockedBranch, error) {
	held, err := s.lockBranch(ctx, q, tenant, lineID, false)
	if err != nil {
		return lockedBranch{}, err
	}
	if held.child.ArchivedAt.Valid {
		return lockedBranch{}, domain.ErrLineArchived
	}
	return held, nil
}

// LeafWrite is a leaf written inside another write's transaction (a merge's
// conclusion, a discard's dead end), whose locks already cover the branch.
type LeafWrite struct {
	LineID string
	Leaf   domain.LeafInput
	Status string
	Actor  string
}

// WriteLeaf writes a branch's leaf inside a write's transaction (a TxHook).
func (s *Store) WriteLeaf(ctx context.Context, tx Tx, in LeafWrite) (domain.Leaf, error) {
	leaf, problems := domain.NormalizeLeaf(in.Leaf, s.limits.Leaf)
	if len(problems) > 0 {
		return domain.Leaf{}, domain.LeafError(problems)
	}
	q := db.New(tx)
	id, ok := parseID(in.LineID)
	if !ok {
		return domain.Leaf{}, domain.ErrBranchNotFound
	}
	row, isBranch, err := branchRowFor(ctx, q, id)
	if err != nil {
		return domain.Leaf{}, err
	}
	if !isBranch {
		return domain.Leaf{}, domain.ErrBranchNotFound
	}
	return upsertLeaf(ctx, q, row, leaf, in.Status, uuid.NullUUID{}, in.Actor)
}

// LeafDraftResult is a finished leaf_draft job: Written is false when the
// branch has a leaf the operator (or a card) wrote, which a draft never
// replaces.
type LeafDraftResult struct {
	Job     Job
	Leaf    domain.Leaf
	Written bool
}

// FinishLeafDraft ends a pending leaf_draft job as done and writes its leaf
// with the given status, under the locks branch line → job. A job that is
// no longer pending returns ErrJobNotPending.
func (s *Store) FinishLeafDraft(ctx context.Context, jobID string, draft domain.LeafInput, status string, hooks ...TxHook) (LeafDraftResult, error) {
	leaf, problems := domain.NormalizeLeaf(draft, s.limits.Leaf)
	if len(problems) > 0 {
		return LeafDraftResult{}, domain.LeafError(problems)
	}
	peek, err := s.GetJob(ctx, jobID)
	if err != nil {
		return LeafDraftResult{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (LeafDraftResult, error) {
		held, err := s.lockBranch(ctx, q, peek.TenantID, peek.LineID, false)
		if err != nil {
			return LeafDraftResult{}, err
		}
		job, err := lockJob(ctx, q, peek.ID)
		if err != nil {
			return LeafDraftResult{}, err
		}
		done, err := finishJob(ctx, q, job.ID, JobDone, "")
		if err != nil {
			return LeafDraftResult{}, err
		}
		out := LeafDraftResult{Job: jobFromRow(done)}
		existing, err := q.GetLeaf(ctx, held.row.LineID)
		if err == nil && !existing.SourceJobID.Valid {
			out.Leaf = leafFromRow(existing)
			return out, nil
		}
		if err != nil && !noRows(err) {
			return LeafDraftResult{}, fmt.Errorf("get leaf: %w", err)
		}
		out.Leaf, err = upsertLeaf(ctx, q, held.row, leaf, status, uuid.NullUUID{UUID: job.ID, Valid: true}, "")
		out.Written = err == nil
		return out, err
	})
}

func upsertLeaf(ctx context.Context, q *db.Queries, branch db.TangentBranch, leaf domain.LeafInput, status string, job uuid.NullUUID, actor string) (domain.Leaf, error) {
	if status != domain.LeafStatusDraft && status != domain.LeafStatusConfirmed {
		return domain.Leaf{}, invalidInput("a leaf is a draft or confirmed")
	}
	row, err := q.UpsertLeaf(ctx, db.UpsertLeafParams{
		LineID: branch.LineID, TenantID: branch.TenantID, RootLineID: branch.RootLineID, Kind: leaf.Kind, Line: leaf.Line, Body: leaf.Body,
		Status: status, SourceJobID: job, CreatedBy: strings.TrimSpace(actor),
	})
	if err != nil {
		return domain.Leaf{}, fmt.Errorf("write leaf: %w", err)
	}
	return leafFromRow(row), nil
}

func leafFromRow(row db.TangentLeaf) domain.Leaf {
	return domain.Leaf{
		LineID: row.LineID.String(), RootLineID: row.RootLineID.String(), Kind: row.Kind, Line: row.Line, Body: row.Body, Status: row.Status,
		AIDrafted: row.SourceJobID.Valid, CreatedBy: row.CreatedBy, CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(),
	}
}

// leafSummary is the outline's view of a leaf (nil without one).
func leafSummary(kind, line, status pgtype.Text) *domain.LeafSummary {
	if !kind.Valid {
		return nil
	}
	return &domain.LeafSummary{Kind: kind.String, Line: line.String, Status: status.String}
}
