package store

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// JobKindIbisTag tags a line's newest untagged messages (the ibis feature).
const JobKindIbisTag = "ibis_tag"

// TaggedMessage is a message after a tag was written or removed: Changed is
// false when it already was in that state.
type TaggedMessage struct {
	Message    domain.Message
	RootLineID string
	Changed    bool
}

// TagInput is a tag the operator writes: Status is confirmed (empty too)
// or draft, which puts the tag back for review as the model's (B15).
type TagInput struct {
	Kind   string
	Status string
}

// TagMessage writes the operator's confirmed tag; see SetMessageTag.
func (s *Store) TagMessage(ctx context.Context, tenant, messageID, kind, actor string, hooks ...TxHook) (TaggedMessage, error) {
	return s.SetMessageTag(ctx, tenant, messageID, TagInput{Kind: kind}, actor, hooks...)
}

// SetMessageTag writes a tag on a finished operator or assistant message
// under the lock of the line it is on; it replaces any tag, a model's
// included. Confirmed is the operator's (source user); draft is source ai,
// status draft. An archived conversation is read-only.
func (s *Store) SetMessageTag(ctx context.Context, tenant, messageID string, in TagInput, actor string, hooks ...TxHook) (TaggedMessage, error) {
	kind, err := domain.NormalizeTagKind(in.Kind)
	if err != nil {
		return TaggedMessage{}, err
	}
	status, err := domain.NormalizeTagStatus(in.Status)
	if err != nil {
		return TaggedMessage{}, err
	}
	source := domain.TagSourceOf(status)
	return s.writeTag(ctx, tenant, messageID, hooks, func(q *db.Queries, message db.TangentMessage, current *db.TangentMessageTag) (bool, error) {
		if current != nil && current.Kind == kind && current.Source == source && current.Status == status {
			return false, nil
		}
		_, err := q.PutTag(ctx, db.PutTagParams{MessageID: message.ID, TenantID: message.TenantID, Kind: kind, Source: source, Status: status, UpdatedBy: actor})
		return true, wrapErr(err, "put the tag")
	})
}

// UntagMessage removes a message's tag (whoever wrote it).
func (s *Store) UntagMessage(ctx context.Context, tenant, messageID string, hooks ...TxHook) (TaggedMessage, error) {
	return s.writeTag(ctx, tenant, messageID, hooks, func(q *db.Queries, message db.TangentMessage, current *db.TangentMessageTag) (bool, error) {
		if current == nil {
			return false, nil
		}
		_, err := q.DeleteMessageTag(ctx, message.ID)
		return true, wrapErr(err, "remove the tag")
	})
}

type tagWrite func(q *db.Queries, message db.TangentMessage, current *db.TangentMessageTag) (bool, error)

// writeTag locks the line the message is on (a move of it waits, or is
// waited for) and runs write on the taggable message.
func (s *Store) writeTag(ctx context.Context, tenant, messageID string, hooks []TxHook, write tagWrite) (TaggedMessage, error) {
	id, ok := parseID(messageID)
	if !ok {
		return TaggedMessage{}, domain.ErrMessageNotFound
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (TaggedMessage, error) {
		line, message, err := lockMessageLine(ctx, q, tenant, id)
		if err != nil {
			return TaggedMessage{}, err
		}
		if line.ArchivedAt.Valid {
			return TaggedMessage{}, domain.ErrLineArchived
		}
		if !taggable(message) {
			return TaggedMessage{}, invalidInput("only a finished operator or assistant message can be tagged")
		}
		current, err := tagOf(ctx, q, message.ID)
		if err != nil {
			return TaggedMessage{}, err
		}
		changed, err := write(q, message, current)
		if err != nil {
			return TaggedMessage{}, err
		}
		root, err := rootOf(ctx, q, line.ID)
		if err != nil {
			return TaggedMessage{}, err
		}
		view, err := taggedMessage(ctx, q, message)
		return TaggedMessage{Message: view, RootLineID: root.String(), Changed: changed}, err
	})
}

// lockMessageLine locks the line a message of the tenant is on and reads
// the message again under that lock; a message moved meanwhile retries.
func lockMessageLine(ctx context.Context, q *db.Queries, tenant string, id uuid.UUID) (db.TangentLine, db.TangentMessage, error) {
	peek, err := q.GetMessage(ctx, id)
	if err != nil {
		return db.TangentLine{}, db.TangentMessage{}, lookup(err, domain.ErrMessageNotFound, "get message")
	}
	if peek.TenantID != tenant {
		return db.TangentLine{}, db.TangentMessage{}, domain.ErrMessageNotFound
	}
	line, err := lockLineByID(ctx, q, peek.LineID)
	if err != nil {
		return db.TangentLine{}, db.TangentMessage{}, err
	}
	message, err := q.GetMessage(ctx, id)
	if err != nil {
		return db.TangentLine{}, db.TangentMessage{}, lookup(err, domain.ErrMessageNotFound, "get message")
	}
	if message.LineID != line.ID {
		return db.TangentLine{}, db.TangentMessage{}, errBranchMoved
	}
	return line, message, nil
}

