package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// LoadTurn reads a pending turn back as BeginTurn returned it: the line,
// the operator message it answers, the pending reply, the cards it carries
// (meta.deliversCards) and the notes revisions (the one it carries from
// meta.notesRevision, the line's sent one as it is now). A finished,
// unknown or malformed id, or one of another tenant, returns
// ErrTurnNotPending. It is a plain read: the turn may end right after.
func (s *Store) LoadTurn(ctx context.Context, tenant, turnID string) (BegunTurn, error) {
	pending, err := s.pendingTurnRow(ctx, tenant, turnID)
	if err != nil {
		return BegunTurn{}, err
	}
	message := messageFromRow(pending)
	user, err := s.q.GetTurnOperatorMessage(ctx, db.GetTurnOperatorMessageParams{LineID: pending.LineID, BeforeSeq: pending.Seq})
	if err != nil {
		return BegunTurn{}, lookup(err, domain.ErrTurnNotPending, "get the turn's operator message")
	}
	cards, err := s.turnCards(ctx, pending.LineID, message.Meta.DeliversCards)
	if err != nil {
		return BegunTurn{}, err
	}
	out := BegunTurn{User: messageFromRow(user), Pending: message, Cards: cards, NotesRevision: message.Meta.NotesRevision}
	return s.withTurnLine(ctx, tenant, pending.LineID, out)
}

// pendingTurnRow is the pending assistant message of the tenant with id
// turnID; ErrTurnNotPending for anything else.
func (s *Store) pendingTurnRow(ctx context.Context, tenant, turnID string) (db.TangentMessage, error) {
	id, ok := parseID(turnID)
	if !ok {
		return db.TangentMessage{}, domain.ErrTurnNotPending
	}
	row, err := s.q.GetMessage(ctx, id)
	if err != nil {
		return db.TangentMessage{}, lookup(err, domain.ErrTurnNotPending, "get turn")
	}
	if row.TenantID != tenant || row.Status != domain.MessagePending || row.Role != domain.RoleAssistant {
		return db.TangentMessage{}, domain.ErrTurnNotPending
	}
	return row, nil
}

// turnCards reads the cards a turn carries, in seq order.
func (s *Store) turnCards(ctx context.Context, lineID uuid.UUID, ids []string) ([]domain.Message, error) {
	if len(ids) == 0 {
		return []domain.Message{}, nil
	}
	parsed := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if value, ok := parseID(id); ok {
			parsed = append(parsed, value)
		}
	}
	rows, err := s.q.ListLineMessagesByIDs(ctx, db.ListLineMessagesByIDsParams{LineID: lineID, Ids: parsed})
	if err != nil {
		return nil, fmt.Errorf("list the turn's cards: %w", err)
	}
	return messagesFromRows(rows), nil
}

// withTurnLine adds the turn's line, tree and the line's sent notes
// revision.
func (s *Store) withTurnLine(ctx context.Context, tenant string, lineID uuid.UUID, out BegunTurn) (BegunTurn, error) {
	row, err := s.lineRow(ctx, s.q, tenant, lineID.String())
	if err != nil {
		return BegunTurn{}, err
	}
	if out.Line, err = s.hydrateOne(ctx, s.q, row); err != nil {
		return BegunTurn{}, err
	}
	root, err := rootOf(ctx, s.q, lineID)
	if err != nil {
		return BegunTurn{}, err
	}
	out.RootLineID = root.String()
	revisions, err := s.q.GetNotesRevisions(ctx, db.GetNotesRevisionsParams{RootID: root, LineID: lineID})
	if err != nil {
		return BegunTurn{}, fmt.Errorf("get notes revisions: %w", err)
	}
	out.NotesRevisionSent = int(revisions.Sent)
	return out, nil
}
