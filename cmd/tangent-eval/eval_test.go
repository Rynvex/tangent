package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

func TestLoadSamples_ReadsTheFixedSamplesAndRefusesBrokenOnes(t *testing.T) {
	samples, err := loadSamples("testdata")
	if err != nil || len(samples) != 3 || samples[0].Name != "kyoto-trip" {
		t.Fatalf("samples = %d %v", len(samples), err)
	}
	dir := t.TempDir()
	cases := map[string]string{
		"noname.json": `{"main":[{"user":"q","assistant":"a"}],"asks":[{"line":"main","question":"q"}]}`,
		"parent.json": `{"name":"x","main":[{"user":"q","assistant":"a"}],"branches":[{"name":"b","parent":"nope","at":0,"purpose":"p"}],"asks":[{"line":"main","question":"q"}]}`,
		"at.json":     `{"name":"x","main":[{"user":"q","assistant":"a"}],"branches":[{"name":"b","parent":"main","at":3,"purpose":"p"}],"asks":[{"line":"main","question":"q"}]}`,
		"end.json":    `{"name":"x","main":[{"user":"q","assistant":"a"}],"branches":[{"name":"b","parent":"main","at":0,"purpose":"p","end":"later"}],"asks":[{"line":"main","question":"q"}]}`,
		"ask.json":    `{"name":"x","main":[{"user":"q","assistant":"a"}],"asks":[{"line":"elsewhere","question":"q"}]}`,
		"pin.json":    `{"name":"x","main":[{"user":"q","assistant":"a"}],"pins":[4],"asks":[{"line":"main","question":"q"}]}`,
		"json.json":   `{`,
	}
	for file, body := range cases {
		path := filepath.Join(dir, file)
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadSample(path); err == nil {
			t.Errorf("%s is refused", file)
		}
		os.Remove(path)
	}
	if _, err := loadSamples(dir); err == nil {
		t.Fatal("an empty directory has no samples")
	}
}

// The long main lines save at least 30%; a short branch line keeps all its
// messages and gains the other branches' conclusions (it may grow a little);
// the total saves at least 30%.
func TestEvaluate_TheFisheyeSavesAtLeastThirtyPercentOverall(t *testing.T) {
	samples, err := loadSamples("testdata")
	if err != nil {
		t.Fatal(err)
	}
	report, err := evaluate(tangenttest.Context(t), tangenttest.Open(t), samples, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Results) != 5 || report.Graded {
		t.Fatalf("report = %+v", report)
	}
	for _, r := range report.Results {
		long := r.Line == mainLineName
		if r.DefaultTokens == 0 || r.FisheyeTokens == 0 || r.LeafOnly == 0 || (long && (r.Reduction() < 0.30 || r.Hidden == 0)) {
			t.Errorf("%s / %s: default %d, fisheye %d (%.0f%%), leaf_only %d, hidden %d", r.Sample, r.Line, r.DefaultTokens, r.FisheyeTokens, 100*r.Reduction(), r.LeafOnly, r.Hidden)
		}
		if !long && r.Reduction() < -0.10 {
			t.Errorf("a short branch line grows only by the conclusions block: %s %.0f%%", r.Line, 100*r.Reduction())
		}
	}
	if report.Reduction() < 0.30 {
		t.Fatalf("overall %.2f", report.Reduction())
	}
}

// scriptedRunner answers the turns with fixed text and the grader with
// fixed scores.
type scriptedRunner struct{ prompts []string }

func (r *scriptedRunner) Run(_ context.Context, req tangent.RunRequest) (tangent.RunResult, error) {
	last := req.Messages[len(req.Messages)-1].Content
	r.prompts = append(r.prompts, req.System+"\n"+last)
	if strings.Contains(last, scoreMarker) {
		return tangent.RunResult{Content: scoreMarker + `{"a": 7, "b": 8}`}, nil
	}
	return tangent.RunResult{Content: "An answer."}, nil
}

func TestEvaluate_GradesBothAnswersWithTheFixedPrompt(t *testing.T) {
	samples, err := loadSamples("testdata")
	if err != nil {
		t.Fatal(err)
	}
	runner := &scriptedRunner{}
	report, err := evaluate(tangenttest.Context(t), tangenttest.Open(t), samples[:1], &grader{runner: runner, model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	if !report.Graded || report.Results[0].DefaultScore != 7 || report.Results[0].FisheyeScore != 8 {
		t.Fatalf("report = %+v", report.Results[0])
	}
	graded := runner.prompts[2]
	if !strings.Contains(graded, "One ryokan night in Higashiyama") || !strings.Contains(graded, "Answer A") {
		t.Fatalf("the grading prompt carries the expected facts and both answers: %q", graded)
	}
	if _, err := parseScores("no marker"); err == nil {
		t.Fatal("unusable scores are refused")
	}
	if _, err := parseScores(scoreMarker + `{"a": 11, "b": 3}`); err == nil {
		t.Fatal("scores are 1 to 10")
	}
}

func TestReport_Markdown(t *testing.T) {
	report := Report{Results: []Result{{Sample: "s", Line: "main", Question: "q?", DefaultTokens: 1000, FisheyeTokens: 400, Full: 9, Summary: 30, LeafOnly: 3, Hidden: 40}}, SkipReason: "no key"}
	var out bytes.Buffer
	report.Markdown(&out)
	text := out.String()
	for _, want := range []string{"| s | main | 1000 | 400 | 60% |", "**Total** | | 1000 | 400 | 60%", "Quality grading skipped: no key"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in\n%s", want, text)
		}
	}
}

func TestGraderFromEnv(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if g, reason := graderFromEnv(env(nil)); g != nil || !strings.Contains(reason, envGrade) {
		t.Fatalf("off: %v %q", g, reason)
	}
	if g, reason := graderFromEnv(env(map[string]string{envGrade: "1"})); g != nil || !strings.Contains(reason, "API key") {
		t.Fatalf("no key: %v %q", g, reason)
	}
	if g, _ := graderFromEnv(env(map[string]string{envGrade: "1", "ANTHROPIC_API_KEY": "k"})); g == nil || g.model == "" {
		t.Fatal("anthropic")
	}
	if g, _ := graderFromEnv(env(map[string]string{envGrade: "1", "OPENAI_API_KEY": "k", envModel: "gpt-x"})); g == nil || g.model != "gpt-x" {
		t.Fatal("openai")
	}
}

func TestRun_WritesTheReportAndChecksTheThreshold(t *testing.T) {
	tangenttest.Open(t) // skips without a database
	var out bytes.Buffer
	env := func(k string) string {
		if k == envDatabaseURL {
			return tangenttest.URL()
		}
		return ""
	}
	if code := run([]string{"-samples", "testdata", "-min-reduction", "30"}, env, &out); code != 0 {
		t.Fatalf("exit %d:\n%s", code, out.String())
	}
	if !strings.Contains(out.String(), "| kyoto-trip | main |") || !strings.Contains(out.String(), "Quality grading skipped") {
		t.Fatalf("report:\n%s", out.String())
	}
	out.Reset()
	if code := run([]string{"-samples", "testdata", "-min-reduction", "99"}, env, &out); code != 1 {
		t.Fatalf("an unmet threshold fails: %d", code)
	}
	if code := run([]string{"-samples", "nowhere"}, env, &out); code != 2 {
		t.Fatalf("missing samples: %d", code)
	}
}
