package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

const recallTestdata = "testdata/recall"

func TestLoadRecallSamples_ReadsTheFixedSampleAndRefusesBrokenOnes(t *testing.T) {
	samples, err := loadRecallSamples(recallTestdata)
	if err != nil || len(samples) != 1 || samples[0].Name != "bakery-ops" || len(samples[0].Queries) < 8 {
		t.Fatalf("samples = %+v %v", samples, err)
	}
	dir := t.TempDir()
	cases := map[string]string{
		"noname.json":     `{"memories":[{"key":"a","kind":"fact","text":"t"}],"queries":[{"query":"q","expect":["a"]}]}`,
		"nomemories.json": `{"name":"x","queries":[{"query":"q","expect":["a"]}]}`,
		"noqueries.json":  `{"name":"x","memories":[{"key":"a","kind":"fact","text":"t"}]}`,
		"twice.json":      `{"name":"x","memories":[{"key":"a","kind":"fact","text":"t"},{"key":"a","kind":"fact","text":"u"}],"queries":[{"query":"q","expect":["a"]}]}`,
		"unknown.json":    `{"name":"x","memories":[{"key":"a","kind":"fact","text":"t"}],"queries":[{"query":"q","expect":["b"]}]}`,
		"noexpect.json":   `{"name":"x","memories":[{"key":"a","kind":"fact","text":"t"}],"queries":[{"query":"q"}]}`,
		"replaces.json":   `{"name":"x","memories":[{"key":"a","kind":"fact","text":"t","supersedes":"z"}],"queries":[{"query":"q","expect":["a"]}]}`,
		"stale.json":      `{"name":"x","memories":[{"key":"a","kind":"fact","text":"t"},{"key":"b","kind":"fact","text":"u","supersedes":"a"}],"queries":[{"query":"q","expect":["a"]}]}`,
		"json.json":       `{`,
	}
	for file, body := range cases {
		path := filepath.Join(dir, file)
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadRecallSample(path); err == nil {
			t.Errorf("%s is refused", file)
		}
		os.Remove(path)
	}
	if _, err := loadRecallSamples(dir); err == nil {
		t.Fatal("an empty directory has no samples")
	}
}

// The flow runs end to end with the deterministic fake Embedder (no key):
// the memories are written (one by superseding another), each query is
// searched and previewed as a new conversation's first turn, and a
// superseded memory is never recalled. The fake only matches shared words,
// so this checks the flow and a floor, not the quality of recall.
func TestEvaluateRecall_RunsTheFlowWithTheFakeEmbedder(t *testing.T) {
	samples, err := loadRecallSamples(recallTestdata)
	if err != nil {
		t.Fatal(err)
	}
	pool := tangenttest.OpenFeatures(t, tangent.FeatureMemory)
	report, err := evaluateRecall(tangenttest.Context(t), pool, samples, recallEmbedderFromEnv(func(string) string { return "" }), 3)
	if err != nil {
		t.Fatal(err)
	}
	if report.Embedder != "fake" || report.K != 3 || len(report.Results) != len(samples[0].Queries) {
		t.Fatalf("report = %+v", report)
	}
	if report.Stale() != 0 {
		t.Fatalf("a superseded memory was recalled: %+v", report.Results)
	}
	if search, turn := report.SearchRecall(), report.TurnRecall(); search < 0.6 || turn < 0.6 {
		t.Fatalf("the fake Embedder's floor: search %.2f, turn %.2f\n%+v", search, turn, report.Results)
	}
	for _, r := range report.Results {
		if r.Expected == 0 || r.TurnTokens == 0 && r.TurnFound > 0 {
			t.Errorf("result %+v", r)
		}
	}
}

func TestRecallReport_Markdown(t *testing.T) {
	report := RecallReport{Embedder: "fake", K: 3, Note: "a lexical stand-in", Results: []RecallResult{
		{Sample: "s", Query: "Which disks?", Expected: 2, SearchFound: 1, TurnFound: 2, TurnTokens: 40, FirstRank: 2},
		{Sample: "s", Query: "Stale?", Expected: 1, StaleRecalled: 1},
	}}
	var out bytes.Buffer
	report.Markdown(&out)
	text := out.String()
	for _, want := range []string{"| s | Which disks? | 2 | 1 | 2 | 2 | 40 | 0 |", "| s | Stale? | 1 | 0 | — | 0 | 0 | 1 |",
		"**Recall@3** | | 3 | 33% | | 67% | | 1", "Embedder: fake (a lexical stand-in)."} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in\n%s", want, text)
		}
	}
	if (RecallReport{}).SearchRecall() != 0 || (RecallReport{}).TurnRecall() != 0 {
		t.Fatal("no queries recall nothing")
	}
}

