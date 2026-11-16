package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Groups belong to their tree's main line: every write locks it first, then
// the group row (and, finishing a summary, the job), so the per-tree cap and
// "a branch is in one active group" hold under concurrent writers.

// JobKindGroupSummary is the group feature's summary job (its input names
// the group).
const JobKindGroupSummary = "group_summary"

// groupListCap bounds one listing.
const groupListCap = 200

// CreateGroupInput circles ended branches of the line's tree. Settled are
// claims adopted when the group came from a suggestion; Notes are written in
// the same transaction (a keepBoth's to-confirm notes).
type CreateGroupInput struct {
	Tenant        string
	LineID        string
	MemberLineIDs []string
	Title         string
	Settled       []string
	Notes         []domain.NoteChange
	Actor         string
}

// GroupWrite is a new group and the notes written with it.
type GroupWrite struct {
	Group domain.Group
	Notes NotesWrite
}

// CreateGroup records a group. Refusals (invalid_group): fewer than two or
// more than MaxMembers members, a member that is not an ended branch of the
// tree with a leaf or a card's conclusion, a member already in an active
// group; group_limit at the cap; archived.
func (s *Store) CreateGroup(ctx context.Context, in CreateGroupInput, hooks ...TxHook) (GroupWrite, error) {
	title, err := domain.NormalizeGroupTitle(in.Title, s.limits.Group)
	if err != nil {
		return GroupWrite{}, err
	}
	members, err := s.groupMemberIDs(in.MemberLineIDs)
	if err != nil {
		return GroupWrite{}, err
	}
	notes, err := s.normaliseNotes(in.Notes)
	if err != nil {
		return GroupWrite{}, err
	}
	settled, _ := json.Marshal(append([]string{}, in.Settled...))
	return runTx(ctx, s, hooks, func(q *db.Queries) (GroupWrite, error) {
		root, err := s.lockOpenRoot(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return GroupWrite{}, err
		}
		if err := s.checkGroupMembers(ctx, q, root, members); err != nil {
			return GroupWrite{}, err
		}
		row, err := q.InsertGroup(ctx, db.InsertGroupParams{TenantID: root.TenantID, RootLineID: root.ID, Title: title, Settled: settled, CreatedBy: strings.TrimSpace(in.Actor)})
		if err != nil {
			return GroupWrite{}, fmt.Errorf("insert group: %w", err)
		}
		for _, member := range members {
			if err := q.InsertGroupMember(ctx, db.InsertGroupMemberParams{GroupID: row.ID, LineID: member}); err != nil {
				return GroupWrite{}, fmt.Errorf("insert group member: %w", err)
			}
		}
		out := GroupWrite{Notes: NotesWrite{RootLineID: root.ID.String(), Created: []domain.Note{}, Superseded: []domain.Note{}}}
		if len(notes) > 0 {
			if out.Notes, err = s.applyNoteChanges(ctx, q, root, notes, noteWriteContext{actor: in.Actor}); err != nil {
				return GroupWrite{}, err
			}
		}
		out.Group, err = groupView(ctx, q, row)
		return out, err
	})
}

