package domain

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Lines: a durable, resumable conversation between an operator and an AI.
// A line without a branch record is a main line (the root of a tree); a line
// with one is a side line hanging on a message of its parent. Messages of a
// line are ordered by their global seq, never by their creation time.

// Line statuses.
const (
	LineStatusIdle     = "idle"
	LineStatusThinking = "thinking"
	LineStatusError    = "error"
)

// Message roles.
const (
	RoleUser      = "user"
	RoleAssistant = "assistant"
	RoleSystem    = "system"
)

// Message statuses.
const (
	MessagePending = "pending"
	MessageDone    = "done"
	MessageError   = "error"
)

// Message kinds.
const (
	// MessageKindChat is an ordinary operator, assistant or system message.
	MessageKindChat = "chat"
	// MessageKindBranchCard is the system message a merged branch leaves in its parent.
	MessageKindBranchCard = "branch_card"
	// MessageKindBranchMarker is the system message a move leaves where the
	// moved messages were.
	MessageKindBranchMarker = "branch_marker"
)

// Delta kinds of a streamed turn.
const (
	DeltaText      = "text"
	DeltaReasoning = "reasoning"
	DeltaTool      = "tool"
)

const (
	// lineStatusDetailLimit caps the stored error detail.
	lineStatusDetailLimit = 500
)

// Line is one conversation line as the API shows it.
type Line struct {
	ID           string `json:"id"`
	TenantID     string `json:"tenantId"`
	Title        string `json:"title"`
	Status       string `json:"status"`
	StatusDetail string `json:"statusDetail"`
	// Provider and Model are hints for the runner; both may be empty.
	Provider string `json:"provider"`
	Model    string `json:"model"`
	// Folder groups a main line in the conversation list (B18; "" when
	// unfiled, always "" on a branch).
	Folder string `json:"folder"`
	// Tags are topic labels on a main line (B18; always a non-nil slice,
	// empty on a branch).
	Tags   []string `json:"tags"`
	Unread int      `json:"unread"`
	// Summary is the rolling digest; always an object.
	Summary Summary `json:"summary"`
	// SummaryUptoSeq is the seq of the newest message the summary covers;
	// 0 when there is none (internal).
	SummaryUptoSeq int64 `json:"-"`
	// NotesRevision counts changes of the tree's notes (main line only);
	// NotesRevisionSent is the revision the last finished turn carried.
	NotesRevision     int `json:"notesRevision"`
	NotesRevisionSent int `json:"-"`
	// Usage is the accumulated usage of the line's turns (cache buckets are
	// only kept per message).
	Usage          Usage           `json:"usage"`
	HostMeta       json.RawMessage `json:"hostMeta"`
	LastActivityAt time.Time       `json:"lastActivityAt"`
	ArchivedAt     *time.Time      `json:"archivedAt"`
	CreatedBy      string          `json:"createdBy"`
	CreatedAt      time.Time       `json:"createdAt"`
	UpdatedAt      time.Time       `json:"updatedAt"`
	// SpunOffFrom is where a spun-off main line came from (spinoff); nil
	// otherwise.
	SpunOffFrom *SpunOffRef `json:"spunOffFrom"`
	// ImportBatchID is the import batch the main line came in (B25); "" for
	// a line of no batch. An attached line keeps it; a spun-off one has none.
	ImportBatchID string `json:"importBatchId,omitempty"`
	// PinnedAt is when the operator pinned the main line (B25); nil when it
	// is not pinned, always nil on a branch. Pinning is not activity.
	PinnedAt *time.Time `json:"pinnedAt,omitempty"`
	// Capsule is a spun-off main line's origin capsule (internal: the prompt
	// carries it).
	Capsule *OriginCapsule `json:"-"`
}

// LineView is a line with its place in the tree: the branch record when it
// is a side line, its direct branches counted by status and the unread
// messages of every open branch below it.
type LineView struct {
	Line
	// ConversationBranch is nil for a main line.
	ConversationBranch *BranchRef   `json:"conversationBranch"`
	BranchCounts       BranchCounts `json:"branchCounts"`
	BranchUnread       int          `json:"branchUnread"`
	// AwaitingReview counts the open branches below the line whose
	// conclusion card draft is ready for the operator to review.
	AwaitingReview int `json:"awaitingReview"`
	// OpenSuggestions and OpenSeeds count the conversation's open
	// suggestions (the inbox) and open parked thoughts, on the main line
	// only (0 on a branch). They count stored rows whatever the features'
	// state; clients show them when /capabilities says the feature is on.
	OpenSuggestions int `json:"openSuggestions"`
	OpenSeeds       int `json:"openSeeds"`
	// StaleBranches counts the conversation's open branches idle longer
	// than Limits.OpenLoops.StaleAfter (open loops), on the main line only;
	// it is computed when read, so time passing alone sends no event.
	StaleBranches int `json:"staleBranches"`
}

