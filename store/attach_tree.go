package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// The rows of an attached tree (B20). Every tree-scoped table names its
// conversation by root_line_id; the whole source tree moves, so each moves
// by its old main line and none is left under it:
//   - suggestions, leaves, chapter cuts, seeds, memos (those whose node is
//     gone too), notes (moved, where a detach copies), terms and groups
//     move;
//   - a term the target already has (same key) keeps the target's: the
//     source's goes first (B24);
//   - the source's open suggestions the target already has open expire
//     first (one open per feature, kind and target);
//   - the source's goal goes (a branch has none; the target keeps its own).
// Messages, their tags, folds, comparisons, jobs and links name lines and
// messages, which keep their ids, so they stay as they are. The per-tree
// caps of notes, memos, terms, seeds, milestones, relations and groups gate new
// writes; an attach may bring the target over them.

// moveTree moves the source tree's rows to the target's main line.
func (s *Store) moveTree(ctx context.Context, q *db.Queries, from, to uuid.UUID, out *AttachedLine) error {
	expired, err := q.ExpireCollidingSuggestions(ctx, db.ExpireCollidingSuggestionsParams{FromRoot: from, ToRoot: to})
	if err != nil {
		return fmt.Errorf("expire colliding suggestions: %w", err)
	}
	for _, row := range expired {
		out.ExpiredSuggestions = append(out.ExpiredSuggestions, suggestionFromRow(row))
	}
	if err := moveTreeCounts(ctx, q, from, to, &out.Moved); err != nil {
		return err
	}
	groups, err := q.MoveTreeGroups(ctx, db.MoveTreeGroupsParams{FromRoot: from, ToRoot: to})
	if err != nil {
		return fmt.Errorf("move the groups: %w", err)
	}
	if out.Groups, err = groupViews(ctx, q, groups); err != nil {
		return err
	}
	if _, err := q.DeleteGoal(ctx, from); err == nil {
		out.DroppedGoal = true
	} else if !noRows(err) {
		return fmt.Errorf("drop the source's goal: %w", err)
	}
	if out.Moved.Notes > 0 {
		if out.NotesRevision, err = bumpNotesRevision(ctx, q, to); err != nil {
			return err
		}
	}
	return nil
}

// moveTreeCounts runs the counted moves.
func moveTreeCounts(ctx context.Context, q *db.Queries, from, to uuid.UUID, moved *AttachMoved) error {
	steps := []struct {
		what  string
		count *int64
		run   func(context.Context, uuid.UUID, uuid.UUID) (int64, error)
	}{
		{"suggestions", &moved.Suggestions, func(ctx context.Context, f, t uuid.UUID) (int64, error) {
			return q.MoveTreeSuggestions(ctx, db.MoveTreeSuggestionsParams{FromRoot: f, ToRoot: t})
		}},
		{"leaves", &moved.Leaves, func(ctx context.Context, f, t uuid.UUID) (int64, error) {
			return q.MoveTreeLeaves(ctx, db.MoveTreeLeavesParams{FromRoot: f, ToRoot: t})
		}},
		{"chapter cuts", &moved.ChapterCuts, func(ctx context.Context, f, t uuid.UUID) (int64, error) {
			return q.MoveTreeChapterCuts(ctx, db.MoveTreeChapterCutsParams{FromRoot: f, ToRoot: t})
		}},
		{"seeds", &moved.Seeds, func(ctx context.Context, f, t uuid.UUID) (int64, error) {
			return q.MoveTreeSeeds(ctx, db.MoveTreeSeedsParams{FromRoot: f, ToRoot: t})
		}},
		{"memos", &moved.Memos, func(ctx context.Context, f, t uuid.UUID) (int64, error) {
			return q.MoveTreeMemos(ctx, db.MoveTreeMemosParams{FromRoot: f, ToRoot: t})
		}},
		{"colliding terms", &moved.DroppedTerms, func(ctx context.Context, f, t uuid.UUID) (int64, error) {
			return q.DropCollidingTerms(ctx, db.DropCollidingTermsParams{FromRoot: f, ToRoot: t})
		}},
		{"terms", &moved.Terms, func(ctx context.Context, f, t uuid.UUID) (int64, error) {
			return q.MoveTreeTerms(ctx, db.MoveTreeTermsParams{FromRoot: f, ToRoot: t})
		}},
		{"notes", &moved.Notes, func(ctx context.Context, f, t uuid.UUID) (int64, error) {
			return q.MoveTreeNotes(ctx, db.MoveTreeNotesParams{FromRoot: f, ToRoot: t})
		}},
	}
	for _, step := range steps {
		n, err := step.run(ctx, from, to)
		if err != nil {
			return fmt.Errorf("move the %s: %w", step.what, err)
		}
		*step.count = n
	}
	return nil
}

