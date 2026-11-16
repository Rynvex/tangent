package embedding

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// HostTurnQueueDDL is the host's own queue table of the remote-worker
// example (the host's migrations create it, not tangent's).
const HostTurnQueueDDL = `CREATE TABLE host_turn_queue (
	turn_id UUID PRIMARY KEY,
	tenant TEXT NOT NULL,
	queued_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`

// snippet:remote-queue
// QueueTurns is httpapi.Config.TxOptions for a durable turn queue: a sent or
// retried message writes its turn id into the host's queue in the same
// transaction, so a crash right after the commit loses nothing. Only the id
// is queued; the worker rebuilds the turn with LoadTurn.
func QueueTurns(_ *http.Request, op string) []tangent.TxOption {
	if op != httpapi.OpTurnsSend && op != httpapi.OpTurnsRetry {
		return nil
	}
	return []tangent.TxOption{tangent.InTx(func(ctx context.Context, tx store.Tx, result any) error {
		begun, ok := result.(store.BegunTurn)
		if !ok {
			return fmt.Errorf("queue hook: unexpected result %T", result)
		}
		_, err := tx.Exec(ctx, `INSERT INTO host_turn_queue (turn_id, tenant) VALUES ($1, $2)`, begun.Pending.ID, begun.Line.TenantID)
		return err
	})}
}

// QueuedDispatcher is the API process's Dispatcher when turns run in workers:
// the turn is already queued (QueueTurns), so DispatchTurn only wakes a
// worker (a NOTIFY, say). Jobs run where Jobs says.
type QueuedDispatcher struct {
	Wake func()
	Jobs tangent.Dispatcher
}

func (d QueuedDispatcher) DispatchTurn(context.Context, tangent.Turn) error {
	d.Wake()
	return nil
}

func (d QueuedDispatcher) DispatchJob(ctx context.Context, j tangent.Job) error {
	return d.Jobs.DispatchJob(ctx, j)
}

// endsnippet

// snippet:remote-wire
// DeltaSender is a worker's DeltaSink (tangent.WithDeltaSink): every delta
// goes to the API process over the host's channel (HTTP, NATS, Postgres
// NOTIFY…), Send here. The API process numbers it.
type DeltaSender struct {
	Send func(ctx context.Context, payload []byte) error
}

func (s DeltaSender) SendDelta(ctx context.Context, d tangent.RemoteDelta) error {
	payload, err := json.Marshal(d)
	if err != nil {
		return err
	}
	return s.Send(ctx, payload)
}

// ReceiveDelta is the API process's end: the delta joins its buffer (GET
// /stream) and goes out as message.delta, as if the turn ran there.
func ReceiveDelta(ctx context.Context, api *tangent.Engine, payload []byte) error {
	var d tangent.RemoteDelta
	if err := json.Unmarshal(payload, &d); err != nil {
		return err
	}
	return api.AppendDelta(ctx, d.TurnID, d.Delta)
}

// EventSender is a Publisher that forwards one process's own events to the
// other process.
type EventSender struct {
	Send func(ctx context.Context, payload []byte) error
	Log  *slog.Logger
}

func (s EventSender) Publish(ctx context.Context, ev tangent.Event) {
	payload, err := json.Marshal(ev)
	if err == nil {
		err = s.Send(ctx, payload)
	}
	if err != nil {
		s.Log.Warn("event not forwarded", "type", ev.Type, "error", err)
	}
}

// ReceiveEvent is the other end: the Engine catches up first (a turn that
// ended over there stops here, its last held text is streamed), then this
// process's own hub, if it has one, gets the event. It is never forwarded
// back.
func ReceiveEvent(ctx context.Context, engine *tangent.Engine, hub tangent.Publisher, payload []byte) error {
	var ev tangent.Event
	if err := json.Unmarshal(payload, &ev); err != nil {
		return err
	}
	engine.Observe(ctx, ev)
	if hub != nil {
		hub.Publish(ctx, ev)
	}
	return nil
}

// endsnippet

// snippet:remote-worker
// Worker runs turns in another process: its own Engine over the same
// database, built WithDeltaSink(DeltaSender{…}) and publishing through an
// EventSender, claims queued turn ids, rebuilds each turn and runs it.
type Worker struct {
	Engine *tangent.Engine
	Model  tangent.Runner
	Pool   *pgxpool.Pool
}

// RunOne claims one queued turn and runs it; false when the queue is empty.
// (A production queue marks a row claimed and deletes it after the run; a
// turn lost in a crash is failed as stale by Maintain either way.)
func (w Worker) RunOne(ctx context.Context) (bool, error) {
	var tenant, turnID string
	err := w.Pool.QueryRow(ctx, `DELETE FROM host_turn_queue WHERE turn_id = (
		SELECT turn_id FROM host_turn_queue ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1
	) RETURNING tenant, turn_id::text`).Scan(&tenant, &turnID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	turn, err := w.Engine.LoadTurn(ctx, tangent.Scope{Tenant: tenant}, turnID)
	if errors.Is(err, domain.ErrTurnNotPending) {
		return true, nil // cancelled or failed meanwhile: nothing to run
	}
	if err != nil {
		return true, err
	}
	// Deltas go through the sink; a cancel in the API process reaches this
	// run through ReceiveEvent (or poll TurnPending without an event channel).
	done, err := w.Engine.RunTurn(ctx, turn, w.Model)
	if err != nil && !errors.Is(err, domain.ErrTurnNotPending) {
		return true, err
	}
	for _, job := range done.Jobs {
		runJobInline(ctx, w.Engine, w.Model, job)
	}
	return true, nil
}

// endsnippet
