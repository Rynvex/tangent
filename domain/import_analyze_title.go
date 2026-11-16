package domain

import (
	"strings"
	"unicode"
)

// The guards on a model's node titles: a title the model wrote in another
// script than the units' questions (an English sentence for a Chinese chat,
// or the reverse) or as a bare category word (技術討論, Misc) says nothing
// about the node, so the node is titled as the heuristic would title it.

// analyzeCategoryTitles are titles that name a category, not a topic; a
// model's title equal to one (case folded, trimmed, words joined by "-") is
// dropped.
var analyzeCategoryTitles = wordSet(
	"技術討論 技術問題 程式問題 程式討論 相關問題 其他問題 其他 雜談 閒聊 討論 問題 " +
		"技术讨论 技术问题 程序问题 程序讨论 相关问题 其他问题 杂谈 闲聊 讨论 问题 " +
		"discussion discussions technical-discussion general-discussion misc miscellaneous " +
		"questions question other-questions general-questions other others general")

const (
	// cjkMajority is the CJK share of a text's tokens that makes it a CJK text.
	cjkMajority = 0.5
	// latinTitleNameWords is how many Latin words a title may have and still
	// be a name (Docker Compose) rather than a sentence in the wrong language.
	latinTitleNameWords = 2
)

// guardedAnalyzeTitle is a model's title for the node of units when it is
// specific and in the questions' script, else the first unit's own title
// (analyzeTitle). The title is already flattened and cut.
func guardedAnalyzeTitle(title string, units []ImportAnalyzeUnit) string {
	if title == "" || isCategoryTitle(title) || isWrongScript(title, units) {
		return analyzeTitle(units[0])
	}
	return title
}

// isCategoryTitle reports whether a title is only a category word.
func isCategoryTitle(title string) bool {
	folded := strings.ToLower(strings.TrimFunc(title, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) }))
	fields := strings.Fields(folded)
	return analyzeCategoryTitles[strings.Join(fields, "-")] || analyzeCategoryTitles[strings.Join(fields, "")]
}

// isWrongScript reports whether a title is a Latin sentence (more than
// latinTitleNameWords words, no CJK) while the questions are mostly CJK, or
// is mostly CJK while the questions have no CJK at all. Mixed titles
// (CPU 散熱), names (Docker Compose), mixed questions and questions without
// any letters pass.
func isWrongScript(title string, units []ImportAnalyzeUnit) bool {
	questions := make([]string, 0, len(units))
	for _, unit := range units {
		questions = append(questions, unit.Question)
	}
	asked := scriptTokens(strings.Join(questions, "\n"))
	titled := scriptTokens(title)
	switch {
	case asked.total() == 0:
		return false
	case asked.cjkShare() >= cjkMajority && titled.cjk == 0 && titled.latin > latinTitleNameWords:
		return true
	case asked.cjk == 0 && titled.cjkShare() >= cjkMajority:
		return true
	}
	return false
}

// scriptCount is a text's tokens by script: one per CJK character (Han,
// kana), one per run of other letters or digits.
type scriptCount struct{ cjk, latin int }

func (c scriptCount) total() int { return c.cjk + c.latin }

func (c scriptCount) cjkShare() float64 {
	if c.total() == 0 {
		return 0
	}
	return float64(c.cjk) / float64(c.total())
}

func isCJKRune(r rune) bool {
	return unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r)
}

// scriptTokens counts a text's tokens by script.
func scriptTokens(text string) scriptCount {
	count := scriptCount{}
	inWord := false
	for _, r := range text {
		switch {
		case isCJKRune(r):
			count.cjk++
			inWord = false
		case unicode.IsLetter(r) || unicode.IsNumber(r):
			if !inWord {
				count.latin++
			}
			inWord = true
		default:
			inWord = false
		}
	}
	return count
}
