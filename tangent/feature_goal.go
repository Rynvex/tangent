package tangent

import (
	"context"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Jobs and suggestion kinds of the goal feature.
const (
	// JobKindGoalPropose: a cheap model states the goal from the first exchanges.
	JobKindGoalPropose = "goal_propose"
	// JobKindDriftCheck: a cheap model checks the latest exchanges against the goal.
	JobKindDriftCheck = "drift_check"
	// SuggestionKindGoalPropose is a proposed goal (payload GoalProposal).
	SuggestionKindGoalPropose = "goal_propose"
	// SuggestionKindDrift proposes a branch for a drifting part (payload DriftPayload).
	SuggestionKindDrift = "drift"
)

// goalJobTimeout is how long a goal or drift job may stay pending.
const goalJobTimeout = 3 * time.Minute

// Goal is the conversation's goal (DESIGN §12 B9): one line per
// conversation, carried by every prompt of its tree right after the rules
// (a stable block). The operator writes it, or asks the model to propose
// one (ProposeGoal, any mode). Suggest and Auto also propose one by
// themselves after the main line's second reply when there is none, and
// check every Limits.Goal.DriftEvery main-line replies whether the
// conversation drifted from it (a drift suggestion: open a branch or an
// aside there). A proposal waits in the inbox; Auto writes it as the goal
// instead (never over a goal that is there, unless the operator asked).
// Manual: the goal and the button only. Off: the goal calls return
// feature_disabled and prompts carry no goal; a stored goal is kept.
func Goal(mode Mode, opts ...FeatureOption) Feature {
	return aiFeature(FeatureGoal, mode, opts, registerGoal)
}

func registerGoal(r *registry, _ *module) {
	r.addContextProvider(goalContext)
	r.addAfterCommit(goalAfterTurn)
	r.addJobHandler(JobKindGoalPropose, jobHandler{timeout: goalJobTimeout, finish: finishGoalPropose, onStale: staleJobFailed})
	r.addJobHandler(JobKindDriftCheck, jobHandler{timeout: goalJobTimeout, finish: finishDriftCheck, onStale: staleJobFailed})
	r.addSuggestionKind(SuggestionKindGoalPropose, suggestionKind{accept: acceptGoal})
	r.addSuggestionKind(SuggestionKindDrift, suggestionKind{accept: acceptDrift})
}

// goalContext puts the tree's goal into the prompt.
func goalContext(ctx context.Context, e *Engine, _ Mode, pc *promptContext) error {
	root := pc.line.ID
	switch {
	case pc.begun != nil:
		root = pc.begun.rootLineID
	case pc.line.ConversationBranch != nil:
		root = pc.line.ConversationBranch.RootLineID
	}
	goal, err := e.store.GoalOfRoot(ctx, root)
	if err != nil || goal == nil {
		return err
	}
	pc.in.Goal = goal.Text
	return nil
}

// GoalChange is the data of goal.changed; Goal is nil once it was deleted.
type GoalChange struct {
	RootLineID string       `json:"rootLineId"`
	Goal       *domain.Goal `json:"goal"`
}

func goalEvent(scope Scope, rootLineID string, goal *domain.Goal) Event {
	return Event{
		Type: EventGoalChanged, Tenant: scope.Tenant, RootLineID: rootLineID, LineID: rootLineID,
		Data: GoalChange{RootLineID: rootLineID, Goal: goal},
	}
}

// GetGoal reads the goal of the line's conversation; nil when it has none.
func (e *Engine) GetGoal(ctx context.Context, scope Scope, lineID string) (*domain.Goal, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureGoal)
	if err != nil {
		return nil, err
	}
	return e.store.GetGoal(ctx, scope.Tenant, lineID)
}

