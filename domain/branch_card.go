package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

// The conclusion card: what a branch brings back to the line it grew from. A
// card is drafted by a tool-free one-shot run, edited and confirmed by the
// operator, and only then written into the parent. Every piece of text in it
// is untrusted data (it descends from branch messages and from files a model
// read), so it is neutralised the same way the branch pack is before it is
// stored, rendered or put into a prompt.

// Limits of the conclusion card and its draft. They define the card format
// (what a stored card may hold), so they are constants, not Limits.
const (
	// BranchCardFieldMaxRunes caps every free-text field of a card.
	BranchCardFieldMaxRunes = 2000
	// BranchCardTotalMaxRunes caps all text of one card together.
	BranchCardTotalMaxRunes = 12000
	// BranchCardMaxEvidence caps the evidence pointers.
	BranchCardMaxEvidence = 12
	// BranchCardMaxOpenItems caps the "still unresolved" list.
	BranchCardMaxOpenItems = 10
	// BranchCardMaxNeedsDecision caps the "needs your decision" list.
	BranchCardMaxNeedsDecision = 8
	// BranchCardMaxExcerpts caps the attached verbatim excerpts.
	BranchCardMaxExcerpts = 3
	// BranchCardExcerptMaxRunes caps one excerpt.
	BranchCardExcerptMaxRunes = 1500
	// BranchCardMaxReferences is the most messages one card may make the store
	// look up: every evidence, excerpt and decision pointer, ids counted once.
	BranchCardMaxReferences = BranchCardMaxEvidence + BranchCardMaxExcerpts + BranchCardMaxNeedsDecision
	// BranchCardIDMaxRunes caps a message id (a canonical UUID is 36).
	BranchCardIDMaxRunes = 64
	// BranchCardRequestMaxBytes bounds a merge request: the card's total text
	// at its widest JSON escaping, plus its ids.
	BranchCardRequestMaxBytes = 256 << 10
	// BranchConclusionLineMaxRunes caps the one-line conclusion kept on the branch.
	BranchConclusionLineMaxRunes = 160
	// BranchDraftParentSinceMessages is how many main-line messages after the
	// fork the draft sees.
	BranchDraftParentSinceMessages = 30
	// BranchDraftInputTokenBudget bounds the draft prompt (EstimatePackTokens).
	BranchDraftInputTokenBudget = 24000
	// BranchDraftOutputMaxBytes bounds the model output that is parsed.
	BranchDraftOutputMaxBytes = 64 * 1024
)

// BranchCard is the structured conclusion of a branch.
type BranchCard struct {
	Question      string               `json:"question"`
	Conclusion    string               `json:"conclusion"`
	Evidence      []BranchCardEvidence `json:"evidence"`
	Impact        string               `json:"impact"`
	OpenItems     []string             `json:"openItems"`
	NeedsDecision []BranchCardDecision `json:"needsDecision"`
	Excerpts      []BranchCardExcerpt  `json:"excerpts"`
}

// BranchCardEvidence points at a message of the branch (or of its background pack).
type BranchCardEvidence struct {
	MessageID string `json:"messageId"`
	Note      string `json:"note"`
}

// BranchCardDecision is a point where the branch and the main line disagree
// or the operator must choose. Nothing resolves it automatically.
type BranchCardDecision struct {
	BranchClaim   string `json:"branchClaim"`
	MainLineClaim string `json:"mainLineClaim"`
	// MainLineMessageID is a main-line message written after the fork; optional.
	MainLineMessageID string `json:"mainLineMessageId"`
}

// BranchCardExcerpt is a verbatim piece of a branch message (a command, a number).
type BranchCardExcerpt struct {
	MessageID string `json:"messageId"`
	Text      string `json:"text"`
}

// BranchCardProblem names one reason a card is refused.
type BranchCardProblem struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// BranchCardRefs is what a card may point at: the finished messages of the
// branch and of its background pack (id to content), and the referenced
// main-line messages that were written after the fork.
type BranchCardRefs struct {
	Messages          map[string]string
	ParentAfterAnchor map[string]bool
}

