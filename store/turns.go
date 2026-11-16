package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// BeginTurnInput is the operator's message that starts a turn.
type BeginTurnInput struct {
	Tenant   string
	LineID   string
	Content  string
	HostMeta json.RawMessage
	// Actor is who started the turn; it is kept on the pending message.
	Actor string
}

// BegunTurn is a started turn: the line (now thinking), the operator's
// message, the pending assistant message whose id is the turn id, the
// conclusion cards this turn's prompt carries (oldest first, at most
// NoticeMaxPerTurn) and the notes revisions of the line's conversation.
type BegunTurn struct {
	Line              domain.LineView
	User              domain.Message
	Pending           domain.Message
	Cards             []domain.Message
	RootLineID        string
	NotesRevision     int
	NotesRevisionSent int
}

// BeginTurn stores the operator's message and a pending assistant message
// and moves the line to thinking, under the line's row lock. It refuses a
// second pending turn (ErrTurnPending) and a branch that takes no turns. The
// cards the turn carries and the notes revision are chosen under the same
// lock and recorded on the pending message, so CompleteTurn marks exactly
// those delivered.
func (s *Store) BeginTurn(ctx context.Context, in BeginTurnInput, hooks ...TxHook) (BegunTurn, error) {
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
		out, err := s.prepareTurn(ctx, q, line)
		if err != nil {
			return BegunTurn{}, err
		}
		user, err := insertMessage(ctx, q, line, NewMessage{Role: domain.RoleUser, Content: in.Content, HostMeta: in.HostMeta})
		if err != nil {
			return BegunTurn{}, err
		}
		pending, err := insertMessage(ctx, q, line, NewMessage{Role: domain.RoleAssistant, Status: domain.MessagePending, Meta: domain.MessageMeta{
			Provider: line.Provider, Model: line.Model, DeliversCards: messageIDs(out.Cards), NotesRevision: out.NotesRevision,
			Actor: strings.TrimSpace(in.Actor),
		}})
		if err != nil {
			return BegunTurn{}, err
		}
		out.User, out.Pending = messageFromRow(user), messageFromRow(pending)
		if err := touch(ctx, q, line.ID); err != nil {
			return BegunTurn{}, err
		}
		lineRow, err := q.SetLineStatus(ctx, db.SetLineStatusParams{ID: line.ID, Status: domain.LineStatusThinking})
		if err != nil {
			return BegunTurn{}, fmt.Errorf("set line thinking: %w", err)
		}
		out.Line, err = s.hydrateOne(ctx, q, lineRow)
		return out, err
	})
}

// prepareTurn reads, under the line lock, what the new turn carries.
func (s *Store) prepareTurn(ctx context.Context, q *db.Queries, line db.TangentLine) (BegunTurn, error) {
	cards, err := undeliveredCards(ctx, q, line.ID, int32(s.limits.Branch.NoticeMaxPerTurn))
	if err != nil {
		return BegunTurn{}, err
	}
	root, err := rootOf(ctx, q, line.ID)
	if err != nil {
		return BegunTurn{}, err
	}
	revisions, err := q.GetNotesRevisions(ctx, db.GetNotesRevisionsParams{RootID: root, LineID: line.ID})
	if err != nil {
		return BegunTurn{}, fmt.Errorf("get notes revisions: %w", err)
	}
	return BegunTurn{Cards: cards, RootLineID: root.String(), NotesRevision: int(revisions.Revision), NotesRevisionSent: int(revisions.Sent)}, nil
}

func messageIDs(messages []domain.Message) []string {
	out := make([]string, 0, len(messages))
	for _, message := range messages {
		out = append(out, message.ID)
	}
	return out
}

// CompleteTurnInput is the result of a turn. Outcome comes from
// domain.ResolveTurnOutcome; Suggestions are the branch suggestions parsed
// out of the content. Provider and Model, when set, name what actually ran.
type CompleteTurnInput struct {
	TurnID      string
	Outcome     domain.TurnOutcome
	Usage       *domain.Usage
	DurationMs  int64
	Suggestions []domain.BranchSuggestion
	Provider    string
	Model       string
	// SkipNotesRevision leaves notes_revision_sent alone; the caller records
	// it itself (MarkNotesRevisionSent in a hook) when the turn carried notes.
	SkipNotesRevision bool
	// Notices are host system messages written right after the reply, in
	// order, in the same transaction (a failed reply gets them too).
	Notices []SystemNotice
}

// CompletedTurn is a finished turn. EndedAsideLineID is set when the turn
// was an aside's one answer and ended it.
type CompletedTurn struct {
	Tenant           string
	Line             domain.LineView
	Message          domain.Message
	RootLineID       string
	EndedAsideLineID string
	// DeliveredCards are the conclusion cards this turn delivered, as they
	// are now (meta.delivered true), in seq order.
	DeliveredCards []domain.Message
	// Notices are the host system messages written after the reply, in seq
	// order (those SkipRepeat left out are not here).
	Notices []domain.Message
}

