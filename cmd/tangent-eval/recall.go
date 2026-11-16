package main

import (
	"context"
	"fmt"
	"log/slog"
	"slices"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// The recall mode (-mode recall) writes fixed memories and measures, for
// each query, whether the expected memories come back: from the search (the
// offers at a new conversation or branch, top k) and in the prompt of a new
// conversation's first turn (the per-turn recall, within its token budget).

// RecallResult is one query's outcome. FirstRank is the 1-based search rank
// of the first expected memory (0: none in the top k); StaleRecalled counts
// superseded memories that came back (always 0 unless recall is broken).
type RecallResult struct {
	Sample        string
	Query         string
	Expected      int
	SearchFound   int
	FirstRank     int
	TurnFound     int
	TurnTokens    int
	StaleRecalled int
}

// RecallReport is every query's result with the Embedder that ran them.
type RecallReport struct {
	Embedder string
	Note     string
	K        int
	Results  []RecallResult
}

// SearchRecall is recall@k of the search over every query together.
func (r RecallReport) SearchRecall() float64 {
	return r.share(func(x RecallResult) int { return x.SearchFound })
}

// TurnRecall is the share of expected memories the first turn's prompt carried.
func (r RecallReport) TurnRecall() float64 {
	return r.share(func(x RecallResult) int { return x.TurnFound })
}

// Stale is how many superseded memories were recalled in all.
func (r RecallReport) Stale() int {
	n := 0
	for _, x := range r.Results {
		n += x.StaleRecalled
	}
	return n
}

func (r RecallReport) expected() int {
	n := 0
	for _, x := range r.Results {
		n += x.Expected
	}
	return n
}

func (r RecallReport) share(found func(RecallResult) int) float64 {
	total, hits := r.expected(), 0
	if total == 0 {
		return 0
	}
	for _, x := range r.Results {
		hits += found(x)
	}
	return float64(hits) / float64(total)
}

// writtenSample maps a sample's memory keys to ids, and lists the ids of
// the superseded ones.
type writtenSample struct {
	ids   map[string]string
	stale map[string]bool
}

// evaluateRecall writes every sample (as its own tenant) and runs its
// queries; k bounds the search.
func evaluateRecall(ctx context.Context, pool *pgxpool.Pool, samples []RecallSample, choice recallEmbedder, k int) (RecallReport, error) {
	if choice.err != nil {
		return RecallReport{}, choice.err
	}
	quiet := tangent.WithLogger(slog.New(slog.DiscardHandler))
	e, err := tangent.New(pool, quiet, tangent.WithFeatures(tangent.Notes(), tangent.Memory(tangent.ModeManual, tangent.MemoryConfig{Embedder: choice.embedder})))
	if err != nil {
		return RecallReport{}, err
	}
	report := RecallReport{Embedder: choice.name, Note: choice.note, K: k}
	for _, s := range samples {
		scope := tangent.Scope{Tenant: "eval-recall-" + s.Name, Actor: "tangent-eval"}
		written, err := writeMemories(ctx, e, scope, s.Memories)
		if err != nil {
			return RecallReport{}, fmt.Errorf("sample %s: %w", s.Name, err)
		}
		for _, q := range s.Queries {
			result, err := recallQuery(ctx, e, scope, written, q, k)
			if err != nil {
				return RecallReport{}, fmt.Errorf("sample %s, query %q: %w", s.Name, q.Query, err)
			}
			result.Sample = s.Name
			report.Results = append(report.Results, result)
		}
	}
	return report, nil
}

// writeMemories writes the memories in order; one with Supersedes replaces
// the earlier one through SupersedeMemory.
func writeMemories(ctx context.Context, e *tangent.Engine, scope tangent.Scope, memories []SampleMemory) (writtenSample, error) {
	out := writtenSample{ids: map[string]string{}, stale: map[string]bool{}}
	for _, m := range memories {
		in := domain.MemoryInput{Kind: m.Kind, Text: m.Text, Importance: m.Importance}
		if m.Supersedes == "" {
			memory, err := e.CreateMemory(ctx, scope, tangent.MemoryCreate{Memory: in})
			if err != nil {
				return out, fmt.Errorf("memory %s: %w", m.Key, err)
			}
			out.ids[m.Key] = memory.ID
			continue
		}
		replaced, err := e.SupersedeMemory(ctx, scope, out.ids[m.Supersedes], in)
		if err != nil {
			return out, fmt.Errorf("memory %s: %w", m.Key, err)
		}
		out.ids[m.Key], out.stale[out.ids[m.Supersedes]] = replaced.New.ID, true
	}
	return out, nil
}

// recallQuery searches the query and previews it as a new conversation's
// first turn.
func recallQuery(ctx context.Context, e *tangent.Engine, scope tangent.Scope, w writtenSample, q RecallQuery, k int) (RecallResult, error) {
	want := make([]string, 0, len(q.Expect))
	for _, key := range q.Expect {
		want = append(want, w.ids[key])
	}
	result := RecallResult{Query: q.Query, Expected: len(want)}
	found, err := e.SearchMemories(ctx, scope, tangent.MemorySearch{Query: q.Query, Limit: k})
	if err != nil {
		return result, err
	}
	result.SearchFound, result.FirstRank, result.StaleRecalled = w.score(found, want)
	line, err := e.CreateLine(ctx, scope, tangent.LineInput{Title: "Recall", Provider: "fake", Model: "fake-1"})
	if err != nil {
		return result, err
	}
	preview, err := e.PreviewTurn(ctx, scope, line.ID, q.Query)
	if err != nil {
		return result, err
	}
	turnFound, _, turnStale := w.score(preview.Memories, want)
	result.TurnFound, result.StaleRecalled = turnFound, result.StaleRecalled+turnStale
	for _, block := range preview.Blocks {
		if block.Key == domain.SectionMemory {
			result.TurnTokens += block.Tokens
		}
	}
	return result, nil
}

// score counts the wanted memories among the recalled ones, the rank of the
// first, and the superseded ones recalled.
func (w writtenSample) score(recalled []domain.RecalledMemory, want []string) (found, firstRank, stale int) {
	for i, r := range recalled {
		if w.stale[r.Memory.ID] {
			stale++
		}
		if slices.Contains(want, r.Memory.ID) {
			found++
			if firstRank == 0 {
				firstRank = i + 1
			}
		}
	}
	return found, firstRank, stale
}
