package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

const evalSamplesDir = "../../domain/testdata/import_analyze_eval"

func TestLoadImportSamples_ReadsTheLabelledSetAndRefusesABadGold(t *testing.T) {
	samples, err := loadImportSamples(evalSamplesDir)
	if err != nil || len(samples) < 3 {
		t.Fatalf("samples = %d, %v", len(samples), err)
	}
	for _, sample := range samples {
		if sample.Name == "" || len(sample.Units) == 0 || len(sample.Gold) == 0 {
			t.Errorf("sample %+v is incomplete", sample.Name)
		}
	}
	for name, body := range map[string]string{
		"unknown unit":       `{"name":"bad","units":[{"key":"a","question":"q","answer":"a","messageCount":2}],"gold":[{"unitKeys":["a","b"]}]}`,
		"still a draft":      `{"name":"d","draft":true,"units":[{"key":"a","question":"q","answer":"a","messageCount":2}],"gold":[{"unitKeys":["a"]}]}`,
		"a unit needs a key": `{"name":"k","units":[{"key":" ","question":"q","answer":"a","messageCount":2}],"gold":[{"unitKeys":[" "]}]}`,
	} {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "x.json"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadImportSamples(dir); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := loadImportSamples(t.TempDir()); err == nil {
		t.Fatal("an empty directory has no samples")
	}
}

func TestImportRunnerFromEnv(t *testing.T) {
	env := func(values map[string]string) func(string) string { return func(k string) string { return values[k] } }
	if r, _, _, skip, err := importRunnerFromEnv(env(nil)); r != nil || skip == "" || err != nil {
		t.Fatalf("unset: %v %q %v", r, skip, err)
	}
	for _, spec := range []string{"sonnet", "claude-cli:", "nope:x"} {
		if _, _, _, _, err := importRunnerFromEnv(env(map[string]string{envImportModel: spec})); err == nil {
			t.Errorf("%q: no error", spec)
		}
	}
	// A CLI runner needs no key (the binary is looked up when a run starts).
	r, provider, model, skip, err := importRunnerFromEnv(env(map[string]string{envImportModel: " claude-cli : sonnet "}))
	if r == nil || provider != "claude-cli" || model != "sonnet" || skip != "" || err != nil {
		t.Fatalf("claude-cli: %v %q %q %q %v", r, provider, model, skip, err)
	}
}

// A fake model that answers the gold itself scores 1.0; one that answers
// nonsense is recorded as a failure, not fatal.
func TestEvaluateImport_ScoresTheHeuristicAndTheModel(t *testing.T) {
	samples, err := loadImportSamples(evalSamplesDir)
	if err != nil {
		t.Fatal(err)
	}
	byTitle := map[string]domain.ImportAnalyzeEvalSample{}
	for _, s := range samples {
		byTitle[s.Title] = s
	}
	perfect := tangent.RunnerFunc(func(_ context.Context, req tangent.RunRequest) (tangent.RunResult, error) {
		user := req.Messages[len(req.Messages)-1].Content
		for title, sample := range byTitle {
			if !strings.Contains(user, "> "+title) {
				continue
			}
			nodes := []map[string]any{}
			for _, g := range sample.Gold {
				nodes = append(nodes, map[string]any{"unitKeys": g.UnitKeys, "role": g.Role, "title": "t", "attachToKey": sample.Gold[0].UnitKeys[0]})
			}
			raw, _ := json.Marshal(map[string]any{"mode": "tree", "nodes": nodes})
			return tangent.RunResult{Content: string(raw)}, nil
		}
		return tangent.RunResult{Content: "no idea"}, nil
	})
	report, err := evaluateImport(context.Background(), samples, perfect, "fake", "m", domain.ImportAnalyzeKeywordsByWeight)
	if err != nil {
		t.Fatal(err)
	}
	heuristic, model, scored := report.totals()
	if scored != len(samples) || model.Precision() != 1 || model.Recall() != 1 || model.RoleHits != model.RoleTotal {
		t.Fatalf("model = %+v (%d scored)", model, scored)
	}
	if heuristic.Precision() >= 1 || heuristic.Hits == 0 {
		t.Fatalf("the heuristic is scored too: %+v", heuristic)
	}
	var text bytes.Buffer
	report.Markdown(&text)
	if !strings.Contains(text.String(), "| mvcc |") || !strings.Contains(text.String(), "1.00 / 1.00 / 1.00") || !strings.Contains(text.String(), "Model: fake:m (3 of") || !strings.Contains(text.String(), "key terms ranked by weights") {
		t.Fatalf("report:\n%s", text.String())
	}
	broken := tangent.RunnerFunc(func(context.Context, tangent.RunRequest) (tangent.RunResult, error) {
		return tangent.RunResult{Content: "a | b"}, nil
	})
	report, err = evaluateImport(context.Background(), samples[:1], broken, "fake", "m", domain.ImportAnalyzeKeywordsByWeight)
	if err != nil {
		t.Fatal(err)
	}
	if r := report.Results[0]; r.Model != nil || r.ModelErr == "" || !reflect.DeepEqual(report.failed(), []string{samples[0].Name}) {
		t.Fatalf("broken = %+v", r)
	}
	text.Reset()
	report.Markdown(&text)
	if !strings.Contains(text.String(), "failed: ") || strings.Count(text.String(), "a | b") != 0 {
		t.Fatalf("a failure is one escaped cell:\n%s", text.String())
	}
}

func TestRunImport_FailsWhenAModelCallGivesNoPlan(t *testing.T) {
	samples, err := loadImportSamples(evalSamplesDir)
	if err != nil {
		t.Fatal(err)
	}
	broken := tangent.RunnerFunc(func(context.Context, tangent.RunRequest) (tangent.RunResult, error) {
		return tangent.RunResult{}, errors.New("down")
	})
	report, err := evaluateImport(context.Background(), samples, broken, "fake", "m", domain.ImportAnalyzeKeywordsByWeight)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.failed()) != len(samples) {
		t.Fatalf("failed = %v", report.failed())
	}
	if _, model, scored := report.totals(); scored != 0 || model.Hits != 0 {
		t.Fatalf("model = %+v (%d scored)", model, scored)
	}
}

