package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Memos (B13) belong to the main line of their conversation: every write
// locks that row and nothing else (a memo never changes a line), so the
// per-conversation cap holds under concurrent writers and an archived
// conversation refuses every write. No prompt and no job reads them.

// CreateMemoInput writes a memo. LineID is the path's line (any line of the
// conversation); NodeLineID the node it is written on (LineID when empty),
// which must be in the same conversation.
type CreateMemoInput struct {
	Tenant     string
	LineID     string
	NodeLineID string
	Text       string
	Actor      string
}

// CreateMemo writes a memo. Refusals: an empty or long text, a node that is
// not a line of this conversation, an archived conversation, the cap.
func (s *Store) CreateMemo(ctx context.Context, in CreateMemoInput, hooks ...TxHook) (domain.Memo, error) {
	text, err := domain.NormalizeMemoText(in.Text, s.limits.Memo)
	if err != nil {
		return domain.Memo{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.Memo, error) {
		line, err := s.lineRow(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return domain.Memo{}, err
		}
		root, err := lockOpenRootOf(ctx, q, line.ID)
		if err != nil {
			return domain.Memo{}, err
		}
		node, err := s.memoNode(ctx, q, in.Tenant, root.ID, line.ID, in.NodeLineID)
		if err != nil {
			return domain.Memo{}, err
		}
		if count, err := q.CountMemos(ctx, root.ID); err != nil {
			return domain.Memo{}, fmt.Errorf("count memos: %w", err)
		} else if int(count) >= s.limits.Memo.MaxPerTree {
			return domain.Memo{}, domain.ErrMemoLimit
		}
		nodeID := uuid.NullUUID{UUID: node, Valid: true}
		label, err := s.sourceLabel(ctx, q, root.ID, nodeID, uuid.NullUUID{}, uuid.NullUUID{})
		if err != nil {
			return domain.Memo{}, err
		}
		row, err := q.InsertMemo(ctx, db.InsertMemoParams{
			TenantID: root.TenantID, RootLineID: root.ID, LineID: nodeID, SourceLabel: label, Text: text, CreatedBy: strings.TrimSpace(in.Actor),
		})
		if err != nil {
			return domain.Memo{}, fmt.Errorf("insert memo: %w", err)
		}
		return memoView(row), nil
	})
}

// memoNode is the node a memo is written on: the path's line when none is
// named, else the named line, which must belong to the root's conversation.
func (s *Store) memoNode(ctx context.Context, q *db.Queries, tenant string, rootID, pathLine uuid.UUID, nodeLineID string) (uuid.UUID, error) {
	if strings.TrimSpace(nodeLineID) == "" {
		return pathLine, nil
	}
	node, err := s.lineRow(ctx, q, tenant, nodeLineID)
	if err != nil {
		return uuid.UUID{}, err
	}
	nodeRoot, err := rootOf(ctx, q, node.ID)
	if err != nil {
		return uuid.UUID{}, err
	}
	if nodeRoot != rootID {
		return uuid.UUID{}, domain.ErrLineNotFound
	}
	return node.ID, nil
}

// MemoList is a conversation's memos, oldest first.
type MemoList struct {
	RootLineID string
	Memos      []domain.Memo
}

// ListMemos lists the memos of the line's conversation; with nodeLineID,
// only those written on that node (a line of another conversation is
// line_not_found).
func (s *Store) ListMemos(ctx context.Context, tenant, lineID, nodeLineID string) (MemoList, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return MemoList{}, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return MemoList{}, err
	}
	params := db.ListMemosParams{RootLineID: root, RowLimit: int32(s.limits.Memo.MaxPerTree)}
	if strings.TrimSpace(nodeLineID) != "" {
		node, err := s.memoNode(ctx, s.q, tenant, root, line.ID, nodeLineID)
		if err != nil {
			return MemoList{}, err
		}
		params.LineID = uuid.NullUUID{UUID: node, Valid: true}
	}
	rows, err := s.q.ListMemos(ctx, params)
	if err != nil {
		return MemoList{}, fmt.Errorf("list memos: %w", err)
	}
	memos := make([]domain.Memo, 0, len(rows))
	for _, row := range rows {
		memos = append(memos, memoView(row))
	}
	return MemoList{RootLineID: root.String(), Memos: memos}, nil
}

// UpdateMemo replaces a memo's text.
func (s *Store) UpdateMemo(ctx context.Context, tenant, memoID, text string, hooks ...TxHook) (domain.Memo, error) {
	clean, err := domain.NormalizeMemoText(text, s.limits.Memo)
	if err != nil {
		return domain.Memo{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.Memo, error) {
		row, err := s.lockMemo(ctx, q, tenant, memoID)
		if err != nil {
			return domain.Memo{}, err
		}
		updated, err := q.UpdateMemoText(ctx, db.UpdateMemoTextParams{ID: row.ID, Text: clean})
		if err != nil {
			return domain.Memo{}, lookup(err, domain.ErrMemoNotFound, "update memo")
		}
		return memoView(updated), nil
	})
}

// DeleteMemo removes a memo for good and returns it as it was.
func (s *Store) DeleteMemo(ctx context.Context, tenant, memoID string, hooks ...TxHook) (domain.Memo, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.Memo, error) {
		row, err := s.lockMemo(ctx, q, tenant, memoID)
		if err != nil {
			return domain.Memo{}, err
		}
		if err := q.DeleteMemo(ctx, row.ID); err != nil {
			return domain.Memo{}, fmt.Errorf("delete memo: %w", err)
		}
		return memoView(row), nil
	})
}

// lockMemo locks the memo's main line (refusing an archived conversation)
// and reads the memo again under that lock: a concurrent delete is
// memo_not_found, never a write to a gone row.
func (s *Store) lockMemo(ctx context.Context, q *db.Queries, tenant, memoID string) (db.TangentMemo, error) {
	id, ok := parseID(memoID)
	if !ok {
		return db.TangentMemo{}, domain.ErrMemoNotFound
	}
	before, err := q.GetMemo(ctx, id)
	if err != nil {
		return db.TangentMemo{}, lookup(err, domain.ErrMemoNotFound, "get memo")
	}
	if before.TenantID != tenant {
		return db.TangentMemo{}, domain.ErrMemoNotFound
	}
	root, err := lockLineByID(ctx, q, before.RootLineID)
	if err != nil {
		return db.TangentMemo{}, err
	}
	if root.ArchivedAt.Valid {
		return db.TangentMemo{}, domain.ErrLineArchived
	}
	row, err := q.GetMemo(ctx, id)
	if err != nil {
		return db.TangentMemo{}, lookup(err, domain.ErrMemoNotFound, "get memo")
	}
	// A detach or an attach moved the memo to another tree between the read and the lock: that tree's lock is not held (retried).
	if row.RootLineID != root.ID {
		return db.TangentMemo{}, errBranchMoved
	}
	return row, nil
}

func memoView(row db.TangentMemo) domain.Memo {
	return domain.Memo{
		ID: row.ID.String(), RootLineID: row.RootLineID.String(), LineID: idString(row.LineID), SourceLabel: row.SourceLabel,
		Text: row.Text, CreatedBy: row.CreatedBy, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}
