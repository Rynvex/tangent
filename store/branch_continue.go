package store

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// ContinueAsideInput continues an answered aside as an ordinary branch
// (B23). Purpose is the new branch's (empty keeps the aside's); Kind is
// investigate (the default) or alternative. ParentLineID and
// AnchorMessageID say where the aside hung when the caller built Pack from
// its parent: an aside that hangs elsewhere by now is ErrConcurrentChange.
type ContinueAsideInput struct {
	Tenant          string
	LineID          string
	Purpose         string
	Kind            string
	ConfirmDeeper   bool
	CreatedBy       string
	ParentLineID    string
	AnchorMessageID string
	Pack            domain.BranchPack
	HostMeta        json.RawMessage
}

// ContinuedAside is what continuing an aside changed: the new branch (Line,
// Branch), the aside it replaced, the messages that moved into the branch
// in seq order, the aside's own branches that now hang on the new branch,
// and what went with the aside's line (Gone; its moved messages are not in
// it).
type ContinuedAside struct {
	Line            domain.LineView
	Branch          domain.BranchView
	ReplacedLineID  string
	ParentLineID    string
	RootLineID      string
	MovedMessageIDs []string
	Reparented      []string
	Gone            LinesGone
}

// ContinueAside replaces an ended, answered aside by a new open branch on
// the same anchor, in one transaction under the locks root → parent → aside
// → the lines below it in id order. The state machine is not bent: the
// ended aside is not reopened, it is deleted once its finished messages
// moved into the new branch (their seq does not change; failed ones go with
// the aside). The new branch keeps the aside's origin, excerpt, provider
// and model; the limits are CreateBranch's (the aside itself does not count
// against the tree's). Branches of the aside hang on the new branch at the
// same depth. Refusals: not a branch, not an aside, archived, still open
// (ErrAsideNotEnded), no answer (ErrAsideUnanswered), a line of its subtree
// answering (ErrBranchBusy), and whatever CreateBranch refuses about the
// parent.
func (s *Store) ContinueAside(ctx context.Context, in ContinueAsideInput, hooks ...TxHook) (ContinuedAside, error) {
	kind, err := domain.NormalizeContinueKind(in.Kind)
	if err != nil {
		return ContinuedAside{}, err
	}
	in.Kind = kind
	if in.Purpose = strings.TrimSpace(in.Purpose); in.Purpose != "" {
		purpose, ok := domain.NormalizeBranchPurpose(in.Purpose, s.limits.Branch)
		if !ok {
			return ContinuedAside{}, domain.ErrInvalidPurpose
		}
		in.Purpose = purpose
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (ContinuedAside, error) {
		held, err := s.lockEndedAside(ctx, q, in)
		if err != nil {
			return ContinuedAside{}, err
		}
		created, err := s.openContinuation(ctx, q, held, in)
		if err != nil {
			return ContinuedAside{}, err
		}
		out, err := s.replaceAside(ctx, q, held, created.ID)
		if err != nil {
			return ContinuedAside{}, err
		}
		branch, err := s.createdBranch(ctx, q, created)
		if err != nil {
			return ContinuedAside{}, err
		}
		out.Line, out.Branch = branch.Line, branch.Branch
		return out, nil
	})
}

// lockEndedAside locks root → parent → aside → its subtree and applies the
// refusals about the aside itself.
func (s *Store) lockEndedAside(ctx context.Context, q *db.Queries, in ContinueAsideInput) (lockedBranch, error) {
	held, err := s.lockBranch(ctx, q, in.Tenant, in.LineID, true)
	if err != nil {
		return lockedBranch{}, err
	}
	switch {
	case held.row.Kind != domain.BranchKindAside:
		return lockedBranch{}, domain.ErrContinueNotAside
	case held.child.ArchivedAt.Valid || held.parent.ArchivedAt.Valid:
		return lockedBranch{}, domain.ErrLineArchived
	case held.row.Status == domain.BranchStatusOpen:
		return lockedBranch{}, domain.ErrAsideNotEnded
	}
	// The pack was built outside the locks from where the aside hung then.
	if parent, ok := parseID(in.ParentLineID); !ok || parent != held.parent.ID || !sameID(in.AnchorMessageID, held.row.AnchorMessageID) {
		return lockedBranch{}, domain.ErrConcurrentChange
	}
	below, err := s.subtreeIDs(ctx, q, held.child.ID)
	if err != nil {
		return lockedBranch{}, err
	}
	if _, err := lockLines(ctx, q, held.child.ID, below); err != nil {
		if errors.Is(err, domain.ErrDeleteBusy) {
			return lockedBranch{}, domain.ErrBranchBusy
		}
		return lockedBranch{}, err
	}
	answers, err := q.CountDoneAssistantReplies(ctx, held.child.ID)
	if err != nil {
		return lockedBranch{}, fmt.Errorf("count aside replies: %w", err)
	}
	if answers == 0 {
		return lockedBranch{}, domain.ErrAsideUnanswered
	}
	return held, nil
}

