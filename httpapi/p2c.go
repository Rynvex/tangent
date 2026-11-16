package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// The B9 part C routes: groups, combining branches and a relation's label.

func (a *api) p2cRoutes() []route {
	return []route{
		{pattern: "GET /lines/{id}/groups", feature: tangent.FeatureGroup, serve: a.listGroups},
		{pattern: "POST /lines/{id}/groups", write: true, op: OpGroupsCreate, feature: tangent.FeatureGroup, serve: a.createGroup},
		{pattern: "GET /groups/{gid}", feature: tangent.FeatureGroup, serve: a.getGroup},
		{pattern: "PATCH /groups/{gid}", write: true, op: OpGroupsRename, feature: tangent.FeatureGroup, serve: a.renameGroup},
		{pattern: "POST /groups/{gid}/dissolve", write: true, op: OpGroupsDissolve, feature: tangent.FeatureGroup, serve: a.dissolveGroup},
		{pattern: "POST /groups/{gid}/summarize", write: true, op: OpGroupsSummarize, feature: tangent.FeatureGroup, serve: a.summarizeGroup},
		{pattern: "POST /lines/{id}/branches/combine", write: true, op: OpBranchesCombine, feature: tangent.FeatureGroup, serve: a.combineBranches},
		{pattern: "PATCH /lines/{id}/relations/{rid}", write: true, op: OpRelationsUpdate, feature: tangent.FeatureRelations, serve: a.updateRelation},
	}
}

type groupList struct {
	RootLineID string         `json:"rootLineId"`
	Groups     []domain.Group `json:"groups"`
	Limits     groupLimitsJS  `json:"limits"`
}

type groupLimitsJS struct {
	MaxMembers       int `json:"maxMembers"`
	MaxActivePerTree int `json:"maxActivePerTree"`
	TitleMaxRunes    int `json:"titleMaxRunes"`
}

type groupView struct {
	Group domain.Group `json:"group"`
}

// groupBody is POST /lines/{id}/groups.
type groupBody struct {
	MemberLineIDs []string          `json:"memberLineIds"`
	Title         string            `json:"title"`
	Conflicts     []domain.Conflict `json:"conflicts"`
}

type groupCreated struct {
	Group domain.Group `json:"group"`
	Job   *jobStarted  `json:"job"`
	Notes *notesWrite  `json:"notes,omitempty"`
}

func (a *api) listGroups(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	statuses := c.queryList("status", []string{domain.GroupActive, domain.GroupDissolved})
	groups, err := a.engine.ListGroups(c.ctx, c.scope, id, statuses)
	if err != nil {
		return 0, nil, err
	}
	l := a.limits.Group
	return http.StatusOK, groupList{RootLineID: groups.RootLineID, Groups: list(groups.Groups), Limits: groupLimitsJS{
		MaxMembers: l.MaxMembers, MaxActivePerTree: l.MaxActivePerTree, TitleMaxRunes: l.TitleMaxRunes,
	}}, nil
}

// createGroup is 201 with the group and its summary job (already handed to
// the job dispatcher; null when it could not be started).
func (a *api) createGroup(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in groupBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	created, err := a.engine.CreateGroup(c.ctx, c.scope, id, tangent.GroupInput{MemberLineIDs: in.MemberLineIDs, Title: in.Title, Conflicts: in.Conflicts}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	out := groupCreated{Group: created.Group, Notes: notesOf(created.Notes)}
	if job := created.Job; job != nil {
		out.Job = &jobStarted{JobID: job.ID, Kind: job.Kind, LineID: job.LineID, Provider: job.Provider, Model: job.Model}
	}
	return http.StatusCreated, out, nil
}

// notesOf is a note write for a response; nil when nothing was written.
func notesOf(w tangent.NotesWrite) *notesWrite {
	if len(w.Created) == 0 && len(w.Superseded) == 0 {
		return nil
	}
	return &notesWrite{RootLineID: w.RootLineID, Revision: w.Revision, Created: list(w.Created), Superseded: list(w.Superseded)}
}

func (a *api) getGroup(c *call) (int, any, error) {
	id, err := c.pathID("gid", domain.ErrGroupNotFound)
	if err != nil {
		return 0, nil, err
	}
	group, err := a.engine.GetGroup(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, groupView{Group: group}, nil
}

func (a *api) renameGroup(c *call) (int, any, error) {
	id, err := c.pathID("gid", domain.ErrGroupNotFound)
	if err != nil {
		return 0, nil, err
	}
	var in struct {
		Title string `json:"title"`
	}
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	group, err := a.engine.RenameGroup(c.ctx, c.scope, id, in.Title, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, groupView{Group: group}, nil
}

func (a *api) dissolveGroup(c *call) (int, any, error) {
	id, err := c.pathID("gid", domain.ErrGroupNotFound)
	if err != nil {
		return 0, nil, err
	}
	group, err := a.engine.DissolveGroup(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, groupView{Group: group}, nil
}

// summarizeGroup is 202 with the job, handed to the dispatcher.
func (a *api) summarizeGroup(c *call) (int, any, error) {
	id, err := c.pathID("gid", domain.ErrGroupNotFound)
	if err != nil {
		return 0, nil, err
	}
	job, err := a.engine.SummarizeGroup(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return a.dispatchStarted(c, job)
}

// combineBody is POST /lines/{id}/branches/combine ({id} is the parent).
type combineBody struct {
	LineIDs   []string          `json:"lineIds"`
	Purpose   string            `json:"purpose"`
	Kind      string            `json:"kind"`
	Conflicts []domain.Conflict `json:"conflicts"`
}

type combined struct {
	Line     domain.LineView     `json:"line"`
	Branch   domain.BranchView   `json:"branch"`
	Pack     domain.BranchPack   `json:"pack"`
	Combined []domain.BranchView `json:"combined"`
	// Reparented are the open children now hanging on the new branch.
	Reparented []string    `json:"reparented"`
	Notes      *notesWrite `json:"notes,omitempty"`
}

func (a *api) combineBranches(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in combineBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	out, err := a.engine.CombineBranches(c.ctx, c.scope, id, tangent.CombineInput{LineIDs: in.LineIDs, Purpose: in.Purpose, Kind: in.Kind, Conflicts: in.Conflicts}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, combined{
		Line: out.Created.Line, Branch: out.Created.Branch, Pack: out.Pack, Combined: list(out.Combined), Reparented: list(out.Reparented), Notes: notesOf(out.Notes),
	}, nil
}

// updateRelation is PATCH /lines/{id}/relations/{rid} {label?,
// relationKind?}: an absent (or null) field keeps the stored value.
func (a *api) updateRelation(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	relation, err := c.pathID("rid", domain.ErrRelationNotFound)
	if err != nil {
		return 0, nil, err
	}
	var in struct {
		Label        *string `json:"label"`
		RelationKind *string `json:"relationKind"`
	}
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	change, err := a.engine.EditRelation(c.ctx, c.scope, id, relation, tangent.RelationEdit{Label: in.Label, RelationKind: in.RelationKind}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, relationCreated{Relation: change.Link, RootLineIDs: list(change.RootLineIDs)}, nil
}
