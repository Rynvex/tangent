package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Attaching a conversation (B20), the inverse of Detach: a main line of the
// tenant, with its whole tree, becomes a branch of a line of another
// conversation. Locks: both main lines in id order, then the target line,
// then the source's branches in id order. The source keeps its messages and
// their seq; its branches go one level deeper per the new branch's depth;
// the rows of its tree move to the target's main line (attach_tree.go).

// AttachInput attaches SourceLineID under TargetLineID. Kind and Status are
// already normalized (domain.NormalizeAttachKind / NormalizeAttachStatus).
// AnchorMessageID empty picks the anchor under the locks (the newest
// anchorable message of the target dated no later than the source's start,
// else its newest). Purpose empty defaults per domain.AttachPurpose. Card
// (status merged) is checked under the locks; Leaf writes it as the
// branch's confirmed leaf (the leaf feature is on). BuildPack builds the
// pack once the anchor and the purpose are known.
type AttachInput struct {
	Tenant          string
	TargetLineID    string
	SourceLineID    string
	AnchorMessageID string
	Purpose         string
	Kind            string
	Status          string
	Card            *domain.BranchCard
	Leaf            bool
	ConfirmDeeper   bool
	CreatedBy       string
	BuildPack       func(base MovePackBase, purpose string) domain.BranchPack
}

// AttachedLine is what an attach changed. TargetLine is the line the
// source now hangs on, Branch its new outline row and BranchLine the
// source line as a branch; CardMessage the conclusion card left on the
// target (merged only); Reparented the source's branches, now in the target
// tree. RootLineID is the target's main line, OldRootLineID the source's
// former one (its own id).
type AttachedLine struct {
	TargetLine    domain.LineView
	Branch        domain.BranchView
	BranchLine    domain.LineView
	CardMessage   *domain.Message
	Reparented    []string
	RootLineID    string
	OldRootLineID string
	Leaf          *domain.Leaf
	Moved         AttachMoved
	// Groups are the source tree's groups, now in the target tree.
	Groups []domain.Group
	// ExpiredSuggestions are the source tree's open suggestions the target
	// tree already had open (one open per feature, kind and target).
	ExpiredSuggestions []domain.Suggestion
	// DroppedGoal reports that the source conversation's goal was removed
	// (a branch has none; the target keeps its own).
	DroppedGoal bool
	// NotesRevision is the target's notes revision after moved notes (0
	// when none moved).
	NotesRevision int
}

// AttachMoved counts the rows that moved to the target tree.
type AttachMoved struct {
	Notes       int64
	Memos       int64
	Seeds       int64
	Leaves      int64
	ChapterCuts int64
	Suggestions int64
	// Terms moved; DroppedTerms were the source's terms the target had
	// already (the target's are kept).
	Terms        int64
	DroppedTerms int64
}

// attachHeld is an attach's locked state.
type attachHeld struct {
	target  lockedParent
	source  db.TangentLine
	below   []uuid.UUID
	opening db.AttachSourceOpeningRow
}

// AttachLine attaches a main line, with its tree, as a branch of another
// conversation's line. Refusals: either line unknown (line_not_found), the
// source not a main line, the same conversation or empty (invalid_input),
// either archived (archived), the target answering (source_busy), a line of
// the source tree answering (branch_busy) or drafting (branch_drafting), the
// target a closed branch (parent_closed), the branch limits with the
// source's tree counted, no anchor on the target (move_no_anchor), an
// anchor that is not one (anchor_not_found), a card that is not acceptable.
func (s *Store) AttachLine(ctx context.Context, in AttachInput, hooks ...TxHook) (AttachedLine, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (AttachedLine, error) {
		held, err := s.lockAttach(ctx, q, in)
		if err != nil {
			return AttachedLine{}, err
		}
		return s.attach(ctx, q, held, in)
	})
}

