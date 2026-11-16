package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// SaveSummaryInput is a finished rolling summary of a line. UptoSeq is the
// seq of the newest message it covers (0 = none); it must be a finished
// message of the line and never below the line's current cursor. ReportedTopicStart is the message id the
// model says the current topic starts at (untrusted). JobID, when set, is
// the summary job the result belongs to: it must still be pending, and is
// finished with the write.
type SaveSummaryInput struct {
	Tenant             string
	LineID             string
	JobID              string
	Summary            domain.Summary
	UptoSeq            int64
	ReportedTopicStart string
	Actor              string
	// SkipTopicCut stores the summary without recording a topic cut (the
	// host does not keep chapters).
	SkipTopicCut bool
}

// SavedSummary is the line with its new summary and the topic cut the
// summary recorded (nil when none was due or the message already had one).
type SavedSummary struct {
	Line       domain.LineView
	RootLineID string
	TopicCut   *domain.ChapterCut
}

// SaveSummary stores a rolling summary and its seq cursor under the line's
// row lock and records the topic cut it implies (domain.TopicCutFor over
// the messages after the previous cursor), in one transaction.
func (s *Store) SaveSummary(ctx context.Context, in SaveSummaryInput, hooks ...TxHook) (SavedSummary, error) {
	summary, err := json.Marshal(domain.NormalizeSummary(in.Summary))
	if err != nil {
		return SavedSummary{}, fmt.Errorf("marshal summary: %w", err)
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (SavedSummary, error) {
		line, err := s.lockLine(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return SavedSummary{}, err
		}
		finish, err := s.claimSummaryJob(ctx, q, line, in.JobID)
		if err != nil {
			return SavedSummary{}, err
		}
		if err := requireCursorOnLine(ctx, q, line, in.UptoSeq); err != nil {
			return SavedSummary{}, err
		}
		cutAt := ""
		if !in.SkipTopicCut {
			if cutAt, err = topicCutFor(ctx, q, line, in); err != nil {
				return SavedSummary{}, err
			}
		}
		cursor := pgtype.Int8{Int64: in.UptoSeq, Valid: in.UptoSeq > 0}
		lineRow, err := q.SetLineSummary(ctx, db.SetLineSummaryParams{ID: line.ID, Summary: summary, SummaryUptoSeq: cursor})
		if err != nil {
			return SavedSummary{}, fmt.Errorf("set summary: %w", err)
		}
		out, err := s.recordSummaryCut(ctx, q, line, cutAt, in)
		if err != nil {
			return SavedSummary{}, err
		}
		if err := finish(); err != nil {
			return SavedSummary{}, err
		}
		out.Line, err = s.hydrateOne(ctx, q, lineRow)
		return out, err
	})
}

// claimSummaryJob checks the job a result belongs to and returns the step
// that finishes it; without a job there is nothing to finish.
func (s *Store) claimSummaryJob(ctx context.Context, q *db.Queries, line db.TangentLine, jobID string) (func() error, error) {
	if jobID == "" {
		return func() error { return nil }, nil
	}
	job, err := lockJob(ctx, q, jobID)
	if err != nil {
		return nil, err
	}
	if job.Status != JobPending || job.Kind != JobKindSummary || !job.LineID.Valid || job.LineID.UUID != line.ID {
		return nil, domain.ErrJobNotPending
	}
	return func() error {
		_, err := finishJob(ctx, q, job.ID, JobDone, "")
		return err
	}, nil
}

// requireCursorOnLine refuses a cursor that is not a finished message of the
// line, or that would move the line's cursor backwards (a late or duplicate
// summary must never undo a newer one; a reset is the store's own doing).
func requireCursorOnLine(ctx context.Context, q *db.Queries, line db.TangentLine, uptoSeq int64) error {
	if line.SummaryUptoSeq.Valid && uptoSeq < line.SummaryUptoSeq.Int64 {
		return invalidInput("the summary cursor cannot move backwards")
	}
	if uptoSeq == 0 {
		return nil
	}
	message, err := q.GetLineMessageBySeq(ctx, db.GetLineMessageBySeqParams{LineID: line.ID, Seq: uptoSeq})
	if noRows(err) || (err == nil && message.Status == domain.MessagePending) {
		return invalidInput("the summary cursor is not a finished message of this conversation")
	}
	if err != nil {
		return fmt.Errorf("check summary cursor: %w", err)
	}
	return nil
}

// topicCutFor decides where the new summary's topic cut lands ("" = none).
func topicCutFor(ctx context.Context, q *db.Queries, line db.TangentLine, in SaveSummaryInput) (string, error) {
	input, err := unsummarized(ctx, q, line)
	if err != nil {
		return "", err
	}
	previous := summaryFromJSON(line.Summary)
	return domain.TopicCutFor(previous.Topic, in.Summary, in.ReportedTopicStart, input, in.UptoSeq), nil
}

func (s *Store) recordSummaryCut(ctx context.Context, q *db.Queries, line db.TangentLine, cutAt string, in SaveSummaryInput) (SavedSummary, error) {
	root, err := rootOf(ctx, q, line.ID)
	if err != nil {
		return SavedSummary{}, err
	}
	out := SavedSummary{RootLineID: root.String()}
	if cutAt == "" {
		return out, nil
	}
	message, err := messageOn(ctx, q, line.ID, cutAt)
	if err != nil {
		return SavedSummary{}, err
	}
	out.TopicCut, err = s.insertCut(ctx, q, cutParams{
		tenant: line.TenantID, root: root, line: line.ID, message: message.ID,
		kind: domain.ChapterKindTopic, title: s.topicTitle(in.Summary.Topic), actor: in.Actor,
	})
	return out, err
}
