package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/runner/anthropic"
	"github.com/Rynvex/tangent/runner/cli"
	"github.com/Rynvex/tangent/runner/openai"
	"github.com/Rynvex/tangent/tangent"
)

// The import mode scores the import analysis (B22) on hand-labelled samples
// (domain/testdata/import_analyze_eval, see its README): always the
// deterministic analyzer, and the model TANGENT_EVAL_IMPORT_MODEL names as
// provider:model (anthropic, openai, claude-cli, codex-cli or agy-cli), one
// call per sample. Pairs of units joined by the plan but not by the gold are
// over-merging (precision), pairs joined by the gold but not by the plan are
// over-splitting (recall). -import-keywords picks how the model's prompt
// ranks each answer's key terms (B26: weights, the default the server uses,
// or idf), so both can be scored on the same samples.

const (
	envImportModel = "TANGENT_EVAL_IMPORT_MODEL"
	// importCallTimeout bounds one model call (a CLI is slower than the API).
	importCallTimeout = 3 * time.Minute
	// baselineFile is the file in a samples directory that is not a sample.
	baselineFile = "baseline.json"
)

// ImportResult is one sample's scores.
type ImportResult struct {
	Sample    string
	Units     int
	Heuristic domain.ImportAnalyzeScore
	Model     *domain.ImportAnalyzeScore
	ModelErr  string
}

// ImportReport is the import mode's report.
type ImportReport struct {
	Results    []ImportResult
	Model      string
	Keywords   domain.ImportAnalyzeKeywordRanking
	SkipReason string
}

// loadImportSamples reads every sample of dir (the baseline file left out)
// and checks its gold.
func loadImportSamples(dir string) ([]domain.ImportAnalyzeEvalSample, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	samples := []domain.ImportAnalyzeEvalSample{}
	for _, file := range files {
		if filepath.Base(file) == baselineFile {
			continue
		}
		sample, err := loadImportSample(file)
		if err != nil {
			return nil, err
		}
		samples = append(samples, sample)
	}
	if len(samples) == 0 {
		return nil, fmt.Errorf("no import samples in %s", dir)
	}
	return samples, nil
}

func loadImportSample(file string) (domain.ImportAnalyzeEvalSample, error) {
	raw, err := os.ReadFile(file)
	if err != nil {
		return domain.ImportAnalyzeEvalSample{}, err
	}
	var sample domain.ImportAnalyzeEvalSample
	if err := json.Unmarshal(raw, &sample); err != nil {
		return domain.ImportAnalyzeEvalSample{}, fmt.Errorf("%s: %w", file, err)
	}
	switch {
	case sample.Name == "":
		return domain.ImportAnalyzeEvalSample{}, fmt.Errorf("%s: no name", file)
	case sample.Draft:
		return domain.ImportAnalyzeEvalSample{}, fmt.Errorf("%s: still a draft (label its gold, then remove \"draft\")", file)
	}
	if _, err := domain.NormalizeImportAnalyzeInput(sample.Input()); err != nil {
		return domain.ImportAnalyzeEvalSample{}, fmt.Errorf("%s: %w", file, err)
	}
	if err := domain.CheckImportAnalyzeGold(sample.Units, sample.Gold); err != nil {
		return domain.ImportAnalyzeEvalSample{}, fmt.Errorf("%s: %w", file, err)
	}
	return sample, nil
}