// checkAttachCard checks a merged attach's card the way a merge checks one:
// branch-side ids must be finished operator or assistant messages of the
// source line, parent-side ids relevant finished messages of the target
// after the anchor. It returns the cleaned card and its rendering.
func (s *Store) checkAttachCard(ctx context.Context, q *db.Queries, held attachHeld, anchor db.TangentMessage, card domain.BranchCard, purpose string) (*domain.BranchCard, string, error) {
	refs := domain.BranchCardRefs{Messages: map[string]string{}, ParentAfterAnchor: map[string]bool{}}
	branchIDs, parentIDs := card.CappedReferencedIDs()
	for _, id := range branchIDs {
		message, err := messageOn(ctx, q, held.source.ID, id)
		if err != nil && !isNotFound(err) {
			return nil, "", err
		}
		if err == nil && domain.ExtractableMessage(message.Role, message.Kind, message.Status) {
			refs.Messages[id] = message.Content
		}
	}
	for _, id := range parentIDs {
		message, err := messageOn(ctx, q, held.target.line.ID, id)
		if err != nil && !isNotFound(err) {
			return nil, "", err
		}
		relevant := message.Role != domain.RoleSystem || message.Kind == domain.MessageKindBranchCard
		if err == nil && message.Status == domain.MessageDone && relevant && message.Seq > anchor.Seq {
			refs.ParentAfterAnchor[id] = true
		}
	}
	checked, problems := domain.ValidateBranchCard(card, refs)
	if len(problems) > 0 {
		return nil, "", domain.CardError(problems)
	}
	return &checked, domain.RenderBranchCardMarkdown(checked, purpose), nil
}

// isNotFound reports a message that is not on the line.
func isNotFound(err error) bool {
	return errors.Is(err, domain.ErrMessageNotFound)
}

// closeAttached leaves the card on the target, already delivered (it
// stands for a conversation that happened, as an extract's card does),
// closes the branch as merged and, with Leaf, writes its confirmed leaf.
func (s *Store) closeAttached(ctx context.Context, q *db.Queries, held attachHeld, card domain.BranchCard, content string, in AttachInput, out *AttachedLine) error {
	written, err := insertMessage(ctx, q, held.target.line, NewMessage{
		Role: domain.RoleSystem, Kind: domain.MessageKindBranchCard, Content: content,
		Meta: domain.MessageMeta{Card: &card, BranchLineID: held.source.ID.String(), Delivered: true},
	})
	if err != nil {
		return err
	}
	message := messageFromRow(written)
	out.CardMessage = &message
	row, err := q.CloseBranch(ctx, db.CloseBranchParams{
		LineID: held.source.ID, Status: domain.BranchStatusMerged, ConclusionLine: domain.BranchConclusionLine(card),
		CardMessageID: uuid.NullUUID{UUID: written.ID, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("close the attached branch: %w", err)
	}
	if !in.Leaf {
		return nil
	}
	leafIn, problems := domain.NormalizeLeaf(domain.LeafFromCard(card, s.limits.Leaf), s.limits.Leaf)
	if len(problems) > 0 {
		return domain.LeafError(problems)
	}
	leaf, err := upsertLeaf(ctx, q, row, leafIn, domain.LeafStatusConfirmed, uuid.NullUUID{}, in.CreatedBy)
	if err != nil {
		return err
	}
	out.Leaf = &leaf
	return nil
}
