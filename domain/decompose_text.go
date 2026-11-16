package domain

import (
	"sort"
	"strings"
	"unicode"
)

// The text heuristics of a decompose plan: topic terms, cue words and the
// first sentence of a reply. They are deliberately simple and stable (no
// model, no randomness): the same messages always give the same plan.

// decomposeScanRunes caps how much of one message the heuristics read.
const decomposeScanRunes = 4000

// Cue words, matched case-insensitively at the start of an operator message
// (after leading white space and punctuation).
var (
	// shiftCues open a new topic.
	shiftCues = []string{
		"另外", "順便問", "順便", "換個", "那如果", "另一個問題", "話說", "对了", "對了", "顺便",
		"by the way", "btw", "another question", "switching to", "on another note", "unrelated", "different topic", "new topic",
	}
	// errorCues mark a question about an error.
	errorCues = []string{
		"error", "exception", "traceback", "panic:", "stack trace", "failed", "failure", "doesn't work", "does not work", "not working",
		"報錯", "报错", "錯誤", "错误", "失敗", "失败", "異常", "异常", "跑不起來", "連不上", "连不上",
	}
	// definitionCues mark a short "what is" question.
	definitionCues = []string{
		"what is", "what's", "what are", "what does", "explain", "define", "meaning of",
		"什麼是", "什么是", "是什麼", "是什么", "是指", "的意思", "解釋一下", "解释一下",
	}
	// openItemCues mark a list item that is still open.
	openItemCues = []string{"todo", "to do", "next step", "open question", "to confirm", "待確認", "待确认", "待辦", "待办", "下一步", "未解", "還沒", "还没"}
)

// Cleaning the suggested tags (B18.1): the Han pairs orderedTerms cuts are
// joined back into the words of the title and chains, and fragments are
// dropped (cleanSuggestedTags). The sets and the rules are the web client's
// (web/packages/client/src/suggested-tags.ts); keep the two in step.

// hanFunctionChars are single Han characters that join or qualify words
// rather than name a topic: a pair that starts or ends with one ("何在") is
// a fragment, and the title's topic words are cut at them.
const hanFunctionChars = "的了在是和與与及跟或就也都把被嗎吗呢吧啊很這这那個个們们之於于對对從从到會会還还又並并且則则但若中裡里要怎麼么什嘛呀"

// hanConnectives split a title into topic words (longest first).
var hanConnectives = []string{
	"為什麼", "为什么", "怎麼樣", "怎么样", "怎麼", "怎么", "如何", "什麼", "什么", "還是", "还是", "以及", "關於", "关于", "有關", "有关", "比較", "比较", "vs",
}

const (
	// titleWordMaxRunes caps a title topic word; longer runs are not words.
	titleWordMaxRunes = 8
	// chainedTagMaxRunes caps a tag joined from a chain of pairs the title
	// does not name.
	chainedTagMaxRunes = 6
)

// isHanFunction reports whether r is one of hanFunctionChars.
func isHanFunction(r rune) bool { return strings.ContainsRune(hanFunctionChars, r) }

// titleTopicWords are the title's topic words: runs of two to
// titleWordMaxRunes Han characters between punctuation, non-Han text,
// hanConnectives and hanFunctionChars, in title order.
func titleTopicWords(title string) []string {
	// A line's title is short (domain limits); it is read whole, as the client does.
	text := title
	for _, connective := range hanConnectives {
		text = strings.ReplaceAll(text, connective, " ")
	}
	words := []string{}
	var current []rune
	flush := func() {
		if len(current) >= 2 && len(current) <= titleWordMaxRunes {
			words = append(words, string(current))
		}
		current = current[:0]
	}
	for _, r := range text {
		if !unicode.Is(unicode.Han, r) || isHanFunction(r) {
			flush()
			continue
		}
		current = append(current, r)
	}
	flush()
	return words
}

// hanOnly reports whether s is one or more Han characters and nothing else.
func hanOnly(s string) bool {
	return s != "" && !strings.ContainsFunc(s, func(r rune) bool { return !unicode.Is(unicode.Han, r) })
}

