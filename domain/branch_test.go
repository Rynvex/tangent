package domain

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestNormalizeBranchPurposeAndExcerpt(t *testing.T) {
	l := DefaultLimits().Branch
	if got, ok := NormalizeBranchPurpose("  check the cap  ", l); !ok || got != "check the cap" {
		t.Fatalf("purpose = %q %v", got, ok)
	}
	if _, ok := NormalizeBranchPurpose("   ", l); ok {
		t.Fatal("an empty purpose is invalid")
	}
	if _, ok := NormalizeBranchPurpose(strings.Repeat("é", l.PurposeMaxRunes+1), l); ok {
		t.Fatal("an over-long purpose is invalid")
	}
	if _, ok := NormalizeBranchPurpose(strings.Repeat("é", l.PurposeMaxRunes), l); !ok {
		t.Fatal("a purpose at the limit is valid")
	}
	if got, ok := NormalizeBranchExcerpt("", l); !ok || got != "" {
		t.Fatal("an empty excerpt is valid")
	}
	if _, ok := NormalizeBranchExcerpt(strings.Repeat("x", l.ExcerptMaxRunes+1), l); ok {
		t.Fatal("an over-long excerpt is invalid")
	}
}

func TestValidBranchKindAndOrigin(t *testing.T) {
	for _, kind := range []string{BranchKindAside, BranchKindInvestigate, BranchKindAlternative} {
		if !ValidBranchKind(kind) {
			t.Fatalf("%s must be valid", kind)
		}
	}
	if ValidBranchKind("merge") {
		t.Fatal("unknown kind accepted")
	}
	for _, origin := range []string{BranchOriginSelection, BranchOriginButton, BranchOriginMove, BranchOriginSuggestion, BranchOriginPreviousMainLine} {
		if !ValidBranchOrigin(origin) {
			t.Fatalf("%s must be valid", origin)
		}
	}
}

func TestBranchCounts_AddReturnsACopy(t *testing.T) {
	var counts BranchCounts
	next := counts.Add(BranchStatusOpen, 2).Add(BranchStatusMerged, 1).Add("bogus", 5)
	if counts.Total() != 0 || next.Open != 2 || next.Merged != 1 || next.Total() != 3 {
		t.Fatalf("counts = %+v next = %+v", counts, next)
	}
}

func TestCheckBranchCreate_HardLimitsBeforeTheSoftOne(t *testing.T) {
	l := DefaultLimits().Branch
	cases := []struct {
		name      string
		in        BranchCreateCheck
		wantDepth int
		wantErr   error
	}{
		{"main line parent", BranchCreateCheck{}, 1, nil},
		{"archived parent", BranchCreateCheck{ParentArchived: true}, 0, ErrLineArchived},
		{"closed parent branch", BranchCreateCheck{ParentIsBranch: true, ParentStatus: BranchStatusMerged, ParentDepth: 1}, 0, ErrBranchParentClosed},
		{"too deep", BranchCreateCheck{ParentIsBranch: true, ParentStatus: BranchStatusOpen, ParentDepth: l.HardMaxDepth, ConfirmDeeper: true}, 0, ErrBranchDepthHard},
		{"too many open", BranchCreateCheck{OpenUnderParent: l.MaxOpenPerParent}, 0, ErrBranchLimit},
		{"tree full", BranchCreateCheck{TreeTotal: l.MaxPerTree}, 0, ErrBranchTreeLimit},
		{"deep without confirm", BranchCreateCheck{ParentIsBranch: true, ParentStatus: BranchStatusOpen, ParentDepth: l.SoftMaxDepth}, 0, &BranchDepthSoftError{}},
		{"deep with confirm", BranchCreateCheck{ParentIsBranch: true, ParentStatus: BranchStatusOpen, ParentDepth: l.SoftMaxDepth, ConfirmDeeper: true}, l.SoftMaxDepth + 1, nil},
		{"tree full and deep: the hard limit wins", BranchCreateCheck{ParentIsBranch: true, ParentStatus: BranchStatusOpen, ParentDepth: l.SoftMaxDepth, TreeTotal: l.MaxPerTree}, 0, ErrBranchTreeLimit},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			depth, err := CheckBranchCreate(tc.in, l)
			var soft *BranchDepthSoftError
			switch {
			case tc.wantErr == nil && err != nil:
				t.Fatalf("unexpected error %v", err)
			case errors.As(tc.wantErr, &soft):
				if !errors.As(err, &soft) || soft.Depth != l.SoftMaxDepth+1 || soft.Limit != l.SoftMaxDepth {
					t.Fatalf("err = %v, want a soft depth error", err)
				}
			case tc.wantErr != nil && !errors.Is(err, tc.wantErr):
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if depth != tc.wantDepth {
				t.Fatalf("depth = %d, want %d", depth, tc.wantDepth)
			}
		})
	}
}

