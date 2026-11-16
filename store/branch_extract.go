package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Extracting a stretch of a line into a branch (B18): MoveToBranch for any
// contiguous range, the middle of a line included. The marker (or, with a
// card, the conclusion card) takes the range's place in seq order: the
// range's last message gets a fresh seq (it stays the newest of the moved
// messages, so their order holds) and the marker is written at the seq it
// vacated, between what stays before and after the range.

// ExtractInput opens a branch from the messages of a line from
// FromMessageID to ToMessageID (seq order, both included). AnchorMessageID,
// Excerpt and Origin of the embedded input are ignored: the anchor is the
// newest anchorable message before the range, found under the lock, and the
// origin is move. BuildPack builds the pack once the anchor is known. Card
// (already validated, CardContent its rendering) closes the branch as
// merged at once; Leaf, with a card, is written as its confirmed leaf (the
// leaf feature is on).
type ExtractInput struct {
	CreateBranchInput
	FromMessageID string
	ToMessageID   string
	Card          *domain.BranchCard
	CardContent   string
	Leaf          *domain.LeafInput
	BuildPack     func(MovePackBase) domain.BranchPack
}

// ExtractedBranch is what an extract changed.
type ExtractedBranch struct {
	Line   domain.LineView
	Branch domain.BranchView
	// Marker is the branch_marker, or with a card the branch_card, left
	// where the range was.
	Marker       domain.Message
	SourceLineID string
	RootLineID   string
	// MovedMessageIDs are the moved messages in seq order.
	MovedMessageIDs []string
	// Reparented are the branches that hung on moved messages and now hang
	// on the new branch.
	Reparented []string
	// SummaryReset reports that the source's summary covered a moved message.
	SummaryReset bool
	// Folds are the folds the extract changed: removed (they crossed the
	// range's ends or contained it) or moved with the range.
	Folds []domain.Fold
	// MovedCuts counts the chapter cuts moved onto the marker.
	MovedCuts int
	// Leaf is the leaf written from the card (nil without one).
	Leaf *domain.Leaf
}

// extractRange is the stretch to move, read under the source's lock.
type extractRange struct {
	messages []db.TangentMessage
	ids      []uuid.UUID
	fromSeq  int64
	toSeq    int64
}

// ExtractToBranch moves a range of a line into a new branch of it, in one
// transaction under the locks root → source. Refusals are MoveToBranch's:
// the source archived or answering, the branch limits, a range of more than
// the move limit, anything but finished operator and assistant chat
// messages in it or a branch opened in it whose conclusion card is on the
// line (move_protected_message), a range that starts with a reply,
// nothing to hang the branch on before it; plus ends that are not messages
// of the line (message_not_found) or in the wrong order (invalid_input).
func (s *Store) ExtractToBranch(ctx context.Context, in ExtractInput, hooks ...TxHook) (ExtractedBranch, error) {
	normalized, err := s.normalizeBranchInput(in.CreateBranchInput, true)
	if err != nil {
		return ExtractedBranch{}, err
	}
	in.CreateBranchInput = normalized
	if in.Card != nil && in.Leaf != nil {
		leaf, problems := domain.NormalizeLeaf(*in.Leaf, s.limits.Leaf)
		if len(problems) > 0 {
			return ExtractedBranch{}, domain.LeafError(problems)
		}
		in.Leaf = &leaf
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (ExtractedBranch, error) {
		source, err := s.lockParent(ctx, q, in.Tenant, in.ParentLineID)
		if err != nil {
			return ExtractedBranch{}, err
		}
		if source.line.ArchivedAt.Valid {
			return ExtractedBranch{}, domain.ErrLineArchived
		}
		depth, err := s.checkBranchLimits(ctx, q, source, in.ConfirmDeeper)
		if err != nil {
			return ExtractedBranch{}, err
		}
		stretch, err := s.readExtractRange(ctx, q, source.line, in.FromMessageID, in.ToMessageID)
		if err != nil {
			return ExtractedBranch{}, err
		}
		created, out, err := s.extract(ctx, q, source, depth, stretch, in)
		if err != nil {
			return ExtractedBranch{}, err
		}
		if err := touch(ctx, q, source.line.ID); err != nil {
			return ExtractedBranch{}, err
		}
		branch, err := s.createdBranch(ctx, q, created)
		if err != nil {
			return ExtractedBranch{}, err
		}
		out.Line, out.Branch = branch.Line, branch.Branch
		return out, nil
	})
}