// lockAttach resolves both lines, locks both main lines in id order, the
// target line and the source tree, and applies the refusals about state.
func (s *Store) lockAttach(ctx context.Context, q *db.Queries, in AttachInput) (attachHeld, error) {
	target, source, rootID, err := s.peekAttach(ctx, q, in)
	if err != nil {
		return attachHeld{}, err
	}
	roots, err := lockRootRows(ctx, q, rootID, source.ID)
	if err != nil {
		return attachHeld{}, err
	}
	held := attachHeld{source: roots[source.ID], target: lockedParent{rootID: rootID, line: roots[rootID]}}
	_, isBranch, err := branchRowFor(ctx, q, source.ID)
	if err != nil {
		return attachHeld{}, err
	}
	if isBranch {
		return attachHeld{}, errBranchMoved // attached meanwhile: the retry refuses it
	}
	if err := s.lockAttachTarget(ctx, q, &held, target.ID); err != nil {
		return attachHeld{}, err
	}
	if held.target.line.ArchivedAt.Valid || roots[rootID].ArchivedAt.Valid || held.source.ArchivedAt.Valid {
		return attachHeld{}, domain.ErrLineArchived
	}
	if held.target.line.Status == domain.LineStatusThinking {
		return attachHeld{}, domain.ErrBranchSourceBusy
	}
	if err := requireNoPendingTurn(ctx, q, held.target.line.ID, domain.ErrBranchSourceBusy); err != nil {
		return attachHeld{}, err
	}
	if err := s.lockAttachSource(ctx, q, &held); err != nil {
		return attachHeld{}, err
	}
	return held, nil
}

// peekAttach reads both lines before any lock and refuses what needs no
// lock: the same line, a source that is a branch, a source that is the
// target's main line.
func (s *Store) peekAttach(ctx context.Context, q *db.Queries, in AttachInput) (db.TangentLine, db.TangentLine, uuid.UUID, error) {
	target, err := s.lineRow(ctx, q, in.Tenant, in.TargetLineID)
	if err != nil {
		return db.TangentLine{}, db.TangentLine{}, uuid.Nil, err
	}
	source, err := s.lineRow(ctx, q, in.Tenant, in.SourceLineID)
	if err != nil {
		return db.TangentLine{}, db.TangentLine{}, uuid.Nil, err
	}
	if source.ID == target.ID {
		return db.TangentLine{}, db.TangentLine{}, uuid.Nil, domain.ErrAttachSelf
	}
	_, isBranch, err := branchRowFor(ctx, q, source.ID)
	if err != nil {
		return db.TangentLine{}, db.TangentLine{}, uuid.Nil, err
	}
	if isBranch {
		return db.TangentLine{}, db.TangentLine{}, uuid.Nil, domain.ErrAttachNotMainLine
	}
	rootID, err := rootOf(ctx, q, target.ID)
	if err != nil {
		return db.TangentLine{}, db.TangentLine{}, uuid.Nil, err
	}
	if rootID == source.ID {
		return db.TangentLine{}, db.TangentLine{}, uuid.Nil, domain.ErrAttachSelf
	}
	return target, source, rootID, nil
}

// lockAttachTarget locks the target line after the main lines and checks it
// is still in the tree it was peeked in (a main line peeked may have been
// attached meanwhile: it is a branch now, of another tree).
func (s *Store) lockAttachTarget(ctx context.Context, q *db.Queries, held *attachHeld, targetID uuid.UUID) error {
	if targetID != held.target.rootID {
		line, err := lockLineByID(ctx, q, targetID)
		if err != nil {
			return err
		}
		held.target.line = line
	}
	root, err := rootOf(ctx, q, targetID)
	if err != nil {
		return err
	}
	if root != held.target.rootID {
		return errBranchMoved
	}
	held.target.branch, held.target.hasBranch, err = branchRowFor(ctx, q, targetID)
	return err
}