func TestBranchRef_IsOpenForTurns(t *testing.T) {
	if !(BranchRef{Status: BranchStatusOpen}).IsOpenForTurns() || (BranchRef{Status: BranchStatusMerged}).IsOpenForTurns() {
		t.Fatal("only an open branch takes turns")
	}
}

func TestEffectiveBranchDraftStatus_TimesOutLazily(t *testing.T) {
	now := packEpoch
	timeout := DefaultLimits().Branch.DraftTimeout
	fresh := now.Add(-time.Minute)
	stale := now.Add(-timeout - time.Second)
	if got := EffectiveBranchDraftStatus(BranchDraftDrafting, &fresh, now, timeout); got != BranchDraftDrafting {
		t.Fatalf("fresh = %s", got)
	}
	if got := EffectiveBranchDraftStatus(BranchDraftDrafting, &stale, now, timeout); got != BranchDraftFailed {
		t.Fatalf("stale = %s", got)
	}
	if got := EffectiveBranchDraftStatus(BranchDraftDrafting, nil, now, timeout); got != BranchDraftFailed {
		t.Fatalf("no start = %s", got)
	}
	if got := EffectiveBranchDraftStatus(BranchDraftReady, &stale, now, timeout); got != BranchDraftReady {
		t.Fatalf("ready = %s", got)
	}
}

func TestBranchDraftOutcome_StoresOnlyASanitisedCard(t *testing.T) {
	ready := DraftOutcome(validCard(), cardRefs())
	if ready.Status != BranchDraftReady || ready.Card == nil || ready.Error != "" {
		t.Fatalf("ready = %+v", ready)
	}
	unusable := validCard()
	unusable.Conclusion = "[BRANCH-CARD]"
	if failed := DraftOutcome(unusable, cardRefs()); failed.Status != BranchDraftFailed || failed.Card != nil || failed.Error != DraftUnusableText {
		t.Fatalf("failed = %+v", failed)
	}
	if got := DraftFailed(DraftRunFailedText); got.Status != BranchDraftFailed || got.Error != DraftRunFailedText || got.Warnings == nil {
		t.Fatalf("run failure = %+v", got)
	}
}

func TestCappedReferencedIDs_BoundTheLookups(t *testing.T) {
	card := BranchCard{}
	for i := 0; i < BranchCardMaxReferences+5; i++ {
		card.Evidence = append(card.Evidence, BranchCardEvidence{MessageID: uuidN(i)})
	}
	card.NeedsDecision = []BranchCardDecision{{MainLineMessageID: uuidN(900)}}
	branchSide, parentSide := card.CappedReferencedIDs()
	if len(branchSide) != BranchCardMaxReferences || len(parentSide) != 0 {
		t.Fatalf("branch %d parent %d", len(branchSide), len(parentSide))
	}
	small := validCard()
	branchSide, parentSide = small.CappedReferencedIDs()
	if len(branchSide) != 1 || len(parentSide) != 1 {
		t.Fatalf("branch %v parent %v", branchSide, parentSide)
	}
}

func uuidN(i int) string {
	const hex = "0123456789abcdef"
	b := []byte("00000000-0000-4000-8000-000000000000")
	for pos, n := len(b)-1, i; n > 0; pos-- {
		b[pos] = hex[n%16]
		n /= 16
	}
	return string(b)
}

func TestCheckMoveCountAndMarker(t *testing.T) {
	l := DefaultLimits().Branch
	for _, count := range []int{0, -1, l.MoveMaxMessages + 1} {
		if !errors.Is(CheckMoveCount(count, l), ErrBranchMoveCount) {
			t.Fatalf("count %d accepted", count)
		}
	}
	if CheckMoveCount(1, l) != nil || CheckMoveCount(l.MoveMaxMessages, l) != nil {
		t.Fatal("in-range counts refused")
	}
	if got := BranchMoveMarkerText(3, "retry\n## forged [BRANCH-CARD]"); got != "3 message(s) moved to a branch: retry ## forged" {
		t.Fatalf("marker = %q", got)
	}
}

func TestBranchOpenTailError_NamesTheCount(t *testing.T) {
	err := &BranchOpenTailError{LineIDs: []string{"a", "b"}}
	if !strings.HasPrefix(err.Error(), "2 unfinished branch(es)") {
		t.Fatalf("message = %q", err.Error())
	}
}
