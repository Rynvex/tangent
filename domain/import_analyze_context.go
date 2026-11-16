package domain

import (
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// B26: what the model reads of each unit besides its key terms
// (import_analyze_keywords.go): a long question's start and end, the first
// and last sentence of the answer (its opening is mostly a pleasantry, its
// close the conclusion) and the pause before the unit. Pure functions.

const (
	// importAnalyzeQuestionHeadRunes and importAnalyzeQuestionTailRunes are
	// what the model reads of a long question: a pasted log's question is
	// usually at its start or its end.
	importAnalyzeQuestionHeadRunes = 300
	importAnalyzeQuestionTailRunes = 100
	// importAnalyzeSentenceRunes caps the answer's first and last sentence.
	importAnalyzeSentenceRunes = 120
	// importAnalyzeGapMark is the pause after which a unit shows it (+2d 3h).
	importAnalyzeGapMark = 30 * time.Minute
	// importAnalyzeExcerptGap joins a question's start and end.
	importAnalyzeExcerptGap = " … "
)

// questionExcerpt is a question as the model reads it: whole up to
// head+tail runes, else its first head and last tail runes.
func questionExcerpt(text string, head, tail int) string {
	runes := []rune(text)
	if len(runes) <= head+tail {
		return text
	}
	return strings.TrimSpace(string(runes[:head])) + importAnalyzeExcerptGap + strings.TrimSpace(string(runes[len(runes)-tail:]))
}

// questionWithin is a question in at most max runes: whole when it fits,
// else its start and end three to one.
func questionWithin(text string, max int) string {
	if utf8.RuneCountInString(text) <= max {
		return text
	}
	room := max - utf8.RuneCountInString(importAnalyzeExcerptGap)
	if room < 2 {
		return CutRunes(text, max)
	}
	head := room * 3 / 4
	return questionExcerpt(text, head, room-head)
}

// answerSentences are an answer's sentences in order: prose ends a sentence
// at a line break, 。！？ or an ASCII .!? before a space or the end; a fenced
// code block (``` or the defused ”', ~~~) is one sentence, lines kept, and
// is never split. Pieces without a letter or a digit are left out.
func answerSentences(text string) []string {
	out := []string{}
	var code []string
	for _, line := range strings.Split(text, "\n") {
		fence := isFenceLine(line)
		switch {
		case code != nil:
			code = append(code, line)
			if fence {
				out = appendSentence(out, strings.Join(code, "\n"))
				code = nil
			}
		case fence:
			code = []string{line}
		default:
			out = append(out, lineSentences(line)...)
		}
	}
	if code != nil {
		out = appendSentence(out, strings.Join(code, "\n"))
	}
	return out
}

func isFenceLine(line string) bool {
	start := strings.TrimLeft(line, " \t")
	return strings.HasPrefix(start, "```") || strings.HasPrefix(start, "'''") || strings.HasPrefix(start, "~~~")
}

// lineSentences are the sentences of one prose line.
func lineSentences(line string) []string {
	out := []string{}
	runes := []rune(line)
	start := 0
	for i := range runes {
		if isSentenceEnd(runes, i) {
			out = appendSentence(out, string(runes[start:i+1]))
			start = i + 1
		}
	}
	return appendSentence(out, string(runes[start:]))
}

// isSentenceEnd reports whether runes[i] ends a sentence (1.5 and
// asyncio.gather do not).
func isSentenceEnd(runes []rune, i int) bool {
	switch runes[i] {
	case '。', '！', '？':
		return true
	case '.', '!', '?':
		return i+1 == len(runes) || unicode.IsSpace(runes[i+1])
	}
	return false
}

func appendSentence(out []string, sentence string) []string {
	sentence = strings.TrimSpace(sentence)
	if !strings.ContainsFunc(sentence, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }) {
		return out
	}
	return append(out, sentence)
}

// answerEnds are an answer's first and last sentence, each on one line and
// cut to max runes; last is "" when the answer has one sentence.
func answerEnds(text string, max int) (first, last string) {
	sentences := answerSentences(text)
	if len(sentences) == 0 {
		return "", ""
	}
	first = CutRunes(FlattenUntrusted(sentences[0]), max)
	if len(sentences) == 1 {
		return first, ""
	}
	return first, CutRunes(FlattenUntrusted(sentences[len(sentences)-1]), max)
}

// analyzeGap is the pause from prev to cur (RFC 3339 times) as the prompt
// marks it (+31m, +3h, +1h 5m, +2d 3h); "" when a time is missing or the
// pause is importAnalyzeGapMark or less.
func analyzeGap(prev, cur string) string {
	if prev == "" || cur == "" {
		return ""
	}
	from, errFrom := time.Parse(time.RFC3339Nano, prev)
	to, errTo := time.Parse(time.RFC3339Nano, cur)
	if errFrom != nil || errTo != nil || to.Sub(from) <= importAnalyzeGapMark {
		return ""
	}
	return formatGap(to.Sub(from))
}

// formatGap is a pause in its two largest units, days and hours or hours
// and minutes, a zero second unit left out.
func formatGap(d time.Duration) string {
	days, hours, minutes := int(d/(24*time.Hour)), int(d%(24*time.Hour)/time.Hour), int(d%time.Hour/time.Minute)
	switch {
	case days > 0 && hours > 0:
		return fmt.Sprintf("+%dd %dh", days, hours)
	case days > 0:
		return fmt.Sprintf("+%dd", days)
	case hours > 0 && minutes > 0:
		return fmt.Sprintf("+%dh %dm", hours, minutes)
	case hours > 0:
		return fmt.Sprintf("+%dh", hours)
	}
	return fmt.Sprintf("+%dm", minutes)
}

// analyzeUnitGaps are the units' pause marks: each timed unit measured from
// the latest time before it (a unit without one is skipped, not a reset).
func analyzeUnitGaps(units []ImportAnalyzeUnit) []string {
	out := make([]string, len(units))
	latest := ""
	for i, unit := range units {
		out[i] = analyzeGap(latest, unit.StartAt)
		if unit.StartAt != "" {
			latest = unit.StartAt
		}
	}
	return out
}
