package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// The B9 part A routes: the conversation goal, relations, open loops and
// message pins (core).

// p2Routes are mounted like the other feature routes; the pins are core.
func (a *api) p2Routes() []route {
	return []route{
		{pattern: "GET /lines/{id}/goal", feature: tangent.FeatureGoal, serve: a.getGoal},
		{pattern: "PUT /lines/{id}/goal", write: true, op: OpGoalPut, feature: tangent.FeatureGoal, serve: a.putGoal},
		{pattern: "DELETE /lines/{id}/goal", write: true, op: OpGoalDelete, feature: tangent.FeatureGoal, serve: a.deleteGoal},
		{pattern: "POST /lines/{id}/goal/propose", write: true, op: OpGoalPropose, feature: tangent.FeatureGoal, serve: a.proposeGoal},
		{pattern: "GET /lines/{id}/relations", feature: tangent.FeatureRelations, serve: a.listRelations},
		{pattern: "POST /lines/{id}/relations", write: true, op: OpRelationsCreate, feature: tangent.FeatureRelations, serve: a.createRelation},
		{pattern: "DELETE /lines/{id}/relations/{rid}", write: true, op: OpRelationsDelete, feature: tangent.FeatureRelations, serve: a.deleteRelation},
		{pattern: "GET /open-loops", feature: tangent.FeatureOpenLoops, serve: a.openLoops},
		{pattern: "POST /messages/{mid}/pin", write: true, op: OpMessagesPin, serve: a.pin(true)},
		{pattern: "DELETE /messages/{mid}/pin", write: true, op: OpMessagesUnpin, serve: a.pin(false)},
	}
}

type goalView struct {
	// Goal is null while the conversation has none.
	Goal *domain.Goal `json:"goal"`
}

type goalBody struct {
	Text string `json:"text"`
}

func (a *api) getGoal(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	goal, err := a.engine.GetGoal(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, goalView{Goal: goal}, nil
}

// putGoal is PUT /lines/{id}/goal {text}: the operator's goal.
func (a *api) putGoal(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in goalBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	goal, err := a.engine.PutGoal(c.ctx, c.scope, id, in.Text, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, goalView{Goal: &goal}, nil
}

func (a *api) deleteGoal(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	if _, err := a.engine.DeleteGoal(c.ctx, c.scope, id, c.tx()...); err != nil {
		return 0, nil, err
	}
	return http.StatusNoContent, nil, nil
}

// proposeGoal is POST /lines/{id}/goal/propose: 202 with the job.
func (a *api) proposeGoal(c *call) (int, any, error) {
	return a.startJob(c, a.engine.ProposeGoal)
}

// relationList is GET /lines/{id}/relations.
type relationList struct {
	Relations []domain.Link    `json:"relations"`
	Limits    relationLimitsJS `json:"limits"`
}

type relationLimitsJS struct {
	MaxPerTree    int `json:"maxPerTree"`
	LabelMaxRunes int `json:"labelMaxRunes"`
}

func (a *api) listRelations(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	relations, err := a.engine.ListRelations(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	limits := relationLimitsJS{MaxPerTree: a.limits.Relations.MaxPerTree, LabelMaxRunes: a.limits.Relations.LabelMaxRunes}
	return http.StatusOK, relationList{Relations: list(relations), Limits: limits}, nil
}

// relationBody is POST /lines/{id}/relations: fromLineId defaults to {id}.
type relationBody struct {
	FromLineID    string `json:"fromLineId"`
	FromMessageID string `json:"fromMessageId"`
	ToLineID      string `json:"toLineId"`
	ToMessageID   string `json:"toMessageId"`
	Label         string `json:"label"`
	RelationKind  string `json:"relationKind"`
}

type relationCreated struct {
	Relation    domain.Link `json:"relation"`
	RootLineIDs []string    `json:"rootLineIds"`
}

func (a *api) createRelation(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in relationBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	change, err := a.engine.CreateRelation(c.ctx, c.scope, id, tangent.RelationInput{
		From: tangent.RelationEnd{LineID: in.FromLineID, MessageID: in.FromMessageID},
		To:   tangent.RelationEnd{LineID: in.ToLineID, MessageID: in.ToMessageID}, Label: in.Label, RelationKind: in.RelationKind,
	}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, relationCreated{Relation: change.Link, RootLineIDs: list(change.RootLineIDs)}, nil
}

func (a *api) deleteRelation(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	relation, err := c.pathID("rid", domain.ErrRelationNotFound)
	if err != nil {
		return 0, nil, err
	}
	if _, err := a.engine.DeleteRelation(c.ctx, c.scope, id, relation, c.tx()...); err != nil {
		return 0, nil, err
	}
	return http.StatusNoContent, nil, nil
}

// openLoops is GET /open-loops?root=&staleDays=.
func (a *api) openLoops(c *call) (int, any, error) {
	days, err := c.queryInt("staleDays", 0, 1<<20)
	if err != nil {
		return 0, nil, err
	}
	root := c.r.URL.Query().Get("root")
	if root != "" {
		if root, err = c.idValue(root, domain.ErrLineNotFound); err != nil {
			return 0, nil, err
		}
	}
	loops, err := a.engine.OpenLoops(c.ctx, c.scope, tangent.OpenLoopsInput{LineID: root, StaleDays: int(days)})
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, loops, nil
}

type messageView struct {
	Message domain.Message `json:"message"`
}

// pin is POST (pin) and DELETE (unpin) /messages/{mid}/pin.
func (a *api) pin(pinned bool) func(c *call) (int, any, error) {
	return func(c *call) (int, any, error) {
		id, err := c.pathID("mid", domain.ErrMessageNotFound)
		if err != nil {
			return 0, nil, err
		}
		message, err := a.engine.PinMessage(c.ctx, c.scope, id, pinned, c.tx()...)
		if err != nil {
			return 0, nil, err
		}
		return http.StatusOK, messageView{Message: message}, nil
	}
}
