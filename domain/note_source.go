package domain

import (
	"strconv"
	"strings"
)

// A note's source label: a text snapshot of where the note came from,
// written with the note, so the source still reads when its line is gone
// (an aside purged after seven days). It follows the client's rules
// (web note-source.ts): a main-line message "主線 #n", the main line
// "主線", a conclusion card "結論卡・purpose", a branch "kind・purpose"; a
// previous main line is titled by its label instead of its purpose.

// NoteSourceLabels are the label templates; {n}, {kind} and {title} are
// replaced. Empty fields take the default (Traditional Chinese) ones.
type NoteSourceLabels struct {
	MainMessage      string
	MainLine         string
	Card             string
	Branch           string
	PreviousMainLine string
	Kinds            map[string]string
}

// DefaultNoteSourceLabels are the Traditional Chinese labels of the product.
func DefaultNoteSourceLabels() NoteSourceLabels {
	return NoteSourceLabels{
		MainMessage: "主線 #{n}", MainLine: "主線", Card: "結論卡・{title}", Branch: "{kind}・{title}", PreviousMainLine: "原本的主線",
		Kinds: map[string]string{BranchKindAside: "順口問", BranchKindInvestigate: "查證", BranchKindAlternative: "另一條路"},
	}
}

// EnglishNoteSourceLabels are the English labels of the reference UI.
func EnglishNoteSourceLabels() NoteSourceLabels {
	return NoteSourceLabels{
		MainMessage: "Main line #{n}", MainLine: "Main line", Card: "Conclusion card · {title}", Branch: "{kind} · {title}",
		PreviousMainLine: "Previous main line",
		Kinds:            map[string]string{BranchKindAside: "Aside", BranchKindInvestigate: "Investigate", BranchKindAlternative: "Alternative"},
	}
}

// NoteSourceFacts is what is known about a note's source when it is written.
type NoteSourceFacts struct {
	// HasLine: the note has a source line (otherwise it has no label).
	HasLine bool
	// OnRoot: the source line is the main line; MainNumber is the 1-based
	// place of the source message among the main line's chat messages (0
	// when there is no such message).
	OnRoot     bool
	MainNumber int
	// Card: the note came with a conclusion card of the source branch.
	Card bool
	// The source branch.
	BranchKind    string
	BranchPurpose string
	BranchOrigin  string
}

// Render is the label of a source; "" when the note has none.
func (l NoteSourceLabels) Render(f NoteSourceFacts) string {
	l = l.orDefault()
	switch {
	case !f.HasLine:
		return ""
	case f.OnRoot && !f.Card && f.MainNumber > 0:
		return strings.ReplaceAll(l.MainMessage, "{n}", strconv.Itoa(f.MainNumber))
	case f.OnRoot && !f.Card:
		return l.MainLine
	}
	title := FlattenUntrusted(f.BranchPurpose)
	if f.BranchOrigin == BranchOriginPreviousMainLine {
		title = l.PreviousMainLine
	}
	if f.Card {
		return strings.ReplaceAll(l.Card, "{title}", title)
	}
	kind := l.Kinds[f.BranchKind]
	if kind == "" {
		kind = f.BranchKind
	}
	return strings.NewReplacer("{kind}", kind, "{title}", title).Replace(l.Branch)
}

func (l NoteSourceLabels) orDefault() NoteSourceLabels {
	d := DefaultNoteSourceLabels()
	pick := func(v, def string) string {
		if strings.TrimSpace(v) == "" {
			return def
		}
		return v
	}
	out := NoteSourceLabels{
		MainMessage: pick(l.MainMessage, d.MainMessage), MainLine: pick(l.MainLine, d.MainLine), Card: pick(l.Card, d.Card),
		Branch: pick(l.Branch, d.Branch), PreviousMainLine: pick(l.PreviousMainLine, d.PreviousMainLine), Kinds: map[string]string{},
	}
	for kind, label := range d.Kinds {
		out.Kinds[kind] = pick(l.Kinds[kind], label)
	}
	return out
}
