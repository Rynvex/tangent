package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// A drafted conclusion card may come with proposed changes of the notes (the
// notes feature on). They have the shape of a merge request's noteChanges
// and pass the same checks; what fails is dropped with a warning, never the
// whole draft. The operator picks which to send with the merge.

// draftProposal is a drafting model's output: the card and its proposals.
type draftProposal struct {
	BranchCard
	NoteChanges []NoteChange `json:"noteChanges"`
}

// ParseBranchDraftProposal is ParseBranchDraft for an output that may also
// carry "noteChanges". The object is decoded as strictly as a card: unknown
// or repeated fields fail the draft.
func ParseBranchDraftProposal(output string) (BranchCard, []NoteChange, error) {
	if len(output) > BranchDraftOutputMaxBytes {
		return BranchCard{}, nil, fmt.Errorf("the draft is larger than %d bytes", BranchDraftOutputMaxBytes)
	}
	if strings.Count(output, BranchCardMarker) != 1 {
		return BranchCard{}, nil, errors.New("the draft must contain the card marker exactly once")
	}
	raw := bytes.TrimSpace([]byte(output[strings.Index(output, BranchCardMarker)+len(BranchCardMarker):]))
	if len(raw) == 0 || raw[0] != '{' {
		return BranchCard{}, nil, errors.New("the card must be a JSON object")
	}
	scan := json.NewDecoder(bytes.NewReader(raw))
	if err := checkDuplicateKeys(scan); err != nil {
		return BranchCard{}, nil, err
	}
	if _, err := scan.Token(); !errors.Is(err, io.EOF) {
		return BranchCard{}, nil, errors.New("unexpected content after the card")
	}
	var proposal draftProposal
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&proposal); err != nil {
		return BranchCard{}, nil, err
	}
	return proposal.BranchCard, proposal.NoteChanges, nil
}

// DraftNoteContext is what proposals are checked against: the branch they
// come from, the tree's active notes (a supersede must name one) and the
// branch messages a proposal may cite as its source.
type DraftNoteContext struct {
	BranchLineID   string
	ActiveNotes    map[string]bool
	BranchMessages map[string]bool
	Limits         NoteLimits
}

// SanitizeDraftNoteChanges keeps the proposals a merge would accept: at most
// Limits.MaxChangesPerMerge, each a valid add or a supersede of an active
// note, with neutralised text within the limit and not repeating an earlier
// proposal. Every kept proposal's source line is the branch; a source
// message that is not a branch message is cleared. Warnings name what was
// dropped. The result is never nil.
func SanitizeDraftNoteChanges(changes []NoteChange, c DraftNoteContext) ([]NoteChange, []string) {
	limits := c.Limits.orDefault()
	out := []NoteChange{}
	warnings := []string{}
	if len(changes) > limits.MaxChangesPerMerge {
		warnings = append(warnings, fmt.Sprintf("%d proposed note changes were left out (at most %d)", len(changes)-limits.MaxChangesPerMerge, limits.MaxChangesPerMerge))
		changes = changes[:limits.MaxChangesPerMerge]
	}
	seen := map[string]bool{}
	for i, change := range changes {
		kept, problem := draftNoteChange(change, c, limits)
		key := strings.ToLower(kept.Text)
		if problem == "" && seen[key] {
			problem = "repeats an earlier proposal"
		}
		if problem != "" {
			warnings = append(warnings, fmt.Sprintf("proposed note change %d was left out: %s", i+1, problem))
			continue
		}
		seen[key] = true
		out = append(out, kept)
	}
	return out, warnings
}

// draftNoteChange checks one proposal and returns its stored form, or why it
// cannot be kept.
func draftNoteChange(change NoteChange, c DraftNoteContext, limits NoteLimits) (NoteChange, string) {
	normalised, problems := NormaliseNoteChanges([]NoteChange{change}, limits)
	if len(problems) > 0 {
		return NoteChange{}, strings.TrimPrefix(problems[0].Field, "noteChanges[0].") + " " + problems[0].Message
	}
	kept := normalised[0]
	kept.NoteID = strings.TrimSpace(kept.NoteID)
	if kept.Op == NoteOpSupersede && !c.ActiveNotes[kept.NoteID] {
		return NoteChange{}, "it replaces a note that is not an active note of this conversation"
	}
	if kept.Op == NoteOpAdd {
		kept.NoteID = ""
	}
	kept.SourceLineID = c.BranchLineID
	if source := strings.TrimSpace(kept.SourceMessageID); !c.BranchMessages[source] {
		kept.SourceMessageID = ""
	} else {
		kept.SourceMessageID = source
	}
	return kept, ""
}

// draftNotesInstructions asks for proposals (the notes feature on).
const draftNotesInstructions = "- noteChanges (optional): changes to the conversation notes that this branch settled, at most %d. " +
	`Each is {"op":"add","section":"decided|fact|to_confirm|todo","text":""} or {"op":"supersede","noteId":"","text":""} ` +
	"to replace a note listed under \"Current conversation notes\" (copy its id exactly). Propose only what the branch established; " +
	"never repeat a note that already says it. Leave noteChanges out when nothing changes. The operator reviews every proposal.\n\n"

// draftNotesBlock lists the active notes with their ids, newest first,
// within budget tokens (the rest are counted, not shown).
func draftNotesBlock(notes []Note, budget int) string {
	var b strings.Builder
	b.WriteString("## Current conversation notes (quoted data written by the operator)\n\n")
	shown, left := 0, 0
	for _, note := range newestNotesFirst(notes) {
		line := fmt.Sprintf("- note %s (%s): %s\n", branchLine(note.ID), branchLine(note.Section), NeutraliseNoteText(note.Text))
		if EstimatePackTokens(b.String()+line) > budget {
			left++
			continue
		}
		b.WriteString(line)
		shown++
	}
	if shown == 0 && left == 0 {
		b.WriteString("(There are no notes yet.)\n")
	}
	if left > 0 {
		fmt.Fprintf(&b, "(%d older note(s) are not shown.)\n", left)
	}
	return b.String() + "\n"
}

// newestNotesFirst is the active notes, newest first.
func newestNotesFirst(notes []Note) []Note {
	out := make([]Note, 0, len(notes))
	for _, note := range notes {
		if note.Status == NoteStatusActive {
			out = append(out, note)
		}
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].CreatedAt.After(out[j-1].CreatedAt); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
