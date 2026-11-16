package domain

import (
	"errors"
	"fmt"
	"maps"
	"unicode/utf8"
)

// Error is a refusal the caller can act on: a stable code, a message for the
// operator and optional extra fields. The codes use stable canonical strings so
// a ported frontend tells the refusals apart without changes. The HTTP layer
// maps codes to statuses; this package knows nothing about HTTP. The Err*
// sentinels are shared values: never modify their fields, use AsError or
// NewError for a copy.
type Error struct {
	Code    string
	Message string
	Extra   map[string]any
	// cause is the sentinel a refined error stands for, so errors.Is still
	// matches it.
	cause error
}

func (e *Error) Error() string {
	if e == nil {
		return "<nil domain error>"
	}
	return e.Message
}

// Unwrap returns the error a refined or converted error stands for, if any.
func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

// NewError builds an Error.
func NewError(code, message string, extra map[string]any) *Error {
	return &Error{Code: code, Message: message, Extra: extra}
}

// refine returns a copy of a sentinel with a more specific message and extra
// fields; errors.Is(refined, sentinel) stays true.
func refine(sentinel *Error, message string, extra map[string]any) *Error {
	return &Error{Code: sentinel.Code, Message: message, Extra: extra, cause: sentinel}
}

// Error codes. Every public error code keeps its canonical string.
const (
	// Opening branches.
	CodeDepthSoftLimit     = "depth_soft_limit"
	CodeDepthHardLimit     = "depth_hard_limit"
	CodeBranchLimit        = "branch_limit"
	CodeTreeLimit          = "tree_limit"
	CodeParentClosed       = "parent_closed"
	CodeAnchorNotFound     = "anchor_not_found"
	CodeKindUnsupported    = "kind_unsupported"
	CodeSuggestionNotFound = "suggestion_not_found"
	// Turns and the state of a branch.
	CodeBranchClosed   = "branch_closed"
	CodeArchived       = "archived"
	CodeAsideAnswered  = "aside_answered"
	CodeBranchBusy     = "branch_busy"
	CodeBranchDrafting = "branch_drafting"
	// Drafting and merging.
	CodeNoMessages       = "no_messages"
	CodeDraftNotPending  = "draft_not_pending"
	CodeParentBusy       = "parent_busy"
	CodeParentMoved      = "parent_moved"
	CodeInvalidCard      = "invalid_card"
	CodeInvalidParentTip = "invalid_parent_tip"
	// Moving, promoting and deleting.
	CodeInvalidCount          = "invalid_count"
	CodeNotEnoughMessages     = "not_enough_messages"
	CodeMoveMustStartWithUser = "move_must_start_with_user"
	CodeMoveProtected         = "move_protected_message"
	CodeMoveNoAnchor          = "move_no_anchor"
	CodeSourceBusy            = "source_busy"
	CodePromoteNotTopLevel    = "promote_not_top_level"
	CodeOpenBranchesOnOldTail = "open_branches_on_old_tail"
	CodeSessionBusy           = "session_busy"
	CodeNotMainLine           = "branch_not_main_line"
	// CodeBranchNotDeletable (B23): the branch is not one that can be
	// deleted on its own (not all hosts enforce this).
	CodeBranchNotDeletable = "branch_not_deletable"
	// Notes.
	CodeNoteNotFound       = "note_not_found"
	CodeNoteSuperseded     = "note_superseded"
	CodeNoteLimit          = "note_limit"
	CodeInvalidNote        = "invalid_note"
	CodeNoteSourceNotFound = "note_source_not_found"
	// Chapters.
	CodeMilestoneNotFound = "milestone_not_found"
	CodeMilestoneExists   = "milestone_exists"
	CodeMilestoneLimit    = "milestone_limit"
	CodeMessageNotFound   = "message_not_found"
	CodeInvalidMilestone  = "invalid_milestone"
	// Codes tangent adds where legacy handlers answered without a code.
	CodeTurnPending       = "turn_pending"
	CodeTurnNotPending    = "turn_not_pending"
	CodeInvalidTransition = "invalid_transition"
	CodeLineNotFound      = "line_not_found"
	CodeBranchNotFound    = "branch_not_found"
	CodeInvalidInput      = "invalid_input"
	CodeJobNotFound       = "job_not_found"
	CodeJobNotPending     = "job_not_pending"
	CodeConcurrentChange  = "concurrent_change"
	CodeIDUnavailable     = "id_unavailable"
	CodeFeatureDisabled   = "feature_disabled"
	CodeTooLong           = "too_long"
	CodeModelNotAllowed   = "model_not_allowed"
	CodeNothingToRetry    = "nothing_to_retry"
	// P1 (B8): the leaf, the parked seeds and the suggestion inbox.
	CodeInvalidLeaf       = "invalid_leaf"
	CodeLeafNotFound      = "leaf_not_found"
	CodeSeedNotFound      = "seed_not_found"
	CodeSeedNotOpen       = "seed_not_open"
	CodeSeedLimit         = "seed_limit"
	CodeSuggestionNotOpen = "suggestion_not_open"
	// P2 (B9): goals and relations.
	CodeGoalNotFound     = "goal_not_found"
	CodeRelationNotFound = "relation_not_found"
	CodeRelationLimit    = "relation_limit"
	CodeRelationExists   = "relation_exists"
	// P2 (B9 part C): groups.
	CodeGroupNotFound  = "group_not_found"
	CodeGroupNotActive = "group_not_active"
	CodeInvalidGroup   = "invalid_group"
	CodeGroupLimit     = "group_limit"
	// P3 (B10 part A): folds.
	CodeFoldNotFound = "fold_not_found"
	CodeFoldOverlap  = "fold_overlap"
	CodeFoldLimit    = "fold_limit"
	CodeInvalidFold  = "invalid_fold"
	// P3 (B10 part B): comparisons.
	CodeComparisonNotFound = "comparison_not_found"
	CodeComparisonNotReady = "comparison_not_ready"
	CodeComparisonDecided  = "comparison_decided"
	CodeInvalidComparison  = "invalid_comparison"
	// P3 (B10 part C): memories.
	CodeMemoryNotFound   = "memory_not_found"
	CodeMemorySuperseded = "memory_superseded"
	CodeInvalidMemory    = "invalid_memory"
	// B13: memos (not sent to the AI).
	CodeMemoNotFound = "memo_not_found"
	CodeMemoLimit    = "memo_limit"
	// B24: the glossary.
	CodeTermNotFound = "term_not_found"
	CodeTermLimit    = "term_limit"
	CodeTermExists   = "term_exists"
	// B25: import batches.
	CodeImportBatchNotFound = "import_batch_not_found"
	// CodeEmbedderUnavailable: the host's Embedder failed (the cause is
	// only logged); a write or search that needs a vector can be retried.
	CodeEmbedderUnavailable = "embedder_unavailable"
)

