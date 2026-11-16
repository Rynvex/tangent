package tangent

import (
	"context"
	"errors"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// TurnResult is what running a turn produced. A non-empty Error fails the
// turn; it is stored and published, so it must be a text meant for the
// operator, never a raw upstream error. Provider and Model, when set, name
// what actually ran. Notices are host system messages written right after
// the reply, in order, in the same transaction (a failed reply gets them
// too; blank ones are left out, at most 16).
type TurnResult struct {
	Content    string
	Error      string
	Usage      *domain.Usage
	DurationMs int64
	Provider   string
	Model      string
	Notices    []SystemNotice
}

// CompletedTurn is a finished turn: the line (idle or error) and the reply.
// SummaryDue reports that a summary is due (the summary feature in suggest
// mode); Jobs are background jobs the features started (the summary feature
// in auto mode) for the caller to dispatch. EndedAside is the aside this
// turn answered and so ended. Notices are the host system messages written
// after the reply.
type CompletedTurn struct {
	Line       domain.LineView
	Message    domain.Message
	RootLineID string
	SummaryDue bool
	Jobs       []Job
	EndedAside *domain.BranchView
	Notices    []domain.Message
}

// CompleteTurn finishes a pending turn, once: a turn that is no longer
// pending returns ErrTurnNotPending. The scope is the turn's own (tenant and
// the actor who began it). A successful reply passes the features' reply
// filters; OnTurnCompleted hooks (and OnBranchClosed for an aside the answer
// ended) run in the transaction, AfterCommit hooks after it. Notices that
// are too many, too long or carry host data that is not a JSON object are
// refused (invalid_input, too_long) and the turn stays pending.
//
// Runner side only: the bare turn id carries no tenant check, so this must
// never be reachable by clients (httpapi does not route it).
// InTx hooks receive store.CompletedTurn.
func (e *Engine) CompleteTurn(ctx context.Context, turnID string, r TurnResult, opts ...TxOption) (CompletedTurn, error) {
	notices, err := e.cleanNotices(r.Notices)
	if err != nil {
		return CompletedTurn{}, err
	}
	ref, err := e.turnRefFor(ctx, turnID)
	if err != nil {
		e.streams.finish(turnID, e.now())
		return CompletedTurn{}, err
	}
	e.flushStream(ctx, ref)
	scope := ref.scope()
	modes := e.modesFor(ctx, scope)
	ctx = e.inbox(ctx, modes)
	outcome := domain.ResolveTurnOutcome(r.Content, r.Error)
	reply := replyParts{content: outcome.Content}
	var marked *turnReply
	if !outcome.Failed {
		marked = e.extractTitleLines(&reply, ref.asks)
		e.filterReply(modes, &reply)
	}
	outcome.Content = reply.content
	call := newTxCall(modes, scope, commitTurnCompleted, nil)
	done, err := e.store.CompleteTurn(ctx, store.CompleteTurnInput{
		TurnID: turnID, Outcome: outcome, Usage: r.Usage, DurationMs: r.DurationMs, Suggestions: reply.suggestions,
		Provider: r.Provider, Model: r.Model, SkipNotesRevision: true, Notices: notices,
	}, e.turnTxHooks(call, opts)...)
	e.forgetTurnIfEnded(turnID, err)
	if err != nil {
		return CompletedTurn{}, err
	}
	e.turns.drop(turnID)
	return e.afterTurnCompleted(ctx, scope, modes, done, call.out, marked), nil
}

// recordFailedText is the turn error when its result could not be recorded
// (a feature hook refused it).
const recordFailedText = "the reply could not be recorded"

// failTurn ends a turn as failed without any feature hook in the
// transaction, so a hook that keeps failing cannot leave the turn pending:
// the line leaves "thinking" at once. AfterCommit still runs; its jobs are
// returned. Problems are logged.
func (e *Engine) failTurn(ctx context.Context, turnID, text string) CompletedTurn {
	e.streams.finish(turnID, e.now())
	writeCtx, done := detached(ctx)
	defer done()
	ref, _ := e.turns.get(turnID)
	stored, err := e.store.CompleteTurn(writeCtx, store.CompleteTurnInput{
		TurnID: turnID, Outcome: domain.ResolveTurnOutcome("", text), SkipNotesRevision: true,
	})
	e.forgetTurnIfEnded(turnID, err)
	if err != nil {
		if !isNotPending(err) {
			e.log.Error("tangent: failing a turn failed", "turn", turnID, "error", err)
		}
		return CompletedTurn{}
	}
	e.turns.drop(turnID)
	scope := Scope{Tenant: stored.Tenant, Actor: ref.actor}
	return e.afterTurnCompleted(writeCtx, scope, e.modesFor(writeCtx, scope), stored, nil, nil)
}

// afterTurnCompleted publishes a completed turn, applies the [TOPIC] title
// the reply carried (marked; nil for a failed turn) and runs AfterCommit
// (for the turn, and for an aside the answer ended).
func (e *Engine) afterTurnCompleted(ctx context.Context, scope Scope, modes modeSet, done store.CompletedTurn, outbox *txOutbox, marked *turnReply) CompletedTurn {
	out := CompletedTurn{Line: done.Line, Message: done.Message, RootLineID: done.RootLineID, Notices: done.Notices}
	events := []Event{messageEvent(EventMessageUpdated, done.Tenant, done.RootLineID, done.Message)}
	for _, notice := range done.Notices {
		events = append(events, messageEvent(EventMessageCreated, done.Tenant, done.RootLineID, notice))
	}
	for _, card := range done.DeliveredCards {
		events = append(events, messageEvent(EventMessageUpdated, done.Tenant, done.RootLineID, card))
	}
	e.publish(ctx, append(events, lineEvent(EventLineUpdated, done.Line))...)
	if done.EndedAsideLineID != "" {
		// The aside's own line.updated went out above; only its parent changed besides.
		out.EndedAside = e.publishBranchEnded(ctx, scope, done.EndedAsideLineID, BranchDiscarded, false)
		if out.EndedAside != nil {
			out.Jobs = e.commit(ctx, &commitEvent{kind: commitBranchClosed, scope: scope, modes: modes, change: BranchDiscarded, branch: out.EndedAside, out: outbox})
		}
	}
	if marked != nil && marked.topic != "" {
		out.Line = e.applyTopic(ctx, scope, out.Line, marked)
	}
	out.Jobs = append(out.Jobs, e.commit(ctx, &commitEvent{kind: commitTurnCompleted, scope: scope, modes: modes, turn: &out, reply: marked, out: outbox})...)
	return out
}

// SetJobDispatcher names where jobs go that no caller receives: those the
// AfterCommit hooks start while a turn is failed inside BeginTurn. Without
// one they are logged and left to FailStaleJobs.
func (e *Engine) SetJobDispatcher(d Dispatcher) {
	e.jobsMu.Lock()
	defer e.jobsMu.Unlock()
	e.jobSink = d
}

// dispatchOrphanJobs hands jobs nobody receives to the job dispatcher.
func (e *Engine) dispatchOrphanJobs(ctx context.Context, jobs []Job) {
	if len(jobs) == 0 {
		return
	}
	e.jobsMu.Lock()
	sink := e.jobSink
	e.jobsMu.Unlock()
	for _, job := range jobs {
		if sink == nil {
			e.log.Warn("tangent: a job has no dispatcher", "job", job.ID, "kind", job.Kind)
			continue
		}
		if err := sink.DispatchJob(ctx, job); err != nil {
			e.log.Warn("tangent: job not dispatched", "job", job.ID, "error", err)
			e.failRefusedJob(ctx, job, err)
		}
	}
}

// publishBranchEnded re-reads a branch that changed and publishes it with
// its parent line (whose branch counts changed) and, withSelf, its own line
// (whose branch record changed). It returns the view, nil when it could not
// be read.
func (e *Engine) publishBranchEnded(ctx context.Context, scope Scope, lineID, change string, withSelf bool) *domain.BranchView {
	detail, err := e.store.GetBranch(ctx, scope.Tenant, lineID)
	if err != nil {
		e.log.Warn("tangent: reload of an ended branch failed", "line", lineID, "error", err)
		return nil
	}
	events := []Event{branchEvent(scope.Tenant, change, detail.Branch)}
	reload := []string{detail.Branch.ParentLineID}
	if withSelf {
		reload = append(reload, lineID)
	}
	events = append(events, e.lineEvents(ctx, scope, reload...)...)
	e.publish(ctx, events...)
	return &detail.Branch
}

// lineEvents re-reads lines after a commit and returns their line.updated
// events; a line that cannot be read (it went away meanwhile) is skipped.
func (e *Engine) lineEvents(ctx context.Context, scope Scope, lineIDs ...string) []Event {
	events := make([]Event, 0, len(lineIDs))
	for _, id := range lineIDs {
		line, err := e.store.GetLine(ctx, scope.Tenant, id)
		if err != nil {
			e.log.Warn("tangent: reload of a changed line failed", "line", id, "error", err)
			continue
		}
		events = append(events, lineEvent(EventLineUpdated, line))
	}
	return events
}

// cancelText is the text a cancelled turn keeps: what this process
// streamed (marker lines left out), else the partial saved on the pending
// message plus the buffered deltas after it.
func (e *Engine) cancelText(scope Scope, pending domain.Message) string {
	if text, ok := e.streams.snapshot(pending.ID); ok {
		return text
	}
	if run, ok := e.inflight.get(pending.ID); ok {
		return run.partial()
	}
	return pending.Content + e.deltas.text(scope.Tenant, pending.LineID, pending.ID, pending.Meta.StreamSeq)
}

// CancelledTurn is what CancelTurn did; Cancelled is false when the line had
// no turn in flight.
type CancelledTurn = store.CancelledTurn

// CancelTurn ends the line's pending turn, keeping the text streamed so far
// (complete for a run of this process, else what the delta buffer holds),
// and stops its run when this process runs it. Only the turn that was
// pending when the call started is cancelled: if it finished and another
// began meanwhile, nothing changes. Without a pending turn nothing is
// written (and the hooks do not run).
// InTx hooks receive store.CancelledTurn.
func (e *Engine) CancelTurn(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (CancelledTurn, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return CancelledTurn{}, err
	}
	ctx = e.inboxFor(ctx, scope)
	pending, ok, err := e.store.PendingTurn(ctx, scope.Tenant, lineID)
	if err != nil {
		return CancelledTurn{}, err
	}
	if !ok {
		line, err := e.store.GetLine(ctx, scope.Tenant, lineID)
		return CancelledTurn{Line: line}, err
	}
	partial := e.cancelText(scope, pending)
	out, err := e.store.CancelTurnFor(ctx, scope.Tenant, lineID, pending.ID, partial, hooksOf(opts)...)
	if err == nil && out.Cancelled {
		e.streams.finish(pending.ID, e.now())
	}
	if err != nil || !out.Cancelled {
		return out, err
	}
	e.inflight.cancel(out.Message.ID)
	e.turns.drop(out.Message.ID)
	root := rootOfView(out.Line)
	e.publish(ctx, messageEvent(EventMessageUpdated, scope.Tenant, root, out.Message), lineEvent(EventLineUpdated, out.Line))
	return out, nil
}

// StaleTurn is one pending turn FailStaleTurns ended.
type StaleTurn = store.StaleTurn

// FailStaleTurns fails every turn that has been pending since before
// olderThan (at most 200 per call). On an error it returns the turns already
// failed with the error.
func (e *Engine) FailStaleTurns(ctx context.Context, olderThan time.Time) ([]StaleTurn, error) {
	maxAge := e.now().Sub(olderThan)
	if maxAge <= 0 {
		return nil, domain.NewError(domain.CodeInvalidInput, "olderThan must lie in the past", nil)
	}
	stale, err := e.store.FailStaleTurns(ctx, maxAge)
	for _, turn := range stale {
		e.turns.drop(turn.Message.ID)
		e.inflight.cancel(turn.Message.ID)
		root := rootOfView(turn.Line)
		e.publish(ctx, messageEvent(EventMessageUpdated, turn.Tenant, root, turn.Message), lineEvent(EventLineUpdated, turn.Line))
	}
	return stale, err
}

// isNotPending reports a turn or job that already finished or went away.
func isNotPending(err error) bool {
	return errors.Is(err, domain.ErrTurnNotPending) || errors.Is(err, domain.ErrJobNotPending) ||
		errors.Is(err, domain.ErrDraftNotPending) || errors.Is(err, domain.ErrJobNotFound)
}

// failRefusedJob ends a job no dispatcher took, so it does not wait for the
// stale-job sweep.
func (e *Engine) failRefusedJob(ctx context.Context, job Job, cause error) {
	writeCtx, done := detached(ctx)
	defer done()
	if err := e.FinishJob(writeCtx, job.ID, "", cause); err != nil && !isNotPending(err) {
		e.log.Warn("tangent: refused job not failed", "job", job.ID, "error", err)
	}
}
