package domain

import (
	"errors"
	"fmt"
	"testing"
)

func TestCodeOf_KeepsCanonicalCodes(t *testing.T) {
	cases := map[error]string{
		ErrBranchClosed:                "branch_closed",
		ErrBranchParentClosed:          "parent_closed",
		ErrBranchDepthHard:             "depth_hard_limit",
		ErrBranchLimit:                 "branch_limit",
		ErrBranchTreeLimit:             "tree_limit",
		ErrBranchAnchorNotFound:        "anchor_not_found",
		ErrLineArchived:                "archived",
		ErrAsideAnswered:               "aside_answered",
		ErrBranchDrafting:              "branch_drafting",
		ErrBranchNoMessages:            "no_messages",
		ErrBranchBusy:                  "branch_busy",
		ErrBranchParentTipUnknown:      "invalid_parent_tip",
		ErrBranchParentBusy:            "parent_busy",
		ErrDraftNotPending:             "draft_not_pending",
		ErrBranchMoveCount:             "invalid_count",
		ErrBranchMoveTooFew:            "not_enough_messages",
		ErrBranchMoveNotUserStart:      "move_must_start_with_user",
		ErrBranchMoveProtected:         "move_protected_message",
		ErrBranchMoveNoAnchor:          "move_no_anchor",
		ErrBranchSourceBusy:            "source_busy",
		ErrBranchPromoteNotTopLevel:    "promote_not_top_level",
		ErrBranchPromoteDrafting:       "branch_drafting",
		ErrDeleteBusy:                  "session_busy",
		ErrDeleteNotMainLine:           "branch_not_main_line",
		ErrKindUnsupported:             "kind_unsupported",
		ErrSuggestionNotFound:          "suggestion_not_found",
		ErrNoteNotFound:                "note_not_found",
		ErrNoteSuperseded:              "note_superseded",
		ErrNoteLimit:                   "note_limit",
		ErrNoteSourceNotFound:          "note_source_not_found",
		ErrChapterMilestoneNotFound:    "milestone_not_found",
		ErrChapterMilestoneExists:      "milestone_exists",
		ErrChapterMilestoneLimit:       "milestone_limit",
		ErrChapterMessageNotFound:      "message_not_found",
		ErrChapterTitleInvalid:         "invalid_milestone",
		ErrTurnPending:                 "turn_pending",
		ErrTurnNotPending:              "turn_not_pending",
		ErrLineNotFound:                "line_not_found",
		ErrBranchNotFound:              "branch_not_found",
		ErrLineBusy:                    "session_busy",
		ErrArchiveNotMainLine:          "branch_not_main_line",
		ErrMessageNotFound:             "message_not_found",
		ErrJobNotFound:                 "job_not_found",
		ErrJobNotPending:               "job_not_pending",
		ErrConcurrentChange:            "concurrent_change",
		ErrIDUnavailable:               "id_unavailable",
		&BranchDepthSoftError{3, 4}:    "depth_soft_limit",
		&ParentMovedError{1, 0}:        "parent_moved",
		&BranchOpenTailError{nil}:      "open_branches_on_old_tail",
		errors.New("database is down"): "",
	}
	for err, want := range cases {
		if got := CodeOf(err); got != want {
			t.Errorf("CodeOf(%v) = %q, want %q", err, got, want)
		}
		if got := CodeOf(fmt.Errorf("wrapped: %w", err)); got != want {
			t.Errorf("CodeOf(wrapped %v) = %q, want %q", err, got, want)
		}
	}
	if CodeOf(nil) != "" {
		t.Fatal("nil has no code")
	}
}

func TestError_WorksWithErrorsAsAndIs(t *testing.T) {
	wrapped := fmt.Errorf("merge: %w", ErrBranchParentBusy)
	var domainErr *Error
	if !errors.As(wrapped, &domainErr) || domainErr.Code != CodeParentBusy {
		t.Fatalf("errors.As = %+v", domainErr)
	}
	if !errors.Is(wrapped, ErrBranchParentBusy) || errors.Is(wrapped, ErrBranchBusy) {
		t.Fatal("errors.Is must match the sentinel only")
	}
	custom := NewError(CodeInvalidInput, "purpose is required", map[string]any{"field": "purpose"})
	if custom.Error() != "purpose is required" || CodeOf(custom) != CodeInvalidInput {
		t.Fatalf("custom = %+v", custom)
	}
}