// Errors of lines and turns.
var (
	// ErrLineNotFound: no such line for this tenant.
	ErrLineNotFound = NewError(CodeLineNotFound, "conversation not found", nil)
	// ErrLineArchived: archived conversations accept no new branches, messages or notes.
	ErrLineArchived = NewError(CodeArchived, "the conversation is archived", nil)
	// ErrLineBusy: the line is answering, so the operation is skipped.
	ErrLineBusy = NewError(CodeSessionBusy, "the conversation is busy", nil)
	// ErrTurnPending: a turn is already pending on this line.
	ErrTurnPending = NewError(CodeTurnPending, "a turn is already pending for this conversation", nil)
	// ErrTurnNotPending: the turn being completed is no longer pending.
	ErrTurnNotPending = NewError(CodeTurnNotPending, "this turn is no longer pending", nil)
	// ErrStatusTransition: an invalid line status change.
	ErrStatusTransition = NewError(CodeInvalidTransition, "invalid conversation status transition", nil)
	// ErrArchiveNotMainLine: only a whole conversation is archived.
	ErrArchiveNotMainLine = NewError(CodeNotMainLine, "a branch cannot be archived on its own; discard it or archive the main line", nil)
	// ErrConcurrentChange: other writes kept getting in the way; try again.
	ErrConcurrentChange = NewError(CodeConcurrentChange, "the conversation changed while this was being saved; try again", nil)
	// ErrIDUnavailable: a host-chosen id cannot be used (it says nothing about why).
	ErrIDUnavailable = NewError(CodeIDUnavailable, "this id cannot be used", nil)
	// ErrMessageNotFound: no such message on this line (the chapter error, shared).
	ErrMessageNotFound = ErrChapterMessageNotFound
)

