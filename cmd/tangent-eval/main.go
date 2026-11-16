// Command tangent-eval measures the context features on fixed samples.
//
// The default mode (-mode fisheye) compares the prompts of fixed sample conversations
// with the default history and with the fisheye context: their token
// counts and, with TANGENT_EVAL_GRADE=1 and an API key, the quality of the
// answers (graded by the same model with one fixed prompt). It writes the
// samples into a fresh schema of the database and drops it at the end.
//
//	go run ./cmd/tangent-eval [-samples dir] [-min-reduction 30] [-out report.md]
//
// The database is TANGENT_EVAL_DATABASE_URL (default: the docker compose
// test database on :5444). Exit 0: the asks together saved at least
// -min-reduction percent of the prompt tokens; 1: they did not; 2: the run
// failed. (A short line keeps all its messages and gains the other
// branches' conclusions, so one ask may grow; the total is what counts.)
//
// The recall mode writes fixed memories and checks which ones each query
// recalls, by search (top -k) and in a new conversation's first turn:
//
//	go run ./cmd/tangent-eval -mode recall [-recall-samples dir] [-k 5] [-min-recall 60]
//
// It needs the vector extension. The Embedder is the deterministic fake by
// default (no key: it only runs the flow, its numbers are lexical), or
// TANGENT_EVAL_EMBEDDER=openai with OPENAI_API_KEY. Exit 1: recall@k of
// the search is below -min-recall percent (default 60) or 0%, or a
// superseded memory came back.
//
// The import mode scores the import analysis (B22) on the hand-labelled
// samples of domain/testdata/import_analyze_eval: always the deterministic
// analyzer, and the model TANGENT_EVAL_IMPORT_MODEL names (provider:model;
// anthropic, openai, claude-cli, codex-cli or agy-cli; one call per sample):
//
//	go run ./cmd/tangent-eval -mode import [-import-samples dir] [-min-import-f1 0] [-import-keywords weights|idf]
//
// Exit 1: a model call gave no plan, or the F1 over pairs of units (joined
// as the gold joins them) of what was scored (the model, else the
// heuristic) is below -min-import-f1 percent.
// The import-convert mode turns a ChatGPT or Claude export into draft
// samples to label by hand:
//
//	go run ./cmd/tangent-eval -mode import-convert -export conversations.json -out-dir dir
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

const (
	envDatabaseURL     = "TANGENT_EVAL_DATABASE_URL"
	defaultDatabaseURL = "postgres://tangent:tangent@localhost:5444/tangent_test?sslmode=disable"
	runTimeout         = 10 * time.Minute
)

func main() { os.Exit(run(os.Args[1:], os.Getenv, os.Stdout)) }

// defaultMinRecall is the recall mode's baseline (percent): the fake
// Embedder reaches 90% on the fixed sample, a real one should do better.
const defaultMinRecall = 60

// Modes of the command.
const (
	modeFisheye       = "fisheye"
	modeRecall        = "recall"
	modeImport        = "import"
	modeImportConvert = "import-convert"
)

// options are the command's flags.
type options struct {
	mode, samplesDir, recallDir, outPath string
	importDir, exportPath, convertDir    string
	importKeywords                       string
	minReduction, minRecall, minImportF1 float64
	k                                    int
}