// taggable: a finished operator or assistant chat message.
func taggable(m db.TangentMessage) bool {
	return m.Status == domain.MessageDone && m.Kind == domain.MessageKindChat && (m.Role == domain.RoleUser || m.Role == domain.RoleAssistant)
}

func tagOf(ctx context.Context, q *db.Queries, messageID uuid.UUID) (*db.TangentMessageTag, error) {
	row, err := q.GetMessageTag(ctx, messageID)
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get the tag: %w", err)
	}
	return &row, nil
}

func tagFromRow(row db.TangentMessageTag) *domain.MessageTag {
	return &domain.MessageTag{Kind: row.Kind, Source: row.Source, Status: row.Status, UpdatedAt: row.UpdatedAt.UTC()}
}

// taggedMessage is a message row with its tag.
func taggedMessage(ctx context.Context, q *db.Queries, row db.TangentMessage) (domain.Message, error) {
	messages := []domain.Message{messageFromRow(row)}
	err := attachTags(ctx, q, messages)
	return messages[0], err
}

// AttachTags sets the tags of the messages that have one (one query); the
// fisheye reads them for its head starts.
func (s *Store) AttachTags(ctx context.Context, messages []domain.Message) error {
	return attachTags(ctx, s.q, messages)
}

// attachTags sets the tags of the messages that have one (one query).
func attachTags(ctx context.Context, q *db.Queries, messages []domain.Message) error {
	ids := make([]uuid.UUID, 0, len(messages))
	for _, m := range messages {
		if id, ok := parseID(m.ID); ok && m.Kind == domain.MessageKindChat {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.ListMessageTags(ctx, ids)
	if err != nil {
		return fmt.Errorf("list tags: %w", err)
	}
	byID := make(map[string]*domain.MessageTag, len(rows))
	for _, row := range rows {
		byID[row.MessageID.String()] = tagFromRow(row)
	}
	for i := range messages {
		messages[i].Tag = byID[messages[i].ID]
	}
	return nil
}

// TagDraftsMax bounds the drafts one listing returns (Truncated beyond).
const TagDraftsMax = 500

// TagDrafts is a tree's messages whose tag is a draft: the main line
// first, then the branches in outline order, each line by seq.
type TagDrafts struct {
	RootLineID string            `json:"rootLineId"`
	Drafts     []domain.TagDraft `json:"drafts"`
	Truncated  bool              `json:"truncated"`
}

// ListTagDrafts lists the draft tags of the tree of any of its lines (one
// query), at most TagDraftsMax, leaving out discarded branches; each
// draft's content is a snippet of at most domain.TagDraftContentRunes.
func (s *Store) ListTagDrafts(ctx context.Context, tenant, lineID string) (TagDrafts, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return TagDrafts{}, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return TagDrafts{}, err
	}
	// One rune past the snippet tells CutRunes the content was longer.
	rows, err := s.q.ListTreeTagDrafts(ctx, db.ListTreeTagDraftsParams{
		TenantID: tenant, RootLineID: root, RowLimit: TagDraftsMax + 1, ContentRunes: domain.TagDraftContentRunes + 1,
	})
	if err != nil {
		return TagDrafts{}, fmt.Errorf("list tag drafts: %w", err)
	}
	out := TagDrafts{RootLineID: root.String(), Drafts: make([]domain.TagDraft, 0, min(len(rows), TagDraftsMax)), Truncated: len(rows) > TagDraftsMax}
	for _, row := range rows[:min(len(rows), TagDraftsMax)] {
		out.Drafts = append(out.Drafts, domain.TagDraft{
			LineID: row.LineID.String(), MessageID: row.ID.String(), Seq: row.Seq, Role: row.Role, Content: domain.CutRunes(row.Content, domain.TagDraftContentRunes),
			Tag: domain.MessageTag{Kind: row.TagKind, Source: row.TagSource, Status: row.TagStatus, UpdatedAt: row.TagUpdatedAt.UTC()},
		})
	}
	return out, nil
}

// ibisJobInput is what an ibis_tag job remembers: the newest message seq
// it read (the next job starts after it).
type ibisJobInput struct {
	UptoSeq int64 `json:"uptoSeq"`
}

// IbisCandidates is what the next ibis_tag job of a line reads: its newest
// untagged operator and assistant messages after the last finished job and
// up to UptoSeq (oldest first). UptoSeq is the next job's cursor.
type IbisCandidates struct {
	Messages []domain.Message
	UptoSeq  int64
}

// ibisScanFactor: a tagging job looks at the newest limit × this messages
// after its cursor (a long line that turns ibis on is tagged from its end).
const ibisScanFactor = 2

// IbisCandidates reads the messages a tagging job of the line tags: of the
// newest limit × ibisScanFactor messages after the last finished job and up
// to uptoSeq (the newest message the job reads, tagged or not), the
// untagged ones, at most limit. The caller has the line.
func (s *Store) IbisCandidates(ctx context.Context, lineID string, uptoSeq int64, limit int) (IbisCandidates, error) {
	id, ok := parseID(lineID)
	if !ok {
		return IbisCandidates{}, domain.ErrLineNotFound
	}
	after, err := s.ibisCursor(ctx, id)
	if err != nil {
		return IbisCandidates{}, err
	}
	limit = max(limit, 1)
	rows, err := s.q.ListUntaggedChatMessages(ctx, db.ListUntaggedChatMessagesParams{
		LineID: id, AfterSeq: after, UptoSeq: uptoSeq, ScanLimit: int32(limit * ibisScanFactor), RowLimit: int32(limit),
	})
	if err != nil {
		return IbisCandidates{}, fmt.Errorf("list untagged messages: %w", err)
	}
	return IbisCandidates{Messages: newestFirst(rows), UptoSeq: uptoSeq}, nil
}

func (s *Store) ibisCursor(ctx context.Context, lineID uuid.UUID) (int64, error) {
	raw, err := s.q.LatestDoneJobInput(ctx, db.LatestDoneJobInputParams{LineID: uuid.NullUUID{UUID: lineID, Valid: true}, Kind: JobKindIbisTag})
	if noRows(err) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read the last tagging job: %w", err)
	}
	var in ibisJobInput
	_ = json.Unmarshal(raw, &in)
	return in.UptoSeq, nil
}

