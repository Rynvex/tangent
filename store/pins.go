package store

import (
	"context"
	"fmt"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// PinnedMessage is a message after a pin or unpin: Changed is false when it
// already was in that state.
type PinnedMessage struct {
	Message    domain.Message
	RootLineID string
	Changed    bool
}

// PinMessage pins or unpins a finished operator, assistant or card message
// under the lock of the line it is on (a move of the message waits, or is
// waited for). An archived conversation is read-only.
func (s *Store) PinMessage(ctx context.Context, tenant, messageID string, pinned bool, hooks ...TxHook) (PinnedMessage, error) {
	id, ok := parseID(messageID)
	if !ok {
		return PinnedMessage{}, domain.ErrMessageNotFound
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (PinnedMessage, error) {
		peek, err := q.GetMessage(ctx, id)
		if err != nil {
			return PinnedMessage{}, lookup(err, domain.ErrMessageNotFound, "get message")
		}
		if peek.TenantID != tenant {
			return PinnedMessage{}, domain.ErrMessageNotFound
		}
		line, err := lockLineByID(ctx, q, peek.LineID)
		if err != nil {
			return PinnedMessage{}, err
		}
		message, err := q.GetMessage(ctx, id)
		if err != nil {
			return PinnedMessage{}, lookup(err, domain.ErrMessageNotFound, "get message")
		}
		if message.LineID != line.ID {
			return PinnedMessage{}, errBranchMoved // it moved while the line was being locked
		}
		return s.setPinned(ctx, q, line, message, pinned)
	})
}

func (s *Store) setPinned(ctx context.Context, q *db.Queries, line db.TangentLine, message db.TangentMessage, pinned bool) (PinnedMessage, error) {
	if line.ArchivedAt.Valid {
		return PinnedMessage{}, domain.ErrLineArchived
	}
	if !pinnable(message) {
		return PinnedMessage{}, invalidInput("only a finished operator, assistant or card message can be pinned")
	}
	root, err := rootOf(ctx, q, line.ID)
	if err != nil {
		return PinnedMessage{}, err
	}
	out := PinnedMessage{RootLineID: root.String()}
	if message.Pinned != pinned {
		if message, err = q.SetMessagePinned(ctx, db.SetMessagePinnedParams{ID: message.ID, Pinned: pinned}); err != nil {
			return PinnedMessage{}, fmt.Errorf("pin message: %w", err)
		}
		out.Changed = true
	}
	out.Message, err = taggedMessage(ctx, q, message)
	return out, err
}

// pinnable: a finished operator or assistant chat message, or a card.
func pinnable(m db.TangentMessage) bool {
	if m.Status != domain.MessageDone {
		return false
	}
	return m.Kind == domain.MessageKindBranchCard || (m.Kind == domain.MessageKindChat && (m.Role == domain.RoleUser || m.Role == domain.RoleAssistant))
}
