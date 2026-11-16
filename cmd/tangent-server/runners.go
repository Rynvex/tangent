package main

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync/atomic"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/runner/anthropic"
	"github.com/Rynvex/tangent/runner/cli"
	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/runner/openai"
	"github.com/Rynvex/tangent/tangent"
)

// routedRunner sends each run to the runner of its provider hint: a line
// without one uses the default provider; a provider this server has no
// runner for fails the run with a public text. A turn's reasoning effort
// comes from its host_meta (hostmeta.go). When the run hits a usage or rate
// limit before anything streamed and a fallback model is set (and is not
// the model that failed), it runs once more on the fallback.
type routedRunner struct {
	runners         map[string]tangent.Runner
	defaultProvider string
	// models are the providers' configured models, for a run without one.
	models   map[string]string
	fallback modelRef
	log      *slog.Logger
}

func (r routedRunner) Run(ctx context.Context, req tangent.RunRequest) (tangent.RunResult, error) {
	req.Provider = cmp.Or(strings.ToLower(strings.TrimSpace(req.Provider)), r.defaultProvider)
	req.ReasoningEffort = r.effortFor(req)
	var streamed atomic.Bool
	primary := req
	if onDelta := req.OnDelta; onDelta != nil {
		// Only a turn streams (a runner may tell a job by its nil OnDelta).
		primary.OnDelta = func(d domain.Delta) {
			streamed.Store(true)
			onDelta(d)
		}
	}
	result, err := r.runOn(ctx, primary)
	if err == nil || streamed.Load() || !r.canFallBack(req) || !limitReached(err) {
		return result, err
	}
	r.logger().Warn("tangent-server: a usage or rate limit was reached; running once more on the fallback model",
		"from", modelRef{req.Provider, r.modelOf(req)}.String(), "to", r.fallback.String(), "error", err)
	retry := req
	retry.Provider, retry.Model = r.fallback.Provider, r.fallback.Model
	retry.ReasoningEffort = r.effortFor(retry)
	result, err = r.runOn(ctx, retry)
	if err == nil {
		result.Model = cmp.Or(result.Model, r.fallback.Model)
	}
	return result, err
}

func (r routedRunner) runOn(ctx context.Context, req tangent.RunRequest) (tangent.RunResult, error) {
	runner, ok := r.runners[req.Provider]
	if !ok {
		return tangent.RunResult{}, &tangent.RunnerError{Public: fmt.Sprintf("the provider %q is not configured on this server", req.Provider)}
	}
	return runner.Run(ctx, req)
}

// modelOf is the model a request runs (its own or its provider's).
func (r routedRunner) modelOf(req tangent.RunRequest) string {
	return cmp.Or(strings.TrimSpace(req.Model), r.models[req.Provider])
}

// equivalentEffort is the top level under the other CLI's name (Claude's
// max is Codex's xhigh), so a choice survives a switch to the fallback.
var equivalentEffort = map[string]string{"max": "xhigh", "xhigh": "max"}

// effortFor is the reasoning effort to pass on: the request's own, else its
// host_meta's, kept only when the model takes that level (or its
// equivalent).
func (r routedRunner) effortFor(req tangent.RunRequest) string {
	effort := cmp.Or(strings.ToLower(strings.TrimSpace(req.ReasoningEffort)), effortFromMeta(req.HostMeta))
	if effort == "" {
		return ""
	}
	levels := effortLevels(req.Provider, r.modelOf(req))
	for _, candidate := range []string{effort, equivalentEffort[effort]} {
		if candidate != "" && slices.Contains(levels, candidate) {
			return candidate
		}
	}
	return ""
}

// canFallBack: a fallback is set, has a runner and differs from the model
// that ran.
func (r routedRunner) canFallBack(req tangent.RunRequest) bool {
	if r.fallback.Provider == "" || r.runners[r.fallback.Provider] == nil {
		return false
	}
	return r.fallback != modelRef{req.Provider, r.modelOf(req)}
}

func (r routedRunner) logger() *slog.Logger {
	if r.log == nil {
		return slog.Default()
	}
	return r.log
}

// limitReached reports a run that failed on a usage or rate limit: a CLI's
// subscription limit (cli.ErrUsageLimit) or an API provider's HTTP 429 (its
// runner says so in the public text, as its error type is internal).
func limitReached(err error) bool {
	if errors.Is(err, cli.ErrUsageLimit) {
		return true
	}
	var public *tangent.RunnerError
	return errors.As(err, &public) && strings.Contains(public.Public, "HTTP 429")
}

// buildRunner makes a runner for the default provider and for every other
// provider whose credentials are set.
func buildRunner(cfg config) (routedRunner, error) {
	out := routedRunner{runners: map[string]tangent.Runner{}, defaultProvider: cfg.Provider, models: map[string]string{}, fallback: cfg.Fallback}
	for provider := range cfg.runnerProviders() {
		out.models[provider] = cfg.providerModel(provider)
	}
	providers := cfg.runnerProviders()
	if providers[providerFake] {
		out.runners[providerFake] = fake.New(fake.Config{ChunkDelay: cfg.FakeChunkDelay})
	}
	if providers[providerOpenAI] {
		r, err := openai.New(openai.Config{BaseURL: cfg.OpenAI.BaseURL, APIKey: cfg.OpenAI.APIKey, Model: cfg.OpenAI.Model})
		if err != nil {
			return routedRunner{}, fmt.Errorf("TANGENT_OPENAI_BASE_URL: %w", err)
		}
		out.runners[providerOpenAI] = r
	}
	if providers[providerAnthropic] {
		r, err := anthropic.New(anthropic.Config{BaseURL: cfg.Anthropic.BaseURL, APIKey: cfg.Anthropic.APIKey, Model: cfg.Anthropic.Model})
		if err != nil {
			return routedRunner{}, fmt.Errorf("TANGENT_ANTHROPIC_BASE_URL: %w", err)
		}
		out.runners[providerAnthropic] = r
	}
	if err := buildCLIRunners(cfg, out, providers); err != nil {
		return routedRunner{}, err
	}
	return out, nil
}