// ReferencedIDs lists the message ids a card cites: those that must be
// messages of the branch or its pack, and those that must be main-line
// messages after the fork. Each id is listed once and only when it is a
// canonical UUID (anything else can never name a message). Callers check
// CheckBranchCardShape first and load exactly these before validating.
func (c BranchCard) ReferencedIDs() (branchSide, parentSide []string) {
	seen := map[string]bool{}
	add := func(list *[]string, id string) {
		if id = strings.TrimSpace(id); isCanonicalUUID(id) && !seen[id] {
			seen[id] = true
			*list = append(*list, id)
		}
	}
	for _, evidence := range c.Evidence {
		add(&branchSide, evidence.MessageID)
	}
	for _, excerpt := range c.Excerpts {
		add(&branchSide, excerpt.MessageID)
	}
	for _, decision := range c.NeedsDecision {
		add(&parentSide, decision.MainLineMessageID)
	}
	return branchSide, parentSide
}

func isCanonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}

// cleanedCard returns a copy of card with every text neutralised and every
// collection non-nil. It enforces no limits.
func cleanedCard(card BranchCard) BranchCard {
	out := BranchCard{
		Question: CleanCardText(card.Question), Conclusion: CleanCardText(card.Conclusion), Impact: CleanCardText(card.Impact),
		Evidence: []BranchCardEvidence{}, OpenItems: []string{}, NeedsDecision: []BranchCardDecision{}, Excerpts: []BranchCardExcerpt{},
	}
	for _, evidence := range card.Evidence {
		out.Evidence = append(out.Evidence, BranchCardEvidence{MessageID: strings.TrimSpace(evidence.MessageID), Note: CleanCardText(evidence.Note)})
	}
	for _, item := range card.OpenItems {
		out.OpenItems = append(out.OpenItems, CleanCardText(item))
	}
	for _, decision := range card.NeedsDecision {
		out.NeedsDecision = append(out.NeedsDecision, BranchCardDecision{
			BranchClaim: CleanCardText(decision.BranchClaim), MainLineClaim: CleanCardText(decision.MainLineClaim),
			MainLineMessageID: strings.TrimSpace(decision.MainLineMessageID),
		})
	}
	for _, excerpt := range card.Excerpts {
		out.Excerpts = append(out.Excerpts, BranchCardExcerpt{MessageID: strings.TrimSpace(excerpt.MessageID), Text: excerptText(excerpt.Text)})
	}
	return out
}

func runeCount(text string) int { return utf8.RuneCountInString(text) }

// cardTextRunes is the length of all text of a cleaned card.
func cardTextRunes(card BranchCard) int {
	total := runeCount(card.Question) + runeCount(card.Conclusion) + runeCount(card.Impact)
	for _, evidence := range card.Evidence {
		total += runeCount(evidence.Note)
	}
	for _, item := range card.OpenItems {
		total += runeCount(item)
	}
	for _, decision := range card.NeedsDecision {
		total += runeCount(decision.BranchClaim) + runeCount(decision.MainLineClaim)
	}
	for _, excerpt := range card.Excerpts {
		total += runeCount(excerpt.Text)
	}
	return total
}

// cardProblems collects every violated rule of a cleaned card.
type cardProblems []BranchCardProblem

func (p *cardProblems) add(field, format string, args ...any) {
	*p = append(*p, BranchCardProblem{Field: field, Message: fmt.Sprintf(format, args...)})
}

func (p *cardProblems) text(field, value string, required bool) {
	switch {
	case required && value == "":
		p.add(field, "is required")
	case runeCount(value) > BranchCardFieldMaxRunes:
		p.add(field, "is longer than %d characters", BranchCardFieldMaxRunes)
	}
}

// ValidateBranchCard checks a card the operator confirmed and returns it
// neutralised. Any problem means the card must not be stored: each one names
// the field. Evidence and excerpts must point at real messages of the branch
// or its pack; an excerpt must be a verbatim substring of the message it names.
func ValidateBranchCard(card BranchCard, refs BranchCardRefs) (BranchCard, []BranchCardProblem) {
	card = cleanedCard(card)
	var problems cardProblems
	cardShapeProblems(card, &problems)
	cardReferenceProblems(card, refs, &problems)
	return card, problems
}

// CheckBranchCardShape is the part of validation that needs no lookup: how
// many entries each list has and how long each text and id is. Callers run it
// before loading any message, so a card with thousands of pointers costs no
// query.
func CheckBranchCardShape(card BranchCard) []BranchCardProblem {
	var problems cardProblems
	cardShapeProblems(cleanedCard(card), &problems)
	return problems
}