// importRunnerFromEnv is the runner, provider and model TANGENT_EVAL_IMPORT_MODEL
// asks for; without one, the reason the model is skipped.
func importRunnerFromEnv(get func(string) string) (tangent.Runner, string, string, string, error) {
	spec := strings.TrimSpace(get(envImportModel))
	if spec == "" {
		return nil, "", "", "set " + envImportModel + "=provider:model (anthropic, openai, claude-cli, codex-cli, agy-cli) to score a model", nil
	}
	provider, model, ok := strings.Cut(spec, ":")
	provider, model = strings.TrimSpace(provider), strings.TrimSpace(model)
	if !ok || provider == "" || model == "" {
		return nil, "", "", "", fmt.Errorf("%s: want provider:model, got %q", envImportModel, spec)
	}
	var r tangent.Runner
	var err error
	switch provider {
	case "anthropic":
		r, err = anthropic.New(anthropic.Config{APIKey: strings.TrimSpace(get("ANTHROPIC_API_KEY")), Model: model, BaseURL: strings.TrimSpace(get("TANGENT_ANTHROPIC_BASE_URL"))})
	case "openai":
		r, err = openai.New(openai.Config{APIKey: strings.TrimSpace(get("OPENAI_API_KEY")), Model: model, BaseURL: strings.TrimSpace(get("TANGENT_OPENAI_BASE_URL"))})
	case "claude-cli", "codex-cli", "agy-cli":
		r, err = cli.New(cli.Config{Backend: cli.Backend(strings.TrimSuffix(provider, "-cli")), Model: model, Timeout: importCallTimeout})
	default:
		err = fmt.Errorf("unknown provider %q", provider)
	}
	if err != nil {
		return nil, "", "", "", fmt.Errorf("%s: %w", envImportModel, err)
	}
	return r, provider, model, "", nil
}

// evaluateImport scores the deterministic analyzer on every sample (an
// error there is the run's, since the samples were checked when loaded),
// and the model when r is not nil, its prompt ranking key terms by keywords (a call that fails or gives no usable
// plan is recorded in the sample's row; the run then fails at the end).
func evaluateImport(ctx context.Context, samples []domain.ImportAnalyzeEvalSample, r tangent.Runner, provider, model string, keywords domain.ImportAnalyzeKeywordRanking) (ImportReport, error) {
	report := ImportReport{Model: provider + ":" + model, Keywords: keywords}
	for _, sample := range samples {
		result := ImportResult{Sample: sample.Name, Units: len(sample.Units)}
		plan, err := domain.AnalyzeImportDeterministic(sample.Input())
		if err != nil {
			return ImportReport{}, fmt.Errorf("%s: %w", sample.Name, err)
		}
		result.Heuristic = domain.ScoreImportAnalyzePlan(plan, sample.Gold)
		if r != nil {
			score, err := scoreModel(ctx, sample, r, provider, model, keywords)
			if err != nil {
				result.ModelErr = err.Error()
			} else {
				result.Model = &score
			}
		}
		report.Results = append(report.Results, result)
	}
	return report, nil
}

// failed are the samples whose model call gave no score.
func (r ImportReport) failed() []string {
	out := []string{}
	for _, x := range r.Results {
		if x.ModelErr != "" {
			out = append(out, x.Sample)
		}
	}
	return out
}

func scoreModel(ctx context.Context, sample domain.ImportAnalyzeEvalSample, r tangent.Runner, provider, model string, keywords domain.ImportAnalyzeKeywordRanking) (domain.ImportAnalyzeScore, error) {
	callCtx, cancel := context.WithTimeout(ctx, importCallTimeout)
	defer cancel()
	prompt := domain.BuildImportAnalyzePromptWith(sample.Input(), domain.ImportAnalyzePromptOptions{Keywords: keywords})
	result, err := r.Run(callCtx, tangent.ChatRequest(prompt, provider, model))
	if err != nil {
		return domain.ImportAnalyzeScore{}, fmt.Errorf("model: %w", err)
	}
	plan, err := domain.ParseImportAnalyzeOutput(result.Content, sample.Input())
	if err != nil {
		return domain.ImportAnalyzeScore{}, err
	}
	return domain.ScoreImportAnalyzePlan(plan, sample.Gold), nil
}

// totals are the pair counts of every sample together.
func (r ImportReport) totals() (heuristic, model domain.ImportAnalyzeScore, modelScored int) {
	for _, x := range r.Results {
		heuristic = heuristic.Add(x.Heuristic)
		if x.Model != nil {
			model = model.Add(*x.Model)
			modelScored++
		}
	}
	return heuristic, model, modelScored
}

func scoreCells(s domain.ImportAnalyzeScore) string {
	return fmt.Sprintf("%.2f / %.2f / %.2f | %d/%d | %d", s.Precision(), s.Recall(), s.F1(), s.RoleHits, s.RoleTotal, s.Nodes)
}

