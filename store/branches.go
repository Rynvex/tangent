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

// OutlineCap bounds the rows of one outline (ListBranches).
const OutlineCap = 500

const outlineCap = OutlineCap

// CreateBranchInput opens a branch on a message of its parent. The pack is
// built by the caller from the parent's messages (MessagesUpToAnchor).
// Provider and Model default to the parent's; Origin defaults to button.
type CreateBranchInput struct {
	Tenant          string
	ParentLineID    string
	AnchorMessageID string
	Purpose         string
	Excerpt         string
	Kind            string
	Origin          string
	Provider        string
	Model           string
	CreatedBy       string
	// ConfirmDeeper accepts a depth beyond the soft limit.
	ConfirmDeeper bool
	Pack          domain.BranchPack
	HostMeta      json.RawMessage
	// Keep keeps a new aside from the purge from the start (B23); any other
	// kind refuses it.
	Keep bool
}

// CreatedBranch is the new branch line and its outline row.
type CreatedBranch struct {
	Line   domain.LineView
	Branch domain.BranchView
}

// lockedParent is a would-be parent locked after its root.
type lockedParent struct {
	line      db.TangentLine
	branch    db.TangentBranch
	hasBranch bool
	rootID    uuid.UUID
}

// CreateBranch opens a branch in one transaction: root then parent are
// locked, the limits checked against the counts under the lock, the anchor
// checked, and the branch line and row inserted.
func (s *Store) CreateBranch(ctx context.Context, in CreateBranchInput, hooks ...TxHook) (CreatedBranch, error) {
	in, err := s.normalizeBranchInput(in, false)
	if err != nil {
		return CreatedBranch{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (CreatedBranch, error) {
		parent, err := s.lockParent(ctx, q, in.Tenant, in.ParentLineID)
		if err != nil {
			return CreatedBranch{}, err
		}
		return s.createInParent(ctx, q, parent, in)
	})
}

// createInParent opens a branch under a parent already locked after its
// root: the limits against the counts under the lock, the anchor, then the
// branch line and row.
func (s *Store) createInParent(ctx context.Context, q *db.Queries, parent lockedParent, in CreateBranchInput) (CreatedBranch, error) {
	depth, err := s.checkBranchLimits(ctx, q, parent, in.ConfirmDeeper)
	if err != nil {
		return CreatedBranch{}, err
	}
	anchor, err := requireAnchor(ctx, q, parent.line, in.AnchorMessageID)
	if err != nil {
		return CreatedBranch{}, err
	}
	created, err := s.insertBranch(ctx, q, parent, anchor, depth, in)
	if err != nil {
		return CreatedBranch{}, err
	}
	return s.createdBranch(ctx, q, created)
}

// createdBranch reads the new branch line and its outline row in the
// transaction that created them.
func (s *Store) createdBranch(ctx context.Context, q *db.Queries, row db.TangentLine) (CreatedBranch, error) {
	line, err := s.hydrateOne(ctx, q, row)
	if err != nil {
		return CreatedBranch{}, err
	}
	view, err := s.branchViewOf(ctx, q, row.TenantID, row.ID)
	if err != nil {
		return CreatedBranch{}, err
	}
	return CreatedBranch{Line: line, Branch: view}, nil
}

// normalizeBranchInput trims and validates the request; a move may use the
// move origin, nothing else may.
func (s *Store) normalizeBranchInput(in CreateBranchInput, move bool) (CreateBranchInput, error) {
	purpose, ok := domain.NormalizeBranchPurpose(in.Purpose, s.limits.Branch)
	if !ok {
		return in, domain.ErrInvalidPurpose
	}
	excerpt, ok := domain.NormalizeBranchExcerpt(in.Excerpt, s.limits.Branch)
	if !ok {
		return in, domain.ErrInvalidExcerpt
	}
	if !domain.ValidBranchKind(in.Kind) {
		return in, domain.ErrKindUnsupported
	}
	if in.Keep && in.Kind != domain.BranchKindAside {
		return in, domain.ErrKeepNeedsAside
	}
	in.Purpose, in.Excerpt = purpose, excerpt
	switch {
	case move:
		in.Origin, in.Excerpt = domain.BranchOriginMove, ""
	case strings.TrimSpace(in.Origin) == "":
		in.Origin = domain.BranchOriginButton
	case in.Origin == domain.BranchOriginMove || in.Origin == domain.BranchOriginPreviousMainLine || in.Origin == domain.BranchOriginSeed || in.Origin == domain.BranchOriginImport ||
		!domain.ValidBranchOrigin(in.Origin):
		return in, invalidInput("origin must be selection, button or suggestion")
	}
	return in, nil
}

// lockParent resolves the parent, locks the root of its tree and then the
// parent, and re-reads the parent's branch row under the lock.
func (s *Store) lockParent(ctx context.Context, q *db.Queries, tenant, parentID string) (lockedParent, error) {
	peek, err := s.lineRow(ctx, q, tenant, parentID)
	if err != nil {
		return lockedParent{}, err
	}
	rootID, err := rootOf(ctx, q, peek.ID)
	if err != nil {
		return lockedParent{}, err
	}
	if rootID != peek.ID {
		if _, err := lockLineByID(ctx, q, rootID); err != nil {
			return lockedParent{}, err
		}
	}
	out := lockedParent{rootID: rootID}
	if out.line, err = lockLineByID(ctx, q, peek.ID); err != nil {
		return lockedParent{}, err
	}
	if out.branch, out.hasBranch, err = branchRowFor(ctx, q, peek.ID); err != nil {
		return lockedParent{}, err
	}
	// B20: a detach or an attach may have moved the parent to another tree
	// between the peek and the locks; the root locked is then the wrong one.
	if (out.hasBranch && out.branch.RootLineID != rootID) || (!out.hasBranch && peek.ID != rootID) {
		return lockedParent{}, errBranchMoved
	}
	return out, nil
}

// checkBranchLimits returns the new branch's depth under the parent.
func (s *Store) checkBranchLimits(ctx context.Context, q *db.Queries, parent lockedParent, confirmDeeper bool) (int, error) {
	return s.checkBranchLimitsReplacing(ctx, q, parent, confirmDeeper, 0)
}

// checkBranchLimitsReplacing is checkBranchLimits for a branch that takes
// the place of replaced ended branches of the tree (B23: a continued aside
// goes when its branch comes), which do not count against the tree's limit.
func (s *Store) checkBranchLimitsReplacing(ctx context.Context, q *db.Queries, parent lockedParent, confirmDeeper bool, replaced int) (int, error) {
	open, err := q.CountOpenBranchesForParent(ctx, parent.line.ID)
	if err != nil {
		return 0, fmt.Errorf("count open branches: %w", err)
	}
	total, err := q.CountBranchesForRoot(ctx, parent.rootID)
	if err != nil {
		return 0, fmt.Errorf("count tree branches: %w", err)
	}
	return domain.CheckBranchCreate(domain.BranchCreateCheck{
		ParentArchived: parent.line.ArchivedAt.Valid, ParentIsBranch: parent.hasBranch,
		ParentStatus: parent.branch.Status, ParentDepth: int(parent.branch.Depth),
		OpenUnderParent: int(open), TreeTotal: int(total) - replaced, ConfirmDeeper: confirmDeeper,
	}, s.limits.Branch)
}

// requireAnchor checks the anchor is a finished operator or assistant
// message of the parent, or a conclusion card on it (domain.CanAnchorBranch).
func requireAnchor(ctx context.Context, q *db.Queries, parent db.TangentLine, anchorID string) (db.TangentMessage, error) {
	message, err := messageOn(ctx, q, parent.ID, anchorID)
	if errors.Is(err, domain.ErrMessageNotFound) {
		return db.TangentMessage{}, domain.ErrBranchAnchorNotFound
	}
	if err != nil {
		return db.TangentMessage{}, err
	}
	if !domain.CanAnchorBranch(message.Role, message.Kind, message.Status) {
		return db.TangentMessage{}, domain.ErrBranchAnchorNotFound
	}
	return message, nil
}

// insertBranch creates the branch line (titled by its purpose, provider and
// model inherited unless given) and its branch row.
func (s *Store) insertBranch(ctx context.Context, q *db.Queries, parent lockedParent, anchor db.TangentMessage, depth int, in CreateBranchInput) (db.TangentLine, error) {
	return s.insertBranchAs(ctx, q, parent, anchor, depth, in, uuid.New())
}

// insertBranchAs is insertBranch with the branch line's id chosen by the
// caller (an import writes the card that names it first, B19).
func (s *Store) insertBranchAs(ctx context.Context, q *db.Queries, parent lockedParent, anchor db.TangentMessage, depth int, in CreateBranchInput, id uuid.UUID) (db.TangentLine, error) {
	provider, model := strings.TrimSpace(in.Provider), strings.TrimSpace(in.Model)
	if provider == "" {
		provider = parent.line.Provider
	}
	if model == "" {
		model = parent.line.Model
	}
	meta, err := jsonObject(in.HostMeta, "hostMeta")
	if err != nil {
		return db.TangentLine{}, err
	}
	created, err := q.InsertLine(ctx, db.InsertLineParams{
		ID: id, TenantID: parent.line.TenantID, Title: in.Purpose, Provider: provider, Model: model,
		HostMeta: meta, CreatedBy: strings.TrimSpace(in.CreatedBy), Tags: noTags(),
	})
	if err != nil {
		return db.TangentLine{}, fmt.Errorf("insert branch line: %w", err)
	}
	pack, err := json.Marshal(in.Pack)
	if err != nil {
		return db.TangentLine{}, fmt.Errorf("marshal branch pack: %w", err)
	}
	if _, err := q.InsertBranch(ctx, db.InsertBranchParams{
		LineID: created.ID, TenantID: created.TenantID, ParentLineID: parent.line.ID, RootLineID: parent.rootID,
		AnchorMessageID: anchor.ID, Excerpt: in.Excerpt, Purpose: in.Purpose, Kind: in.Kind, Depth: int32(depth),
		Origin: in.Origin, Pack: pack, CreatedBy: strings.TrimSpace(in.CreatedBy),
	}); err != nil {
		return db.TangentLine{}, fmt.Errorf("insert branch: %w", err)
	}
	if in.Keep {
		if _, err := q.SetBranchKept(ctx, db.SetBranchKeptParams{LineID: created.ID, Keep: true}); err != nil {
			return db.TangentLine{}, fmt.Errorf("keep the new branch: %w", err)
		}
	}
	return created, nil
}

// GetBranch reads one branch: its outline row, the stored pack, the draft and
// the parent's newest relevant message (the tip a merge must name).
func (s *Store) GetBranch(ctx context.Context, tenant, lineID string) (domain.BranchDetail, error) {
	id, ok := parseID(lineID)
	if !ok {
		return domain.BranchDetail{}, domain.ErrBranchNotFound
	}
	row, err := s.q.GetBranchView(ctx, db.GetBranchViewParams{LineID: id, TenantID: tenant})
	if err != nil {
		return domain.BranchDetail{}, lookup(err, domain.ErrBranchNotFound, "get branch")
	}
	tip, err := latestRelevant(ctx, s.q, row.TangentBranch.ParentLineID)
	if err != nil {
		return domain.BranchDetail{}, err
	}
	draft, err := s.draftFromRow(row.TangentBranch)
	if err != nil {
		return domain.BranchDetail{}, err
	}
	return domain.BranchDetail{
		Branch: s.branchViewFromViewRow(row), Pack: packFromJSON(row.TangentBranch.Pack), Draft: draft, ParentTipMessageID: tip,
	}, nil
}

// branchViewOf reads one outline row.
func (s *Store) branchViewOf(ctx context.Context, q *db.Queries, tenant string, lineID uuid.UUID) (domain.BranchView, error) {
	row, err := q.GetBranchView(ctx, db.GetBranchViewParams{LineID: lineID, TenantID: tenant})
	if err != nil {
		return domain.BranchView{}, lookup(err, domain.ErrBranchNotFound, "get branch")
	}
	return s.branchViewFromViewRow(row), nil
}

// ListBranches returns the whole tree of the line's conversation as a flat
// adjacency list, oldest first, at most 500 rows; asides only when asked.
func (s *Store) ListBranches(ctx context.Context, tenant, lineID string, includeAside bool) ([]domain.BranchView, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return nil, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListBranchViewsByRoot(ctx, db.ListBranchViewsByRootParams{
		RootLineID: root, TenantID: tenant, IncludeAside: includeAside, RowLimit: outlineCap,
	})
	if err != nil {
		return nil, fmt.Errorf("list branches: %w", err)
	}
	out := make([]domain.BranchView, 0, len(rows))
	for _, row := range rows {
		out = append(out, s.branchViewFromViewRow(db.GetBranchViewRow(row)))
	}
	return out, nil
}

// BranchSubtree returns the branch line and every line below it, the branch
// first.
func (s *Store) BranchSubtree(ctx context.Context, tenant, lineID string) ([]domain.LineView, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return nil, err
	}
	below, err := s.subtreeIDs(ctx, s.q, line.ID)
	if err != nil {
		return nil, err
	}
	return s.hydrateIDs(ctx, s.q, append([]uuid.UUID{line.ID}, below...))
}

