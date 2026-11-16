package main

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/runner/openai"
	"github.com/Rynvex/tangent/tangent"
)

// The recall mode's Embedder: the deterministic fake by default (no key,
// it only runs the flow), or TANGENT_EVAL_EMBEDDER=openai with
// OPENAI_API_KEY (and TANGENT_EVAL_EMBEDDING_MODEL, OPENAI_BASE_URL).
const (
	envEvalEmbedder       = "TANGENT_EVAL_EMBEDDER"
	envEvalEmbeddingModel = "TANGENT_EVAL_EMBEDDING_MODEL"
	evalEmbeddingModel    = "text-embedding-3-small"
	evalEmbeddingDim      = 1536
)

// recallEmbedder is the Embedder the environment chose, its name for the
// report and a note about what its numbers mean (or why it cannot run).
type recallEmbedder struct {
	embedder tangent.Embedder
	name     string
	note     string
	err      error
}

func recallEmbedderFromEnv(get func(string) string) recallEmbedder {
	switch kind := strings.ToLower(strings.TrimSpace(get(envEvalEmbedder))); kind {
	case "", "fake":
		return recallEmbedder{embedder: fake.NewEmbedder(0), name: "fake",
			note: "a lexical stand-in that only matches shared words: it checks the flow, not recall quality; set " + envEvalEmbedder + "=openai with OPENAI_API_KEY for a real Embedder"}
	case "openai":
		key := strings.TrimSpace(get("OPENAI_API_KEY"))
		if key == "" {
			return recallEmbedder{err: errors.New(envEvalEmbedder + "=openai needs OPENAI_API_KEY")}
		}
		model := cmp.Or(strings.TrimSpace(get(envEvalEmbeddingModel)), evalEmbeddingModel)
		e, err := openai.NewEmbedder(openai.EmbedderConfig{BaseURL: strings.TrimSpace(get("OPENAI_BASE_URL")), APIKey: key, Model: model, Dim: evalEmbeddingDim})
		if err != nil {
			return recallEmbedder{err: fmt.Errorf("the OpenAI Embedder: %w", err)}
		}
		return recallEmbedder{embedder: e, name: fmt.Sprintf("openai %s/%d", model, evalEmbeddingDim), note: "a real Embedder"}
	default:
		return recallEmbedder{err: fmt.Errorf("%s must be fake or openai, got %q", envEvalEmbedder, kind)}
	}
}

// runRecall is the recall mode.
func runRecall(ctx context.Context, o options, getenv func(string) string, stdout io.Writer) int {
	samples, err := loadRecallSamples(o.recallDir)
	if err == nil && o.k <= 0 {
		err = fmt.Errorf("-k must be positive, got %d", o.k)
	}
	choice := recallEmbedderFromEnv(getenv)
	if err == nil {
		err = choice.err
	}
	var report RecallReport
	if err == nil {
		err = inSchema(ctx, databaseURL(getenv), true, func(pool *pgxpool.Pool) error {
			report, err = evaluateRecall(ctx, pool, samples, choice, o.k)
			return err
		})
	}
	if err != nil {
		fmt.Fprintln(stdout, "tangent-eval:", err)
		return 2
	}
	var text strings.Builder
	report.Markdown(&text)
	fmt.Fprint(stdout, text.String())
	if err := writeReport(o.outPath, text.String()); err != nil {
		fmt.Fprintln(stdout, "tangent-eval:", err)
		return 2
	}
	if recall := 100 * report.SearchRecall(); recall < o.minRecall || recall == 0 || report.Stale() > 0 {
		fmt.Fprintf(stdout, "tangent-eval: recall@%d %.0f%% (at least %.0f%%), %d superseded recalled\n", o.k, recall, o.minRecall, report.Stale())
		return 1
	}
	return 0
}
