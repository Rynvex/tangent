package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// TurnRef names a pending turn's place: its tenant, line and tree.
type TurnRef struct {
	TurnID     string
	Tenant     string
	LineID     string
	RootLineID string
	// Actor is who started the turn ("" when it was not recorded).
	Actor string
}

// GetTurn resolves a pending turn by its id (the pending assistant message).
// A finished, unknown or malformed id returns ErrTurnNotPending. It is a
// plain read: the turn may finish right after it returns.
func (s *Store) GetTurn(ctx context.Context, turnID string) (TurnRef, error) {
	id, ok := parseID(turnID)
	if !ok {
		return TurnRef{}, domain.ErrTurnNotPending
	}
	row, err := s.q.GetMessage(ctx, id)
	if err != nil {
		return TurnRef{}, lookup(err, domain.ErrTurnNotPending, "get turn")
	}
	if row.Status != domain.MessagePending || row.Role != domain.RoleAssistant {
		return TurnRef{}, domain.ErrTurnNotPending
	}
	root, err := rootOf(ctx, s.q, row.LineID)
	if err != nil {
		return TurnRef{}, err
	}
	return TurnRef{
		TurnID: row.ID.String(), Tenant: row.TenantID, LineID: row.LineID.String(), RootLineID: root.String(),
		Actor: messageFromRow(row).Meta.Actor,
	}, nil
}

// PendingTurn returns the line's pending assistant message; ok is false
// when the line has no turn in flight.
func (s *Store) PendingTurn(ctx context.Context, tenant, lineID string) (domain.Message, bool, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return domain.Message{}, false, err
	}
	row, err := s.q.GetPendingAssistantMessage(ctx, line.ID)
	if noRows(err) {
		return domain.Message{}, false, nil
	}
	if err != nil {
		return domain.Message{}, false, fmt.Errorf("load pending turn: %w", err)
	}
	return messageFromRow(row), true, nil
}

// RecordedUsage is what RecordTurnUsage did: Recorded is false when the turn
// already had usage on record.
type RecordedUsage struct {
	Message  domain.Message
	Recorded bool
}

// RecordTurnUsage records the usage of a turn that ended without
// CompleteTurn (cancelled or failed as stale while its run still finished):
// on the message, once, and added to the line's totals. A pending turn is
// refused (ErrTurnPending: CompleteTurn records its usage); an unknown one
// returns ErrTurnNotPending.
func (s *Store) RecordTurnUsage(ctx context.Context, turnID string, usage domain.Usage) (RecordedUsage, error) {
	id, ok := parseID(turnID)
	if !ok {
		return RecordedUsage{}, domain.ErrTurnNotPending
	}
	if usage.InputTokens < 0 || usage.OutputTokens < 0 || usage.CostUSD < 0 {
		return RecordedUsage{}, invalidInput("usage must not be negative")
	}
	raw, err := json.Marshal(usage)
	if err != nil {
		return RecordedUsage{}, fmt.Errorf("marshal usage: %w", err)
	}
	return runTx(ctx, s, nil, func(q *db.Queries) (RecordedUsage, error) {
		peek, err := q.GetMessage(ctx, id)
		if err != nil {
			return RecordedUsage{}, lookup(err, domain.ErrTurnNotPending, "get turn")
		}
		if _, err := lockLineByID(ctx, q, peek.LineID); err != nil {
			return RecordedUsage{}, err
		}
		row, err := q.SetFinishedMessageUsage(ctx, db.SetFinishedMessageUsageParams{ID: id, Usage: raw})
		if noRows(err) {
			return usageNotRecorded(ctx, q, id)
		}
		if err != nil {
			return RecordedUsage{}, fmt.Errorf("record turn usage: %w", err)
		}
		if err := q.AddLineUsage(ctx, db.AddLineUsageParams{
			ID: row.LineID, InputTokens: usage.InputTokens, OutputTokens: usage.OutputTokens, CostUsd: usage.CostUSD,
		}); err != nil {
			return RecordedUsage{}, fmt.Errorf("add line usage: %w", err)
		}
		return RecordedUsage{Message: messageFromRow(row), Recorded: true}, nil
	})
}

// usageNotRecorded explains why no usage was written: the turn is still
// pending, or it already has usage.
func usageNotRecorded(ctx context.Context, q *db.Queries, id uuid.UUID) (RecordedUsage, error) {
	row, err := q.GetMessage(ctx, id)
	if err != nil {
		return RecordedUsage{}, lookup(err, domain.ErrTurnNotPending, "get turn")
	}
	if row.Status == domain.MessagePending {
		return RecordedUsage{}, domain.ErrTurnPending
	}
	return RecordedUsage{Message: messageFromRow(row)}, nil
}

// SavePartialReply keeps the text streamed so far on a pending reply and
// the delta seq it covers (meta.streamSeq), so a client that reloads gets
// the start of a reply its stream buffer lost. It writes nothing (false)
// once the reply is finished or a later partial is already saved; it takes
// no line lock and publishes nothing.
func (s *Store) SavePartialReply(ctx context.Context, turnID, content string, streamSeq int64) (bool, error) {
	id, ok := parseID(turnID)
	if !ok || streamSeq <= 0 {
		return false, nil
	}
	n, err := s.q.SavePendingPartial(ctx, db.SavePendingPartialParams{ID: id, Content: content, StreamSeq: streamSeq})
	if err != nil {
		return false, fmt.Errorf("save partial reply: %w", err)
	}
	return n > 0, nil
}
