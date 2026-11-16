package store

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// ArchiveTree archives or unarchives a main line together with every branch
// of its tree, in one transaction under the locks main line → branches in id
// order, and returns the changed lines with the main line first. A branch is
// refused: it ends with discard, not archive.
func (s *Store) ArchiveTree(ctx context.Context, tenant, lineID string, archived bool, hooks ...TxHook) ([]domain.LineView, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) ([]domain.LineView, error) {
		root, err := s.lockMainLine(ctx, q, tenant, lineID, domain.ErrArchiveNotMainLine)
		if err != nil {
			return nil, err
		}
		below, err := treeLineIDs(ctx, q, root.ID)
		if err != nil {
			return nil, err
		}
		ids := append([]uuid.UUID{root.ID}, below...)
		if err := lockInOrder(ctx, q, below); err != nil {
			return nil, err
		}
		if _, err := q.ArchiveLines(ctx, db.ArchiveLinesParams{Archived: archived, LineIds: ids}); err != nil {
			return nil, fmt.Errorf("archive tree: %w", err)
		}
		return s.hydrateIDs(ctx, q, ids)
	})
}

// lockMainLine locks a line of the tenant and refuses a branch with notMain.
func (s *Store) lockMainLine(ctx context.Context, q *db.Queries, tenant, lineID string, notMain error) (db.TangentLine, error) {
	root, err := s.lockLine(ctx, q, tenant, lineID)
	if err != nil {
		return db.TangentLine{}, err
	}
	if _, isBranch, err := branchRowFor(ctx, q, root.ID); err != nil {
		return db.TangentLine{}, err
	} else if isBranch {
		return db.TangentLine{}, notMain
	}
	return root, nil
}

// treeLineIDs lists every branch line of a main line's tree (by root, so no
// recursion and no cap), in id order.
func treeLineIDs(ctx context.Context, q *db.Queries, root uuid.UUID) ([]uuid.UUID, error) {
	ids, err := q.ListTreeLineIDs(ctx, root)
	if err != nil {
		return nil, fmt.Errorf("list tree: %w", err)
	}
	return ids, nil
}

// MessageHostMeta is the host data of one message of a deleted line.
type MessageHostMeta struct {
	LineID    string
	MessageID string
	HostMeta  json.RawMessage
}

// DeletedTree is what deleting a conversation removed: every line id (the
// main line first), the lines' host data and the host data of their messages
// (only non-empty objects), so a host can clean up what it keeps elsewhere.
type DeletedTree struct {
	RootLineID   string
	LineIDs      []string
	LineHostMeta map[string]json.RawMessage
	Messages     []MessageHostMeta
	// PendingJobIDs are the jobs that were still pending on the deleted
	// lines (they are deleted with them), so their runs can be stopped. No
	// turn can be pending: a tree that is answering is not deleted.
	PendingJobIDs []string
}

// DeleteTree removes a whole conversation: the main line, every branch below
// it, their messages, notes, cuts and jobs. Locks are the main line first,
// then the branches in id order. It refuses a branch (ErrDeleteNotMainLine)
// and refuses while any line of the tree is answering (ErrDeleteBusy). The
// hooks run before the rows are deleted, so they can still read them.
func (s *Store) DeleteTree(ctx context.Context, tenant, rootID string, hooks ...TxHook) (DeletedTree, error) {
	return s.deleteTree(ctx, tenant, rootID, nil, hooks)
}

// deleteTree is DeleteTree; guard, when set, runs under the locks (after the
// busy check, before the hooks) and its error refuses the delete.
func (s *Store) deleteTree(ctx context.Context, tenant, rootID string, guard func(q *db.Queries, root uuid.UUID) error, hooks []TxHook) (DeletedTree, error) {
	return runTxWith(ctx, s, func(q *db.Queries, tx pgx.Tx) (DeletedTree, error) {
		root, err := s.lockMainLine(ctx, q, tenant, rootID, domain.ErrDeleteNotMainLine)
		if err != nil {
			return DeletedTree{}, err
		}
		below, err := treeLineIDs(ctx, q, root.ID)
		if err != nil {
			return DeletedTree{}, err
		}
		ids, err := lockLines(ctx, q, root.ID, below)
		if err != nil {
			return DeletedTree{}, err
		}
		if guard != nil {
			if err := guard(q, root.ID); err != nil {
				return DeletedTree{}, err
			}
		}
		out, err := readDeletedTree(ctx, q, root.ID, ids)
		if err != nil {
			return DeletedTree{}, err
		}
		if err := runHooks(ctx, tx, hooks, out); err != nil {
			return DeletedTree{}, err
		}
		if err := q.DeleteLines(ctx, db.DeleteLinesParams{TenantID: tenant, LineIds: ids}); err != nil {
			return DeletedTree{}, fmt.Errorf("delete tree: %w", err)
		}
		return out, nil
	})
}

// lockLines locks the lines below top (top is already locked) in id order
// and refuses when a line of the set, top included, is answering. It
// returns the ids, top first.
func lockLines(ctx context.Context, q *db.Queries, top uuid.UUID, below []uuid.UUID) ([]uuid.UUID, error) {
	if err := lockInOrder(ctx, q, below); err != nil {
		return nil, err
	}
	ids := append([]uuid.UUID{top}, below...)
	busy, err := q.CountBusyLines(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("check busy lines: %w", err)
	}
	if busy > 0 {
		return nil, domain.ErrDeleteBusy
	}
	return ids, nil
}

// lockInOrder locks a set of lines in id order; one that is gone is skipped.
func lockInOrder(ctx context.Context, q *db.Queries, ids []uuid.UUID) error {
	sorted := slices.Clone(ids)
	slices.SortFunc(sorted, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
	for _, id := range sorted {
		if _, err := q.GetLineForUpdate(ctx, id); err != nil && !noRows(err) {
			return fmt.Errorf("lock branch line: %w", err)
		}
	}
	return nil
}

// readDeletedTree collects the ids and host data of the lines about to go.
func readDeletedTree(ctx context.Context, q *db.Queries, root uuid.UUID, ids []uuid.UUID) (DeletedTree, error) {
	out := DeletedTree{RootLineID: root.String(), LineIDs: idStrings(ids), LineHostMeta: map[string]json.RawMessage{}, Messages: []MessageHostMeta{}}
	lines, err := q.GetLinesByIDs(ctx, ids)
	if err != nil {
		return out, fmt.Errorf("read lines: %w", err)
	}
	for _, line := range lines {
		out.LineHostMeta[line.ID.String()] = hostMeta(line.HostMeta)
	}
	rows, err := q.ListMessageHostMeta(ctx, ids)
	if err != nil {
		return out, fmt.Errorf("read message host data: %w", err)
	}
	for _, row := range rows {
		out.Messages = append(out.Messages, MessageHostMeta{LineID: row.LineID.String(), MessageID: row.ID.String(), HostMeta: hostMeta(row.HostMeta)})
	}
	jobs, err := q.ListPendingJobIDsForLines(ctx, ids)
	if err != nil {
		return out, fmt.Errorf("read pending jobs: %w", err)
	}
	out.PendingJobIDs = idStrings(jobs)
	return out, nil
}
