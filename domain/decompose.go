package domain

import (
	"sort"
	"strings"
	"time"
)

// Decomposing a long conversation (B18): GET /lines/{id}/decompose proposes,
// without a model, how to organise a line — tags, chapter cuts, detours to
// extract into branches, open items to park and related conversations. The
// plan is pure and deterministic; every heuristic is a fixed rule on the
// words of the messages (decompose_text.go).

// Bounds of a decompose plan.
const (
	// DecomposeMaxMessages caps the messages read (the oldest of the line).
	DecomposeMaxMessages = 2000
	// DecomposeMaxTags, DecomposeMaxCuts, DecomposeMaxDetours,
	// DecomposeMaxSeeds and DecomposeMaxRelated cap each list.
	DecomposeMaxTags    = 5
	DecomposeMaxCuts    = 8
	DecomposeMaxDetours = 8
	DecomposeMaxSeeds   = 8
	DecomposeMaxRelated = 5
	// DecomposeTimeGap is the pause before an operator message that
	// suggests a chapter cut.
	DecomposeTimeGap = 30 * time.Minute
	// decomposeShiftWindow is the messages compared on each side of a
	// possible topic shift; decomposeShiftEvery the messages that must pass
	// since the last cut before one is looked for (six rounds).
	decomposeShiftWindow = 6
	decomposeShiftEvery  = 12
	// decomposeShiftOverlap: windows sharing less than this are a shift.
	decomposeShiftOverlap = 0.15
	// decomposeDetourMaxRounds caps a detour (four question-answer rounds).
	decomposeDetourMaxRounds = 4
	// decomposeTitleRunes and decomposeTextRunes cap the texts the plan
	// makes up from messages.
	decomposeTitleRunes = 40
	decomposeTextRunes  = 200
)

// Reasons of a suggested chapter cut.
const (
	DecomposeReasonTopicShift = "topic_shift"
	DecomposeReasonTimeGap    = "time_gap"
)

// Reasons of a seed candidate.
const (
	DecomposeSeedQuestion = "question"
	DecomposeSeedOpenItem = "open_item"
)

// DecomposeInput is what a plan is made from. Messages are the line's
// messages (any order; at most DecomposeMaxMessages are read, oldest
// first). CutMessageIDs are the messages that already hold a chapter cut.
// Tags are the conversation's own (never suggested again). TenantTags are
// the tags the tenant's conversations use (suggested as they are, never
// joined or dropped as fragments). Related are the related conversations
// the store found.
type DecomposeInput struct {
	LineID        string
	Title         string
	Messages      []Message
	CutMessageIDs map[string]bool
	Tags          []string
	TenantTags    []string
	Related       []RelatedLine
	Truncated     bool
}

// DecomposePlan is the answer of GET /lines/{id}/decompose.
type DecomposePlan struct {
	LineID         string                 `json:"lineId"`
	SuggestedTags  []string               `json:"suggestedTags"`
	ChapterCuts    []ChapterCutSuggestion `json:"chapterCuts"`
	DetourRanges   []DetourRange          `json:"detourRanges"`
	SeedCandidates []SeedCandidate        `json:"seedCandidates"`
	RelatedLines   []RelatedLine          `json:"relatedLines"`
	// Truncated is true when the line has more messages than were read.
	Truncated bool `json:"truncated"`
}

// ChapterCutSuggestion is a proposed chapter start on an operator message.
type ChapterCutSuggestion struct {
	MessageID string `json:"messageId"`
	Seq       int64  `json:"seq"`
	Title     string `json:"title"`
	Reason    string `json:"reason"`
}

// DetourRange is a stretch that could be extracted into a branch
// (POST /lines/{id}/branches/extract).
type DetourRange struct {
	FromMessageID       string `json:"fromMessageId"`
	ToMessageID         string `json:"toMessageId"`
	AnchorMessageID     string `json:"anchorMessageId"`
	MessageCount        int    `json:"messageCount"`
	Purpose             string `json:"purpose"`
	SuggestedConclusion string `json:"suggestedConclusion"`
}

