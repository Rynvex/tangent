package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// MovePackBase is what the pack of a moved branch is built from: the anchor
// (the newest finished operator or assistant message that stays), the
// finished messages that stay up to it in seq order, and the source's summary
// when it still describes only messages that stay.
type MovePackBase struct {
	Anchor         domain.Message
	Remaining      []domain.Message
	Summary        domain.Summary
	SummaryUptoSeq int64
}

// MoveToBranchInput opens a branch from the last Count messages of a line.
// AnchorMessageID, Excerpt and Origin of the embedded input are ignored: the
// anchor is found under the lock and the origin is move. BuildPack builds the
// pack once the anchor is known (nil keeps Pack as given).
type MoveToBranchInput struct {
	CreateBranchInput
	Count     int
	BuildPack func(MovePackBase) domain.BranchPack
}

// MovedBranch is what a move changed.
type MovedBranch struct {
	Line   domain.LineView
	Branch domain.BranchView
	// Marker is the system message left at the end of the source line.
	Marker       domain.Message
	SourceLineID string
	RootLineID   string
	// MovedMessageIDs are the moved messages in seq order.
	MovedMessageIDs []string
	// Reparented are the branches that hung on moved messages and now hang on the new branch.
	Reparented []string
	// SummaryReset reports that the source's summary covered a moved message.
	SummaryReset bool
}

// MoveToBranch moves the last Count messages of a line into a new branch of
// it, in one transaction: root then source are locked. Messages keep their
// seq, so nothing is renumbered. Branches opened on moved messages go with
// them one level deeper; the source keeps a marker; a summary whose cursor
// moved is reset and pending summaries of the source are superseded.
func (s *Store) MoveToBranch(ctx context.Context, in MoveToBranchInput, hooks ...TxHook) (MovedBranch, error) {
	if err := domain.CheckMoveCount(in.Count, s.limits.Branch); err != nil {
		return MovedBranch{}, err
	}
	normalized, err := s.normalizeBranchInput(in.CreateBranchInput, true)
	if err != nil {
		return MovedBranch{}, err
	}
	in.CreateBranchInput = normalized
	return runTx(ctx, s, hooks, func(q *db.Queries) (MovedBranch, error) {
		source, err := s.lockParent(ctx, q, in.Tenant, in.ParentLineID)
		if err != nil {
			return MovedBranch{}, err
		}
		if source.line.ArchivedAt.Valid {
			return MovedBranch{}, domain.ErrLineArchived
		}
		depth, err := s.checkBranchLimits(ctx, q, source, in.ConfirmDeeper)
		if err != nil {
			return MovedBranch{}, err
		}
		created, out, err := s.moveTail(ctx, q, source, depth, in)
		if err != nil {
			return MovedBranch{}, err
		}
		if err := touch(ctx, q, source.line.ID); err != nil {
			return MovedBranch{}, err
		}
		branch, err := s.createdBranch(ctx, q, created)
		if err != nil {
			return MovedBranch{}, err
		}
		out.Line, out.Branch = branch.Line, branch.Branch
		return out, nil
	})
}

// moveTail does the move under the source's locks.
func (s *Store) moveTail(ctx context.Context, q *db.Queries, source lockedParent, depth int, in MoveToBranchInput) (db.TangentLine, MovedBranch, error) {
	tail, remaining, err := s.splitMoveTail(ctx, q, source.line, in.Count)
	if err != nil {
		return db.TangentLine{}, MovedBranch{}, err
	}
	anchor, base, err := moveAnchor(remaining)
	if err != nil {
		return db.TangentLine{}, MovedBranch{}, err
	}
	reset := source.line.SummaryUptoSeq.Valid && source.line.SummaryUptoSeq.Int64 >= tail[0].Seq
	if !reset && source.line.SummaryUptoSeq.Valid {
		if summary := summaryFromJSON(source.line.Summary); summary.HasContent() {
			base.Summary, base.SummaryUptoSeq = summary, source.line.SummaryUptoSeq.Int64
		}
	}
	if in.BuildPack != nil {
		in.Pack = in.BuildPack(base)
	}
	created, err := s.insertBranch(ctx, q, source, anchor, depth, in.CreateBranchInput)
	if err != nil {
		return db.TangentLine{}, MovedBranch{}, err
	}
	ids := make([]uuid.UUID, 0, len(tail))
	for _, message := range tail {
		ids = append(ids, message.ID)
	}
	if _, err := q.MoveMessagesByIDs(ctx, db.MoveMessagesByIDsParams{ToLine: created.ID, FromLine: source.line.ID, Ids: ids}); err != nil {
		return db.TangentLine{}, MovedBranch{}, fmt.Errorf("move messages: %w", err)
	}
	out := MovedBranch{SourceLineID: source.line.ID.String(), RootLineID: source.rootID.String(), MovedMessageIDs: idStrings(ids), SummaryReset: reset}
	if out.Reparented, err = s.reparentAnchoredBranches(ctx, q, source.line.ID, created.ID, ids); err != nil {
		return db.TangentLine{}, MovedBranch{}, err
	}
	if err := forgetSummary(ctx, q, []uuid.UUID{source.line.ID}, reset); err != nil {
		return db.TangentLine{}, MovedBranch{}, err
	}
	marker, err := insertMessage(ctx, q, source.line, NewMessage{
		Role: domain.RoleSystem, Kind: domain.MessageKindBranchMarker, Content: domain.BranchMoveMarkerText(len(ids), in.Purpose),
		Meta: domain.MessageMeta{BranchLineID: created.ID.String()},
	})
	if err != nil {
		return db.TangentLine{}, MovedBranch{}, err
	}
	out.Marker = messageFromRow(marker)
	return created, out, nil
}

