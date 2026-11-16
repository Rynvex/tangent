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

// Spinning conversations off. detach makes a branch and its subtree a tree
// of their own, under the locks main line → parent → branch → the lines
// below it in id order: the branch's record goes, its subtree is re-rooted
// one level up per its old depth, and whatever belongs to those lines
// (leaves, chapter cuts, seeds anchored there; suggestions of the lines
// below it) moves along.
// Notes stay with the old tree (copyNotes copies the active ones). The
// parent keeps a marker; a link joins the two places.

// DetachBase is what the capsule of a detached branch is built from, read
// under the locks.
type DetachBase struct {
	From domain.SpunOffRef
	Pack domain.BranchPack
	// Leaf is the branch's leaf (nil without one or when WithLeaf is off).
	Leaf *domain.Leaf
}

// DetachInput detaches a branch. Title is the new main line's (empty keeps
// the purpose). WithLeaf carries the branch's leaf into the capsule (the
// leaf feature is on); the branch's own leaf row goes either way.
type DetachInput struct {
	Tenant       string
	LineID       string
	Title        string
	Actor        string
	CopyNotes    bool
	WithLeaf     bool
	BuildCapsule func(DetachBase) domain.OriginCapsule
}

// SpunOff is what a spinoff changed. Line is the new main line; Marker the
// message the source line keeps; Notes the notes copied into the new tree.
// For detach, Branch is the branch as it was, Moved the lines that moved
// with it (below it) and MovedSeeds how many seeds followed their anchor.
type SpunOff struct {
	Mode          string
	Line          domain.LineView
	SourceLineID  string
	OldRootLineID string
	Marker        domain.Message
	Link          domain.Link
	Notes         NotesWrite
	Branch        domain.BranchView
	Moved         []string
	MovedSeeds    int64
	// DissolvedGroups are the active groups the detach dissolved (it took
	// some of their members to the new tree).
	DissolvedGroups []domain.Group
	// ExpiredSuggestions are the old tree's open suggestions that named a
	// line the detach took (a relation's end, a group's member).
	ExpiredSuggestions []domain.Suggestion
}

// Detach makes an open branch, with every line below it, a new main line.
// Refusals: not a branch, closed (or below a closed one), archived, a line
// of the subtree answering (branch_busy), the parent answering
// (source_busy), the branch drafting.
func (s *Store) Detach(ctx context.Context, in DetachInput, hooks ...TxHook) (SpunOff, error) {
	if in.BuildCapsule == nil {
		return SpunOff{}, invalidInput("a detach needs a capsule builder")
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (SpunOff, error) {
		held, below, err := s.lockDetach(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return SpunOff{}, err
		}
		out := SpunOff{Mode: domain.SpinoffDetach, SourceLineID: held.parent.ID.String(), OldRootLineID: held.row.RootLineID.String(), Moved: idStrings(below)}
		if out.Branch, err = s.branchViewOf(ctx, q, in.Tenant, held.child.ID); err != nil {
			return SpunOff{}, err
		}
		title := strings.TrimSpace(in.Title)
		if title == "" {
			title = held.row.Purpose
		}
		capsule, err := s.detachCapsule(ctx, q, held, in)
		if err != nil {
			return SpunOff{}, err
		}
		lines := append([]uuid.UUID{held.child.ID}, below...)
		if err := s.labelMovingSources(ctx, q, held.row.RootLineID, lines); err != nil {
			return SpunOff{}, err
		}
		if out.MovedSeeds, err = rehome(ctx, q, held, lines, below); err != nil {
			return SpunOff{}, err
		}
		if out.DissolvedGroups, err = dissolveGroupsOf(ctx, q, lines); err != nil {
			return SpunOff{}, err
		}
		if out.ExpiredSuggestions, err = expireNamingLines(ctx, q, held.row.RootLineID, lines); err != nil {
			return SpunOff{}, err
		}
		return s.finishSpinoff(ctx, q, spinoffEnd{
			out: out, source: held.parent, sourceMessage: held.row.AnchorMessageID, newLine: held.child.ID, oldRoot: held.row.RootLineID,
			title: title, capsule: capsule, copyNotes: in.CopyNotes, actor: in.Actor,
		})
	})
}