// readExtractRange reads the range under the lock and applies the rules on
// what may move.
func (s *Store) readExtractRange(ctx context.Context, q *db.Queries, source db.TangentLine, fromID, toID string) (extractRange, error) {
	if source.Status == domain.LineStatusThinking {
		return extractRange{}, domain.ErrBranchSourceBusy
	}
	if err := requireNoPendingTurn(ctx, q, source.ID, domain.ErrBranchSourceBusy); err != nil {
		return extractRange{}, err
	}
	from, err := messageOn(ctx, q, source.ID, fromID)
	if err != nil {
		return extractRange{}, err
	}
	to, err := messageOn(ctx, q, source.ID, toID)
	if err != nil {
		return extractRange{}, err
	}
	if from.Seq > to.Seq {
		return extractRange{}, invalidInput("fromMessageId must not come after toMessageId")
	}
	max := s.limits.Branch.MoveMaxMessages
	rows, err := q.ListLineMessagesInSeqRange(ctx, db.ListLineMessagesInSeqRangeParams{LineID: source.ID, FromSeq: from.Seq, ToSeq: to.Seq, RowLimit: int32(max + 1)})
	if err != nil {
		return extractRange{}, fmt.Errorf("list the range: %w", err)
	}
	if err := domain.CheckMoveCount(len(rows), s.limits.Branch); err != nil {
		return extractRange{}, err
	}
	for _, message := range rows {
		if !domain.ExtractableMessage(message.Role, message.Kind, message.Status) {
			return extractRange{}, domain.ErrBranchMoveProtected
		}
	}
	if rows[0].Role != domain.RoleUser {
		return extractRange{}, domain.ErrBranchMoveNotUserStart
	}
	ids := make([]uuid.UUID, 0, len(rows))
	for _, message := range rows {
		ids = append(ids, message.ID)
	}
	// A branch opened in the range goes with it; one already brought back
	// would leave its card behind on this line (after the range: a card in
	// it is refused above), so the range is protected.
	cards, err := q.CountCardsOnLineOfBranchesAnchoredIn(ctx, db.CountCardsOnLineOfBranchesAnchoredInParams{ParentLineID: source.ID, MessageIds: ids})
	if err != nil {
		return extractRange{}, fmt.Errorf("count the cards of branches in the range: %w", err)
	}
	if cards > 0 {
		return extractRange{}, domain.ErrBranchMoveProtected
	}
	return extractRange{messages: rows, fromSeq: from.Seq, toSeq: to.Seq, ids: ids}, nil
}

