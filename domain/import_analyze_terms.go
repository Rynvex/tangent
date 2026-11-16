package domain

import (
	"strings"
	"unicode"
)

// The topic words of an import analysis, as the web client's B21 topic
// splitting reads them (web/packages/client/src/import-topics.ts): the
// decompose words with two-letter acronyms kept and more stopwords, and the
// openings of a follow-up question. Both sides must keep these lists equal,
// so a plan made here and one made by the client's local analyzer agree.

// importTopicStopwords are question and filler words of English and words of
// Chinese replies and questions that name no topic (import-topics.ts
// SHORT_ENGLISH_STOPWORDS and TOPIC_STOPWORDS).
var importTopicStopwords = wordSet(
	"to in on at by of or as is it be we he do no so up go me my us if an ok hi " +
		"please explain tell give example examples difference between need want know think make work good best way thing things something really much many very same other these those who where after before now well still only even because such each most may might must been were had him his her she our over under again too " +
		"比較 比较 說明 说明 建議 建议 例如 比如 通常 主要 包括 方式 方法 使用 部分 情況 情况 進行 进行 提供 如下 重點 重点 簡單 简单 總結 总结 注意 推薦 推荐 選擇 选择 了解 確認 确认 果是 果有 果要 果用 果想 開始 开始")

// importFunctionHan are the Han characters of function words: a pair holding
// one (是什, 般是, 外的) is no topic word (import-topics.ts FUNCTION_HAN).
var importFunctionHan = runeSet("的了是嗎吗呢吧啊呀喔哦嘛么麼什怎誰谁哪這这那我你妳您他她它們们就都也還还很又才再而並并及與与和或跟把被讓让給给在有沒没不為为如但所因一個个些樣样得著着啦嗯請请謝谢可以")

// importFollowUpCues open a follow-up question (import-topics.ts
// FOLLOW_UP_CUES): it stays with the current topic when it touches it
// (threadTarget).
var importFollowUpCues = []string{
	"那", "還有", "还有", "如果", "再問", "再问", "承上", "繼續", "继续", "要怎麼", "要怎么", "這", "这", "它",
	"what about", "how about", "what if", "also", "and then", "so then",
}

// importShiftCues open a change of topic (import-topics.ts SHIFT_CUES): the
// follow-up rule does not apply, only the words decide.
var importShiftCues = []string{
	"另外", "對了", "对了", "順便", "顺便", "換個", "换个", "離題", "离题", "另一個問題", "另一个问题", "再來一個", "再来一个",
	"我想問", "我想问", "想問", "想问", "請問", "请问",
	"by the way", "unrelated", "another question", "different question", "new question", "changing topic", "switching topic",
}

// importReferents point back at the reply before, anywhere in the question
// (import-topics.ts REFERENTS); importWeakReferents (也, 再, 還要: also
// inside 也許, 再生) count only in a short question (hasReferent).
var importReferents = []string{
	"它", "這個", "这个", "那個", "那个", "上面", "上述", "剛剛", "刚刚", "剛才", "刚才", "前面", "這次", "这次", "最後", "最后",
	"the above", "that one", "this one", "your answer", "you said",
}

var importWeakReferents = []string{"也", "再", "還要", "还要", "還有", "还有", " it ", " also ", " again"}

// importTermScanRunes are the runes of a text that are read (TERM_SCAN_RUNES).
const importTermScanRunes = 4000

func wordSet(words string) map[string]bool {
	out := map[string]bool{}
	for _, word := range strings.Fields(words) {
		out[word] = true
	}
	return out
}

func runeSet(chars string) map[rune]bool {
	out := map[rune]bool{}
	for _, r := range chars {
		out[r] = true
	}
	return out
}

// isImportTopicStopword reports whether a word or Han pair is left out.
func isImportTopicStopword(term string) bool {
	if decomposeStopwords[term] || importTopicStopwords[term] {
		return true
	}
	if strings.Trim(term, "0123456789_-") == "" {
		return true
	}
	hasHanRune := false
	for _, r := range term {
		if unicode.Is(unicode.Han, r) {
			hasHanRune = true
		}
	}
	if !hasHanRune {
		return false
	}
	for _, r := range term {
		if importFunctionHan[r] {
			return true
		}
	}
	return false
}

// importTopicTerms are a text's topic words in the order they first appear:
// lower-case ASCII words of two or more letters or digits and overlapping
// Han pairs, without the stopwords (import-topics.ts topicTerms).
func importTopicTerms(text string) []string {
	placed := importTopicTermsAt(text)
	terms := make([]string, 0, len(placed))
	for _, term := range placed {
		terms = append(terms, term.text)
	}
	return terms
}

// importTerm is a topic word with where it first appears (rune index) and
// whether it is a Han pair (import-topics.ts topicTermsAt).
type importTerm struct {
	text string
	at   int
	han  bool
}

// importTopicTermsAt is importTopicTerms with each word's first position.
func importTopicTermsAt(text string) []importTerm {
	runes := []rune(strings.ToLower(text))
	if len(runes) > importTermScanRunes {
		runes = runes[:importTermScanRunes]
	}
	terms := []importTerm{}
	seen := map[string]bool{}
	add := func(term string, at int, han bool) {
		if !seen[term] && !isImportTopicStopword(term) {
			seen[term] = true
			terms = append(terms, importTerm{text: term, at: at, han: han})
		}
	}
	for i := 0; i < len(runes); {
		r := runes[i]
		switch {
		case isASCIIWordRune(r):
			end := i
			for end < len(runes) && (isASCIIWordRune(runes[end]) || runes[end] == '_' || runes[end] == '-') {
				end++
			}
			if word := strings.Trim(string(runes[i:end]), "_-"); len(word) >= 2 {
				add(word, i, false)
			}
			i = end
		case unicode.Is(unicode.Han, r):
			if i+1 < len(runes) && unicode.Is(unicode.Han, runes[i+1]) {
				add(string(runes[i:i+2]), i, true)
			}
			i++
		default:
			i++
		}
	}
	return terms
}

func isASCIIWordRune(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}

// importTermSet is importTopicTerms as a set.
func importTermSet(text string) map[string]bool {
	out := map[string]bool{}
	for _, term := range importTopicTerms(text) {
		out[term] = true
	}
	return out
}

// startsAsFollowUp reports whether a question opens like a follow-up
// (leading white space, punctuation and symbols ignored).
func startsAsFollowUp(question string) bool {
	return startsWithCue(question, importFollowUpCues)
}