// run is the command; it returns the exit code.
func run(args []string, getenv func(string) string, stdout io.Writer) int {
	flags := flag.NewFlagSet("tangent-eval", flag.ContinueOnError)
	flags.SetOutput(stdout)
	var o options
	flags.StringVar(&o.mode, "mode", modeFisheye, "fisheye (prompt tokens), recall (memories), import (import analysis) or import-convert (export to samples)")
	flags.StringVar(&o.samplesDir, "samples", "cmd/tangent-eval/testdata", "directory of sample conversations (*.json)")
	flags.Float64Var(&o.minReduction, "min-reduction", 30, "fail unless the asks together save at least this percent of tokens")
	flags.StringVar(&o.recallDir, "recall-samples", "cmd/tangent-eval/testdata/recall", "directory of recall samples (*.json)")
	flags.IntVar(&o.k, "k", 5, "the recall mode's search size")
	flags.Float64Var(&o.minRecall, "min-recall", defaultMinRecall, "fail unless the search's recall@k is at least this percent (0% always fails)")
	flags.StringVar(&o.importDir, "import-samples", "domain/testdata/import_analyze_eval", "directory of hand-labelled import analysis samples (*.json)")
	flags.StringVar(&o.importKeywords, "import-keywords", string(domain.ImportAnalyzeKeywordsByWeight), "import mode: how the model's prompt ranks each answer's key terms (weights or idf)")
	flags.Float64Var(&o.minImportF1, "min-import-f1", 0, "import mode: fail unless the F1 over unit pairs is at least this percent")
	flags.StringVar(&o.exportPath, "export", "", "import-convert mode: the ChatGPT or Claude export file")
	flags.StringVar(&o.convertDir, "out-dir", "", "import-convert mode: where the draft samples are written")
	flags.StringVar(&o.outPath, "out", "", "also write the report to this file")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), runTimeout)
	defer cancel()
	switch o.mode {
	case modeFisheye:
		return runFisheye(ctx, o, getenv, stdout)
	case modeRecall:
		return runRecall(ctx, o, getenv, stdout)
	case modeImport:
		return runImport(ctx, o, getenv, stdout)
	case modeImportConvert:
		return runImportConvert(o, stdout)
	}
	fmt.Fprintf(stdout, "tangent-eval: -mode must be %s, %s, %s or %s, got %q\n", modeFisheye, modeRecall, modeImport, modeImportConvert, o.mode)
	return 2
}

func runFisheye(ctx context.Context, o options, getenv func(string) string, stdout io.Writer) int {
	samples, err := loadSamples(o.samplesDir)
	if err != nil {
		fmt.Fprintln(stdout, "tangent-eval:", err)
		return 2
	}
	g, skip := graderFromEnv(getenv)
	var report Report
	err = inSchema(ctx, databaseURL(getenv), false, func(pool *pgxpool.Pool) error {
		report, err = evaluate(ctx, pool, samples, g)
		return err
	})
	if err != nil {
		fmt.Fprintln(stdout, "tangent-eval:", err)
		return 2
	}
	report.SkipReason = skip
	return finish(report, o.minReduction, o.outPath, stdout)
}

func databaseURL(getenv func(string) string) string {
	if url := strings.TrimSpace(getenv(envDatabaseURL)); url != "" {
		return url
	}
	return defaultDatabaseURL
}

// finish writes the report and checks the threshold.
func finish(report Report, minReduction float64, outPath string, stdout io.Writer) int {
	var text strings.Builder
	report.Markdown(&text)
	fmt.Fprint(stdout, text.String())
	if err := writeReport(outPath, text.String()); err != nil {
		fmt.Fprintln(stdout, "tangent-eval:", err)
		return 2
	}
	if saved := 100 * report.Reduction(); saved < minReduction {
		fmt.Fprintf(stdout, "tangent-eval: the fisheye saved %.0f%% in all, below %.0f%%\n", saved, minReduction)
		return 1
	}
	return 0
}

// inSchema runs fn on a fresh schema that is dropped after, migrated with
// the core tables (and the memory feature's, withMemory: its extension is
// then also looked up in public, where a shared install lives).
func inSchema(ctx context.Context, url string, withMemory bool, fn func(*pgxpool.Pool) error) error {
	admin, err := pgx.Connect(ctx, url)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer admin.Close(context.WithoutCancel(ctx))
	schema, err := schemaName()
	if err != nil {
		return err
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}
	defer admin.Exec(context.WithoutCancel(ctx), "DROP SCHEMA "+schema+" CASCADE") //nolint:errcheck // best effort
	path := schema
	if withMemory {
		path += ", public"
	}
	pool, err := schemaPool(ctx, url, path)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := store.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	if withMemory {
		if err := store.MigrateFeatures(ctx, pool, tangent.FeatureMemory); err != nil {
			return fmt.Errorf("migrate the memory feature (it needs the vector extension): %w", err)
		}
	}
	return fn(pool)
}

// schemaName is a fresh schema name (hex only, safe to splice into DDL).
func schemaName() (string, error) {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "tangent_eval_" + hex.EncodeToString(raw), nil
}

func schemaPool(ctx context.Context, url, searchPath string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = searchPath
	return pgxpool.NewWithConfig(ctx, cfg)
}

// writeReport also writes the report to path, when one is given.
func writeReport(path, text string) error {
	if path == "" {
		return nil
	}
	return os.WriteFile(path, []byte(text), 0o644)
}