// AITag is a tag a model proposed for a message.
type AITag struct {
	MessageID string
	Kind      string
}

// AITagged is a finished ibis_tag job and the messages it tagged (with
// their tags).
type AITagged struct {
	Job        Job
	RootLineID string
	Messages   []domain.Message
}

// FinishIbisTags ends an ibis_tag job under the locks line → job: failed
// with failure, or done with the tags written (as status) on the messages
// that are still finished operator or assistant messages of the line and
// have no tag; a tag that is there, the operator's above all, stays.
func (s *Store) FinishIbisTags(ctx context.Context, jobID string, tags []AITag, status, failure string, hooks ...TxHook) (AITagged, error) {
	peek, err := s.GetJob(ctx, jobID)
	if err != nil {
		return AITagged{}, err
	}
	lineID, ok := parseID(peek.LineID)
	if !ok {
		return AITagged{}, domain.ErrJobNotFound
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (AITagged, error) {
		if _, err := lockLineByID(ctx, q, lineID); err != nil {
			return AITagged{}, err
		}
		job, err := lockJob(ctx, q, jobID)
		if err != nil {
			return AITagged{}, err
		}
		jobStatus := JobDone
		if failure != "" {
			jobStatus = JobFailed
		}
		done, err := finishJob(ctx, q, job.ID, jobStatus, failure)
		if err != nil {
			return AITagged{}, err
		}
		root, err := rootOf(ctx, q, lineID)
		if err != nil {
			return AITagged{}, err
		}
		out := AITagged{Job: jobFromRow(done), RootLineID: root.String(), Messages: []domain.Message{}}
		if failure != "" {
			return out, nil
		}
		out.Messages, err = insertAITags(ctx, q, lineID, job, tags, status)
		return out, err
	})
}

func insertAITags(ctx context.Context, q *db.Queries, lineID uuid.UUID, job db.TangentJob, tags []AITag, status string) ([]domain.Message, error) {
	out := []domain.Message{}
	for _, tag := range tags {
		id, ok := parseID(tag.MessageID)
		if !ok || !domain.ValidTagKind(tag.Kind) {
			continue
		}
		message, err := q.GetMessage(ctx, id)
		if noRows(err) || (err == nil && (message.LineID != lineID || !taggable(message))) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("get message: %w", err)
		}
		_, err = q.InsertAITag(ctx, db.InsertAITagParams{
			MessageID: id, TenantID: message.TenantID, Kind: tag.Kind, Status: status, SourceJobID: uuid.NullUUID{UUID: job.ID, Valid: true},
		})
		if noRows(err) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("write a tag: %w", err)
		}
		view, err := taggedMessage(ctx, q, message)
		if err != nil {
			return nil, err
		}
		out = append(out, view)
	}
	slices.SortFunc(out, func(a, b domain.Message) int { return int(a.Seq - b.Seq) })
	return out, nil
}

// wrapErr wraps a failure with what was being done; nil stays nil.
func wrapErr(err error, what string) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", what, err)
}
