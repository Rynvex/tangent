package domain

import (
	"fmt"
	"time"
	"unicode/utf8"
)

// Seeds: thoughts parked for later (the parking feature). Parking costs no
// tokens: no branch is opened and no model is called. A seed is later
// expanded into a branch, written into the notes, or dropped; every one of
// those ends it for good.

// Seed statuses: open → expanded | noted | dropped, one way.
const (
	SeedStatusOpen     = "open"
	SeedStatusExpanded = "expanded"
	SeedStatusNoted    = "noted"
	SeedStatusDropped  = "dropped"
)

// BranchOriginSeed marks a branch opened by expanding a seed.
const BranchOriginSeed = "seed"

// Errors of seeds.
var (
	// ErrSeedNotFound: no such seed in this conversation.
	ErrSeedNotFound = NewError(CodeSeedNotFound, "seed not found in this conversation", nil)
	// ErrSeedNotOpen: the seed was already expanded, noted or dropped.
	ErrSeedNotOpen = NewError(CodeSeedNotOpen, "this seed was already expanded, noted or dropped", nil)
	// ErrSeedLimit: the conversation holds as many open seeds as it may.
	ErrSeedLimit = NewError(CodeSeedLimit, "this conversation has reached its limit of parked thoughts", nil)
)

// Seed is one parked thought.
type Seed struct {
	ID         string `json:"id"`
	RootLineID string `json:"rootLineId"`
	// AnchorMessageID is where the thought came up (the message it was
	// parked at, or the newest message of the line it was parked on); empty
	// when that line had none.
	AnchorMessageID string `json:"anchorMessageId"`
	// AnchorLineID is the line the anchor message is on now ("" without an
	// anchor or once it is gone); SourceLabel the text snapshot of where the
	// seed was parked, taken when it was (the notes' rules: "主線 #n",
	// "查證・purpose"…; "" without an anchor).
	AnchorLineID string `json:"anchorLineId"`
	SourceLabel  string `json:"sourceLabel"`
	Text         string `json:"text"`
	Status       string `json:"status"`
	// ExpandedLineID is the branch an expanded seed became; NoteID the note
	// a noted seed became.
	ExpandedLineID string    `json:"expandedLineId"`
	NoteID         string    `json:"noteId"`
	CreatedBy      string    `json:"createdBy"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// ValidSeedStatus reports whether s is one of the seed statuses.
func ValidSeedStatus(s string) bool {
	switch s {
	case SeedStatusOpen, SeedStatusExpanded, SeedStatusNoted, SeedStatusDropped:
		return true
	}
	return false
}

// NormalizeSeedText flattens a seed's text to one safe line and checks it is
// not empty and within the limit.
func NormalizeSeedText(text string, l ParkingLimits) (string, error) {
	l = l.orDefault()
	clean := branchLine(text)
	if clean == "" {
		return "", NewError(CodeInvalidInput, "the text of a parked thought must not be empty", nil)
	}
	if utf8.RuneCountInString(clean) > l.TextMaxRunes {
		return "", CheckRunes("text", clean, l.TextMaxRunes)
	}
	return clean, nil
}

// SeedBatchMax caps the thoughts one batch parks (an outline or a to-do
// list turned into seeds, B14).
const SeedBatchMax = 20

// NormalizeSeedTexts checks a batch of thoughts: 1 to SeedBatchMax of them
// (invalid_input otherwise), each as NormalizeSeedText checks one.
func NormalizeSeedTexts(texts []string, l ParkingLimits) ([]string, error) {
	if len(texts) < 1 || len(texts) > SeedBatchMax {
		return nil, NewError(CodeInvalidInput, fmt.Sprintf("a batch parks 1 to %d thoughts", SeedBatchMax), nil)
	}
	out := make([]string, 0, len(texts))
	for _, text := range texts {
		clean, err := NormalizeSeedText(text, l)
		if err != nil {
			return nil, err
		}
		out = append(out, clean)
	}
	return out, nil
}

// SeedPurpose is the purpose a seed's branch gets when none is given: its
// text, cut to the purpose limit.
func SeedPurpose(text string, l BranchLimits) string {
	return CutRunes(branchLine(text), l.orDefault().PurposeMaxRunes)
}

// SeedNoteText is the note a seed becomes: its text, cut to the note limit.
func SeedNoteText(text string, l NoteLimits) string {
	return CutRunes(branchLine(text), l.orDefault().MaxRunes)
}