// ErrFeatureDisabled: the feature this needs is not enabled for the caller
// (not configured, or switched off by the host's FeaturePolicy).
var ErrFeatureDisabled = NewError(CodeFeatureDisabled, "this feature is not enabled", nil)

// FeatureDisabled is ErrFeatureDisabled naming the feature (extra "feature").
func FeatureDisabled(feature string) *Error {
	return refine(ErrFeatureDisabled, "the "+feature+" feature is not enabled", map[string]any{"feature": feature})
}

// ErrTooLong: a text field is longer than its limit (extra field, max).
var ErrTooLong = NewError(CodeTooLong, "a text is too long", nil)

// CheckRunes refuses text longer than max runes, naming the field.
func CheckRunes(field, text string, max int) error {
	if utf8.RuneCountInString(text) <= max {
		return nil
	}
	return refine(ErrTooLong, fmt.Sprintf("%s is longer than %d characters", field, max), map[string]any{"field": field, "max": max})
}

// ErrModelNotAllowed: the provider or model is not one this host allows.
var ErrModelNotAllowed = NewError(CodeModelNotAllowed, "this provider or model is not allowed", nil)

// ModelNotAllowed is ErrModelNotAllowed naming the provider and model.
func ModelNotAllowed(provider, model string) *Error {
	return refine(ErrModelNotAllowed, "the model "+provider+"/"+model+" is not allowed here", map[string]any{"provider": provider, "model": model})
}

// ErrNothingToRetry: the line's last turn did not fail, so there is nothing to retry.
var ErrNothingToRetry = NewError(CodeNothingToRetry, "the last turn of this conversation did not fail", nil)

// Errors of background jobs.
var (
	// ErrJobNotFound: no such job.
	ErrJobNotFound = NewError(CodeJobNotFound, "job not found", nil)
	// ErrJobNotPending: the job already finished, was superseded or timed out.
	ErrJobNotPending = NewError(CodeJobNotPending, "this job is no longer pending", nil)
)

// errorExtraFor returns the extra fields returned with a code; nil
// for codes without any.
func errorExtraFor(code string, l Limits) map[string]any {
	switch code {
	case CodeDepthHardLimit:
		return map[string]any{"limit": l.Branch.HardMaxDepth}
	case CodeBranchLimit:
		return map[string]any{"limit": l.Branch.MaxOpenPerParent}
	case CodeTreeLimit:
		return map[string]any{"limit": l.Branch.MaxPerTree}
	case CodeInvalidCount:
		return map[string]any{"max": l.Branch.MoveMaxMessages}
	case CodeNoteLimit:
		return map[string]any{"maxActive": l.Notes.MaxActive, "maxTotal": l.Notes.MaxTotal}
	case CodeMilestoneLimit:
		return map[string]any{"maxMilestones": l.Chapters.MilestoneMaxPerTree}
	case CodeInvalidMilestone:
		return map[string]any{"maxLength": l.Chapters.MilestoneTitleMaxRunes}
	case CodeSeedLimit:
		return map[string]any{"limit": l.Parking.MaxOpenPerTree}
	case CodeRelationLimit:
		return map[string]any{"limit": l.Relations.MaxPerTree}
	case CodeGroupLimit:
		return map[string]any{"limit": l.Group.MaxActivePerTree}
	case CodeFoldLimit:
		return map[string]any{"limit": l.Fold.MaxActivePerLine}
	case CodeMemoLimit:
		return map[string]any{"limit": l.Memo.MaxPerTree}
	case CodeTermLimit:
		return map[string]any{"limit": l.Glossary.MaxPerTree}
	}
	return nil
}