// extract does the move under the source's locks.
func (s *Store) extract(ctx context.Context, q *db.Queries, source lockedParent, depth int, stretch extractRange, in ExtractInput) (db.TangentLine, ExtractedBranch, error) {
	anchor, base, err := s.extractAnchor(ctx, q, source.line, stretch.fromSeq)
	if err != nil {
		return db.TangentLine{}, ExtractedBranch{}, err
	}
	base, reset := extractPackBase(source.line, stretch.fromSeq, base)
	if in.BuildPack != nil {
		in.Pack = in.BuildPack(base)
	}
	created, err := s.insertBranch(ctx, q, source, anchor, depth, in.CreateBranchInput)
	if err != nil {
		return db.TangentLine{}, ExtractedBranch{}, err
	}
	if _, err := q.MoveMessagesByIDs(ctx, db.MoveMessagesByIDsParams{ToLine: created.ID, FromLine: source.line.ID, Ids: stretch.ids}); err != nil {
		return db.TangentLine{}, ExtractedBranch{}, fmt.Errorf("move messages: %w", err)
	}
	out := ExtractedBranch{
		SourceLineID: source.line.ID.String(), RootLineID: source.rootID.String(), MovedMessageIDs: idStrings(stretch.ids), SummaryReset: reset,
	}
	if out.Folds, err = extractFolds(ctx, q, source.line.ID, created.ID, stretch); err != nil {
		return db.TangentLine{}, ExtractedBranch{}, err
	}
	newSeq, err := vacateLastSeq(ctx, q, stretch)
	if err != nil {
		return db.TangentLine{}, ExtractedBranch{}, err
	}
	out.Folds = renumberedFolds(out.Folds, stretch.messages[len(stretch.messages)-1].ID.String(), newSeq)
	if out.Reparented, err = s.reparentAnchoredBranches(ctx, q, source.line.ID, created.ID, stretch.ids); err != nil {
		return db.TangentLine{}, ExtractedBranch{}, err
	}
	if err := forgetSummary(ctx, q, []uuid.UUID{source.line.ID}, reset); err != nil {
		return db.TangentLine{}, ExtractedBranch{}, err
	}
	if out, err = s.markExtracted(ctx, q, source, created.ID, stretch, in, out); err != nil {
		return db.TangentLine{}, ExtractedBranch{}, err
	}
	return created, out, nil
}

// extractPackBase adds the source's summary to the pack base when the range
// starts after what it covers; reset is true when the range starts inside
// it (the summary is forgotten).
func extractPackBase(line db.TangentLine, fromSeq int64, base MovePackBase) (MovePackBase, bool) {
	reset := line.SummaryUptoSeq.Valid && line.SummaryUptoSeq.Int64 >= fromSeq
	if !reset && line.SummaryUptoSeq.Valid {
		if summary := summaryFromJSON(line.Summary); summary.HasContent() {
			base.Summary, base.SummaryUptoSeq = summary, line.SummaryUptoSeq.Int64
		}
	}
	return base, reset
}

// markExtracted leaves the marker where the range was, keeps a chapter that
// started in the range starting at the marker and, with a card, closes the
// new branch; it returns out with the marker, the moved cuts and the leaf.
func (s *Store) markExtracted(ctx context.Context, q *db.Queries, source lockedParent, branchID uuid.UUID, stretch extractRange, in ExtractInput, out ExtractedBranch) (ExtractedBranch, error) {
	marker, err := s.leaveInPlace(ctx, q, source.line, branchID, stretch, in)
	if err != nil {
		return ExtractedBranch{}, err
	}
	out.Marker = messageFromRow(marker)
	if out.MovedCuts, err = keepChapterStart(ctx, q, source, marker, stretch); err != nil {
		return ExtractedBranch{}, err
	}
	if in.Card != nil {
		if out.Leaf, err = closeExtracted(ctx, q, branchID, marker, in); err != nil {
			return ExtractedBranch{}, err
		}
	}
	return out, nil
}

// extractAnchor picks the newest message before the range a branch may
// hang on (domain.CanAnchorBranch: a finished operator or assistant
// message, or a conclusion card) and returns the pack base up to it (the
// finished messages, seq order). Only the newest HistoryScan messages before
// the range are looked at.
func (s *Store) extractAnchor(ctx context.Context, q *db.Queries, source db.TangentLine, fromSeq int64) (db.TangentMessage, MovePackBase, error) {
	before, err := q.ListMessagesBeforeSeq(ctx, db.ListMessagesBeforeSeqParams{LineID: source.ID, BeforeSeq: fromSeq, RowLimit: int32(s.limits.Pack.HistoryScan)})
	if err != nil {
		return db.TangentMessage{}, MovePackBase{}, fmt.Errorf("list messages before the range: %w", err)
	}
	for i, message := range before {
		if !domain.CanAnchorBranch(message.Role, message.Kind, message.Status) {
			continue
		}
		upTo := make([]domain.Message, 0, len(before)-i)
		for j := len(before) - 1; j >= i; j-- {
			if before[j].Status == domain.MessageDone {
				upTo = append(upTo, messageFromRow(before[j]))
			}
		}
		return message, MovePackBase{Anchor: messageFromRow(message), Remaining: upTo}, nil
	}
	return db.TangentMessage{}, MovePackBase{}, domain.ErrBranchMoveNoAnchor
}

