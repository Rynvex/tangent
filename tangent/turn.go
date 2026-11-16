package tangent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// TurnInput is the operator's message that starts a turn.
type TurnInput struct {
	Content  string
	HostMeta json.RawMessage
}

// Turn is a started turn: the operator's message, the pending assistant
// message (its id is the turn id) and the prompt to run.
type Turn struct {
	ID          string
	Scope       Scope
	LineID      string
	RootLineID  string
	UserMessage domain.Message
	Pending     domain.Message
	Prompt      domain.Prompt
	Provider    string
	Model       string
}

// historyMargin is what a turn reads beyond HistoryScan: its own operator
// message and pending reply, which HistoryBeforeTurn removes again.
const historyMargin = 2

// errEmptyContent refuses a turn without text.
var errEmptyContent = domain.NewError(domain.CodeInvalidInput, "content is required", nil)

// BeginTurn starts a turn: the TurnGate is asked first (outside the
// transaction), then the operator's message and a pending reply are stored
// and the line goes thinking, under the line's lock; the prompt is built
// after the commit. If the prompt cannot be built the turn is failed at once.
// InTx hooks receive store.BegunTurn.
func (e *Engine) BeginTurn(ctx context.Context, scope Scope, lineID string, in TurnInput, opts ...TxOption) (Turn, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return Turn{}, err
	}
	if strings.TrimSpace(in.Content) == "" {
		return Turn{}, errEmptyContent
	}
	if err := checkText("content", strings.TrimSpace(in.Content), e.limits.Text.MessageMaxRunes); err != nil {
		return Turn{}, err
	}
	if err := e.askGate(ctx, scope, lineID); err != nil {
		return Turn{}, err
	}
	modes := e.modesFor(ctx, scope)
	ctx = e.inbox(ctx, modes)
	begun, err := e.store.BeginTurn(ctx, store.BeginTurnInput{
		Tenant: scope.Tenant, LineID: lineID, Content: strings.TrimSpace(in.Content), HostMeta: in.HostMeta, Actor: scope.Actor,
	}, hooksOf(opts)...)
	if err != nil {
		return Turn{}, err
	}
	e.turns.put(turnRef{turnID: begun.Pending.ID, tenant: scope.Tenant, actor: scope.Actor, lineID: begun.Line.ID, rootLineID: begun.RootLineID})
	e.publish(ctx,
		messageEvent(EventMessageCreated, scope.Tenant, begun.RootLineID, begun.User),
		messageEvent(EventMessageCreated, scope.Tenant, begun.RootLineID, begun.Pending),
		lineEvent(EventLineUpdated, begun.Line),
	)
	turn := Turn{
		ID: begun.Pending.ID, Scope: scope, LineID: begun.Line.ID, RootLineID: begun.RootLineID,
		UserMessage: begun.User, Pending: begun.Pending, Provider: begun.Line.Provider, Model: begun.Line.Model,
	}
	if turn.Prompt, err = e.turnPrompt(ctx, scope, modes, begun); err != nil {
		return Turn{}, e.failUnbuiltTurn(ctx, turn.ID, err)
	}
	return turn, nil
}

// askGate asks the host's TurnGate about the line; without a gate nothing
// is read.
func (e *Engine) askGate(ctx context.Context, scope Scope, lineID string) error {
	if e.gate == nil {
		return nil
	}
	line, err := e.store.GetLine(ctx, scope.Tenant, lineID)
	if err != nil {
		return err
	}
	return e.gate.AllowTurn(ctx, scope, line)
}

// turnPrompt reads, after the commit, what the begun turn's prompt shows.
func (e *Engine) turnPrompt(ctx context.Context, scope Scope, modes modeSet, begun store.BegunTurn) (domain.Prompt, error) {
	built, err := e.assemblePrompt(ctx, promptSource{
		scope: scope, modes: modes, line: begun.Line, cards: begun.Cards, userMessage: begun.User.Content,
		begun: &beginInfo{
			pendingID: begun.Pending.ID, userID: begun.User.ID, rootLineID: begun.RootLineID,
			notesRevision: begun.NotesRevision, notesSent: begun.NotesRevisionSent,
		},
	})
	if err == nil {
		e.turns.setAsks(begun.Pending.ID, built.asks)
	}
	return built.prompt, err
}

// promptFailedText is the turn error when its prompt could not be built.
const promptFailedText = "the prompt could not be assembled"

// failUnbuiltTurn fails a turn whose prompt could not be built (without
// feature hooks, see failTurn) and returns the cause.
func (e *Engine) failUnbuiltTurn(ctx context.Context, turnID string, cause error) error {
	e.dispatchOrphanJobs(ctx, e.failTurn(ctx, turnID, promptFailedText).Jobs)
	return cause
}

