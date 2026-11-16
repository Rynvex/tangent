package domain

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Rolling line summary. A cheap model runs over a prompt built here; the
// library parses the [SESSION-SUMMARY] JSON block of its reply and stores it
// with the seq of the newest message it covers (the summary cursor).

const (
	// summaryLineLimit caps each message line fed to the summarizer.
	summaryLineLimit = 400
	// summaryTopicMaxRunes caps the parsed topic.
	summaryTopicMaxRunes = 200
	// summaryItemMaxRunes caps every parsed list entry.
	summaryItemMaxRunes = 400
	// summaryMaxListItems caps each parsed list.
	summaryMaxListItems = 20
	// summaryMaxLandings caps the parsed landings (the prompt asks for 0-5).
	summaryMaxLandings = 5
)

// SummaryLanding is a suggested landing action (note or decision).
type SummaryLanding struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// Summary is the structured rolling digest of a line.
type Summary struct {
	Topic             string           `json:"topic"`
	Decisions         []string         `json:"decisions"`
	OpenQuestions     []string         `json:"openQuestions"`
	Files             []string         `json:"files"`
	SuggestedLandings []SummaryLanding `json:"suggestedLandings"`
	UpdatedAt         string           `json:"updatedAt"`
}

// NormalizeSummary never returns nil slices, so the JSON is stable.
func NormalizeSummary(s Summary) Summary {
	if s.Decisions == nil {
		s.Decisions = []string{}
	}
	if s.OpenQuestions == nil {
		s.OpenQuestions = []string{}
	}
	if s.Files == nil {
		s.Files = []string{}
	}
	if s.SuggestedLandings == nil {
		s.SuggestedLandings = []SummaryLanding{}
	}
	return s
}

// HasContent reports whether the summary has anything a prompt renders
// (topic, decisions, open questions or files). Landings alone render nothing,
// so a summary with only landings must not stand in for messages.
func (s Summary) HasContent() bool {
	return strings.TrimSpace(s.Topic) != "" || len(s.Decisions) > 0 || len(s.OpenQuestions) > 0 || len(s.Files) > 0
}

// CleanSummary neutralises model-written summary text and caps it: every
// field is flattened to one marker-free line and cut, every list bounded,
// empty entries dropped. extraMarkers are host markers removed as well.
func CleanSummary(s Summary, extraMarkers ...string) Summary {
	markers := hostMarkers(extraMarkers)
	line := func(text string, limit int) string {
		return truncateRunes(flattenWith(text, markers), limit)
	}
	list := func(items []string) []string {
		out := []string{}
		for _, item := range items {
			if cleaned := line(item, summaryItemMaxRunes); cleaned != "" && len(out) < summaryMaxListItems {
				out = append(out, cleaned)
			}
		}
		return out
	}
	landings := []SummaryLanding{}
	for _, landing := range s.SuggestedLandings {
		if text := line(landing.Text, summaryItemMaxRunes); text != "" && len(landings) < summaryMaxLandings {
			landings = append(landings, SummaryLanding{Kind: line(landing.Kind, 20), Text: text})
		}
	}
	return Summary{
		Topic: line(s.Topic, summaryTopicMaxRunes), Decisions: list(s.Decisions), OpenQuestions: list(s.OpenQuestions),
		Files: list(s.Files), SuggestedLandings: landings, UpdatedAt: line(s.UpdatedAt, 64),
	}
}

// IsEmpty reports whether the summary carries nothing worth showing.
func (s Summary) IsEmpty() bool {
	return s.Topic == "" && len(s.Decisions) == 0 && len(s.OpenQuestions) == 0 &&
		len(s.Files) == 0 && len(s.SuggestedLandings) == 0
}

// BuildSummaryPrompt renders the summarization prompt: the previous digest
// plus the newest finished messages (in seq order), asking for one
// marker-prefixed JSON object. Message bodies and the previous (model-written)
// summary are flattened and stripped of protocol markers and of the host's
// extraMarkers.
func BuildSummaryPrompt(previous Summary, messages []Message, extraMarkers ...string) string {
	markers := hostMarkers(extraMarkers)
	var b strings.Builder
	b.WriteString("You maintain a rolling summary of an operator/agent coding session.\n")
	b.WriteString("Given the previous summary and the newest messages, output ONLY one JSON object on the final line, prefixed by the marker line.\n\n")
	b.WriteString("Shape:\n" + SummaryMarker + "\n")
	b.WriteString(`{"topic":"short phrase","decisions":["short string"],"openQuestions":["short string"],"files":["path"],"topicStartMessageId":"message id","suggestedLandings":[{"kind":"note","text":"short string"}]}` + "\n\n")
	b.WriteString("Rules:\n")
	b.WriteString("- topic is one short phrase; decisions/openQuestions/files are short strings.\n")
	b.WriteString("- topicStartMessageId is the id (the text after \"id \" at the start of a line) of the newest-messages line where the current topic begins; it must be one of those ids. Leave it out if the topic did not change.\n")
	b.WriteString("- suggestedLandings kind is note or decision; 0-5 entries.\n")
	b.WriteString("- Output nothing after the JSON. Do not use code fences.\n\n")

	b.WriteString("Previous summary:\n")
	if previous.IsEmpty() {
		b.WriteString("(none)\n")
	} else if encoded, err := json.Marshal(CleanSummary(previous, markers...)); err == nil {
		b.WriteString(string(encoded) + "\n")
	} else {
		b.WriteString("(none)\n")
	}
	b.WriteString("\nNewest messages:\n")
	shown := shownMessages(SortBySeq(messages))
	if len(shown) == 0 {
		b.WriteString("(none)\n")
	}
	for _, message := range shown {
		if message.IsCard() {
			fmt.Fprintf(&b, "[id %s] %s\n", message.ID, StripMarkers(renderHistoryBranchCard(message), markers))
			continue
		}
		// Stripped before the cut (as always) and after normalising, so a
		// host marker split by an invisible character is gone too.
		body := flattenWith(condenseLine(StripMarkers(message.Content, markers), summaryLineLimit), markers)
		fmt.Fprintf(&b, "[id %s] %s: %s\n", message.ID, roleLabel(message.Role), body)
	}
	return b.String()
}