// lockDetach locks the branch with its ancestors and its subtree in id
// order and applies the refusals.
func (s *Store) lockDetach(ctx context.Context, q *db.Queries, tenant, lineID string) (lockedBranch, []uuid.UUID, error) {
	held, err := s.lockBranch(ctx, q, tenant, lineID, true)
	if err != nil {
		return lockedBranch{}, nil, err
	}
	switch {
	case held.row.Status != domain.BranchStatusOpen:
		return lockedBranch{}, nil, domain.ErrBranchClosed
	case held.child.ArchivedAt.Valid || held.parent.ArchivedAt.Valid:
		return lockedBranch{}, nil, domain.ErrLineArchived
	case s.draftStatus(held.row) == domain.BranchDraftDrafting:
		return lockedBranch{}, nil, domain.ErrBranchDrafting
	}
	if err := s.requireAncestorsOpen(ctx, q, held.parent, held.row); err != nil {
		return lockedBranch{}, nil, domain.ErrBranchClosed
	}
	below, err := s.subtreeIDs(ctx, q, held.child.ID)
	if err != nil {
		return lockedBranch{}, nil, err
	}
	if _, err := lockLines(ctx, q, held.child.ID, below); err != nil {
		if errors.Is(err, domain.ErrDeleteBusy) {
			return lockedBranch{}, nil, domain.ErrBranchBusy
		}
		return lockedBranch{}, nil, err
	}
	if err := requireNoPendingTurn(ctx, q, held.parent.ID, domain.ErrBranchSourceBusy); err != nil {
		return lockedBranch{}, nil, err
	}
	return held, below, nil
}

// detachCapsule builds the capsule from the stored pack and (WithLeaf) the
// branch's leaf, and drops the leaf row: a main line has no leaf.
func (s *Store) detachCapsule(ctx context.Context, q *db.Queries, held lockedBranch, in DetachInput) (domain.OriginCapsule, error) {
	base := DetachBase{
		From: domain.SpunOffRef{LineID: held.parent.ID.String(), MessageID: held.row.AnchorMessageID.String(), Title: held.parent.Title},
		Pack: packFromJSON(held.row.Pack),
	}
	leaf, err := q.DeleteLeaf(ctx, held.child.ID)
	switch {
	case err == nil && in.WithLeaf:
		view := leafFromRow(leaf)
		base.Leaf = &view
	case err != nil && !noRows(err):
		return domain.OriginCapsule{}, fmt.Errorf("take the branch's leaf: %w", err)
	}
	return in.BuildCapsule(base), nil
}

// labelMovingSources gives the old tree's notes whose source line moves away
// their source label (they will read the source from it).
func (s *Store) labelMovingSources(ctx context.Context, q *db.Queries, rootID uuid.UUID, lines []uuid.UUID) error {
	notes, err := q.NotesMissingLabels(ctx, db.NotesMissingLabelsParams{RootLineID: rootID, LineIds: lines})
	if err != nil {
		return fmt.Errorf("notes without labels: %w", err)
	}
	for _, note := range notes {
		label, err := s.sourceLabel(ctx, q, rootID, note.SourceLineID, note.SourceMessageID, note.SourceCardMessageID)
		if err != nil {
			return err
		}
		if err := q.SetNoteLabel(ctx, db.SetNoteLabelParams{ID: note.ID, SourceLabel: label}); err != nil {
			return fmt.Errorf("label a note: %w", err)
		}
	}
	return nil
}

// rehome moves the subtree into the new tree rooted at the branch line.
func rehome(ctx context.Context, q *db.Queries, held lockedBranch, lines, below []uuid.UUID) (int64, error) {
	root := held.child.ID
	if err := q.DeleteBranchRow(ctx, root); err != nil {
		return 0, fmt.Errorf("drop the branch record: %w", err)
	}
	if err := q.RehomeBranches(ctx, db.RehomeBranchesParams{RootLineID: root, Shift: held.row.Depth, LineIds: below}); err != nil {
		return 0, fmt.Errorf("move the subtree: %w", err)
	}
	if err := q.RehomeLeaves(ctx, db.RehomeLeavesParams{RootLineID: root, LineIds: lines}); err != nil {
		return 0, fmt.Errorf("move the leaves: %w", err)
	}
	// The detached line's own suggestions stay in the old tree, where its
	// branch ended (the inbox expires the open ones, after an accepted one
	// was marked); only the subtree's move.
	if err := q.RehomeSuggestions(ctx, db.RehomeSuggestionsParams{RootLineID: root, LineIds: below}); err != nil {
		return 0, fmt.Errorf("move the suggestions: %w", err)
	}
	if err := q.RehomeChapterCuts(ctx, db.RehomeChapterCutsParams{RootLineID: root, LineIds: lines}); err != nil {
		return 0, fmt.Errorf("move the chapter cuts: %w", err)
	}
	if err := q.RehomeLinkEnds(ctx, lines); err != nil {
		return 0, fmt.Errorf("move the link ends: %w", err)
	}
	seeds, err := q.RehomeSeeds(ctx, db.RehomeSeedsParams{RootLineID: root, OldRootLineID: held.row.RootLineID, LineIds: lines})
	if err != nil {
		return 0, fmt.Errorf("move the seeds: %w", err)
	}
	// B13: memos follow the node they were written on (never copied).
	if _, err := q.RehomeMemos(ctx, db.RehomeMemosParams{RootLineID: root, OldRootLineID: held.row.RootLineID, LineIds: lines}); err != nil {
		return 0, fmt.Errorf("move the memos: %w", err)
	}
	// B24: so do the terms saved on them (the new conversation has none).
	if _, err := q.RehomeTerms(ctx, db.RehomeTermsParams{RootLineID: root, OldRootLineID: held.row.RootLineID, LineIds: lines}); err != nil {
		return 0, fmt.Errorf("move the terms: %w", err)
	}
	return seeds, nil
}

