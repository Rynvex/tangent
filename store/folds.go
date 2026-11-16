package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// JobKindFoldSummary writes the summary of a drafting fold.
const JobKindFoldSummary = "fold_summary"

// CreateFoldInput folds the messages of a line from one message to another
// (either order). Summary "" drafts it: a fold_summary job of Feature is
// started in the same transaction. SourceJobID marks a summary a model
// wrote (an accepted suggestion's).
type CreateFoldInput struct {
	Tenant        string
	LineID        string
	FromMessageID string
	ToMessageID   string
	Summary       string
	Actor         string
	Feature       string
	SourceJobID   string
}

// FoldWrite is a fold after a write: its conversation, the job that drafts
// its summary (nil unless one was started) and the messages it covers
// (when it was created).
type FoldWrite struct {
	Fold       domain.Fold
	RootLineID string
	Job        *Job
	Messages   []domain.Message
}

// foldJobInput is what a fold_summary job remembers.
type foldJobInput struct {
	FoldID string `json:"foldId"`
}

// CreateFold folds a stretch of a line under the line's lock: both ends on
// the line and finished, MinMessages..MaxMessages messages, none pending,
// no overlap with the line's drafting or active folds (fold_overlap) and
// room under MaxActivePerLine (fold_limit). An archived conversation is
// read-only.
func (s *Store) CreateFold(ctx context.Context, in CreateFoldInput, hooks ...TxHook) (FoldWrite, error) {
	summary, err := domain.NormalizeFoldSummary(in.Summary, s.limits.Fold)
	if err != nil {
		return FoldWrite{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (FoldWrite, error) {
		line, err := s.lockLine(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return FoldWrite{}, err
		}
		if line.ArchivedAt.Valid {
			return FoldWrite{}, domain.ErrLineArchived
		}
		from, to, err := foldEnds(ctx, q, line.ID, in.FromMessageID, in.ToMessageID)
		if err != nil {
			return FoldWrite{}, err
		}
		messages, err := s.foldRange(ctx, q, line.ID, from.Seq, to.Seq)
		if err != nil {
			return FoldWrite{}, err
		}
		if err := s.checkFoldRoom(ctx, q, line.ID, from.Seq, to.Seq); err != nil {
			return FoldWrite{}, err
		}
		return s.insertFold(ctx, q, line, in, summary, from, to, messages)
	})
}

// foldEnds reads the two end messages (finished, on the line) in seq order.
func foldEnds(ctx context.Context, q *db.Queries, lineID uuid.UUID, fromID, toID string) (db.TangentMessage, db.TangentMessage, error) {
	from, err := messageOn(ctx, q, lineID, fromID)
	if err != nil {
		return db.TangentMessage{}, db.TangentMessage{}, err
	}
	to, err := messageOn(ctx, q, lineID, toID)
	if err != nil {
		return db.TangentMessage{}, db.TangentMessage{}, err
	}
	if from.Seq > to.Seq {
		from, to = to, from
	}
	if from.Status == domain.MessagePending || to.Status == domain.MessagePending {
		return db.TangentMessage{}, db.TangentMessage{}, domain.InvalidFold("the ends of a fold must be finished messages")
	}
	return from, to, nil
}

// foldRange reads the messages of the range and checks their number.
func (s *Store) foldRange(ctx context.Context, q *db.Queries, lineID uuid.UUID, fromSeq, toSeq int64) ([]domain.Message, error) {
	l := s.limits.Fold
	rows, err := q.ListLineMessagesInSeqRange(ctx, db.ListLineMessagesInSeqRangeParams{LineID: lineID, FromSeq: fromSeq, ToSeq: toSeq, RowLimit: int32(l.MaxMessages + 1)})
	if err != nil {
		return nil, fmt.Errorf("list the fold's messages: %w", err)
	}
	switch {
	case len(rows) > l.MaxMessages:
		return nil, domain.InvalidFold(fmt.Sprintf("a fold covers at most %d messages", l.MaxMessages))
	case len(rows) < l.MinMessages:
		return nil, domain.InvalidFold(fmt.Sprintf("a fold covers at least %d messages", l.MinMessages))
	}
	for _, row := range rows {
		if row.Status == domain.MessagePending {
			return nil, domain.InvalidFold("a fold cannot cover a reply that is still being written")
		}
	}
	return messagesFromRows(rows), nil
}

// checkFoldRoom refuses a range that overlaps a live fold of the line, or
// a line that holds as many as it may.
func (s *Store) checkFoldRoom(ctx context.Context, q *db.Queries, lineID uuid.UUID, fromSeq, toSeq int64) error {
	live, err := q.ListLiveFolds(ctx, lineID)
	if err != nil {
		return fmt.Errorf("list folds: %w", err)
	}
	for _, fold := range live {
		if domain.FoldsOverlap(fold.FromSeq, fold.ToSeq, fromSeq, toSeq) {
			return domain.FoldOverlapError(fold.ID.String())
		}
	}
	if len(live) >= s.limits.Fold.MaxActivePerLine {
		return domain.ErrFoldLimit
	}
	return nil
}

func (s *Store) insertFold(ctx context.Context, q *db.Queries, line db.TangentLine, in CreateFoldInput, summary string, from, to db.TangentMessage, messages []domain.Message) (FoldWrite, error) {
	status := domain.FoldActive
	if summary == "" {
		status = domain.FoldDrafting
	}
	row, err := q.InsertFold(ctx, db.InsertFoldParams{
		TenantID: line.TenantID, LineID: line.ID, FromMessageID: from.ID, ToMessageID: to.ID, FromSeq: from.Seq, ToSeq: to.Seq,
		Summary: summary, MessageCount: int32(len(messages)), TokensOriginal: int32(domain.FoldTokens(messages)),
		TokensSummary: int32(domain.EstimateTokens(summary)), Status: status, CreatedBy: in.Actor,
	})
	if err != nil {
		return FoldWrite{}, fmt.Errorf("insert fold: %w", err)
	}
	out := FoldWrite{Messages: messages}
	jobID := nullID(in.SourceJobID)
	if status == domain.FoldDrafting {
		input, _ := json.Marshal(foldJobInput{FoldID: row.ID.String()})
		job, err := s.createJob(ctx, q, CreateJobInput{Tenant: line.TenantID, Kind: JobKindFoldSummary, Feature: in.Feature, LineID: line.ID.String(), Input: input})
		if err != nil {
			return FoldWrite{}, err
		}
		started := jobFromRow(job)
		out.Job, jobID = &started, uuid.NullUUID{UUID: job.ID, Valid: true}
	}
	if jobID.Valid {
		if row, err = q.SetFoldJob(ctx, db.SetFoldJobParams{ID: row.ID, JobID: jobID}); err != nil {
			return FoldWrite{}, fmt.Errorf("set the fold's job: %w", err)
		}
	}
	return s.foldWrite(ctx, q, row, out)
}

// foldWrite completes a write's result with the fold and its conversation.
func (s *Store) foldWrite(ctx context.Context, q *db.Queries, row db.TangentFold, out FoldWrite) (FoldWrite, error) {
	root, err := rootOf(ctx, q, row.LineID)
	if err != nil {
		return FoldWrite{}, err
	}
	out.Fold, out.RootLineID = foldFromRow(row), root.String()
	return out, nil
}

func foldFromRow(row db.TangentFold) domain.Fold {
	return domain.Fold{
		ID: row.ID.String(), LineID: row.LineID.String(), FromMessageID: row.FromMessageID.String(), ToMessageID: row.ToMessageID.String(),
		FromSeq: row.FromSeq, ToSeq: row.ToSeq, Summary: row.Summary, MessageCount: int(row.MessageCount),
		TokensOriginal: int(row.TokensOriginal), TokensSummary: int(row.TokensSummary), Status: row.Status, AIDrafted: row.SourceJobID.Valid && row.Summary != "",
		CreatedBy: row.CreatedBy, CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(),
	}
}

func foldsFromRows(rows []db.TangentFold) []domain.Fold {
	out := make([]domain.Fold, 0, len(rows))
	for _, row := range rows {
		out = append(out, foldFromRow(row))
	}
	return out
}

// FoldList is a line's folds.
type FoldList struct {
	LineID     string
	RootLineID string
	Folds      []domain.Fold
}

// ListFolds lists a line's folds that were not removed (drafting, active,
// failed) whose ends are still on it, in seq order.
func (s *Store) ListFolds(ctx context.Context, tenant, lineID string) (FoldList, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return FoldList{}, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return FoldList{}, err
	}
	rows, err := s.q.ListLineFolds(ctx, line.ID)
	if err != nil {
		return FoldList{}, fmt.Errorf("list folds: %w", err)
	}
	return FoldList{LineID: line.ID.String(), RootLineID: root.String(), Folds: foldsFromRows(rows)}, nil
}

