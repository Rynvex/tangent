package domain

// Editing the conclusion card of a merged branch, and following one up with
// a new branch (B17).

// Errors of editing a merged branch's conclusion card.
var (
	// ErrCardNotEditable: the branch was not merged, so it has no card.
	ErrCardNotEditable = NewError(CodeBranchClosed, "only a merged branch has a conclusion card to edit", nil)
	// ErrCardHolderBusy: the line holding the card is answering; its turn
	// may already carry the card as it was.
	ErrCardHolderBusy = NewError(CodeParentBusy, "the conversation the card was brought back to is answering; edit the card when it has finished", nil)
	// ErrCardHolderClosed: the line holding the card takes no more turns.
	ErrCardHolderClosed = NewError(CodeParentClosed, "the conversation the card was brought back to has ended", nil)
)

// CanAnchorBranch reports whether a message of the parent may anchor a new
// branch: a finished operator or assistant message, or a conclusion card
// (a follow-up on what a branch brought back).
func CanAnchorBranch(role, kind, status string) bool {
	if status != MessageDone {
		return false
	}
	return role == RoleUser || role == RoleAssistant || kind == MessageKindBranchCard
}

// packAnchorCard is the anchor of a pack when it names a finished
// conclusion card among the messages and the input allows one.
func (in BranchPackInput) packAnchorCard() (Message, bool) {
	if !in.CardAnchor || in.AnchorMessageID == "" {
		return Message{}, false
	}
	for _, message := range in.Messages {
		if message.ID == in.AnchorMessageID && message.IsCard() && message.Status == MessageDone {
			return message, true
		}
	}
	return Message{}, false
}
