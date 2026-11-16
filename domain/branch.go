package domain

import (
	"strings"
	"time"
)

// Conversation branches. A branch is an ordinary line plus one branch record
// that hangs it on a message of its parent. In the product the parent chain
// is "main line" and "side lines".

// Branch kinds (how heavy the side line is).
const (
	BranchKindAside       = "aside"
	BranchKindInvestigate = "investigate"
	BranchKindAlternative = "alternative"
)

// Branch statuses. open → merged | discarded | promoted, one way and final.
const (
	BranchStatusOpen      = "open"
	BranchStatusMerged    = "merged"
	BranchStatusDiscarded = "discarded"
	BranchStatusPromoted  = "promoted"
)

// Branch origins (which entry point opened the branch).
const (
	BranchOriginSelection = "selection"
	BranchOriginButton    = "button"
	// BranchOriginSuggestion: opened from an assistant's suggestion.
	BranchOriginSuggestion = "suggestion"
	// BranchOriginMove marks a branch opened by moving the tail of a line.
	BranchOriginMove = "move"
	// BranchOriginPreviousMainLine marks the ended branch that holds the old
	// main line's tail after a promotion.
	BranchOriginPreviousMainLine = "previous_main_line"
	// BranchOriginMerge marks a branch that combines several (group).
	BranchOriginMerge = "merge"
	// BranchOriginDiverge marks one of the sibling directions a diverge
	// opened (diverge).
	BranchOriginDiverge = "diverge"
	// BranchOriginImport marks a branch an import wrote (B18).
	BranchOriginImport = "import"
)

// Errors of opening a branch and of taking a turn in one.
var (
	// ErrBranchClosed: the branch (or an ancestor) is no longer open.
	ErrBranchClosed = NewError(CodeBranchClosed, "this branch is closed", nil)
	// ErrBranchParentClosed: a branch cannot be opened under a closed branch.
	ErrBranchParentClosed = NewError(CodeParentClosed, "the parent branch is closed", nil)
	// ErrBranchDepthHard: the deepest allowed branch already exists on this path.
	ErrBranchDepthHard = NewError(CodeDepthHardLimit, "branches cannot be nested any deeper", nil)
	// ErrBranchLimit: too many unfinished branches under one line.
	ErrBranchLimit = NewError(CodeBranchLimit, "too many open branches under this message's conversation", nil)
	// ErrBranchTreeLimit: too many branches in the whole conversation.
	ErrBranchTreeLimit = NewError(CodeTreeLimit, "too many branches in this conversation", nil)
	// ErrBranchAnchorNotFound: the anchor is not a finished operator or assistant message of the parent.
	ErrBranchAnchorNotFound = NewError(CodeAnchorNotFound, "anchor message not found in this conversation", nil)
	// ErrBranchNotFound: the line is not a branch.
	ErrBranchNotFound = NewError(CodeBranchNotFound, "this conversation is not a branch", nil)
	// ErrKindUnsupported: the branch kind is unknown or not allowed here.
	ErrKindUnsupported = NewError(CodeKindUnsupported, "kind must be aside, investigate or alternative", nil)
	// ErrSuggestionNotFound: the message carries no such suggestion.
	ErrSuggestionNotFound = NewError(CodeSuggestionNotFound, "no such suggestion on that message", nil)
	// ErrAsideAnswered: an aside takes one question and one answer.
	ErrAsideAnswered = NewError(CodeAsideAnswered, "this aside has been answered; open a new one or a branch", nil)
	// ErrInvalidPurpose: the purpose is empty or too long.
	ErrInvalidPurpose = NewError(CodeInvalidInput, "purpose is required and must not be too long", nil)
	// ErrInvalidExcerpt: the selected text is too long.
	ErrInvalidExcerpt = NewError(CodeInvalidInput, "the selected excerpt is too long", nil)
)

// BranchRef is LineView.ConversationBranch: what a branch line says about itself.
type BranchRef struct {
	ParentLineID    string `json:"parentLineId"`
	RootLineID      string `json:"rootLineId"`
	AnchorMessageID string `json:"anchorMessageId"`
	Depth           int    `json:"depth"`
	Purpose         string `json:"purpose"`
	Kind            string `json:"kind"`
	Status          string `json:"status"`
	Origin          string `json:"origin"`
}

// IsOpenForTurns reports whether a branch still accepts messages.
func (r BranchRef) IsOpenForTurns() bool { return r.Status == BranchStatusOpen }

// BranchCounts is LineView.BranchCounts: the direct branches under a line.
type BranchCounts struct {
	Open      int `json:"open"`
	Merged    int `json:"merged"`
	Discarded int `json:"discarded"`
	Promoted  int `json:"promoted"`
}

// Add counts n branches of the given status and returns the new counts.
func (c BranchCounts) Add(status string, n int) BranchCounts {
	switch status {
	case BranchStatusOpen:
		c.Open += n
	case BranchStatusMerged:
		c.Merged += n
	case BranchStatusDiscarded:
		c.Discarded += n
	case BranchStatusPromoted:
		c.Promoted += n
	}
	return c
}

// Total is the number of branches counted.
func (c BranchCounts) Total() int { return c.Open + c.Merged + c.Discarded + c.Promoted }

