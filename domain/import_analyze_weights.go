package domain

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// How much a topic word says about which topic a unit is (the deterministic
// import analysis, see threadTarget). A Han pair weighs 1, an ASCII word
// (a name: NAS, asyncio, PgBouncer) analyzeASCIIWeight; a word in more than
// half the units (設定 asked in every topic) and a word of the
// conversation's title (Postgres in a Postgres chat) weigh half: they name
// the domain, not a topic. Inverse document frequency was tried and does worse: a topic's own
// word is frequent exactly because the topic is big. The web client's
// import-topics.ts termWeights is the same; keep them equal.

const (
	// analyzeJoinThreshold is the weight a unit's question must share with
	// an earlier cluster to come back to it: two Han words, or one name, but
	// not one Han word nor one word of the title.
	analyzeJoinThreshold = 1.2
	// analyzeStayThreshold is what it must share with the current cluster
	// to go on with it: one Han word is enough right after that topic.
	analyzeStayThreshold = 1.0
	// analyzeHanWeight and analyzeASCIIWeight are a word's weight by script.
	analyzeHanWeight   = 1.0
	analyzeASCIIWeight = 1.5
	// analyzeTitleFactor discounts a word of the conversation's title, and
	// analyzeCommonFactor one in more than half the units.
	analyzeTitleFactor  = 0.5
	analyzeCommonFactor = 0.5
	// analyzeRecentHanWeight discounts a Han word shared only with a
	// cluster's recent answers (排程 in an asyncio reply must not pull a NAS
	// question along); a name from the last answer counts in full.
	analyzeRecentHanWeight = 0.5
	// analyzeRecentUnits is how many of a cluster's latest units are its recent text.
	analyzeRecentUnits = 2
	// analyzeCommonMinUnits is from how many units a word in more than half
	// of them is common.
	analyzeCommonMinUnits = 4
	// analyzeReportBackRunes is the longest question that is a report-back
	// (確實是 Seq Scan。, 找到了，卡在 orders 表的外鍵檢查。) when it does
	// not ask anything nor order something.
	analyzeReportBackRunes = 30
)

// importImperatives open an order (幫我寫一個…, write me…): a new ask,
// never a report-back, however short (import-topics.ts IMPERATIVES).
var importImperatives = []string{
	"幫我", "帮我", "請", "请", "寫", "写", "給我", "给我", "做一", "畫", "画", "列出", "整理一", "產生", "生成", "翻譯", "翻译",
	"help me", "write", "give me", "make", "create", "show me", "list", "draw", "generate", "translate",
}

// analyzeWeights are the topic words' weights in one analysis.
type analyzeWeights map[string]float64

// analyzeTermWeights weighs every topic word of the units (see the file comment).
func analyzeTermWeights(title string, units []ImportAnalyzeUnit) analyzeWeights {
	df := map[string]int{}
	for _, unit := range units {
		for term := range importTermSet(analyzeUnitText(unit, analyzeUnitReplyRunes)) {
			df[term]++
		}
	}
	titled := importTermSet(title)
	n := len(units)
	weights := analyzeWeights{}
	for term, count := range df {
		weight := analyzeHanWeight
		if isASCIITerm(term) {
			weight = analyzeASCIIWeight
		}
		if n >= analyzeCommonMinUnits && 2*count > n {
			weight *= analyzeCommonFactor
		}
		if titled[term] {
			weight *= analyzeTitleFactor
		}
		weights[term] = weight
	}
	return weights
}

func isASCIITerm(term string) bool {
	return !strings.ContainsFunc(term, func(r rune) bool { return r > unicode.MaxASCII })
}

// analyzeJoin is how a unit's question relates to one cluster: the weight
// it shares (asked words in full, recent Han words discounted) and how
// many words it shares at all.
type analyzeJoin struct {
	score  float64
	shared int
}

// joinScores relates a question's words (importTopicTermsAt of its asked
// text) to every cluster. Shared Han pairs at consecutive positions are one
// recurring phrase (連線時 gives 連線 and 線時) and count once, as their
// lightest pair: a phrase both topics use is one piece of evidence, not
// two, and a phrase built on a title word is domain talk.
func joinScores(asked []importTerm, clusters []*analyzeCluster, weights analyzeWeights) []analyzeJoin {
	joins := make([]analyzeJoin, len(clusters))
	for j, c := range clusters {
		run, runAt := 0.0, -2
		for _, term := range asked {
			weight, ok := sharedWeight(term, c, weights)
			if !ok {
				continue
			}
			joins[j].shared++
			if !term.han {
				joins[j].score += weight
				continue
			}
			if term.at == runAt+1 {
				run = min(run, weight)
			} else {
				joins[j].score += run
				run = weight
			}
			runAt = term.at
		}
		joins[j].score += run
	}
	return joins
}

