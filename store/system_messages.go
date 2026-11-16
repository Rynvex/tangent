package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Host system messages are role system, kind chat. The library writes
// system messages only as conclusion cards and markers (their own kinds),
// so a system chat message is always the host's: a notice, an audit record,
// a sync report. They are ordinary messages of the line (seq, history,
// moves), but never count as a turn (see failedTurnMessage).

// systemRepeatLookback is how many of a line's newest messages SkipRepeat
// searches for its newest host system message.
const systemRepeatLookback = 30

// SystemNotice is one host system message. Content is the text as it is
// stored (the Engine cleans it first); HostMeta is a JSON object or empty.
// SkipRepeat leaves the message out when the newest host system message
// among the line's last 30 messages has the same content (a status the
// host reports on every turn is written once).
type SystemNotice struct {
	Content    string
	HostMeta   json.RawMessage
	SkipRepeat bool
}

// AppendedSystemMessage is what AppendSystemMessage did. Written is false
// when SkipRepeat left the message out: nothing was written (the hooks did
// not run) and Line and Message are empty.
type AppendedSystemMessage struct {
	Line    domain.LineView
	Message domain.Message
	Written bool
}

// AppendSystemMessage appends a host system message to a line under the
// line's row lock (the only lock it takes), after whatever the line holds,
// a pending reply included. A line that is archived, or a branch that (or an
// ancestor of which) has ended, takes none; a line that is gone (another
// tenant's, or a conversation deleted meanwhile) is ErrLineNotFound. The
// line's activity is refreshed.
func (s *Store) AppendSystemMessage(ctx context.Context, tenant, lineID string, n SystemNotice, hooks ...TxHook) (AppendedSystemMessage, error) {
	if strings.TrimSpace(n.Content) == "" {
		return AppendedSystemMessage{}, invalidInput("content is required")
	}
	return runTxWith(ctx, s, func(q *db.Queries, tx pgx.Tx) (AppendedSystemMessage, error) {
		line, err := s.lockLine(ctx, q, tenant, lineID)
		if err != nil {
			return AppendedSystemMessage{}, err
		}
		if err := s.requireLineWritable(ctx, q, line); err != nil {
			return AppendedSystemMessage{}, err
		}
		message, written, err := writeNotice(ctx, q, line, n)
		if err != nil || !written {
			return AppendedSystemMessage{}, err
		}
		out := AppendedSystemMessage{Message: messageFromRow(message), Written: true}
		if out.Line, err = s.touchedLine(ctx, q, line); err != nil {
			return AppendedSystemMessage{}, err
		}
		return out, runHooks(ctx, tx, hooks, out)
	})
}

// touchedLine refreshes a line's activity and reads it back.
func (s *Store) touchedLine(ctx context.Context, q *db.Queries, line db.TangentLine) (domain.LineView, error) {
	if err := touch(ctx, q, line.ID); err != nil {
		return domain.LineView{}, err
	}
	row, err := q.GetLine(ctx, line.ID)
	if err != nil {
		return domain.LineView{}, fmt.Errorf("reload line: %w", err)
	}
	return s.hydrateOne(ctx, q, row)
}

// writeNotices writes a finished turn's notices in order and returns those
// written (SkipRepeat may leave some out).
func writeNotices(ctx context.Context, q *db.Queries, line db.TangentLine, notices []SystemNotice) ([]domain.Message, error) {
	out := []domain.Message{}
	for _, n := range notices {
		row, written, err := writeNotice(ctx, q, line, n)
		if err != nil {
			return nil, err
		}
		if written {
			out = append(out, messageFromRow(row))
		}
	}
	return out, nil
}

// writeNotice inserts one host system message unless SkipRepeat finds it
// repeated; written reports whether it did.
func writeNotice(ctx context.Context, q *db.Queries, line db.TangentLine, n SystemNotice) (db.TangentMessage, bool, error) {
	if strings.TrimSpace(n.Content) == "" {
		return db.TangentMessage{}, false, invalidInput("a system message needs content")
	}
	if n.SkipRepeat {
		latest, err := q.LatestHostSystemContent(ctx, db.LatestHostSystemContentParams{LineID: line.ID, RowLimit: systemRepeatLookback})
		switch {
		case noRows(err):
		case err != nil:
			return db.TangentMessage{}, false, fmt.Errorf("latest host system message: %w", err)
		case latest == n.Content:
			return db.TangentMessage{}, false, nil
		}
	}
	row, err := insertMessage(ctx, q, line, NewMessage{Role: domain.RoleSystem, Kind: domain.MessageKindChat, Content: n.Content, HostMeta: n.HostMeta})
	return row, err == nil, err
}