// LiveFolds are a line's drafting and active folds whose ends are still on
// it, in seq order (what a prompt and a suggestion check read).
func (s *Store) LiveFolds(ctx context.Context, lineID string) ([]domain.Fold, error) {
	id, ok := parseID(lineID)
	if !ok {
		return nil, domain.ErrLineNotFound
	}
	rows, err := s.q.ListLiveFolds(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("list folds: %w", err)
	}
	return foldsFromRows(rows), nil
}

// RemoveFold takes a fold back (removed; its job, if drafting, no longer
// writes) under the lock of its line. Removed or unknown: fold_not_found.
func (s *Store) RemoveFold(ctx context.Context, tenant, foldID string, hooks ...TxHook) (FoldWrite, error) {
	id, ok := parseID(foldID)
	if !ok {
		return FoldWrite{}, domain.ErrFoldNotFound
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (FoldWrite, error) {
		line, row, err := lockFold(ctx, q, tenant, id)
		if err != nil {
			return FoldWrite{}, err
		}
		if row.Status == domain.FoldRemoved {
			return FoldWrite{}, domain.ErrFoldNotFound
		}
		if line.ArchivedAt.Valid {
			return FoldWrite{}, domain.ErrLineArchived
		}
		removed, err := q.RemoveFold(ctx, row.ID)
		if err != nil {
			return FoldWrite{}, fmt.Errorf("remove fold: %w", err)
		}
		return s.foldWrite(ctx, q, removed, FoldWrite{})
	})
}