// groupMemberIDs parses and de-duplicates the members and checks their count.
func (s *Store) groupMemberIDs(ids []string) ([]uuid.UUID, error) {
	out, seen := []uuid.UUID{}, map[uuid.UUID]bool{}
	for _, raw := range ids {
		id, ok := parseID(raw)
		if !ok {
			return nil, domain.InvalidGroup("every member is a branch of this conversation")
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	if len(out) < 2 || len(out) > s.limits.Group.MaxMembers {
		return nil, domain.InvalidGroup(fmt.Sprintf("a group has 2 to %d branches", s.limits.Group.MaxMembers))
	}
	return out, nil
}

// checkGroupMembers checks the members under the root's lock.
func (s *Store) checkGroupMembers(ctx context.Context, q *db.Queries, root db.TangentLine, members []uuid.UUID) error {
	for _, id := range members {
		row, isBranch, err := branchRowFor(ctx, q, id)
		if err != nil {
			return err
		}
		switch {
		case !isBranch || row.RootLineID != root.ID:
			return domain.InvalidGroup("every member is a branch of this conversation")
		case row.Status == domain.BranchStatusOpen:
			return domain.InvalidGroup("only ended branches are grouped (combine open ones)")
		case row.Status == domain.BranchStatusPromoted:
			return domain.InvalidGroup("a promoted branch is the main line now; it is not grouped")
		}
		if ok, err := hasConclusion(ctx, q, row); err != nil || !ok {
			return firstErr(err, domain.InvalidGroup("every member needs a leaf or a card's conclusion"))
		}
	}
	taken, err := q.ActiveGroupLines(ctx, members)
	if err != nil {
		return fmt.Errorf("find grouped branches: %w", err)
	}
	if len(taken) > 0 {
		return domain.InvalidGroup("a branch is in one active group at a time")
	}
	count, err := q.CountActiveGroups(ctx, root.ID)
	if err != nil {
		return fmt.Errorf("count groups: %w", err)
	}
	if int(count) >= s.limits.Group.MaxActivePerTree {
		return domain.ErrGroupLimit
	}
	return nil
}

// hasConclusion reports whether a branch has a leaf or a card's conclusion.
func hasConclusion(ctx context.Context, q *db.Queries, row db.TangentBranch) (bool, error) {
	if strings.TrimSpace(row.ConclusionLine) != "" {
		return true, nil
	}
	_, err := q.GetLeaf(ctx, row.LineID)
	if noRows(err) {
		return false, nil
	}
	return err == nil, err
}

func firstErr(err, otherwise error) error {
	if err != nil {
		return err
	}
	return otherwise
}

// GetGroup reads a group of the tenant.
func (s *Store) GetGroup(ctx context.Context, tenant, groupID string) (domain.Group, error) {
	row, err := s.groupOfTenant(ctx, s.q, tenant, groupID, false)
	if err != nil {
		return domain.Group{}, err
	}
	return groupView(ctx, s.q, row)
}

func (s *Store) groupOfTenant(ctx context.Context, q *db.Queries, tenant, groupID string, forUpdate bool) (db.TangentGroup, error) {
	id, ok := parseID(groupID)
	if !ok {
		return db.TangentGroup{}, domain.ErrGroupNotFound
	}
	get := q.GetGroup
	if forUpdate {
		get = q.GetGroupForUpdate
	}
	row, err := get(ctx, id)
	if err != nil {
		return db.TangentGroup{}, lookup(err, domain.ErrGroupNotFound, "get group")
	}
	if row.TenantID != tenant {
		return db.TangentGroup{}, domain.ErrGroupNotFound
	}
	return row, nil
}

// GroupList is a tree's groups.
type GroupList struct {
	RootLineID string
	Groups     []domain.Group
}

// ListGroups lists the groups of the line's tree, newest first; statuses
// default to active.
func (s *Store) ListGroups(ctx context.Context, tenant, lineID string, statuses []string) (GroupList, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return GroupList{}, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return GroupList{}, err
	}
	if len(statuses) == 0 {
		statuses = []string{domain.GroupActive}
	}
	rows, err := s.q.ListGroupsOfRoot(ctx, db.ListGroupsOfRootParams{RootLineID: root, Statuses: statuses, RowLimit: groupListCap})
	if err != nil {
		return GroupList{}, fmt.Errorf("list groups: %w", err)
	}
	groups, err := groupViews(ctx, s.q, rows)
	return GroupList{RootLineID: root.String(), Groups: groups}, err
}

// ReadyGroups are a tree's active groups whose summary is ready (what the
// fisheye shows in place of their members).
func (s *Store) ReadyGroups(ctx context.Context, rootLineID string) ([]domain.Group, error) {
	root, ok := parseID(rootLineID)
	if !ok {
		return nil, domain.ErrLineNotFound
	}
	rows, err := s.q.ListGroupsOfRoot(ctx, db.ListGroupsOfRootParams{RootLineID: root, Statuses: []string{domain.GroupActive}, RowLimit: groupListCap})
	if err != nil {
		return nil, fmt.Errorf("list groups: %w", err)
	}
	ready := rows[:0:0]
	for _, row := range rows {
		if row.SummaryStatus == domain.GroupSummaryReady {
			ready = append(ready, row)
		}
	}
	return groupViews(ctx, s.q, ready)
}

// RenameGroup changes an active group's title.
func (s *Store) RenameGroup(ctx context.Context, tenant, groupID, title string, hooks ...TxHook) (domain.Group, error) {
	title, err := domain.NormalizeGroupTitle(title, s.limits.Group)
	if err != nil {
		return domain.Group{}, err
	}
	return s.groupWrite(ctx, tenant, groupID, hooks, func(q *db.Queries, row db.TangentGroup) (db.TangentGroup, error) {
		return q.RenameGroup(ctx, db.RenameGroupParams{ID: row.ID, Title: title})
	})
}

// DissolveGroup ends an active group (its members are free again).
func (s *Store) DissolveGroup(ctx context.Context, tenant, groupID string, hooks ...TxHook) (domain.Group, error) {
	return s.groupWrite(ctx, tenant, groupID, hooks, func(q *db.Queries, row db.TangentGroup) (db.TangentGroup, error) {
		return q.DissolveGroup(ctx, row.ID)
	})
}

// groupWrite runs a write on an active group under the locks main line →
// group.
func (s *Store) groupWrite(ctx context.Context, tenant, groupID string, hooks []TxHook, write func(*db.Queries, db.TangentGroup) (db.TangentGroup, error)) (domain.Group, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.Group, error) {
		row, err := s.lockActiveGroup(ctx, q, tenant, groupID)
		if err != nil {
			return domain.Group{}, err
		}
		updated, err := write(q, row)
		if err != nil {
			return domain.Group{}, fmt.Errorf("write group: %w", err)
		}
		return groupView(ctx, q, updated)
	})
}

