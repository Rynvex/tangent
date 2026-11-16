package domain

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// Inline title markers. A turn's prompt may ask the model to end its reply
// with one line
//
//	[TOPIC]{"title":"..."}     the line's first turn: a short topic summary
//	[CHAPTER]{"title":"..."}   a main-line turn that opened a new stage
//
// The library always removes those lines from the stored reply (the stream
// filter hides them too); it uses the title only when the turn's prompt
// asked for it. No extra model call is made.

const (
	// TopicMarker starts the topic summary line of a line's first reply.
	TopicMarker = "[TOPIC]"
	// ChapterCutMarker starts the line that opens a new main-line chapter.
	ChapterCutMarker = "[CHAPTER]"
)

const (
	// TopicSummaryMaxRunes caps a topic summary title.
	TopicSummaryMaxRunes = 36
	// topicMainMinRunes: a main line's first message longer than this asks
	// for a topic summary.
	topicMainMinRunes = 20
	// topicPurposeMinRunes: a branch purpose longer than this asks for one.
	topicPurposeMinRunes = 25
	// ChapterCutMinMessages is how many finished messages (cards not
	// counted) the current chapter needs before the model may cut a new one.
	ChapterCutMinMessages = 4
	// titleLineMaxBytes bounds the JSON of one marker line.
	titleLineMaxBytes = 2000
)

// SectionReplyLines is the prompt section that carries the [TOPIC] and
// [CHAPTER] rules. It changes from turn to turn, so it sits among the
// trailing (uncached) sections, and a resumed session gets it too.
const SectionReplyLines = "reply_lines"

// TopicSummaryRule asks for the [TOPIC] line.
const TopicSummaryRule = "- End your reply with one line " + TopicMarker + `{"title":"a concise 6-18 character topic summary in the operator's language"}` +
	" summarizing the core subject of the operator's question.\n"

// ChapterCutRule allows the [CHAPTER] line.
const ChapterCutRule = "- Only when the operator's new message clearly shifts the main conversation to a new sub-topic or stage, end your reply with one line " +
	ChapterCutMarker + `{"title":"short stage title (4-15 chars in the operator's language)"}` + ". Do not output it if the topic continues.\n"

// BuildReplyLinesBlock renders the rules the prompt input asks for ("" when
// none: the chapter rule only on a main line).
func BuildReplyLinesBlock(in PromptInput) string {
	rules := ""
	if in.RequestTopicSummary {
		rules += TopicSummaryRule
	}
	if in.AllowChapterCut && in.Branch == nil {
		rules += ChapterCutRule
	}
	if rules == "" {
		return ""
	}
	return "Reply lines (removed before the operator sees the reply):\n" + rules
}

// WantsTopicSummary reports whether a turn prompt asks for a [TOPIC] line:
// only on the line's first turn (no history, no condensed or selected
// history, no summary), never on an aside or a spun-off line (its title
// came with the spinoff); on a main line when the operator's message is
// longer than 20 runes or the line has no title, on a branch when its
// purpose is longer than 25 runes.
func WantsTopicSummary(in PromptInput, lineTitle string) bool {
	if hasPromptHistory(in) || strings.TrimSpace(in.OriginCapsule) != "" {
		return false
	}
	if in.Branch == nil {
		return strings.TrimSpace(lineTitle) == "" || utf8.RuneCountInString(strings.TrimSpace(in.UserMessage)) > topicMainMinRunes
	}
	return !in.Branch.isAside() && utf8.RuneCountInString(strings.TrimSpace(in.Branch.Purpose)) > topicPurposeMinRunes
}

// hasPromptHistory reports whether the prompt carries any earlier message:
// a finished history entry, a history selection or the rolling summary.
func hasPromptHistory(in PromptInput) bool {
	if in.Summary.HasContent() && in.SummaryUptoSeq > 0 {
		return true
	}
	if in.Selection != nil && len(in.Selection.Full)+len(in.Selection.Condensed) > 0 {
		return true
	}
	for _, message := range in.History {
		if message.Status == MessageDone && historyShowsMessage(message) {
			return true
		}
	}
	return false
}

// ChapterCutDue reports whether the line's current (last) chapter holds at
// least ChapterCutMinMessages finished messages besides cards and the
// turn's own messages (own: how many of the turn's messages the chapters
// already include, 1 for the stored operator message of a begun turn).
func ChapterCutDue(chapters []Chapter, own int) bool {
	if len(chapters) == 0 {
		return false
	}
	last := chapters[len(chapters)-1]
	return last.MessageCount-len(last.CardMessageIDs)-own >= ChapterCutMinMessages
}

// ExtractTopicSummary removes every [TOPIC] line from content and returns
// the cleaned text (trimmed by TrimReply) and the first valid title: JSON
// {"title":...}, flattened to one line, at most TopicSummaryMaxRunes (and
// the title limit); "" when there is none.
func ExtractTopicSummary(content string, l TextLimits) (string, string) {
	return extractTitleLine(content, TopicMarker, min(TopicSummaryMaxRunes, l.orDefault().TitleMaxRunes))
}

// ExtractChapterCut removes every [CHAPTER] line from content and returns
// the cleaned text and the first valid chapter title (at most the topic
// title limit); "" when there is none.
func ExtractChapterCut(content string, l ChapterLimits) (string, string) {
	return extractTitleLine(content, ChapterCutMarker, l.orDefault().TopicTitleMaxRunes)
}

// extractTitleLine drops the lines that start with marker and parses the
// first valid title among them; the marker and its closing form are removed
// from the kept lines, so none is left live in the stored reply.
func extractTitleLine(content, marker string, maxRunes int) (string, string) {
	if !strings.Contains(content, marker) {
		return TrimReply(content), ""
	}
	closing := "[/" + strings.TrimPrefix(marker, "[")
	var kept []string
	title := ""
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(MarkerLineStart(line))
		if !strings.HasPrefix(trimmed, marker) {
			kept = append(kept, StripMarkers(line, []string{marker, closing}))
			continue
		}
		if title == "" {
			title = parseTitleLine(strings.TrimPrefix(trimmed, marker), closing, maxRunes)
		}
	}
	return TrimReply(strings.Join(kept, "\n")), title
}

// parseTitleLine reads {"title":...} after a marker; "" when it is not
// valid JSON, the title is empty or longer than maxRunes.
func parseTitleLine(raw, closing string, maxRunes int) string {
	raw = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(raw), closing))
	if raw == "" || len(raw) > titleLineMaxBytes {
		return ""
	}
	var parsed struct {
		Title string `json:"title"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return ""
	}
	title := branchLine(parsed.Title)
	if title == "" || utf8.RuneCountInString(title) > maxRunes {
		return ""
	}
	return title
}
