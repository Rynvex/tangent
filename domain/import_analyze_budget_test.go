package domain

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// B26: the prompt fits importAnalyzePromptBudgetRunes. Each unit gets an
// equal share; one that does not fit drops its answer's last sentence, then
// its first, and at last is its question (shortened) and key terms only.

var updateAnalyzePrompt = flag.Bool("update-analyze-prompt", false, "rewrite the import analysis prompt golden files in testdata")

func promptSize(p Prompt) int {
	system, messages := p.Chat()
	n := utf8.RuneCountInString(system)
	for _, m := range messages {
		n += utf8.RuneCountInString(m.Content)
	}
	return n
}

// hanText is n Han runes of varied two-rune words (no function characters),
// in sentences of seven runes, so it has many topic words.
func hanText(n, seed int) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		if i%8 == 7 {
			b.WriteString("。")
			continue
		}
		b.WriteRune(rune(0x5800 + (seed*131+i*17)%3000))
	}
	return b.String()
}

// worstUnits are n units at every cap: a long title, a question of many
// lines, an answer of many sentences, the most messages and long pauses.
func worstUnits(n int) []ImportAnalyzeUnit {
	start := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	units := make([]ImportAnalyzeUnit, 0, n)
	for i := 0; i < n; i++ {
		question := strings.Repeat(hanText(59, i)+"\n", ImportAnalyzeQuestionRunes/60+1)
		units = append(units, ImportAnalyzeUnit{
			Key: fmt.Sprintf("u%d", i), Title: hanText(ImportAnalyzeTitleRunes+20, i+7),
			Question: question, Answer: hanText(ImportAnalyzeAnswerRunes+100, i+1000) + " supercalifragilisticexpialidocious_and_more_letters",
			MessageCount: ImportAnalyzeMaxUnitMessages, StartAt: start.Add(time.Duration(i) * 1000 * 24 * time.Hour).Format(time.RFC3339),
		})
	}
	return units
}

// unitBlocks are the user message's unit sections by id.
func unitBlocks(t *testing.T, user string) []string {
	t.Helper()
	parts := strings.Split(user, "\n### U")
	return parts[1:]
}

func TestBuildImportAnalyzePrompt_FitsTheBudget(t *testing.T) {
	for _, n := range []int{1, 20, ImportAnalyzeMaxUnits} {
		units := worstUnits(n)
		prompt := BuildImportAnalyzePrompt(ImportAnalyzeInput{Title: hanText(300, 99), Units: units})
		if size := promptSize(prompt); size > importAnalyzePromptBudgetRunes {
			t.Errorf("%d units: %d runes, over %d", n, size, importAnalyzePromptBudgetRunes)
		}
		_, messages := prompt.Chat()
		blocks := unitBlocks(t, messages[0].Content)
		if len(blocks) != n {
			t.Fatalf("%d units: %d blocks", n, len(blocks))
		}
		for i, block := range blocks {
			if !strings.Contains(block, "Question:\n> ") || !strings.Contains(block, "Answer key terms:\n> ") {
				t.Fatalf("%d units: U%d lacks its question or key terms:\n%s", n, i+1, block)
			}
		}
		full := strings.Contains(blocks[0], "Answer, first sentence:") && strings.Contains(blocks[0], "Answer, last sentence:")
		if n <= 20 && !full {
			t.Errorf("%d units have room for both sentences:\n%s", n, blocks[0])
		}
		if n == ImportAnalyzeMaxUnits && strings.Contains(messages[0].Content, "sentence:") {
			t.Errorf("200 worst units keep no sentence")
		}
	}
}

// Units of a usual size keep their whole question at 200 units.
func TestBuildImportAnalyzePrompt_TypicalUnitsKeepTheirQuestion(t *testing.T) {
	units := make([]ImportAnalyzeUnit, 0, ImportAnalyzeMaxUnits)
	for i := 0; i < ImportAnalyzeMaxUnits; i++ {
		units = append(units, ImportAnalyzeUnit{Key: fmt.Sprint(i), Question: hanText(60, i), Answer: hanText(800, i+500), MessageCount: 2})
	}
	prompt := BuildImportAnalyzePrompt(ImportAnalyzeInput{Units: units})
	if size := promptSize(prompt); size > importAnalyzePromptBudgetRunes {
		t.Fatalf("%d runes", size)
	}
	_, messages := prompt.Chat()
	for i, block := range unitBlocks(t, messages[0].Content) {
		if !strings.Contains(block, "> "+hanText(60, i)+"\n") {
			t.Fatalf("U%d lost its question:\n%s", i+1, block)
		}
	}
}

// The levels, one quota at a time: the whole unit; without the last
// sentence; without the first; the question shortened with the key terms.
func TestAnalyzePromptUnit_DegradesInOrder(t *testing.T) {
	units := []ImportAnalyzeUnit{{Key: "a", Question: strings.Repeat("問題很長", 101), Answer: "第一句在這裡。中間的句子講到 PgBouncer。最後一句是結論。", MessageCount: 2}}
	unit := analyzePromptUnits(ImportAnalyzeInput{Units: units}, ImportAnalyzeKeywordsByWeight)[0]
	size := func(s string) int { return utf8.RuneCountInString(s) }
	full := unit.within(1 << 20)
	if !strings.Contains(full, "Answer, first sentence:\n> 第一句在這裡。") || !strings.Contains(full, "Answer, last sentence:\n> 最後一句是結論。") || !strings.Contains(full, "Answer key terms:\n> pgbouncer") {
		t.Fatalf("full:\n%s", full)
	}
	noLast := unit.within(size(full) - 1)
	if strings.Contains(noLast, "last sentence") || !strings.Contains(noLast, "first sentence") {
		t.Fatalf("first the last sentence goes:\n%s", noLast)
	}
	noFirst := unit.within(size(noLast) - 1)
	if strings.Contains(noFirst, "sentence") || !strings.Contains(noFirst, " … ") || !strings.Contains(noFirst, "Answer key terms:") {
		t.Fatalf("then the first:\n%s", noFirst)
	}
	tight := unit.within(size(noFirst) - 100)
	if size(tight) > size(noFirst)-100 || !strings.Contains(tight, "Question:\n> 問題") || !strings.Contains(tight, "Answer key terms:\n> pgbouncer") {
		t.Fatalf("at last the question shrinks:\n%s", tight)
	}
}

