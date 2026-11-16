package store

import (
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Conversions from rows to the domain's API shapes. Stored JSON is the
// library's own; a value that fails to decode reads as its zero value.

func timePtr(ts pgtype.Timestamptz) *time.Time {
	if !ts.Valid {
		return nil
	}
	value := ts.Time.UTC()
	return &value
}

// anyTimePtr reads a nullable timestamptz column sqlc could only type as
// any: pgx hands back a time.Time, or nil for NULL.
func anyTimePtr(value any) *time.Time {
	ts, ok := value.(time.Time)
	if !ok {
		return nil
	}
	ts = ts.UTC()
	return &ts
}

func hostMeta(raw []byte) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("{}")
	}
	return json.RawMessage(raw)
}

func summaryFromJSON(raw []byte) domain.Summary {
	var summary domain.Summary
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &summary)
	}
	return domain.NormalizeSummary(summary)
}

func lineFromRow(row db.TangentLine) domain.Line {
	line := domain.Line{
		ID:                row.ID.String(),
		TenantID:          row.TenantID,
		Title:             row.Title,
		Status:            row.Status,
		StatusDetail:      row.StatusDetail,
		Provider:          row.Provider,
		Model:             row.Model,
		Folder:            row.Folder,
		Tags:              tagsOf(row.Tags),
		Unread:            int(row.Unread),
		Summary:           summaryFromJSON(row.Summary),
		SummaryUptoSeq:    row.SummaryUptoSeq.Int64,
		NotesRevision:     int(row.NotesRevision),
		NotesRevisionSent: int(row.NotesRevisionSent),
		Usage:             domain.Usage{InputTokens: row.InputTokens, OutputTokens: row.OutputTokens, CostUSD: row.CostUsd},
		HostMeta:          hostMeta(row.HostMeta),
		LastActivityAt:    row.LastActivityAt.UTC(),
		ArchivedAt:        timePtr(row.ArchivedAt),
		CreatedBy:         row.CreatedBy,
		CreatedAt:         row.CreatedAt.UTC(),
		UpdatedAt:         row.UpdatedAt.UTC(),
		PinnedAt:          timePtr(row.PinnedAt),
	}
	if row.ImportBatchID.Valid {
		line.ImportBatchID = row.ImportBatchID.UUID.String()
	}
	if capsule := capsuleFromJSON(row.OriginCapsule); capsule != nil {
		line.Capsule, line.SpunOffFrom = capsule, &capsule.From
	}
	return line
}

// capsuleFromJSON reads a stored origin capsule; nil without one (or one
// that cannot be read).
func capsuleFromJSON(raw []byte) *domain.OriginCapsule {
	if len(raw) == 0 {
		return nil
	}
	var capsule domain.OriginCapsule
	if err := json.Unmarshal(raw, &capsule); err != nil || capsule.Mode == "" {
		return nil
	}
	return &capsule
}

func messageFromRow(row db.TangentMessage) domain.Message {
	var meta domain.MessageMeta
	if len(row.Meta) > 0 {
		_ = json.Unmarshal(row.Meta, &meta)
	}
	if meta.EditedAt != nil {
		editedAt := meta.EditedAt.UTC()
		meta.EditedAt = &editedAt
	}
	return domain.Message{
		ID:        row.ID.String(),
		Seq:       row.Seq,
		LineID:    row.LineID.String(),
		Role:      row.Role,
		Kind:      row.Kind,
		Content:   row.Content,
		Status:    row.Status,
		Meta:      meta,
		HostMeta:  hostMeta(row.HostMeta),
		Pinned:    row.Pinned,
		CreatedAt: row.CreatedAt.UTC(),
	}
}

func messagesFromRows(rows []db.TangentMessage) []domain.Message {
	out := make([]domain.Message, 0, len(rows))
	for _, row := range rows {
		out = append(out, messageFromRow(row))
	}
	return out
}

// newestFirst turns rows read newest first into messages in seq order.
func newestFirst(rows []db.TangentMessage) []domain.Message {
	out := messagesFromRows(rows)
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func branchRefFromRow(row db.TangentBranch) domain.BranchRef {
	return domain.BranchRef{
		ParentLineID:    row.ParentLineID.String(),
		RootLineID:      row.RootLineID.String(),
		AnchorMessageID: row.AnchorMessageID.String(),
		Depth:           int(row.Depth),
		Purpose:         row.Purpose,
		Kind:            row.Kind,
		Status:          row.Status,
		Origin:          row.Origin,
	}
}

func packFromJSON(raw []byte) domain.BranchPack {
	pack := domain.BranchPack{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &pack)
	}
	if pack.Recent == nil {
		pack.Recent = []domain.BranchPackMessage{}
	}
	return pack
}

