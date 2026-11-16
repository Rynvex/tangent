package tangent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// The suggestion inbox (DESIGN §12 B8): what features in suggest mode
// propose waits here for the operator; nothing is ever acted on by itself.
// It is not a feature of its own: it is on while a feature that registered
// a suggestion kind is on (FeatureSuggestions in the modes and in
// /capabilities). A feature raises suggestions from its AfterCommit hooks
// (proposeSuggestion) and decides what accepting one does.

// suggestionKind is what a feature registers for one kind of suggestion.
// permanentDismiss: a dismissal is never followed by the same suggestion
// again (otherwise the cooldown applies). accept runs the suggestion's
// action; it must put mark into the transaction of that action (or accept
// through store.DecideSuggestion), so the action and the acceptance commit
// together. opts are the host's own TxOptions.
type suggestionKind struct {
	feature          string
	permanentDismiss bool
	accept           acceptFunc
}

type acceptFunc func(ctx context.Context, e *Engine, scope Scope, s domain.Suggestion, body json.RawMessage, mark TxOption, opts []TxOption) (any, error)

// addSuggestionKind registers a kind of suggestion; one feature per kind.
func (r *registry) addSuggestionKind(kind string, spec suggestionKind) {
	if existing, ok := r.suggestionKinds[kind]; ok {
		r.fail("suggestion kind %q is already raised by %q", kind, existing.feature)
		return
	}
	spec.feature = r.current
	r.suggestionKinds[kind] = spec
}

// inboxOn reports whether a feature that raises suggestions is on.
func (r *registry) inboxOn(modes modeSet) bool {
	for _, spec := range r.suggestionKinds {
		if modes.of(spec.feature) != ModeOff {
			return true
		}
	}
	return false
}

// producers are the features (on in modes) that raise suggestions.
func (r *registry) producers(modes modeSet) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, spec := range r.suggestionKinds {
		if modes.of(spec.feature) != ModeOff && !seen[spec.feature] {
			seen[spec.feature] = true
			out = append(out, spec.feature)
		}
	}
	return out
}

// TaskExpireSuggestions is the inbox's maintenance task: open suggestions
// about branches that ended while the inbox was off for their tenant.
const TaskExpireSuggestions = "suggestions.expire"

// registerInbox attaches the inbox itself once a feature registered a kind:
// a branch that ends expires the open suggestions about it (and, unless it
// was promoted, about the lines below it) in the same transaction.
func registerInbox(r *registry) {
	r.addOnBranchClosed(expireWithBranch)
	r.addMaintainer(TaskExpireSuggestions, func(ctx context.Context, e *Engine) (int, error) {
		swept, err := e.store.ExpireSuggestionsOfEndedBranches(ctx)
		for _, item := range swept {
			scope := Scope{Tenant: item.Tenant}
			e.publish(ctx, append([]Event{suggestionEvent(scope, item.Suggestion)}, e.lineEvents(ctx, scope, item.Suggestion.RootLineID)...)...)
		}
		return len(swept), err
	})
}

func expireWithBranch(ctx context.Context, e *Engine, _ Mode, tx store.Tx, ev txEvent) error {
	if ev.branchLineID == "" {
		return nil
	}
	// A promotion lifts the lines below to the main line and a detach takes
	// them along: only the branch itself stops being one.
	_, promoted := ev.result.(store.PromotedBranch)
	_, detached := ev.result.(store.SpunOff)
	lines, err := e.store.LinesEndedWith(ctx, tx, ev.branchLineID, !promoted && !detached)
	if err != nil {
		return err
	}
	expired, err := store.ExpireSuggestions(ctx, tx, lines)
	if err != nil || len(expired) == 0 {
		return err
	}
	ev.out.after(func(ctx context.Context) []Event { return e.suggestionEvents(ctx, ev.scope, expired...) })
	return nil
}

// SuggestionChange is the data of suggestion.changed.
type SuggestionChange struct {
	RootLineID string            `json:"rootLineId"`
	Suggestion domain.Suggestion `json:"suggestion"`
}

func suggestionEvent(scope Scope, s domain.Suggestion) Event {
	return Event{
		Type: EventSuggestionChanged, Tenant: scope.Tenant, RootLineID: s.RootLineID, LineID: s.LineID,
		Data: SuggestionChange{RootLineID: s.RootLineID, Suggestion: s},
	}
}