// lockAttachSource locks the source tree's branches in id order and refuses
// a tree that is answering, drafting or has nothing finished on its line.
func (s *Store) lockAttachSource(ctx context.Context, q *db.Queries, held *attachHeld) error {
	below, err := treeLineIDs(ctx, q, held.source.ID)
	if err != nil {
		return err
	}
	if _, err := lockLines(ctx, q, held.source.ID, below); err != nil {
		if errors.Is(err, domain.ErrDeleteBusy) {
			return domain.ErrBranchBusy
		}
		return err
	}
	drafting, err := q.ListDraftingInTree(ctx, held.source.ID)
	if err != nil {
		return fmt.Errorf("list drafting branches: %w", err)
	}
	for _, row := range drafting {
		if s.draftStatus(row) == domain.BranchDraftDrafting {
			return domain.ErrBranchDrafting
		}
	}
	if held.opening, err = q.AttachSourceOpening(ctx, held.source.ID); err != nil {
		return fmt.Errorf("read the source's opening: %w", err)
	}
	if held.opening.ChatCount == 0 {
		return domain.ErrAttachEmpty
	}
	held.below = below
	return nil
}

// attach writes the attach under the locks.
func (s *Store) attach(ctx context.Context, q *db.Queries, held attachHeld, in AttachInput) (AttachedLine, error) {
	purpose, ok := domain.AttachPurpose(in.Purpose, held.source.Title, held.opening.FirstUser, held.opening.FirstAny, s.limits.Branch)
	if !ok {
		return AttachedLine{}, domain.ErrInvalidPurpose
	}
	card, err := domain.PlanAttachCard(in.Card, in.Status, purpose)
	if err != nil {
		return AttachedLine{}, err
	}
	depth, err := s.checkAttachLimits(ctx, q, held, in)
	if err != nil {
		return AttachedLine{}, err
	}
	anchor, base, err := s.attachAnchor(ctx, q, held, in.AnchorMessageID)
	if err != nil {
		return AttachedLine{}, err
	}
	var content string
	if card != nil {
		if card, content, err = s.checkAttachCard(ctx, q, held, anchor, *card, purpose); err != nil {
			return AttachedLine{}, err
		}
	}
	if err := s.insertAttachedBranch(ctx, q, held, anchor, depth, purpose, in, base); err != nil {
		return AttachedLine{}, err
	}
	out := AttachedLine{RootLineID: held.target.rootID.String(), OldRootLineID: held.source.ID.String(), Reparented: idStrings(held.below)}
	if len(held.below) > 0 {
		// RehomeBranches raises by shift; a negative shift deepens.
		if err := q.RehomeBranches(ctx, db.RehomeBranchesParams{RootLineID: held.target.rootID, Shift: -int32(depth), LineIds: held.below}); err != nil {
			return AttachedLine{}, fmt.Errorf("move the source's branches: %w", err)
		}
	}
	if err := s.moveTree(ctx, q, held.source.ID, held.target.rootID, &out); err != nil {
		return AttachedLine{}, err
	}
	if card != nil {
		if err := s.closeAttached(ctx, q, held, *card, content, in, &out); err != nil {
			return AttachedLine{}, err
		}
	}
	if err := touch(ctx, q, held.target.line.ID); err != nil {
		return AttachedLine{}, err
	}
	return s.attachedViews(ctx, q, held, out)
}

// checkAttachLimits counts under the locks and returns the branch's depth.
func (s *Store) checkAttachLimits(ctx context.Context, q *db.Queries, held attachHeld, in AttachInput) (int, error) {
	open, err := q.CountOpenBranchesForParent(ctx, held.target.line.ID)
	if err != nil {
		return 0, fmt.Errorf("count open branches: %w", err)
	}
	total, err := q.CountBranchesForRoot(ctx, held.target.rootID)
	if err != nil {
		return 0, fmt.Errorf("count tree branches: %w", err)
	}
	deepest, err := q.MaxBranchDepthForRoot(ctx, held.source.ID)
	if err != nil {
		return 0, fmt.Errorf("read the source tree's depth: %w", err)
	}
	return domain.CheckAttach(domain.AttachCheck{
		Parent: domain.BranchCreateCheck{
			ParentIsBranch: held.target.hasBranch, ParentStatus: held.target.branch.Status, ParentDepth: int(held.target.branch.Depth),
			OpenUnderParent: int(open), TreeTotal: int(total), ConfirmDeeper: in.ConfirmDeeper,
		},
		Status: in.Status, SubtreeLines: len(held.below), SubtreeDepth: int(deepest),
	}, s.limits.Branch)
}

