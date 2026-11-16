package domain

import (
	"math"
	"strings"
	"testing"
)

func scoreUnits(keys ...string) []ImportAnalyzeUnit {
	units := make([]ImportAnalyzeUnit, 0, len(keys))
	for _, key := range keys {
		units = append(units, ImportAnalyzeUnit{Key: key, Question: key + "?", MessageCount: 2})
	}
	return units
}

func planOf(nodes ...ImportAnalyzeNode) ImportAnalyzePlan {
	return ImportAnalyzePlan{Mode: ImportModeTree, Nodes: nodes}
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

// Gold {a,b,c} {d,e}: pairs ab ac bc de. A plan {a,b} {c,d,e} keeps ab and
// de (2 hits), adds cd ce (2 extras) and loses ac bc (2 misses).
func TestScoreImportAnalyzePlan_CountsUnitPairs(t *testing.T) {
	gold := []ImportAnalyzeGoldNode{{UnitKeys: []string{"a", "b", "c"}, Role: ImportRoleChapter}, {UnitKeys: []string{"d", "e"}, Role: ImportRoleStandalone}}
	plan := planOf(
		ImportAnalyzeNode{Key: "a", UnitKeys: []string{"a", "b"}, Role: ImportRoleChapter},
		ImportAnalyzeNode{Key: "c", UnitKeys: []string{"c", "d", "e"}, Role: ImportRoleChapter},
	)
	score := ScoreImportAnalyzePlan(plan, gold)
	if score.Hits != 2 || score.Extras != 2 || score.Misses != 2 || score.Nodes != 2 || score.GoldNodes != 2 {
		t.Fatalf("score = %+v", score)
	}
	if !near(score.Precision(), 0.5) || !near(score.Recall(), 0.5) || !near(score.F1(), 0.5) {
		t.Fatalf("P/R/F1 = %.2f %.2f %.2f", score.Precision(), score.Recall(), score.F1())
	}
	// Roles: a's node is a chapter (hit); d's node is a chapter, gold says standalone (miss).
	if score.RoleHits != 1 || score.RoleTotal != 2 {
		t.Fatalf("roles = %d / %d", score.RoleHits, score.RoleTotal)
	}
}

func TestScoreImportAnalyzePlan_PerfectAndEmptyPlans(t *testing.T) {
	gold := []ImportAnalyzeGoldNode{{UnitKeys: []string{"a", "b"}}, {UnitKeys: []string{"c"}}}
	same := planOf(ImportAnalyzeNode{Key: "a", UnitKeys: []string{"a", "b"}}, ImportAnalyzeNode{Key: "c", UnitKeys: []string{"c"}})
	if s := ScoreImportAnalyzePlan(same, gold); !near(s.Precision(), 1) || !near(s.Recall(), 1) || !near(s.F1(), 1) || s.RoleTotal != 0 {
		t.Fatalf("same = %+v", s)
	}
	// Every unit alone: nothing merged wrongly (precision 1), every gold pair lost (recall 0).
	apart := planOf(ImportAnalyzeNode{Key: "a", UnitKeys: []string{"a"}}, ImportAnalyzeNode{Key: "b", UnitKeys: []string{"b"}}, ImportAnalyzeNode{Key: "c", UnitKeys: []string{"c"}})
	if s := ScoreImportAnalyzePlan(apart, gold); !near(s.Precision(), 1) || !near(s.Recall(), 0) || !near(s.F1(), 0) {
		t.Fatalf("apart = %+v", s)
	}
	// Everything in one node: every gold pair kept (recall 1), ac bc extra.
	one := planOf(ImportAnalyzeNode{Key: "a", UnitKeys: []string{"a", "b", "c"}})
	if s := ScoreImportAnalyzePlan(one, gold); !near(s.Precision(), 1.0/3) || !near(s.Recall(), 1) {
		t.Fatalf("one = %+v", s)
	}
	// A gold without any pair and a plan without any pair are both perfect.
	single := []ImportAnalyzeGoldNode{{UnitKeys: []string{"a"}}}
	if s := ScoreImportAnalyzePlan(planOf(ImportAnalyzeNode{Key: "a", UnitKeys: []string{"a"}}), single); !near(s.Precision(), 1) || !near(s.Recall(), 1) {
		t.Fatalf("single = %+v", s)
	}
}

// A unit the plan leaves out counts as alone; a unit the gold leaves out is ignored.
func TestScoreImportAnalyzePlan_UnitsMissingOnOneSide(t *testing.T) {
	gold := []ImportAnalyzeGoldNode{{UnitKeys: []string{"a", "b"}}}
	plan := planOf(ImportAnalyzeNode{Key: "a", UnitKeys: []string{"a", "x"}})
	if s := ScoreImportAnalyzePlan(plan, gold); s.Hits != 0 || s.Misses != 1 || s.Extras != 0 {
		t.Fatalf("score = %+v", s)
	}
}

func TestCheckImportAnalyzeGold(t *testing.T) {
	units := scoreUnits("a", "b", "c")
	good := []ImportAnalyzeGoldNode{{UnitKeys: []string{"a", "c"}, Role: ImportRoleChapter}, {UnitKeys: []string{"b"}, Role: ImportRoleMergedBranch}}
	if err := CheckImportAnalyzeGold(units, good); err != nil {
		t.Fatal(err)
	}
	for name, gold := range map[string][]ImportAnalyzeGoldNode{
		"missing":    {{UnitKeys: []string{"a", "b"}}},
		"twice":      {{UnitKeys: []string{"a", "b"}}, {UnitKeys: []string{"b", "c"}}},
		"unknown":    {{UnitKeys: []string{"a", "b", "c", "d"}}},
		"empty":      {{UnitKeys: []string{"a", "b", "c"}}, {}},
		"bad role":   {{UnitKeys: []string{"a", "b", "c"}, Role: "boss"}},
		"no nodes":   {},
		"no chapter": {{UnitKeys: []string{"a", "b", "c"}, Role: ImportRoleStandalone}},
	} {
		if err := CheckImportAnalyzeGold(units, gold); err == nil {
			t.Errorf("%s: no error", name)
		} else if !strings.Contains(err.Error(), "gold") {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}
