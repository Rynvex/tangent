package tangent

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"

	"github.com/Rynvex/tangent/domain"
)

// Turns can run in another process than the one clients talk to (the API
// process). The API process stays the only one that numbers deltas: its
// buffer, its message.delta events and the streamSeq of saved partials all
// share one sequence. A worker process (an Engine over the same database)
// rebuilds the turn with LoadTurn, runs it, and forwards its deltas through
// a DeltaSink to the API process's AppendDelta. Each process's events go to
// the other through the host's channel, where Observe keeps the receiving
// Engine's memory in step. See docs/EMBEDDING.md §3.4.

// RemoteDelta is one streamed piece of a turn on its way to the API
// process: hand Delta to that process's AppendDelta(ctx, TurnID, Delta).
// Tenant, LineID and RootLineID say where the turn lives, for routing.
type RemoteDelta struct {
	TurnID     string       `json:"turnId"`
	Tenant     string       `json:"tenant"`
	LineID     string       `json:"lineId"`
	RootLineID string       `json:"rootLineId"`
	Delta      domain.Delta `json:"delta"`
}

// DeltaSink takes the deltas of an Engine built WithDeltaSink. Its error is
// returned by AppendDelta: a synchronous channel that answers
// turn_not_pending stops RunTurn's model.
type DeltaSink interface {
	SendDelta(ctx context.Context, d RemoteDelta) error
}

// WithDeltaSink makes AppendDelta (and RunTurn's streaming) forward every
// valid delta of a pending turn to the sink instead of buffering it,
// filtering it, saving partials or publishing message.delta here: the
// Engine of a worker process whose deltas the API process numbers.
func WithDeltaSink(s DeltaSink) Option {
	return func(c *config) { c.deltaSink = s }
}

// sendRemote forwards a delta of a known turn to the sink.
func (e *Engine) sendRemote(ctx context.Context, ref turnRef, d domain.Delta) error {
	return e.deltaSink.SendDelta(ctx, RemoteDelta{TurnID: ref.turnID, Tenant: ref.tenant, LineID: ref.lineID, RootLineID: ref.rootLineID, Delta: d})
}

// LoadTurn rebuilds a pending turn by its id, as BeginTurn (or RetryTurn)
// returned it: a durable queue only needs to keep the id. The prompt is
// built again from what is stored now: the operator message, the cards and
// notes revision the turn recorded, the features' context and the host's
// PromptContributor. The scope's tenant must be the turn's; the returned
// Turn has the turn's own scope (the actor who began it). A turn that ended,
// does not exist or belongs to another tenant returns ErrTurnNotPending. A
// prompt that cannot be built is returned as an error; the turn stays
// pending (fail it with CompleteTurn, or let Maintain).
func (e *Engine) LoadTurn(ctx context.Context, scope Scope, turnID string) (Turn, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return Turn{}, err
	}
	begun, err := e.store.LoadTurn(ctx, scope.Tenant, turnID)
	if err != nil {
		e.forgetTurnIfEnded(turnID, err)
		return Turn{}, err
	}
	own := Scope{Tenant: scope.Tenant, Actor: cmp.Or(begun.Pending.Meta.Actor, scope.Actor)}
	e.turns.put(turnRef{turnID: begun.Pending.ID, tenant: own.Tenant, actor: own.Actor, lineID: begun.Line.ID, rootLineID: begun.RootLineID})
	modes := e.modesFor(ctx, own)
	ctx = e.inbox(ctx, modes)
	turn := Turn{
		ID: begun.Pending.ID, Scope: own, LineID: begun.Line.ID, RootLineID: begun.RootLineID, UserMessage: begun.User, Pending: begun.Pending,
		Provider: cmp.Or(begun.Pending.Meta.Provider, begun.Line.Provider), Model: cmp.Or(begun.Pending.Meta.Model, begun.Line.Model),
	}
	if turn.Prompt, err = e.turnPrompt(ctx, own, modes, begun); err != nil {
		return Turn{}, err
	}
	return turn, nil
}

// TurnPending reports whether the turn is still pending for the scope's
// tenant: false once it was completed, cancelled or failed as stale (and for
// an unknown id or another tenant's turn). A worker that cannot observe the
// API process's events asks it to learn about a cancel.
func (e *Engine) TurnPending(ctx context.Context, scope Scope, turnID string) (bool, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return false, err
	}
	ref, err := e.store.GetTurn(ctx, turnID)
	if errors.Is(err, domain.ErrTurnNotPending) {
		e.forgetTurnIfEnded(turnID, err)
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return ref.Tenant == scope.Tenant, nil
}

// Observe tells the Engine about events another Engine over the same
// database published (another process), so what this process holds in
// memory follows: a reply that is no longer pending ends the turn here (the
// text its line filter still held is streamed, as CompleteTurn does, then
// its run in this process is stopped), and deleted lines drop their delta
// buffers and remembered turns. Data may be the typed value or its JSON
// (json.RawMessage, or anything that marshals to it). Observe never
// publishes the events it is given; call it before handing them to this
// process's own hub, and forward each Engine's own events only.
func (e *Engine) Observe(ctx context.Context, events ...Event) {
	for _, ev := range events {
		switch ev.Type {
		case EventMessageUpdated:
			if message, ok := eventData[domain.Message](ev.Data); ok && endedReply(message) {
				e.observeTurnEnded(ctx, message.ID)
			}
		case EventLineDeleted:
			if deleted, ok := eventData[LinesDeleted](ev.Data); ok {
				e.forgetLines(ev.Tenant, deleted.LineIDs, nil)
			}
		}
	}
}

// endedReply is a chat reply that is no longer pending.
func endedReply(m domain.Message) bool {
	return m.ID != "" && m.Role == domain.RoleAssistant && m.Kind == domain.MessageKindChat && m.Status != domain.MessagePending
}

// observeTurnEnded ends what this process holds of a turn another process
// ended.
func (e *Engine) observeTurnEnded(ctx context.Context, turnID string) {
	if ref, ok := e.turns.get(turnID); ok {
		e.flushStream(ctx, ref)
	} else {
		e.streams.finish(turnID, e.now())
	}
	e.turns.drop(turnID)
	e.inflight.cancel(turnID)
}

// eventData reads an event's data as T: the value itself, or its JSON.
func eventData[T any](data any) (T, bool) {
	var out T
	switch v := data.(type) {
	case T:
		return v, true
	case *T:
		if v != nil {
			return *v, true
		}
		return out, false
	case nil:
		return out, false
	case json.RawMessage:
		return out, json.Unmarshal(v, &out) == nil
	case []byte:
		return out, json.Unmarshal(v, &out) == nil
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return out, false
	}
	return out, json.Unmarshal(raw, &out) == nil
}
