package domain

import "unicode"

// Token estimates. Two estimators exist: EstimateTokens is the cheap one the
// history budget and the summary trigger use; EstimatePackTokens is the
// conservative one for every text that must stay inside a hard budget (packs,
// notes, drafts).

// EstimateTokens approximates the token count of s: a CJK character (including
// full-width punctuation) counts as one token, every other character as a
// quarter token.
func EstimateTokens(s string) int {
	cjk, others := 0, 0
	for _, r := range s {
		if isCJK(r) {
			cjk++
		} else {
			others++
		}
	}
	return cjk + (others+3)/4
}

// isCJK reports whether r is a CJK character or full-width punctuation.
func isCJK(r rune) bool {
	switch {
	case r >= 0x2E80 && r <= 0x303F: // CJK radicals, Kangxi, CJK symbols & punctuation
		return true
	case r >= 0x3040 && r <= 0x30FF: // Hiragana, Katakana
		return true
	case r >= 0x3400 && r <= 0x4DBF: // CJK unified ideographs extension A
		return true
	case r >= 0x4E00 && r <= 0x9FFF: // CJK unified ideographs
		return true
	case r >= 0xF900 && r <= 0xFAFF: // CJK compatibility ideographs
		return true
	case r >= 0xFE30 && r <= 0xFE4F: // CJK compatibility forms
		return true
	case r >= 0xFF00 && r <= 0xFFEF: // half/full-width forms and signs
		return true
	case r >= 0x1100 && r <= 0x11FF: // Hangul Jamo
		return true
	case r >= 0x3130 && r <= 0x318F: // Hangul compatibility Jamo
		return true
	case r >= 0xA960 && r <= 0xA97F: // Hangul Jamo extended A
		return true
	case r >= 0xAC00 && r <= 0xD7FF: // Hangul syllables
		return true
	case r >= 0x20000 && r <= 0x2FA1F: // CJK unified ideographs extensions B-F
		return true
	}
	return false
}

// Rune costs in quarter tokens. CJK and other wide scripts are priced above
// their typical tokenisation so the estimate never under-counts them.
const (
	asciiRuneUnits = 1 // 0.25 token
	wideRuneUnits  = 6 // 1.5 tokens: CJK, kana, hangul, full-width forms
	otherRuneUnits = 4 // 1 token: emoji, accented letters, symbols
	// denseRuneUnits prices ASCII inside a long unbroken run (0.75 token).
	denseRuneUnits = 3
	// denseRunMinRunes is the length beyond which an unbroken, mostly ASCII
	// run is priced as dense.
	denseRunMinRunes = 12
	// denseRunASCIIPercent is how much of such a run must be ASCII.
	denseRunASCIIPercent = 80
	unitsPerToken        = 4
)

// EstimatePackTokens is a conservative token estimate for pack text. Words of
// ordinary length cost a quarter token per ASCII character; a long run of
// non-space characters that is mostly ASCII (hashes, base64, minified JSON,
// URLs, long identifiers) costs three quarters of a token per character,
// because such strings tokenise into many short pieces. CJK costs a token and
// a half per character and any other non-ASCII character a whole token. For
// the text kinds listed it stays at or above half a token per character; it
// is an estimate, not a guarantee for every possible string.
func EstimatePackTokens(s string) int {
	units := 0
	for _, cost := range packRuneCosts(s) {
		units += cost
	}
	return (units + unitsPerToken - 1) / unitsPerToken
}

// packRuneCosts returns the cost of every rune of s in quarter tokens.
func packRuneCosts(s string) []int {
	runes := []rune(s)
	costs := make([]int, len(runes))
	for start := 0; start < len(runes); {
		if unicode.IsSpace(runes[start]) {
			costs[start] = asciiRuneUnits
			start++
			continue
		}
		end := start
		ascii := 0
		for end < len(runes) && !unicode.IsSpace(runes[end]) {
			if runes[end] < 0x80 {
				ascii++
			}
			end++
		}
		dense := end-start > denseRunMinRunes && ascii*100 >= (end-start)*denseRunASCIIPercent
		for i := start; i < end; i++ {
			costs[i] = packRuneUnits(runes[i], dense)
		}
		start = end
	}
	return costs
}

func packRuneUnits(r rune, dense bool) int {
	switch {
	case r < 0x80 && dense:
		return denseRuneUnits
	case r < 0x80:
		return asciiRuneUnits
	case isCJK(r):
		return wideRuneUnits
	default:
		return otherRuneUnits
	}
}

// truncateToPackTokens cuts s to at most limit estimated tokens, on a rune
// boundary, reporting whether it cut anything.
func truncateToPackTokens(s string, limit int) (string, bool) {
	if limit <= 0 {
		return "", s != ""
	}
	maxUnits := limit * unitsPerToken
	units := 0
	runes := []rune(s)
	for i, cost := range packRuneCosts(s) {
		units += cost
		if units > maxUnits {
			return string(runes[:i]), true
		}
	}
	return s, false
}
