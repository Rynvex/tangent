package domain

import "strings"

// Attaching a conversation (B20): a main line of the tenant, with its whole
// tree, becomes a branch of a line of another conversation. It is the
// inverse of a detach: the attached line keeps its messages and their seq,
// its branches go one level deeper per the new branch's depth, and what
// belongs to its tree (notes, memos, seeds, leaves, chapter cuts,
// suggestions, groups) moves to the target's main line.

// Statuses an attached branch can start in.
const (
	AttachStatusOpen   = BranchStatusOpen
	AttachStatusMerged = BranchStatusMerged
)

// ErrAttachSelf refuses attaching a conversation to itself or into its own
// tree.
var ErrAttachSelf = NewError(CodeInvalidInput, "a conversation cannot be attached to itself", map[string]any{"field": "sourceLineId"})

// ErrAttachNotMainLine refuses a source that is already a branch.
var ErrAttachNotMainLine = NewError(CodeInvalidInput, "sourceLineId must be a main line (a conversation of its own)", map[string]any{"field": "sourceLineId"})

// ErrAttachEmpty refuses a source with no finished operator or assistant
// message.
var ErrAttachEmpty = NewError(CodeInvalidInput, "the conversation to attach has no finished messages", map[string]any{"field": "sourceLineId"})

// AttachCheck is what the limits of an attach are checked against, read
// under the locks.
type AttachCheck struct {
	// Parent describes the target line as BranchCreateCheck does.
	Parent BranchCreateCheck
	// Status is the status the attached branch starts in (open or merged).
	Status string
	// SubtreeLines counts the branches of the source's tree (they come along).
	SubtreeLines int
	// SubtreeDepth is the deepest of them in the source's tree (0 without).
	SubtreeDepth int
}

// CheckAttach applies the branch limits to an attach and returns the
// depth of the attached branch. The open count only matters for an open
// branch; the tree count and the depths include the source's tree.
// Refusals, in CheckBranchCreate's order: archived, parent closed, the hard
// depth, the open branches of the parent, the tree size, the soft depth.
func CheckAttach(in AttachCheck, l BranchLimits) (int, error) {
	l = l.orDefault()
	p := in.Parent
	if p.ParentArchived {
		return 0, ErrLineArchived
	}
	depth := 1
	if p.ParentIsBranch {
		if p.ParentStatus != BranchStatusOpen {
			return 0, ErrBranchParentClosed
		}
		depth = p.ParentDepth + 1
	}
	deepest := depth + max(in.SubtreeDepth, 0)
	switch {
	case deepest > l.HardMaxDepth:
		return 0, ErrBranchDepthHard
	case in.Status == AttachStatusOpen && p.OpenUnderParent >= l.MaxOpenPerParent:
		return 0, ErrBranchLimit
	case p.TreeTotal+1+in.SubtreeLines > l.MaxPerTree:
		return 0, ErrBranchTreeLimit
	case deepest > l.SoftMaxDepth && !p.ConfirmDeeper:
		return 0, &BranchDepthSoftError{Depth: deepest, Limit: l.SoftMaxDepth}
	}
	return depth, nil
}

// NormalizeAttachStatus is the status an attach asks for: open by default,
// or merged; anything else is invalid_input naming the field.
func NormalizeAttachStatus(status string) (string, error) {
	switch strings.TrimSpace(status) {
	case "", AttachStatusOpen:
		return AttachStatusOpen, nil
	case AttachStatusMerged:
		return AttachStatusMerged, nil
	}
	return "", NewError(CodeInvalidInput, "status must be open or merged", map[string]any{"field": "status"})
}

// NormalizeAttachKind is the kind of the attached branch: investigate by
// default, or alternative (an aside is a quick question, not a whole
// conversation).
func NormalizeAttachKind(kind string) (string, error) {
	switch strings.TrimSpace(kind) {
	case "", BranchKindInvestigate:
		return BranchKindInvestigate, nil
	case BranchKindAlternative:
		return BranchKindAlternative, nil
	}
	return "", ErrKindUnsupported
}

// AttachPurpose is the purpose of the attached branch: the one given, else
// the source's title cut to the purpose limit, else its first operator
// message (the first finished message when there is none) on one line,
// cut to ImportTitleRunes. ok is false when the given purpose is too long
// or nothing gives one.
func AttachPurpose(given, title, firstUser, firstAny string, l BranchLimits) (string, bool) {
	l = l.orDefault()
	if strings.TrimSpace(given) != "" {
		return NormalizeBranchPurpose(given, l)
	}
	if title = FlattenUntrusted(title); title != "" {
		return NormalizeBranchPurpose(CutRunes(title, l.PurposeMaxRunes), l)
	}
	opening := firstUser
	if strings.TrimSpace(opening) == "" {
		opening = firstAny
	}
	return NormalizeBranchPurpose(CutRunes(FlattenUntrusted(opening), ImportTitleRunes), l)
}

// PlanAttachCard checks the card of an attach before anything is read: a
// merged attach carries one (invalid_input, field card), an open one must
// not; an empty question is the purpose. Only the shape is checked here
// (invalid_card); the messages it cites are checked under the locks.
func PlanAttachCard(card *BranchCard, status, purpose string) (*BranchCard, error) {
	if status != AttachStatusMerged {
		if card != nil {
			return nil, NewError(CodeInvalidInput, "card: only a merged attach carries a card", map[string]any{"field": "card"})
		}
		return nil, nil
	}
	if card == nil {
		return nil, NewError(CodeInvalidInput, "card: a merged attach carries its card", map[string]any{"field": "card"})
	}
	filled := *card
	if strings.TrimSpace(filled.Question) == "" {
		filled.Question = purpose
	}
	if problems := CheckBranchCardShape(filled); len(problems) > 0 {
		return nil, CardError(problems)
	}
	return &filled, nil
}
