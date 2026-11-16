package domain

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// The guards on a model's node titles (ParseImportAnalyzeOutput): a title in
// the wrong script for the units' questions or a bare category word falls
// back to the first unit's own title, and when the reply names no chapter the
// largest node becomes one, not the first.

func TestBuildImportAnalyzePrompt_TellsTheModelToSplit(t *testing.T) {
	system, _ := BuildImportAnalyzePrompt(ImportAnalyzeInput{Units: interleavedUnits()}).Chat()
	for _, want := range []string{"When in doubt, keep units apart", "different questions about the same tool are", "## Example", "language the user's QUESTIONS", "never fold it into a chapter"} {
		if !strings.Contains(system, want) {
			t.Errorf("the instructions miss %q", want)
		}
	}
	if strings.Contains(system, "the first node is one") {
		t.Errorf("the instructions still make the first node a chapter")
	}
}

// The prompt's example must be a plan the parser accepts as it is, with the
// titles the example gives (none of them a guard's fallback) and no title of
// a multi-unit node joining two things with 與 or 、.
func TestBuildImportAnalyzePrompt_ExampleIsAValidPlan(t *testing.T) {
	system, _ := BuildImportAnalyzePrompt(ImportAnalyzeInput{Units: interleavedUnits()}).Chat()
	_, after, found := strings.Cut(system, "\n→ ")
	if !found {
		t.Fatal("no example reply in the instructions")
	}
	reply, _, _ := strings.Cut(after, "\n\n")
	questions := []string{
		"家裡的 NAS 要怎麼每天自動備份照片?", "Python 的 asyncio 跟 threading 差在哪?", "NAS 備份好的照片要不要再丟一份到雲端?", "手沖咖啡水溫幾度比較好?",
		"asyncio 的 gather 跟 create_task 怎麼選?", "那備份排程跑到一半斷電怎麼辦?", "Python 的 dataclass 跟 NamedTuple 差在哪?", "另外，公司 VPN 連不上要怎麼查?",
	}
	units := make([]ImportAnalyzeUnit, 0, len(questions))
	for i, q := range questions {
		units = append(units, ImportAnalyzeUnit{Key: fmt.Sprintf("e%d", i+1), Question: q, Answer: "回答。", MessageCount: 2})
	}
	plan, err := ParseImportAnalyzeOutput(reply, ImportAnalyzeInput{Units: units})
	if err != nil {
		t.Fatalf("%v\n%s", err, reply)
	}
	coversEveryUnit(t, plan, units)
	for _, node := range plan.Nodes {
		if strings.Contains(reply, `"title":"`+node.Title+`"`) == false {
			t.Errorf("node %s has the fallback title %q", node.Key, node.Title)
		}
		if len(node.UnitKeys) > 1 && strings.ContainsAny(node.Title, "與及、/") {
			t.Errorf("node %s joins things in its title %q", node.Key, node.Title)
		}
	}
	if a, b := nodeByKey(t, plan, "e1"), nodeByKey(t, plan, "e2"); a.Role != ImportRoleChapter || b.Role != ImportRoleMergedBranch || b.AttachToKey != "e1" {
		t.Fatalf("example roles = %+v", plan.Nodes)
	}
}

