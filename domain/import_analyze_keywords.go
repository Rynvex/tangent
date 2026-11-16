package domain

import (
	"math"
	"slices"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// B26: an answer's key terms, one line of the unit in the model's prompt:
// the answer's topic words (importTopicTermsAt, the deterministic analyzer's
// words) that its question does not already name, ranked by weight × how
// often the answer uses the word; a Han word is shown as the phrase around
// it. The weight is the fallback's
// (analyzeTermWeights) by default, or inverse document frequency over the
// conversation's units; neither is visible in the HTTP API: the engine uses
// the default, cmd/tangent-eval can switch to compare them on a model.

// ImportAnalyzeKeywordRanking ranks an answer's key terms in the import
// analysis prompt (BuildImportAnalyzePromptWith).
type ImportAnalyzeKeywordRanking string

const (
	// ImportAnalyzeKeywordsByWeight ranks by the deterministic analyzer's
	// word weights (names over Han words, a word of most units or of the
	// title discounted); the default.
	ImportAnalyzeKeywordsByWeight ImportAnalyzeKeywordRanking = "weights"
	// ImportAnalyzeKeywordsByIDF ranks by ln(1 + units / units using the word).
	ImportAnalyzeKeywordsByIDF ImportAnalyzeKeywordRanking = "idf"
)

const (
	// importAnalyzeKeywordCount is how many key terms a unit shows.
	importAnalyzeKeywordCount = 8
	// importAnalyzeKeywordHanRunes is the longest Han phrase shown.
	importAnalyzeKeywordHanRunes = 6
	// importAnalyzeKeywordRunes caps one key term (a long identifier).
	importAnalyzeKeywordRunes = 30
	// importAnalyzeKeywordLineRunes caps the line of key terms.
	importAnalyzeKeywordLineRunes = 80
	// importAnalyzeKeywordSeparator joins the key terms.
	importAnalyzeKeywordSeparator = ", "
)

// analyzeKeywordWeights are the conversation's word weights for ranking key
// terms; an unknown ranking is the default.
func analyzeKeywordWeights(title string, units []ImportAnalyzeUnit, ranking ImportAnalyzeKeywordRanking) analyzeWeights {
	if ranking == ImportAnalyzeKeywordsByIDF {
		return idfWeights(units)
	}
	return analyzeTermWeights(title, units)
}

// idfWeights are ln(1 + n / df) over each unit's title, question and answer.
func idfWeights(units []ImportAnalyzeUnit) analyzeWeights {
	df := map[string]int{}
	for _, unit := range units {
		for term := range importTermSet(unit.Title + "\n" + unit.Question + "\n" + unit.Answer) {
			df[term]++
		}
	}
	n := float64(len(units))
	out := analyzeWeights{}
	for term, count := range df {
		out[term] = math.Log(1 + n/float64(count))
	}
	return out
}

// keywordWeight is a word's weight; a word the weights do not know (one
// past the head of the answer analyzeTermWeights reads) weighs by its script.
func keywordWeight(term string, weights analyzeWeights) float64 {
	if weight, ok := weights[term]; ok {
		return weight
	}
	if isASCIITerm(term) {
		return analyzeASCIIWeight
	}
	return analyzeHanWeight
}

// keywordCandidate is a possible key term: its text, score and where its
// best word first appears (rune index of the lower-case answer).
type keywordCandidate struct {
	text  string
	score float64
	at    int
	han   bool
}

// answerKeywords are a unit's key terms, best first (a tie keeps the order
// in the answer), none inside one already taken. An ASCII word is a term; a
// Han pair is shown as the phrase around it (hanPhraseCandidates).
func answerKeywords(unit ImportAnalyzeUnit, weights analyzeWeights) []string {
	asked := importTermSet(analyzeAskedText(unit))
	lower := strings.ToLower(unit.Answer)
	candidates := hanPhraseCandidates(lower, asked, weights)
	for _, term := range importTopicTermsAt(unit.Answer) {
		if !term.han && !asked[term.text] {
			candidates = append(candidates, keywordCandidate{text: term.text, score: keywordWeight(term.text, weights) * float64(countTerm(lower, term)), at: term.at})
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		return candidates[i].at < candidates[j].at
	})
	return pickKeywords(candidates)
}

// pickKeywords takes the best candidates, skipping a Han phrase inside one
// already taken (an ASCII word is a word: nas is not taken by dynasty), at most importAnalyzeKeywordCount, each cut to
// importAnalyzeKeywordRunes.
func pickKeywords(candidates []keywordCandidate) []string {
	picked := []string{}
	for _, c := range candidates {
		if len(picked) == importAnalyzeKeywordCount {
			break
		}
		if c.han && slices.ContainsFunc(picked, func(p string) bool { return strings.Contains(p, c.text) }) {
			continue
		}
		picked = append(picked, CutRunes(c.text, importAnalyzeKeywordRunes))
	}
	return picked
}

// hanPhraseCandidates are the answer's Han phrases (runs of Han runes
// without a function character, importFunctionHan) that hold a topic pair
// the question does not name. A phrase scores as its best pair (weight ×
// uses in the answer) and is shown whole up to importAnalyzeKeywordHanRunes,
// else as that many runes around the best pair: the overlapping pairs
// alone (庫之, 間放) would read as noise.
func hanPhraseCandidates(lower string, asked map[string]bool, weights analyzeWeights) []keywordCandidate {
	runes := []rune(lower)
	if len(runes) > importTermScanRunes {
		runes = runes[:importTermScanRunes]
	}
	out := []keywordCandidate{}
	for start := 0; start < len(runes); {
		end := start
		for end < len(runes) && isPhraseHan(runes[end]) {
			end++
		}
		if end == start {
			start++
			continue
		}
		if c, ok := hanPhrase(runes[start:end], start, lower, asked, weights); ok {
			out = append(out, c)
		}
		start = end
	}
	return out
}

func isPhraseHan(r rune) bool { return unicode.Is(unicode.Han, r) && !importFunctionHan[r] }

// hanPhrase scores one run (at is its start) by its best pair.
func hanPhrase(run []rune, at int, lower string, asked map[string]bool, weights analyzeWeights) (keywordCandidate, bool) {
	best, bestAt := 0.0, -1
	for i := 0; i+1 < len(run); i++ {
		pair := string(run[i : i+2])
		if asked[pair] || isImportTopicStopword(pair) {
			continue
		}
		if score := keywordWeight(pair, weights) * float64(strings.Count(lower, pair)); score > best {
			best, bestAt = score, i
		}
	}
	if bestAt < 0 {
		return keywordCandidate{}, false
	}
	from := 0
	if len(run) > importAnalyzeKeywordHanRunes {
		from = min(max(bestAt-(importAnalyzeKeywordHanRunes-2)/2, 0), len(run)-importAnalyzeKeywordHanRunes)
	}
	to := min(from+importAnalyzeKeywordHanRunes, len(run))
	return keywordCandidate{text: string(run[from:to]), score: best, at: at + bestAt, han: true}, true
}

// countTerm is how often a lower-case text uses a topic word: a Han pair
// anywhere, an ASCII word only as a whole word (nas is not in dynasty).
func countTerm(text string, term importTerm) int {
	if term.han {
		return strings.Count(text, term.text)
	}
	count := 0
	for from := 0; ; {
		at := strings.Index(text[from:], term.text)
		if at < 0 {
			return max(count, 1)
		}
		start, end := from+at, from+at+len(term.text)
		if !isTermByte(text, start-1) && !isTermByte(text, end) {
			count++
		}
		from = start + 1
	}
}

// isTermByte reports whether text[i] would continue an ASCII topic word.
func isTermByte(text string, i int) bool {
	if i < 0 || i >= len(text) {
		return false
	}
	b := rune(text[i])
	return isASCIIWordRune(b) || b == '_' || b == '-'
}

// keywordLine joins key terms, as many as fit importAnalyzeKeywordLineRunes.
func keywordLine(terms []string) string {
	line := ""
	for _, term := range terms {
		next := term
		if line != "" {
			next = line + importAnalyzeKeywordSeparator + term
		}
		if line != "" && utf8.RuneCountInString(next) > importAnalyzeKeywordLineRunes {
			break
		}
		line = next
	}
	return line
}