// lockActiveGroup locks the group's main line (refusing an archived one),
// then the group, which must be active and still on that main line.
func (s *Store) lockActiveGroup(ctx context.Context, q *db.Queries, tenant, groupID string) (db.TangentGroup, error) {
	peek, err := s.groupOfTenant(ctx, q, tenant, groupID, false)
	if err != nil {
		return db.TangentGroup{}, err
	}
	root, err := lockOpenRootOf(ctx, q, peek.RootLineID)
	if err != nil {
		return db.TangentGroup{}, err
	}
	row, err := s.groupOfTenant(ctx, q, tenant, groupID, true)
	if err != nil {
		return db.TangentGroup{}, err
	}
	if row.RootLineID != root.ID {
		return db.TangentGroup{}, errBranchMoved
	}
	if row.Status != domain.GroupActive {
		return db.TangentGroup{}, domain.ErrGroupNotActive
	}
	return row, nil
}

func groupView(ctx context.Context, q *db.Queries, row db.TangentGroup) (domain.Group, error) {
	views, err := groupViews(ctx, q, []db.TangentGroup{row})
	if err != nil {
		return domain.Group{}, err
	}
	return views[0], nil
}

// groupViews reads the members of the groups in one query.
func groupViews(ctx context.Context, q *db.Queries, rows []db.TangentGroup) ([]domain.Group, error) {
	out := make([]domain.Group, 0, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	ids := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	members, err := q.ListMembersOfGroups(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("list group members: %w", err)
	}
	byGroup := map[uuid.UUID][]string{}
	for _, m := range members {
		byGroup[m.GroupID] = append(byGroup[m.GroupID], m.LineID.String())
	}
	for _, row := range rows {
		out = append(out, domain.Group{
			ID: row.ID.String(), RootLineID: row.RootLineID.String(), Title: row.Title, Summary: row.Summary, SummaryStatus: row.SummaryStatus,
			Status: row.Status, MemberLineIDs: append([]string{}, byGroup[row.ID]...), CreatedBy: row.CreatedBy,
			CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(),
		})
	}
	return out, nil
}