// BranchLineEnded reports whether a line is a branch that has ended, or hangs
// below a branch that ended or a line that was archived. Such a line takes no
// more turns. A main line is never "ended" here.
func (s *Store) BranchLineEnded(ctx context.Context, lineID string) (bool, error) {
	id, ok := parseID(lineID)
	if !ok {
		return false, domain.ErrLineNotFound
	}
	for level := 0; level <= s.limits.Branch.HardMaxDepth+1; level++ {
		row, isBranch, err := branchRowFor(ctx, s.q, id)
		if err != nil || !isBranch {
			return false, err
		}
		if row.Status != domain.BranchStatusOpen {
			return true, nil
		}
		parent, err := s.q.GetLine(ctx, row.ParentLineID)
		if err != nil {
			return false, lookup(err, domain.ErrLineNotFound, "load the parent of a branch")
		}
		if parent.ArchivedAt.Valid {
			return true, nil
		}
		id = row.ParentLineID
	}
	return false, nil
}

// BranchViews reads the outline rows of many branches of the tenant in one
// query, in the order of lineIDs; ids that name no branch of the tenant are
// skipped.
func (s *Store) BranchViews(ctx context.Context, tenant string, lineIDs []string) ([]domain.BranchView, error) {
	ids := make([]uuid.UUID, 0, len(lineIDs))
	for _, id := range lineIDs {
		if parsed, ok := parseID(id); ok {
			ids = append(ids, parsed)
		}
	}
	out := []domain.BranchView{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.q.ListBranchViewsByLineIDs(ctx, db.ListBranchViewsByLineIDsParams{LineIds: ids, TenantID: tenant})
	if err != nil {
		return nil, fmt.Errorf("list branch views: %w", err)
	}
	byID := make(map[uuid.UUID]domain.BranchView, len(rows))
	for _, row := range rows {
		byID[row.TangentBranch.LineID] = s.branchViewFromViewRow(db.GetBranchViewRow(row))
	}
	for _, id := range ids {
		if view, ok := byID[id]; ok {
			out = append(out, view)
		}
	}
	return out, nil
}
