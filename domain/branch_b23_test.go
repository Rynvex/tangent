package domain

import (
	"errors"
	"testing"
)

func TestBranchDeletable(t *testing.T) {
	cases := []struct {
		name                             string
		kind, status, origin, mergedInto string
		want                             bool
	}{
		{"an ended aside", BranchKindAside, BranchStatusDiscarded, BranchOriginButton, "", true},
		{"an open aside", BranchKindAside, BranchStatusOpen, BranchOriginButton, "", false},
		{"a discarded branch", BranchKindInvestigate, BranchStatusDiscarded, BranchOriginSelection, "", true},
		{"a discarded alternative", BranchKindAlternative, BranchStatusDiscarded, BranchOriginImport, "", true},
		{"an open branch", BranchKindInvestigate, BranchStatusOpen, BranchOriginButton, "", false},
		{"a merged branch", BranchKindInvestigate, BranchStatusMerged, BranchOriginButton, "", false},
		{"a promoted branch", BranchKindAlternative, BranchStatusPromoted, BranchOriginButton, "", false},
		{"the previous main line", BranchKindAlternative, BranchStatusDiscarded, BranchOriginPreviousMainLine, "", false},
		{"combined into another", BranchKindInvestigate, BranchStatusDiscarded, BranchOriginButton, "00000000-0000-4000-8000-000000000001", false},
	}
	for _, c := range cases {
		if got := BranchDeletable(c.kind, c.status, c.origin, c.mergedInto); got != c.want {
			t.Errorf("%s: deletable = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestNormalizeContinueKind(t *testing.T) {
	for in, want := range map[string]string{"": BranchKindInvestigate, " investigate ": BranchKindInvestigate, "alternative": BranchKindAlternative} {
		if got, err := NormalizeContinueKind(in); err != nil || got != want {
			t.Errorf("%q = %q, %v", in, got, err)
		}
	}
	for _, in := range []string{BranchKindAside, "nope"} {
		if _, err := NormalizeContinueKind(in); !errors.Is(err, ErrKindUnsupported) {
			t.Errorf("%q: err = %v", in, err)
		}
	}
}

func TestB23_RefinedErrorsKeepTheirCodes(t *testing.T) {
	for err, code := range map[error]string{
		ErrKeepNotAside: CodeKindUnsupported, ErrKeepNeedsAside: CodeInvalidInput, ErrContinueNotAside: CodeKindUnsupported,
		ErrAsideNotEnded: CodeBranchBusy, ErrBranchNotDeletable: CodeBranchNotDeletable, ErrDeleteBranchIsMainLine: CodeInvalidInput,
		ErrBranchSubtreeOpen: CodeBranchBusy,
	} {
		if got := CodeOf(err); got != code {
			t.Errorf("%v: code = %q, want %q", err, got, code)
		}
	}
}
