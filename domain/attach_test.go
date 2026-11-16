package domain

import (
	"errors"
	"strings"
	"testing"
)

func TestCheckAttach_CountsTheSourceTree(t *testing.T) {
	l := DefaultLimits().Branch
	main := BranchCreateCheck{}
	cases := []struct {
		name  string
		in    AttachCheck
		depth int
		err   error
	}{
		{"under a main line", AttachCheck{Parent: main, Status: AttachStatusOpen}, 1, nil},
		{"under a branch", AttachCheck{Parent: BranchCreateCheck{ParentIsBranch: true, ParentStatus: BranchStatusOpen, ParentDepth: 1}, Status: AttachStatusOpen, SubtreeDepth: 1}, 2, nil},
		{"archived", AttachCheck{Parent: BranchCreateCheck{ParentArchived: true}}, 0, ErrLineArchived},
		{"closed parent", AttachCheck{Parent: BranchCreateCheck{ParentIsBranch: true, ParentStatus: BranchStatusMerged}}, 0, ErrBranchParentClosed},
		{"hard depth", AttachCheck{Parent: BranchCreateCheck{ParentIsBranch: true, ParentStatus: BranchStatusOpen, ParentDepth: 3, ConfirmDeeper: true}, SubtreeDepth: 3}, 0, ErrBranchDepthHard},
		{"open limit", AttachCheck{Parent: BranchCreateCheck{OpenUnderParent: l.MaxOpenPerParent}, Status: AttachStatusOpen}, 0, ErrBranchLimit},
		{"a merged attach is not open", AttachCheck{Parent: BranchCreateCheck{OpenUnderParent: l.MaxOpenPerParent}, Status: AttachStatusMerged}, 1, nil},
		{"tree limit", AttachCheck{Parent: BranchCreateCheck{TreeTotal: l.MaxPerTree - 2}, Status: AttachStatusOpen, SubtreeLines: 2}, 0, ErrBranchTreeLimit},
		{"tree exactly full", AttachCheck{Parent: BranchCreateCheck{TreeTotal: l.MaxPerTree - 3}, Status: AttachStatusOpen, SubtreeLines: 2}, 1, nil},
		{"confirmed deeper", AttachCheck{Parent: BranchCreateCheck{ConfirmDeeper: true}, Status: AttachStatusOpen, SubtreeDepth: 4}, 1, nil},
	}
	for _, c := range cases {
		depth, err := CheckAttach(c.in, l)
		if depth != c.depth || !errors.Is(err, c.err) {
			t.Fatalf("%s: depth %d err %v, want %d %v", c.name, depth, err, c.depth, c.err)
		}
	}
	var soft *BranchDepthSoftError
	if _, err := CheckAttach(AttachCheck{Parent: main, Status: AttachStatusOpen, SubtreeDepth: 3}, l); !errors.As(err, &soft) || soft.Depth != 4 {
		t.Fatalf("the source's depth counts against the soft limit: %v", err)
	}
}

func TestAttachInputs_StatusKindPurposeAndCard(t *testing.T) {
	if s, err := NormalizeAttachStatus(" "); s != AttachStatusOpen || err != nil {
		t.Fatalf("default status %q %v", s, err)
	}
	if _, err := NormalizeAttachStatus("discarded"); CodeOf(err) != CodeInvalidInput {
		t.Fatalf("bad status: %v", err)
	}
	if k, err := NormalizeAttachKind(""); k != BranchKindInvestigate || err != nil {
		t.Fatalf("default kind %q %v", k, err)
	}
	if _, err := NormalizeAttachKind(BranchKindAside); !errors.Is(err, ErrKindUnsupported) {
		t.Fatalf("aside: %v", err)
	}
	l := DefaultLimits().Branch
	for _, c := range []struct{ given, title, user, any, want string }{
		{"given", "title", "q", "a", "given"},
		{"", " Title\nline ", "q", "a", "Title line"},
		{"", "", "first question", "a", "first question"},
		{"", "", "", "only an answer", "only an answer"},
		{"", "", strings.Repeat("長", 80), "", strings.Repeat("長", ImportTitleRunes-1) + "…"},
	} {
		if got, ok := AttachPurpose(c.given, c.title, c.user, c.any, l); !ok || got != c.want {
			t.Fatalf("purpose(%q, %q) = %q %v, want %q", c.given, c.title, got, ok, c.want)
		}
	}
	if _, ok := AttachPurpose(strings.Repeat("x", l.PurposeMaxRunes+1), "", "", "", l); ok {
		t.Fatal("a given purpose that is too long is refused")
	}
	if got, ok := AttachPurpose("", strings.Repeat("t", l.PurposeMaxRunes+5), "", "", l); !ok || len([]rune(got)) != l.PurposeMaxRunes {
		t.Fatalf("a long title is cut to the limit: %d %v", len([]rune(got)), ok)
	}
	card := &BranchCard{Conclusion: "done"}
	if _, err := PlanAttachCard(card, AttachStatusOpen, "p"); CodeOf(err) != CodeInvalidInput {
		t.Fatalf("a card on an open attach: %v", err)
	}
	if _, err := PlanAttachCard(nil, AttachStatusMerged, "p"); CodeOf(err) != CodeInvalidInput {
		t.Fatalf("merged without a card: %v", err)
	}
	filled, err := PlanAttachCard(card, AttachStatusMerged, "the purpose")
	if err != nil || filled.Question != "the purpose" || card.Question != "" {
		t.Fatalf("filled %+v %v (the input is not changed: %q)", filled, err, card.Question)
	}
	if _, err := PlanAttachCard(&BranchCard{}, AttachStatusMerged, "p"); CodeOf(err) != CodeInvalidCard {
		t.Fatalf("no conclusion: %v", err)
	}
}