// CompleteTurn finishes a pending turn, once: a message that is no longer
// pending returns ErrTurnNotPending. The notices follow the reply (their seq
// is after it). A successful turn marks the cards it
// carried delivered, records the notes revision it carried as sent and ends
// an answered aside. The usage is added to the line's totals; the line goes
// idle or error.
func (s *Store) CompleteTurn(ctx context.Context, in CompleteTurnInput, hooks ...TxHook) (CompletedTurn, error) {
	turnID, ok := parseID(in.TurnID)
	if !ok {
		return CompletedTurn{}, domain.ErrTurnNotPending
	}
	if err := checkTurnResult(in); err != nil {
		return CompletedTurn{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (CompletedTurn, error) {
		peek, err := q.GetMessage(ctx, turnID)
		if err != nil {
			return CompletedTurn{}, lookup(err, domain.ErrTurnNotPending, "get turn")
		}
		// Lock order: the line before its message, like BeginTurn and CancelTurn.
		line, err := lockLineByID(ctx, q, peek.LineID)
		if err != nil {
			return CompletedTurn{}, err
		}
		message, err := s.finishTurnMessage(ctx, q, turnID, in)
		if err != nil {
			return CompletedTurn{}, err
		}
		out := CompletedTurn{Tenant: line.TenantID, Message: messageFromRow(message)}
		if out.Notices, err = writeNotices(ctx, q, line, in.Notices); err != nil {
			return CompletedTurn{}, err
		}
		if out.DeliveredCards, out.EndedAsideLineID, err = s.settleTurn(ctx, q, line, out.Message, in); err != nil {
			return CompletedTurn{}, err
		}
		root, err := rootOf(ctx, q, line.ID)
		if err != nil {
			return CompletedTurn{}, err
		}
		out.RootLineID = root.String()
		lineRow, err := applyTurnToLine(ctx, q, line.ID, in)
		if err != nil {
			return CompletedTurn{}, err
		}
		out.Line, err = s.hydrateOne(ctx, q, lineRow)
		return out, err
	})
}

// checkTurnResult refuses an outcome that does not fit together: the status
// must be idle or error, error exactly when the turn failed, and usage and
// duration never negative.
func checkTurnResult(in CompleteTurnInput) error {
	outcome := in.Outcome
	switch {
	case outcome.Status != domain.LineStatusIdle && outcome.Status != domain.LineStatusError:
		return invalidInput("a finished turn leaves the conversation idle or in error")
	case outcome.Failed != (outcome.Status == domain.LineStatusError):
		return invalidInput("a failed turn, and only a failed turn, leaves the conversation in error")
	case in.DurationMs < 0:
		return invalidInput("duration must not be negative")
	case in.Usage != nil && (in.Usage.InputTokens < 0 || in.Usage.OutputTokens < 0 || in.Usage.CostUSD < 0):
		return invalidInput("usage must not be negative")
	}
	return nil
}

// finishTurnMessage writes the outcome on the pending message.
func (s *Store) finishTurnMessage(ctx context.Context, q *db.Queries, turnID uuid.UUID, in CompleteTurnInput) (db.TangentMessage, error) {
	patch := map[string]any{"durationMs": in.DurationMs, "error": "", "streamSeq": nil}
	if in.Usage != nil {
		patch["usage"] = in.Usage
	}
	if in.Outcome.Failed {
		patch["error"] = in.Outcome.StatusDetail
	} else if len(in.Suggestions) > 0 {
		patch["suggestions"] = in.Suggestions
	}
	if provider := strings.TrimSpace(in.Provider); provider != "" {
		patch["provider"] = provider
	}
	if model := strings.TrimSpace(in.Model); model != "" {
		patch["model"] = model
	}
	status := domain.MessageDone
	if in.Outcome.Failed {
		status = domain.MessageError
	}
	return completePending(ctx, q, turnID, in.Outcome.Content, status, patch)
}

// completePending finishes a pending message with a meta patch (only the
// top-level keys of the patch change); ErrTurnNotPending once it is not
// pending any more.
func completePending(ctx context.Context, q *db.Queries, id uuid.UUID, content, status string, patch map[string]any) (db.TangentMessage, error) {
	raw, err := json.Marshal(patch)
	if err != nil {
		return db.TangentMessage{}, fmt.Errorf("marshal meta patch: %w", err)
	}
	row, err := q.CompletePendingMessage(ctx, db.CompletePendingMessageParams{ID: id, Content: content, Status: status, MetaPatch: raw})
	if err != nil {
		return db.TangentMessage{}, lookup(err, domain.ErrTurnNotPending, "complete turn")
	}
	return row, nil
}

// settleTurn applies what a successful turn changes besides its message:
// delivered cards, the notes revision sent and an answered aside. It returns
// the cards it delivered and the aside it ended, if any.
func (s *Store) settleTurn(ctx context.Context, q *db.Queries, line db.TangentLine, message domain.Message, in CompleteTurnInput) ([]domain.Message, string, error) {
	if in.Outcome.Failed || message.Meta.Cancelled {
		return nil, "", nil
	}
	delivered, err := markCardsDelivered(ctx, q, line.ID, message.Meta.DeliversCards)
	if err != nil {
		return nil, "", err
	}
	if message.Meta.NotesRevision > 0 && !in.SkipNotesRevision {
		if err := q.SetNotesRevisionSent(ctx, db.SetNotesRevisionSentParams{ID: line.ID, NotesRevisionSent: int32(message.Meta.NotesRevision)}); err != nil {
			return nil, "", fmt.Errorf("record notes revision sent: %w", err)
		}
	}
	aside, err := endAnsweredAside(ctx, q, line.ID)
	return delivered, aside, err
}

// markCardsDelivered marks the cards a finished turn carried, from the ids
// the store itself recorded on the pending message, and returns them. Only
// cards of this very line that were not delivered yet qualify.
func markCardsDelivered(ctx context.Context, q *db.Queries, lineID uuid.UUID, ids []string) ([]domain.Message, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	parsed := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if value, ok := parseID(id); ok {
			parsed = append(parsed, value)
		}
	}
	rows, err := q.MarkCardsDelivered(ctx, db.MarkCardsDeliveredParams{LineID: lineID, MessageIds: parsed})
	if err != nil {
		return nil, fmt.Errorf("mark cards delivered: %w", err)
	}
	return domain.SortBySeq(messagesFromRows(rows)), nil
}