// suggestionEvents are suggestion.changed for each suggestion and the main
// line's line.updated (its open count changed).
func (e *Engine) suggestionEvents(ctx context.Context, scope Scope, suggestions ...domain.Suggestion) []Event {
	if len(suggestions) == 0 {
		return nil
	}
	events := make([]Event, 0, len(suggestions)+1)
	for _, s := range suggestions {
		events = append(events, suggestionEvent(scope, s))
	}
	return append(events, e.lineEvents(ctx, scope, suggestions[0].RootLineID)...)
}

// suggestionProposal is a suggestion a feature raises about a line.
type suggestionProposal struct {
	lineID    string
	kind      string
	targetKey string
	payload   json.RawMessage
	// asked: the operator asked for it (an earlier dismissal does not hold it back).
	asked bool
}

// proposeSuggestion records a suggestion of a registered kind (its own
// transaction, after the write that prompted it) and returns the events to
// publish; nothing when the rules say not to raise it. A failure is logged:
// a suggestion is never worth failing the write it followed.
func (e *Engine) proposeSuggestion(ctx context.Context, scope Scope, p suggestionProposal) []Event {
	spec, ok := e.features.suggestionKinds[p.kind]
	if !ok {
		e.log.Error("tangent: a suggestion of an unregistered kind", "kind", p.kind)
		return nil
	}
	proposal, err := e.store.ProposeSuggestion(ctx, store.ProposeInput{
		Tenant: scope.Tenant, LineID: p.lineID, Feature: spec.feature, Kind: p.kind, TargetKey: p.targetKey,
		Payload: p.payload, Permanent: spec.permanentDismiss, Asked: p.asked,
	})
	if err != nil {
		e.log.Warn("tangent: a suggestion was not recorded", "kind", p.kind, "line", p.lineID, "error", err)
		return nil
	}
	if !proposal.Created {
		return nil
	}
	return e.suggestionEvents(ctx, scope, proposal.Suggestion)
}

// SuggestionList is a conversation's inbox.
type SuggestionList = store.SuggestionList

// ListSuggestions lists the suggestions of the line's conversation raised
// by the features that are on, newest first; statuses default to open.
func (e *Engine) ListSuggestions(ctx context.Context, scope Scope, lineID string, statuses []string) (SuggestionList, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureSuggestions)
	if err != nil {
		return SuggestionList{}, err
	}
	wanted := make([]string, 0, len(statuses))
	for _, status := range statuses {
		status = strings.TrimSpace(status)
		if !domain.ValidSuggestionStatus(status) {
			return SuggestionList{}, domain.NewError(domain.CodeInvalidInput, "status must be open, accepted, dismissed or expired", nil)
		}
		wanted = append(wanted, status)
	}
	return e.store.ListSuggestions(ctx, store.SuggestionQuery{
		Tenant: scope.Tenant, LineID: lineID, Features: e.features.producers(modes), Statuses: wanted,
	})
}

// AcceptedSuggestion is an accepted suggestion and what its action returned.
type AcceptedSuggestion struct {
	Suggestion domain.Suggestion
	Result     any
}

// AcceptSuggestion runs an open suggestion's action and marks it accepted
// in the same transaction. body is the kind's choice (for example which of
// two actions); a refused action leaves the suggestion open.
// InTx hooks receive the action's result: domain.Suggestion for a kind without one; store.PromotedBranch or store.SpunOff for rebalance.
func (e *Engine) AcceptSuggestion(ctx context.Context, scope Scope, id string, body json.RawMessage, opts ...TxOption) (AcceptedSuggestion, error) {
	scope, s, spec, err := e.openSuggestion(ctx, scope, id)
	if err != nil {
		return AcceptedSuggestion{}, err
	}
	ctx = e.inboxFor(ctx, scope)
	mark := inTxFirst(func(ctx context.Context, tx store.Tx, _ any) error {
		_, err := store.MarkSuggestionAccepted(ctx, tx, s.ID)
		return err
	})
	result, err := spec.accept(ctx, e, scope, s, body, mark, opts)
	if err != nil {
		return AcceptedSuggestion{}, err
	}
	accepted, err := e.store.GetSuggestion(ctx, scope.Tenant, s.ID)
	if err != nil {
		return AcceptedSuggestion{}, err
	}
	e.publish(ctx, e.suggestionEvents(ctx, scope, accepted)...)
	return AcceptedSuggestion{Suggestion: accepted, Result: result}, nil
}