func cardShapeProblems(card BranchCard, problems *cardProblems) {
	problems.text("question", card.Question, true)
	problems.text("conclusion", card.Conclusion, true)
	problems.text("impact", card.Impact, false)
	problems.count("evidence", len(card.Evidence), BranchCardMaxEvidence)
	problems.count("openItems", len(card.OpenItems), BranchCardMaxOpenItems)
	problems.count("needsDecision", len(card.NeedsDecision), BranchCardMaxNeedsDecision)
	problems.count("excerpts", len(card.Excerpts), BranchCardMaxExcerpts)
	// Entries past a list's cap are not looked at one by one.
	for i, evidence := range firstN(card.Evidence, BranchCardMaxEvidence) {
		field := fmt.Sprintf("evidence[%d]", i)
		problems.id(field+".messageId", evidence.MessageID)
		problems.text(field+".note", evidence.Note, false)
	}
	for i, item := range firstN(card.OpenItems, BranchCardMaxOpenItems) {
		problems.text(fmt.Sprintf("openItems[%d]", i), item, true)
	}
	for i, decision := range firstN(card.NeedsDecision, BranchCardMaxNeedsDecision) {
		field := fmt.Sprintf("needsDecision[%d]", i)
		if decision.BranchClaim == "" && decision.MainLineClaim == "" {
			problems.add(field, "says nothing: give the branch's claim or the main line's")
		}
		problems.text(field+".branchClaim", decision.BranchClaim, false)
		problems.text(field+".mainLineClaim", decision.MainLineClaim, false)
		problems.id(field+".mainLineMessageId", decision.MainLineMessageID)
	}
	for i, excerpt := range firstN(card.Excerpts, BranchCardMaxExcerpts) {
		field := fmt.Sprintf("excerpts[%d]", i)
		problems.id(field+".messageId", excerpt.MessageID)
		switch {
		case excerpt.Text == "":
			problems.add(field+".text", "is required")
		case runeCount(excerpt.Text) > BranchCardExcerptMaxRunes:
			problems.add(field+".text", "is longer than %d characters", BranchCardExcerptMaxRunes)
		}
	}
	if total := cardTextRunes(card); total > BranchCardTotalMaxRunes {
		problems.add("card", "is %d characters long; the limit for all text together is %d", total, BranchCardTotalMaxRunes)
	}
}

func firstN[T any](items []T, limit int) []T {
	if len(items) > limit {
		return items[:limit]
	}
	return items
}

func (p *cardProblems) count(field string, have, most int) {
	if have > most {
		p.add(field, "has %d entries; at most %d", have, most)
	}
}

func (p *cardProblems) id(field, value string) {
	if runeCount(value) > BranchCardIDMaxRunes {
		p.add(field, "is longer than %d characters", BranchCardIDMaxRunes)
	}
}

// excerptText prepares a pasted excerpt for comparison with its message:
// CRLF counts as LF and surrounding whitespace is dropped. Nothing else is
// changed, so what the card shows is what the message says.
func excerptText(text string) string {
	return strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n"))
}

// excerptProblem says why text cannot stand as a verbatim excerpt of content,
// or "" when it can. Cards never keep protocol markers, fences or control
// characters, so an excerpt that would be changed by that cleaning is refused
// instead of being shown differently from the message.
func excerptProblem(text, content string) string {
	if CleanCardText(text) != text {
		return "contains protocol markers, code fences or control characters, which a card does not keep; it cannot be shown as a verbatim part of the message"
	}
	if !strings.Contains(strings.ReplaceAll(content, "\r\n", "\n"), text) {
		return "is not a verbatim part of that message"
	}
	return ""
}

