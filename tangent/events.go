package tangent

import (
	"context"
	"time"

	"github.com/Rynvex/tangent/domain"
)

// Event is one change, published only after its transaction committed.
type Event struct {
	Type       string `json:"type"`
	Tenant     string `json:"tenant"`
	RootLineID string `json:"rootLineId"`
	LineID     string `json:"lineId"`
	// Data is JSON-serialisable; its shape depends on Type (DESIGN §6).
	Data any `json:"data"`
}

// Event types.
const (
	EventLineCreated     = "line.created"
	EventLineUpdated     = "line.updated"
	EventLineDeleted     = "line.deleted"
	EventMessageCreated  = "message.created"
	EventMessageUpdated  = "message.updated"
	EventMessageDelta    = "message.delta"
	EventBranchChanged   = "branch.changed"
	EventNotesChanged    = "notes.changed"
	EventChaptersChanged = "chapters.changed"
	EventTurnRetrying    = "turn.retrying"
	// P1 (B8).
	EventSuggestionChanged = "suggestion.changed"
	EventLeafChanged       = "leaf.changed"
	EventSeedsChanged      = "seeds.changed"
	EventLinkChanged       = "link.changed"
	// EventSummaryDue: a summary is due (summary in suggest mode).
	EventSummaryDue = "summary.due"
	// P2 (B9).
	EventGoalChanged  = "goal.changed"
	EventGroupChanged = "group.changed"
	// EventJobFailed: a feature's background job failed (B9 part C).
	EventJobFailed = "job.failed"
	// EventFoldChanged: a fold of a line was made, written, moved or
	// removed (B10).
	EventFoldChanged = "fold.changed"
	// EventComparisonChanged: a comparison of branches was made, filled,
	// failed or decided (B10).
	EventComparisonChanged = "comparison.changed"
	// EventMemoryChanged: a memory was written or superseded (B10; a
	// tenant's, not a conversation's: rootLineId and lineId are empty).
	EventMemoryChanged = "memory.changed"
	// EventMemoChanged: a memo (not sent to the AI) was written, edited or
	// deleted (B13).
	EventMemoChanged = "memo.changed"
	// EventTermsChanged: a glossary term was saved, edited or deleted
	// (B24).
	EventTermsChanged = "terms.changed"
)

// Changes reported by branch.changed.
const (
	BranchCreated   = "created"
	BranchMoved     = "moved"
	BranchPromoted  = "promoted"
	BranchDraft     = "draft"
	BranchMerged    = "merged"
	BranchDiscarded = "discarded"
	BranchRenamed   = "renamed"
	// BranchDetached: the branch became a main line of its own (spinoff).
	BranchDetached = "detached"
	// BranchKept: an aside was kept from the purge, or released again (B23;
	// the branch's keptAt says which).
	BranchKept = "kept"
)

// BranchChange is the data of branch.changed.
type BranchChange struct {
	Change string            `json:"change"`
	Branch domain.BranchView `json:"branch"`
}

// LinesDeleted is the data of line.deleted.
type LinesDeleted struct {
	RootLineID string   `json:"rootLineId"`
	LineIDs    []string `json:"lineIds"`
}

// NotesChange is the data of notes.changed.
type NotesChange struct {
	RootLineID string `json:"rootLineId"`
	Revision   int    `json:"revision"`
}

// ChaptersChange is the data of chapters.changed.
type ChaptersChange struct {
	RootLineID string `json:"rootLineId"`
}

// TurnRetrying is the data of turn.retrying: the runner hit a 429 / 5xx and
// tries again at NextRetryAt.
type TurnRetrying struct {
	TurnID      string    `json:"turnId"`
	Attempt     int       `json:"attempt"`
	MaxAttempts int       `json:"maxAttempts"`
	NextRetryAt time.Time `json:"nextRetryAt"`
}

// publish hands events to the host's publisher in order. A publisher that
// panics is logged and does not take the engine down.
func (e *Engine) publish(ctx context.Context, events ...Event) {
	for _, ev := range events {
		e.publishOne(ctx, ev)
	}
}

func (e *Engine) publishOne(ctx context.Context, ev Event) {
	defer func() {
		if recovered := recover(); recovered != nil {
			e.log.Error("tangent: publisher panicked", "event", ev.Type, "panic", recovered)
		}
	}()
	e.publisher.Publish(ctx, ev)
}

// lineEvent is a line.created / line.updated event.
func lineEvent(kind string, line domain.LineView) Event {
	return Event{Type: kind, Tenant: line.TenantID, RootLineID: rootOfView(line), LineID: line.ID, Data: line}
}

// messageEvent is a message.created / message.updated event.
func messageEvent(kind, tenant, rootLineID string, message domain.Message) Event {
	return Event{Type: kind, Tenant: tenant, RootLineID: rootLineID, LineID: message.LineID, Data: message}
}

// branchEvent is a branch.changed event.
func branchEvent(tenant, change string, view domain.BranchView) Event {
	return Event{
		Type: EventBranchChanged, Tenant: tenant, RootLineID: view.RootLineID, LineID: view.LineID,
		Data: BranchChange{Change: change, Branch: view},
	}
}

// rootOfView is the main line of a line's tree.
func rootOfView(line domain.LineView) string {
	if line.ConversationBranch != nil {
		return line.ConversationBranch.RootLineID
	}
	return line.ID
}

// Publishers fans every event out to each publisher in order. One that
// panics does not keep the event from the others; the first panic is
// raised again once all were called, so the engine logs it as it logs any
// publisher's panic. Nil publishers are skipped.
func Publishers(publishers ...Publisher) Publisher {
	out := make(fanOut, 0, len(publishers))
	for _, p := range publishers {
		if p != nil {
			out = append(out, p)
		}
	}
	return out
}

type fanOut []Publisher

func (f fanOut) Publish(ctx context.Context, ev Event) {
	var first any
	for _, p := range f {
		if recovered := publishGuarded(ctx, p, ev); recovered != nil && first == nil {
			first = recovered
		}
	}
	if first != nil {
		panic(first)
	}
}

// publishGuarded publishes and returns what a panic carried (nil without one).
func publishGuarded(ctx context.Context, p Publisher, ev Event) (recovered any) {
	defer func() { recovered = recover() }()
	p.Publish(ctx, ev)
	return nil
}