// hasASCIIWord reports whether a (normalised, lower-case) tag has an ASCII
// letter or digit.
func hasASCIIWord(s string) bool {
	return strings.ContainsFunc(s, func(r rune) bool { return (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') })
}

// touchesFunction reports whether a Han term starts or ends with one of
// hanFunctionChars.
func touchesFunction(term string) bool {
	runes := []rune(term)
	return len(runes) > 0 && (isHanFunction(runes[0]) || isHanFunction(runes[len(runes)-1]))
}

// joinInWord joins the terms found in word into the stretches of word they
// cover by overlapping ("微分", "分幾", "幾何" in "微分幾何" give "微分幾何"),
// in word order. A term of any length matches, so an already joined word
// joins to itself.
func joinInWord(word string, terms []string) []string {
	chars := []rune(word)
	type span struct{ from, to int }
	spans := []span{}
	for _, term := range terms {
		n := len([]rune(term))
		for i := 0; i+n <= len(chars); i++ {
			if string(chars[i:i+n]) == term {
				spans = append(spans, span{i, i + n - 1})
			}
		}
	}
	sort.SliceStable(spans, func(a, b int) bool { return spans[a].from < spans[b].from })
	joined := []span{}
	for _, next := range spans {
		if last := len(joined) - 1; last >= 0 && next.from <= joined[last].to {
			joined[last].to = max(joined[last].to, next.to)
			continue
		}
		joined = append(joined, next)
	}
	out := make([]string, 0, len(joined))
	for _, s := range joined {
		out = append(out, string(chars[s.from:s.to+1]))
	}
	return out
}

// decomposeStopwords are frequent words that never name a topic.
var decomposeStopwords = map[string]bool{
	"the": true, "and": true, "for": true, "that": true, "this": true, "with": true, "you": true, "are": true, "was": true,
	"what": true, "how": true, "why": true, "can": true, "but": true, "not": true, "have": true, "has": true, "will": true,
	"would": true, "should": true, "could": true, "from": true, "about": true, "into": true, "your": true, "they": true,
	"them": true, "their": true, "there": true, "then": true, "than": true, "when": true, "which": true, "also": true,
	"just": true, "like": true, "more": true, "some": true, "any": true, "use": true, "using": true, "does": true, "did": true,
	"its": true, "it's": true, "one": true, "all": true, "out": true, "get": true, "let": true, "here": true, "yes": true,
	"我們": true, "你們": true, "什麼": true, "什么": true, "這個": true, "这个": true, "那個": true, "那个": true, "可以": true,
	"如果": true, "一個": true, "一个": true, "沒有": true, "没有": true, "因為": true, "因为": true, "所以": true, "就是": true,
	"還是": true, "还是": true, "但是": true, "然後": true, "然后": true, "怎麼": true, "怎么": true, "應該": true, "应该": true,
	"需要": true, "問題": true, "问题": true, "時候": true, "时候": true, "知道": true, "現在": true, "现在": true, "已經": true,
	"已经": true, "這樣": true, "这样": true, "不是": true, "我想": true, "請問": true, "请问": true, "一下": true, "的是": true,
}

// topicTerms are a text's topic terms (orderedTerms) as a set.
func topicTerms(text string) map[string]bool {
	terms := map[string]bool{}
	for _, term := range orderedTerms(text) {
		terms[term] = true
	}
	return terms
}

// orderedTerms are a text's topic terms in the order they first appear:
// lower-case ASCII words of three or more letters or digits, and
// overlapping pairs of Han characters, without the stopwords. Only the
// first decomposeScanRunes runes are read.
func orderedTerms(text string) []string {
	runes := []rune(strings.ToLower(text))
	if len(runes) > decomposeScanRunes {
		runes = runes[:decomposeScanRunes]
	}
	terms := []string{}
	seen := map[string]bool{}
	add := func(term string) {
		if !decomposeStopwords[term] && !seen[term] {
			seen[term] = true
			terms = append(terms, term)
		}
	}
	for i := 0; i < len(runes); {
		switch r := runes[i]; {
		case r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)):
			end := i
			for end < len(runes) && runes[end] < unicode.MaxASCII && (unicode.IsLetter(runes[end]) || unicode.IsDigit(runes[end]) || runes[end] == '_' || runes[end] == '-') {
				end++
			}
			if word := strings.Trim(string(runes[i:end]), "_-"); len(word) >= 3 {
				add(word)
			}
			i = end
		case unicode.Is(unicode.Han, r):
			if i+1 < len(runes) && unicode.Is(unicode.Han, runes[i+1]) {
				add(string(runes[i : i+2]))
			}
			i++
		default:
			i++
		}
	}
	return terms
}

// overlap is how much two term sets share, over the smaller one (0 when
// either is empty).
func overlap(a, b map[string]bool) float64 {
	small, large := a, b
	if len(b) < len(a) {
		small, large = b, a
	}
	if len(small) == 0 {
		return 0
	}
	shared := 0
	for term := range small {
		if large[term] {
			shared++
		}
	}
	return float64(shared) / float64(len(small))
}

// cueStart is a message's start as the cue words see it: lower case,
// leading white space and punctuation removed.
func cueStart(text string) string {
	return strings.TrimLeftFunc(strings.ToLower(text), func(r rune) bool { return unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) })
}