// splitMoveTail reads the newest messages of the source and splits them into
// the tail to move (seq order) and the rest (newest first), applying the
// rules on what may move.
func (s *Store) splitMoveTail(ctx context.Context, q *db.Queries, source db.TangentLine, count int) ([]db.TangentMessage, []db.TangentMessage, error) {
	if source.Status == domain.LineStatusThinking {
		return nil, nil, domain.ErrBranchSourceBusy
	}
	if err := requireNoPendingTurn(ctx, q, source.ID, domain.ErrBranchSourceBusy); err != nil {
		return nil, nil, err
	}
	newest, err := q.ListRecentMessages(ctx, db.ListRecentMessagesParams{LineID: source.ID, RowLimit: int32(count + s.limits.Pack.HistoryScan)})
	if err != nil {
		return nil, nil, fmt.Errorf("list tail messages: %w", err)
	}
	if len(newest) < count {
		return nil, nil, domain.ErrBranchMoveTooFew
	}
	tail := make([]db.TangentMessage, 0, count)
	for i := count - 1; i >= 0; i-- {
		message := newest[i]
		if message.Status != domain.MessageDone {
			return nil, nil, domain.ErrBranchSourceBusy
		}
		if message.Kind == domain.MessageKindBranchCard || message.Kind == domain.MessageKindBranchMarker {
			return nil, nil, domain.ErrBranchMoveProtected
		}
		tail = append(tail, message)
	}
	if tail[0].Role != domain.RoleUser {
		return nil, nil, domain.ErrBranchMoveNotUserStart
	}
	return tail, newest[count:], nil
}

// moveAnchor picks the newest finished operator or assistant message that
// stays and returns the pack base up to it (seq order).
func moveAnchor(remaining []db.TangentMessage) (db.TangentMessage, MovePackBase, error) {
	for i, message := range remaining {
		if message.Status != domain.MessageDone || (message.Role != domain.RoleUser && message.Role != domain.RoleAssistant) {
			continue
		}
		upTo := make([]domain.Message, 0, len(remaining)-i)
		for j := len(remaining) - 1; j >= i; j-- {
			if remaining[j].Status == domain.MessageDone {
				upTo = append(upTo, messageFromRow(remaining[j]))
			}
		}
		return message, MovePackBase{Anchor: messageFromRow(message), Remaining: upTo}, nil
	}
	return db.TangentMessage{}, MovePackBase{}, domain.ErrBranchMoveNoAnchor
}

// reparentAnchoredBranches re-hangs the branches of oldParent opened on one
// of the moved messages under newParent, one level deeper together with
// everything below them, and returns their ids.
func (s *Store) reparentAnchoredBranches(ctx context.Context, q *db.Queries, oldParent, newParent uuid.UUID, moved []uuid.UUID) ([]string, error) {
	children, err := q.ListBranchesAnchoredIn(ctx, db.ListBranchesAnchoredInParams{ParentLineID: oldParent, MessageIds: moved})
	if err != nil {
		return nil, fmt.Errorf("list branches on moved messages: %w", err)
	}
	if len(children) == 0 {
		return []string{}, nil
	}
	if err := q.ReparentBranches(ctx, db.ReparentBranchesParams{ParentLineID: newParent, LineIds: children}); err != nil {
		return nil, fmt.Errorf("reparent branches: %w", err)
	}
	if err := s.shiftSubtreeDepth(ctx, q, newParent, 1); err != nil {
		return nil, err
	}
	return idStrings(children), nil
}

// shiftSubtreeDepth changes the depth of every branch below a line by delta,
// refusing a result deeper than the hard limit.
func (s *Store) shiftSubtreeDepth(ctx context.Context, q *db.Queries, below uuid.UUID, delta int) error {
	ids, err := s.subtreeIDs(ctx, q, below)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.ListBranchesByLineIDs(ctx, ids)
	if err != nil {
		return fmt.Errorf("list subtree branches: %w", err)
	}
	for _, row := range rows {
		if int(row.Depth)+delta > s.limits.Branch.HardMaxDepth {
			return domain.ErrBranchDepthHard
		}
	}
	if err := q.ShiftBranchDepths(ctx, db.ShiftBranchDepthsParams{Delta: int32(delta), LineIds: ids}); err != nil {
		return fmt.Errorf("shift branch depths: %w", err)
	}
	return nil
}

// forgetSummary resets the summaries of lines whose messages changed (when
// reset) and supersedes their pending summary jobs, whose input no longer
// matches the line.
func forgetSummary(ctx context.Context, q *db.Queries, lines []uuid.UUID, reset bool) error {
	if reset {
		for _, id := range lines {
			if err := q.ResetLineSummary(ctx, id); err != nil {
				return fmt.Errorf("reset summary: %w", err)
			}
		}
	}
	if _, err := q.SupersedePendingJobs(ctx, db.SupersedePendingJobsParams{LineIds: lines, Kind: JobKindSummary}); err != nil {
		return fmt.Errorf("supersede pending summaries: %w", err)
	}
	return nil
}
