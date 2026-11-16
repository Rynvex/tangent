package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

const (
	// DefaultMessagePage is the transcript page size when no limit is given.
	DefaultMessagePage = 100
	// MaxMessagePage caps one transcript page.
	MaxMessagePage = 500
	// unsummarizedScan bounds the messages read after the summary cursor.
	unsummarizedScan = 500
)

// NewMessage is one transcript entry to append. Kind defaults to chat and
// Status to done; InsertMessage refuses pending (only BeginTurn opens a turn).
type NewMessage struct {
	Role     string
	Kind     string
	Content  string
	Status   string
	Meta     domain.MessageMeta
	HostMeta json.RawMessage
}

// InsertMessage appends a finished message to a line and refreshes its
// activity, under the line's row lock. A line that is archived, or a branch
// that (or an ancestor of which) has ended, takes no messages.
func (s *Store) InsertMessage(ctx context.Context, tenant, lineID string, m NewMessage, hooks ...TxHook) (domain.Message, error) {
	if m.Status == domain.MessagePending {
		return domain.Message{}, invalidInput("a pending message is only written by BeginTurn")
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.Message, error) {
		line, err := s.lockLine(ctx, q, tenant, lineID)
		if err != nil {
			return domain.Message{}, err
		}
		if err := s.requireLineWritable(ctx, q, line); err != nil {
			return domain.Message{}, err
		}
		row, err := insertMessage(ctx, q, line, m)
		if err != nil {
			return domain.Message{}, err
		}
		return messageFromRow(row), touch(ctx, q, line.ID)
	})
}

// insertMessage validates and inserts one message on a line.
func insertMessage(ctx context.Context, q *db.Queries, line db.TangentLine, m NewMessage) (db.TangentMessage, error) {
	if m.Kind == "" {
		m.Kind = domain.MessageKindChat
	}
	if m.Status == "" {
		m.Status = domain.MessageDone
	}
	if err := checkMessageShape(m); err != nil {
		return db.TangentMessage{}, err
	}
	host, err := jsonObject(m.HostMeta, "hostMeta")
	if err != nil {
		return db.TangentMessage{}, err
	}
	meta, err := json.Marshal(m.Meta)
	if err != nil {
		return db.TangentMessage{}, fmt.Errorf("marshal message meta: %w", err)
	}
	row, err := q.InsertMessage(ctx, db.InsertMessageParams{
		LineID: line.ID, TenantID: line.TenantID, Role: m.Role, Kind: m.Kind, Content: m.Content, Status: m.Status, Meta: meta, HostMeta: host,
	})
	if err != nil {
		return db.TangentMessage{}, fmt.Errorf("insert message: %w", err)
	}
	return row, nil
}

func checkMessageShape(m NewMessage) error {
	switch {
	case m.Role != domain.RoleUser && m.Role != domain.RoleAssistant && m.Role != domain.RoleSystem:
		return invalidInput("role must be user, assistant or system")
	case m.Kind != domain.MessageKindChat && m.Kind != domain.MessageKindBranchCard && m.Kind != domain.MessageKindBranchMarker:
		return invalidInput("kind must be chat, branch_card or branch_marker")
	case m.Kind != domain.MessageKindChat && m.Role != domain.RoleSystem:
		return invalidInput("cards and markers are system messages")
	case m.Status != domain.MessagePending && m.Status != domain.MessageDone && m.Status != domain.MessageError:
		return invalidInput("status must be pending, done or error")
	}
	return nil
}

func touch(ctx context.Context, q *db.Queries, lineID uuid.UUID) error {
	if err := q.TouchLine(ctx, lineID); err != nil {
		return fmt.Errorf("touch line: %w", err)
	}
	return nil
}

// GetMessage loads one message of a line.
func (s *Store) GetMessage(ctx context.Context, tenant, lineID, messageID string) (domain.Message, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return domain.Message{}, err
	}
	row, err := messageOn(ctx, s.q, line.ID, messageID)
	if err != nil {
		return domain.Message{}, err
	}
	return messageFromRow(row), nil
}

// messageOn loads a message that sits on the line; ErrMessageNotFound otherwise.
func messageOn(ctx context.Context, q *db.Queries, lineID uuid.UUID, messageID string) (db.TangentMessage, error) {
	id, ok := parseID(messageID)
	if !ok {
		return db.TangentMessage{}, domain.ErrMessageNotFound
	}
	row, err := q.GetMessage(ctx, id)
	if err != nil {
		return db.TangentMessage{}, lookup(err, domain.ErrMessageNotFound, "get message")
	}
	if row.LineID != lineID {
		return db.TangentMessage{}, domain.ErrMessageNotFound
	}
	return row, nil
}

// ListMessages returns an ascending transcript page after a seq cursor.
func (s *Store) ListMessages(ctx context.Context, tenant, lineID string, afterSeq int64, limit int) ([]domain.Message, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListMessagesAfterSeq(ctx, db.ListMessagesAfterSeqParams{
		LineID: line.ID, AfterSeq: afterSeq, RowLimit: clampLimit(limit, DefaultMessagePage, MaxMessagePage),
	})
	if err != nil {
		return nil, fmt.Errorf("list messages: %w", err)
	}
	messages := messagesFromRows(rows)
	if err := attachTags(ctx, s.q, messages); err != nil {
		return nil, err
	}
	return messages, markSpunOffTargets(ctx, s.q, line.TenantID, messages)
}