func TestBuildImportAnalyzePrompt_MarksPauses(t *testing.T) {
	units := []ImportAnalyzeUnit{
		{Key: "a", Question: "q1", Answer: "a1", MessageCount: 2, StartAt: "2026-11-01T09:00:00Z"},
		{Key: "b", Question: "q2", Answer: "a2", MessageCount: 2},
		{Key: "c", Question: "q3", Answer: "a3", MessageCount: 2, StartAt: "2026-11-01T09:30:00Z"},
		{Key: "d", Question: "q4", Answer: "", MessageCount: 1, StartAt: "2026-11-03T12:30:00Z"},
	}
	_, messages := BuildImportAnalyzePrompt(ImportAnalyzeInput{Units: units}).Chat()
	user := messages[0].Content
	for _, want := range []string{"### U1 (2 messages)\n", "### U2 (2 messages)\n", "### U3 (2 messages)\n", "### U4 (1 messages, +2d 3h)\nQuestion:\n> q4\nAnswer: none"} {
		if !strings.Contains(user, want) {
			t.Errorf("missing %q in:\n%s", want, user)
		}
	}
}

// The instructions tell the model what a unit now holds.
func TestBuildImportAnalyzePrompt_ExplainsTheUnits(t *testing.T) {
	system, _ := BuildImportAnalyzePrompt(ImportAnalyzeInput{Units: interleavedUnits()}).Chat()
	for _, want := range []string{"first and last sentence", "key terms", "+2d 3h", "pause"} {
		if !strings.Contains(system, want) {
			t.Errorf("the instructions miss %q", want)
		}
	}
}

// The golden prompts (testdata/import_analyze_*.prompt.txt) are the user
// message of a sample input; -update-analyze-prompt rewrites them.
func TestBuildImportAnalyzePrompt_Golden(t *testing.T) {
	for _, name := range []string{"import_analyze_weekend", "import_analyze_context"} {
		raw, err := os.ReadFile(filepath.Join("testdata", name+".input.json"))
		if err != nil {
			t.Fatal(err)
		}
		var in ImportAnalyzeInput
		if err := json.Unmarshal(raw, &in); err != nil {
			t.Fatal(err)
		}
		_, messages := BuildImportAnalyzePrompt(in).Chat()
		got := messages[0].Content + "\n"
		golden := filepath.Join("testdata", name+".prompt.txt")
		if *updateAnalyzePrompt {
			if err := os.WriteFile(golden, []byte(got), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(golden)
		if err != nil {
			t.Fatalf("%v (run with -update-analyze-prompt)", err)
		}
		if got != string(want) {
			t.Errorf("%s differs from %s (rerun with -update-analyze-prompt after checking):\n%s", name, golden, got)
		}
	}
}

// The deterministic analyzer and the repair of a model's plan read what
// they read before B26 (and what the web client's analyzeImportLocal
// reads): question and answer cut to ImportAnalyzeTextRunes, however much
// more the input now keeps.
func TestImportAnalyze_HeuristicReadsTheOldExcerpt(t *testing.T) {
	long := make([]ImportAnalyzeUnit, 0, 8)
	cut := make([]ImportAnalyzeUnit, 0, 8)
	for i := 0; i < 8; i++ {
		question := "  " + hanText(290, i%3) + " 結尾的 Redis 與 Kafka 問題？" + hanText(300, i)
		answer := hanText(295, i%2) + "\n\n" + strings.Repeat(" ", 20) + "NAS RAID " + hanText(1500, i)
		unit := ImportAnalyzeUnit{Key: fmt.Sprint(i), Question: question, Answer: answer, MessageCount: 2}
		long = append(long, unit)
		unit.Question = CutRunes(cleanAnalyzeText(question), ImportAnalyzeTextRunes)
		unit.Answer = CutRunes(cleanAnalyzeText(answer), ImportAnalyzeTextRunes)
		cut = append(cut, unit)
	}
	gotLong, err := AnalyzeImportDeterministic(ImportAnalyzeInput{Title: "t", Units: long})
	if err != nil {
		t.Fatal(err)
	}
	gotCut, _ := AnalyzeImportDeterministic(ImportAnalyzeInput{Title: "t", Units: cut})
	if !reflect.DeepEqual(gotLong, gotCut) {
		t.Fatalf("the heuristic changed:\n%+v\n%+v", gotLong, gotCut)
	}
	reply := `{"mode":"tree","nodes":[{"unitKeys":["U1","U2","U3","U4"],"role":"chapter"},{"unitKeys":["U5","U6","U7","U8"],"role":"merged_branch","attachToKey":"U1"}]}`
	parsedLong, err := ParseImportAnalyzeOutput(reply, ImportAnalyzeInput{Units: long})
	if err != nil {
		t.Fatal(err)
	}
	parsedCut, _ := ParseImportAnalyzeOutput(reply, ImportAnalyzeInput{Units: cut})
	if !reflect.DeepEqual(parsedLong, parsedCut) {
		t.Fatalf("the repair changed:\n%+v\n%+v", parsedLong, parsedCut)
	}
}