// endAnsweredAside discards an open aside once its one answer is in.
func endAnsweredAside(ctx context.Context, q *db.Queries, lineID uuid.UUID) (string, error) {
	row, isBranch, err := branchRowFor(ctx, q, lineID)
	if err != nil || !isBranch || row.Kind != domain.BranchKindAside || row.Status != domain.BranchStatusOpen {
		return "", err
	}
	if _, err := q.CloseBranch(ctx, db.CloseBranchParams{LineID: lineID, Status: domain.BranchStatusDiscarded}); err != nil {
		return "", fmt.Errorf("end answered aside: %w", err)
	}
	return lineID.String(), nil
}

func applyTurnToLine(ctx context.Context, q *db.Queries, lineID uuid.UUID, in CompleteTurnInput) (db.TangentLine, error) {
	usage := domain.Usage{}
	if in.Usage != nil {
		usage = *in.Usage
	}
	row, err := q.ApplyTurnToLine(ctx, db.ApplyTurnToLineParams{
		ID: lineID, InputTokens: usage.InputTokens, OutputTokens: usage.OutputTokens, CostUsd: usage.CostUSD,
		Status: in.Outcome.Status, StatusDetail: in.Outcome.StatusDetail,
	})
	if err != nil {
		return db.TangentLine{}, fmt.Errorf("apply turn to line: %w", err)
	}
	return row, nil
}

// CancelledTurn is what cancelling found: Cancelled is false when the line
// had no pending turn.
type CancelledTurn struct {
	Line      domain.LineView
	Message   domain.Message
	Cancelled bool
}

// CancelTurn ends the line's pending turn as cancelled: the message keeps
// the partial text the caller streamed so far, meta.cancelled is set, the
// line goes idle. Without a pending turn it changes nothing.
func (s *Store) CancelTurn(ctx context.Context, tenant, lineID, partial string, hooks ...TxHook) (CancelledTurn, error) {
	return s.cancelTurn(ctx, tenant, lineID, "", partial, hooks)
}

// CancelTurnFor is CancelTurn for one named turn: when the line's pending
// turn is another one (the named turn finished and a new one began), it
// changes nothing, so the new turn never gets the old turn's text.
func (s *Store) CancelTurnFor(ctx context.Context, tenant, lineID, turnID, partial string, hooks ...TxHook) (CancelledTurn, error) {
	if _, ok := parseID(turnID); !ok {
		return CancelledTurn{}, domain.ErrTurnNotPending
	}
	return s.cancelTurn(ctx, tenant, lineID, turnID, partial, hooks)
}

// cancelTurn cancels the pending turn, or only the expected one when set.
func (s *Store) cancelTurn(ctx context.Context, tenant, lineID, expected, partial string, hooks []TxHook) (CancelledTurn, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (CancelledTurn, error) {
		line, err := s.lockLine(ctx, q, tenant, lineID)
		if err != nil {
			return CancelledTurn{}, err
		}
		out := CancelledTurn{}
		pending, err := q.GetPendingAssistantMessage(ctx, line.ID)
		switch {
		case noRows(err):
		case err != nil:
			return CancelledTurn{}, fmt.Errorf("load pending turn: %w", err)
		case expected != "" && pending.ID.String() != strings.ToLower(strings.TrimSpace(expected)):
		default:
			message, err := completePending(ctx, q, pending.ID, partial, domain.MessageDone, map[string]any{"cancelled": true, "error": "", "streamSeq": nil})
			if err != nil {
				return CancelledTurn{}, err
			}
			out.Message, out.Cancelled = messageFromRow(message), true
			if line, err = q.SetLineStatus(ctx, db.SetLineStatusParams{ID: line.ID, Status: domain.LineStatusIdle}); err != nil {
				return CancelledTurn{}, fmt.Errorf("set line idle: %w", err)
			}
		}
		out.Line, err = s.hydrateOne(ctx, q, line)
		return out, err
	})
}