// extractFolds removes the source's folds that cross the range's ends or
// contain it (the marker would sit inside them) and moves the ones inside
// it to the new branch. It runs before the range's last seq is vacated, so
// the stored seqs still name the range.
func extractFolds(ctx context.Context, q *db.Queries, sourceID, branchID uuid.UUID, stretch extractRange) ([]domain.Fold, error) {
	removed, err := q.RemoveFoldsAcross(ctx, db.RemoveFoldsAcrossParams{LineID: sourceID, FromSeq: stretch.fromSeq, ToSeq: stretch.toSeq})
	if err != nil {
		return nil, fmt.Errorf("remove the folds across the range: %w", err)
	}
	moved, err := q.RehomeFoldsWithin(ctx, db.RehomeFoldsWithinParams{ToLine: branchID, FromLine: sourceID, FromSeq: stretch.fromSeq, ToSeq: stretch.toSeq})
	if err != nil {
		return nil, fmt.Errorf("move the folds inside the range: %w", err)
	}
	out := make([]domain.Fold, 0, len(removed)+len(moved))
	for _, row := range append(removed, moved...) {
		out = append(out, foldFromRow(row))
	}
	return out, nil
}

// vacateLastSeq gives the range's last message a fresh seq (folds that end
// at it follow), freeing its old one for the marker; it returns the new seq.
func vacateLastSeq(ctx context.Context, q *db.Queries, stretch extractRange) (int64, error) {
	last := stretch.messages[len(stretch.messages)-1]
	seq, err := q.RenumberMessage(ctx, last.ID)
	if err != nil {
		return 0, fmt.Errorf("renumber the range's last message: %w", err)
	}
	if err := q.RenumberFoldEnds(ctx, db.RenumberFoldEndsParams{MessageID: last.ID, Seq: seq}); err != nil {
		return 0, fmt.Errorf("renumber fold ends: %w", err)
	}
	return seq, nil
}

// renumberedFolds are the folds extractFolds returned (read before the
// range's last message was renumbered) with that message's new seq on the
// ends that name it, as RenumberFoldEnds stored them (B18.1: fold.changed
// carries the stored fold).
func renumberedFolds(folds []domain.Fold, lastID string, seq int64) []domain.Fold {
	out := make([]domain.Fold, 0, len(folds))
	for _, fold := range folds {
		if fold.FromMessageID == lastID {
			fold.FromSeq = seq
		}
		if fold.ToMessageID == lastID {
			fold.ToSeq = seq
		}
		out = append(out, fold)
	}
	return out
}