// cardReferenceProblems checks what needs the messages a card cites.
func cardReferenceProblems(card BranchCard, refs BranchCardRefs, problems *cardProblems) {
	seenEvidence := map[string]bool{}
	for i, evidence := range card.Evidence {
		field := fmt.Sprintf("evidence[%d]", i)
		if _, known := refs.Messages[evidence.MessageID]; !isCanonicalUUID(evidence.MessageID) || !known {
			problems.add(field+".messageId", "is not a message of this branch or its background")
		} else if seenEvidence[evidence.MessageID] {
			problems.add(field, "repeats an earlier entry")
		}
		seenEvidence[evidence.MessageID] = true
	}
	for i, decision := range card.NeedsDecision {
		if decision.MainLineMessageID != "" && !refs.ParentAfterAnchor[decision.MainLineMessageID] {
			problems.add(fmt.Sprintf("needsDecision[%d].mainLineMessageId", i), "is not a main-line message written after the fork")
		}
	}
	seen := map[string]bool{}
	for i, excerpt := range card.Excerpts {
		field := fmt.Sprintf("excerpts[%d]", i)
		content, known := refs.Messages[excerpt.MessageID]
		if !isCanonicalUUID(excerpt.MessageID) || !known {
			problems.add(field+".messageId", "is not a message of this branch or its background")
		} else if excerpt.Text != "" {
			if reason := excerptProblem(excerpt.Text, content); reason != "" {
				problems.add(field+".text", "%s", reason)
			}
		}
		key := excerpt.MessageID + "\x00" + excerpt.Text
		if seen[key] {
			problems.add(field, "repeats an earlier entry")
		}
		seen[key] = true
	}
}

// SanitizeBranchDraft repairs what a model drafted instead of refusing it:
// unverifiable evidence and excerpts are dropped, over-long text and lists
// are cut, and every repair is reported. It reports ok=false when nothing
// usable is left (no question or conclusion, or still too long overall).
func SanitizeBranchDraft(draft BranchCard, refs BranchCardRefs) (BranchCard, []string, bool) {
	card := cleanedCard(draft)
	var warnings []string
	warn := func(format string, args ...any) { warnings = append(warnings, fmt.Sprintf(format, args...)) }
	cut := func(field string, value *string, limit int) {
		if runeCount(*value) > limit {
			*value = string([]rune(*value)[:limit])
			warn("%s was cut to %d characters", field, limit)
		}
	}
	cut("question", &card.Question, BranchCardFieldMaxRunes)
	cut("conclusion", &card.Conclusion, BranchCardFieldMaxRunes)
	cut("impact", &card.Impact, BranchCardFieldMaxRunes)
	if card.Question == "" || card.Conclusion == "" {
		return BranchCard{}, warnings, false
	}
	card.Evidence = repairEvidence(card.Evidence, refs, cut, warn)
	card.OpenItems = repairOpenItems(card.OpenItems, cut, warn)
	card.NeedsDecision = repairDecisions(card.NeedsDecision, refs, cut, warn)
	card.Excerpts = repairExcerpts(card.Excerpts, refs, cut, warn)
	if total := cardTextRunes(card); total > BranchCardTotalMaxRunes {
		warn("the draft is %d characters long, over the limit of %d", total, BranchCardTotalMaxRunes)
		return BranchCard{}, warnings, false
	}
	return card, warnings, true
}

type (
	cutFunc  func(field string, value *string, limit int)
	warnFunc func(format string, args ...any)
)

func repairEvidence(in []BranchCardEvidence, refs BranchCardRefs, cut cutFunc, warn warnFunc) []BranchCardEvidence {
	out := []BranchCardEvidence{}
	seen := map[string]bool{}
	for _, evidence := range in {
		if _, known := refs.Messages[evidence.MessageID]; !isCanonicalUUID(evidence.MessageID) || !known || seen[evidence.MessageID] {
			warn("evidence pointing at an unknown or repeated message was dropped")
			continue
		}
		if len(out) >= BranchCardMaxEvidence {
			warn("evidence was cut to %d entries", BranchCardMaxEvidence)
			break
		}
		seen[evidence.MessageID] = true
		cut("evidence note", &evidence.Note, BranchCardFieldMaxRunes)
		out = append(out, evidence)
	}
	return out
}

func repairOpenItems(in []string, cut cutFunc, warn warnFunc) []string {
	out := []string{}
	for _, item := range in {
		if item == "" {
			continue
		}
		if len(out) >= BranchCardMaxOpenItems {
			warn("open items were cut to %d entries", BranchCardMaxOpenItems)
			break
		}
		cut("open item", &item, BranchCardFieldMaxRunes)
		out = append(out, item)
	}
	return out
}

