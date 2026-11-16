package domain

import "fmt"

// After-the-fact move and promotion of branches, and deleting a tree.

// BranchPreviousMainLinePurpose is the title of the branch that holds the old
// main line's tail after a promotion; clients should label it from the
// origin, not from this text.
const BranchPreviousMainLinePurpose = "Previous main line"

// Errors of moving, promoting and deleting.
var (
	// ErrBranchMoveCount: the number of messages to move is out of range.
	ErrBranchMoveCount = NewError(CodeInvalidCount, "count is out of range", nil)
	// ErrBranchMoveTooFew: the line has fewer messages than asked for.
	ErrBranchMoveTooFew = NewError(CodeNotEnoughMessages, "the conversation has fewer messages than that", nil)
	// ErrBranchMoveNotUserStart: the first message to move is not the operator's.
	ErrBranchMoveNotUserStart = NewError(CodeMoveMustStartWithUser, "the first message to move must be one of yours", nil)
	// ErrBranchMoveProtected: a conclusion card or a move marker is in the range.
	ErrBranchMoveProtected = NewError(CodeMoveProtected, "a conclusion card or a move marker is in that range and cannot be moved", nil)
	// ErrBranchMoveNoAnchor: nothing would be left to hang the branch on.
	ErrBranchMoveNoAnchor = NewError(CodeMoveNoAnchor, "moving that many messages would leave nothing to branch from", nil)
	// ErrBranchSourceBusy: the line is answering or has a turn waiting.
	ErrBranchSourceBusy = NewError(CodeSourceBusy, "the conversation is answering; wait for it or cancel the turn", nil)
	// ErrBranchPromoteNotTopLevel: only a branch opened on the main line can be promoted.
	ErrBranchPromoteNotTopLevel = NewError(CodePromoteNotTopLevel, "only a branch opened directly on the main conversation can become the main conversation", nil)
	// ErrBranchPromoteDrafting: a conclusion card is being drafted for the branch.
	ErrBranchPromoteDrafting = NewError(CodeBranchDrafting, "a conclusion card is being drafted for this branch; wait for it", nil)
	// ErrDeleteBusy: a conversation of the tree is answering.
	ErrDeleteBusy = NewError(CodeSessionBusy, "a conversation in this tree is answering; cancel it first", nil)
	// ErrDeleteNotMainLine: only a whole conversation can be deleted.
	ErrDeleteNotMainLine = NewError(CodeNotMainLine, "a branch cannot be deleted on its own; delete the main conversation", nil)
)

// BranchOpenTailError names the unfinished branches that hang on the part of
// the main line a promotion would put away.
type BranchOpenTailError struct {
	LineIDs []string
}

func (e *BranchOpenTailError) Error() string {
	return fmt.Sprintf("%d unfinished branch(es) hang on the part of the main conversation that would be put away; bring back or discard them first", len(e.LineIDs))
}

// CheckMoveCount refuses a move of fewer than one or more than the move
// limit of messages, naming the range for compatibility.
func CheckMoveCount(count int, l BranchLimits) error {
	l = l.orDefault()
	if count >= 1 && count <= l.MoveMaxMessages {
		return nil
	}
	return refine(ErrBranchMoveCount, fmt.Sprintf("count must be between 1 and %d", l.MoveMaxMessages), map[string]any{"max": l.MoveMaxMessages})
}

// BranchMoveMarkerText is the system message left where moved messages were.
func BranchMoveMarkerText(count int, purpose string) string {
	return fmt.Sprintf("%d message(s) moved to a branch: %s", count, branchLine(purpose))
}

// ExtractableMessage reports whether a message may be moved by an extract
// (B18): only finished operator and assistant chat messages. Pending and
// failed replies, conclusion cards, move markers and host system messages
// stay where they are (move_protected_message).
func ExtractableMessage(role, kind, status string) bool {
	return status == MessageDone && kind == MessageKindChat && (role == RoleUser || role == RoleAssistant)
}