// attachAnchor is the anchor given (it must be one, anchor_not_found) or
// the one picked by time, and the pack base up to it (the target's summary
// when it covers no more than the anchor).
func (s *Store) attachAnchor(ctx context.Context, q *db.Queries, held attachHeld, anchorID string) (db.TangentMessage, MovePackBase, error) {
	target := held.target.line
	anchor, err := s.pickAttachAnchor(ctx, q, held, anchorID)
	if err != nil {
		return db.TangentMessage{}, MovePackBase{}, err
	}
	_, base, err := s.extractAnchor(ctx, q, target, anchor.Seq+1)
	if err != nil {
		return db.TangentMessage{}, MovePackBase{}, err
	}
	if target.SummaryUptoSeq.Valid && target.SummaryUptoSeq.Int64 <= anchor.Seq {
		if summary := summaryFromJSON(target.Summary); summary.HasContent() {
			base.Summary, base.SummaryUptoSeq = summary, target.SummaryUptoSeq.Int64
		}
	}
	return anchor, base, nil
}

// pickAttachAnchor is the anchor given or, without one, the newest
// anchorable message of the target (seq order) dated no later than the
// source's start, else its newest one; move_no_anchor when it has none.
func (s *Store) pickAttachAnchor(ctx context.Context, q *db.Queries, held attachHeld, anchorID string) (db.TangentMessage, error) {
	if id := strings.TrimSpace(anchorID); id != "" {
		return requireAnchor(ctx, q, held.target.line, id)
	}
	anchor, err := q.AttachAnchorCandidate(ctx, db.AttachAnchorCandidateParams{LineID: held.target.line.ID, At: held.source.CreatedAt})
	if noRows(err) {
		return db.TangentMessage{}, domain.ErrBranchMoveNoAnchor
	}
	if err != nil {
		return db.TangentMessage{}, fmt.Errorf("pick the anchor: %w", err)
	}
	return anchor, nil
}

// insertAttachedBranch writes the source line's branch row under the target
// and turns the line into a branch line.
func (s *Store) insertAttachedBranch(ctx context.Context, q *db.Queries, held attachHeld, anchor db.TangentMessage, depth int, purpose string, in AttachInput, base MovePackBase) error {
	pack := domain.BranchPack{}
	if in.BuildPack != nil {
		pack = in.BuildPack(base, purpose)
	}
	raw, err := json.Marshal(pack)
	if err != nil {
		return fmt.Errorf("marshal branch pack: %w", err)
	}
	if _, err := q.InsertBranch(ctx, db.InsertBranchParams{
		LineID: held.source.ID, TenantID: held.source.TenantID, ParentLineID: held.target.line.ID, RootLineID: held.target.rootID,
		AnchorMessageID: anchor.ID, Purpose: purpose, Kind: in.Kind, Depth: int32(depth), Origin: domain.BranchOriginMove, Pack: raw,
		CreatedBy: strings.TrimSpace(in.CreatedBy),
	}); err != nil {
		return fmt.Errorf("insert the attached branch: %w", err)
	}
	if err := q.MakeLineBranch(ctx, db.MakeLineBranchParams{ID: held.source.ID, Title: purpose}); err != nil {
		return fmt.Errorf("make the source a branch line: %w", err)
	}
	// What each line last sent was counted against the old main line's notes revision: the next turn sends the notes again.
	if err := q.ResetNotesRevisionSent(ctx, append([]uuid.UUID{held.source.ID}, held.below...)); err != nil {
		return fmt.Errorf("reset the notes revisions sent: %w", err)
	}
	return nil
}

// attachedViews reads what the answer shows.
func (s *Store) attachedViews(ctx context.Context, q *db.Queries, held attachHeld, out AttachedLine) (AttachedLine, error) {
	var err error
	if out.TargetLine, err = s.lineViewOf(ctx, q, held.target.line.ID); err != nil {
		return AttachedLine{}, err
	}
	if out.BranchLine, err = s.lineViewOf(ctx, q, held.source.ID); err != nil {
		return AttachedLine{}, err
	}
	if out.Branch, err = s.branchViewOf(ctx, q, held.source.TenantID, held.source.ID); err != nil {
		return AttachedLine{}, err
	}
	return out, nil
}