// AppendDelta buffers a streamed piece of a pending turn's reply and
// publishes it as message.delta. The turn is looked up once and remembered.
// Text is filtered by line: a line that starts with a protocol marker is
// never streamed, and the start of a line is held until it cannot become
// one (CompleteTurn flushes the rest). Every DefaultPartialInterval or
// DefaultPartialBytes of text (WithPartialFlush) the text streamed so far is
// saved on the pending message with meta.streamSeq.
//
// An Engine built WithDeltaSink forwards the delta to its sink instead (a
// worker process); the API process's AppendDelta is where such deltas
// arrive.
//
// Runner side only: the bare turn id carries no tenant check, so this must
// never be reachable by clients (httpapi does not route it).
func (e *Engine) AppendDelta(ctx context.Context, turnID string, d domain.Delta) error {
	if !domain.ValidDeltaKind(d.Kind) {
		return domain.NewError(domain.CodeInvalidInput, "delta kind must be text, reasoning or tool", nil)
	}
	ref, err := e.turnRefFor(ctx, turnID)
	if err != nil {
		return err
	}
	if e.deltaSink != nil {
		return e.sendRemote(ctx, ref, d)
	}
	if d.Kind != domain.DeltaText {
		e.emitDelta(ctx, ref, d)
		return nil
	}
	now := e.now()
	if d.Text = e.streams.push(ref.turnID, d.Text, now); d.Text == "" {
		return nil // held (an undecided line) or dropped (a marker line)
	}
	stored := e.emitDelta(ctx, ref, d)
	if partial, due := e.streams.emitted(ref.turnID, stored.Text, stored.Seq, now); due {
		e.savePartial(ctx, ref.turnID, partial)
	}
	return nil
}

// savePartial keeps the text streamed so far on the pending message (no
// event: clients follow the deltas).
func (e *Engine) savePartial(ctx context.Context, turnID string, p partialReply) {
	if _, err := e.store.SavePartialReply(ctx, turnID, p.content, p.seq); err != nil {
		e.log.Warn("tangent: partial reply not saved", "turn", turnID, "error", err)
	}
}

// emitDelta buffers a delta and publishes it as message.delta.
func (e *Engine) emitDelta(ctx context.Context, ref turnRef, d domain.Delta) domain.Delta {
	d.TurnID = ref.turnID
	stored := e.deltas.append(ref.tenant, ref.lineID, d)
	e.publish(ctx, Event{Type: EventMessageDelta, Tenant: ref.tenant, RootLineID: ref.rootLineID, LineID: ref.lineID, Data: stored})
	return stored
}

// flushStream emits what a finished turn's line filter still held (the
// last line, once it is clear it is not a marker line).
func (e *Engine) flushStream(ctx context.Context, ref turnRef) {
	if rest := e.streams.finish(ref.turnID, e.now()); rest != "" {
		e.emitDelta(ctx, ref, domain.Delta{Kind: domain.DeltaText, Text: rest})
	}
}

// turnRefFor finds where a pending turn lives: remembered, or read once.
func (e *Engine) turnRefFor(ctx context.Context, turnID string) (turnRef, error) {
	if ref, ok := e.turns.get(turnID); ok {
		return ref, nil
	}
	found, err := e.store.GetTurn(ctx, turnID)
	if err != nil {
		e.forgetTurnIfEnded(turnID, err)
		return turnRef{}, err
	}
	ref := turnRef{turnID: found.TurnID, tenant: found.Tenant, actor: found.Actor, lineID: found.LineID, rootLineID: found.RootLineID}
	e.turns.put(ref)
	return ref, nil
}

// forgetTurnIfEnded drops a remembered turn once a call learned that it is
// no longer pending.
func (e *Engine) forgetTurnIfEnded(turnID string, err error) {
	if errors.Is(err, domain.ErrTurnNotPending) {
		e.turns.drop(turnID)
	}
}

// StreamSince returns the buffered deltas of a line after afterSeq (a
// reconnecting client catches up with it). The buffer is per process and
// bounded; Truncated says deltas after the cursor are gone and the client
// must reload the messages.
func (e *Engine) StreamSince(ctx context.Context, scope Scope, lineID string, afterSeq int64) (DeltaTail, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return DeltaTail{}, err
	}
	return e.deltas.since(scope.Tenant, lineID, afterSeq), nil
}

// RetryTurn runs the line's last turn again when it failed: the failed reply
// stays (status error, left out of every prompt's history) and a new pending
// reply is started for the same operator message, which is not duplicated.
// It refuses a line with a pending turn (turn_pending) or whose last turn did
// not fail (nothing_to_retry); the TurnGate is asked first, as for BeginTurn.
// InTx hooks receive store.BegunTurn.
func (e *Engine) RetryTurn(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (Turn, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return Turn{}, err
	}
	if err := e.askGate(ctx, scope, lineID); err != nil {
		return Turn{}, err
	}
	modes := e.modesFor(ctx, scope)
	ctx = e.inbox(ctx, modes)
	begun, err := e.store.RetryTurn(ctx, store.RetryTurnInput{Tenant: scope.Tenant, LineID: lineID, Actor: scope.Actor}, hooksOf(opts)...)
	if err != nil {
		return Turn{}, err
	}
	e.turns.put(turnRef{turnID: begun.Pending.ID, tenant: scope.Tenant, actor: scope.Actor, lineID: begun.Line.ID, rootLineID: begun.RootLineID})
	e.publish(ctx,
		messageEvent(EventMessageCreated, scope.Tenant, begun.RootLineID, begun.Pending),
		lineEvent(EventLineUpdated, begun.Line),
	)
	turn := Turn{
		ID: begun.Pending.ID, Scope: scope, LineID: begun.Line.ID, RootLineID: begun.RootLineID,
		UserMessage: begun.User, Pending: begun.Pending, Provider: begun.Line.Provider, Model: begun.Line.Model,
	}
	if turn.Prompt, err = e.turnPrompt(ctx, scope, modes, begun); err != nil {
		return Turn{}, e.failUnbuiltTurn(ctx, turn.ID, err)
	}
	return turn, nil
}
