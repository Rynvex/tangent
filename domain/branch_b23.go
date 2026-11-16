package domain

import "strings"

// B23: keeping an aside, continuing one as a branch, deleting an ended
// branch.

// Errors of keeping, continuing and deleting a branch.
var (
	// ErrKeepNotAside: only an aside is purged, so only an aside is kept.
	ErrKeepNotAside = refine(ErrKindUnsupported, "only an aside can be kept", nil)
	// ErrKeepNeedsAside: keep on a new branch that is not an aside.
	ErrKeepNeedsAside = NewError(CodeInvalidInput, "keep belongs to an aside", map[string]any{"field": "keep"})
	// ErrContinueNotAside: only an aside is continued as a branch.
	ErrContinueNotAside = refine(ErrKindUnsupported, "only an aside can be continued as a branch", nil)
	// ErrContinueKind: an aside continues as an investigate or an
	// alternative branch.
	ErrContinueKind = refine(ErrKindUnsupported, "kind must be investigate or alternative", nil)
	// ErrAsideNotEnded: the aside has no answer yet (or is answering).
	ErrAsideNotEnded = refine(ErrBranchBusy, "this aside has not been answered yet; wait for its answer", nil)
	// ErrAsideUnanswered: the aside ended without an answer, so there is
	// no exchange to continue from.
	ErrAsideUnanswered = refine(ErrBranchNoMessages, "this aside has no answer to continue from", nil)
	// ErrBranchNotDeletable: only an ended aside or a discarded branch is
	// deleted on its own.
	ErrBranchNotDeletable = NewError(CodeBranchNotDeletable, "only an ended aside or a discarded branch can be deleted", nil)
	// ErrDeleteBranchIsMainLine: a main line goes with its whole tree.
	ErrDeleteBranchIsMainLine = NewError(CodeInvalidInput, "this is a main line; delete the whole conversation instead", nil)
	// ErrBranchSubtreeOpen: a branch below the one being deleted is open.
	ErrBranchSubtreeOpen = refine(ErrBranchBusy, "a branch below this one is still open; end it first", nil)
)

// BranchDeletable reports whether a branch may be deleted on its own (B23):
// an aside that ended, or a discarded branch that is neither the previous
// main line (it holds the old tail of a promotion) nor discarded into
// another branch by a combine (mergedInto names that branch).
func BranchDeletable(kind, status, origin, mergedInto string) bool {
	if kind == BranchKindAside {
		return status != BranchStatusOpen
	}
	return status == BranchStatusDiscarded && origin != BranchOriginPreviousMainLine && mergedInto == ""
}

// NormalizeContinueKind is the kind an aside continues as: investigate by
// default, or alternative.
func NormalizeContinueKind(kind string) (string, error) {
	switch strings.TrimSpace(kind) {
	case "", BranchKindInvestigate:
		return BranchKindInvestigate, nil
	case BranchKindAlternative:
		return BranchKindAlternative, nil
	}
	return "", ErrContinueKind
}

// GroupMinMembers is the fewest branches a group has; a group left with
// fewer (a member was deleted) is dissolved.
const GroupMinMembers = 2
