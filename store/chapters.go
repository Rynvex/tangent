package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Topic cuts and milestones are stored per conversation (root_line_id); the
// chapters of a line are computed on every read.

// ChaptersView is the chapters of one line of a conversation and the
// milestones that sit on a message of that line.
type ChaptersView struct {
	LineID     string
	RootLineID string
	Chapters   []domain.Chapter
	Milestones []domain.ChapterCut
}

// ListChapters computes the chapters of a line.
func (s *Store) ListChapters(ctx context.Context, tenant, lineID string) (ChaptersView, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return ChaptersView{}, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return ChaptersView{}, err
	}
	messages, err := s.chapterMessages(ctx, line.ID)
	if err != nil {
		return ChaptersView{}, err
	}
	cuts, err := s.chapterCuts(ctx, root)
	if err != nil {
		return ChaptersView{}, err
	}
	anchors, err := s.q.ListBranchAnchorsInLine(ctx, line.ID)
	if err != nil {
		return ChaptersView{}, fmt.Errorf("list branch anchors: %w", err)
	}
	branches := make([]domain.ChapterBranch, 0, len(anchors))
	for _, anchor := range anchors {
		branches = append(branches, domain.ChapterBranch{LineID: anchor.LineID.String(), AnchorMessageID: anchor.AnchorMessageID.String()})
	}
	view := ChaptersView{
		LineID: line.ID.String(), RootLineID: root.String(), Milestones: []domain.ChapterCut{},
		Chapters: domain.ComputeChapters(messages, cuts, branches, s.limits.Chapters),
	}
	onLine := make(map[string]bool, len(messages))
	for _, message := range messages {
		onLine[message.ID] = true
	}
	for _, cut := range cuts {
		if cut.Kind == domain.ChapterKindMilestone && onLine[cut.MessageID] {
			view.Milestones = append(view.Milestones, cut)
		}
	}
	return view, nil
}

func (s *Store) chapterMessages(ctx context.Context, lineID uuid.UUID) ([]domain.ChapterMessage, error) {
	rows, err := s.q.ListChapterMessages(ctx, db.ListChapterMessagesParams{LineID: lineID, RowLimit: int32(s.limits.Chapters.MaxMessages)})
	if err != nil {
		return nil, fmt.Errorf("list chapter messages: %w", err)
	}
	out := make([]domain.ChapterMessage, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.ChapterMessage{ID: row.ID.String(), Seq: row.Seq, At: row.CreatedAt, IsCard: row.Kind == domain.MessageKindBranchCard})
	}
	return out, nil
}

func (s *Store) chapterCuts(ctx context.Context, root uuid.UUID) ([]domain.ChapterCut, error) {
	rows, err := s.q.ListChapterCuts(ctx, root)
	if err != nil {
		return nil, fmt.Errorf("list chapter cuts: %w", err)
	}
	out := make([]domain.ChapterCut, 0, len(rows))
	for _, row := range rows {
		out = append(out, chapterCutFromRow(row))
	}
	return out, nil
}

// MilestoneInput marks a message of a conversation as a chapter start.
type MilestoneInput struct {
	Tenant    string
	LineID    string
	MessageID string
	Title     string
	Actor     string
}

// ChapterChange is a stored cut and the conversation it belongs to.
type ChapterChange struct {
	RootLineID string
	Cut        domain.ChapterCut
}

// AddMilestone stores a milestone on a message of the line's conversation,
// under the main line's lock so the cap holds. An archived conversation is
// read-only.
func (s *Store) AddMilestone(ctx context.Context, in MilestoneInput, hooks ...TxHook) (ChapterChange, error) {
	title := strings.TrimSpace(in.Title)
	if utf8.RuneCountInString(title) > s.limits.Chapters.MilestoneTitleMaxRunes {
		return ChapterChange{}, domain.ErrChapterTitleInvalid
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (ChapterChange, error) {
		root, err := s.lockOpenRoot(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return ChapterChange{}, err
		}
		message, err := messageInTree(ctx, q, root.ID, in.MessageID)
		if err != nil {
			return ChapterChange{}, err
		}
		count, err := q.CountChapterCutsByKind(ctx, db.CountChapterCutsByKindParams{RootLineID: root.ID, Kind: domain.ChapterKindMilestone})
		if err != nil {
			return ChapterChange{}, fmt.Errorf("count milestones: %w", err)
		}
		if int(count) >= s.limits.Chapters.MilestoneMaxPerTree {
			return ChapterChange{}, domain.ErrChapterMilestoneLimit
		}
		cut, err := s.insertCut(ctx, q, cutParams{
			tenant: root.TenantID, root: root.ID, line: message.LineID, message: message.ID,
			kind: domain.ChapterKindMilestone, title: title, actor: in.Actor,
		})
		if err != nil {
			return ChapterChange{}, err
		}
		if cut == nil {
			return ChapterChange{}, domain.ErrChapterMilestoneExists
		}
		return ChapterChange{RootLineID: root.ID.String(), Cut: *cut}, nil
	})
}

