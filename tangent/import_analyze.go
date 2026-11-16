package tangent

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/Rynvex/tangent/domain"
)

// ImportAnalyzeTimeout bounds the model call of one import analysis (B22),
// waiting for a run slot included.
const ImportAnalyzeTimeout = 45 * time.Second

// OnceRunner runs one request synchronously, outside the turn and job
// protocol (RunnerDispatcher.RunOnce); httpapi uses it, when the API's
// Dispatcher is one, for the import analysis.
type OnceRunner interface {
	RunOnce(ctx context.Context, req RunRequest) (RunResult, error)
}

// RunnerFunc adapts a function to Runner.
type RunnerFunc func(ctx context.Context, req RunRequest) (RunResult, error)

// Run calls f.
func (f RunnerFunc) Run(ctx context.Context, req RunRequest) (RunResult, error) { return f(ctx, req) }

// AnalyzeImport proposes how an import is organized (domain.ImportAnalyzePlan):
// which units (rounds or conversations) are one topic, even when other topics
// came between them, and which topics are chapters, branches or
// conversations of their own. in is checked first (invalid_input). With a
// runner the model is asked once (BuildImportAnalyzePrompt, at most
// ImportAnalyzeTimeout, the engine's default provider and model) and its plan
// is checked and repaired (ParseImportAnalyzeOutput, Source "model"); without
// one, or when the call fails, times out or its reply is not a usable plan,
// the deterministic analyzer answers (Source "heuristic") and the reason is
// logged without any of the conversation's text. Nothing is written.
func (e *Engine) AnalyzeImport(ctx context.Context, scope Scope, in domain.ImportAnalyzeInput, r Runner) (domain.ImportAnalyzePlan, error) {
	if _, err := checkScope(scope); err != nil {
		return domain.ImportAnalyzePlan{}, err
	}
	clean, err := domain.NormalizeImportAnalyzeInput(in)
	if err != nil {
		return domain.ImportAnalyzePlan{}, err
	}
	if r != nil {
		plan, err := e.analyzeWithModel(ctx, clean, r)
		if err == nil {
			return plan, nil
		}
		// No runner and a caller that went away are expected; anything else is worth a warning.
		level := slog.LevelWarn
		if errors.Is(err, errNoRunner) || errors.Is(err, context.Canceled) {
			level = slog.LevelDebug
		}
		e.log.Log(ctx, level, "tangent: the import analysis fell back to the heuristic", "units", len(clean.Units), "reason", analyzeFallbackReason(err))
	}
	return domain.AnalyzeImportDeterministic(clean)
}

// analyzeWithModel asks the runner once and reads its plan.
func (e *Engine) analyzeWithModel(ctx context.Context, in domain.ImportAnalyzeInput, r Runner) (domain.ImportAnalyzePlan, error) {
	runCtx, cancel := context.WithTimeout(ctx, ImportAnalyzeTimeout)
	defer cancel()
	result, err := guardedRun(runCtx, r, ChatRequest(domain.BuildImportAnalyzePrompt(in), e.defaults.provider, e.defaults.model))
	if err != nil {
		return domain.ImportAnalyzePlan{}, err
	}
	return domain.ParseImportAnalyzeOutput(result.Content, in)
}

// analyzeFallbackReason says why the model's plan was not used, in fixed
// words (a runner's or the parser's detail may quote the conversation).
func analyzeFallbackReason(err error) string {
	switch {
	case errors.Is(err, domain.ErrImportAnalyzeOutput):
		return "the reply is not a usable plan"
	case errors.Is(err, ErrDispatcherBusy):
		return "the dispatcher is busy"
	case errors.Is(err, ErrDispatcherClosed):
		return "the dispatcher is shut down"
	case errors.Is(err, errNoRunner):
		return "no runner"
	}
	return publicRunError(err)
}
