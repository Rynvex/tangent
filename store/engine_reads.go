package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Reads and in-transaction helpers the engine's feature modules use.

// MarkNotesRevisionSent records, inside a write's transaction (a TxHook),
// the notes revision a finished turn carried. It never moves backwards.
func MarkNotesRevisionSent(ctx context.Context, tx Tx, lineID string, revision int) error {
	id, ok := parseID(lineID)
	if !ok {
		return domain.ErrLineNotFound
	}
	if revision <= 0 {
		return nil
	}
	if err := db.New(tx).SetNotesRevisionSent(ctx, db.SetNotesRevisionSentParams{ID: id, NotesRevisionSent: int32(revision)}); err != nil {
		return fmt.Errorf("record notes revision sent: %w", err)
	}
	return nil
}

// FailJob ends a pending job of any kind as failed with reason: a card
// draft through its branch (FinishBranchDraft), any other job directly.
// A job that is no longer pending returns ErrJobNotPending.
func (s *Store) FailJob(ctx context.Context, jobID, reason string) error {
	job, err := s.GetJob(ctx, jobID)
	if err != nil {
		return err
	}
	if job.Status != JobPending {
		return domain.ErrJobNotPending
	}
	if job.Kind == JobKindCardDraft {
		_, err = s.FinishBranchDraft(ctx, jobID, domain.DraftFailed(reason))
		return err
	}
	_, err = s.FinishJob(ctx, jobID, JobFailed, reason)
	return err
}

// ActiveNotes returns the active notes of a conversation by its main line's
// id. The id must come from the store (BegunTurn.RootLineID): there is no
// tenant check here.
func (s *Store) ActiveNotes(ctx context.Context, rootLineID string) ([]domain.Note, error) {
	root, ok := parseID(rootLineID)
	if !ok {
		return nil, domain.ErrLineNotFound
	}
	rows, err := s.q.ListActiveNotes(ctx, root)
	if err != nil {
		return nil, fmt.Errorf("list active notes: %w", err)
	}
	return notesFromRows(rows), nil
}

// BranchPurposes returns the purpose of each of the tenant's branch lines
// among lineIDs; ids that are not branches (or not ids) are left out.
func (s *Store) BranchPurposes(ctx context.Context, tenant string, lineIDs []string) (map[string]string, error) {
	ids := make([]uuid.UUID, 0, len(lineIDs))
	for _, id := range lineIDs {
		if parsed, ok := parseID(id); ok {
			ids = append(ids, parsed)
		}
	}
	out := map[string]string{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.q.ListBranchPurposes(ctx, db.ListBranchPurposesParams{TenantID: tenant, LineIds: ids})
	if err != nil {
		return nil, fmt.Errorf("list branch purposes: %w", err)
	}
	for _, row := range rows {
		out[row.LineID.String()] = row.Purpose
	}
	return out, nil
}

// UnsummarizedSize is how much a summary of a line would cover: the finished
// messages after its cursor up to the first undelivered card, and their
// length in characters (EstimateTokens never exceeds chars + messages).
type UnsummarizedSize struct {
	Messages int64
	Chars    int64
}

// UnsummarizedSize measures a line's unsummarized history without reading
// the messages.
func (s *Store) UnsummarizedSize(ctx context.Context, tenant, lineID string) (UnsummarizedSize, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return UnsummarizedSize{}, err
	}
	row, err := s.q.GetUnsummarizedSize(ctx, db.GetUnsummarizedSizeParams{LineID: line.ID, AfterSeq: line.SummaryUptoSeq.Int64})
	if err != nil {
		return UnsummarizedSize{}, fmt.Errorf("measure unsummarized messages: %w", err)
	}
	return UnsummarizedSize{Messages: row.Messages, Chars: row.Chars}, nil
}