func TestRecallEmbedderFromEnv(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if c := recallEmbedderFromEnv(env(nil)); c.err != nil || c.name != "fake" || c.embedder == nil || !strings.Contains(c.note, envEvalEmbedder) {
		t.Fatalf("default: %+v", c)
	}
	if c := recallEmbedderFromEnv(env(map[string]string{envEvalEmbedder: "openai"})); c.err == nil || !strings.Contains(c.err.Error(), "OPENAI_API_KEY") {
		t.Fatalf("openai without a key: %+v", c)
	}
	c := recallEmbedderFromEnv(env(map[string]string{envEvalEmbedder: "openai", "OPENAI_API_KEY": "k", envEvalEmbeddingModel: "m-x"}))
	if c.err != nil || c.name != "openai m-x/1536" || c.embedder.Dim() != 1536 {
		t.Fatalf("openai: %+v", c)
	}
	if c := recallEmbedderFromEnv(env(map[string]string{envEvalEmbedder: "other"})); c.err == nil {
		t.Fatal("an unknown embedder is refused")
	}
}

func TestRun_RecallMode(t *testing.T) {
	if !tangenttest.ExtensionAvailable(t, tangent.FeatureMemory) {
		t.Skip("the recall mode needs the vector extension")
	}
	var out bytes.Buffer
	env := func(k string) string {
		if k == envDatabaseURL {
			return tangenttest.URL()
		}
		return ""
	}
	if code := run([]string{"-mode", "recall", "-recall-samples", recallTestdata}, env, &out); code != 0 {
		t.Fatalf("exit %d:\n%s", code, out.String())
	}
	if !strings.Contains(out.String(), "| bakery-ops |") || !strings.Contains(out.String(), "Embedder: fake") {
		t.Fatalf("report:\n%s", out.String())
	}
	out.Reset()
	if code := run([]string{"-mode", "recall", "-recall-samples", recallTestdata, "-min-recall", "101"}, env, &out); code != 1 {
		t.Fatalf("an unmet threshold fails: %d\n%s", code, out.String())
	}
	for _, args := range [][]string{{"-mode", "other"}, {"-mode", "recall", "-recall-samples", "nowhere"}, {"-mode", "recall", "-k", "0"}} {
		out.Reset()
		if code := run(args, env, &out); code != 2 {
			t.Fatalf("%v: exit %d", args, code)
		}
	}
	// A recall of 0% always fails, whatever -min-recall says; the default
	// baseline is 60%.
	zero := t.TempDir()
	body := `{"name":"zero","memories":[{"key":"a","kind":"fact","text":"Bake sourdough on Sundays"}],"queries":[{"query":"Which oven temperature?","expect":["a"]}]}`
	if err := os.WriteFile(filepath.Join(zero, "zero.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"-mode", "recall", "-recall-samples", zero}, {"-mode", "recall", "-recall-samples", zero, "-min-recall", "0"}} {
		out.Reset()
		if code := run(args, env, &out); code != 1 || !strings.Contains(out.String(), "recall@5 0%") {
			t.Fatalf("%v: a 0%% recall must fail: %d\n%s", args, code, out.String())
		}
	}
	if defaultMinRecall != 60 {
		t.Fatalf("the default baseline is %v", defaultMinRecall)
	}
	out.Reset()
	openai := func(k string) string {
		if k == envEvalEmbedder {
			return "openai"
		}
		return env(k)
	}
	if code := run([]string{"-mode", "recall", "-recall-samples", recallTestdata}, openai, &out); code != 2 || !strings.Contains(out.String(), "OPENAI_API_KEY") {
		t.Fatalf("openai without a key: %d\n%s", code, out.String())
	}
}
