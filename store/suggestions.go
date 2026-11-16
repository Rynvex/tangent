package store

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// The suggestion inbox. A proposal locks the main line, so a dismissal (main
// line → suggestion) and a proposal of the same target never interleave; an
// accept that runs inside another write marks the suggestion after that
// write's own locks (MarkSuggestionAccepted).

// suggestionListCap bounds one inbox listing.
const suggestionListCap = 200

// ProposeInput is a suggestion a feature raises about a line. Cooldown 0
// means Limits.Suggestions.DismissCooldown; Permanent makes a dismissal
// final for this target.
type ProposeInput struct {
	Tenant    string
	LineID    string
	Feature   string
	Kind      string
	TargetKey string
	Payload   json.RawMessage
	Cooldown  time.Duration
	Permanent bool
	// Asked: the operator asked for this proposal, so an earlier dismissal
	// (cooldown or permanent) does not hold it back.
	Asked bool
}

// Proposal is the outcome of a proposal: Created is false when the target
// already has an open suggestion, was dismissed within the cooldown (or for
// good), or the conversation is archived.
type Proposal struct {
	Suggestion domain.Suggestion
	Created    bool
}

// ProposeSuggestion records an open suggestion unless one of the rules says
// not to raise it.
func (s *Store) ProposeSuggestion(ctx context.Context, in ProposeInput, hooks ...TxHook) (Proposal, error) {
	in, payload, err := s.checkProposal(in)
	if err != nil {
		return Proposal{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (Proposal, error) {
		line, err := s.lineRow(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return Proposal{}, err
		}
		root, err := lockRootOf(ctx, q, line.ID)
		if err != nil {
			return Proposal{}, err
		}
		if usable, err := s.lockProposalTarget(ctx, q, root.ID, line.ID); err != nil || !usable {
			return Proposal{}, err
		}
		if outside, err := namesLinesOutside(ctx, q, root.ID, payload); err != nil || outside {
			return Proposal{}, err // it names a line that left the tree (B11)
		}
		if blocked, err := s.proposalBlocked(ctx, q, root, in); err != nil || blocked {
			return Proposal{}, err
		}
		row, err := q.InsertSuggestion(ctx, db.InsertSuggestionParams{
			TenantID: in.Tenant, RootLineID: root.ID, LineID: line.ID, Feature: in.Feature, Kind: in.Kind, TargetKey: in.TargetKey, Payload: payload,
		})
		if noRows(err) {
			return Proposal{}, nil // one is open for this target already
		}
		if err != nil {
			return Proposal{}, fmt.Errorf("insert suggestion: %w", err)
		}
		return Proposal{Suggestion: suggestionFromRow(row), Created: true}, nil
	})
}

// lockProposalTarget locks the target line after its root and re-reads it
// under the lock: it must still belong to that root and, for a branch,
// still take turns (not ended, nothing above it ended). Holding the line's
// lock keeps a concurrent close (which locks it too) from ending the branch
// before this proposal commits, so the close's expiry sees the row.
func (s *Store) lockProposalTarget(ctx context.Context, q *db.Queries, rootID, lineID uuid.UUID) (bool, error) {
	if lineID == rootID {
		return true, nil // the root is locked already
	}
	target, err := lockLineByID(ctx, q, lineID)
	if err != nil {
		return false, err
	}
	nowRoot, err := rootOf(ctx, q, target.ID)
	if err != nil || nowRoot != rootID {
		return false, err
	}
	if _, _, err := s.requireWritable(ctx, q, target); err != nil {
		if domain.CodeOf(err) != "" {
			return false, nil // ended or archived: nothing to suggest about
		}
		return false, err
	}
	return true, nil
}

// checkProposal trims and checks a proposal before anything is read.
func (s *Store) checkProposal(in ProposeInput) (ProposeInput, json.RawMessage, error) {
	in.Feature, in.Kind, in.TargetKey = strings.TrimSpace(in.Feature), strings.TrimSpace(in.Kind), strings.TrimSpace(in.TargetKey)
	if in.Feature == "" || in.Kind == "" || in.TargetKey == "" {
		return in, nil, invalidInput("a suggestion needs a feature, a kind and a target")
	}
	payload, err := domain.SuggestionPayload(in.Payload, s.limits.Suggestions)
	if err != nil {
		return in, nil, invalidInput(err.Error())
	}
	if in.Cooldown <= 0 {
		in.Cooldown = s.limits.Suggestions.DismissCooldown
	}
	return in, payload, nil
}

// proposalBlocked: the conversation is archived, or the target was dismissed
// for good or within the cooldown.
func (s *Store) proposalBlocked(ctx context.Context, q *db.Queries, root db.TangentLine, in ProposeInput) (bool, error) {
	if root.ArchivedAt.Valid {
		return true, nil
	}
	if in.Asked {
		return false, nil
	}
	last, err := q.LastDismissal(ctx, db.LastDismissalParams{RootLineID: root.ID, Feature: in.Feature, Kind: in.Kind, TargetKey: in.TargetKey})
	if noRows(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read the last dismissal: %w", err)
	}
	return in.Permanent || s.now().Sub(last) < in.Cooldown, nil
}

// GetSuggestion reads one suggestion of the tenant.
func (s *Store) GetSuggestion(ctx context.Context, tenant, id string) (domain.Suggestion, error) {
	row, err := s.suggestionRow(ctx, s.q, tenant, id)
	if err != nil {
		return domain.Suggestion{}, err
	}
	return suggestionFromRow(row), nil
}

func (s *Store) suggestionRow(ctx context.Context, q *db.Queries, tenant, id string) (db.TangentSuggestion, error) {
	parsed, ok := parseID(id)
	if !ok {
		return db.TangentSuggestion{}, domain.ErrSuggestionGone
	}
	row, err := q.GetSuggestion(ctx, parsed)
	if err != nil {
		return db.TangentSuggestion{}, lookup(err, domain.ErrSuggestionGone, "get suggestion")
	}
	if row.TenantID != tenant {
		return db.TangentSuggestion{}, domain.ErrSuggestionGone
	}
	return row, nil
}

// SuggestionQuery lists a conversation's suggestions of some features;
// Statuses defaults to open.
type SuggestionQuery struct {
	Tenant   string
	LineID   string
	Features []string
	Statuses []string
}

// SuggestionList is a conversation's inbox, newest first (at most 200).
type SuggestionList struct {
	RootLineID  string
	Suggestions []domain.Suggestion
}

// ListSuggestions lists the suggestions of the line's conversation.
func (s *Store) ListSuggestions(ctx context.Context, in SuggestionQuery) (SuggestionList, error) {
	line, err := s.lineRow(ctx, s.q, in.Tenant, in.LineID)
	if err != nil {
		return SuggestionList{}, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return SuggestionList{}, err
	}
	statuses := in.Statuses
	if len(statuses) == 0 {
		statuses = []string{domain.SuggestionOpen}
	}
	rows, err := s.q.ListSuggestions(ctx, db.ListSuggestionsParams{
		RootLineID: root, Features: append([]string{}, in.Features...), Statuses: statuses, RowLimit: suggestionListCap,
	})
	if err != nil {
		return SuggestionList{}, fmt.Errorf("list suggestions: %w", err)
	}
	out := SuggestionList{RootLineID: root.String(), Suggestions: make([]domain.Suggestion, 0, len(rows))}
	for _, row := range rows {
		out.Suggestions = append(out.Suggestions, suggestionFromRow(row))
	}
	return out, nil
}

// DecideSuggestion accepts or dismisses an open suggestion under the locks
// main line → suggestion; the hooks run in the same transaction (a feature
// writes what accepting it does there).
func (s *Store) DecideSuggestion(ctx context.Context, tenant, id, status string, hooks ...TxHook) (domain.Suggestion, error) {
	if status != domain.SuggestionAccepted && status != domain.SuggestionDismissed {
		return domain.Suggestion{}, invalidInput("a suggestion is accepted or dismissed")
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.Suggestion, error) {
		peek, err := s.suggestionRow(ctx, q, tenant, id)
		if err != nil {
			return domain.Suggestion{}, err
		}
		if _, err := lockLineByID(ctx, q, peek.RootLineID); err != nil {
			return domain.Suggestion{}, err
		}
		return decide(ctx, q, peek.ID, status)
	})
}