// shownMessages drops the messages the history does not show yet (a branch
// card no turn has carried).
func shownMessages(messages []Message) []Message {
	out := make([]Message, 0, len(messages))
	for _, message := range messages {
		if historyShowsMessage(message) {
			out = append(out, message)
		}
	}
	return out
}

// ParseSummary extracts the [SESSION-SUMMARY] JSON object from a summarizer
// reply.
func ParseSummary(content string) (Summary, bool) {
	summary, _, ok := ParseSummaryWithCut(content)
	return summary, ok
}

// ParseSummaryWithCut is ParseSummary plus the message id the model says the
// current topic starts at (empty when it gave none). The id is untrusted
// until TopicCutMessage accepts it. The summary comes back cleaned and capped
// (CleanSummary).
func ParseSummaryWithCut(content string) (Summary, string, bool) {
	idx := strings.LastIndex(content, SummaryMarker)
	if idx < 0 {
		return Summary{}, "", false
	}
	rest := content[idx+len(SummaryMarker):]
	start := strings.Index(rest, "{")
	if start < 0 {
		return Summary{}, "", false
	}
	var reply struct {
		Summary
		TopicStartMessageID string `json:"topicStartMessageId"`
	}
	if err := json.NewDecoder(strings.NewReader(rest[start:])).Decode(&reply); err != nil {
		return Summary{}, "", false
	}
	return CleanSummary(reply.Summary), strings.TrimSpace(reply.TopicStartMessageID), true
}

// TopicCutMessage picks the message a topic cut lands on: the model's id when
// it names one of the messages the summary was given, otherwise the first of
// them (lowest seq). It returns "" when the summary had no messages.
func TopicCutMessage(reported string, input []Message) string {
	shown := shownMessages(SortBySeq(input))
	if len(shown) == 0 {
		return ""
	}
	for _, message := range shown {
		if message.ID == reported {
			return reported
		}
	}
	return shown[0].ID
}

// TopicCutFor decides where a finished summary's topic cut lands, or "" when
// no cut is due: the model reported no start and the topic did not change.
// input are the messages after the previous cursor; only those up to uptoSeq
// (the new cursor, 0 = all) count.
func TopicCutFor(previousTopic string, summary Summary, reported string, input []Message, uptoSeq int64) string {
	if reported == "" && strings.EqualFold(strings.TrimSpace(summary.Topic), strings.TrimSpace(previousTopic)) {
		return ""
	}
	return TopicCutMessage(reported, SummaryInputUpTo(input, uptoSeq))
}

// SummaryInputUpTo keeps the messages through the one the summary covers up
// to, in seq order; uptoSeq 0 keeps them all.
func SummaryInputUpTo(messages []Message, uptoSeq int64) []Message {
	ordered := SortBySeq(messages)
	if uptoSeq <= 0 {
		return ordered
	}
	out := make([]Message, 0, len(ordered))
	for _, message := range ordered {
		if message.Seq <= uptoSeq {
			out = append(out, message)
		}
	}
	return out
}

// SummaryUptoSeq is the cursor a summary over messages records: the seq of
// the newest message that is not pending, or 0 when there is none.
func SummaryUptoSeq(messages []Message) int64 {
	var upto int64
	for _, message := range messages {
		if message.Status != MessagePending && message.Seq > upto {
			upto = message.Seq
		}
	}
	return upto
}

// SummaryTokenCount estimates the tokens of messages, used to decide when to
// summarize.
func SummaryTokenCount(messages []Message) int {
	total := 0
	for _, message := range messages {
		total += EstimateTokens(message.Content)
	}
	return total
}

// SummaryDue reports whether the messages after the summary cursor have grown
// past the trigger.
func SummaryDue(messagesAfterCursor []Message, l HistoryLimits) bool {
	l = l.orDefault()
	return len(messagesAfterCursor) > 0 && SummaryTokenCount(messagesAfterCursor) >= l.SummaryTriggerTokens
}
