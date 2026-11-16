package main

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// Result is one ask: the prompt tokens with the default history and with
// the fisheye, how many fisheye items got each level, and (when graded)
// both answers' scores.
type Result struct {
	Sample        string
	Line          string
	Question      string
	DefaultTokens int
	FisheyeTokens int
	Full          int
	Summary       int
	LeafOnly      int
	Hidden        int
	DefaultScore  int
	FisheyeScore  int
}

// Reduction is the share of the default prompt's tokens the fisheye saves.
func (r Result) Reduction() float64 { return reduction(r.DefaultTokens, r.FisheyeTokens) }

// Report is every ask's result; SkipReason says why quality was not graded.
type Report struct {
	Results    []Result
	Graded     bool
	SkipReason string
}

// Reduction is the saving over every ask together.
func (r Report) Reduction() float64 {
	plain, fish := r.totals()
	return reduction(plain, fish)
}

func (r Report) totals() (int, int) {
	plain, fish := 0, 0
	for _, result := range r.Results {
		plain, fish = plain+result.DefaultTokens, fish+result.FisheyeTokens
	}
	return plain, fish
}

func reduction(plain, fish int) float64 {
	if plain == 0 {
		return 0
	}
	return 1 - float64(fish)/float64(plain)
}

// evalFeatures are what both engines run with; the fisheye engine adds
// Fisheye. Summary is manual, so no rolling summary changes the history.
func evalFeatures() []tangent.Feature {
	return []tangent.Feature{
		tangent.Notes(), tangent.Chapters(), tangent.Aside(), tangent.Summary(tangent.ModeManual), tangent.CardDraft(), tangent.Leaf(tangent.ModeManual),
	}
}

// evaluate writes every sample (as its own tenant) and compares the
// prompts of each ask with the default history and with the fisheye; g,
// when set, also grades the answers.
func evaluate(ctx context.Context, pool *pgxpool.Pool, samples []Sample, g *grader) (Report, error) {
	quiet := tangent.WithLogger(slog.New(slog.DiscardHandler))
	plain, err := tangent.New(pool, quiet, tangent.WithFeatures(evalFeatures()...))
	if err != nil {
		return Report{}, err
	}
	fish, err := tangent.New(pool, quiet, tangent.WithFeatures(append(evalFeatures(), tangent.Fisheye())...))
	if err != nil {
		return Report{}, err
	}
	report := Report{Graded: g != nil}
	for _, s := range samples {
		scope := tangent.Scope{Tenant: "eval-" + s.Name, Actor: "tangent-eval"}
		built, err := buildSample(ctx, fish, scope, s)
		if err != nil {
			return Report{}, fmt.Errorf("sample %s: %w", s.Name, err)
		}
		for _, ask := range s.Asks {
			result, err := compare(ctx, plain, fish, scope, built.lines[ask.Line], ask, g)
			if err != nil {
				return Report{}, fmt.Errorf("sample %s, ask on %s: %w", s.Name, ask.Line, err)
			}
			result.Sample, result.Line = s.Name, ask.Line
			report.Results = append(report.Results, result)
		}
	}
	return report, nil
}

// compare previews one ask on both engines (and grades it).
func compare(ctx context.Context, plain, fish *tangent.Engine, scope tangent.Scope, lineID string, ask Ask, g *grader) (Result, error) {
	before, err := plain.PreviewTurn(ctx, scope, lineID, ask.Question)
	if err != nil {
		return Result{}, err
	}
	after, err := fish.PreviewTurn(ctx, scope, lineID, ask.Question)
	if err != nil {
		return Result{}, err
	}
	result := Result{Question: ask.Question, DefaultTokens: before.TotalTokens, FisheyeTokens: after.TotalTokens}
	if after.Fisheye != nil {
		for _, item := range after.Fisheye.Items {
			result.count(item.Level)
		}
	}
	if g != nil {
		result.DefaultScore, result.FisheyeScore, err = g.grade(ctx, ask, before.Prompt, after.Prompt)
	}
	return result, err
}

func (r *Result) count(level string) {
	switch level {
	case domain.FisheyeFull:
		r.Full++
	case domain.FisheyeSummary:
		r.Summary++
	case domain.FisheyeLeafOnly:
		r.LeafOnly++
	default:
		r.Hidden++
	}
}