// leaveInPlace writes, at the vacated seq, the move marker or (with a card)
// the conclusion card, already delivered: the turns it stands for were
// part of the conversation, so later prompts show the card in their place
// and no notice carries it again. It is dated like the range's last
// message, so what reads time in seq order (idle chapter cuts) sees no
// jump where it stands.
func (s *Store) leaveInPlace(ctx context.Context, q *db.Queries, source db.TangentLine, branchID uuid.UUID, stretch extractRange, in ExtractInput) (db.TangentMessage, error) {
	m := NewMessage{
		Role: domain.RoleSystem, Kind: domain.MessageKindBranchMarker, Content: domain.BranchMoveMarkerText(len(stretch.ids), in.Purpose),
		Meta: domain.MessageMeta{BranchLineID: branchID.String()},
	}
	if in.Card != nil {
		m.Kind, m.Content = domain.MessageKindBranchCard, in.CardContent
		m.Meta = domain.MessageMeta{Card: in.Card, BranchLineID: branchID.String(), Delivered: true}
	}
	meta, err := json.Marshal(m.Meta)
	if err != nil {
		return db.TangentMessage{}, fmt.Errorf("marshal message meta: %w", err)
	}
	row, err := q.InsertMessageAtSeq(ctx, db.InsertMessageAtSeqParams{
		Seq: stretch.toSeq, LineID: source.ID, TenantID: source.TenantID, Role: m.Role, Kind: m.Kind, Content: m.Content,
		Status: domain.MessageDone, Meta: meta, HostMeta: []byte("{}"), CreatedAt: stretch.messages[len(stretch.messages)-1].CreatedAt,
	})
	if err != nil {
		return db.TangentMessage{}, fmt.Errorf("insert the marker: %w", err)
	}
	return row, nil
}

// keepChapterStart keeps the source's chapters right when the line goes on
// after the range: of the chapter cuts on moved messages, the newest of
// each kind (the chapter still running when the range ends) moves onto the
// marker, so what follows the range stays in that chapter. The others go
// with their messages (cuts are per conversation, so the branch's chapters
// show them). A range at the end of the line moves no cut (as a tail move).
func keepChapterStart(ctx context.Context, q *db.Queries, source lockedParent, marker db.TangentMessage, stretch extractRange) (int, error) {
	after, err := q.CountMessagesAfterSeq(ctx, db.CountMessagesAfterSeqParams{LineID: source.line.ID, AfterSeq: stretch.toSeq})
	if err != nil {
		return 0, fmt.Errorf("count messages after the range: %w", err)
	}
	if after == 0 {
		return 0, nil
	}
	cuts, err := q.ListChapterCutsOnMessages(ctx, db.ListChapterCutsOnMessagesParams{RootLineID: source.rootID, MessageIds: stretch.ids})
	if err != nil {
		return 0, fmt.Errorf("list chapter cuts in the range: %w", err)
	}
	position := make(map[uuid.UUID]int, len(stretch.messages))
	for i, message := range stretch.messages {
		position[message.ID] = i
	}
	newest := map[string]db.TangentChapterCut{}
	for _, cut := range cuts {
		if kept, ok := newest[cut.Kind]; !ok || position[cut.MessageID] > position[kept.MessageID] {
			newest[cut.Kind] = cut
		}
	}
	for _, cut := range newest {
		if err := q.MoveChapterCut(ctx, db.MoveChapterCutParams{ID: cut.ID, MessageID: marker.ID, LineID: source.line.ID}); err != nil {
			return 0, fmt.Errorf("move a chapter cut onto the marker: %w", err)
		}
	}
	return len(newest), nil
}

// closeExtracted marks an extracted branch merged with the card left on the
// source, and writes its leaf when asked.
func closeExtracted(ctx context.Context, q *db.Queries, branchID uuid.UUID, card db.TangentMessage, in ExtractInput) (*domain.Leaf, error) {
	row, err := q.CloseBranch(ctx, db.CloseBranchParams{
		LineID: branchID, Status: domain.BranchStatusMerged, ConclusionLine: domain.BranchConclusionLine(*in.Card),
		CardMessageID: uuid.NullUUID{UUID: card.ID, Valid: true},
	})
	if err != nil {
		return nil, fmt.Errorf("close the extracted branch: %w", err)
	}
	if in.Leaf == nil {
		return nil, nil
	}
	leaf, err := upsertLeaf(ctx, q, row, *in.Leaf, domain.LeafStatusConfirmed, uuid.NullUUID{}, in.CreatedBy)
	if err != nil {
		return nil, err
	}
	return &leaf, nil
}
