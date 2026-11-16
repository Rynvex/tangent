package store

import (
	"bytes"
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Relations are links of kind relation between two places (a line, or a
// message on it) of one tenant's conversations, in one tree or across two.
// A write locks the main lines of both ends' conversations in id order, so
// the per-conversation cap holds under concurrent writers and a move of an
// end's message (which locks its main line first) is never half-seen.

// RelationEnd is one end of a relation: a line and, optionally, a message
// on it.
type RelationEnd struct {
	LineID    string
	MessageID string
}

// CreateRelationInput relates two places. LineID is the line the request
// is made on: the From end must be in its conversation (From.LineID
// defaults to it); the To end may be in any conversation of the tenant.
type CreateRelationInput struct {
	Tenant string
	LineID string
	From   RelationEnd
	To     RelationEnd
	Label  string
	// RelationKind is one of domain.RelationKinds; empty is related.
	RelationKind string
	Actor        string
}

// RelationChange is a relation that was created or deleted and the main
// lines of the conversations it touches (the From end's first).
type RelationChange struct {
	Link        domain.Link
	RootLineIDs []string
}

// relationEnd is an end with its ids parsed and its conversation found.
type relationEnd struct {
	line    uuid.UUID
	message uuid.NullUUID
	root    uuid.UUID
}

// CreateRelation records a relation. Refusals: a label over the limit, the
// same place at both ends, an end that is not a line of the tenant or not a
// finished operator, assistant or card message on that line, a From end
// outside the request's conversation, an archived conversation, the same
// two places related already, the per-conversation cap. Hooks receive the
// RelationChange.
func (s *Store) CreateRelation(ctx context.Context, in CreateRelationInput, hooks ...TxHook) (RelationChange, error) {
	label, err := domain.NormalizeRelationLabel(in.Label, s.limits.Relations)
	if err != nil {
		return RelationChange{}, err
	}
	kind, err := domain.NormalizeRelationKind(in.RelationKind)
	if err != nil {
		return RelationChange{}, err
	}
	if strings.TrimSpace(in.From.LineID) == "" {
		in.From.LineID = in.LineID
	}
	if samePlace(in.From, in.To) {
		return RelationChange{}, invalidInput("a relation joins two different places")
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (RelationChange, error) {
		from, to, err := s.lockRelationEnds(ctx, q, in)
		if err != nil {
			return RelationChange{}, err
		}
		if err := s.checkRelationRoom(ctx, q, from, to); err != nil {
			return RelationChange{}, err
		}
		row, err := q.InsertLink(ctx, db.InsertLinkParams{
			TenantID: in.Tenant, Kind: domain.LinkKindRelation, FromLineID: from.line, FromMessageID: from.message,
			ToLineID: to.line, ToMessageID: to.message, Label: label, RelationKind: kind, CreatedBy: strings.TrimSpace(in.Actor),
		})
		if err != nil {
			return RelationChange{}, fmt.Errorf("insert relation: %w", err)
		}
		return relationChange(ctx, q, row.ID, from.root, to.root)
	})
}

// samePlace reports whether both ends name the same line and message.
func samePlace(a, b RelationEnd) bool {
	return strings.TrimSpace(a.LineID) == strings.TrimSpace(b.LineID) && strings.TrimSpace(a.MessageID) == strings.TrimSpace(b.MessageID)
}

// lockRelationEnds finds both ends, locks their main lines in id order and
// checks them under the locks.
func (s *Store) lockRelationEnds(ctx context.Context, q *db.Queries, in CreateRelationInput) (relationEnd, relationEnd, error) {
	here, err := s.relationLine(ctx, q, in.Tenant, in.LineID)
	if err != nil {
		return relationEnd{}, relationEnd{}, err
	}
	from, err := s.relationLine(ctx, q, in.Tenant, in.From.LineID)
	if err != nil {
		return relationEnd{}, relationEnd{}, err
	}
	to, err := s.relationLine(ctx, q, in.Tenant, in.To.LineID)
	if err != nil {
		return relationEnd{}, relationEnd{}, err
	}
	if from.root != here.root {
		return relationEnd{}, relationEnd{}, invalidInput("a relation starts in the conversation it is drawn from")
	}
	if err := lockRoots(ctx, q, from.root, to.root); err != nil {
		return relationEnd{}, relationEnd{}, err
	}
	if nowHere, err := rootOf(ctx, q, here.line); err != nil {
		return relationEnd{}, relationEnd{}, err
	} else if nowHere != here.root {
		return relationEnd{}, relationEnd{}, errBranchMoved
	}
	for _, end := range []struct {
		end     *relationEnd
		message string
	}{{&from, in.From.MessageID}, {&to, in.To.MessageID}} {
		if err := checkRelationEnd(ctx, q, end.end, end.message); err != nil {
			return relationEnd{}, relationEnd{}, err
		}
	}
	return from, to, nil
}

// relationLine reads a line of the tenant and its conversation's main line.
func (s *Store) relationLine(ctx context.Context, q *db.Queries, tenant, lineID string) (relationEnd, error) {
	line, err := s.lineRow(ctx, q, tenant, lineID)
	if err != nil {
		return relationEnd{}, err
	}
	root, err := rootOf(ctx, q, line.ID)
	if err != nil {
		return relationEnd{}, err
	}
	return relationEnd{line: line.ID, root: root}, nil
}

// lockRoots locks the main lines in id order and refuses an archived one.
func lockRoots(ctx context.Context, q *db.Queries, roots ...uuid.UUID) error {
	locked, err := lockRootRows(ctx, q, roots...)
	if err != nil {
		return err
	}
	for _, root := range locked {
		if root.ArchivedAt.Valid {
			return domain.ErrLineArchived
		}
	}
	return nil
}

// lockRootRows locks the main lines in id order and returns them by id.
func lockRootRows(ctx context.Context, q *db.Queries, roots ...uuid.UUID) (map[uuid.UUID]db.TangentLine, error) {
	sorted := slices.Clone(roots)
	slices.SortFunc(sorted, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
	out := map[uuid.UUID]db.TangentLine{}
	for _, id := range slices.Compact(sorted) {
		root, err := lockLineByID(ctx, q, id)
		if err != nil {
			return nil, err
		}
		out[id] = root
	}
	return out, nil
}

// checkRelationEnd re-reads an end under the locks: the line is still in
// the same conversation (a detach may have moved it; the write is retried)
// and the message, when given, is a finished message on it.
func checkRelationEnd(ctx context.Context, q *db.Queries, end *relationEnd, messageID string) error {
	root, err := rootOf(ctx, q, end.line)
	if err != nil {
		return err
	}
	if root != end.root {
		return errBranchMoved
	}
	if strings.TrimSpace(messageID) == "" {
		return nil
	}
	id, ok := parseID(messageID)
	if !ok {
		return domain.ErrMessageNotFound
	}
	message, err := q.GetMessage(ctx, id)
	if err != nil {
		return lookup(err, domain.ErrMessageNotFound, "get message")
	}
	if message.LineID != end.line || !pinnable(message) {
		return domain.ErrMessageNotFound
	}
	end.message = uuid.NullUUID{UUID: id, Valid: true}
	return nil
}

// checkRelationRoom refuses a relation between the same places as another
// and one that would take either conversation over its cap.
func (s *Store) checkRelationRoom(ctx context.Context, q *db.Queries, from, to relationEnd) error {
	_, err := q.FindRelation(ctx, db.FindRelationParams{ALineID: from.line, AMessageID: from.message, BLineID: to.line, BMessageID: to.message})
	if err == nil {
		return domain.ErrRelationExists
	}
	if !noRows(err) {
		return fmt.Errorf("find relation: %w", err)
	}
	for _, root := range slices.Compact([]uuid.UUID{from.root, to.root}) {
		lines, err := treeLineIDs(ctx, q, root)
		if err != nil {
			return err
		}
		count, err := q.CountRelationsOfLines(ctx, append([]uuid.UUID{root}, lines...))
		if err != nil {
			return fmt.Errorf("count relations: %w", err)
		}
		if int(count) >= s.limits.Relations.MaxPerTree {
			return domain.ErrRelationLimit
		}
	}
	return nil
}

// relationChange reads the link view and names the conversations.
func relationChange(ctx context.Context, q *db.Queries, id, fromRoot, toRoot uuid.UUID) (RelationChange, error) {
	link, err := linkView(ctx, q, id)
	if err != nil {
		return RelationChange{}, err
	}
	roots := []string{fromRoot.String()}
	if toRoot != fromRoot {
		roots = append(roots, toRoot.String())
	}
	return RelationChange{Link: link, RootLineIDs: roots}, nil
}

// DeleteRelation removes a relation one of whose ends is in the line's
// conversation (ErrRelationNotFound otherwise, and for links of other
// kinds). Only the caller's conversation must not be archived: a relation
// to an archived conversation can still be removed from this side. Hooks
// receive the RelationChange.
func (s *Store) DeleteRelation(ctx context.Context, tenant, lineID, relationID string, hooks ...TxHook) (RelationChange, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (RelationChange, error) {
		link, roots, err := s.lockRelation(ctx, q, tenant, lineID, relationID, false)
		if err != nil {
			return RelationChange{}, err
		}
		change, err := relationChange(ctx, q, link.ID, roots[0], roots[len(roots)-1])
		if err != nil {
			return RelationChange{}, err
		}
		if err := q.DeleteLink(ctx, link.ID); err != nil {
			return RelationChange{}, fmt.Errorf("delete relation: %w", err)
		}
		return change, nil
	})
}

// relationOf reads a relation of the tenant and the main lines of its two
// ends' conversations (from first).
func (s *Store) relationOf(ctx context.Context, q *db.Queries, tenant, relationID string) (db.TangentLink, []uuid.UUID, error) {
	id, ok := parseID(relationID)
	if !ok {
		return db.TangentLink{}, nil, domain.ErrRelationNotFound
	}
	link, err := q.GetLink(ctx, id)
	if err != nil {
		return db.TangentLink{}, nil, lookup(err, domain.ErrRelationNotFound, "get relation")
	}
	if link.TenantID != tenant || link.Kind != domain.LinkKindRelation {
		return db.TangentLink{}, nil, domain.ErrRelationNotFound
	}
	fromRoot, err := rootOf(ctx, q, link.FromLineID)
	if err != nil {
		return db.TangentLink{}, nil, err
	}
	toRoot, err := rootOf(ctx, q, link.ToLineID)
	if err != nil {
		return db.TangentLink{}, nil, err
	}
	return link, []uuid.UUID{fromRoot, toRoot}, nil
}

// RelationEdit is a change to a relation: a nil field keeps the stored
// value.
type RelationEdit struct {
	Label        *string
	RelationKind *string
}

// UpdateRelationLabel changes the label of a relation and keeps its kind;
// see UpdateRelation.
func (s *Store) UpdateRelationLabel(ctx context.Context, tenant, lineID, relationID, label string, hooks ...TxHook) (RelationChange, error) {
	return s.UpdateRelation(ctx, tenant, lineID, relationID, RelationEdit{Label: &label}, hooks...)
}

// UpdateRelation changes the label and/or the kind of a relation one of
// whose ends is in the line's conversation, under the same locks as a
// delete; an edit with neither field writes the stored values back. A
// given kind must be one of the four (empty is invalid_input, unlike on
// create). Hooks receive the RelationChange.
func (s *Store) UpdateRelation(ctx context.Context, tenant, lineID, relationID string, edit RelationEdit, hooks ...TxHook) (RelationChange, error) {
	var label, kind string
	var err error
	if edit.Label != nil {
		if label, err = domain.NormalizeRelationLabel(*edit.Label, s.limits.Relations); err != nil {
			return RelationChange{}, err
		}
	}
	if edit.RelationKind != nil {
		if kind, err = domain.ParseRelationKind(*edit.RelationKind); err != nil {
			return RelationChange{}, err
		}
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (RelationChange, error) {
		link, roots, err := s.lockRelation(ctx, q, tenant, lineID, relationID, true)
		if err != nil {
			return RelationChange{}, err
		}
		params := db.UpdateRelationParams{ID: link.ID, Label: link.Label, RelationKind: link.RelationKind}
		if edit.Label != nil {
			params.Label = label
		}
		if edit.RelationKind != nil {
			params.RelationKind = kind
		}
		if _, err := q.UpdateRelation(ctx, params); err != nil {
			return RelationChange{}, fmt.Errorf("update relation: %w", err)
		}
		return relationChange(ctx, q, link.ID, roots[0], roots[len(roots)-1])
	})
}

// lockRelation finds a relation touching the line's conversation, locks
// both ends' main lines and reads it again under the locks: gone (deleted
// meanwhile) → ErrRelationNotFound; an end moved to another tree → the
// write is retried. Archived: the caller's conversation is always refused,
// the other one too when both is set.
func (s *Store) lockRelation(ctx context.Context, q *db.Queries, tenant, lineID, relationID string, both bool) (db.TangentLink, []uuid.UUID, error) {
	here, err := s.relationLine(ctx, q, tenant, lineID)
	if err != nil {
		return db.TangentLink{}, nil, err
	}
	_, roots, err := s.relationOf(ctx, q, tenant, relationID)
	if err != nil {
		return db.TangentLink{}, nil, err
	}
	if !slices.Contains(roots, here.root) {
		return db.TangentLink{}, nil, domain.ErrRelationNotFound
	}
	locked, err := lockRootRows(ctx, q, roots...)
	if err != nil {
		return db.TangentLink{}, nil, err
	}
	for id, root := range locked {
		if root.ArchivedAt.Valid && (both || id == here.root) {
			return db.TangentLink{}, nil, domain.ErrLineArchived
		}
	}
	if nowHere, err := rootOf(ctx, q, here.line); err != nil {
		return db.TangentLink{}, nil, err
	} else if nowHere != here.root {
		return db.TangentLink{}, nil, errBranchMoved
	}
	link, now, err := s.relationOf(ctx, q, tenant, relationID)
	if err != nil {
		return db.TangentLink{}, nil, err
	}
	if !slices.Equal(now, roots) {
		return db.TangentLink{}, nil, errBranchMoved
	}
	return link, roots, nil
}