// messageInTree loads a message that sits on a line of the root's tree.
func messageInTree(ctx context.Context, q *db.Queries, root uuid.UUID, messageID string) (db.TangentMessage, error) {
	id, ok := parseID(messageID)
	if !ok {
		return db.TangentMessage{}, domain.ErrChapterMessageNotFound
	}
	message, err := q.GetMessage(ctx, id)
	if err != nil {
		return db.TangentMessage{}, lookup(err, domain.ErrChapterMessageNotFound, "get message")
	}
	messageRoot, err := rootOf(ctx, q, message.LineID)
	if err != nil {
		return db.TangentMessage{}, err
	}
	if messageRoot != root {
		return db.TangentMessage{}, domain.ErrChapterMessageNotFound
	}
	return message, nil
}

// DeleteMilestone removes a milestone of the line's conversation and returns
// the main line's id.
func (s *Store) DeleteMilestone(ctx context.Context, tenant, lineID, milestoneID string, hooks ...TxHook) (string, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (string, error) {
		root, err := s.lockOpenRoot(ctx, q, tenant, lineID)
		if err != nil {
			return "", err
		}
		id, ok := parseID(milestoneID)
		if !ok {
			return "", domain.ErrChapterMilestoneNotFound
		}
		deleted, err := q.DeleteChapterMilestone(ctx, db.DeleteChapterMilestoneParams{ID: id, RootLineID: root.ID})
		if err != nil {
			return "", fmt.Errorf("delete milestone: %w", err)
		}
		if deleted == 0 {
			return "", domain.ErrChapterMilestoneNotFound
		}
		return root.ID.String(), nil
	})
}

// TopicCut is the result of RecordTopicCut: Cut is nil when the message
// already had a topic cut.
type TopicCut struct {
	RootLineID string
	Cut        *domain.ChapterCut
}

// RecordTopicCut stores a topic cut on a message of the line (SaveSummary
// records its own; this is for hosts that summarise elsewhere).
func (s *Store) RecordTopicCut(ctx context.Context, tenant, lineID, messageID, topic string, hooks ...TxHook) (TopicCut, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (TopicCut, error) {
		line, err := s.lockLine(ctx, q, tenant, lineID)
		if err != nil {
			return TopicCut{}, err
		}
		message, err := messageOn(ctx, q, line.ID, messageID)
		if errors.Is(err, domain.ErrMessageNotFound) {
			return TopicCut{}, domain.ErrChapterMessageNotFound
		}
		if err != nil {
			return TopicCut{}, err
		}
		root, err := rootOf(ctx, q, line.ID)
		if err != nil {
			return TopicCut{}, err
		}
		out := TopicCut{RootLineID: root.String()}
		out.Cut, err = s.insertCut(ctx, q, cutParams{
			tenant: line.TenantID, root: root, line: line.ID, message: message.ID, kind: domain.ChapterKindTopic, title: s.topicTitle(topic),
		})
		return out, err
	})
}

// cutParams is one chapter cut to insert.
type cutParams struct {
	tenant              string
	root, line, message uuid.UUID
	kind, title, actor  string
}

// insertCut stores a cut; nil when the message already has one of that kind.
func (s *Store) insertCut(ctx context.Context, q *db.Queries, p cutParams) (*domain.ChapterCut, error) {
	row, err := q.InsertChapterCut(ctx, db.InsertChapterCutParams{
		TenantID: p.tenant, RootLineID: p.root, LineID: p.line, MessageID: p.message, Kind: p.kind, Title: p.title, CreatedBy: strings.TrimSpace(p.actor),
	})
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("insert chapter cut: %w", err)
	}
	cut := chapterCutFromRow(row)
	return &cut, nil
}

// topicTitle trims a topic to the stored title length.
func (s *Store) topicTitle(topic string) string {
	title := strings.TrimSpace(topic)
	if runes := []rune(title); len(runes) > s.limits.Chapters.TopicTitleMaxRunes {
		title = string(runes[:s.limits.Chapters.TopicTitleMaxRunes])
	}
	return title
}
