package tangent

import (
	"context"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Jobs and the suggestion kind of the group feature.
const (
	// JobKindGroupSummary writes a group's shared summary.
	JobKindGroupSummary = store.JobKindGroupSummary
	// JobKindGroupSuggest proposes groups among a tree's branches.
	JobKindGroupSuggest = "group_suggest"
	// SuggestionKindGroup is a proposed group (payload GroupSuggestion).
	SuggestionKindGroup = "group"
)

// capGroupFisheye is what group provides to the fisheye: a ready group's
// summary stands for its members.
const capGroupFisheye = "group.fisheye"

// Group circles branches together (DESIGN §12 B9): a group of ended
// branches gets one shared summary (a group_summary job, started when the
// group is made or asked again) that stands for their leaves in the
// fisheye context; open sibling branches can be combined into one new
// branch (origin merge) that carries their background, the old ones
// discarded and pointing at it. Either may settle conflicts between the
// branches' claims (adopt one side, or keep both as a note to confirm).
// Suggest (Auto alike: nothing is grouped by itself) also asks a cheap model,
// whenever a branch ends, to propose groups and their conflicts
// (group_suggest → the inbox). Manual: by hand only. Needs leaf. Off: the
// group calls return feature_disabled; stored groups are kept.
func Group(mode Mode, opts ...FeatureOption) Feature {
	return &module{name: FeatureGroup, ai: true, configured: mode, requires: []string{FeatureLeaf}, cfg: newFeatureConfig(opts), attach: registerGroup}
}

func registerGroup(r *registry, _ *module) {
	r.provide(capGroupFisheye)
	r.addAfterCommit(groupSuggestAfterClose)
	r.addJobHandler(JobKindGroupSummary, jobHandler{timeout: goalJobTimeout, finish: finishGroupSummary, onStale: staleGroupSummary})
	r.addJobHandler(JobKindGroupSuggest, jobHandler{timeout: goalJobTimeout, finish: finishGroupSuggest, onStale: staleJobFailed})
	r.addSuggestionKind(SuggestionKindGroup, suggestionKind{accept: acceptGroup})
}

// GroupChange is the data of group.changed.
type GroupChange struct {
	RootLineID string       `json:"rootLineId"`
	Group      domain.Group `json:"group"`
}

func groupEvent(tenant string, g domain.Group) Event {
	return Event{Type: EventGroupChanged, Tenant: tenant, RootLineID: g.RootLineID, LineID: g.RootLineID, Data: GroupChange{RootLineID: g.RootLineID, Group: g}}
}

// GroupInput makes a group of ended branches; Conflicts are the ones the
// operator settled (keepBoth needs notes).
type GroupInput struct {
	MemberLineIDs []string
	Title         string
	Conflicts     []domain.Conflict
}

// GroupCreated is a new group, the summary job started for it (nil when it
// could not be started; SummarizeGroup again) and the notes keepBoth wrote.
type GroupCreated struct {
	Group domain.Group
	Job   *Job
	Notes NotesWrite
}

// CreateGroup makes a group of ended branches of the line's tree and
// starts its summary; the job goes to the job dispatcher (SetJobDispatcher)
// and is returned.
// InTx hooks receive store.GroupWrite.
func (e *Engine) CreateGroup(ctx context.Context, scope Scope, lineID string, in GroupInput, opts ...TxOption) (GroupCreated, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureGroup)
	if err != nil {
		return GroupCreated{}, err
	}
	settled, err := e.settle(ctx, scope, modes, in.MemberLineIDs, in.Conflicts)
	if err != nil {
		return GroupCreated{}, err
	}
	written, err := e.store.CreateGroup(ctx, store.CreateGroupInput{
		Tenant: scope.Tenant, LineID: lineID, MemberLineIDs: in.MemberLineIDs, Title: in.Title, Settled: settled.settled, Notes: settled.notes, Actor: scope.Actor,
	}, hooksOf(opts)...)
	if err != nil {
		return GroupCreated{}, err
	}
	e.publish(ctx, append([]Event{groupEvent(scope.Tenant, written.Group)}, notesEvents(scope, written.Notes)...)...)
	out := GroupCreated{Group: written.Group, Notes: written.Notes}
	if job, err := e.SummarizeGroup(ctx, scope, written.Group.ID); err == nil {
		out.Job = &job
		out.Group, _ = e.store.GetGroup(ctx, scope.Tenant, written.Group.ID)
		e.dispatchOrphanJobs(ctx, []Job{job})
	} else {
		e.log.Warn("tangent: a group summary was not started", "group", written.Group.ID, "error", err)
	}
	return out, nil
}

