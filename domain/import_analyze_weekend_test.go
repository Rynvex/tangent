package domain

import (
	"encoding/json"
	"flag"
	"os"
	"reflect"
	"testing"
)

// The coordinator's probe (B22 review): twelve rounds where NAS backups,
// asyncio, coffee and a trip interleave, and r6's question shares 排程 with
// r5's asyncio answer. The plan is kept in testdata so the web client's
// analyzeImportLocal is checked against the very same output.

var updateAnalyzeGolden = flag.Bool("update-analyze", false, "rewrite testdata/import_analyze_weekend.plan.json")

const (
	weekendInput = "testdata/import_analyze_weekend.input.json"
	weekendPlan  = "testdata/import_analyze_weekend.plan.json"
)

func weekendUnits(t *testing.T) ImportAnalyzeInput {
	t.Helper()
	raw, err := os.ReadFile(weekendInput)
	if err != nil {
		t.Fatal(err)
	}
	var in ImportAnalyzeInput
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatal(err)
	}
	return in
}

func TestAnalyzeImportDeterministic_WordsEveryTopicAsksDoNotThread(t *testing.T) {
	// Every topic's follow-ups ask "…要怎麼設定?": 設定 is in the questions of
	// several topics, so it does not pull Rust's follow-up into Nginx.
	topics := [][2]string{{"Docker", "容器"}, {"Nginx", "反向代理"}, {"Rust", "所有權"}}
	units := []ImportAnalyzeUnit{}
	for _, topic := range topics {
		for n := 0; n < 3; n++ {
			question := topic[0] + " " + topic[1] + "是什麼?"
			if n > 0 {
				question = topic[0] + " 的" + topic[1] + "第 " + string(rune('0'+n)) + " 點要怎麼設定?"
			}
			units = append(units, ImportAnalyzeUnit{Key: topic[0] + string(rune('0'+n)), Question: question, Answer: "先確認版本，再照步驟調整。", MessageCount: 2})
		}
	}
	plan, err := AnalyzeImportDeterministic(ImportAnalyzeInput{Units: units})
	if err != nil {
		t.Fatal(err)
	}
	got := [][]string{}
	for _, node := range plan.Nodes {
		got = append(got, node.UnitKeys)
	}
	want := [][]string{{"Docker0", "Docker1", "Docker2"}, {"Nginx0", "Nginx1", "Nginx2"}, {"Rust0", "Rust1", "Rust2"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("nodes = %v", got)
	}
}

func TestAnalyzeImportDeterministic_AnAnswersWordDoesNotPullAnotherTopicAlong(t *testing.T) {
	plan, err := AnalyzeImportDeterministic(weekendUnits(t))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][]string{}
	roles := map[string]string{}
	for _, node := range plan.Nodes {
		got[node.Key] = node.UnitKeys
		roles[node.Key] = node.Role
	}
	want := map[string][]string{
		"r1": {"r1", "r3", "r6", "r7", "r9", "r12"},
		"r2": {"r2", "r5", "r10", "r11"},
		"r4": {"r4"},
		"r8": {"r8"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("nodes = %v, want %v", got, want)
	}
	// NAS runs from #1 to #12, so asyncio, coffee and the trip start inside it: detours.
	if roles["r1"] != ImportRoleChapter || roles["r2"] != ImportRoleMergedBranch || roles["r4"] != ImportRoleMergedBranch || roles["r8"] != ImportRoleMergedBranch {
		t.Fatalf("roles = %v", roles)
	}
	encoded, err := json.MarshalIndent(plan, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	if *updateAnalyzeGolden {
		if err := os.WriteFile(weekendPlan, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	golden, err := os.ReadFile(weekendPlan)
	if err != nil {
		t.Fatalf("%v (run go test ./domain -run AnAnswersWord -update-analyze)", err)
	}
	if string(golden) != string(encoded) {
		t.Fatalf("the plan differs from %s (rerun with -update-analyze if intended):\n%s", weekendPlan, encoded)
	}
}
