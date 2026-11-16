package domain

import (
	"encoding/json"
	"flag"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// The evaluation set (testdata/import_analyze_eval, see its README): the
// deterministic analyzer is scored against every hand-labelled sample and
// must not fall below baseline.json; a better algorithm rewrites the
// baseline with -update-analyze-baseline.

var updateAnalyzeBaseline = flag.Bool("update-analyze-baseline", false, "rewrite testdata/import_analyze_eval/baseline.json")

const (
	analyzeEvalDir      = "testdata/import_analyze_eval"
	analyzeEvalBaseline = "baseline.json"
	// analyzeEvalTolerance is the drop below the baseline that still passes.
	analyzeEvalTolerance = 0.005
)

// analyzeBaseline is one sample's recorded scores.
type analyzeBaseline struct {
	Precision float64 `json:"precision"`
	Recall    float64 `json:"recall"`
	F1        float64 `json:"f1"`
	Roles     float64 `json:"roles"`
}

func baselineOf(s ImportAnalyzeScore) analyzeBaseline {
	round := func(f float64) float64 { return math.Round(f*1000) / 1000 }
	return analyzeBaseline{Precision: round(s.Precision()), Recall: round(s.Recall()), F1: round(s.F1()), Roles: round(s.RoleAccuracy())}
}

func loadAnalyzeEvalSamples(t *testing.T) []ImportAnalyzeEvalSample {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(analyzeEvalDir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	samples := []ImportAnalyzeEvalSample{}
	for _, file := range files {
		if filepath.Base(file) == analyzeEvalBaseline {
			continue
		}
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var sample ImportAnalyzeEvalSample
		if err := json.Unmarshal(raw, &sample); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if sample.Name == "" || sample.Draft {
			t.Fatalf("%s: no name, or still a draft", file)
		}
		if _, err := NormalizeImportAnalyzeInput(sample.Input()); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if err := CheckImportAnalyzeGold(sample.Units, sample.Gold); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		samples = append(samples, sample)
	}
	if len(samples) == 0 {
		t.Fatal("no samples")
	}
	return samples
}

func TestImportAnalyzeEval_HeuristicKeepsItsBaseline(t *testing.T) {
	samples := loadAnalyzeEvalSamples(t)
	path := filepath.Join(analyzeEvalDir, analyzeEvalBaseline)
	baseline := map[string]analyzeBaseline{}
	if raw, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(raw, &baseline); err != nil {
			t.Fatal(err)
		}
	} else if !*updateAnalyzeBaseline {
		t.Fatalf("%v (run with -update-analyze-baseline)", err)
	}
	got := map[string]analyzeBaseline{}
	total := ImportAnalyzeScore{}
	for _, sample := range samples {
		plan, err := AnalyzeImportDeterministic(sample.Input())
		if err != nil {
			t.Fatalf("%s: %v", sample.Name, err)
		}
		score := ScoreImportAnalyzePlan(plan, sample.Gold)
		total = total.Add(score)
		got[sample.Name] = baselineOf(score)
		t.Logf("%-10s units %2d  gold %d nodes  plan %d nodes  P %.2f  R %.2f  F1 %.2f  roles %d/%d",
			sample.Name, len(sample.Units), score.GoldNodes, score.Nodes, score.Precision(), score.Recall(), score.F1(), score.RoleHits, score.RoleTotal)
		for _, node := range plan.Nodes {
			t.Logf("    %-13s %v", node.Role, node.UnitKeys)
		}
	}
	t.Logf("%-10s P %.2f  R %.2f  F1 %.2f  roles %d/%d", "total", total.Precision(), total.Recall(), total.F1(), total.RoleHits, total.RoleTotal)
	if *updateAnalyzeBaseline {
		raw, err := json.MarshalIndent(got, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(raw, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	for name := range baseline {
		if _, ok := got[name]; !ok {
			t.Errorf("%s: in the baseline but not in the samples (rerun with -update-analyze-baseline)", name)
		}
	}
	for name, now := range got {
		want, ok := baseline[name]
		if !ok {
			t.Errorf("%s: not in the baseline (rerun with -update-analyze-baseline)", name)
			continue
		}
		if now.Precision < want.Precision-analyzeEvalTolerance || now.Recall < want.Recall-analyzeEvalTolerance || now.F1 < want.F1-analyzeEvalTolerance || now.Roles < want.Roles-analyzeEvalTolerance {
			t.Errorf("%s: P %.3f R %.3f F1 %.3f roles %.3f fell below the baseline P %.3f R %.3f F1 %.3f roles %.3f", name, now.Precision, now.Recall, now.F1, now.Roles, want.Precision, want.Recall, want.F1, want.Roles)
		}
	}
}