// IsMainLine reports whether the view is the root of its tree.
func (v LineView) IsMainLine() bool { return v.ConversationBranch == nil }

// Usage is the token usage and cost of one turn. InputTokens counts every
// prompt token, the prompt-cache reads and writes included; the cache
// buckets say how many of them were read from or written to the cache.
type Usage struct {
	InputTokens      int64   `json:"inputTokens"`
	OutputTokens     int64   `json:"outputTokens"`
	CostUSD          float64 `json:"costUsd"`
	CacheReadTokens  int64   `json:"cacheReadTokens,omitempty"`
	CacheWriteTokens int64   `json:"cacheWriteTokens,omitempty"`
}

// TotalTokens sums the token buckets.
func (u Usage) TotalTokens() int64 { return u.InputTokens + u.OutputTokens }

// MessageMeta is the library-owned part of a message's meta JSON. Hosts keep
// their own data in Message.HostMeta.
type MessageMeta struct {
	Provider   string `json:"provider,omitempty"`
	Model      string `json:"model,omitempty"`
	Usage      *Usage `json:"usage,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
	Error      string `json:"error,omitempty"`
	// Cancelled marks a turn the operator cancelled; the partial content that
	// already streamed is kept.
	Cancelled bool `json:"cancelled,omitempty"`
	// Card is the structured conclusion on a branch_card message; BranchLineID
	// is the branch it came from.
	Card         *BranchCard `json:"card,omitempty"`
	BranchLineID string      `json:"branchLineId,omitempty"`
	// Delivered is set once a turn of the parent that carried this card
	// finished without failing.
	Delivered bool `json:"delivered,omitempty"`
	// EditedAt, on a branch_card message, is when the card was last edited
	// after its merge (B17.1); nil when it has never been edited.
	EditedAt *time.Time `json:"editedAt,omitempty"`
	// DeliversCards, on a pending assistant message, lists the branch cards
	// that turn's prompt carried.
	DeliversCards []string `json:"deliversCards,omitempty"`
	// NotesRevision, on a pending assistant message, is the notes revision that
	// turn's prompt carried; a turn that finishes without failing records it
	// as sent.
	NotesRevision int `json:"notesRevision,omitempty"`
	// Suggestions are the side lines the assistant proposed in this reply; the
	// marker lines are removed from the stored content.
	Suggestions []BranchSuggestion `json:"suggestions,omitempty"`
	// Actor is who started the turn (on the pending assistant message).
	Actor string `json:"actor,omitempty"`
	// StreamSeq, on a pending assistant message, is the delta seq its saved
	// partial content covers: a client shows the content, then the deltas
	// after StreamSeq. Cleared when the turn finishes.
	StreamSeq int64 `json:"streamSeq,omitempty"`
	// SpunOffTo, on the marker a spinoff leaves on its source line, names the
	// new main line (lineId, title) and the message it grew from
	// (messageId).
	SpunOffTo *SpunOffRef `json:"spunOffTo,omitempty"`
	// Folded, on a fold's history entry (never stored), is how many
	// messages it stands for.
	Folded int `json:"folded,omitempty"`
}

// Message is one transcript entry. Seq is global and increasing; ordering
// within a line is always by Seq.
type Message struct {
	ID       string          `json:"id"`
	Seq      int64           `json:"seq"`
	LineID   string          `json:"lineId"`
	Role     string          `json:"role"`
	Kind     string          `json:"kind"`
	Content  string          `json:"content"`
	Status   string          `json:"status"`
	Meta     MessageMeta     `json:"meta"`
	HostMeta json.RawMessage `json:"hostMeta"`
	// Pinned marks a message the operator wants kept in view (the fisheye
	// context gives it a head start).
	Pinned bool `json:"pinned"`
	// Tag is the message's argument tag (the ibis feature); absent without
	// one. Stored tags show even while the feature is off.
	Tag       *MessageTag `json:"tag,omitempty"`
	CreatedAt time.Time   `json:"createdAt"`
}

// IsCard reports whether the message is a branch conclusion card.
func (m Message) IsCard() bool { return m.Kind == MessageKindBranchCard }

// Delta is one streamed piece of a running turn.
type Delta struct {
	TurnID string `json:"turnId"`
	Seq    int64  `json:"seq"`
	Kind   string `json:"kind"`
	Text   string `json:"text"`
}

// ValidDeltaKind reports whether kind is text, reasoning or tool.
func ValidDeltaKind(kind string) bool {
	return kind == DeltaText || kind == DeltaReasoning || kind == DeltaTool
}

// SortBySeq returns a copy of messages ordered by seq.
func SortBySeq(messages []Message) []Message {
	out := slices.Clone(messages)
	slices.SortStableFunc(out, func(a, b Message) int {
		switch {
		case a.Seq < b.Seq:
			return -1
		case a.Seq > b.Seq:
			return 1
		}
		return 0
	})
	return out
}

// HistoryBeforeTurn is the history a new turn's prompt shows: the line's
// messages in seq order without the pending ones, the turn's pending
// assistant message and the operator's current message, both named by id.
func HistoryBeforeTurn(history []Message, pendingID, userMessageID string) []Message {
	out := make([]Message, 0, len(history))
	for _, message := range SortBySeq(history) {
		if message.ID == pendingID || message.ID == userMessageID || message.Status == MessagePending {
			continue
		}
		out = append(out, message)
	}
	return out
}

// TurnOutcome is what a finished turn does to the line and its message.
type TurnOutcome struct {
	Status       string
	StatusDetail string
	Content      string
	Failed       bool
}

// ResolveTurnOutcome maps a runner's result onto the line status, its detail
// and the content stored on the assistant message.
func ResolveTurnOutcome(content, runErr string) TurnOutcome {
	if detail := strings.TrimSpace(runErr); detail != "" {
		return TurnOutcome{Status: LineStatusError, StatusDetail: truncateRunes(detail, lineStatusDetailLimit), Content: "Turn failed: " + detail, Failed: true}
	}
	content = TrimReply(content)
	if content == "" {
		return TurnOutcome{Status: LineStatusError, StatusDetail: "empty response", Content: "Turn failed: the assistant returned no content", Failed: true}
	}
	return TurnOutcome{Status: LineStatusIdle, Content: content}
}

// TrimReply is how a stored reply is trimmed: Unicode white space at both
// ends goes. ResolveTurnOutcome and ExtractBranchSuggestions use it, and the
// engine's stream filter mirrors it, so a streamed reply and the stored one
// are the same bytes.
func TrimReply(content string) string { return strings.TrimSpace(content) }

// ValidLineStatus reports whether s is one of the line statuses.
func ValidLineStatus(s string) bool {
	return s == LineStatusIdle || s == LineStatusThinking || s == LineStatusError
}

// TransitionLineStatus validates a status change: a turn starts from any
// non-thinking status, a result lands only on a thinking line, and error is
// reachable from everywhere (timeouts, cancelled runners).
func TransitionLineStatus(from, to string) error {
	if !ValidLineStatus(from) || !ValidLineStatus(to) {
		return refine(ErrStatusTransition, fmt.Sprintf("%s: %q -> %q", ErrStatusTransition.Message, from, to), nil)
	}
	switch to {
	case LineStatusThinking:
		if from == LineStatusThinking {
			return ErrTurnPending
		}
	case LineStatusIdle:
		if from != LineStatusThinking {
			return refine(ErrStatusTransition, fmt.Sprintf("%s: %q -> %q", ErrStatusTransition.Message, from, to), nil)
		}
	}
	return nil
}

// roleLabel is the transcript label for a role. Standard role labels are kept
// so prompts read the same: the operator and the agent.
func roleLabel(role string) string {
	switch role {
	case RoleUser:
		return "operator"
	case RoleAssistant:
		return "agent"
	default:
		return "system"
	}
}

// condenseLine collapses whitespace and caps the rune count.
func condenseLine(s string, limit int) string {
	return truncateRunes(strings.Join(strings.Fields(s), " "), limit)
}

// truncateRunes caps s at limit runes, appending an ellipsis when cut.
func truncateRunes(s string, limit int) string {
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return string(runes[:limit]) + "…"
}
