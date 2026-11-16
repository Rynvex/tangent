package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Import batches (B25): the imports of one client action share a batch the
// client named, so the batch can be listed and undone later. An import
// upserts the batch row (locked until it commits) and records on its main
// line the batch and the tree as it left it (import_seq, the newest message
// seq; import_activity_at, the main line's activity time), which is how
// undoing the batch tells a conversation that was used since.

// Bounds of one ListImportBatches page.
const (
	defaultImportBatchPage = 50
	maxImportBatchPage     = 200
)

// ErrImportedTreeChanged: the imported conversation was used since the
// import, so DeleteImportedTree left it (without force).
var ErrImportedTreeChanged = errors.New("store: the imported conversation was used since the import")

// upsertImportBatch creates or reuses an import's batch (none without one).
func upsertImportBatch(ctx context.Context, q *db.Queries, tenant string, in ImportLineInput) error {
	if in.Batch.ID == uuid.Nil {
		return nil
	}
	_, err := q.UpsertImportBatch(ctx, db.UpsertImportBatchParams{ID: in.Batch.ID, TenantID: tenant, Label: in.Batch.Label, CreatedBy: in.CreatedBy})
	return lookup(err, domain.ErrImportBatchNotFound, "write the import batch")
}

// markImportedLine puts a new imported main line in its batch (none without
// one) and records the tree as the import leaves it.
func markImportedLine(ctx context.Context, q *db.Queries, lineID uuid.UUID, batch domain.ImportBatchRef) error {
	if batch.ID == uuid.Nil {
		return nil
	}
	if err := q.MarkImportedLine(ctx, db.MarkImportedLineParams{ID: lineID, BatchID: uuid.NullUUID{UUID: batch.ID, Valid: true}}); err != nil {
		return fmt.Errorf("mark the imported line: %w", err)
	}
	return nil
}

// ImportBatchQuery selects one page of a tenant's import batches; Cursor is
// the NextCursor of the previous page.
type ImportBatchQuery struct {
	Limit  int
	Cursor string
}

// ImportBatchPage is one page of import batches, newest first. NextCursor
// is "" on the last page.
type ImportBatchPage struct {
	Batches    []domain.ImportBatch
	NextCursor string
}

// ListImportBatches returns one keyset page of the tenant's import batches.
func (s *Store) ListImportBatches(ctx context.Context, tenant string, in ImportBatchQuery) (ImportBatchPage, error) {
	limit := clampLimit(in.Limit, defaultImportBatchPage, maxImportBatchPage)
	params := db.ListImportBatchesParams{TenantID: tenant, RowLimit: limit + 1}
	if in.Cursor != "" {
		at, id, err := decodeKeysetCursor(in.Cursor)
		if err != nil {
			return ImportBatchPage{}, err
		}
		params.AfterAt = pgtype.Timestamptz{Time: at, Valid: true}
		params.AfterID = uuid.NullUUID{UUID: id, Valid: true}
	}
	rows, err := s.q.ListImportBatches(ctx, params)
	if err != nil {
		return ImportBatchPage{}, fmt.Errorf("list import batches: %w", err)
	}
	page := ImportBatchPage{Batches: make([]domain.ImportBatch, 0, len(rows))}
	if len(rows) > int(limit) {
		rows = rows[:limit]
		page.NextCursor = encodeKeysetCursor(rows[len(rows)-1].CreatedAt, rows[len(rows)-1].ID)
	}
	for _, row := range rows {
		page.Batches = append(page.Batches, domain.ImportBatch{
			ID: row.ID.String(), Label: row.Label, CreatedAt: row.CreatedAt.UTC(), LineCount: int(row.LineCount), StandaloneCount: int(row.StandaloneCount),
		})
	}
	return page, nil
}

// ImportBatchLine is a line of a batch: Attached when it is a branch now.
type ImportBatchLine struct {
	LineID   string
	Attached bool
}

// ImportBatchLines lists the lines of a batch of the tenant in import
// order; ErrImportBatchNotFound when the tenant has no such batch.
func (s *Store) ImportBatchLines(ctx context.Context, tenant, batchID string) ([]ImportBatchLine, error) {
	id, ok := parseID(batchID)
	if !ok {
		return nil, domain.ErrImportBatchNotFound
	}
	if _, err := s.q.GetImportBatch(ctx, db.GetImportBatchParams{ID: id, TenantID: tenant}); err != nil {
		return nil, lookup(err, domain.ErrImportBatchNotFound, "get the import batch")
	}
	rows, err := s.q.ListImportBatchLines(ctx, db.ListImportBatchLinesParams{TenantID: tenant, BatchID: uuid.NullUUID{UUID: id, Valid: true}})
	if err != nil {
		return nil, fmt.Errorf("list the batch's lines: %w", err)
	}
	out := make([]ImportBatchLine, 0, len(rows))
	for _, row := range rows {
		out = append(out, ImportBatchLine{LineID: row.ID.String(), Attached: row.Attached})
	}
	return out, nil
}

// DeleteImportedTree is DeleteTree for undoing an import batch: under the
// same locks it also refuses a main line that left the batch
// (ErrLineNotFound) and, without force, one whose tree was used since the
// import (ErrImportedTreeChanged).
func (s *Store) DeleteImportedTree(ctx context.Context, tenant, rootID, batchID string, force bool, hooks ...TxHook) (DeletedTree, error) {
	batch, ok := parseID(batchID)
	if !ok {
		return DeletedTree{}, domain.ErrImportBatchNotFound
	}
	guard := func(q *db.Queries, root uuid.UUID) error {
		row, err := q.ImportedTreeChanged(ctx, root)
		switch {
		case err != nil:
			return lookup(err, domain.ErrLineNotFound, "check the imported tree")
		case !row.ImportBatchID.Valid || row.ImportBatchID.UUID != batch:
			return domain.ErrLineNotFound
		case row.Changed && !force:
			return ErrImportedTreeChanged
		}
		return nil
	}
	return s.deleteTree(ctx, tenant, rootID, guard, hooks)
}

// RemovedImportBatch is what removing a batch row did: Removed is false
// when lines of the batch still exist (an import of the batch committed
// meanwhile), and the row stays.
type RemovedImportBatch struct {
	BatchID string
	Removed bool
}

// RemoveImportBatch deletes a batch row of the tenant once none of its
// lines exist, under the row's lock (an import of the batch holds it until
// it commits, so its line is counted).
func (s *Store) RemoveImportBatch(ctx context.Context, tenant, batchID string, hooks ...TxHook) (RemovedImportBatch, error) {
	id, ok := parseID(batchID)
	if !ok {
		return RemovedImportBatch{}, domain.ErrImportBatchNotFound
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (RemovedImportBatch, error) {
		out := RemovedImportBatch{BatchID: id.String()}
		if _, err := q.LockImportBatch(ctx, db.LockImportBatchParams{ID: id, TenantID: tenant}); err != nil {
			return out, lookup(err, domain.ErrImportBatchNotFound, "lock the import batch")
		}
		left, err := q.CountImportBatchLines(ctx, db.CountImportBatchLinesParams{TenantID: tenant, BatchID: uuid.NullUUID{UUID: id, Valid: true}})
		if err != nil || left > 0 {
			return out, wrapErr(err, "count the batch's lines")
		}
		if err := q.DeleteImportBatch(ctx, db.DeleteImportBatchParams{ID: id, TenantID: tenant}); err != nil {
			return out, fmt.Errorf("delete the import batch: %w", err)
		}
		out.Removed = true
		return out, nil
	})
}
