package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Open loops: what a conversation (or a whole tenant) left unfinished.
// Read-only; archived conversations are left out. Each kind lists at most
// Limits.OpenLoops.MaxPerKind items with the exact total.

// OpenLoopsQuery asks for the open loops of a tenant, or of the
// conversation of LineID. IdleBefore: an open branch whose line has been
// idle since before it is stale. Notes, Seeds and SuggestionFeatures (the
// features whose open suggestions count; none: no suggestions) choose the
// kinds besides stale branches.
type OpenLoopsQuery struct {
	Tenant             string
	LineID             string
	IdleBefore         time.Time
	Notes              bool
	Seeds              bool
	SuggestionFeatures []string
}

// OpenLoopGroup is one kind of open loop: the newest (stale branches: the
// idlest) items and how many there are in all.
type OpenLoopGroup[T any] struct {
	Items []T `json:"items"`
	Total int `json:"total"`
}

// OpenBranch is an open branch idle too long, with its conversation's title.
type OpenBranch struct {
	domain.BranchView
	RootTitle string `json:"rootTitle"`
}

// OpenNote is a note to confirm, with its conversation.
type OpenNote struct {
	domain.Note
	RootLineID string `json:"rootLineId"`
	RootTitle  string `json:"rootTitle"`
}

// OpenSeed is an open parked thought, with its conversation's title.
type OpenSeed struct {
	domain.Seed
	RootTitle string `json:"rootTitle"`
}

// OpenSuggestion is an open suggestion, with its conversation's title.
type OpenSuggestion struct {
	domain.Suggestion
	RootTitle string `json:"rootTitle"`
}

// OpenLoops is the listing. RootLineID is the conversation asked for (""
// for the whole tenant); a kind that was not asked for is nil.
type OpenLoops struct {
	RootLineID    string                         `json:"rootLineId"`
	StaleBranches OpenLoopGroup[OpenBranch]      `json:"staleBranches"`
	ToConfirm     *OpenLoopGroup[OpenNote]       `json:"toConfirm,omitempty"`
	Seeds         *OpenLoopGroup[OpenSeed]       `json:"seeds,omitempty"`
	Suggestions   *OpenLoopGroup[OpenSuggestion] `json:"suggestions,omitempty"`
}

// openLoopScope is the tenant and, for one conversation, its main line.
type openLoopScope struct {
	tenant  string
	oneRoot bool
	root    uuid.UUID
	limit   int32
}

// OpenLoops lists the open loops asked for.
func (s *Store) OpenLoops(ctx context.Context, in OpenLoopsQuery) (OpenLoops, error) {
	scope := openLoopScope{tenant: in.Tenant, limit: int32(s.limits.OpenLoops.MaxPerKind)}
	out := OpenLoops{}
	if strings.TrimSpace(in.LineID) != "" {
		line, err := s.lineRow(ctx, s.q, in.Tenant, in.LineID)
		if err != nil {
			return OpenLoops{}, err
		}
		if scope.root, err = rootOf(ctx, s.q, line.ID); err != nil {
			return OpenLoops{}, err
		}
		scope.oneRoot, out.RootLineID = true, scope.root.String()
	}
	var err error
	if out.StaleBranches, err = s.staleBranches(ctx, scope, in.IdleBefore); err != nil {
		return OpenLoops{}, err
	}
	if in.Notes {
		if out.ToConfirm, err = s.notesToConfirm(ctx, scope); err != nil {
			return OpenLoops{}, err
		}
	}
	if in.Seeds {
		if out.Seeds, err = s.openSeeds(ctx, scope); err != nil {
			return OpenLoops{}, err
		}
	}
	if len(in.SuggestionFeatures) > 0 {
		out.Suggestions, err = s.openSuggestions(ctx, scope, in.SuggestionFeatures)
	}
	return out, err
}