// Markdown writes one row per sample and the totals.
func (r ImportReport) Markdown(w io.Writer) {
	fmt.Fprintln(w, "| Sample | Units | Gold nodes | Heuristic P / R / F1 | Roles | Nodes | Model P / R / F1 | Roles | Nodes |")
	fmt.Fprintln(w, "|---|---|---|---|---|---|---|---|---|")
	for _, x := range r.Results {
		model := "— | — | —"
		if x.Model != nil {
			model = scoreCells(*x.Model)
		} else if x.ModelErr != "" {
			model = "failed: " + tableCell(x.ModelErr) + " | — | —"
		}
		fmt.Fprintf(w, "| %s | %d | %d | %s | %s |\n", x.Sample, x.Units, x.Heuristic.GoldNodes, scoreCells(x.Heuristic), model)
	}
	heuristic, model, scored := r.totals()
	modelTotal := "— | — | —"
	if scored > 0 {
		modelTotal = scoreCells(model)
	}
	fmt.Fprintf(w, "| **Total** | | | %s | %s |\n\n", scoreCells(heuristic), modelTotal)
	if r.SkipReason != "" {
		fmt.Fprintf(w, "Model skipped: %s.\n", r.SkipReason)
	} else {
		fmt.Fprintf(w, "Model: %s (%d of %d samples scored), key terms ranked by %s.\n", r.Model, scored, len(r.Results), r.Keywords)
	}
}

// tableCell is text safe inside a Markdown table cell.
func tableCell(text string) string {
	return strings.ReplaceAll(strings.Join(strings.Fields(text), " "), "|", "\\|")
}

// runImport is the import mode: load, score, report. Exit 1 when a model
// was asked for and any of its calls failed, or when the F1 of what was
// scored (the model, else the heuristic) is below -min-import-f1 percent.
func runImport(ctx context.Context, o options, getenv func(string) string, stdout io.Writer) int {
	keywords, err := importKeywordRanking(o.importKeywords)
	if err != nil {
		fmt.Fprintln(stdout, "tangent-eval:", err)
		return 2
	}
	samples, err := loadImportSamples(o.importDir)
	if err != nil {
		fmt.Fprintln(stdout, "tangent-eval:", err)
		return 2
	}
	r, provider, model, skip, err := importRunnerFromEnv(getenv)
	if err != nil {
		fmt.Fprintln(stdout, "tangent-eval:", err)
		return 2
	}
	if r != nil {
		fmt.Fprintf(stdout, "tangent-eval: %d model calls on %s:%s (one per sample, key terms ranked by %s)\n", len(samples), provider, model, keywords)
	}
	report, err := evaluateImport(ctx, samples, r, provider, model, keywords)
	if err != nil {
		fmt.Fprintln(stdout, "tangent-eval:", err)
		return 2
	}
	report.SkipReason = skip
	var text strings.Builder
	report.Markdown(&text)
	fmt.Fprint(stdout, text.String())
	if err := writeReport(o.outPath, text.String()); err != nil {
		fmt.Fprintln(stdout, "tangent-eval:", err)
		return 2
	}
	if failed := report.failed(); len(failed) > 0 {
		fmt.Fprintf(stdout, "tangent-eval: the model gave no plan for %s\n", strings.Join(failed, ", "))
		return 1
	}
	heuristic, modelScore, scored := report.totals()
	judged := heuristic
	if scored > 0 {
		judged = modelScore
	}
	if f1 := 100 * judged.F1(); f1 < o.minImportF1 {
		fmt.Fprintf(stdout, "tangent-eval: the import analysis F1 is %.0f%%, below %.0f%%\n", f1, o.minImportF1)
		return 1
	}
	return 0
}

// importKeywordRanking reads -import-keywords: weights or idf.
func importKeywordRanking(flagValue string) (domain.ImportAnalyzeKeywordRanking, error) {
	switch ranking := domain.ImportAnalyzeKeywordRanking(strings.TrimSpace(flagValue)); ranking {
	case domain.ImportAnalyzeKeywordsByWeight, domain.ImportAnalyzeKeywordsByIDF:
		return ranking, nil
	}
	return "", fmt.Errorf("-import-keywords must be %s or %s, got %q", domain.ImportAnalyzeKeywordsByWeight, domain.ImportAnalyzeKeywordsByIDF, flagValue)
}