func TestAsError_AddsTheExpectedExtras(t *testing.T) {
	l := DefaultLimits()
	cases := []struct {
		err   error
		code  string
		extra map[string]any
	}{
		{&BranchDepthSoftError{Depth: 4, Limit: 3}, CodeDepthSoftLimit, map[string]any{"depth": 4, "limit": 3}},
		{ErrBranchDepthHard, CodeDepthHardLimit, map[string]any{"limit": 6}},
		{ErrBranchLimit, CodeBranchLimit, map[string]any{"limit": 8}},
		{ErrBranchTreeLimit, CodeTreeLimit, map[string]any{"limit": 200}},
		{ErrBranchMoveCount, CodeInvalidCount, map[string]any{"max": 40}},
		{ErrNoteLimit, CodeNoteLimit, map[string]any{"maxActive": 200, "maxTotal": 1000}},
		{ErrChapterMilestoneLimit, CodeMilestoneLimit, map[string]any{"maxMilestones": 200}},
		{ErrChapterTitleInvalid, CodeInvalidMilestone, map[string]any{"maxLength": 80}},
		{&ParentMovedError{MovedMessages: 2, MovedCards: 1}, CodeParentMoved, map[string]any{"movedMessages": 2, "movedCards": 1}},
		{&BranchOpenTailError{LineIDs: []string{"b1"}}, CodeOpenBranchesOnOldTail, map[string]any{"lineIds": []string{"b1"}}},
	}
	for _, tc := range cases {
		got := AsError(fmt.Errorf("context: %w", tc.err), l)
		if got == nil || got.Code != tc.code {
			t.Fatalf("%v: got %+v", tc.err, got)
		}
		if fmt.Sprint(got.Extra) != fmt.Sprint(tc.extra) {
			t.Errorf("%s extra = %v, want %v", tc.code, got.Extra, tc.extra)
		}
		if got.Message != tc.err.Error() {
			t.Errorf("%s message = %q, want the domain text %q", tc.code, got.Message, tc.err.Error())
		}
	}
	if AsError(errors.New("boom"), l) != nil {
		t.Fatal("a non-domain error must not be exposed")
	}
	if ErrBranchLimit.Extra != nil {
		t.Fatal("AsError must not write into the shared sentinel")
	}
}

func TestCardAndNoteErrors_CarryTheProblems(t *testing.T) {
	card := CardError([]BranchCardProblem{{Field: "question", Message: "is required"}})
	if card.Code != CodeInvalidCard || card.Message != "the conclusion card is not acceptable: question is required" || card.Extra["problems"] == nil {
		t.Fatalf("card error = %+v", card)
	}
	note := NoteError([]NoteProblem{{Field: "text", Message: "must not be empty"}})
	if note.Code != CodeInvalidNote || note.Message != "the note is not acceptable: text must not be empty" {
		t.Fatalf("note error = %+v", note)
	}
}

func TestAsError_KeepsTheCauseForErrorsIs(t *testing.T) {
	l := DefaultLimits()
	for _, sentinel := range []error{ErrBranchClosed, ErrBranchMoveCount, ErrNoteLimit} {
		if got := AsError(fmt.Errorf("x: %w", sentinel), l); !errors.Is(got, sentinel) {
			t.Fatalf("errors.Is(AsError(%v), sentinel) = false", sentinel)
		}
	}
	if refined := AsError(CheckMoveCount(0, l.Branch), l); !errors.Is(refined, ErrBranchMoveCount) || refined.Message != "count must be between 1 and 40" {
		t.Fatalf("refined = %+v", refined)
	}
	soft := &BranchDepthSoftError{Depth: 4, Limit: 3}
	var gotSoft *BranchDepthSoftError
	if !errors.As(AsError(soft, l), &gotSoft) || gotSoft != soft {
		t.Fatal("a converted typed error must unwrap to it")
	}
}

func TestError_NilReceiverDoesNotPanic(t *testing.T) {
	var nilErr *Error
	if nilErr.Error() == "" || nilErr.Unwrap() != nil {
		t.Fatal("nil receiver")
	}
	var err error = nilErr
	if CodeOf(err) != "" || AsError(err, DefaultLimits()) != nil {
		t.Fatal("a typed nil must not be a domain error")
	}
}