func (s *Store) staleBranches(ctx context.Context, scope openLoopScope, idleBefore time.Time) (OpenLoopGroup[OpenBranch], error) {
	group := OpenLoopGroup[OpenBranch]{Items: []OpenBranch{}}
	rows, err := s.q.ListStaleBranches(ctx, db.ListStaleBranchesParams{
		TenantID: scope.tenant, IdleBefore: idleBefore, OneRoot: scope.oneRoot, RootLineID: scope.root, RowLimit: scope.limit,
	})
	if err != nil || len(rows) == 0 {
		return group, wrapList(err, "list stale branches")
	}
	ids := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.LineID)
	}
	views, err := s.q.ListBranchViewsByLineIDs(ctx, db.ListBranchViewsByLineIDsParams{LineIds: ids, TenantID: scope.tenant})
	if err != nil {
		return group, fmt.Errorf("read stale branches: %w", err)
	}
	byID := make(map[uuid.UUID]domain.BranchView, len(views))
	for _, view := range views {
		byID[view.TangentBranch.LineID] = s.branchViewFromViewRow(db.GetBranchViewRow(view))
	}
	for _, row := range rows {
		if view, ok := byID[row.LineID]; ok {
			group.Items = append(group.Items, OpenBranch{BranchView: view, RootTitle: row.RootTitle})
		}
	}
	group.Total = int(rows[0].Total)
	return group, nil
}

func (s *Store) notesToConfirm(ctx context.Context, scope openLoopScope) (*OpenLoopGroup[OpenNote], error) {
	group := &OpenLoopGroup[OpenNote]{Items: []OpenNote{}}
	rows, err := s.q.ListNotesToConfirm(ctx, db.ListNotesToConfirmParams{
		TenantID: scope.tenant, OneRoot: scope.oneRoot, RootLineID: scope.root, RowLimit: scope.limit,
	})
	if err != nil || len(rows) == 0 {
		return group, wrapList(err, "list notes to confirm")
	}
	for _, row := range rows {
		group.Items = append(group.Items, OpenNote{Note: noteFromRow(row.TangentNote), RootLineID: row.TangentNote.RootLineID.String(), RootTitle: row.RootTitle})
	}
	group.Total = int(rows[0].Total)
	return group, nil
}

func (s *Store) openSeeds(ctx context.Context, scope openLoopScope) (*OpenLoopGroup[OpenSeed], error) {
	group := &OpenLoopGroup[OpenSeed]{Items: []OpenSeed{}}
	rows, err := s.q.ListOpenSeedsOfTenant(ctx, db.ListOpenSeedsOfTenantParams{
		TenantID: scope.tenant, OneRoot: scope.oneRoot, RootLineID: scope.root, RowLimit: scope.limit,
	})
	if err != nil || len(rows) == 0 {
		return group, wrapList(err, "list open seeds")
	}
	seeds := make([]db.TangentSeed, 0, len(rows))
	for _, row := range rows {
		seeds = append(seeds, row.TangentSeed)
	}
	views, err := seedViews(ctx, s.q, seeds)
	if err != nil {
		return nil, err
	}
	for i, view := range views {
		group.Items = append(group.Items, OpenSeed{Seed: view, RootTitle: rows[i].RootTitle})
	}
	group.Total = int(rows[0].Total)
	return group, nil
}

func (s *Store) openSuggestions(ctx context.Context, scope openLoopScope, features []string) (*OpenLoopGroup[OpenSuggestion], error) {
	group := &OpenLoopGroup[OpenSuggestion]{Items: []OpenSuggestion{}}
	rows, err := s.q.ListOpenSuggestionsOfTenant(ctx, db.ListOpenSuggestionsOfTenantParams{
		TenantID: scope.tenant, Features: features, OneRoot: scope.oneRoot, RootLineID: scope.root, RowLimit: scope.limit,
	})
	if err != nil || len(rows) == 0 {
		return group, wrapList(err, "list open suggestions")
	}
	for _, row := range rows {
		group.Items = append(group.Items, OpenSuggestion{Suggestion: suggestionFromRow(row.TangentSuggestion), RootTitle: row.RootTitle})
	}
	group.Total = int(rows[0].Total)
	return group, nil
}

// wrapList wraps a listing's failure (nil stays nil).
func wrapList(err error, what string) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", what, err)
}