// UpdateFold writes the operator's summary on a fold that was not removed
// (a drafting or failed one becomes active; its job no longer writes) under
// the lock of its line.
func (s *Store) UpdateFold(ctx context.Context, tenant, foldID, summary string, hooks ...TxHook) (FoldWrite, error) {
	id, ok := parseID(foldID)
	if !ok {
		return FoldWrite{}, domain.ErrFoldNotFound
	}
	summary, err := domain.NormalizeFoldSummary(summary, s.limits.Fold)
	if err != nil {
		return FoldWrite{}, err
	}
	if summary == "" {
		return FoldWrite{}, invalidInput("a summary is required")
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (FoldWrite, error) {
		line, row, err := lockFold(ctx, q, tenant, id)
		if err != nil {
			return FoldWrite{}, err
		}
		if row.Status == domain.FoldRemoved {
			return FoldWrite{}, domain.ErrFoldNotFound
		}
		if line.ArchivedAt.Valid {
			return FoldWrite{}, domain.ErrLineArchived
		}
		updated, err := q.UpdateFoldSummary(ctx, db.UpdateFoldSummaryParams{ID: row.ID, Summary: summary, TokensSummary: int32(domain.EstimateTokens(summary))})
		if err != nil {
			return FoldWrite{}, fmt.Errorf("update fold: %w", err)
		}
		return s.foldWrite(ctx, q, updated, FoldWrite{})
	})
}

// lockFold locks the line a fold of the tenant is on, then the fold; a
// fold that moved to another line meanwhile retries.
func lockFold(ctx context.Context, q *db.Queries, tenant string, id uuid.UUID) (db.TangentLine, db.TangentFold, error) {
	peek, err := q.GetFold(ctx, id)
	if err != nil {
		return db.TangentLine{}, db.TangentFold{}, lookup(err, domain.ErrFoldNotFound, "get fold")
	}
	if tenant != "" && peek.TenantID != tenant {
		return db.TangentLine{}, db.TangentFold{}, domain.ErrFoldNotFound
	}
	line, err := lockLineByID(ctx, q, peek.LineID)
	if err != nil {
		return db.TangentLine{}, db.TangentFold{}, err
	}
	row, err := q.GetFoldForUpdate(ctx, id)
	if err != nil {
		return db.TangentLine{}, db.TangentFold{}, lookup(err, domain.ErrFoldNotFound, "lock fold")
	}
	if row.LineID != line.ID {
		return db.TangentLine{}, db.TangentFold{}, errBranchMoved
	}
	return line, row, nil
}

// FoldSummaryResult is a finished fold_summary job: Written is false when
// the fold no longer waited on it (removed, or failed by a timeout).
type FoldSummaryResult struct {
	Fold       domain.Fold
	RootLineID string
	Job        Job
	Written    bool
}

// FinishFoldSummary ends a fold_summary job under the locks line → fold →
// job: done with the summary (the fold active), or failed with failure (the
// fold failed).
func (s *Store) FinishFoldSummary(ctx context.Context, jobID, summary, failure string, hooks ...TxHook) (FoldSummaryResult, error) {
	peek, err := s.GetJob(ctx, jobID)
	if err != nil {
		return FoldSummaryResult{}, err
	}
	var input foldJobInput
	_ = json.Unmarshal(peek.Input, &input)
	foldID, ok := parseID(input.FoldID)
	if !ok {
		return FoldSummaryResult{}, domain.ErrFoldNotFound
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (FoldSummaryResult, error) {
		_, row, err := lockFold(ctx, q, "", foldID)
		if err != nil {
			return FoldSummaryResult{}, err
		}
		job, err := lockJob(ctx, q, jobID)
		if err != nil {
			return FoldSummaryResult{}, err
		}
		return s.finishFoldSummary(ctx, q, row, job, summary, failure)
	})
}

