package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// The glossary (B24) belongs to the main line of its conversation: every
// write locks that row (a term never changes a line), so the per-tree cap
// and the one-term-per-key rule hold under concurrent writers and an
// archived conversation refuses every write. Saving a term from an aside
// also keeps the aside (B23's kept_at), under the aside line's lock taken
// after the main line's: the order the purge, continue and delete use.

// Changes a TermChange reports.
const (
	TermCreated = "created"
	TermUpdated = "updated"
	TermDeleted = "deleted"
)

// termListCap bounds one conversation's listing (an attach may bring a
// conversation over Limits.Glossary.MaxPerTree).
const termListCap = 1000

// TermChange is what a glossary write did: the term as it is now (as it
// was, for a delete), the change, and the aside the write kept (nil unless
// a save from an aside that was not kept yet).
type TermChange struct {
	Term   domain.Term
	Change string
	Kept   *domain.BranchView
}

// CreateTermInput saves a term from LineID (any line of the conversation;
// an aside is kept). SourceMessageID, optional, is a message on that line.
// Replace overwrites the explanation and source of the term the
// conversation already has; otherwise that is term_exists. Markers are the
// host's protocol markers, removed from the texts.
type CreateTermInput struct {
	Tenant          string
	LineID          string
	Term            string
	Explanation     string
	SourceMessageID string
	Replace         bool
	Actor           string
	Markers         []string
}

