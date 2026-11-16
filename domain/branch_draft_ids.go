package domain

import (
	"fmt"
	"regexp"
	"strings"
)

// Short ids of the drafting prompt. The prompt names branch messages [B1],
// [B2], … and the main-line messages after the fork [M1], [M2], …, numbered
// oldest first, instead of 36-character UUIDs a model easily miscopies. The
// numbering is a pure function of the BranchDraftInput, so the engine
// rebuilds the same mapping when the run finishes and turns the short ids of
// the reply back into message ids before the card is checked. A reply that
// gives real message ids still works; an unknown short id is left as it is
// and fails the checks like any unknown id.

const (
	draftBranchIDPrefix = "B"
	draftMainIDPrefix   = "M"
)

// draftShortIDPattern is the shape of a short id once brackets and spaces
// are trimmed and it is upper-cased.
var draftShortIDPattern = regexp.MustCompile(`^[BM][1-9][0-9]*$`)

// DraftShortIDs maps the short ids of one drafting prompt to message ids.
type DraftShortIDs struct {
	branch map[string]string
	main   map[string]string
	// labels maps a message id to its short id.
	labels map[string]string
}

// NewDraftShortIDs numbers the input's messages exactly as
// BuildBranchDraftPrompt shows them.
func NewDraftShortIDs(in BranchDraftInput) DraftShortIDs {
	ids := DraftShortIDs{branch: map[string]string{}, main: map[string]string{}, labels: map[string]string{}}
	ids.number(draftBranchIDPrefix, SortBySeq(in.BranchMessages), ids.branch)
	ids.number(draftMainIDPrefix, draftParentSince(in), ids.main)
	return ids
}

func (s DraftShortIDs) number(prefix string, messages []Message, into map[string]string) {
	for i, message := range messages {
		short := fmt.Sprintf("%s%d", prefix, i+1)
		into[short] = message.ID
		s.labels[message.ID] = short
	}
}

// draftParentSince is the main-line part the prompt shows: the newest
// BranchDraftParentSinceMessages after the fork, oldest first.
func draftParentSince(in BranchDraftInput) []Message {
	return lastMessages(SortBySeq(in.ParentSince), BranchDraftParentSinceMessages)
}

// label is the short id of a message of the prompt.
func (s DraftShortIDs) label(message Message) string {
	return s.labels[message.ID]
}

// resolve returns the message id a short id of the table stands for, or raw
// unchanged when it is not one.
func resolveShortID(raw string, table map[string]string) string {
	short := strings.ToUpper(strings.TrimSpace(strings.Trim(strings.TrimSpace(raw), "[]")))
	if !draftShortIDPattern.MatchString(short) {
		return raw
	}
	if id, ok := table[short]; ok {
		return id
	}
	return raw
}

// ResolveCard returns a copy of card with branch short ids in evidence and
// excerpts, and main-line short ids in decisions, replaced by message ids.
// Every other id is kept as given.
func (s DraftShortIDs) ResolveCard(card BranchCard) BranchCard {
	out := card
	out.Evidence = make([]BranchCardEvidence, len(card.Evidence))
	for i, evidence := range card.Evidence {
		out.Evidence[i] = BranchCardEvidence{MessageID: resolveShortID(evidence.MessageID, s.branch), Note: evidence.Note}
	}
	out.Excerpts = make([]BranchCardExcerpt, len(card.Excerpts))
	for i, excerpt := range card.Excerpts {
		out.Excerpts[i] = BranchCardExcerpt{MessageID: resolveShortID(excerpt.MessageID, s.branch), Text: excerpt.Text}
	}
	out.NeedsDecision = make([]BranchCardDecision, len(card.NeedsDecision))
	for i, decision := range card.NeedsDecision {
		decision.MainLineMessageID = resolveShortID(decision.MainLineMessageID, s.main)
		out.NeedsDecision[i] = decision
	}
	out.OpenItems = append([]string(nil), card.OpenItems...)
	return out
}

// ResolveNoteChanges returns a copy of the proposed note changes with branch
// short ids in sourceMessageId replaced by message ids (nil stays nil).
func (s DraftShortIDs) ResolveNoteChanges(changes []NoteChange) []NoteChange {
	if changes == nil {
		return nil
	}
	out := make([]NoteChange, len(changes))
	for i, change := range changes {
		change.SourceMessageID = resolveShortID(change.SourceMessageID, s.branch)
		out[i] = change
	}
	return out
}