// PutGoal writes the operator's goal for the line's conversation (source
// manual) over whatever it had; open goal_propose suggestions of the
// conversation expire in the same transaction.
// InTx hooks receive domain.Goal.
func (e *Engine) PutGoal(ctx context.Context, scope Scope, lineID, text string, opts ...TxOption) (domain.Goal, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureGoal)
	if err != nil {
		return domain.Goal{}, err
	}
	ctx = e.inbox(ctx, modes)
	var expired []domain.Suggestion
	expire := inTxFirst(func(ctx context.Context, tx store.Tx, result any) error {
		goal, _ := result.(domain.Goal)
		rows, expireErr := store.ExpireSuggestionsOfKind(ctx, tx, goal.RootLineID, FeatureGoal, SuggestionKindGoalPropose)
		expired = rows
		return expireErr
	})
	goal, err := e.writeGoal(ctx, scope, store.PutGoalInput{LineID: lineID, Text: text, Source: domain.GoalSourceManual}, append([]TxOption{expire}, opts...))
	if err != nil {
		return domain.Goal{}, err
	}
	e.publish(ctx, e.suggestionEvents(ctx, scope, expired...)...)
	return goal, nil
}

// writeGoal writes a goal and publishes goal.changed when it was written.
func (e *Engine) writeGoal(ctx context.Context, scope Scope, in store.PutGoalInput, opts []TxOption) (domain.Goal, error) {
	in.Tenant, in.Actor = scope.Tenant, scope.Actor
	write, err := e.store.PutGoal(ctx, in, hooksOf(opts)...)
	if err != nil {
		return domain.Goal{}, err
	}
	if write.Written {
		e.publish(ctx, goalEvent(scope, write.Goal.RootLineID, &write.Goal))
	}
	return write.Goal, nil
}

// DeleteGoal removes the goal of the line's conversation (goal_not_found
// without one).
// InTx hooks receive domain.Goal (the deleted one).
func (e *Engine) DeleteGoal(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (domain.Goal, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureGoal)
	if err != nil {
		return domain.Goal{}, err
	}
	goal, err := e.store.DeleteGoal(ctx, scope.Tenant, lineID, hooksOf(opts)...)
	if err != nil {
		return domain.Goal{}, err
	}
	e.publish(ctx, goalEvent(scope, goal.RootLineID, nil))
	return goal, nil
}

// ProposeGoal starts a goal_propose job for the line's conversation (any
// mode; the operator asked, so an earlier dismissal does not hold the
// proposal back, and in Auto it replaces the goal). A pending proposal is
// superseded. It needs a finished exchange on the main line (no_messages).
// InTx hooks receive store.Job.
func (e *Engine) ProposeGoal(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (Job, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureGoal)
	if err != nil {
		return Job{}, err
	}
	line, err := e.store.GetLine(ctx, scope.Tenant, lineID)
	if err != nil {
		return Job{}, err
	}
	root := line.ID
	if line.ConversationBranch != nil {
		root = line.ConversationBranch.RootLineID
	}
	return e.startGoalPropose(ctx, scope, root, true, opts)
}

// goalAfterTurn proposes a goal after the main line's second reply when
// there is none, and checks for drift every DriftEvery replies when there
// is one (Suggest, Auto; main lines only).
func goalAfterTurn(ctx context.Context, e *Engine, mode Mode, ev *commitEvent) ([]Event, []Job) {
	if ev.kind != commitTurnCompleted || mode < ModeSuggest || ev.turn == nil || !repliedTurn(ev.turn.Message) || ev.turn.Line.ConversationBranch != nil {
		return nil, nil
	}
	line := ev.turn.Line
	replies, err := ev.lineReplies(ctx, e)
	if err != nil || (replies != goalProposeAfterReplies && replies%e.limits.Goal.DriftEvery != 0) {
		return nil, nil
	}
	goal, err := e.store.GoalOfRoot(ctx, line.ID)
	if err != nil {
		e.log.Warn("tangent: the goal could not be read", "line", line.ID, "error", err)
		return nil, nil
	}
	var job Job
	switch {
	case goal == nil && replies == goalProposeAfterReplies:
		job, err = e.startGoalPropose(ctx, ev.scope, line.ID, false, nil)
	case goal != nil && replies%e.limits.Goal.DriftEvery == 0:
		job, err = e.startDriftCheck(ctx, ev.scope, ev.modes, line, *goal, ev.turn.Message.ID)
	default:
		return nil, nil
	}
	if err != nil {
		e.log.Warn("tangent: a goal job was not started", "line", line.ID, "error", err)
		return nil, nil
	}
	return nil, []Job{job}
}