// CreateTerm saves a term. Refusals: an empty or long term or explanation,
// a source message that is not on the line, an archived conversation, the
// term already there (without Replace), the cap.
func (s *Store) CreateTerm(ctx context.Context, in CreateTermInput, hooks ...TxHook) (TermChange, error) {
	term, key, err := domain.CleanTerm(in.Term, s.limits.Glossary, in.Markers)
	if err != nil {
		return TermChange{}, err
	}
	explanation, err := domain.CleanTermExplanation(in.Explanation, s.limits.Glossary, in.Markers)
	if err != nil {
		return TermChange{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (TermChange, error) {
		line, err := s.lineRow(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return TermChange{}, err
		}
		root, err := lockOpenRootOf(ctx, q, line.ID)
		if err != nil {
			return TermChange{}, err
		}
		kept, err := s.keepSourceAside(ctx, q, root.ID, line.ID)
		if err != nil {
			return TermChange{}, err
		}
		source, err := s.termSource(ctx, q, root.ID, line.ID, in.SourceMessageID)
		if err != nil {
			return TermChange{}, err
		}
		out, err := s.saveTerm(ctx, q, root, termWrite{term: term, key: key, explanation: explanation, source: source, replace: in.Replace, actor: in.Actor})
		out.Kept = kept
		return out, err
	})
}

// termWrite is a cleaned save.
type termWrite struct {
	term, key, explanation string
	source                 termSourceRef
	replace                bool
	actor                  string
}

// termSourceRef is where a term is saved from.
type termSourceRef struct {
	line, message uuid.NullUUID
	label         string
}

// termSource checks the source message (on the line) and snapshots the
// source's label.
func (s *Store) termSource(ctx context.Context, q *db.Queries, rootID, lineID uuid.UUID, messageID string) (termSourceRef, error) {
	ref := termSourceRef{line: uuid.NullUUID{UUID: lineID, Valid: true}}
	if strings.TrimSpace(messageID) != "" {
		message, err := messageOn(ctx, q, lineID, strings.TrimSpace(messageID))
		if err != nil {
			return termSourceRef{}, err
		}
		ref.message = uuid.NullUUID{UUID: message.ID, Valid: true}
	}
	label, err := s.sourceLabel(ctx, q, rootID, ref.line, ref.message, uuid.NullUUID{})
	ref.label = label
	return ref, err
}

// saveTerm inserts the term, or overwrites the stored one (replace), under
// the main line's lock.
func (s *Store) saveTerm(ctx context.Context, q *db.Queries, root db.TangentLine, w termWrite) (TermChange, error) {
	existing, err := q.GetTermByKey(ctx, db.GetTermByKeyParams{RootLineID: root.ID, TermKey: w.key})
	switch {
	case err == nil && !w.replace:
		return TermChange{}, domain.TermExists(termView(existing))
	case err == nil:
		row, err := q.ReplaceTermSource(ctx, db.ReplaceTermSourceParams{
			ID: existing.ID, Explanation: w.explanation, SourceLineID: w.source.line, SourceMessageID: w.source.message, SourceLabel: w.source.label,
		})
		if err != nil {
			return TermChange{}, fmt.Errorf("replace term: %w", err)
		}
		return TermChange{Term: termView(row), Change: TermUpdated}, nil
	case !noRows(err):
		return TermChange{}, fmt.Errorf("get term: %w", err)
	}
	if count, err := q.CountTerms(ctx, root.ID); err != nil {
		return TermChange{}, fmt.Errorf("count terms: %w", err)
	} else if int(count) >= s.limits.Glossary.MaxPerTree {
		return TermChange{}, domain.ErrTermLimit
	}
	row, err := q.InsertTerm(ctx, db.InsertTermParams{
		TenantID: root.TenantID, RootLineID: root.ID, Term: w.term, TermKey: w.key, Explanation: w.explanation,
		SourceLineID: w.source.line, SourceMessageID: w.source.message, SourceLabel: w.source.label, CreatedBy: strings.TrimSpace(w.actor),
	})
	if err != nil {
		return TermChange{}, fmt.Errorf("insert term: %w", err)
	}
	return TermChange{Term: termView(row), Change: TermCreated}, nil
}

// keepSourceAside keeps the aside a term was saved from, under its line's
// lock (the main line's is held): a saved aside is never purged. nil for
// any other line, or an aside kept already.
func (s *Store) keepSourceAside(ctx context.Context, q *db.Queries, rootID, lineID uuid.UUID) (*domain.BranchView, error) {
	if lineID == rootID {
		return nil, nil
	}
	line, err := lockLineByID(ctx, q, lineID)
	if err != nil {
		return nil, err
	}
	row, isBranch, err := branchRowFor(ctx, q, lineID)
	if err != nil {
		return nil, err
	}
	// The main line's lock pins the tree; the check only guards that.
	if !isBranch || row.RootLineID != rootID {
		return nil, errBranchMoved
	}
	if row.Kind != domain.BranchKindAside || row.KeptAt.Valid {
		return nil, nil
	}
	if _, err := q.SetBranchKept(ctx, db.SetBranchKeptParams{LineID: lineID, Keep: true}); err != nil {
		return nil, fmt.Errorf("keep the aside: %w", err)
	}
	view, err := s.branchViewOf(ctx, q, line.TenantID, lineID)
	return &view, err
}

// TermPatch changes a term: nil leaves a field as it is.
type TermPatch struct {
	Term        *string
	Explanation *string
	Markers     []string
}

// UpdateTerm changes a term's text or explanation. A new spelling of
// another term of the conversation is term_exists; an empty patch is
// invalid_input.
func (s *Store) UpdateTerm(ctx context.Context, tenant, termID string, patch TermPatch, hooks ...TxHook) (TermChange, error) {
	if patch.Term == nil && patch.Explanation == nil {
		return TermChange{}, invalidInput("give a term or an explanation to change")
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (TermChange, error) {
		row, err := s.lockTerm(ctx, q, tenant, termID)
		if err != nil {
			return TermChange{}, err
		}
		params, err := s.patchedTerm(row, patch)
		if err != nil {
			return TermChange{}, err
		}
		if params.TermKey != row.TermKey {
			other, err := q.GetTermByKey(ctx, db.GetTermByKeyParams{RootLineID: row.RootLineID, TermKey: params.TermKey})
			if err == nil {
				return TermChange{}, domain.TermExists(termView(other))
			}
			if !noRows(err) {
				return TermChange{}, fmt.Errorf("get term: %w", err)
			}
		}
		updated, err := q.UpdateTermText(ctx, params)
		if err != nil {
			return TermChange{}, fmt.Errorf("update term: %w", err)
		}
		return TermChange{Term: termView(updated), Change: TermUpdated}, nil
	})
}

// patchedTerm is the row after the patch, cleaned.
func (s *Store) patchedTerm(row db.TangentTerm, patch TermPatch) (db.UpdateTermTextParams, error) {
	out := db.UpdateTermTextParams{ID: row.ID, Term: row.Term, TermKey: row.TermKey, Explanation: row.Explanation}
	var err error
	if patch.Term != nil {
		if out.Term, out.TermKey, err = domain.CleanTerm(*patch.Term, s.limits.Glossary, patch.Markers); err != nil {
			return out, err
		}
	}
	if patch.Explanation != nil {
		out.Explanation, err = domain.CleanTermExplanation(*patch.Explanation, s.limits.Glossary, patch.Markers)
	}
	return out, err
}

// DeleteTerm removes a term for good and returns it as it was.
func (s *Store) DeleteTerm(ctx context.Context, tenant, termID string, hooks ...TxHook) (TermChange, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (TermChange, error) {
		row, err := s.lockTerm(ctx, q, tenant, termID)
		if err != nil {
			return TermChange{}, err
		}
		if err := q.DeleteTerm(ctx, row.ID); err != nil {
			return TermChange{}, fmt.Errorf("delete term: %w", err)
		}
		return TermChange{Term: termView(row), Change: TermDeleted}, nil
	})
}