// BranchView is one row of the outline (GET /branches) and the branch header.
type BranchView struct {
	LineID          string `json:"lineId"`
	ParentLineID    string `json:"parentLineId"`
	RootLineID      string `json:"rootLineId"`
	AnchorMessageID string `json:"anchorMessageId"`
	Depth           int    `json:"depth"`
	Purpose         string `json:"purpose"`
	Kind            string `json:"kind"`
	Status          string `json:"status"`
	Origin          string `json:"origin"`
	Excerpt         string `json:"excerpt"`
	ConclusionLine  string `json:"conclusionLine"`
	CardMessageID   string `json:"cardMessageId"`
	Provider        string `json:"provider"`
	Model           string `json:"model"`
	// LineStatus is the branch line's own status (idle, thinking, error).
	LineStatus     string     `json:"lineStatus"`
	Unread         int        `json:"unread"`
	MessageCount   int        `json:"messageCount"`
	DraftStatus    string     `json:"draftStatus"`
	Archived       bool       `json:"archived"`
	CreatedAt      time.Time  `json:"createdAt"`
	ClosedAt       *time.Time `json:"closedAt"`
	LastActivityAt time.Time  `json:"lastActivityAt"`
	// MergedIntoLineID is the branch a combine discarded this one into
	// ("" otherwise; the group feature).
	MergedIntoLineID string `json:"mergedIntoLineId"`
	// Leaf is the branch's closing note (the leaf feature), nil when it has
	// none. Stored leaves show even while the feature is off; clients follow
	// /capabilities.
	Leaf *LeafSummary `json:"leaf"`
	// AnchorTag is the argument tag of the message the branch hangs on (the
	// ibis feature); absent without one.
	AnchorTag *MessageTag `json:"anchorTag,omitempty"`
	// CardEditedAt is when a merged branch's conclusion card was last edited
	// (B17.1); nil when the branch has no card or its card was never edited.
	CardEditedAt *time.Time `json:"cardEditedAt,omitempty"`
	// KeptAt is when an aside was kept from the purge (B23); nil for an
	// aside that is not kept and for every other branch.
	KeptAt *time.Time `json:"keptAt,omitempty"`
}

// BranchDetail is GET /branch: the header, the stored pack and its exact
// text, the draft state and the newest message of the parent (the tip a
// merge must name).
type BranchDetail struct {
	Branch             BranchView  `json:"branch"`
	Pack               BranchPack  `json:"pack"`
	Draft              BranchDraft `json:"draft"`
	ParentTipMessageID string      `json:"parentTipMessageId"`
}

// ValidBranchKind reports whether kind is one of the branch kinds.
func ValidBranchKind(kind string) bool {
	return kind == BranchKindAside || kind == BranchKindInvestigate || kind == BranchKindAlternative
}

// ValidBranchOrigin reports whether origin is one of the branch origins.
func ValidBranchOrigin(origin string) bool {
	switch origin {
	case BranchOriginSelection, BranchOriginButton, BranchOriginSuggestion, BranchOriginMove, BranchOriginPreviousMainLine, BranchOriginSeed, BranchOriginMerge, BranchOriginDiverge, BranchOriginImport:
		return true
	}
	return false
}

// NormalizeBranchPurpose trims the purpose and reports whether it is valid:
// non-empty and within the purpose limit.
func NormalizeBranchPurpose(purpose string, l BranchLimits) (string, bool) {
	l = l.orDefault()
	trimmed := strings.TrimSpace(purpose)
	runes := []rune(trimmed)
	return trimmed, len(runes) > 0 && len(runes) <= l.PurposeMaxRunes
}

// NormalizeBranchExcerpt trims the selected text and reports whether it is
// within the excerpt limit. It is not required to be a substring of the
// anchor message: the browser shows rendered Markdown, so the selection need
// not match the stored text byte for byte.
func NormalizeBranchExcerpt(excerpt string, l BranchLimits) (string, bool) {
	l = l.orDefault()
	trimmed := strings.TrimSpace(excerpt)
	return trimmed, len([]rune(trimmed)) <= l.ExcerptMaxRunes
}

// BranchCreateCheck is what the store knows, under its locks, when a branch
// is about to be opened.
type BranchCreateCheck struct {
	// ParentArchived: the parent line (or its tree) is archived.
	ParentArchived bool
	// ParentIsBranch, ParentStatus and ParentDepth describe the parent when it
	// is itself a branch.
	ParentIsBranch bool
	ParentStatus   string
	ParentDepth    int
	// OpenUnderParent counts the open branches already under the parent;
	// TreeTotal counts every branch of the tree.
	OpenUnderParent int
	TreeTotal       int
	// ConfirmDeeper accepts a depth beyond the soft limit.
	ConfirmDeeper bool
}

// CheckBranchCreate applies the state, depth and count rules and returns the
// new branch's depth. The hard limits are checked before the soft one so the
// operator is never asked to confirm something that would then be refused.
func CheckBranchCreate(in BranchCreateCheck, l BranchLimits) (int, error) {
	l = l.orDefault()
	if in.ParentArchived {
		return 0, ErrLineArchived
	}
	depth := 1
	if in.ParentIsBranch {
		if in.ParentStatus != BranchStatusOpen {
			return 0, ErrBranchParentClosed
		}
		depth = in.ParentDepth + 1
	}
	switch {
	case depth > l.HardMaxDepth:
		return 0, ErrBranchDepthHard
	case in.OpenUnderParent >= l.MaxOpenPerParent:
		return 0, ErrBranchLimit
	case in.TreeTotal >= l.MaxPerTree:
		return 0, ErrBranchTreeLimit
	case depth > l.SoftMaxDepth && !in.ConfirmDeeper:
		return 0, &BranchDepthSoftError{Depth: depth, Limit: l.SoftMaxDepth}
	}
	return depth, nil
}

// BranchRenamable reports whether a branch's purpose may change (B13): open
// and ended branches, but not a promoted one (its messages went to the main
// line) nor the previous main line (always shown under a fixed name).
func BranchRenamable(status, origin string) bool {
	if origin == BranchOriginPreviousMainLine {
		return false
	}
	return status == BranchStatusOpen || status == BranchStatusMerged || status == BranchStatusDiscarded
}
