package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"
)

// The suggestion inbox: what features in suggest mode propose (a structural
// change, a follow-up) waits here for the operator. A suggestion is never
// acted on by itself; accepting it runs the feature's action. One target
// (feature, kind, target key) has at most one open suggestion per
// conversation; after a dismissal it is not raised again for a cooldown, or
// never when the feature says so.

// Suggestion statuses: open → accepted | dismissed | expired, one way.
const (
	SuggestionOpen      = "open"
	SuggestionAccepted  = "accepted"
	SuggestionDismissed = "dismissed"
	SuggestionExpired   = "expired"
)

// Errors of the suggestion inbox.
var (
	// ErrSuggestionGone: no such suggestion in the inbox (it shares the code
	// of an unknown [BRANCH-SUGGEST] suggestion).
	ErrSuggestionGone = NewError(CodeSuggestionNotFound, "suggestion not found", nil)
	// ErrSuggestionNotOpen: the suggestion was already accepted, dismissed or expired.
	ErrSuggestionNotOpen = NewError(CodeSuggestionNotOpen, "this suggestion was already accepted, dismissed or expired", nil)
)

// Suggestion is one entry of the inbox.
type Suggestion struct {
	ID         string `json:"id"`
	RootLineID string `json:"rootLineId"`
	// LineID is the line the suggestion is about; when it is a branch that
	// ends, the suggestion expires.
	LineID    string          `json:"lineId"`
	Feature   string          `json:"feature"`
	Kind      string          `json:"kind"`
	TargetKey string          `json:"targetKey"`
	Payload   json.RawMessage `json:"payload"`
	Status    string          `json:"status"`
	CreatedAt time.Time       `json:"createdAt"`
	DecidedAt *time.Time      `json:"decidedAt"`
}

// ValidSuggestionStatus reports whether s is one of the suggestion statuses.
func ValidSuggestionStatus(s string) bool {
	switch s {
	case SuggestionOpen, SuggestionAccepted, SuggestionDismissed, SuggestionExpired:
		return true
	}
	return false
}

// SuggestionTargetLine is the target key of a suggestion about a line.
func SuggestionTargetLine(lineID string) string { return "line:" + lineID }

// SuggestionPayload checks a feature's payload: empty means {}, anything
// else must be a JSON object within the limit.
func SuggestionPayload(raw []byte, l SuggestionLimits) (json.RawMessage, error) {
	l = l.orDefault()
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return json.RawMessage("{}"), nil
	}
	if len(trimmed) > l.PayloadMaxBytes {
		return nil, fmt.Errorf("a suggestion payload is larger than %d bytes", l.PayloadMaxBytes)
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &probe); err != nil || probe == nil {
		return nil, fmt.Errorf("a suggestion payload must be a JSON object")
	}
	return json.RawMessage(trimmed), nil
}