// CodeOf returns the code of a domain error anywhere in err's chain, or ""
// when err is not one (an internal failure).
func CodeOf(err error) string {
	if domainErr := AsError(err, DefaultLimits()); domainErr != nil {
		return domainErr.Code
	}
	return ""
}

// AsError turns any domain error in err's chain into a fresh *Error with the
// extra fields (limits, counts, ids), or returns nil when err
// is not a domain error. The message is the domain error's own text, never
// the wrapping context, so nothing internal leaks. Shared sentinels are never
// modified, and the copy unwraps to the error it was made from, so
// errors.Is(AsError(err, l), ErrX) still holds.
func AsError(err error, l Limits) *Error {
	if err == nil {
		return nil
	}
	l = l.WithDefaults()
	var soft *BranchDepthSoftError
	var moved *ParentMovedError
	var openTail *BranchOpenTailError
	var domainErr *Error
	switch {
	case errors.As(err, &soft):
		return &Error{Code: CodeDepthSoftLimit, Message: soft.Error(), Extra: map[string]any{"depth": soft.Depth, "limit": soft.Limit}, cause: soft}
	case errors.As(err, &moved):
		return &Error{Code: CodeParentMoved, Message: moved.Error(), Extra: map[string]any{"movedMessages": moved.MovedMessages, "movedCards": moved.MovedCards}, cause: moved}
	case errors.As(err, &openTail):
		return &Error{Code: CodeOpenBranchesOnOldTail, Message: openTail.Error(), Extra: map[string]any{"lineIds": append([]string{}, openTail.LineIDs...)}, cause: openTail}
	case errors.As(err, &domainErr) && domainErr != nil:
		extra := maps.Clone(domainErr.Extra)
		if extra == nil {
			extra = errorExtraFor(domainErr.Code, l)
		}
		return &Error{Code: domainErr.Code, Message: domainErr.Message, Extra: extra, cause: domainErr}
	}
	return nil
}

// BranchDepthSoftError asks the caller to confirm a deep branch.
type BranchDepthSoftError struct {
	Depth int
	Limit int
}

func (e *BranchDepthSoftError) Error() string {
	return fmt.Sprintf("branch depth %d is beyond %d; confirm to open it", e.Depth, e.Limit)
}

// ParentMovedError refuses a merge because the parent got new messages since
// the operator last looked (the tip they saw is no longer the newest).
type ParentMovedError struct {
	MovedMessages int
	MovedCards    int
}

func (e *ParentMovedError) Error() string {
	return fmt.Sprintf("the conversation moved on since the draft: %d new message(s), %d of them branch card(s)", e.MovedMessages, e.MovedCards)
}

// CardError is the refusal of a conclusion card: the first problem in the
// message and every problem in the extra fields.
func CardError(problems []BranchCardProblem) *Error {
	message := "the conclusion card is not acceptable"
	if len(problems) > 0 {
		message += ": " + problems[0].Field + " " + problems[0].Message
	}
	return NewError(CodeInvalidCard, message, map[string]any{"problems": append([]BranchCardProblem{}, problems...)})
}

// NoteError is the refusal of a note request, shaped like CardError.
func NoteError(problems []NoteProblem) *Error {
	message := "the note is not acceptable"
	if len(problems) > 0 {
		message += ": " + problems[0].Field + " " + problems[0].Message
	}
	return NewError(CodeInvalidNote, message, map[string]any{"problems": append([]NoteProblem{}, problems...)})
}