// SeedCandidate is an open item or a closing question of a reply that
// could be parked.
type SeedCandidate struct {
	MessageID string `json:"messageId"`
	Text      string `json:"text"`
	Reason    string `json:"reason"`
}

// RelatedLine is another conversation of the tenant sharing a tag or the
// folder.
type RelatedLine struct {
	LineID     string   `json:"lineId"`
	Title      string   `json:"title"`
	Folder     string   `json:"folder"`
	SharedTags []string `json:"sharedTags"`
}

// BuildDecomposePlan makes the plan. Every list is non-nil and capped.
func BuildDecomposePlan(in DecomposeInput) DecomposePlan {
	messages := SortBySeq(in.Messages)
	if len(messages) > DecomposeMaxMessages {
		messages, in.Truncated = messages[:DecomposeMaxMessages], true
	}
	scan := newDecomposeScan(messages)
	scan.truncated = in.Truncated
	related := in.Related
	if related == nil {
		related = []RelatedLine{}
	}
	if len(related) > DecomposeMaxRelated {
		related = related[:DecomposeMaxRelated]
	}
	return DecomposePlan{
		LineID:         in.LineID,
		SuggestedTags:  scan.suggestTags(in.Title, in.Tags, in.TenantTags),
		ChapterCuts:    scan.suggestCuts(in.CutMessageIDs),
		DetourRanges:   scan.suggestDetours(in.Title),
		SeedCandidates: scan.suggestSeeds(),
		RelatedLines:   related,
		Truncated:      in.Truncated,
	}
}

// decomposeScan is the line's messages with their terms, computed once.
type decomposeScan struct {
	messages []Message
	terms    []map[string]bool
	// truncated: the line goes on after messages, so their end is not the
	// line's end.
	truncated bool
}

func newDecomposeScan(messages []Message) decomposeScan {
	scan := decomposeScan{messages: messages, terms: make([]map[string]bool, len(messages))}
	for i, message := range messages {
		if isConversation(message) {
			scan.terms[i] = topicTerms(message.Content)
		} else {
			scan.terms[i] = map[string]bool{}
		}
	}
	return scan
}

// isConversation is a finished operator or assistant chat message.
func isConversation(m Message) bool { return ExtractableMessage(m.Role, m.Kind, m.Status) }

func (s decomposeScan) isUser(i int) bool {
	return i >= 0 && i < len(s.messages) && isConversation(s.messages[i]) && s.messages[i].Role == RoleUser
}

// suggestTags: the terms found in at least two of the title and the
// first three rounds' messages, the title's counting three times in the
// ranking (first seen on a tie), normalised like tags, not already a tag,
// then cleaned (cleanSuggestedTags: Han pairs joined back into words,
// fragments dropped) and capped.
func (s decomposeScan) suggestTags(title string, existing, tenantTags []string) []string {
	score := map[string]int{}
	sources := map[string]int{}
	order := []string{}
	count := func(terms []string, weight int) {
		for _, term := range terms {
			if _, seen := score[term]; !seen {
				order = append(order, term)
			}
			score[term] += weight
			sources[term]++
		}
	}
	count(orderedTerms(title), 3)
	for i := 0; i < len(s.messages) && i < 6; i++ {
		if isConversation(s.messages[i]) {
			count(orderedTerms(s.messages[i].Content), 1)
		}
	}
	have := map[string]bool{}
	for _, tag := range existing {
		have[NormalizeTag(tag)] = true
	}
	candidates := make([]string, 0, len(order))
	for _, term := range order {
		if tag := NormalizeTag(term); sources[term] >= 2 && tag != "" && !have[tag] && len([]rune(tag)) <= TagMaxRunes {
			candidates = append(candidates, term)
		}
	}
	sort.SliceStable(candidates, func(a, b int) bool { return score[candidates[a]] > score[candidates[b]] })
	ranked := make([]string, 0, len(candidates))
	for _, term := range candidates {
		ranked = append(ranked, NormalizeTag(term))
	}
	used := map[string]bool{}
	for _, tag := range tenantTags {
		used[NormalizeTag(tag)] = true
	}
	return cleanSuggestedTags(ranked, title, used, have, DecomposeMaxTags)
}

