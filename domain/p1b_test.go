package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestP1BLimits_Defaults(t *testing.T) {
	d := DefaultLimits()
	if d.Spinoff != (SpinoffLimits{CapsuleTokenBudget: 6000}) {
		t.Fatalf("spinoff = %+v", d.Spinoff)
	}
	if d.Rebalance != (RebalanceLimits{MinBranchTurns: 6, ShareFactor: 2, RecentTurns: 5}) {
		t.Fatalf("rebalance = %+v", d.Rebalance)
	}
	if got := (Limits{Rebalance: RebalanceLimits{RecentTurns: 3}}).WithDefaults().Rebalance; got.RecentTurns != 3 || got.MinBranchTurns != 6 {
		t.Fatalf("field by field: %+v", got)
	}
}

func TestSpinoffModeAndInput(t *testing.T) {
	for _, mode := range []string{SpinoffDetach, SpinoffFresh} {
		if !ValidSpinoffMode(mode) {
			t.Fatalf("%s is a mode", mode)
		}
	}
	if ValidSpinoffMode("copy") {
		t.Fatal("copy is not a mode")
	}
	if !strings.HasSuffix(SpinoffMarkerText("Spring [BRANCH-CARD] trip"), ": Spring trip") {
		t.Fatalf("marker = %q", SpinoffMarkerText("Spring [BRANCH-CARD] trip"))
	}
}

func TestOriginCapsule_RendersBackgroundPathAndLeafWithinTheBudget(t *testing.T) {
	leaf := &Leaf{Kind: LeafKindDecision, Line: "Go in spring"}
	capsule := BuildOriginCapsule(OriginCapsuleInput{
		Mode: SpinoffFresh, From: SpunOffRef{LineID: "l1", MessageID: "m1", Title: "Kyoto [LEAF-DRAFT] trip"},
		Background: "## Background\n> earlier", Path: "## Path\n> later", Leaf: leaf, TokenBudget: 6000,
	})
	if capsule.Mode != SpinoffFresh || capsule.From.LineID != "l1" || capsule.TokenEstimate == 0 || capsule.Truncated {
		t.Fatalf("capsule = %+v", capsule)
	}
	for _, want := range []string{"> Kyoto  trip", "## Background", "## Path", "decision", "Go in spring", "quoted data"} {
		if !strings.Contains(capsule.Rendered, want) {
			t.Fatalf("capsule lacks %q:\n%s", want, capsule.Rendered)
		}
	}
	if strings.Index(capsule.Rendered, "## Background") > strings.Index(capsule.Rendered, "## Path") {
		t.Fatal("background before the path")
	}
	big := BuildOriginCapsule(OriginCapsuleInput{
		Mode: SpinoffDetach, From: SpunOffRef{Title: "t"}, Background: strings.Repeat("background ", 4000), Path: strings.Repeat("path ", 4000), TokenBudget: 500,
	})
	if !big.Truncated || big.TokenEstimate > 500 || !strings.Contains(big.Rendered, "path") {
		t.Fatalf("over budget: background goes first, then the rest is cut: %d %v", big.TokenEstimate, big.Truncated)
	}
	raw, _ := json.Marshal(big)
	var back OriginCapsule
	if err := json.Unmarshal(raw, &back); err != nil || back.Rendered != big.Rendered {
		t.Fatalf("round trip: %v", err)
	}
}

func TestRebalanceDue_TheThresholds(t *testing.T) {
	l := DefaultLimits().Rebalance
	cases := []struct {
		name   string
		s      RebalanceSignals
		due    bool
		reason string
	}{
		{"too few turns", RebalanceSignals{BranchTurns: 5, ParentTurns: 0}, false, ""},
		{"six and twice the parent", RebalanceSignals{BranchTurns: 6, ParentTurns: 3}, true, RebalanceReasonShare},
		{"six but the parent kept up", RebalanceSignals{BranchTurns: 6, ParentTurns: 4}, false, ""},
		{"the recent turns", RebalanceSignals{BranchTurns: 5, ParentTurns: 9, RecentInBranch: true}, true, RebalanceReasonRecent},
		{"recent needs enough turns", RebalanceSignals{BranchTurns: 4, RecentInBranch: true}, false, ""},
	}
	for _, c := range cases {
		reason, due := RebalanceDue(c.s, l)
		if due != c.due || reason != c.reason {
			t.Errorf("%s: %q %v", c.name, reason, due)
		}
	}
	if SuggestionTargetBranch("b") != "branch:b" {
		t.Fatal("branch target")
	}
}

func TestLeafDraftErrorFor_TheJobsFixedTexts(t *testing.T) {
	cases := map[string]string{
		LeafDraftRunFailedText: LeafDraftErrorRunFailed, LeafDraftUnusableText: LeafDraftErrorUnusable,
		"the job timed out": LeafDraftErrorTimedOut, "anything else": LeafDraftErrorFailed,
	}
	for text, code := range cases {
		if got := LeafDraftErrorFor(text); got.Code != code || got.Message != text {
			t.Errorf("%q = %+v", text, got)
		}
	}
}