// startsWithCue reports whether text opens with one of the cues.
func startsWithCue(text string, cues []string) bool {
	start := cueStart(text)
	for _, cue := range cues {
		if strings.HasPrefix(start, cue) {
			return true
		}
	}
	return false
}

// containsCue reports whether the start of text (the first 300 runes)
// contains one of the cues.
func containsCue(text string, cues []string) bool {
	head := strings.ToLower(CutRunes(text, 300))
	for _, cue := range cues {
		if strings.Contains(head, cue) {
			return true
		}
	}
	return false
}

// hasHan reports whether text has a Han character (the plan then speaks
// Chinese in the texts it makes up).
func hasHan(text string) bool {
	return strings.ContainsFunc(CutRunes(text, 300), func(r rune) bool { return unicode.Is(unicode.Han, r) })
}

// firstSentence is a reply's first sentence on one line: up to the first
// full stop, question or exclamation mark (an ASCII one only before a space
// or the end) or line break, cut to max runes.
func firstSentence(text string, max int) string {
	text = strings.TrimSpace(StripAgentMarkers(text))
	runes := []rune(text)
	end := len(runes)
	for i, r := range runes {
		if r == '\n' || r == '。' || r == '！' || r == '？' {
			end = i + 1
			break
		}
		if (r == '.' || r == '!' || r == '?') && (i+1 == len(runes) || unicode.IsSpace(runes[i+1])) {
			end = i + 1
			break
		}
	}
	return CutRunes(FlattenUntrusted(string(runes[:end])), max)
}

// lastQuestion is a reply's closing question (its last sentence when it
// ends with a question mark), on one line; "" when it does not end with one.
func lastQuestion(text string, max int) string {
	text = strings.TrimSpace(text)
	if !strings.HasSuffix(text, "?") && !strings.HasSuffix(text, "？") {
		return ""
	}
	runes := []rune(text)
	start := 0
	for i := len(runes) - 2; i >= 0; i-- {
		r := runes[i]
		if r == '\n' || r == '。' || r == '！' || r == '？' || ((r == '.' || r == '!' || r == '?') && i+1 < len(runes) && unicode.IsSpace(runes[i+1])) {
			start = i + 1
			break
		}
	}
	return CutRunes(FlattenUntrusted(string(runes[start:])), max)
}

// listItems are the bulleted or numbered lines of a reply, without their
// bullets.
func listItems(text string) []string {
	out := []string{}
	for _, line := range strings.Split(CutRunes(text, decomposeScanRunes), "\n") {
		line = strings.TrimSpace(line)
		item, ok := strings.CutPrefix(line, "- ")
		if !ok {
			item, ok = strings.CutPrefix(line, "* ")
		}
		if !ok {
			item, ok = strings.CutPrefix(line, "• ")
		}
		if !ok {
			item, ok = numberedItem(line)
		}
		if ok && strings.TrimSpace(item) != "" {
			out = append(out, strings.TrimSpace(item))
		}
	}
	return out
}

// numberedItem reads "1. text" or "1) text".
func numberedItem(line string) (string, bool) {
	digits := 0
	for digits < len(line) && line[digits] >= '0' && line[digits] <= '9' {
		digits++
	}
	if digits == 0 || digits > 3 || digits+1 >= len(line) {
		return "", false
	}
	if (line[digits] == '.' || line[digits] == ')') && line[digits+1] == ' ' {
		return line[digits+2:], true
	}
	return "", false
}