// cleanSuggestedTags turns ranked terms into tags worth showing, in rank
// order (a joined word takes its first term's place), without repeats, own
// tags or tags longer than TagMaxRunes, at most limit:
//   - terms with an ASCII letter or digit, terms that are not all Han, and
//     tags the tenant already uses are kept as they are;
//   - Han terms inside one of the title's topic words (titleTopicWords) are
//     joined into the stretches of that word they cover ("微分" + "分幾" +
//     "幾何" in "微分幾何" give "微分幾何"), a tag the tenant uses taking
//     part too (it is still kept on its own);
//   - any other Han term that starts or ends with a function character
//     ("何在") is dropped, and the rest are joined while they chain in the
//     list (a pair whose first character is the last one so far), up to
//     chainedTagMaxRunes.
//
// What is dropped (fragments, own tags, too long) leaves the list before
// anything chains, so cleaning the result again changes nothing. Terms are
// normalised like tags first (as the client does with the server's list).
// It is the web client's filterSuggestedTags (suggested-tags.ts).
func cleanSuggestedTags(ranked []string, title string, used, own map[string]bool, limit int) []string {
	words := titleTopicWords(title)
	tags := candidateTags(ranked, words, used, own)
	out := []string{}
	seen := map[string]bool{}
	add := func(tag string) {
		if tag != "" && !seen[tag] && !own[tag] && len([]rune(tag)) <= TagMaxRunes {
			seen[tag] = true
			out = append(out, tag)
		}
	}
	handled := map[string]bool{}
	for i := 0; i < len(tags) && len(out) < limit; i++ {
		tag := tags[i]
		if handled[tag] {
			continue
		}
		if used[tag] || hasASCIIWord(tag) || !hanOnly(tag) {
			add(tag)
			continue
		}
		if word, ok := wordContaining(words, tag); ok {
			for _, joined := range joinWordTerms(word, tags, used, handled) {
				add(joined)
			}
			continue
		}
		add(chainFrom(tags, i, handled))
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// candidateTags normalises the ranked terms and drops, before anything
// chains, repeats, own tags, tags longer than TagMaxRunes and fragments
// (isFragment), keeping the rank order.
func candidateTags(ranked, words []string, used, own map[string]bool) []string {
	tags := make([]string, 0, len(ranked))
	seenTerm := map[string]bool{}
	for _, term := range ranked {
		tag := NormalizeTag(term)
		if tag == "" || seenTerm[tag] || own[tag] || len([]rune(tag)) > TagMaxRunes || isFragment(tag, words, used) {
			continue
		}
		seenTerm[tag] = true
		tags = append(tags, tag)
	}
	return tags
}

// joinWordTerms joins every Han term of tags inside the title topic word
// into the stretches of the word they cover, and marks the joined terms
// handled. A tag the tenant uses joins too, so the word is never cut short
// ("微分" + "分幾" with a used "幾何" must not give "微分幾"), but it is not
// marked handled: it is still kept on its own as well (B19).
func joinWordTerms(word string, tags []string, used, handled map[string]bool) []string {
	inWord := []string{}
	for _, other := range tags {
		if hanOnly(other) && strings.Contains(word, other) {
			inWord = append(inWord, other)
			handled[other] = handled[other] || !used[other]
		}
	}
	return joinInWord(word, inWord)
}

// isFragment: a Han term, not a tag the tenant uses and in no title topic
// word, that starts or ends with a function character ("何在").
func isFragment(term string, words []string, used map[string]bool) bool {
	if used[term] || hasASCIIWord(term) || !hanOnly(term) {
		return false
	}
	if _, ok := wordContaining(words, term); ok {
		return false
	}
	return touchesFunction(term)
}

// wordContaining is the first title topic word that contains term.
func wordContaining(words []string, term string) (string, bool) {
	for _, word := range words {
		if strings.Contains(word, term) {
			return word, true
		}
	}
	return "", false
}

// chainFrom joins tags[i] with the Han pairs right after it while each
// starts with the last character so far (微分 分幾 幾何 → 微分幾何), at most
// chainedTagMaxRunes; the pairs it takes are marked handled.
func chainFrom(tags []string, i int, handled map[string]bool) string {
	joined := []rune(tags[i])
	for j := i + 1; j < len(tags); j++ {
		next := []rune(tags[j])
		if !hanOnly(tags[j]) || handled[tags[j]] || len(next) != 2 ||
			joined[len(joined)-1] != next[0] || len(joined)+1 > chainedTagMaxRunes {
			break
		}
		joined = append(joined, next[1])
		handled[tags[j]] = true
	}
	return string(joined)
}

// suggestCuts proposes chapter starts on operator messages (never the
// first one, never one that already holds a cut): after a pause of at
// least DecomposeTimeGap, on a shift cue, or where the words of the next
// rounds share little with the previous ones (looked for once at least six
// rounds passed since the last cut).
func (s decomposeScan) suggestCuts(cut map[string]bool) []ChapterCutSuggestion {
	out := []ChapterCutSuggestion{}
	since := 0
	for i, message := range s.messages {
		since++
		if cut[message.ID] {
			since = 0
		}
		if i == 0 || !s.isUser(i) || cut[message.ID] {
			continue
		}
		reason := s.cutReason(i, since)
		if reason == "" {
			continue
		}
		out = append(out, ChapterCutSuggestion{MessageID: message.ID, Seq: message.Seq, Title: CutRunes(FlattenUntrusted(message.Content), decomposeTitleRunes), Reason: reason})
		since = 0
		if len(out) == DecomposeMaxCuts {
			break
		}
	}
	return out
}

func (s decomposeScan) cutReason(i, since int) string {
	message := s.messages[i]
	if gap := message.CreatedAt.Sub(s.messages[i-1].CreatedAt); gap >= DecomposeTimeGap {
		return DecomposeReasonTimeGap
	}
	if startsWithCue(message.Content, shiftCues) {
		return DecomposeReasonTopicShift
	}
	if since < decomposeShiftEvery || i < decomposeShiftWindow || i+decomposeShiftWindow > len(s.messages) {
		return ""
	}
	before, after := s.window(i-decomposeShiftWindow, i), s.window(i, i+decomposeShiftWindow)
	if len(before) >= 5 && len(after) >= 5 && overlap(before, after) < decomposeShiftOverlap {
		return DecomposeReasonTopicShift
	}
	return ""
}

// window is the union of the terms of messages [from, to).
func (s decomposeScan) window(from, to int) map[string]bool {
	out := map[string]bool{}
	for i := max(from, 0); i < to && i < len(s.messages); i++ {
		for term := range s.terms[i] {
			out[term] = true
		}
	}
	return out
}

// suggestDetours proposes stretches of one to four rounds that wander off
// the conversation's topic (the title and its first round): one that opens
// with a question about an error or a short "what is", or that shares no
// word with the topic, and is followed by an operator message back on the
// topic (an error or "what is" stretch may also end the line). Only
// finished operator / assistant messages qualify, starting with an operator
// message, ending with a reply, with a message to hang the branch on before.
func (s decomposeScan) suggestDetours(title string) []DetourRange {
	out := []DetourRange{}
	topic := s.topic(title)
	for i := 2; i < len(s.messages) && len(out) < DecomposeMaxDetours; i++ {
		if !s.isUser(i) {
			continue
		}
		cued := s.detourCue(i)
		if !cued && (len(s.terms[i]) == 0 || overlap(s.terms[i], topic) > 0) {
			continue
		}
		end, ok := s.detourEnd(i, topic, cued)
		if !ok {
			continue
		}
		anchor := s.anchorBefore(i)
		if anchor < 0 {
			continue
		}
		out = append(out, s.detour(i, end, anchor))
		i = end
	}
	return out
}

// topic is the conversation's topic words: its title and its first round.
func (s decomposeScan) topic(title string) map[string]bool {
	topic := topicTerms(title)
	for i := 0; i < len(s.messages) && i < 2; i++ {
		for term := range s.terms[i] {
			topic[term] = true
		}
	}
	return topic
}

// detourCue: a question about an error, or a short "what is" question.
func (s decomposeScan) detourCue(i int) bool {
	content := s.messages[i].Content
	return containsCue(content, errorCues) || (len([]rune(content)) <= 80 && containsCue(content, definitionCues))
}

// detourEnd is the last message of the detour that starts at i: whole
// rounds while the next operator message is still off the topic, at most
// decomposeDetourMaxRounds; ok is false when it does not end with a reply
// or does not come back to the topic (a cued detour may end the line).
func (s decomposeScan) detourEnd(start int, topic map[string]bool, cued bool) (int, bool) {
	end := -1
	for round := 0; round < decomposeDetourMaxRounds; round++ {
		user, reply := start+2*round, start+2*round+1
		if !s.isUser(user) || reply >= len(s.messages) || !isConversation(s.messages[reply]) || s.messages[reply].Role != RoleAssistant {
			break
		}
		end = reply
		next := reply + 1
		if next >= len(s.messages) {
			return end, cued && !s.truncated
		}
		if !s.isUser(next) {
			return -1, false
		}
		if overlap(s.terms[next], topic) > 0 {
			return end, true
		}
	}
	return -1, false
}

// anchorBefore is the newest message before i a branch may hang on (-1
// when none).
func (s decomposeScan) anchorBefore(i int) int {
	for j := i - 1; j >= 0; j-- {
		m := s.messages[j]
		if CanAnchorBranch(m.Role, m.Kind, m.Status) {
			return j
		}
	}
	return -1
}

func (s decomposeScan) detour(start, end, anchor int) DetourRange {
	first := s.messages[start]
	subject := CutRunes(FlattenUntrusted(first.Content), decomposeTitleRunes)
	purpose := "Look into: " + subject
	if hasHan(first.Content) {
		purpose = "了解：" + subject
	}
	return DetourRange{
		FromMessageID: first.ID, ToMessageID: s.messages[end].ID, AnchorMessageID: s.messages[anchor].ID,
		MessageCount: end - start + 1, Purpose: purpose, SuggestedConclusion: firstSentence(s.messages[end].Content, decomposeTextRunes),
	}
}

// suggestSeeds proposes, newest replies first, a reply's closing question
// and its list items that are questions or carry an open-item cue; each
// text once, at most DecomposeMaxSeeds, returned in seq order.
func (s decomposeScan) suggestSeeds() []SeedCandidate {
	out := []SeedCandidate{}
	seen := map[string]bool{}
	add := func(message Message, text, reason string) {
		text = strings.TrimSpace(text)
		if text == "" || seen[text] || len(out) == DecomposeMaxSeeds {
			return
		}
		seen[text] = true
		out = append(out, SeedCandidate{MessageID: message.ID, Text: text, Reason: reason})
	}
	for i := len(s.messages) - 1; i >= 0 && len(out) < DecomposeMaxSeeds; i-- {
		message := s.messages[i]
		if !isConversation(message) || message.Role != RoleAssistant {
			continue
		}
		for _, item := range listItems(message.Content) {
			if strings.HasSuffix(item, "?") || strings.HasSuffix(item, "？") || containsCue(item, openItemCues) {
				add(message, CutRunes(FlattenUntrusted(item), decomposeTextRunes), DecomposeSeedOpenItem)
			}
		}
		add(message, lastQuestion(message.Content, decomposeTextRunes), DecomposeSeedQuestion)
	}
	position := make(map[string]int, len(s.messages))
	for i, message := range s.messages {
		position[message.ID] = i
	}
	sort.SliceStable(out, func(a, b int) bool { return position[out[a].MessageID] < position[out[b].MessageID] })
	return out
}
