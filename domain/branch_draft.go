package domain

import "time"

// Drafting a conclusion card: the draft states, the state the operator reads
// back and what a finished run is stored as. Which runner drafts is the
// host's choice; the library only builds the prompt and judges the output.

// Draft states of a branch: none → drafting → ready | failed.
const (
	BranchDraftNone     = "none"
	BranchDraftDrafting = "drafting"
	BranchDraftReady    = "ready"
	BranchDraftFailed   = "failed"
)

// Fixed reasons stored with a failed draft. The model's raw output is never
// stored.
const (
	// DraftRunFailedText: the runner reported an error.
	DraftRunFailedText = "the drafting run failed"
	// DraftUnusableText: the output could not be parsed or nothing usable was left.
	DraftUnusableText = "the drafting run did not return a usable card"
	// DraftTimeoutText: the draft stayed "drafting" past its timeout.
	DraftTimeoutText = "the draft took too long"
)

// branchDraftMessageTokenCap bounds one message in the draft prompt.
const branchDraftMessageTokenCap = 3000

// Shape of the draft prompt's context around the branch conversation.
const (
	// branchDraftParentSinceVerbatim is how many of the newest main-line
	// messages after the fork are quoted whole; older ones get one line each.
	branchDraftParentSinceVerbatim = 5
	// branchDraftBackgroundTokens bounds the pack excerpt a draft carries
	// when the branch is too short to explain itself (see
	// branchDraftBackgroundMaxMessages) and no text was selected.
	branchDraftBackgroundTokens = 1200
	// branchDraftBackgroundMaxMessages: a branch with at most this many
	// finished messages gets the pack excerpt.
	branchDraftBackgroundMaxMessages = 2
	// branchDraftAnchorRunes caps the one-line digest of the anchor message.
	branchDraftAnchorRunes = 300
	// branchDraftDigestRunes caps each one-line main-line digest.
	branchDraftDigestRunes = 160
)

// draftNotesTokenBudget bounds the notes listed in the draft prompt.
const draftNotesTokenBudget = 2000

// Errors of the drafting and ending operations.
var (
	// ErrBranchDrafting: a draft is running; the branch cannot take a turn meanwhile.
	ErrBranchDrafting = NewError(CodeBranchDrafting, "a conclusion card is being drafted for this branch; wait for it or write the card by hand", nil)
	// ErrBranchNoMessages: there is nothing in the branch to draft from.
	ErrBranchNoMessages = NewError(CodeNoMessages, "this branch has no finished messages to draft a conclusion from", nil)
	// ErrBranchBusy: the branch has a turn in flight.
	ErrBranchBusy = NewError(CodeBranchBusy, "the branch is still answering; wait for it or cancel the turn", nil)
	// ErrBranchParentTipUnknown: the main-line message the operator says they saw last is not one of its messages.
	ErrBranchParentTipUnknown = NewError(CodeInvalidParentTip, "parentTipMessageId is not a message of the conversation this branch grew from", nil)
	// ErrBranchParentBusy: the parent is answering, so a card cannot be placed after its reply yet.
	ErrBranchParentBusy = NewError(CodeParentBusy, "the conversation this branch grew from is answering; bring the conclusion back when it has finished", nil)
	// ErrDraftNotPending: no draft is waiting for this result (wrong job, timed out or closed).
	ErrDraftNotPending = NewError(CodeDraftNotPending, "no draft is waiting for this result", nil)
)

// EffectiveBranchDraftStatus turns a draft that has been running longer than
// timeout into "failed", lazily, so no reaper is needed.
func EffectiveBranchDraftStatus(status string, startedAt *time.Time, now time.Time, timeout time.Duration) string {
	if status == BranchDraftDrafting && (startedAt == nil || now.Sub(*startedAt) > timeout) {
		return BranchDraftFailed
	}
	return status
}

// BranchDraft is the draft as GET /branch shows it.
type BranchDraft struct {
	Status string `json:"status"`
	// Card is the neutralised draft, nil unless Status is "ready".
	Card *BranchCard `json:"card"`
	// Warnings lists what was repaired or dropped while accepting the draft.
	Warnings []string `json:"warnings"`
	// Error says why the draft failed (never the model's raw output).
	Error     string     `json:"error"`
	Provider  string     `json:"provider"`
	Model     string     `json:"model"`
	StartedAt *time.Time `json:"startedAt"`
	// UptoSeq is the seq of the newest branch message the draft read; 0 when
	// no draft ran.
	UptoSeq             int64  `json:"uptoSeq"`
	ParentTipMessageID  string `json:"parentTipMessageId"`
	ManualCardAvailable bool   `json:"manualCardAvailable"`
	// NoteChanges are the changes of the notes the draft proposes, in the
	// shape of a merge request's noteChanges; empty when the notes feature
	// was off or nothing was proposed (and unless Status is "ready").
	NoteChanges []NoteChange `json:"noteChanges"`
}

// BranchDraftOutcome is what a finished draft run is stored as (the draft
// JSON of the branch record).
type BranchDraftOutcome struct {
	Status   string      `json:"-"`
	Card     *BranchCard `json:"card"`
	Warnings []string    `json:"warnings"`
	Error    string      `json:"error"`
	Provider string      `json:"provider"`
	Model    string      `json:"model"`
	// NoteChanges are the sanitised note proposals (SanitizeDraftNoteChanges).
	NoteChanges []NoteChange `json:"noteChanges,omitempty"`
}

// DraftFailed is the outcome of a run that produced no card.
func DraftFailed(reason string) BranchDraftOutcome {
	return BranchDraftOutcome{Status: BranchDraftFailed, Warnings: []string{}, Error: reason}
}

// DraftOutcome judges a parsed draft against the messages it may cite: a
// sanitised card when something usable is left, a failure otherwise.
func DraftOutcome(draft BranchCard, refs BranchCardRefs) BranchDraftOutcome {
	card, warnings, usable := SanitizeBranchDraft(draft, refs)
	if !usable {
		return DraftFailed(DraftUnusableText)
	}
	if warnings == nil {
		warnings = []string{}
	}
	return BranchDraftOutcome{Status: BranchDraftReady, Card: &card, Warnings: warnings}
}

// CappedReferencedIDs is ReferencedIDs bounded by BranchCardMaxReferences,
// branch-side ids first: the most lookups one card can cause.
func (c BranchCard) CappedReferencedIDs() (branchSide, parentSide []string) {
	branchSide, parentSide = c.ReferencedIDs()
	if len(branchSide) > BranchCardMaxReferences {
		branchSide = branchSide[:BranchCardMaxReferences]
	}
	if room := BranchCardMaxReferences - len(branchSide); len(parentSide) > room {
		parentSide = parentSide[:room]
	}
	return branchSide, parentSide
}