// DismissSuggestion dismisses an open suggestion: the same one is not
// raised again for the cooldown (or never, for kinds that say so).
// InTx hooks receive domain.Suggestion.
func (e *Engine) DismissSuggestion(ctx context.Context, scope Scope, id string, opts ...TxOption) (domain.Suggestion, error) {
	scope, s, _, err := e.openSuggestion(ctx, scope, id)
	if err != nil {
		return domain.Suggestion{}, err
	}
	ctx = e.inboxFor(ctx, scope)
	dismissed, err := e.store.DecideSuggestion(ctx, scope.Tenant, s.ID, domain.SuggestionDismissed, hooksOf(opts)...)
	if err != nil {
		return domain.Suggestion{}, err
	}
	e.publish(ctx, e.suggestionEvents(ctx, scope, dismissed)...)
	return dismissed, nil
}

// DismissAllSuggestions dismisses at once every open suggestion of the
// line's conversation raised by the features that are on (what
// ListSuggestions lists), as DismissSuggestion dismisses one: the cooldown
// (or a permanent dismissal) applies to each. It returns the dismissed
// suggestions, newest first; none is not an error.
// InTx hooks receive store.SuggestionList.
func (e *Engine) DismissAllSuggestions(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (SuggestionList, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureSuggestions)
	if err != nil {
		return SuggestionList{}, err
	}
	ctx = e.inbox(ctx, modes)
	dismissed, err := e.store.DismissOpenSuggestions(ctx, store.SuggestionQuery{
		Tenant: scope.Tenant, LineID: lineID, Features: e.features.producers(modes),
	}, hooksOf(opts)...)
	if err != nil {
		return SuggestionList{}, err
	}
	e.publish(ctx, e.suggestionEvents(ctx, scope, dismissed.Suggestions...)...)
	return dismissed, nil
}

// openSuggestion reads a suggestion whose inbox and feature are on and
// that is still open.
func (e *Engine) openSuggestion(ctx context.Context, scope Scope, id string) (Scope, domain.Suggestion, suggestionKind, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureSuggestions)
	if err != nil {
		return scope, domain.Suggestion{}, suggestionKind{}, err
	}
	s, err := e.store.GetSuggestion(ctx, scope.Tenant, id)
	if err != nil {
		return scope, domain.Suggestion{}, suggestionKind{}, err
	}
	spec, ok := e.features.suggestionKinds[s.Kind]
	if !ok {
		return scope, domain.Suggestion{}, suggestionKind{}, domain.FeatureDisabled(s.Feature)
	}
	if err := requireFeature(modes, spec.feature); err != nil {
		return scope, domain.Suggestion{}, suggestionKind{}, err
	}
	if s.Status != domain.SuggestionOpen {
		return scope, domain.Suggestion{}, suggestionKind{}, domain.ErrSuggestionNotOpen
	}
	return scope, s, spec, nil
}

// acceptOnly accepts a suggestion whose action is written by hook (nil: no
// action) in the acceptance's own transaction, with the host's options.
func (e *Engine) acceptOnly(ctx context.Context, scope Scope, s domain.Suggestion, hook TxHook, opts []TxOption) error {
	hooks := hooksOf(opts)
	if hook != nil {
		hooks = append([]TxHook{hook}, hooks...)
	}
	_, err := e.store.DecideSuggestion(ctx, scope.Tenant, s.ID, domain.SuggestionAccepted, hooks...)
	return err
}

// inbox makes the line views read with ctx count only the open suggestions
// of the features that are on in modes (LineView.OpenSuggestions matches
// ListSuggestions). Background sweeps without a scope count every one.
func (e *Engine) inbox(ctx context.Context, modes modeSet) context.Context {
	return store.WithInboxFeatures(ctx, e.features.producers(modes))
}

// inboxFor is inbox for a scope whose modes the call did not resolve.
func (e *Engine) inboxFor(ctx context.Context, scope Scope) context.Context {
	if len(e.features.suggestionKinds) == 0 {
		return store.WithInboxFeatures(ctx, nil)
	}
	return e.inbox(ctx, e.modesFor(ctx, scope))
}
