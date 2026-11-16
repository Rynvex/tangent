package domain

import (
	"fmt"
	"strings"
)

// Scoring an import analysis against a hand-labelled plan (the gold): how
// many pairs of units the plan puts together as the gold does. Over-merging
// shows as extra pairs (low precision), over-splitting as missed pairs (low
// recall). The gold's roles, when given, are checked by the node that holds
// each gold node's first unit.

// ImportAnalyzeGoldNode is one node of a hand-labelled plan: its units in
// order, its role (optional) and why the labeller grouped them (optional).
type ImportAnalyzeGoldNode struct {
	UnitKeys []string `json:"unitKeys"`
	Role     string   `json:"role,omitempty"`
	Note     string   `json:"note,omitempty"`
}

// ImportAnalyzeEvalSample is one hand-labelled conversation: the analysis
// input and the plan it should give. Where the units came from is Source.
// Draft marks a converted export whose gold nobody has labelled yet (one
// node per unit); an evaluation refuses it.
type ImportAnalyzeEvalSample struct {
	Name   string                  `json:"name"`
	Source string                  `json:"source,omitempty"`
	Draft  bool                    `json:"draft,omitempty"`
	Title  string                  `json:"title,omitempty"`
	Units  []ImportAnalyzeUnit     `json:"units"`
	Gold   []ImportAnalyzeGoldNode `json:"gold"`
}

// Input is the sample as an analysis input.
func (s ImportAnalyzeEvalSample) Input() ImportAnalyzeInput {
	return ImportAnalyzeInput{Title: s.Title, Units: s.Units}
}

// ImportAnalyzeScore is a plan's agreement with a gold: unit pairs the plan
// and the gold both put in one node (Hits), pairs only the plan joins
// (Extras: over-merging), pairs only the gold joins (Misses:
// over-splitting), and the gold nodes whose first unit the plan gave the
// gold's role (RoleHits of RoleTotal, counting gold nodes with a role).
type ImportAnalyzeScore struct {
	Hits, Extras, Misses int
	RoleHits, RoleTotal  int
	Nodes, GoldNodes     int
}

// Precision is the share of the plan's pairs the gold has; 1 without any.
func (s ImportAnalyzeScore) Precision() float64 { return ratio(s.Hits, s.Hits+s.Extras) }

// Recall is the share of the gold's pairs the plan has; 1 without any.
func (s ImportAnalyzeScore) Recall() float64 { return ratio(s.Hits, s.Hits+s.Misses) }

// F1 is the harmonic mean of precision and recall.
func (s ImportAnalyzeScore) F1() float64 {
	p, r := s.Precision(), s.Recall()
	if p+r == 0 {
		return 0
	}
	return 2 * p * r / (p + r)
}

// RoleAccuracy is the share of the gold's roles the plan gave; 1 without any.
func (s ImportAnalyzeScore) RoleAccuracy() float64 { return ratio(s.RoleHits, s.RoleTotal) }

// Add is the score of both together (pairs and roles summed).
func (s ImportAnalyzeScore) Add(o ImportAnalyzeScore) ImportAnalyzeScore {
	return ImportAnalyzeScore{
		Hits: s.Hits + o.Hits, Extras: s.Extras + o.Extras, Misses: s.Misses + o.Misses,
		RoleHits: s.RoleHits + o.RoleHits, RoleTotal: s.RoleTotal + o.RoleTotal,
		Nodes: s.Nodes + o.Nodes, GoldNodes: s.GoldNodes + o.GoldNodes,
	}
}

func ratio(part, whole int) float64 {
	if whole == 0 {
		return 1
	}
	return float64(part) / float64(whole)
}

// ScoreImportAnalyzePlan compares plan with gold over the gold's units: a
// unit the plan leaves out is alone, a unit the gold leaves out is ignored.
func ScoreImportAnalyzePlan(plan ImportAnalyzePlan, gold []ImportAnalyzeGoldNode) ImportAnalyzeScore {
	planNode := map[string]int{}
	for i, node := range plan.Nodes {
		for _, key := range node.UnitKeys {
			planNode[key] = i
		}
	}
	keys := []string{}
	goldNode := map[string]int{}
	for i, node := range gold {
		for _, key := range node.UnitKeys {
			if _, seen := goldNode[key]; !seen {
				keys = append(keys, key)
			}
			goldNode[key] = i
		}
	}
	score := ImportAnalyzeScore{Nodes: len(plan.Nodes), GoldNodes: len(gold)}
	for i, a := range keys {
		for _, b := range keys[i+1:] {
			inGold := goldNode[a] == goldNode[b]
			na, okA := planNode[a]
			nb, okB := planNode[b]
			inPlan := okA && okB && na == nb
			switch {
			case inGold && inPlan:
				score.Hits++
			case inPlan:
				score.Extras++
			case inGold:
				score.Misses++
			}
		}
	}
	for _, node := range gold {
		if node.Role == "" || len(node.UnitKeys) == 0 {
			continue
		}
		score.RoleTotal++
		if i, ok := planNode[node.UnitKeys[0]]; ok && plan.Nodes[i].Role == node.Role {
			score.RoleHits++
		}
	}
	return score
}

// CheckImportAnalyzeGold refuses a gold that is not a plan of units: every
// unit in exactly one node, no unknown unit, no empty node, roles known
// when given, and at least one chapter when any role is given.
func CheckImportAnalyzeGold(units []ImportAnalyzeUnit, gold []ImportAnalyzeGoldNode) error {
	if len(gold) == 0 {
		return fmt.Errorf("gold: no nodes")
	}
	known := map[string]bool{}
	for _, unit := range units {
		known[unit.Key] = true
	}
	seen := map[string]bool{}
	hasRole, hasChapter := false, false
	for i, node := range gold {
		if len(node.UnitKeys) == 0 {
			return fmt.Errorf("gold[%d]: no units", i)
		}
		for _, key := range node.UnitKeys {
			switch {
			case !known[key]:
				return fmt.Errorf("gold[%d]: unknown unit %q", i, key)
			case seen[key]:
				return fmt.Errorf("gold[%d]: unit %q is in two nodes", i, key)
			}
			seen[key] = true
		}
		if node.Role != "" {
			if knownAnalyzeRole(node.Role) != node.Role {
				return fmt.Errorf("gold[%d]: unknown role %q", i, node.Role)
			}
			hasRole = true
			hasChapter = hasChapter || node.Role == ImportRoleChapter
		}
	}
	missing := []string{}
	for _, unit := range units {
		if !seen[unit.Key] {
			missing = append(missing, unit.Key)
		}
	}
	switch {
	case len(missing) > 0:
		return fmt.Errorf("gold: units not in any node: %s", strings.Join(missing, ", "))
	case hasRole && !hasChapter:
		return fmt.Errorf("gold: roles given but no chapter")
	}
	return nil
}