// spinoffEnd is the part both modes share once the new main line exists.
type spinoffEnd struct {
	out           SpunOff
	source        db.TangentLine
	sourceMessage uuid.UUID
	newLine       uuid.UUID
	oldRoot       uuid.UUID
	title         string
	capsule       domain.OriginCapsule
	copyNotes     bool
	actor         string
}

// finishSpinoff stores the capsule and title, copies the notes, leaves the
// marker on the source line, links both places and reads the views.
func (s *Store) finishSpinoff(ctx context.Context, q *db.Queries, end spinoffEnd) (SpunOff, error) {
	raw, err := json.Marshal(end.capsule)
	if err != nil {
		return SpunOff{}, fmt.Errorf("marshal the capsule: %w", err)
	}
	if err := q.SetLineCapsule(ctx, db.SetLineCapsuleParams{ID: end.newLine, Capsule: raw, Title: end.title, OldRootID: end.oldRoot}); err != nil {
		return SpunOff{}, fmt.Errorf("store the capsule: %w", err)
	}
	out := end.out
	if end.copyNotes {
		if out.Notes, err = s.copyNotes(ctx, q, end.oldRoot, end.newLine, end.actor); err != nil {
			return SpunOff{}, err
		}
	}
	ref := &domain.SpunOffRef{LineID: end.newLine.String(), MessageID: end.sourceMessage.String(), Title: end.title, Available: true}
	marker, err := insertMessage(ctx, q, end.source, NewMessage{
		Role: domain.RoleSystem, Kind: domain.MessageKindBranchMarker, Content: domain.SpinoffMarkerText(end.title), Meta: domain.MessageMeta{SpunOffTo: ref},
	})
	if err != nil {
		return SpunOff{}, err
	}
	out.Marker = messageFromRow(marker)
	link, err := q.InsertLink(ctx, db.InsertLinkParams{
		TenantID: end.source.TenantID, Kind: domain.LinkKindSpinoff, FromLineID: end.source.ID,
		FromMessageID: uuid.NullUUID{UUID: end.sourceMessage, Valid: true}, ToLineID: end.newLine, Label: end.title, RelationKind: domain.RelationKindRelated, CreatedBy: strings.TrimSpace(end.actor),
	})
	if err != nil {
		return SpunOff{}, fmt.Errorf("link the spinoff: %w", err)
	}
	if out.Link, err = linkView(ctx, q, link.ID); err != nil {
		return SpunOff{}, err
	}
	out.Line, err = s.lineViewOf(ctx, q, end.newLine)
	return out, err
}

// copyNotes copies the active notes of a tree into a new one, oldest first,
// each pointing at the note it copies; a note without a label gets one now
// (its sources are in the other tree).
func (s *Store) copyNotes(ctx context.Context, q *db.Queries, from, to uuid.UUID, actor string) (NotesWrite, error) {
	out := NotesWrite{RootLineID: to.String(), Created: []domain.Note{}, Superseded: []domain.Note{}}
	rows, err := q.ListActiveNotes(ctx, from)
	if err != nil {
		return out, fmt.Errorf("list the notes to copy: %w", err)
	}
	for i := len(rows) - 1; i >= 0; i-- {
		note := rows[i]
		label := note.SourceLabel
		if label == "" {
			if label, err = s.sourceLabel(ctx, q, from, note.SourceLineID, note.SourceMessageID, note.SourceCardMessageID); err != nil {
				return out, err
			}
		}
		copied, err := q.InsertCopiedNote(ctx, db.InsertCopiedNoteParams{
			TenantID: note.TenantID, RootLineID: to, Section: note.Section, Text: note.Text, SourceLineID: note.SourceLineID,
			SourceMessageID: note.SourceMessageID, SourceCardMessageID: note.SourceCardMessageID, SourceLabel: label,
			CopiedFromNoteID: uuid.NullUUID{UUID: note.ID, Valid: true}, CreatedBy: strings.TrimSpace(actor),
		})
		if err != nil {
			return out, fmt.Errorf("copy a note: %w", err)
		}
		out.Created = append(out.Created, noteFromRow(copied))
	}
	if len(out.Created) > 0 {
		out.Revision, err = bumpNotesRevision(ctx, q, to)
	}
	return out, err
}

// dissolveGroupsOf dissolves the active groups any of the lines belongs to
// (a detach takes them to another tree) and returns them.
func dissolveGroupsOf(ctx context.Context, q *db.Queries, lines []uuid.UUID) ([]domain.Group, error) {
	rows, err := q.DissolveGroupsOfLines(ctx, lines)
	if err != nil {
		return nil, fmt.Errorf("dissolve the groups it takes: %w", err)
	}
	return groupViews(ctx, q, rows)
}
