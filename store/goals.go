package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Conversation goals. A goal belongs to the main line: every write locks
// that row first (a write through a branch resolves to it), so a goal
// written while a suggestion is accepted (main line → suggestion) follows
// the inbox's lock order.

// GetGoal reads the goal of the line's conversation; nil when it has none.
func (s *Store) GetGoal(ctx context.Context, tenant, lineID string) (*domain.Goal, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return nil, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return nil, err
	}
	row, err := s.q.GetGoal(ctx, root)
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get goal: %w", err)
	}
	goal := goalFromRow(row)
	return &goal, nil
}

// PutGoalInput writes the goal of the line's conversation. KeepExisting
// leaves a goal that is already there (a proposal the model wrote by
// itself never replaces one).
type PutGoalInput struct {
	Tenant       string
	LineID       string
	Text         string
	Source       string
	Actor        string
	KeepExisting bool
}

// GoalWrite is a goal write: Written is false when KeepExisting kept the
// goal that was there (Goal is then that one).
type GoalWrite struct {
	Goal    domain.Goal
	Written bool
}

// PutGoal writes a conversation's goal; an archived conversation is
// read-only. Hooks receive the goal (domain.Goal).
func (s *Store) PutGoal(ctx context.Context, in PutGoalInput, hooks ...TxHook) (GoalWrite, error) {
	text, err := domain.NormalizeGoalText(in.Text, s.limits.Goal)
	if err != nil {
		return GoalWrite{}, err
	}
	if in.Source != domain.GoalSourceManual && in.Source != domain.GoalSourceAI {
		return GoalWrite{}, invalidInput("a goal's source is manual or ai")
	}
	return runTxWith(ctx, s, func(q *db.Queries, tx pgx.Tx) (GoalWrite, error) {
		root, err := s.lockOpenRoot(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return GoalWrite{}, err
		}
		out, err := s.writeGoal(ctx, q, root, text, in)
		if err != nil {
			return GoalWrite{}, err
		}
		return out, runHooks(ctx, tx, hooks, out.Goal)
	})
}

func (s *Store) writeGoal(ctx context.Context, q *db.Queries, root db.TangentLine, text string, in PutGoalInput) (GoalWrite, error) {
	if in.KeepExisting {
		existing, err := q.GetGoal(ctx, root.ID)
		if err == nil {
			return GoalWrite{Goal: goalFromRow(existing)}, nil
		}
		if !noRows(err) {
			return GoalWrite{}, fmt.Errorf("get goal: %w", err)
		}
	}
	row, err := q.UpsertGoal(ctx, db.UpsertGoalParams{
		RootLineID: root.ID, TenantID: root.TenantID, Text: text, Source: in.Source, UpdatedBy: strings.TrimSpace(in.Actor),
	})
	if err != nil {
		return GoalWrite{}, fmt.Errorf("write goal: %w", err)
	}
	return GoalWrite{Goal: goalFromRow(row), Written: true}, nil
}

// DeleteGoal removes a conversation's goal; ErrGoalNotFound without one.
func (s *Store) DeleteGoal(ctx context.Context, tenant, lineID string, hooks ...TxHook) (domain.Goal, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.Goal, error) {
		root, err := s.lockOpenRoot(ctx, q, tenant, lineID)
		if err != nil {
			return domain.Goal{}, err
		}
		row, err := q.DeleteGoal(ctx, root.ID)
		if err != nil {
			return domain.Goal{}, lookup(err, domain.ErrGoalNotFound, "delete goal")
		}
		return goalFromRow(row), nil
	})
}

func goalFromRow(row db.TangentGoal) domain.Goal {
	return domain.Goal{
		RootLineID: row.RootLineID.String(), Text: row.Text, Source: row.Source, UpdatedBy: row.UpdatedBy,
		CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(),
	}
}

// GoalOfRoot reads the goal of a main line the caller already resolved
// under its tenant (a turn's tree); nil without one.
func (s *Store) GoalOfRoot(ctx context.Context, rootLineID string) (*domain.Goal, error) {
	id, ok := parseID(rootLineID)
	if !ok {
		return nil, nil
	}
	row, err := s.q.GetGoal(ctx, id)
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get goal: %w", err)
	}
	goal := goalFromRow(row)
	return &goal, nil
}

// ReplyCount counts the finished assistant replies of a line.
func (s *Store) ReplyCount(ctx context.Context, lineID string) (int, error) {
	id, ok := parseID(lineID)
	if !ok {
		return 0, domain.ErrLineNotFound
	}
	n, err := s.q.CountDoneAssistantReplies(ctx, id)
	if err != nil {
		return 0, fmt.Errorf("count replies: %w", err)
	}
	return int(n), nil
}