// lockTerm locks the term's main line (refusing an archived conversation)
// and reads the term again under that lock, as lockMemo does.
func (s *Store) lockTerm(ctx context.Context, q *db.Queries, tenant, termID string) (db.TangentTerm, error) {
	id, ok := parseID(termID)
	if !ok {
		return db.TangentTerm{}, domain.ErrTermNotFound
	}
	before, err := q.GetTerm(ctx, id)
	if err != nil {
		return db.TangentTerm{}, lookup(err, domain.ErrTermNotFound, "get term")
	}
	if before.TenantID != tenant {
		return db.TangentTerm{}, domain.ErrTermNotFound
	}
	root, err := lockOpenRootOf(ctx, q, before.RootLineID)
	if err != nil {
		return db.TangentTerm{}, err
	}
	row, err := q.GetTerm(ctx, id)
	if err != nil {
		return db.TangentTerm{}, lookup(err, domain.ErrTermNotFound, "get term")
	}
	// A detach or an attach moved the term between the read and the lock.
	if row.RootLineID != root.ID {
		return db.TangentTerm{}, errBranchMoved
	}
	return row, nil
}

// TermList is a conversation's glossary in key order.
type TermList struct {
	RootLineID string
	Terms      []domain.Term
}

// ListTerms lists the glossary of the line's conversation.
func (s *Store) ListTerms(ctx context.Context, tenant, lineID string) (TermList, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return TermList{}, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return TermList{}, err
	}
	rows, err := s.q.ListTerms(ctx, db.ListTermsParams{RootLineID: root, RowLimit: int32(max(termListCap, s.limits.Glossary.MaxPerTree))})
	if err != nil {
		return TermList{}, fmt.Errorf("list terms: %w", err)
	}
	terms := make([]domain.Term, 0, len(rows))
	for _, row := range rows {
		terms = append(terms, termView(row))
	}
	return TermList{RootLineID: root.String(), Terms: terms}, nil
}

// RecentTermNames are the terms (only the terms) of a conversation, most
// recently updated first, at most limit: what a prompt may carry.
func (s *Store) RecentTermNames(ctx context.Context, rootLineID string, limit int) ([]string, error) {
	id, ok := parseID(rootLineID)
	if !ok {
		return nil, domain.ErrLineNotFound
	}
	names, err := s.q.ListRecentTermNames(ctx, db.ListRecentTermNamesParams{RootLineID: id, RowLimit: int32(max(limit, 0))})
	if err != nil {
		return nil, fmt.Errorf("list term names: %w", err)
	}
	return names, nil
}

func termView(row db.TangentTerm) domain.Term {
	return domain.Term{
		ID: row.ID.String(), RootLineID: row.RootLineID.String(), Term: row.Term, TermKey: row.TermKey, Explanation: row.Explanation,
		SourceLineID: idString(row.SourceLineID), SourceMessageID: idString(row.SourceMessageID), SourceLabel: row.SourceLabel,
		CreatedBy: row.CreatedBy, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}