// settlement is what the operator's choices on conflicts lead to: the
// to-confirm notes keepBoth writes, the claims adopted and the ones kept
// open (both lines).
type settlement struct {
	notes   []domain.NoteChange
	settled []string
	open    []string
}

// settle checks conflicts against the branches (keepBoth needs notes).
func (e *Engine) settle(ctx context.Context, scope Scope, modes modeSet, lineIDs []string, conflicts []domain.Conflict) (settlement, error) {
	members := map[string]bool{}
	for _, id := range lineIDs {
		members[strings.TrimSpace(id)] = true
	}
	conflicts, err := domain.NormalizeConflicts(conflicts, members)
	if err != nil {
		return settlement{}, err
	}
	purposes, err := e.store.BranchPurposes(ctx, scope.Tenant, lineIDs)
	if err != nil {
		return settlement{}, err
	}
	out := settlement{notes: []domain.NoteChange{}, settled: domain.SettledClaims(conflicts), open: domain.OpenClaims(conflicts, purposes)}
	for _, c := range conflicts {
		if c.Choice != domain.ChoiceKeepBoth {
			continue
		}
		if err := requireFeature(modes, FeatureNotes); err != nil {
			return settlement{}, err
		}
		out.notes = append(out.notes, domain.NoteChange{
			Op: domain.NoteOpAdd, Section: domain.NoteSectionToConfirm, Text: domain.ConflictNoteText(c, purposes, e.limits.Notes), SourceLineID: c.Branch.LineID,
		})
	}
	return out, nil
}

// GroupList is a tree's groups.
type GroupList = store.GroupList

// ListGroups lists the groups of the line's tree, newest first; statuses
// default to active.
func (e *Engine) ListGroups(ctx context.Context, scope Scope, lineID string, statuses []string) (GroupList, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureGroup)
	if err != nil {
		return GroupList{}, err
	}
	for _, status := range statuses {
		if status != domain.GroupActive && status != domain.GroupDissolved {
			return GroupList{}, domain.NewError(domain.CodeInvalidInput, "status must be active or dissolved", nil)
		}
	}
	return e.store.ListGroups(ctx, scope.Tenant, lineID, statuses)
}

// GetGroup reads a group.
func (e *Engine) GetGroup(ctx context.Context, scope Scope, groupID string) (domain.Group, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureGroup)
	if err != nil {
		return domain.Group{}, err
	}
	return e.store.GetGroup(ctx, scope.Tenant, groupID)
}

// RenameGroup changes an active group's title.
// InTx hooks receive domain.Group.
func (e *Engine) RenameGroup(ctx context.Context, scope Scope, groupID, title string, opts ...TxOption) (domain.Group, error) {
	return e.groupWrite(ctx, scope, func(scope Scope) (domain.Group, error) {
		return e.store.RenameGroup(ctx, scope.Tenant, groupID, title, hooksOf(opts)...)
	})
}

// DissolveGroup ends an active group; its members show their own leaves
// again.
// InTx hooks receive domain.Group.
func (e *Engine) DissolveGroup(ctx context.Context, scope Scope, groupID string, opts ...TxOption) (domain.Group, error) {
	return e.groupWrite(ctx, scope, func(scope Scope) (domain.Group, error) {
		return e.store.DissolveGroup(ctx, scope.Tenant, groupID, hooksOf(opts)...)
	})
}

func (e *Engine) groupWrite(ctx context.Context, scope Scope, write func(Scope) (domain.Group, error)) (domain.Group, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureGroup)
	if err != nil {
		return domain.Group{}, err
	}
	group, err := write(scope)
	if err != nil {
		return domain.Group{}, err
	}
	e.publish(ctx, groupEvent(scope.Tenant, group))
	return group, nil
}
