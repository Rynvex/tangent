package domain

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Assembling an import (B19): the source's dates are kept, milestone
// chapter cuts are set on main-line messages and a branch may arrive
// already brought back, its conclusion card on the main line right after
// its anchor. All of it is optional: an import without any of it is
// planned exactly as in B18.

// Limits of an assembled import.
const (
	// ImportMaxChapterCuts caps the chapter cuts of an import (also capped by
	// ChapterLimits.MilestoneMaxPerTree).
	ImportMaxChapterCuts = 50
	// ImportFutureSlack is how far past now a date may be (clock skew
	// between the source and this server).
	ImportFutureSlack = 24 * time.Hour
)

// ImportEarliest is the earliest date an import may carry.
var ImportEarliest = time.Date(1970, time.January, 1, 0, 0, 0, 0, time.UTC)

// ImportDates are the dates a line of an import is written with: when it
// started and its last activity (its last message).
type ImportDates struct {
	CreatedAt      time.Time
	LastActivityAt time.Time
}

// ImportPlanCut is a checked chapter cut: a milestone on Messages[AnchorIndex].
type ImportPlanCut struct {
	AnchorIndex int
	Title       string
}

// checkImportTime checks an optional date and returns it in UTC.
func checkImportTime(field string, at *time.Time, now time.Time) (*time.Time, error) {
	if at == nil {
		return nil, nil
	}
	utc := at.UTC()
	if utc.IsZero() || utc.Before(ImportEarliest) || utc.After(now.Add(ImportFutureSlack)) {
		return nil, importError(field, "the date is between 1970-01-01 and one day from now")
	}
	return &utc, nil
}

// planImportDates fills the dates of a plan whose input carries at least
// one (lineAt is the conversation's createdAt, branchAt each branch's,
// already checked); without any it returns the plan as it is. On each line
// (the main line, every branch) on its own:
//   - the line starts at the earlier of its createdAt and its first dated
//     message, or at now when it has neither;
//   - a message without a date, or dated before the message above it, takes
//     the date of the message above it (the line's start for the first), so
//     dates never go down in seq order;
//   - the last activity is the last message's date.
func planImportDates(plan ImportPlan, lineAt *time.Time, branchAt []*time.Time, now time.Time) ImportPlan {
	if !importHasDates(plan, lineAt, branchAt) {
		return plan
	}
	now = now.UTC()
	out := plan
	out.Messages, out.Dates = dateImportLine(plan.Messages, lineAt, now)
	out.Branches = make([]ImportPlanBranch, 0, len(plan.Branches))
	for i, branch := range plan.Branches {
		dated := branch
		dated.Messages, dated.Dates = dateImportLine(branch.Messages, branchAt[i], now)
		out.Branches = append(out.Branches, dated)
	}
	return out
}

func importHasDates(plan ImportPlan, lineAt *time.Time, branchAt []*time.Time) bool {
	if lineAt != nil || hasMessageDate(plan.Messages) {
		return true
	}
	for i, branch := range plan.Branches {
		if branchAt[i] != nil || hasMessageDate(branch.Messages) {
			return true
		}
	}
	return false
}

func hasMessageDate(messages []ImportMessage) bool {
	for _, message := range messages {
		if message.CreatedAt != nil {
			return true
		}
	}
	return false
}

// dateImportLine dates the messages of one line (planImportDates' rules)
// and returns them with the line's dates.
func dateImportLine(messages []ImportMessage, lineAt *time.Time, now time.Time) ([]ImportMessage, *ImportDates) {
	start := now
	if lineAt != nil {
		start = *lineAt
	}
	for _, message := range messages {
		if message.CreatedAt != nil {
			if lineAt == nil || message.CreatedAt.Before(start) {
				start = *message.CreatedAt
			}
			break
		}
	}
	out := make([]ImportMessage, 0, len(messages))
	previous := start
	for _, message := range messages {
		at := previous
		if message.CreatedAt != nil && message.CreatedAt.After(previous) {
			at = *message.CreatedAt
		}
		dated := message
		dated.CreatedAt = &at
		out = append(out, dated)
		previous = at
	}
	return out, &ImportDates{CreatedAt: start, LastActivityAt: previous}
}

// planImportCuts checks the chapter cuts: each names a main-line message
// (at most one cut per message) and has a title of 1 to ImportTitleRunes
// characters (flattened to one line; at most the milestone limit too).
func planImportCuts(in []ImportChapterCut, anchors map[string]int, l ChapterLimits) ([]ImportPlanCut, error) {
	limit := min(ImportMaxChapterCuts, l.MilestoneMaxPerTree)
	if len(in) > limit {
		return nil, importError("chapterCuts", fmt.Sprintf("an import has at most %d chapter cuts", limit))
	}
	titleRunes := min(ImportTitleRunes, l.MilestoneTitleMaxRunes)
	out := make([]ImportPlanCut, 0, len(in))
	cut := map[int]bool{}
	for i, c := range in {
		field := fmt.Sprintf("chapterCuts[%d]", i)
		anchor, ok := anchors[strings.TrimSpace(c.AnchorExternalID)]
		if !ok {
			return nil, importError(field+".anchorExternalId", "anchorExternalId names no main-line message of the import")
		}
		if cut[anchor] {
			return nil, importError(field+".anchorExternalId", "this message already has a chapter cut")
		}
		title := strings.TrimSpace(FlattenUntrusted(c.Title))
		if n := utf8.RuneCountInString(title); n == 0 || n > titleRunes {
			return nil, importError(field+".title", fmt.Sprintf("title is 1 to %d characters", titleRunes))
		}
		cut[anchor] = true
		out = append(out, ImportPlanCut{AnchorIndex: anchor, Title: title})
	}
	return out, nil
}

// planImportCard checks the card of an imported branch: a merged branch
// must carry one (invalid_input), any other must not. An empty question is
// the branch's purpose. The card is validated like a merge's, citing no
// message (the imported messages have no ids yet): a problem is
// invalid_card, its field under the branch's ("branches[0].card.conclusion").
// It returns the cleaned card and its rendering.
func planImportCard(field string, card *BranchCard, status, purpose string) (*BranchCard, string, error) {
	if status != BranchStatusMerged {
		if card != nil {
			return nil, "", importError(field+".card", "only a merged branch carries a card")
		}
		return nil, "", nil
	}
	if card == nil {
		return nil, "", importError(field+".card", "a merged branch carries its card")
	}
	filled := *card
	if strings.TrimSpace(filled.Question) == "" {
		filled.Question = purpose
	}
	checked, problems := ValidateBranchCard(filled, BranchCardRefs{})
	if len(problems) > 0 {
		under := make([]BranchCardProblem, 0, len(problems))
		for _, problem := range problems {
			under = append(under, BranchCardProblem{Field: field + ".card." + problem.Field, Message: problem.Message})
		}
		return nil, "", CardError(under)
	}
	return &checked, RenderBranchCardMarkdown(checked, purpose), nil
}
