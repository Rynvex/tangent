package tangent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Rynvex/tangent/domain"
)

// FeatureSuggestionProbe is the probe's name.
const FeatureSuggestionProbe = "suggestion_probe"

// Kinds of the probe's suggestions.
const (
	ProbeKind          = "probe"
	ProbeKindPermanent = "probe_permanent"
)

// Directives a reply carries for the probe.
const (
	ProbeDirective          = "[probe:suggest]"
	ProbeDirectivePermanent = "[probe:suggest-permanent]"
)

// SuggestionProbe is for tests, smoke runs and e2e only, never a product
// feature: it is not in AllFeatures nor the catalog, and /capabilities does
// not list it (it only turns the suggestion inbox on). After a turn whose reply
// contains ProbeDirective it raises a "probe" suggestion about the turn's
// line (ProbeDirectivePermanent: a "probe_permanent" one, whose dismissal is
// final). Accepting one does nothing besides accepting it; its result is
// {"accepted": true}. The fake runner echoes the operator's message, so
// sending a directive raises one.
func SuggestionProbe() Feature { return onOff(FeatureSuggestionProbe, registerProbe) }

func registerProbe(r *registry, _ *module) {
	accept := func(ctx context.Context, e *Engine, scope Scope, s domain.Suggestion, _ json.RawMessage, _ TxOption, opts []TxOption) (any, error) {
		if err := e.acceptOnly(ctx, scope, s, nil, opts); err != nil {
			return nil, err
		}
		return map[string]bool{"accepted": true}, nil
	}
	r.addSuggestionKind(ProbeKind, suggestionKind{accept: accept})
	r.addSuggestionKind(ProbeKindPermanent, suggestionKind{accept: accept, permanentDismiss: true})
	r.addAfterCommit(probeAfterTurn)
}

func probeAfterTurn(ctx context.Context, e *Engine, _ Mode, ev *commitEvent) ([]Event, []Job) {
	if ev.kind != commitTurnCompleted || ev.turn == nil || !repliedTurn(ev.turn.Message) {
		return nil, nil
	}
	content, lineID := ev.turn.Message.Content, ev.turn.Line.ID
	kind := ""
	switch {
	case strings.Contains(content, ProbeDirectivePermanent):
		kind = ProbeKindPermanent
	case strings.Contains(content, ProbeDirective):
		kind = ProbeKind
	default:
		return nil, nil
	}
	payload := json.RawMessage(`{"reason":"the reply asked for a probe suggestion"}`)
	return e.proposeSuggestion(ctx, ev.scope, suggestionProposal{
		lineID: lineID, kind: kind, targetKey: domain.SuggestionTargetLine(lineID), payload: payload,
	}), nil
}
