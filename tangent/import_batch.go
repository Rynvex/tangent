package tangent

import (
	"context"
	"errors"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// ImportBatchQuery selects one page of the tenant's import batches (B25).
type ImportBatchQuery = store.ImportBatchQuery

// ImportBatchPage is one page of import batches, newest first.
type ImportBatchPage = store.ImportBatchPage

// DeletedImportBatch is what undoing an import batch did.
type DeletedImportBatch = domain.ImportBatchDeletion

// ImportBatches lists the tenant's import batches, newest first, with how
// many of their lines still exist and how many of those are still main
// lines (B25). Read-only.
func (e *Engine) ImportBatches(ctx context.Context, scope Scope, q ImportBatchQuery) (ImportBatchPage, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return ImportBatchPage{}, err
	}
	return e.store.ListImportBatches(ctx, scope.Tenant, q)
}

// DeleteImportBatch undoes an import batch of the tenant (B25): each line
// of the batch that is still a main line has its tree deleted like
// DeleteTree does it (one transaction, its own locks, hooks and
// line.deleted event per tree; the batch is not deleted atomically), unless
// a line of the tree is answering (kept, busy) or, without force, the
// conversation was used since the import (kept, changed: new messages or
// branches, an edited card, notes, memos, terms or parked thoughts). An
// attached line is kept (attached). When nothing is kept the batch row goes
// too. Deleted and Kept are in import order. Another tenant's batch, or
// none, is import_batch_not_found.
// InTx hooks receive store.DeletedTree for each tree (before its rows go),
// then store.RemovedImportBatch when the batch row is removed.
func (e *Engine) DeleteImportBatch(ctx context.Context, scope Scope, batchID string, force bool, opts ...TxOption) (DeletedImportBatch, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return DeletedImportBatch{}, err
	}
	lines, err := e.store.ImportBatchLines(ctx, scope.Tenant, batchID)
	if err != nil {
		return DeletedImportBatch{}, err
	}
	out := DeletedImportBatch{Deleted: []string{}, Kept: []domain.KeptImportLine{}}
	for _, line := range lines {
		reason, err := e.deleteImportedTree(ctx, scope, line, batchID, force, opts)
		switch {
		case err != nil:
			return DeletedImportBatch{}, err
		case reason == "":
			out.Deleted = append(out.Deleted, line.LineID)
		case reason != importGone:
			out.Kept = append(out.Kept, domain.KeptImportLine{LineID: line.LineID, Reason: reason})
		}
	}
	if len(out.Kept) == 0 {
		if _, err := e.store.RemoveImportBatch(ctx, scope.Tenant, batchID, hooksOf(opts)...); err != nil && !errors.Is(err, domain.ErrImportBatchNotFound) {
			return DeletedImportBatch{}, err
		}
	}
	return out, nil
}

// importGone marks a line that left the batch (or went) meanwhile: neither
// deleted nor kept.
const importGone = "gone"

// deleteImportedTree deletes one line's tree of a batch being undone and
// returns "" when it went, or why it stayed (domain.ImportKept*, or
// importGone).
func (e *Engine) deleteImportedTree(ctx context.Context, scope Scope, line store.ImportBatchLine, batchID string, force bool, opts []TxOption) (string, error) {
	if line.Attached {
		return domain.ImportKeptAttached, nil
	}
	deleted, err := e.store.DeleteImportedTree(ctx, scope.Tenant, line.LineID, batchID, force, hooksOf(opts)...)
	switch {
	case err == nil:
		e.treeDeleted(ctx, scope, deleted)
		return "", nil
	case errors.Is(err, store.ErrImportedTreeChanged):
		return domain.ImportKeptChanged, nil
	case errors.Is(err, domain.ErrDeleteBusy):
		return domain.ImportKeptBusy, nil
	case errors.Is(err, domain.ErrDeleteNotMainLine):
		return domain.ImportKeptAttached, nil
	case errors.Is(err, domain.ErrLineNotFound):
		return importGone, nil
	}
	return "", err
}
