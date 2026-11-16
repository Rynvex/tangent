package domain

import (
	"encoding/json"
	"strings"
)

// Assistant-suggested side lines. A reply may carry up to BranchSuggestMax
// lines of the form
//
//	[BRANCH-SUGGEST]{"purpose":"...","kind":"investigate","excerpt":"..."}
//
// The library removes those lines from the stored reply, keeps the valid ones
// in the message meta, and the operator decides whether to open them. The
// model never opens a branch itself.

const (
	// BranchSuggestMax is how many suggestions one reply keeps.
	BranchSuggestMax = 3
	// branchSuggestLineMaxBytes bounds the JSON of one suggestion line.
	branchSuggestLineMaxBytes = 4000
)

// BranchSuggestRules is the sentence block that tells a model when it may
// suggest a side line.
const BranchSuggestRules = "- Only when a clearly separate question would pull this conversation off its topic, you may end the reply with at most " +
	"3 lines like " + BranchSuggestMarker + `{"purpose":"one short sentence","kind":"investigate"}` +
	" (kind is investigate or alternative; an optional excerpt quotes the part of your reply it comes from). " +
	"This only offers a side line to the operator, it opens nothing; do not suggest on every reply.\n"

// BranchSuggestion is one proposed side line, as stored in message meta.
type BranchSuggestion struct {
	Purpose string `json:"purpose"`
	Kind    string `json:"kind"`
	Excerpt string `json:"excerpt,omitempty"`
}

// ExtractBranchSuggestions removes every suggestion line from content and
// returns the cleaned text (trimmed by TrimReply) and the valid suggestions (at most
// BranchSuggestMax; a bad line is dropped, never an error).
func ExtractBranchSuggestions(content string, l BranchLimits) (string, []BranchSuggestion) {
	if !strings.Contains(content, BranchSuggestMarker) {
		return TrimReply(content), nil
	}
	var kept []string
	var out []BranchSuggestion
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(MarkerLineStart(line))
		if !strings.HasPrefix(trimmed, BranchSuggestMarker) {
			kept = append(kept, stripSuggestMarkers(line))
			continue
		}
		if suggestion, ok := parseBranchSuggestion(strings.TrimPrefix(trimmed, BranchSuggestMarker), l); ok && len(out) < BranchSuggestMax {
			out = append(out, suggestion)
		}
	}
	return TrimReply(strings.Join(kept, "\n")), out
}

// stripSuggestMarkers removes the suggestion marker and its closing form from
// a kept line, repeatedly, so "[BRANCH-[BRANCH-SUGGEST]SUGGEST]" cannot leave
// a live marker behind. Other text is kept as the model wrote it.
func stripSuggestMarkers(line string) string {
	return StripMarkers(line, []string{BranchSuggestMarker, "[/BRANCH-SUGGEST]"})
}

// parseBranchSuggestion validates one suggestion's JSON. Purpose and excerpt
// are flattened to one line with protocol markers removed.
func parseBranchSuggestion(raw string, l BranchLimits) (BranchSuggestion, bool) {
	raw = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(raw), "[/BRANCH-SUGGEST]"))
	if raw == "" || len(raw) > branchSuggestLineMaxBytes {
		return BranchSuggestion{}, false
	}
	var parsed BranchSuggestion
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return BranchSuggestion{}, false
	}
	purpose, ok := NormalizeBranchPurpose(branchLine(parsed.Purpose), l)
	if !ok || !ValidBranchKind(parsed.Kind) {
		return BranchSuggestion{}, false
	}
	excerpt, ok := NormalizeBranchExcerpt(branchLine(parsed.Excerpt), l)
	if !ok {
		return BranchSuggestion{}, false
	}
	return BranchSuggestion{Purpose: purpose, Kind: parsed.Kind, Excerpt: excerpt}, true
}

// FindBranchSuggestion returns the suggestion of meta with the given purpose
// and kind, if the model made one.
func FindBranchSuggestion(meta MessageMeta, purpose, kind string) (BranchSuggestion, bool) {
	for _, suggestion := range meta.Suggestions {
		if suggestion.Purpose == purpose && suggestion.Kind == kind {
			return suggestion, true
		}
	}
	return BranchSuggestion{}, false
}