// B26: -import-keywords picks how the prompt ranks each answer's key terms,
// so a model can be scored with either; an unknown ranking is refused.
func TestEvaluateImport_RanksKeyTermsAsAsked(t *testing.T) {
	samples, err := loadImportSamples(evalSamplesDir)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	capture := tangent.RunnerFunc(func(_ context.Context, req tangent.RunRequest) (tangent.RunResult, error) {
		got = append(got, req.Messages[len(req.Messages)-1].Content)
		return tangent.RunResult{}, errors.New("not scored")
	})
	for _, ranking := range []domain.ImportAnalyzeKeywordRanking{domain.ImportAnalyzeKeywordsByWeight, domain.ImportAnalyzeKeywordsByIDF} {
		got = nil
		if _, err := evaluateImport(context.Background(), samples[:1], capture, "fake", "m", ranking); err != nil {
			t.Fatal(err)
		}
		_, messages := domain.BuildImportAnalyzePromptWith(samples[0].Input(), domain.ImportAnalyzePromptOptions{Keywords: ranking}).Chat()
		if len(got) != 1 || got[0] != messages[len(messages)-1].Content {
			t.Fatalf("%s: the model was not asked with that ranking", ranking)
		}
	}
	var out bytes.Buffer
	if code := run([]string{"-mode", "import", "-import-samples", evalSamplesDir, "-import-keywords", "tfidf"}, func(string) string { return "" }, &out); code != 2 || !strings.Contains(out.String(), "-import-keywords") {
		t.Fatalf("an unknown ranking: code = %d\n%s", code, out.String())
	}
}

func TestRun_ImportModeWithoutAModel(t *testing.T) {
	var out bytes.Buffer
	if code := run([]string{"-mode", "import", "-import-samples", evalSamplesDir}, func(string) string { return "" }, &out); code != 0 {
		t.Fatalf("code = %d\n%s", code, out.String())
	}
	if !strings.Contains(out.String(), "Model skipped: set "+envImportModel) || !strings.Contains(out.String(), "| **Total** |") {
		t.Fatalf("output:\n%s", out.String())
	}
	out.Reset()
	if code := run([]string{"-mode", "import", "-import-samples", evalSamplesDir, "-min-import-f1", "99"}, func(string) string { return "" }, &out); code != 1 || !strings.Contains(out.String(), "F1 is") {
		t.Fatalf("code = %d\n%s", code, out.String())
	}
	out.Reset()
	if code := run([]string{"-mode", "import", "-import-samples", evalSamplesDir}, func(k string) string { return map[string]string{envImportModel: "x"}[k] }, &out); code != 2 {
		t.Fatalf("a bad model spec: code = %d\n%s", code, out.String())
	}
}

