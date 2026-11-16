package httpapi

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

// dispatchFailedText is stored on a turn the dispatcher refused.
const dispatchFailedText = "the turn could not be started"

// writeBackTimeout bounds cleaning up after a refused dispatch.
const writeBackTimeout = 15 * time.Second

func (a *api) listMessages(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	after, err := c.queryInt("afterSeq", 0, math.MaxInt64)
	if err != nil {
		return 0, nil, err
	}
	limit, err := c.queryInt("limit", 1, maxMessagePageQuery)
	if err != nil {
		return 0, nil, err
	}
	messages, err := a.engine.ListMessages(c.ctx, c.scope, id, after, int(limit))
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, messagePage{Messages: list(messages)}, nil
}

// contentBody is POST /messages and /preview.
type contentBody struct {
	Content  string          `json:"content"`
	HostMeta json.RawMessage `json:"hostMeta"`
}

func (a *api) sendMessage(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in contentBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	if hasHostMeta(in.HostMeta) {
		return 0, nil, errHostMeta
	}
	meta, err := c.hostMeta()
	if err != nil {
		return 0, nil, err
	}
	turn, err := a.engine.BeginTurn(c.ctx, c.scope, id, tangent.TurnInput{Content: in.Content, HostMeta: meta}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return a.dispatchTurn(c, turn)
}

// retryTurn is POST /lines/{id}/retry: the last, failed turn runs again.
func (a *api) retryTurn(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	turn, err := a.engine.RetryTurn(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return a.dispatchTurn(c, turn)
}

// dispatchTurn hands a started turn to the dispatcher (202); a turn the
// dispatcher refuses is failed at once (503).
func (a *api) dispatchTurn(c *call, turn tangent.Turn) (int, any, error) {
	if err := a.dispatcher.DispatchTurn(c.ctx, turn); err != nil {
		a.log.Warn("tangent httpapi: turn not dispatched", "turn", turn.ID, "error", err)
		ctx, cancel := detached(c.ctx)
		defer cancel()
		if _, failErr := a.engine.CompleteTurn(ctx, turn.ID, tangent.TurnResult{Error: dispatchFailedText}); failErr != nil {
			a.log.Error("tangent httpapi: undispatched turn not failed", "turn", turn.ID, "error", failErr)
		}
		return 0, nil, apiError(CodeUnavailable, "the turn could not be started; try again")
	}
	return http.StatusAccepted, turnStarted{TurnID: turn.ID, UserMessage: turn.UserMessage, PendingMessage: turn.Pending}, nil
}

func (a *api) streamSince(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	after, err := c.queryInt("afterSeq", 0, math.MaxInt64)
	if err != nil {
		return 0, nil, err
	}
	// The buffer is per tenant already; reading the line answers 404 for a
	// line the caller cannot see, like every other route.
	if _, err := a.engine.GetLine(c.ctx, c.scope, id); err != nil {
		return 0, nil, err
	}
	tail, err := a.engine.StreamSince(c.ctx, c.scope, id, after)
	if err != nil {
		return 0, nil, err
	}
	tail.Deltas = list(a.readerFilter(c.r).all(id, tail.Deltas))
	return http.StatusOK, tail, nil
}

func (a *api) cancelTurn(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	out, err := a.engine.CancelTurn(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	body := cancelledTurn{Cancelled: out.Cancelled, Line: out.Line}
	if out.Cancelled {
		body.Message = &out.Message
	}
	return http.StatusOK, body, nil
}

func (a *api) preview(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in contentBody
	if err := c.body(&in, false); err != nil {
		return 0, nil, err
	}
	preview, err := a.engine.PreviewTurn(c.ctx, c.scope, id, in.Content)
	if err != nil {
		return 0, nil, err
	}
	preview.Blocks = list(preview.Blocks)
	return http.StatusOK, preview, nil
}

func (a *api) compact(c *call) (int, any, error) {
	return a.startJob(c, a.engine.StartSummary)
}

func (a *api) startDraft(c *call) (int, any, error) {
	return a.startJob(c, a.engine.StartDraft)
}

// startJob starts a job on the line and hands it to the dispatcher; a job
// the dispatcher refuses is failed at once.
func (a *api) startJob(c *call, start func(context.Context, tangent.Scope, string, ...tangent.TxOption) (tangent.Job, error)) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	job, err := start(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return a.dispatchStarted(c, job)
}

// dispatchStarted hands a started job to the dispatcher and answers 202; a
// job the dispatcher refuses is failed (503).
func (a *api) dispatchStarted(c *call, job tangent.Job) (int, any, error) {
	if err := a.dispatcher.DispatchJob(c.ctx, job); err != nil {
		a.log.Error("tangent httpapi: job not dispatched", "job", job.ID, "kind", job.Kind, "error", err)
		ctx, cancel := detached(c.ctx)
		defer cancel()
		if failErr := a.engine.FinishJob(ctx, job.ID, "", err); failErr != nil {
			a.log.Error("tangent httpapi: undispatched job not failed", "job", job.ID, "error", failErr)
		}
		return 0, nil, apiError(CodeUnavailable, "the job could not be started; try again")
	}
	return http.StatusAccepted, jobStarted{JobID: job.ID, Kind: job.Kind, LineID: job.LineID, Provider: job.Provider, Model: job.Model}, nil
}

// detached outlives the request for a clean-up write.
func detached(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), writeBackTimeout)
}