// sharedWeight is what a word of the question counts for the cluster: its
// weight when the cluster asked it, a name from the cluster's recent text
// in full, a recent Han word discounted; false when not shared.
func sharedWeight(term importTerm, c *analyzeCluster, weights analyzeWeights) (float64, bool) {
	switch {
	case c.asked[term.text]:
		return weights[term.text], true
	case !c.recent(term.text):
		return 0, false
	case term.han:
		return analyzeRecentHanWeight * weights[term.text], true
	}
	return weights[term.text], true
}

// joinThreshold is what a unit must share with a cluster to join it: less
// for the current one (going on) than for an earlier one (coming back).
func joinThreshold(j, current int) float64 {
	if j == current {
		return analyzeStayThreshold
	}
	return analyzeJoinThreshold
}

// analyzeShiftRunes is how far into a question a shift cue may come
// (那我想問 Docker…, 嗯對了…).
const analyzeShiftRunes = 12

// startsAsShift reports whether a question opens like a change of topic: a
// shift cue at its start or within its first few runes.
func startsAsShift(question string) bool {
	start := cueStart(question)
	early := start
	if runes := []rune(start); len(runes) > analyzeShiftRunes {
		early = string(runes[:analyzeShiftRunes])
	}
	for _, cue := range importShiftCues {
		if strings.HasPrefix(start, cue) || strings.Contains(early, cue) {
			return true
		}
	}
	return false
}

// hasReferent reports whether a question points back: 它, 那個, the above
// anywhere; the weaker 也, 再, 還要 (also inside 也許, 再生) only in a short
// question.
func hasReferent(question string) bool {
	lower := strings.ToLower(question)
	for _, cue := range importReferents {
		if strings.Contains(lower, cue) {
			return true
		}
	}
	if utf8.RuneCountInString(strings.TrimSpace(question)) > analyzeReportBackRunes {
		return false
	}
	for _, cue := range importWeakReferents {
		if strings.Contains(lower, cue) {
			return true
		}
	}
	return false
}

// importReportBackMarks are characters and words a statement has and a
// bare topic (Redis 快取) does not: 了, 是, 到, 很… (import-topics.ts
// REPORT_BACK_MARKS).
const importReportBackMarks = "了是到很沒没在不有好還还也已完對对錯错成會会能"

var importReportBackWords = wordSet("is was it's its done now works worked still yes no not")

// importInterrogatives make a sentence a question even without a question
// mark (import-topics.ts INTERROGATIVES): never a report-back.
var (
	importInterrogativeRunes = "什怎哪誰谁嗎吗呢麼么"
	importInterrogativeWords = wordSet("what why how where when which who whom whose")
)

// importDoneMarks say an order was carried out (寫好了, done): a report-back
// after all.
var importDoneMarks = []string{"好了", "完了", "done", "finished"}

// isReportBack reports whether a question is a short statement rather than
// a question, an order or a bare topic (確實是 Seq Scan。, p95 降到 120ms 了。):
// what the user found after the previous reply.
func isReportBack(question string) bool {
	text := strings.TrimSpace(question)
	if text == "" || utf8.RuneCountInString(text) > analyzeReportBackRunes || isOrder(text) || strings.ContainsAny(text, importInterrogativeRunes) {
		return false
	}
	last, _ := utf8.DecodeLastRuneInString(text)
	if strings.ContainsRune("?？", last) {
		return false
	}
	words := englishWords(text)
	for _, word := range words {
		if importInterrogativeWords[word] {
			return false
		}
	}
	for _, word := range words {
		if importReportBackWords[word] {
			return true
		}
	}
	return strings.ContainsAny(text, importReportBackMarks)
}

// isOrder reports whether a text opens like an order and does not say it
// was carried out (幫我寫一個… yes; 寫好了, "Created the table, works now" no).
func isOrder(text string) bool {
	if !startsWithCue(text, importImperatives) {
		return false
	}
	lower := strings.ToLower(text)
	for _, mark := range importDoneMarks {
		if strings.Contains(lower, mark) {
			return false
		}
	}
	for _, word := range englishWords(text) {
		if importReportBackWords[word] {
			return false
		}
	}
	return true
}

// englishWords are a text's lower-case letter runs (apostrophes kept).
func englishWords(text string) []string {
	return strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) && r != '\'' })
}

// continuesTopic reports whether a question reads as going on with the
// current topic: a follow-up opening, a report-back or a pointer back, and
// not a change of topic.
func continuesTopic(question string) bool {
	return !startsAsShift(question) && (startsAsFollowUp(question) || isReportBack(question) || hasReferent(question))
}
