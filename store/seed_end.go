package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// NoteSeedInput writes a seed into the notes; Section defaults to
// to_confirm.
type NoteSeedInput struct {
	Tenant  string
	SeedID  string
	Section string
	Actor   string
}

// NotedSeed is a seed that became a note, and the notes write.
type NotedSeed struct {
	Seed  domain.Seed
	Notes NotesWrite
}

// NoteSeed turns an open seed into a note (its text, cut to the note limit;
// its source the anchor while that is still in the conversation) in one
// transaction under the locks main line → seed.
func (s *Store) NoteSeed(ctx context.Context, in NoteSeedInput, hooks ...TxHook) (NotedSeed, error) {
	section := strings.TrimSpace(in.Section)
	if section == "" {
		section = domain.NoteSectionToConfirm
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (NotedSeed, error) {
		peek, err := seedOfTenant(ctx, q, in.Tenant, in.SeedID)
		if err != nil {
			return NotedSeed{}, err
		}
		root, err := lockOpenRootOf(ctx, q, peek.RootLineID)
		if err != nil {
			return NotedSeed{}, err
		}
		seed, err := lockOpenSeed(ctx, q, peek.ID, root.ID)
		if err != nil {
			return NotedSeed{}, err
		}
		change := domain.NoteChange{Op: domain.NoteOpAdd, Section: section, Text: domain.SeedNoteText(seed.Text, s.limits.Notes)}
		if seed.AnchorMessageID.Valid {
			if _, inTree, err := treeChatMessage(ctx, q, root.ID, seed.AnchorMessageID.UUID.String()); err != nil {
				return NotedSeed{}, err
			} else if inTree {
				change.SourceMessageID = seed.AnchorMessageID.UUID.String()
			}
		}
		changes, err := s.normaliseNotes([]domain.NoteChange{change})
		if err != nil {
			return NotedSeed{}, err
		}
		out := NotedSeed{}
		if out.Notes, err = s.applyNoteChanges(ctx, q, root, changes, noteWriteContext{actor: in.Actor}); err != nil {
			return NotedSeed{}, err
		}
		note := uuid.NullUUID{UUID: uuid.MustParse(out.Notes.Created[0].ID), Valid: true}
		out.Seed, err = finishSeed(ctx, q, seed.ID, domain.SeedStatusNoted, uuid.NullUUID{}, note)
		return out, err
	})
}

// SeedExpansion is where an open seed's branch would hang: the line its
// anchor sits on now (messages move with a move or a promotion) or, when
// that line has ended, the fork point of the nearest ancestor that has not;
// the main line's newest chat message when the anchor is gone or there was
// none.
type SeedExpansion struct {
	Seed            domain.Seed
	ParentLineID    string
	AnchorMessageID string
}

// PlanSeedExpansion finds where an open seed's branch would hang, so the
// caller can build the pack outside the lock (as for CreateBranch).
func (s *Store) PlanSeedExpansion(ctx context.Context, tenant, seedID string) (SeedExpansion, error) {
	row, err := seedOfTenant(ctx, s.q, tenant, seedID)
	if err != nil {
		return SeedExpansion{}, err
	}
	if row.Status != domain.SeedStatusOpen {
		return SeedExpansion{}, domain.ErrSeedNotOpen
	}
	seed, err := seedView(ctx, s.q, row)
	if err != nil {
		return SeedExpansion{}, err
	}
	out := SeedExpansion{Seed: seed}
	if row.AnchorMessageID.Valid {
		message, ok, err := treeChatMessage(ctx, s.q, row.RootLineID, row.AnchorMessageID.UUID.String())
		if err != nil {
			return SeedExpansion{}, err
		}
		if ok {
			out.ParentLineID, out.AnchorMessageID, err = s.usableFork(ctx, message.LineID, message.ID)
			return out, err
		}
	}
	latest, err := s.q.LatestChatMessage(ctx, row.RootLineID)
	if noRows(err) {
		return SeedExpansion{}, domain.ErrBranchAnchorNotFound
	}
	if err != nil {
		return SeedExpansion{}, fmt.Errorf("newest message: %w", err)
	}
	out.ParentLineID, out.AnchorMessageID = row.RootLineID.String(), latest.ID.String()
	return out, nil
}

// usableFork walks up from a line that has ended (or hangs below one that
// has) to the nearest line that has not, through the fork points: the
// ended branch's anchor on its parent. The main line is always usable.
func (s *Store) usableFork(ctx context.Context, lineID, messageID uuid.UUID) (string, string, error) {
	for level := 0; level <= s.limits.Branch.HardMaxDepth+1; level++ {
		ended, err := s.BranchLineEnded(ctx, lineID.String())
		if err != nil {
			return "", "", err
		}
		if !ended {
			break
		}
		row, isBranch, err := branchRowFor(ctx, s.q, lineID)
		if err != nil {
			return "", "", err
		}
		if !isBranch {
			break
		}
		lineID, messageID = row.ParentLineID, row.AnchorMessageID
	}
	return lineID.String(), messageID.String(), nil
}

// ExpandSeedInput opens the branch of a seed: the branch input as for
// CreateBranch (the parent and anchor from PlanSeedExpansion); the origin is
// always seed.
type ExpandSeedInput struct {
	SeedID string
	CreateBranchInput
}

// ExpandedSeed is the expanded seed and its new branch.
type ExpandedSeed struct {
	Seed domain.Seed
	CreatedBranch
}

// ExpandSeed opens a branch from an open seed and ends the seed, in one
// transaction under the locks main line → parent → seed. Every refusal of
// CreateBranch applies, and the seed stays open when one does.
func (s *Store) ExpandSeed(ctx context.Context, in ExpandSeedInput, hooks ...TxHook) (ExpandedSeed, error) {
	in.Origin = ""
	branchIn, err := s.normalizeBranchInput(in.CreateBranchInput, false)
	if err != nil {
		return ExpandedSeed{}, err
	}
	branchIn.Origin = domain.BranchOriginSeed
	return runTx(ctx, s, hooks, func(q *db.Queries) (ExpandedSeed, error) {
		peek, err := seedOfTenant(ctx, q, branchIn.Tenant, in.SeedID)
		if err != nil {
			return ExpandedSeed{}, err
		}
		parent, err := s.lockParent(ctx, q, branchIn.Tenant, branchIn.ParentLineID)
		if err != nil {
			return ExpandedSeed{}, err
		}
		if parent.rootID != peek.RootLineID {
			return ExpandedSeed{}, domain.ErrSeedNotFound
		}
		if _, err := lockOpenSeed(ctx, q, peek.ID, parent.rootID); err != nil {
			return ExpandedSeed{}, err
		}
		created, err := s.createInParent(ctx, q, parent, branchIn)
		if err != nil {
			return ExpandedSeed{}, err
		}
		out := ExpandedSeed{CreatedBranch: created}
		lineID := uuid.MustParse(created.Line.ID)
		out.Seed, err = finishSeed(ctx, q, peek.ID, domain.SeedStatusExpanded, uuid.NullUUID{UUID: lineID, Valid: true}, uuid.NullUUID{})
		return out, err
	})
}
