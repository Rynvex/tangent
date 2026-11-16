package httpapi

import (
	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// Response bodies. JSON is camelCase; lists are never null.

type linePage struct {
	Lines      []domain.LineView `json:"lines"`
	NextCursor string            `json:"nextCursor"`
}

type lineList struct {
	Lines []domain.LineView `json:"lines"`
}

type deletedTree struct {
	RootLineID string   `json:"rootLineId"`
	LineIDs    []string `json:"lineIds"`
}

type messagePage struct {
	Messages []domain.Message `json:"messages"`
}

type turnStarted struct {
	TurnID         string         `json:"turnId"`
	UserMessage    domain.Message `json:"userMessage"`
	PendingMessage domain.Message `json:"pendingMessage"`
}

type cancelledTurn struct {
	Cancelled bool            `json:"cancelled"`
	Line      domain.LineView `json:"line"`
	// Message is the cancelled reply; null when nothing was pending.
	Message *domain.Message `json:"message"`
}

// jobStarted is a 202 for a job; Provider and Model are what the job asks
// the runner for (a feature's job model, else the line's).
type jobStarted struct {
	JobID    string `json:"jobId"`
	Kind     string `json:"kind"`
	LineID   string `json:"lineId"`
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

type branchList struct {
	Branches []domain.BranchView `json:"branches"`
}

type createdBranch struct {
	Line   domain.LineView   `json:"line"`
	Branch domain.BranchView `json:"branch"`
	Pack   domain.BranchPack `json:"pack"`
}

type movedBranch struct {
	Line            domain.LineView   `json:"line"`
	Branch          domain.BranchView `json:"branch"`
	Marker          domain.Message    `json:"marker"`
	SourceLineID    string            `json:"sourceLineId"`
	RootLineID      string            `json:"rootLineId"`
	MovedMessageIDs []string          `json:"movedMessageIds"`
	Reparented      []string          `json:"reparented"`
	SummaryReset    bool              `json:"summaryReset"`
}

type notesWrite struct {
	RootLineID string        `json:"rootLineId"`
	Revision   int           `json:"revision"`
	Created    []domain.Note `json:"created"`
	Superseded []domain.Note `json:"superseded"`
}

type mergedBranch struct {
	Branch  domain.BranchView `json:"branch"`
	Message domain.Message    `json:"message"`
	// Line is the parent the card went to.
	Line  domain.LineView `json:"line"`
	Notes *notesWrite     `json:"notes,omitempty"`
}

type discardedBranch struct {
	Branch domain.BranchView `json:"branch"`
}

type promotedBranch struct {
	// Branch is the promoted branch, now closed (its messages are the main
	// line's); PreviousMainLine is the ended branch holding the old tail.
	Branch           domain.BranchView `json:"branch"`
	PreviousMainLine domain.BranchView `json:"previousMainLine"`
	Line             domain.LineView   `json:"line"`
	Reparented       []string          `json:"reparented"`
}

type noteLimits struct {
	MaxActive          int `json:"maxActive"`
	MaxTotal           int `json:"maxTotal"`
	MaxRunes           int `json:"maxRunes"`
	MaxChangesPerMerge int `json:"maxChangesPerMerge"`
	// TokenBudget bounds the notes block of one prompt: notes past it are
	// left out (to_confirm first, then todo, then facts; decided never).
	TokenBudget int `json:"tokenBudget"`
}

type notesView struct {
	RootLineID string        `json:"rootLineId"`
	Revision   int           `json:"revision"`
	Notes      []domain.Note `json:"notes"`
	Limits     noteLimits    `json:"limits"`
}

type noteWrite struct {
	Note       domain.Note  `json:"note"`
	Superseded *domain.Note `json:"superseded,omitempty"`
	Revision   int          `json:"revision"`
	RootLineID string       `json:"rootLineId"`
}

type chapterLimits struct {
	MaxChapters     int `json:"maxChapters"`
	MinMessages     int `json:"minMessages"`
	IdleGapMinutes  int `json:"idleGapMinutes"`
	MaxMilestones   int `json:"maxMilestones"`
	MilestoneMaxLen int `json:"milestoneMaxLen"`
}

type chaptersView struct {
	LineID     string              `json:"lineId"`
	RootLineID string              `json:"rootLineId"`
	Chapters   []domain.Chapter    `json:"chapters"`
	Milestones []domain.ChapterCut `json:"milestones"`
	Limits     chapterLimits       `json:"limits"`
}

type milestoneAdded struct {
	Milestone  domain.ChapterCut `json:"milestone"`
	RootLineID string            `json:"rootLineId"`
}

type capabilities struct {
	Features    []tangent.Capability `json:"features"`
	Permissions permissions          `json:"permissions"`
	// Models are the providers and models the host offers (WithModelCatalog).
	Models []tangent.ModelGroup `json:"models"`
}

// permissions is what the caller may do (Config.CanWrite).
type permissions struct {
	CanWrite bool `json:"canWrite"`
}

// list returns s, or an empty slice for nil, so JSON shows [] not null.
func list[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