// sameID reports whether text is the id.
func sameID(text string, id uuid.UUID) bool {
	parsed, ok := parseID(text)
	return ok && parsed == id
}

// openContinuation opens the new branch where the aside hangs, under
// CreateBranch's limits and anchor check.
func (s *Store) openContinuation(ctx context.Context, q *db.Queries, held lockedBranch, in ContinueAsideInput) (db.TangentLine, error) {
	parent := lockedParent{line: held.parent, rootID: held.row.RootLineID}
	var err error
	if parent.branch, parent.hasBranch, err = branchRowFor(ctx, q, held.parent.ID); err != nil {
		return db.TangentLine{}, err
	}
	depth, err := s.checkBranchLimitsReplacing(ctx, q, parent, in.ConfirmDeeper, 1)
	if err != nil {
		return db.TangentLine{}, err
	}
	anchor, err := requireAnchor(ctx, q, parent.line, in.AnchorMessageID)
	if err != nil {
		return db.TangentLine{}, err
	}
	purpose := in.Purpose
	if purpose == "" {
		purpose = held.row.Purpose
	}
	return s.insertBranch(ctx, q, parent, anchor, depth, CreateBranchInput{
		Purpose: purpose, Excerpt: held.row.Excerpt, Kind: in.Kind, Origin: held.row.Origin, Provider: held.child.Provider,
		Model: held.child.Model, CreatedBy: in.CreatedBy, Pack: in.Pack, HostMeta: in.HostMeta,
	})
}

// replaceAside moves the aside's finished messages and its branches to the
// new branch line and deletes the aside's line with what is left on it.
func (s *Store) replaceAside(ctx context.Context, q *db.Queries, held lockedBranch, newLine uuid.UUID) (ContinuedAside, error) {
	aside, root := held.child.ID, held.row.RootLineID
	out := ContinuedAside{ReplacedLineID: aside.String(), ParentLineID: held.parent.ID.String(), RootLineID: root.String()}
	moved, err := q.MoveDoneMessages(ctx, db.MoveDoneMessagesParams{ToLine: newLine, FromLine: aside})
	if err != nil {
		return ContinuedAside{}, fmt.Errorf("move the aside's messages: %w", err)
	}
	out.MovedMessageIDs = movedInSeqOrder(moved)
	// Links that end on a moved message follow it to the new line.
	if err := q.RehomeLinkEnds(ctx, []uuid.UUID{newLine}); err != nil {
		return ContinuedAside{}, fmt.Errorf("move the link ends: %w", err)
	}
	children, err := q.ListChildBranchIDs(ctx, aside)
	if err != nil {
		return ContinuedAside{}, fmt.Errorf("list the aside's branches: %w", err)
	}
	if len(children) > 0 {
		if err := q.ReparentBranches(ctx, db.ReparentBranchesParams{ParentLineID: newLine, LineIds: children}); err != nil {
			return ContinuedAside{}, fmt.Errorf("re-hang the aside's branches: %w", err)
		}
	}
	out.Reparented = idStrings(children)
	// B24: terms saved from the aside name the new line (it holds their
	// messages now) instead of losing their source.
	if err := q.RepointTermSources(ctx, db.RepointTermSourcesParams{ToLine: uuid.NullUUID{UUID: newLine, Valid: true}, FromLine: uuid.NullUUID{UUID: aside, Valid: true}}); err != nil {
		return ContinuedAside{}, fmt.Errorf("repoint the terms: %w", err)
	}
	if out.Gone, err = s.releaseLines(ctx, q, root, []uuid.UUID{aside}); err != nil {
		return ContinuedAside{}, err
	}
	if err := q.DeleteLines(ctx, db.DeleteLinesParams{TenantID: held.child.TenantID, LineIds: []uuid.UUID{aside}}); err != nil {
		return ContinuedAside{}, fmt.Errorf("delete the continued aside: %w", err)
	}
	return out, nil
}

// movedInSeqOrder are the ids of moved messages, oldest first.
func movedInSeqOrder(rows []db.MoveDoneMessagesRow) []string {
	sorted := slices.Clone(rows)
	slices.SortFunc(sorted, func(a, b db.MoveDoneMessagesRow) int { return cmp.Compare(a.Seq, b.Seq) })
	out := make([]string, 0, len(sorted))
	for _, row := range sorted {
		out = append(out, row.ID.String())
	}
	return out
}
