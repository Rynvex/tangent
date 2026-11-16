package embedding

import (
	"context"
	"errors"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// snippet:run-turn
// AskSync runs one turn in the caller's goroutine: a CLI, a test or a
// handler that wants the reply before it answers.
func AskSync(ctx context.Context, engine *tangent.Engine, model tangent.Runner, scope tangent.Scope, lineID, text string) (domain.Message, error) {
	turn, err := engine.BeginTurn(ctx, scope, lineID, tangent.TurnInput{Content: text})
	if err != nil {
		return domain.Message{}, err // turn_pending, archived, branch_closed, a TurnGate refusal…
	}
	done, err := engine.RunTurn(ctx, turn, model) // streams deltas, then CompleteTurn
	if err != nil {
		return domain.Message{}, err
	}
	// Jobs the turn started (the summary feature in auto mode) are the caller's to run.
	for _, job := range done.Jobs {
		runJobInline(ctx, engine, model, job)
	}
	return done.Message, nil
}

// endsnippet

// runJobInline runs a job in the caller's goroutine and reports it.
func runJobInline(ctx context.Context, engine *tangent.Engine, model tangent.Runner, job tangent.Job) {
	result, err := model.Run(ctx, job.Request())
	_ = engine.FinishJob(context.WithoutCancel(ctx), job.ID, result.Content, err)
}

// failedRunText is what an operator sees on a turn whose model call failed;
// the upstream error itself is only logged, never stored.
const failedRunText = "the model run failed"

// snippet:manual-turn
// RunManually is the runner side of the turn protocol without RunTurn: the
// host calls its own model client and reports every piece back.
func RunManually(ctx context.Context, engine *tangent.Engine, model tangent.Runner, turn tangent.Turn) (tangent.CompletedTurn, error) {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	req := turn.Request() // tangent.ChatRequest of the prompt; or Prompt.Text() for a CLI agent
	req.OnDelta = func(d domain.Delta) {
		// Buffers the piece for GET /stream and publishes message.delta. A turn
		// the operator cancelled answers turn_not_pending: stop the model.
		if err := engine.AppendDelta(runCtx, turn.ID, d); errors.Is(err, domain.ErrTurnNotPending) {
			cancel()
		}
	}
	result, runErr := model.Run(runCtx, req)
	outcome := tangent.TurnResult{Content: result.Content, Usage: &result.Usage, Model: result.Model}
	if runErr != nil {
		outcome = tangent.TurnResult{Error: failedRunText}
	}
	// The write-back must happen even when ctx is gone, or the turn stays pending
	// until Maintain fails it as stale.
	return engine.CompleteTurn(context.WithoutCancel(ctx), turn.ID, outcome)
}

// endsnippet