// branchLineFields are the line columns a branch view shows.
type branchLineFields struct {
	provider, model, status string
	unread, messageCount    int32
	lastActivityAt          time.Time
	archivedAt              pgtype.Timestamptz
}

func (s *Store) branchView(row db.TangentBranch, line branchLineFields) domain.BranchView {
	return domain.BranchView{
		LineID:           row.LineID.String(),
		ParentLineID:     row.ParentLineID.String(),
		RootLineID:       row.RootLineID.String(),
		AnchorMessageID:  row.AnchorMessageID.String(),
		Depth:            int(row.Depth),
		Purpose:          row.Purpose,
		Kind:             row.Kind,
		Status:           row.Status,
		Origin:           row.Origin,
		Excerpt:          row.Excerpt,
		ConclusionLine:   row.ConclusionLine,
		CardMessageID:    idString(row.CardMessageID),
		Provider:         line.provider,
		Model:            line.model,
		LineStatus:       line.status,
		Unread:           int(line.unread),
		MessageCount:     int(line.messageCount),
		DraftStatus:      s.draftStatus(row),
		Archived:         line.archivedAt.Valid,
		CreatedAt:        row.CreatedAt.UTC(),
		ClosedAt:         timePtr(row.ClosedAt),
		LastActivityAt:   line.lastActivityAt.UTC(),
		MergedIntoLineID: idString(row.MergedIntoLineID),
		KeptAt:           timePtr(row.KeptAt),
	}
}

func (s *Store) branchViewFromViewRow(row db.GetBranchViewRow) domain.BranchView {
	view := s.branchView(row.TangentBranch, branchLineFields{
		provider: row.LineProvider, model: row.LineModel, status: row.LineStatus, unread: row.LineUnread,
		messageCount: row.MessageCount, lastActivityAt: row.LineLastActivityAt, archivedAt: row.LineArchivedAt,
	})
	view.Leaf = leafSummary(row.LeafKind, row.LeafLine, row.LeafStatus)
	view.CardEditedAt = anyTimePtr(row.CardEditedAt)
	if row.AnchorTagKind.Valid {
		view.AnchorTag = &domain.MessageTag{
			Kind: row.AnchorTagKind.String, Source: row.AnchorTagSource.String, Status: row.AnchorTagStatus.String, UpdatedAt: row.AnchorTagUpdatedAt.Time.UTC(),
		}
	}
	return view
}

// draftStatus is the branch's draft state with an overdue draft read as failed.
func (s *Store) draftStatus(row db.TangentBranch) string {
	return domain.EffectiveBranchDraftStatus(row.DraftStatus, timePtr(row.DraftStartedAt), s.now(), s.limits.Branch.DraftTimeout)
}

func noteFromRow(row db.TangentNote) domain.Note {
	return domain.Note{
		ID: row.ID.String(), Section: row.Section, Text: row.Text, Status: row.Status,
		SourceLineID: idString(row.SourceLineID), SourceMessageID: idString(row.SourceMessageID),
		SourceCardMessageID: idString(row.SourceCardMessageID), SourceLabel: row.SourceLabel, CopiedFromNoteID: idString(row.CopiedFromNoteID),
		SupersededBy: idString(row.SupersededBy),
		CreatedBy:    row.CreatedBy, CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(),
	}
}

func notesFromRows(rows []db.TangentNote) []domain.Note {
	out := make([]domain.Note, 0, len(rows))
	for _, row := range rows {
		out = append(out, noteFromRow(row))
	}
	return out
}

func chapterCutFromRow(row db.TangentChapterCut) domain.ChapterCut {
	return domain.ChapterCut{
		ID: row.ID.String(), MessageID: row.MessageID.String(), Kind: row.Kind,
		Title: row.Title, CreatedBy: row.CreatedBy, CreatedAt: row.CreatedAt.UTC(),
	}
}

// tagsOf is a line's tags, never nil (JSON [] rather than null).
func tagsOf(tags []string) []string {
	if tags == nil {
		return []string{}
	}
	return tags
}

// noTags is the tags of a new branch line (or an untagged main line): a
// TEXT[] NOT NULL column needs an empty array, which a nil slice is not.
func noTags() []string { return []string{} }
