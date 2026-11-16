package domain

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// B26: one unit as the import analysis prompt shows it, and how it shrinks
// into its share of the prompt budget (BuildImportAnalyzePrompt).

const (
	// importAnalyzeMinimalTitleRunes and importAnalyzeMinimalQuestionRunes
	// bound a unit at its smallest: its title cut to the first, its question
	// never shorter than the second.
	importAnalyzeMinimalTitleRunes    = 40
	importAnalyzeMinimalQuestionRunes = 40
)

// analyzePromptUnit is what the prompt shows of one unit; asked is the
// whole normalized question, question what is shown of it.
type analyzePromptUnit struct {
	id, gap, title  string
	messages        int
	asked, question string
	answered        bool
	first, last     string
	keywords        []string
}

// analyzePromptUnits are the normalized units as the prompt shows them.
func analyzePromptUnits(clean ImportAnalyzeInput, ranking ImportAnalyzeKeywordRanking) []analyzePromptUnit {
	weights := analyzeKeywordWeights(clean.Title, clean.Units, ranking)
	gaps := analyzeUnitGaps(clean.Units)
	out := make([]analyzePromptUnit, 0, len(clean.Units))
	for i, unit := range clean.Units {
		first, last := answerEnds(unit.Answer, importAnalyzeSentenceRunes)
		out = append(out, analyzePromptUnit{
			id: analyzeUnitID(i), gap: gaps[i], title: unit.Title, messages: unit.MessageCount,
			asked: unit.Question, question: questionExcerpt(unit.Question, importAnalyzeQuestionHeadRunes, importAnalyzeQuestionTailRunes),
			answered: strings.TrimSpace(unit.Answer) != "", first: first, last: last, keywords: answerKeywords(unit, weights),
		})
	}
	return out
}

// render is the unit's section of the prompt.
func (u analyzePromptUnit) render() string {
	var b strings.Builder
	header := fmt.Sprintf("%d messages", u.messages)
	if u.gap != "" {
		header += ", " + u.gap
	}
	b.WriteString("\n### " + u.id + " (" + header + ")\n")
	if u.title != "" {
		b.WriteString("Title:\n" + branchQuote(u.title) + "\n")
	}
	b.WriteString("Question:\n" + branchQuote(u.question) + "\n")
	if !u.answered {
		b.WriteString("Answer: none\n")
		return b.String()
	}
	if u.first != "" {
		b.WriteString("Answer, first sentence:\n" + branchQuote(u.first) + "\n")
	}
	if u.last != "" {
		b.WriteString("Answer, last sentence:\n" + branchQuote(u.last) + "\n")
	}
	if len(u.keywords) > 0 {
		b.WriteString("Answer key terms:\n" + branchQuote(keywordLine(u.keywords)) + "\n")
	}
	return b.String()
}

// within is the unit in at most quota runes where it can be: whole, else
// without the last sentence, else without either, else minimal.
func (u analyzePromptUnit) within(quota int) string {
	if text := u.render(); utf8.RuneCountInString(text) <= quota {
		return text
	}
	u.last = ""
	if text := u.render(); utf8.RuneCountInString(text) <= quota {
		return text
	}
	u.first = ""
	if text := u.render(); utf8.RuneCountInString(text) <= quota {
		return text
	}
	return u.minimal(quota)
}

// minimal is the unit's title (cut), question on one line shortened to what
// the quota leaves (never below importAnalyzeMinimalQuestionRunes) and key
// terms.
func (u analyzePromptUnit) minimal(quota int) string {
	u.first, u.last = "", ""
	u.title = CutRunes(u.title, importAnalyzeMinimalTitleRunes)
	u.question = "x"
	room := quota - (utf8.RuneCountInString(u.render()) - 1)
	u.question = questionWithin(FlattenUntrusted(u.asked), max(room, importAnalyzeMinimalQuestionRunes))
	return u.render()
}