func TestParseImportAnalyzeOutput_GuardsTitles(t *testing.T) {
	hanUnits := interleavedUnits()
	latinUnits := interleavedUnits()
	for i := range latinUnits {
		latinUnits[i].Question = fmt.Sprintf("How often should I replace CPU thermal paste, round %d?", i+1)
	}
	termUnits := interleavedUnits()
	termUnits[0].Question = "Python 的 asyncio 跟 threading 差在哪? Traceback (most recent call last): RuntimeError: Event loop is closed"
	termUnits[2].Question = "asyncio 的 gather 跟 create_task 怎麼選?"
	termUnits[4].Question = "那 aiohttp ClientSession 要共用嗎?"
	kanaUnits := interleavedUnits()
	kanaUnits[0].Question = "これはどうすればいいですか、教えてください"
	emptyUnits := interleavedUnits()
	emptyUnits[0].Question = ""
	for name, tc := range map[string]struct {
		units []ImportAnalyzeUnit
		title string
		want  string
	}{
		"latin sentence for han questions":  {hanUnits, "CPU thermal paste interval", hanUnits[0].Question},
		"latin name for han questions kept": {hanUnits, "Docker Compose", "Docker Compose"},
		"digits kept":                       {hanUnits, "2024", "2024"},
		"category word":                     {hanUnits, "技術討論", hanUnits[0].Question},
		"category word with a space":        {hanUnits, "技術 討論", hanUnits[0].Question},
		"category words in latin":           {hanUnits, " Other  Questions ", hanUnits[0].Question},
		"specific mixed title kept":         {hanUnits, "CPU 散熱膏更換週期", "CPU 散熱膏更換週期"},
		"han title for latin questions":     {latinUnits, "散熱膏更換", latinUnits[0].Question},
		"latin title for latin kept":        {latinUnits, "Thermal paste interval", "Thermal paste interval"},
		"han title for term-heavy han kept": {termUnits, "非同步並行的取捨", "非同步並行的取捨"},
		"japanese kept":                     {kanaUnits, "機械学習モデル作成", "機械学習モデル作成"},
		"empty question keeps the title":    {emptyUnits, "散熱膏", "散熱膏"},
	} {
		reply := `{"nodes":[{"unitKeys":["U1","U3","U5"],"title":"` + tc.title + `","role":"chapter"},{"unitKeys":["U2","U4","U6"],"title":"x","role":"standalone"}]}`
		plan, err := ParseImportAnalyzeOutput(reply, ImportAnalyzeInput{Units: tc.units})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got := nodeByKey(t, plan, "u1").Title; got != tc.want {
			t.Errorf("%s: title = %q, want %q", name, got, tc.want)
		}
		// "x" is a one-word Latin name: kept for Han questions.
		if got := nodeByKey(t, plan, "u2").Title; got != "x" {
			t.Errorf("%s: second title = %q", name, got)
		}
	}
}

func TestScriptTokens(t *testing.T) {
	for text, want := range map[string]scriptCount{
		"": {},
		"Python 的 asyncio 跟 threading 差在哪?": {cjk: 5, latin: 3},
		"create_task, v2.0":                 {cjk: 0, latin: 4},
		"機械学習モデル作成":                         {cjk: 9, latin: 0},
		"한국어 질문":                            {cjk: 0, latin: 2},
	} {
		if got := scriptTokens(text); got != want {
			t.Errorf("%q = %+v, want %+v", text, got, want)
		}
	}
}

func TestParseImportAnalyzeOutput_LargestNodeIsTheChapterWhenNoneIs(t *testing.T) {
	units := interleavedUnits()
	reply := `{"nodes":[{"unitKeys":["U1"],"role":"standalone"},{"unitKeys":["U2","U4","U6"],"role":"standalone"},` +
		`{"unitKeys":["U3","U5"],"role":"merged_branch","attachToKey":"U2"}]}`
	plan, err := ParseImportAnalyzeOutput(reply, ImportAnalyzeInput{Units: units})
	if err != nil {
		t.Fatal(err)
	}
	coversEveryUnit(t, plan, units)
	a, b, c := nodeByKey(t, plan, "u1"), nodeByKey(t, plan, "u2"), nodeByKey(t, plan, "u3")
	if a.Role != ImportRoleStandalone || b.Role != ImportRoleChapter || b.Title != units[1].Question {
		t.Fatalf("A = %+v, B = %+v, want standalone / chapter", a, b)
	}
	if c.Role != ImportRoleMergedBranch || c.AttachToKey != "u2" || c.AttachAfterUnitKey != "u2" {
		t.Fatalf("C = %+v", c)
	}
	// A tie goes to the earliest node, and a branch that was the largest loses its attach fields.
	tie := `{"nodes":[{"unitKeys":["U1","U3"],"role":"merged_branch","attachToKey":"U2","conclusion":"x"},{"unitKeys":["U2","U4"],"role":"standalone"},{"unitKeys":["U5","U6"],"role":"standalone"}]}`
	plan, err = ParseImportAnalyzeOutput(tie, ImportAnalyzeInput{Units: units})
	if err != nil {
		t.Fatal(err)
	}
	roles := []string{}
	for _, node := range plan.Nodes {
		roles = append(roles, node.Role)
	}
	if first := plan.Nodes[0]; !reflect.DeepEqual(roles, []string{ImportRoleChapter, ImportRoleStandalone, ImportRoleStandalone}) || first.AttachToKey != "" || first.Conclusion != "" {
		t.Fatalf("nodes = %+v", plan.Nodes)
	}
}