// markSpunOffTargets sets SpunOffTo.Available on spinoff markers: whether
// the new conversation still exists.
func markSpunOffTargets(ctx context.Context, q *db.Queries, tenant string, messages []domain.Message) error {
	refs := []*domain.SpunOffRef{}
	for i := range messages {
		if messages[i].Meta.SpunOffTo != nil {
			refs = append(refs, messages[i].Meta.SpunOffTo)
		}
	}
	if len(refs) == 0 {
		return nil
	}
	tenants, err := lineTenants(ctx, q, refs)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		ref.Available = tenants[ref.LineID] == tenant
	}
	return nil
}

// RecentMessages returns the newest limit messages of a line in seq order
// (Limits.HistoryScan when limit is not positive).
func (s *Store) RecentMessages(ctx context.Context, tenant, lineID string, limit int) ([]domain.Message, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return nil, err
	}
	return recentMessages(ctx, s.q, line.ID, clampLimit(limit, s.limits.HistoryScan, MaxMessagePage*10))
}

func recentMessages(ctx context.Context, q *db.Queries, lineID uuid.UUID, limit int32) ([]domain.Message, error) {
	rows, err := q.ListRecentMessages(ctx, db.ListRecentMessagesParams{LineID: lineID, RowLimit: limit})
	if err != nil {
		return nil, fmt.Errorf("list recent messages: %w", err)
	}
	return newestFirst(rows), nil
}

// MessagesUpToAnchor returns the finished messages of a line up to and
// including the anchor, in seq order, at most Pack.HistoryScan; the anchor is
// the last one.
func (s *Store) MessagesUpToAnchor(ctx context.Context, tenant, lineID, anchorID string) ([]domain.Message, error) {
	line, anchor, err := s.lineAndMessage(ctx, tenant, lineID, anchorID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListDoneMessagesUpToSeq(ctx, db.ListDoneMessagesUpToSeqParams{
		LineID: line.ID, UptoSeq: anchor.Seq, RowLimit: int32(s.limits.Pack.HistoryScan),
	})
	if err != nil {
		return nil, fmt.Errorf("list messages up to the anchor: %w", err)
	}
	messages := newestFirst(rows)
	if len(messages) == 0 || messages[len(messages)-1].ID != anchor.ID.String() {
		return nil, domain.ErrMessageNotFound
	}
	return messages, nil
}

// MessagesAfterAnchor returns the finished messages of a line after the
// anchor, in seq order; when there are more than Pack.LaterScan only the
// newest ones.
func (s *Store) MessagesAfterAnchor(ctx context.Context, tenant, lineID, anchorID string) ([]domain.Message, error) {
	line, anchor, err := s.lineAndMessage(ctx, tenant, lineID, anchorID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListDoneMessagesAfterSeq(ctx, db.ListDoneMessagesAfterSeqParams{
		LineID: line.ID, AfterSeq: anchor.Seq, RowLimit: int32(s.limits.Pack.LaterScan),
	})
	if err != nil {
		return nil, fmt.Errorf("list messages after the anchor: %w", err)
	}
	return newestFirst(rows), nil
}

func (s *Store) lineAndMessage(ctx context.Context, tenant, lineID, messageID string) (db.TangentLine, db.TangentMessage, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return db.TangentLine{}, db.TangentMessage{}, err
	}
	message, err := messageOn(ctx, s.q, line.ID, messageID)
	return line, message, err
}

// MessagesAfterSummary returns the finished messages after the line's
// summary cursor (every finished message when there is none), in seq order,
// at most 500.
func (s *Store) MessagesAfterSummary(ctx context.Context, tenant, lineID string) ([]domain.Message, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return nil, err
	}
	return unsummarized(ctx, s.q, line)
}

func unsummarized(ctx context.Context, q *db.Queries, line db.TangentLine) ([]domain.Message, error) {
	rows, err := q.ListUnsummarizedMessages(ctx, db.ListUnsummarizedMessagesParams{
		LineID: line.ID, AfterSeq: line.SummaryUptoSeq.Int64, RowLimit: unsummarizedScan,
	})
	if err != nil {
		return nil, fmt.Errorf("list unsummarized messages: %w", err)
	}
	return messagesFromRows(rows), nil
}

// ParentTipMessageID returns the newest message of a line that counts for
// "the conversation moved on" (finished operator, assistant and card
// messages), or "" when it has none.
func (s *Store) ParentTipMessageID(ctx context.Context, tenant, lineID string) (string, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return "", err
	}
	return latestRelevant(ctx, s.q, line.ID)
}

func latestRelevant(ctx context.Context, q *db.Queries, lineID uuid.UUID) (string, error) {
	row, err := q.LatestRelevantMessage(ctx, lineID)
	if noRows(err) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("latest relevant message: %w", err)
	}
	return row.ID.String(), nil
}

// UndeliveredBranchCards returns the conclusion cards of a line no turn has
// carried yet, oldest first, at most limit (NoticeMaxPerTurn by default).
func (s *Store) UndeliveredBranchCards(ctx context.Context, tenant, lineID string, limit int) ([]domain.Message, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return nil, err
	}
	return undeliveredCards(ctx, s.q, line.ID, clampLimit(limit, s.limits.Branch.NoticeMaxPerTurn, MaxMessagePage))
}

func undeliveredCards(ctx context.Context, q *db.Queries, lineID uuid.UUID, limit int32) ([]domain.Message, error) {
	rows, err := q.ListUndeliveredCards(ctx, db.ListUndeliveredCardsParams{LineID: lineID, RowLimit: limit})
	if err != nil {
		return nil, fmt.Errorf("list undelivered cards: %w", err)
	}
	return messagesFromRows(rows), nil
}
