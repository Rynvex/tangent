package domain

import (
	"reflect"
	"strings"
	"testing"
)

// B26: an answer's key terms for the model: its topic words that the
// question does not already name (a Han word shown as its phrase), most telling first (by the fallback's word
// weights or, switched, by inverse document frequency), a word used more
// often ranking higher, at most importAnalyzeKeywordCount of them.

func keywordsOf(units []ImportAnalyzeUnit, i int, ranking ImportAnalyzeKeywordRanking) []string {
	return answerKeywords(units[i], analyzeKeywordWeights("", units, ranking))
}

func TestAnswerKeywords(t *testing.T) {
	many := []string{}
	for _, w := range []string{"alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"} {
		many = append(many, w)
	}
	cases := []struct {
		name string
		unit ImportAnalyzeUnit
		want []string
	}{
		{
			"question words left out, repeated and named words first",
			ImportAnalyzeUnit{Question: "PgBouncer 的 pool_mode 要選哪個?", Answer: "pool_mode 有 session 與 transaction 兩種。transaction 最省連線。"},
			[]string{"transaction", "session", "兩種", "最省連線"},
		},
		{
			"a Han word is shown as its phrase",
			ImportAnalyzeUnit{Question: "怎麼辦?", Answer: "自動備份照片"},
			[]string{"自動備份照片"},
		},
		{
			"a long phrase is shown around its best pair, a term inside a taken one is skipped",
			ImportAnalyzeUnit{Question: "怎麼排?", Answer: "晚上住市區逛東大門夜市。夜市很熱鬧。"},
			[]string{"逛東大門夜市", "熱鬧"},
		},
		{
			"a phrase of question words only is left out",
			ImportAnalyzeUnit{Question: "NAS 備份怎麼做?", Answer: "備份，排程。"},
			[]string{"排程"},
		},
		{
			"a word inside another word is not counted twice",
			ImportAnalyzeUnit{Question: "q", Answer: "dynasty nas raid raid"},
			[]string{"raid", "dynasty", "nas"},
		},
		{"at most eight", ImportAnalyzeUnit{Question: "q", Answer: strings.Join(many, " ")}, many[:importAnalyzeKeywordCount]},
		{"code only gives its names", ImportAnalyzeUnit{Question: "怎麼寫?", Answer: "'''python\nimport asyncio\nawait asyncio.gather(fetch())\n'''"}, []string{"asyncio", "python", "import", "await", "gather", "fetch"}},
		{"empty answer", ImportAnalyzeUnit{Question: "在嗎?", Answer: ""}, []string{}},
	}
	for _, tc := range cases {
		units := []ImportAnalyzeUnit{tc.unit}
		if got := keywordsOf(units, 0, ImportAnalyzeKeywordsByWeight); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

// The two rankings differ on a word every unit uses: the weights rank by
// script and first use, inverse document frequency puts the rare word first.
func TestAnswerKeywords_RankingsDiffer(t *testing.T) {
	units := []ImportAnalyzeUnit{
		{Question: "a1", Answer: "NAS 可以，RAID 也行"},
		{Question: "a2", Answer: "NAS 照片"},
		{Question: "a3", Answer: "NAS 排程"},
	}
	if got := keywordsOf(units, 0, ImportAnalyzeKeywordsByWeight); !reflect.DeepEqual(got, []string{"nas", "raid"}) {
		t.Errorf("weights: %q", got)
	}
	if got := keywordsOf(units, 0, ImportAnalyzeKeywordsByIDF); !reflect.DeepEqual(got, []string{"raid", "nas"}) {
		t.Errorf("idf: %q", got)
	}
	if got := keywordsOf(units, 0, "unknown"); !reflect.DeepEqual(got, []string{"nas", "raid"}) {
		t.Errorf("an unknown ranking is the weights: %q", got)
	}
}

// A long name is cut, and the line never grows past its cap.
func TestKeywordLine(t *testing.T) {
	long := strings.Repeat("x", 50)
	if got := keywordLine([]string{CutRunes(long, importAnalyzeKeywordRunes), "nas"}); !strings.HasPrefix(got, strings.Repeat("x", importAnalyzeKeywordRunes-1)+"…, nas") {
		t.Errorf("got %q", got)
	}
	words := []string{}
	for i := 0; i < 8; i++ {
		words = append(words, strings.Repeat(string(rune('a'+i)), importAnalyzeKeywordRunes))
	}
	if got := keywordLine(words); len([]rune(got)) > importAnalyzeKeywordLineRunes || !strings.HasPrefix(got, words[0]) {
		t.Errorf("the line is capped: %d runes %q", len([]rune(got)), got)
	}
}