func repairDecisions(in []BranchCardDecision, refs BranchCardRefs, cut cutFunc, warn warnFunc) []BranchCardDecision {
	out := []BranchCardDecision{}
	for _, decision := range in {
		if decision.BranchClaim == "" && decision.MainLineClaim == "" {
			warn("a decision item with no claim was dropped")
			continue
		}
		if len(out) >= BranchCardMaxNeedsDecision {
			warn("decision items were cut to %d entries", BranchCardMaxNeedsDecision)
			break
		}
		if decision.MainLineMessageID != "" && !refs.ParentAfterAnchor[decision.MainLineMessageID] {
			warn("a main-line message id that is not after the fork was removed from a decision item")
			decision.MainLineMessageID = ""
		}
		cut("decision branch claim", &decision.BranchClaim, BranchCardFieldMaxRunes)
		cut("decision main-line claim", &decision.MainLineClaim, BranchCardFieldMaxRunes)
		out = append(out, decision)
	}
	return out
}

func repairExcerpts(in []BranchCardExcerpt, refs BranchCardRefs, cut cutFunc, warn warnFunc) []BranchCardExcerpt {
	out := []BranchCardExcerpt{}
	seen := map[string]bool{}
	for _, excerpt := range in {
		content, known := refs.Messages[excerpt.MessageID]
		key := excerpt.MessageID + "\x00" + excerpt.Text
		if !isCanonicalUUID(excerpt.MessageID) || !known || excerpt.Text == "" || seen[key] || excerptProblem(excerpt.Text, content) != "" {
			warn("an excerpt that is not verbatim text of a known message was dropped")
			continue
		}
		if len(out) >= BranchCardMaxExcerpts {
			warn("excerpts were cut to %d entries", BranchCardMaxExcerpts)
			break
		}
		seen[key] = true
		// A prefix of verbatim text is still verbatim.
		cut("excerpt", &excerpt.Text, BranchCardExcerptMaxRunes)
		out = append(out, excerpt)
	}
	return out
}

// checkDuplicateKeys walks one JSON value and fails on an object that names
// the same field twice (compared case-insensitively, as encoding/json binds).
func checkDuplicateKeys(dec *json.Decoder) error {
	token, err := dec.Token()
	if err != nil {
		return err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return nil
	}
	seen := map[string]bool{}
	for dec.More() {
		if delim == '{' {
			keyToken, err := dec.Token()
			if err != nil {
				return err
			}
			key := strings.ToLower(fmt.Sprint(keyToken))
			if seen[key] {
				return fmt.Errorf("field %q appears twice", key)
			}
			seen[key] = true
		}
		if err := checkDuplicateKeys(dec); err != nil {
			return err
		}
	}
	_, err = dec.Token()
	return err
}

// DecodeBranchCardJSON strictly decodes one card: a single JSON object, no
// duplicate or unknown field, nothing after it.
func DecodeBranchCardJSON(raw []byte) (BranchCard, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' {
		return BranchCard{}, errors.New("the card must be a JSON object")
	}
	scan := json.NewDecoder(bytes.NewReader(raw))
	if err := checkDuplicateKeys(scan); err != nil {
		return BranchCard{}, err
	}
	if _, err := scan.Token(); !errors.Is(err, io.EOF) {
		return BranchCard{}, errors.New("unexpected content after the card")
	}
	var card BranchCard
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&card); err != nil {
		return BranchCard{}, err
	}
	return card, nil
}

// ParseBranchDraft extracts the card from a drafting model's output: exactly
// one [BRANCH-CARD] marker followed by exactly one JSON object. Text before
// the marker is ignored; anything after the object, a second marker, a code
// fence, unknown or duplicate fields or oversized output fail the whole draft.
func ParseBranchDraft(output string) (BranchCard, error) {
	if len(output) > BranchDraftOutputMaxBytes {
		return BranchCard{}, fmt.Errorf("the draft is larger than %d bytes", BranchDraftOutputMaxBytes)
	}
	if strings.Count(output, BranchCardMarker) != 1 {
		return BranchCard{}, errors.New("the draft must contain the card marker exactly once")
	}
	rest := output[strings.Index(output, BranchCardMarker)+len(BranchCardMarker):]
	return DecodeBranchCardJSON([]byte(rest))
}
