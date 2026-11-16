package domain

import (
	"reflect"
	"strings"
	"testing"
)

// B26: what the model reads of each unit: the first and last sentence of
// its answer (a code block is one sentence, never split), the question's
// start and end when it is long, and the time since the unit before.

func TestAnswerSentences(t *testing.T) {
	cases := []struct {
		name string
		text string
		want []string
	}{
		{"chinese", "好的！PgBouncer 有三種模式。transaction 最省連線。", []string{"好的！", "PgBouncer 有三種模式。", "transaction 最省連線。"}},
		{"english", "Sure. Use a pool! Is that ok? Done", []string{"Sure.", "Use a pool!", "Is that ok?", "Done"}},
		{"mixed, a dot inside a name is no end", "可以用 asyncio.gather() 一次等待。Then call loop.close() at the end.", []string{"可以用 asyncio.gather() 一次等待。", "Then call loop.close() at the end."}},
		{"a decimal is no end", "建議每 1.5 年更換一次。", []string{"建議每 1.5 年更換一次。"}},
		{"a line break ends one", "第一行沒有句號\n第二行", []string{"第一行沒有句號", "第二行"}},
		{"code only is one sentence", "'''python\nprint('a. b')\nx = 1\n'''", []string{"'''python\nprint('a. b')\nx = 1\n'''"}},
		{"a code block in prose is not split", "先安裝。\n```bash\npip install x. y\n```\n裝好就能跑。", []string{"先安裝。", "```bash\npip install x. y\n```", "裝好就能跑。"}},
		{"an unclosed block runs to the end", "看這段：\n'''go\nfunc main() {}", []string{"看這段：", "'''go\nfunc main() {}"}},
		{"punctuation only lines are no sentence", "---\n好。\n**", []string{"好。"}},
		{"empty", "", []string{}},
		{"white space", "  \n\t\n", []string{}},
	}
	for _, tc := range cases {
		if got := answerSentences(tc.text); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestAnswerEnds(t *testing.T) {
	long := strings.Repeat("長", 200) + "。結尾。"
	cases := []struct {
		name, text, first, last string
	}{
		{"several", "好的！PgBouncer 有三種模式。總結：選 transaction。", "好的！", "總結：選 transaction。"},
		{"single sentence has no last", "可以。", "可以。", ""},
		{"empty", "", "", ""},
		{"code only is flattened", "'''python\nprint(1)\n'''", "'''python print(1) '''", ""},
		{"ends with code", "Run this:\n```sh\nmake test\n```", "Run this:", "'''sh make test '''"},
		{"a long first sentence is cut", long, strings.Repeat("長", importAnalyzeSentenceRunes-1) + "…", "結尾。"},
	}
	for _, tc := range cases {
		first, last := answerEnds(tc.text, importAnalyzeSentenceRunes)
		if first != tc.first || last != tc.last {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", tc.name, first, last, tc.first, tc.last)
		}
	}
}

func TestQuestionExcerpt(t *testing.T) {
	short := strings.Repeat("問", 400)
	if got := questionExcerpt(short, importAnalyzeQuestionHeadRunes, importAnalyzeQuestionTailRunes); got != short {
		t.Fatalf("400 runes are kept whole, got %d runes", len([]rune(got)))
	}
	long := strings.Repeat("頭", 300) + strings.Repeat("中", 50) + strings.Repeat("尾", 100)
	want := strings.Repeat("頭", 300) + " … " + strings.Repeat("尾", 100)
	if got := questionExcerpt(long, importAnalyzeQuestionHeadRunes, importAnalyzeQuestionTailRunes); got != want {
		t.Fatalf("a long question is its start … its end, got %q", got)
	}
	for _, max := range []int{40, 100, 403} {
		got := questionWithin(long, max)
		if n := len([]rune(got)); n > max || !strings.HasPrefix(got, "頭") || !strings.HasSuffix(got, "尾") {
			t.Errorf("within %d: %d runes %q", max, n, got)
		}
	}
	if got := questionWithin("短問題", 40); got != "短問題" {
		t.Errorf("a short question is kept, got %q", got)
	}
}

func TestAnalyzeGap(t *testing.T) {
	const t0 = "2026-11-01T09:00:00Z"
	cases := []struct {
		name, prev, cur, want string
	}{
		{"no previous time", "", t0, ""},
		{"no time", t0, "", ""},
		{"exactly 30 minutes is no mark", t0, "2026-11-01T09:30:00Z", ""},
		{"31 minutes", t0, "2026-11-01T09:31:00Z", "+31m"},
		{"hours", t0, "2026-11-01T12:00:00Z", "+3h"},
		{"hours and minutes", t0, "2026-11-01T10:05:30Z", "+1h 5m"},
		{"days and hours", t0, "2026-11-03T12:10:00Z", "+2d 3h"},
		{"whole days", t0, "2026-11-08T09:20:00Z", "+7d"},
		{"an offset is a time", t0, "2026-11-01T20:00:00+08:00", "+3h"},
		{"backwards is no mark", "2026-11-02T09:00:00Z", t0, ""},
	}
	for _, tc := range cases {
		if got := analyzeGap(tc.prev, tc.cur); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

// A unit without a time neither gets a mark nor resets the clock: the next
// timed unit is measured from the last time known.
func TestAnalyzeUnitGaps_MixedTimes(t *testing.T) {
	units := []ImportAnalyzeUnit{
		{Key: "a", StartAt: "2026-11-01T09:00:00Z"},
		{Key: "b"},
		{Key: "c", StartAt: "2026-11-01T11:00:00Z"},
		{Key: "d", StartAt: "2026-11-01T11:30:00Z"},
		{Key: "e", StartAt: "2026-11-02T11:30:00Z"},
	}
	want := []string{"", "", "+2h", "", "+1d"}
	if got := analyzeUnitGaps(units); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}
