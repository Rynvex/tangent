package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// RetryTurnInput names the line whose last, failed turn runs again.
type RetryTurnInput struct {
	Tenant string
	LineID string
	Actor  string
}

// retryWindow is how many of the newest messages decide whether the last
// turn failed: the operator's message and its failed reply. Host system
// messages after them (a failed turn's notices) do not count.
const retryWindow = 2

// RetryTurn starts the line's last turn again when it failed: the line's
// two newest messages, host system messages left aside, must be the
// operator's message and its failed reply.
// The failed reply stays (status error); a new pending reply is added for
// the same operator message, which is not duplicated. Like BeginTurn it
// runs under the line's lock, refuses a pending turn and a branch that takes
// no turns, and moves the line to thinking.
func (s *Store) RetryTurn(ctx context.Context, in RetryTurnInput, hooks ...TxHook) (BegunTurn, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (BegunTurn, error) {
		line, err := s.lockLine(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return BegunTurn{}, err
		}
		if err := s.requireBranchAcceptsTurn(ctx, q, line); err != nil {
			return BegunTurn{}, err
		}
		if err := requireNoPendingTurn(ctx, q, line.ID, domain.ErrTurnPending); err != nil {
			return BegunTurn{}, err
		}
		user, err := failedTurnMessage(ctx, q, line)
		if err != nil {
			return BegunTurn{}, err
		}
		out, err := s.prepareTurn(ctx, q, line)
		if err != nil {
			return BegunTurn{}, err
		}
		return s.startPending(ctx, q, line, out, user, in.Actor)
	})
}

// failedTurnMessage is the operator message of the line's last turn when
// that turn failed; ErrNothingToRetry otherwise.
func failedTurnMessage(ctx context.Context, q *db.Queries, line db.TangentLine) (domain.Message, error) {
	rows, err := q.ListRecentTurnMessages(ctx, db.ListRecentTurnMessagesParams{LineID: line.ID, RowLimit: retryWindow})
	if err != nil {
		return domain.Message{}, fmt.Errorf("list the last turn: %w", err)
	}
	recent := newestFirst(rows)
	if len(recent) != retryWindow {
		return domain.Message{}, domain.ErrNothingToRetry
	}
	user, reply := recent[0], recent[1]
	if user.Role != domain.RoleUser || user.Status != domain.MessageDone || reply.Role != domain.RoleAssistant ||
		reply.Kind != domain.MessageKindChat || reply.Status != domain.MessageError {
		return domain.Message{}, domain.ErrNothingToRetry
	}
	return user, nil
}

// startPending adds the pending reply of a turn whose operator message
// exists and moves the line to thinking.
func (s *Store) startPending(ctx context.Context, q *db.Queries, line db.TangentLine, out BegunTurn, user domain.Message, actor string) (BegunTurn, error) {
	pending, err := insertMessage(ctx, q, line, NewMessage{Role: domain.RoleAssistant, Status: domain.MessagePending, Meta: domain.MessageMeta{
		Provider: line.Provider, Model: line.Model, DeliversCards: messageIDs(out.Cards), NotesRevision: out.NotesRevision,
		Actor: strings.TrimSpace(actor),
	}})
	if err != nil {
		return BegunTurn{}, err
	}
	out.User, out.Pending = user, messageFromRow(pending)
	if err := touch(ctx, q, line.ID); err != nil {
		return BegunTurn{}, err
	}
	lineRow, err := q.SetLineStatus(ctx, db.SetLineStatusParams{ID: line.ID, Status: domain.LineStatusThinking})
	if err != nil {
		return BegunTurn{}, fmt.Errorf("set line thinking: %w", err)
	}
	out.Line, err = s.hydrateOne(ctx, q, lineRow)
	return out, err
}
