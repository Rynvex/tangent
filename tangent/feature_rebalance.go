package tangent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Rynvex/tangent/domain"
)

// SuggestionKindRebalance is the rebalance hint's suggestion.
const SuggestionKindRebalance = "promote_or_spinoff"

// Actions the rebalance suggestion offers.
const (
	RebalancePromote = "promote"
	RebalanceSpinoff = "spinoff"
)

// Rebalance hints when a branch has taken over the conversation (DESIGN §12
// B8): after a turn of an open branch whose replies since the fork reach
// Limits.Rebalance (at least MinBranchTurns and ShareFactor times the
// parent's, or the tree's last RecentTurns replies all its), it raises a
// promote_or_spinoff suggestion about the branch. Accepting promotes it
// (top-level branches only) or spins it off (detach; needs spinoff);
// dismissing ("keep as is") is final for that branch. Suggest and Auto
// behave alike (nothing changes without the operator); Manual raises
// nothing. Needs leaf (the previous main line of a promotion gets a leaf).
func Rebalance(mode Mode, opts ...FeatureOption) Feature {
	return &module{
		name: FeatureRebalance, ai: true, configured: mode, requires: []string{FeatureLeaf},
		cfg: newFeatureConfig(opts), attach: registerRebalance,
	}
}

func registerRebalance(r *registry, _ *module) {
	r.addSuggestionKind(SuggestionKindRebalance, suggestionKind{permanentDismiss: true, accept: acceptRebalance})
	r.addAfterCommit(rebalanceAfterTurn)
}

// RebalancePayload is the payload of a promote_or_spinoff suggestion.
type RebalancePayload struct {
	Reason string `json:"reason"`
	// ParentIsMain says the branch hangs on the main line; ParentTitle is
	// the title of the line it hangs on.
	ParentIsMain bool   `json:"parentIsMain"`
	ParentTitle  string `json:"parentTitle"`
	domain.RebalanceSignals
	// Actions are what accepting may do now (promote: a branch of the main
	// line; spinoff: while spinoff is on).
	Actions []string `json:"actions"`
}

func rebalanceAfterTurn(ctx context.Context, e *Engine, mode Mode, ev *commitEvent) ([]Event, []Job) {
	if ev.kind != commitTurnCompleted || mode < ModeSuggest || ev.turn == nil || !repliedTurn(ev.turn.Message) {
		return nil, nil
	}
	branch := ev.turn.Line.ConversationBranch
	if branch == nil || branch.Kind == domain.BranchKindAside || branch.Status != domain.BranchStatusOpen {
		return nil, nil
	}
	state, err := e.store.RebalanceSignals(ctx, ev.scope.Tenant, ev.turn.Line.ID, e.limits.Rebalance)
	if err != nil {
		e.log.Warn("tangent: rebalance signals unavailable", "line", ev.turn.Line.ID, "error", err)
		return nil, nil
	}
	reason, due := domain.RebalanceDue(state.Signals, e.limits.Rebalance)
	if !state.Eligible || !due {
		return nil, nil
	}
	payload := RebalancePayload{
		Reason: reason, ParentIsMain: state.TopLevel, ParentTitle: state.ParentTitle, RebalanceSignals: state.Signals, Actions: []string{},
	}
	if state.TopLevel {
		payload.Actions = append(payload.Actions, RebalancePromote)
	}
	if ev.modes.of(FeatureSpinoff) != ModeOff {
		payload.Actions = append(payload.Actions, RebalanceSpinoff)
	}
	if len(payload.Actions) == 0 {
		return nil, nil
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, nil
	}
	return e.proposeSuggestion(ctx, ev.scope, suggestionProposal{
		lineID: ev.turn.Line.ID, kind: SuggestionKindRebalance, targetKey: domain.SuggestionTargetBranch(ev.turn.Line.ID), payload: raw,
	}), nil
}

// rebalanceChoice is the body of accepting a rebalance suggestion; Title and
// CopyNotes go to the spinoff.
type rebalanceChoice struct {
	Action    string `json:"action"`
	Title     string `json:"title"`
	CopyNotes bool   `json:"copyNotes"`
}

// RebalanceResult is what accepting a rebalance suggestion did.
type RebalanceResult struct {
	Action string `json:"action"`
	// Promote: the promoted branch, the previous main line and the main line.
	Branch           *domain.BranchView `json:"branch,omitempty"`
	PreviousMainLine *domain.BranchView `json:"previousMainLine,omitempty"`
	// Both: the main line after the change (promote: the same id; spinoff:
	// the new one).
	Line domain.LineView `json:"line"`
	// Spinoff: the link to the new conversation.
	Link *domain.Link `json:"link,omitempty"`
}

var errRebalanceAction = domain.NewError(domain.CodeInvalidInput, "action must be promote or spinoff", nil)

func acceptRebalance(ctx context.Context, e *Engine, scope Scope, s domain.Suggestion, body json.RawMessage, mark TxOption, opts []TxOption) (any, error) {
	var choice rebalanceChoice
	if len(body) > 0 {
		if err := json.Unmarshal(body, &choice); err != nil {
			return nil, errRebalanceAction
		}
	}
	all := append([]TxOption{mark}, opts...)
	switch strings.TrimSpace(choice.Action) {
	case RebalancePromote:
		promoted, err := e.PromoteBranch(ctx, scope, s.LineID, all...)
		if err != nil {
			return nil, err
		}
		return RebalanceResult{Action: RebalancePromote, Branch: &promoted.Promoted, PreviousMainLine: &promoted.Previous, Line: promoted.Main}, nil
	case RebalanceSpinoff:
		out, err := e.Spinoff(ctx, scope, s.LineID, SpinoffInput{Mode: domain.SpinoffDetach, Title: choice.Title, CopyNotes: choice.CopyNotes}, all...)
		if err != nil {
			return nil, err
		}
		return RebalanceResult{Action: RebalanceSpinoff, Line: out.Line, Link: &out.Link}, nil
	}
	return nil, errRebalanceAction
}