func TestConvertExport_ChatGPTAndClaude(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer
	if err := convertExport("../../web/e2e/fixtures/chatgpt-conversations.json", dir, &out); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	if len(files) != 2 {
		t.Fatalf("files = %v\n%s", files, out.String())
	}
	// Drafts are refused by the evaluation until labelled.
	if _, err := loadImportSamples(dir); err == nil || !strings.Contains(err.Error(), "draft") {
		t.Fatalf("drafts load: %v", err)
	}
	samples := []domain.ImportAnalyzeEvalSample{}
	for _, file := range files {
		raw, _ := os.ReadFile(file)
		var s domain.ImportAnalyzeEvalSample
		if err := json.Unmarshal(raw, &s); err != nil || !s.Draft {
			t.Fatalf("%s: %v draft=%v", file, err, s.Draft)
		}
		samples = append(samples, s)
	}
	mvcc := samples[1]
	if mvcc.Title != "Postgres MVCC 與索引設計" || len(mvcc.Units) != 9 || len(mvcc.Gold) != 9 || mvcc.Units[8].Key != "u9" || mvcc.Units[0].Answer == "" || mvcc.Units[0].MessageCount != 2 {
		t.Fatalf("mvcc = %s %d units %d gold %+v", mvcc.Title, len(mvcc.Units), len(mvcc.Gold), mvcc.Units[0])
	}
	if !strings.HasPrefix(mvcc.Units[7].Question, "另外") {
		t.Fatalf("u8 = %q", mvcc.Units[7].Question)
	}
	// Running again keeps the files that are there.
	out.Reset()
	if err := convertExport("../../web/e2e/fixtures/chatgpt-conversations.json", dir, &out); err == nil || !strings.Contains(out.String(), "kept ") || !strings.Contains(err.Error(), "no conversation") {
		t.Fatalf("rerun: %v\n%s", err, out.String())
	}
	claude := `[{"uuid":"1","name":"Rust 生命週期","chat_messages":[{"sender":"human","text":"生命週期什麼時候要標?"},{"sender":"assistant","text":"回傳參考且有兩個輸入時。"},{"sender":"assistant","text":"補充。"},{"sender":"human","text":"","content":[{"text":"那 'static 呢?"}]}]},{"uuid":"2","name":"empty","chat_messages":[{"sender":"assistant","text":"hi"}]}]`
	path := filepath.Join(t.TempDir(), "claude.json")
	if err := os.WriteFile(path, []byte(claude), 0o600); err != nil {
		t.Fatal(err)
	}
	dir = t.TempDir()
	out.Reset()
	if err := convertExport(path, dir, &out); err != nil {
		t.Fatal(err)
	}
	files, _ = filepath.Glob(filepath.Join(dir, "*.json"))
	if len(files) != 1 || !strings.Contains(out.String(), `skipped "empty"`) {
		t.Fatalf("files = %v\n%s", files, out.String())
	}
	raw, _ := os.ReadFile(files[0])
	var s domain.ImportAnalyzeEvalSample
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	if s.Title != "Rust 生命週期" || len(s.Units) != 2 || s.Units[0].Answer != "回傳參考且有兩個輸入時。\n補充。" || s.Units[0].MessageCount != 3 || s.Units[1].Question != "那 'static 呢?" {
		t.Fatalf("claude = %+v", s)
	}
	if err := convertExport(filepath.Join(dir, "missing.json"), dir, &out); err == nil {
		t.Fatal("a missing export is an error")
	}
}

// Without a known current_node the branch of last children from the root is
// taken; a cycle ends.
func TestMappingMessages_WithoutACurrentNode(t *testing.T) {
	node := func(parent string, children []string, role, text string) exportedMapNode {
		n := exportedMapNode{Parent: parent, Children: children}
		if role != "" {
			n.Message = &exportedMessage{}
			n.Message.Author.Role = role
			n.Message.Content.Parts = []any{text, 7}
		}
		return n
	}
	c := exportedConversation{Title: "t", CurrentNode: "missing", Mapping: map[string]exportedMapNode{
		"root":   node("", []string{"q1"}, "", ""),
		"q1":     node("root", []string{"a1-old", "a1"}, "user", "Q1"),
		"a1-old": node("q1", nil, "assistant", "old answer"),
		"a1":     node("q1", []string{"q2"}, "assistant", "A1"),
		"q2":     node("a1", nil, "user", "Q2"),
	}}
	got := c.messages()
	want := []exchange{{"user", "Q1"}, {"assistant", "A1"}, {"user", "Q2"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("messages = %v", got)
	}
	loop := exportedConversation{Mapping: map[string]exportedMapNode{"a": node("b", []string{"b"}, "user", "x"), "b": node("a", []string{"a"}, "user", "y")}}
	if got := loop.messages(); len(got) > 2 {
		t.Fatalf("a cycle ends: %v", got)
	}
}
