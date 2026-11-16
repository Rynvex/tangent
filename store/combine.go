package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// CombineInput combines open sibling branches into one new branch of their
// parent (origin merge), anchored on AnchorMessageID with the pack the
// caller built; Notes are written in the same transaction.
type CombineInput struct {
	Tenant          string
	ParentLineID    string
	LineIDs         []string
	AnchorMessageID string
	Purpose         string
	Kind            string
	Pack            domain.BranchPack
	Notes           []domain.NoteChange
	Actor           string
}

// CombinedBranches is what a combine changed: the new branch, the branches
// it took (discarded, pointing at it), their open children now hanging on
// the new branch (Reparented, in id order) and the notes it wrote.
type CombinedBranches struct {
	Created      CreatedBranch
	Combined     []domain.BranchView
	Reparented   []string
	Notes        NotesWrite
	ParentLineID string
	RootLineID   string
}

// CombineBranches closes the branches (discarded, merged_into the new one),
// opens the new branch and re-hangs their open children on it, in one
// transaction under the locks root → parent → the branches in id order →
// their open children in id order. A child keeps its anchor (the message it
// forked from, which stays on the combined branch; the new branch's pack
// quotes that branch's latest messages) and its depth (the new branch is
// the combined ones' sibling). Refusals:
// fewer than two, a branch that is not an open non-aside child of the
// parent (invalid_group, branch_closed), one with a turn in flight
// (branch_busy) or drafting, more open children than a parent may hold
// (branch_limit).
func (s *Store) CombineBranches(ctx context.Context, in CombineInput, hooks ...TxHook) (CombinedBranches, error) {
	branch, err := s.normalizeBranchInput(CreateBranchInput{Purpose: in.Purpose, Kind: in.Kind}, false)
	if err != nil {
		return CombinedBranches{}, err
	}
	ids, err := s.groupMemberIDs(in.LineIDs)
	if err != nil {
		return CombinedBranches{}, err
	}
	notes, err := s.normaliseNotes(in.Notes)
	if err != nil {
		return CombinedBranches{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (CombinedBranches, error) {
		parent, err := s.lockParent(ctx, q, in.Tenant, in.ParentLineID)
		if err != nil {
			return CombinedBranches{}, err
		}
		if err := s.closeCombined(ctx, q, parent, ids); err != nil {
			return CombinedBranches{}, err
		}
		created, err := s.createInParent(ctx, q, parent, CreateBranchInput{
			Tenant: in.Tenant, AnchorMessageID: in.AnchorMessageID, Purpose: branch.Purpose, Kind: in.Kind, Origin: domain.BranchOriginMerge,
			CreatedBy: in.Actor, ConfirmDeeper: true, Pack: in.Pack,
		})
		if err != nil {
			return CombinedBranches{}, err
		}
		return s.finishCombine(ctx, q, parent, ids, created, notes, in.Actor)
	})
}

// closeCombined checks every branch under the locks and discards it.
func (s *Store) closeCombined(ctx context.Context, q *db.Queries, parent lockedParent, ids []uuid.UUID) error {
	if err := lockInOrder(ctx, q, ids); err != nil {
		return err
	}
	for _, id := range ids {
		row, isBranch, err := branchRowFor(ctx, q, id)
		if err != nil {
			return err
		}
		switch {
		case !isBranch || row.ParentLineID != parent.line.ID || row.TenantID != parent.line.TenantID:
			return domain.InvalidGroup("only branches of the same parent are combined")
		case row.Kind == domain.BranchKindAside:
			return domain.InvalidGroup("an aside is not combined")
		case row.Status != domain.BranchStatusOpen:
			return domain.ErrBranchClosed
		case s.draftStatus(row) == domain.BranchDraftDrafting:
			return domain.ErrBranchDrafting
		}
		if err := requireNoPendingTurn(ctx, q, id, domain.ErrBranchBusy); err != nil {
			return err
		}
		if _, err := q.CloseBranch(ctx, db.CloseBranchParams{LineID: id, Status: domain.BranchStatusDiscarded}); err != nil {
			return fmt.Errorf("close a combined branch: %w", err)
		}
	}
	return nil
}

// finishCombine points the old branches at the new one, writes the notes
// and reads the views.
func (s *Store) finishCombine(ctx context.Context, q *db.Queries, parent lockedParent, ids []uuid.UUID, created CreatedBranch, notes []domain.NoteChange, actor string) (CombinedBranches, error) {
	newID, _ := parseID(created.Line.ID)
	if err := q.SetMergedInto(ctx, db.SetMergedIntoParams{MergedInto: uuid.NullUUID{UUID: newID, Valid: true}, LineIds: ids}); err != nil {
		return CombinedBranches{}, fmt.Errorf("point at the combined branch: %w", err)
	}
	reparented, err := s.reparentOpenChildren(ctx, q, ids, newID)
	if err != nil {
		return CombinedBranches{}, err
	}
	if created.Line, err = s.lineViewOf(ctx, q, newID); err != nil {
		return CombinedBranches{}, err
	}
	out := CombinedBranches{
		Created: created, Combined: []domain.BranchView{}, Reparented: idStrings(reparented), ParentLineID: parent.line.ID.String(), RootLineID: parent.rootID.String(),
	}
	out.Notes = NotesWrite{RootLineID: out.RootLineID, Created: []domain.Note{}, Superseded: []domain.Note{}}
	if len(notes) > 0 {
		root, err := lockLineByID(ctx, q, parent.rootID)
		if err != nil {
			return CombinedBranches{}, err
		}
		if out.Notes, err = s.applyNoteChanges(ctx, q, root, notes, noteWriteContext{actor: actor}); err != nil {
			return CombinedBranches{}, err
		}
	}
	for _, id := range ids {
		view, err := s.branchViewOf(ctx, q, parent.line.TenantID, id)
		if err != nil {
			return CombinedBranches{}, err
		}
		out.Combined = append(out.Combined, view)
	}
	return out, nil
}

// reparentOpenChildren locks the combined branches' open children in id
// order and hangs them on the new branch, within the per-parent cap.
func (s *Store) reparentOpenChildren(ctx context.Context, q *db.Queries, combined []uuid.UUID, newID uuid.UUID) ([]uuid.UUID, error) {
	children, err := q.ListOpenChildBranches(ctx, combined)
	if err != nil {
		return nil, fmt.Errorf("list open children: %w", err)
	}
	if len(children) == 0 {
		return []uuid.UUID{}, nil
	}
	if len(children) > s.limits.Branch.MaxOpenPerParent {
		return nil, domain.ErrBranchLimit
	}
	if err := lockInOrder(ctx, q, children); err != nil {
		return nil, err
	}
	if err := q.ReparentBranches(ctx, db.ReparentBranchesParams{ParentLineID: newID, LineIds: children}); err != nil {
		return nil, fmt.Errorf("reparent the open children: %w", err)
	}
	return children, nil
}
