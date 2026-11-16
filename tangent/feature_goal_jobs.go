package tangent

import (
	"cmp"
	"context"
	"encoding/json"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

const (
	// goalProposeAfterReplies: Suggest and Auto propose a goal after the
	// main line's second reply.
	goalProposeAfterReplies = 2
	// goalProposeScan is how many messages from the start of the main line
	// a proposal reads.
	goalProposeScan = 12
)

// errNoConversation: the main line has no finished exchange to read.
var errNoConversation = domain.NewError(domain.CodeNoMessages, "the conversation has no finished messages yet", nil)

// GoalProposal is the payload of a goal_propose suggestion.
type GoalProposal struct {
	Text string `json:"text"`
}

// DriftPayload is the payload of a drift suggestion: where to open the
// branch (the main-line reply the check ran after), its kind and purpose,
// why, and the goal it was checked against.
type DriftPayload struct {
	AnchorMessageID string `json:"anchorMessageId"`
	Kind            string `json:"kind"`
	Purpose         string `json:"purpose"`
	Reason          string `json:"reason"`
	Goal            string `json:"goal"`
}

// goalJobInput is what a goal job remembers between start and finish.
type goalJobInput struct {
	Asked           bool   `json:"asked,omitempty"`
	AnchorMessageID string `json:"anchorMessageId,omitempty"`
	Goal            string `json:"goal,omitempty"`
}

func readGoalJobInput(raw json.RawMessage) goalJobInput {
	var in goalJobInput
	_ = json.Unmarshal(raw, &in)
	return in
}

// startGoalPropose records a goal_propose job for a main line.
func (e *Engine) startGoalPropose(ctx context.Context, scope Scope, rootID string, asked bool, opts []TxOption) (Job, error) {
	root, err := e.store.GetLine(ctx, scope.Tenant, rootID)
	if err != nil {
		return Job{}, err
	}
	messages, err := e.store.ListMessages(ctx, scope.Tenant, rootID, 0, goalProposeScan)
	if err != nil {
		return Job{}, err
	}
	messages = conversationOnly(messages)
	if len(messages) == 0 {
		return Job{}, errNoConversation
	}
	input, _ := json.Marshal(goalJobInput{Asked: asked})
	record, err := e.startJob(ctx, scope, store.CreateJobInput{Kind: JobKindGoalPropose, Feature: FeatureGoal, LineID: rootID, Input: input, Supersede: true}, opts)
	if err != nil {
		return Job{}, err
	}
	text := domain.BuildGoalProposePrompt(domain.GoalProposeInput{Title: root.Title, Messages: messages, ExtraMarkers: e.markers})
	return e.goalJob(record, scope, root, text), nil
}

// startDriftCheck records a drift_check job for a main line after the
// reply anchorID.
func (e *Engine) startDriftCheck(ctx context.Context, scope Scope, modes modeSet, line domain.LineView, goal domain.Goal, anchorID string) (Job, error) {
	window := 2 * e.limits.Goal.DriftEvery
	recent, err := e.store.RecentMessages(ctx, scope.Tenant, line.ID, window+2)
	if err != nil {
		return Job{}, err
	}
	messages := conversationOnly(recent)
	if len(messages) > window {
		messages = messages[len(messages)-window:]
	}
	input, _ := json.Marshal(goalJobInput{AnchorMessageID: anchorID, Goal: goal.Text})
	record, err := e.startJob(ctx, scope, store.CreateJobInput{Kind: JobKindDriftCheck, Feature: FeatureGoal, LineID: line.ID, Input: input, Supersede: true}, nil)
	if err != nil {
		return Job{}, err
	}
	text := domain.BuildDriftCheckPrompt(domain.DriftCheckInput{
		Goal: goal.Text, Messages: messages, AsideAllowed: modes.of(FeatureAside) != ModeOff, ExtraMarkers: e.markers,
	})
	return e.goalJob(record, scope, line, text), nil
}

// goalJob is a goal feature's job on a main line.
func (e *Engine) goalJob(record JobRecord, scope Scope, line domain.LineView, text string) Job {
	provider, model := e.configOf(FeatureGoal).jobModel(line.Provider, line.Model)
	return Job{
		ID: record.ID, Kind: record.Kind, Feature: FeatureGoal, Scope: scope, LineID: line.ID,
		Prompt: jobPrompt(text), Provider: provider, Model: model,
	}
}

// conversationOnly keeps the finished operator and assistant messages.
func conversationOnly(messages []domain.Message) []domain.Message {
	out := make([]domain.Message, 0, len(messages))
	for _, message := range messages {
		if conversationMessage(message) {
			out = append(out, message)
		}
	}
	return out
}

// finishFeatureJob ends a job: failed with a fixed text when the run failed
// or its output was unusable (ok false; job.failed is published), done
// otherwise.
func (e *Engine) finishFeatureJob(ctx context.Context, job JobRecord, runErr, parseErr error) (bool, error) {
	if runErr == nil && parseErr == nil {
		_, err := e.store.FinishJob(ctx, job.ID, store.JobDone, "")
		return err == nil, err
	}
	reason := domain.JobUnusableText
	if runErr != nil {
		reason = domain.JobRunFailedText
	}
	if _, err := e.store.FinishJob(ctx, job.ID, store.JobFailed, reason); err != nil {
		return false, err
	}
	e.publishJobFailed(ctx, job, reason)
	return false, nil
}

// finishGoalPropose raises the proposed goal in the inbox, or in Auto
// writes it (over an existing goal only when the operator asked).
func finishGoalPropose(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
	text, parseErr := domain.ParseGoalProposal(raw, e.limits.Goal)
	if ok, err := e.finishFeatureJob(ctx, job, runErr, parseErr); !ok {
		return err
	}
	scope := Scope{Tenant: job.TenantID}
	asked := readGoalJobInput(job.Input).Asked
	switch e.modesFor(ctx, scope).of(FeatureGoal) {
	case ModeOff:
		return nil
	case ModeAuto:
		_, err := e.writeGoal(ctx, scope, store.PutGoalInput{LineID: job.LineID, Text: text, Source: domain.GoalSourceAI, KeepExisting: !asked}, nil)
		if domain.CodeOf(err) == domain.CodeArchived {
			// The tree was archived while the job ran: the job is done, the
			// goal is not written (an archived tree takes no writes).
			e.log.Warn("tangent: an automatic goal was not written", "job", job.ID, "line", job.LineID, "error", err)
			return nil
		}
		return err
	}
	payload, _ := json.Marshal(GoalProposal{Text: text})
	e.publish(ctx, e.proposeSuggestion(ctx, scope, suggestionProposal{
		lineID: job.LineID, kind: SuggestionKindGoalPropose, targetKey: "goal:" + job.LineID, payload: payload, asked: asked,
	})...)
	return nil
}

// finishDriftCheck raises a drift suggestion when the check found one.
func finishDriftCheck(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
	scope := Scope{Tenant: job.TenantID}
	modes := e.modesFor(ctx, scope)
	verdict, parseErr := domain.ParseDriftCheck(raw, e.limits, modes.of(FeatureAside) != ModeOff)
	if ok, err := e.finishFeatureJob(ctx, job, runErr, parseErr); !ok {
		return err
	}
	if !verdict.Drift || modes.of(FeatureGoal) < ModeSuggest {
		return nil
	}
	in := readGoalJobInput(job.Input)
	payload, _ := json.Marshal(DriftPayload{
		AnchorMessageID: in.AnchorMessageID, Kind: verdict.Kind, Purpose: verdict.Purpose, Reason: verdict.Reason, Goal: in.Goal,
	})
	e.publish(ctx, e.proposeSuggestion(ctx, scope, suggestionProposal{
		lineID: job.LineID, kind: SuggestionKindDrift, targetKey: "drift:" + in.AnchorMessageID, payload: payload,
	})...)
	return nil
}

// GoalAccepted is what accepting a goal_propose suggestion did.
type GoalAccepted struct {
	Goal domain.Goal `json:"goal"`
}

// goalChoice is the body of accepting a goal: Text replaces the proposal
// (the goal is then the operator's, source manual).
type goalChoice struct {
	Text string `json:"text"`
}

func acceptGoal(ctx context.Context, e *Engine, scope Scope, s domain.Suggestion, body json.RawMessage, mark TxOption, opts []TxOption) (any, error) {
	var proposal GoalProposal
	var choice goalChoice
	if err := decodeChoice(s.Payload, &proposal); err != nil {
		return nil, err
	}
	if err := decodeChoice(body, &choice); err != nil {
		return nil, err
	}
	in := store.PutGoalInput{LineID: s.RootLineID, Text: proposal.Text, Source: domain.GoalSourceAI}
	if choice.Text != "" && choice.Text != proposal.Text {
		in.Text, in.Source = choice.Text, domain.GoalSourceManual
	}
	goal, err := e.writeGoal(ctx, scope, in, append([]TxOption{mark}, opts...))
	if err != nil {
		return nil, err
	}
	return GoalAccepted{Goal: goal}, nil
}

// DriftAccepted is what accepting a drift suggestion did: the new branch.
type DriftAccepted struct {
	Line   domain.LineView   `json:"line"`
	Branch domain.BranchView `json:"branch"`
}

// driftChoice is the body of accepting a drift: Kind and Purpose replace
// the proposed ones.
type driftChoice struct {
	Kind    string `json:"kind"`
	Purpose string `json:"purpose"`
}

func acceptDrift(ctx context.Context, e *Engine, scope Scope, s domain.Suggestion, body json.RawMessage, mark TxOption, opts []TxOption) (any, error) {
	var payload DriftPayload
	var choice driftChoice
	if err := decodeChoice(s.Payload, &payload); err != nil {
		return nil, err
	}
	if err := decodeChoice(body, &choice); err != nil {
		return nil, err
	}
	created, err := e.CreateBranch(ctx, scope, s.LineID, BranchInput{
		AnchorMessageID: payload.AnchorMessageID, Purpose: cmp.Or(strings.TrimSpace(choice.Purpose), payload.Purpose),
		Kind: cmp.Or(strings.TrimSpace(choice.Kind), payload.Kind),
	}, append([]TxOption{mark}, opts...)...)
	if err != nil {
		return nil, err
	}
	return DriftAccepted{Line: created.Line, Branch: created.Branch}, nil
}

// decodeChoice reads an accept body or a stored payload; empty is no
// choice.
func decodeChoice(raw json.RawMessage, v any) error {
	if len(strings.TrimSpace(string(raw))) == 0 || string(raw) == "null" {
		return nil
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return domain.NewError(domain.CodeInvalidInput, "the body must be a JSON object of the suggestion's choices", nil)
	}
	return nil
}