func (s *Store) finishFoldSummary(ctx context.Context, q *db.Queries, row db.TangentFold, job db.TangentJob, summary, failure string) (FoldSummaryResult, error) {
	status, jobStatus := domain.FoldActive, JobDone
	if failure != "" {
		status, summary, jobStatus = domain.FoldFailed, "", JobFailed
	}
	done, err := finishJob(ctx, q, job.ID, jobStatus, failure)
	if err != nil {
		return FoldSummaryResult{}, err
	}
	out := FoldSummaryResult{Job: jobFromRow(done), Written: true}
	updated, err := q.FinishFoldSummary(ctx, db.FinishFoldSummaryParams{
		ID: row.ID, JobID: uuid.NullUUID{UUID: job.ID, Valid: true}, Summary: summary, TokensSummary: int32(domain.EstimateTokens(summary)), Status: status,
	})
	switch {
	case noRows(err):
		updated, out.Written = row, false
	case err != nil:
		return FoldSummaryResult{}, fmt.Errorf("write the fold's summary: %w", err)
	}
	write, err := s.foldWrite(ctx, q, updated, FoldWrite{})
	out.Fold, out.RootLineID = write.Fold, write.RootLineID
	return out, err
}

// FailFoldOfJob marks the drafting fold whose summary job timed out failed;
// nil when no fold waits on the job.
func (s *Store) FailFoldOfJob(ctx context.Context, jobID string) (*FoldWrite, error) {
	id, ok := parseID(jobID)
	if !ok {
		return nil, nil
	}
	row, err := s.q.FailFoldOfJob(ctx, uuid.NullUUID{UUID: id, Valid: true})
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("fail the fold: %w", err)
	}
	write, err := s.foldWrite(ctx, s.q, row, FoldWrite{})
	return &write, err
}

// ReconcileFolds, inside a write that moved messages between the lines (a
// move, a promotion), moves each drafting or active fold of the lines to the
// line both its ends are on now, and removes one whose ends were split or
// are gone. It returns the folds it changed.
func ReconcileFolds(ctx context.Context, tx Tx, lineIDs []string) ([]domain.Fold, error) {
	ids := make([]uuid.UUID, 0, len(lineIDs))
	for _, id := range lineIDs {
		if parsed, ok := parseID(id); ok {
			ids = append(ids, parsed)
		}
	}
	q := db.New(tx)
	rows, err := q.ListFoldEnds(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("list fold ends: %w", err)
	}
	out := []domain.Fold{}
	for _, row := range rows {
		together := row.FromLineID.Valid && row.ToLineID.Valid && row.FromLineID.UUID == row.ToLineID.UUID
		if together && row.FromLineID.UUID == row.LineID {
			continue
		}
		var changed db.TangentFold
		if together {
			changed, err = q.RehomeFold(ctx, db.RehomeFoldParams{ID: row.ID, LineID: row.FromLineID.UUID})
		} else {
			changed, err = q.RemoveFold(ctx, row.ID)
		}
		if err != nil {
			return nil, fmt.Errorf("reconcile a fold: %w", err)
		}
		out = append(out, foldFromRow(changed))
	}
	return out, nil
}

// LineMessagesBetween reads the messages of a line from one of its
// messages to another (either order), at most limit.
func (s *Store) LineMessagesBetween(ctx context.Context, tenant, lineID, fromID, toID string, limit int) ([]domain.Message, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return nil, err
	}
	from, to, err := foldEnds(ctx, s.q, line.ID, fromID, toID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListLineMessagesInSeqRange(ctx, db.ListLineMessagesInSeqRangeParams{LineID: line.ID, FromSeq: from.Seq, ToSeq: to.Seq, RowLimit: int32(max(limit, 1))})
	if err != nil {
		return nil, fmt.Errorf("list messages: %w", err)
	}
	return messagesFromRows(rows), nil
}

// TakenSuggestionTargets reports which target keys already have an open or
// a dismissed suggestion of the feature's kind in the conversation.
func (s *Store) TakenSuggestionTargets(ctx context.Context, rootLineID, feature, kind string, keys []string) (map[string]bool, error) {
	root, ok := parseID(rootLineID)
	if !ok {
		return nil, domain.ErrLineNotFound
	}
	rows, err := s.q.ListTakenSuggestionTargets(ctx, db.ListTakenSuggestionTargetsParams{RootLineID: root, Feature: feature, Kind: kind, TargetKeys: keys})
	if err != nil {
		return nil, fmt.Errorf("list suggestion targets: %w", err)
	}
	taken := make(map[string]bool, len(rows))
	for _, key := range rows {
		taken[key] = true
	}
	return taken, nil
}