// DismissOpenSuggestions dismisses, in one transaction under the main
// line's lock (the lock DecideSuggestion takes), every open suggestion of
// the line's conversation raised by in.Features; Statuses is ignored. The
// list is newest first, empty when nothing was open.
func (s *Store) DismissOpenSuggestions(ctx context.Context, in SuggestionQuery, hooks ...TxHook) (SuggestionList, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (SuggestionList, error) {
		line, err := s.lineRow(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return SuggestionList{}, err
		}
		locked, err := lockRootOf(ctx, q, line.ID)
		if err != nil {
			return SuggestionList{}, err
		}
		root := locked.ID
		rows, err := q.DismissOpenSuggestions(ctx, db.DismissOpenSuggestionsParams{RootLineID: root, Features: append([]string{}, in.Features...)})
		if err != nil {
			return SuggestionList{}, fmt.Errorf("dismiss open suggestions: %w", err)
		}
		out := SuggestionList{RootLineID: root.String(), Suggestions: make([]domain.Suggestion, 0, len(rows))}
		for _, row := range rows {
			out.Suggestions = append(out.Suggestions, suggestionFromRow(row))
		}
		sortNewestFirst(out.Suggestions)
		return out, nil
	})
}

// sortNewestFirst orders suggestions as ListSuggestions does: created_at
// descending, then id.
func sortNewestFirst(suggestions []domain.Suggestion) {
	slices.SortStableFunc(suggestions, func(a, b domain.Suggestion) int {
		if c := b.CreatedAt.Compare(a.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
}

// MarkSuggestionAccepted accepts an open suggestion inside another write's
// transaction (a TxHook), after that write's own locks; ErrSuggestionNotOpen
// rolls the write back.
func MarkSuggestionAccepted(ctx context.Context, tx Tx, id string) (domain.Suggestion, error) {
	parsed, ok := parseID(id)
	if !ok {
		return domain.Suggestion{}, domain.ErrSuggestionGone
	}
	return decide(ctx, db.New(tx), parsed, domain.SuggestionAccepted)
}

func decide(ctx context.Context, q *db.Queries, id uuid.UUID, status string) (domain.Suggestion, error) {
	row, err := q.DecideSuggestion(ctx, db.DecideSuggestionParams{ID: id, Status: status})
	if err != nil {
		return domain.Suggestion{}, lookup(err, domain.ErrSuggestionNotOpen, "decide suggestion")
	}
	return suggestionFromRow(row), nil
}

// LinesEndedWith lists the lines a branch's ending takes out of use: the
// branch and, withSubtree, every line below it (a promotion lifts those to
// the main line instead).
func (s *Store) LinesEndedWith(ctx context.Context, tx Tx, lineID string, withSubtree bool) ([]string, error) {
	id, ok := parseID(lineID)
	if !ok {
		return nil, domain.ErrLineNotFound
	}
	if !withSubtree {
		return []string{id.String()}, nil
	}
	below, err := s.subtreeIDs(ctx, db.New(tx), id)
	if err != nil {
		return nil, err
	}
	return idStrings(append([]uuid.UUID{id}, below...)), nil
}

// ExpireSuggestions expires, inside a write's transaction, the open
// suggestions about the given lines.
func ExpireSuggestions(ctx context.Context, tx Tx, lineIDs []string) ([]domain.Suggestion, error) {
	ids := make([]uuid.UUID, 0, len(lineIDs))
	for _, id := range lineIDs {
		if parsed, ok := parseID(id); ok {
			ids = append(ids, parsed)
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := db.New(tx).ExpireSuggestionsForLines(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("expire suggestions: %w", err)
	}
	out := make([]domain.Suggestion, 0, len(rows))
	for _, row := range rows {
		out = append(out, suggestionFromRow(row))
	}
	return out, nil
}

// TenantSuggestion is a suggestion with its tenant (sweeps cross tenants).
type TenantSuggestion struct {
	Tenant     string
	Suggestion domain.Suggestion
}

// ExpireSuggestionsOfEndedBranches expires open suggestions about branches
// that have ended (missed while the inbox was off for their tenant), at most
// 200 per call.
func (s *Store) ExpireSuggestionsOfEndedBranches(ctx context.Context) ([]TenantSuggestion, error) {
	rows, err := s.q.ExpireSuggestionsOfEndedBranches(ctx, sweepBatch)
	if err != nil {
		return nil, fmt.Errorf("expire suggestions of ended branches: %w", err)
	}
	out := make([]TenantSuggestion, 0, len(rows))
	for _, row := range rows {
		out = append(out, TenantSuggestion{Tenant: row.TenantID, Suggestion: suggestionFromRow(row)})
	}
	return out, nil
}

func suggestionFromRow(row db.TangentSuggestion) domain.Suggestion {
	return domain.Suggestion{
		ID: row.ID.String(), RootLineID: row.RootLineID.String(), LineID: row.LineID.String(), Feature: row.Feature, Kind: row.Kind,
		TargetKey: row.TargetKey, Payload: hostMeta(row.Payload), Status: row.Status, CreatedAt: row.CreatedAt.UTC(), DecidedAt: timePtr(row.DecidedAt),
	}
}

// ExpireSuggestionsOfKind expires, inside a write's transaction (a TxHook
// that holds the conversation's main line), the open suggestions of one
// feature and kind in the conversation.
func ExpireSuggestionsOfKind(ctx context.Context, tx Tx, rootLineID, feature, kind string) ([]domain.Suggestion, error) {
	root, ok := parseID(rootLineID)
	if !ok {
		return nil, nil
	}
	rows, err := db.New(tx).ExpireOpenSuggestionsOfKind(ctx, db.ExpireOpenSuggestionsOfKindParams{RootLineID: root, Feature: feature, Kind: kind})
	if err != nil {
		return nil, fmt.Errorf("expire suggestions: %w", err)
	}
	out := make([]domain.Suggestion, 0, len(rows))
	for _, row := range rows {
		out = append(out, suggestionFromRow(row))
	}
	return out, nil
}
