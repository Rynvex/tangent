package domain

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestNormalizeFolder_TrimsAndRefuses(t *testing.T) {
	for in, want := range map[string]string{"": "", "  ": "", " Work ": "Work", "a\tb\nc": "abc", "資料庫‮研究": "資料庫研究"} {
		got, err := NormalizeFolder(in)
		if err != nil || got != want {
			t.Fatalf("NormalizeFolder(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{strings.Repeat("夾", FolderMaxRunes+1), FolderUnfiled, " " + FolderUnfiled + " "} {
		_, err := NormalizeFolder(in)
		if e := AsError(err, DefaultLimits()); e == nil || e.Code != CodeInvalidInput || e.Extra["field"] != "folder" {
			t.Fatalf("NormalizeFolder(%q) = %v", in, err)
		}
	}
	if got, err := NormalizeFolder(strings.Repeat("夾", FolderMaxRunes)); err != nil || len([]rune(got)) != FolderMaxRunes {
		t.Fatalf("the limit itself is allowed: %v", err)
	}
}

func TestNormalizeTags_NormalisesDedupesAndCaps(t *testing.T) {
	got, err := NormalizeTags([]string{" #Go ", "go", "", "  ", "##PostgreSQL", "MVCC\n", "資料庫"})
	if err != nil || !slices.Equal(got, []string{"go", "postgresql", "mvcc", "資料庫"}) {
		t.Fatalf("tags = %v, %v", got, err)
	}
	none, err := NormalizeTags(nil)
	if err != nil || none == nil || len(none) != 0 {
		t.Fatalf("no tags is an empty, non-nil slice: %#v %v", none, err)
	}
	if data, _ := json.Marshal(none); string(data) != "[]" {
		t.Fatalf("JSON = %s", data)
	}
	twelve := make([]string, 0, TagsMax+1)
	for i := range TagsMax {
		twelve = append(twelve, fmt.Sprintf("t%d", i))
	}
	if _, err := NormalizeTags(append(twelve, "t0", "T1")); err != nil {
		t.Fatalf("repeats do not count: %v", err)
	}
	for _, in := range [][]string{append(twelve, "one more"), {strings.Repeat("x", TagMaxRunes+1)}} {
		_, err := NormalizeTags(in)
		if e := AsError(err, DefaultLimits()); e == nil || e.Code != CodeInvalidInput || e.Extra["field"] != "tags" {
			t.Fatalf("NormalizeTags(%v) = %v", in, err)
		}
	}
	if NormalizeTag("  #  Rust ") != "rust" {
		t.Fatalf("NormalizeTag = %q", NormalizeTag("  #  Rust "))
	}
}

func TestPlanImport_CleansAndResolvesAnchors(t *testing.T) {
	plan, err := PlanImport(ImportInput{
		Source: " chatgpt ",
		Messages: []ImportMessage{
			{ExternalID: " a ", Role: "user", Content: "  First question\r\nwith two lines  "},
			{ExternalID: "b", Role: " assistant ", Content: "Answer [TOPIC]{\"title\":\"x\"}\n```go\ncode\n```"},
		},
		Branches: []ImportBranch{{AnchorExternalID: "b", Messages: []ImportMessage{{Role: "assistant", Content: "Another answer"}}}},
	}, DefaultLimits(), nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if plan.Title != "First question with two lines" || plan.Source != "chatgpt" {
		t.Fatalf("title %q source %q", plan.Title, plan.Source)
	}
	if plan.Messages[0].Content != "First question\nwith two lines" || plan.Messages[0].ExternalID != "a" || plan.Messages[1].Role != RoleAssistant {
		t.Fatalf("messages = %+v", plan.Messages)
	}
	if strings.Contains(plan.Messages[1].Content, "[TOPIC]") || !strings.Contains(plan.Messages[1].Content, "```go") {
		t.Fatalf("markers go, fences stay: %q", plan.Messages[1].Content)
	}
	branch := plan.Branches[0]
	if branch.AnchorIndex != 1 || branch.Kind != BranchKindAlternative || branch.Status != BranchStatusDiscarded || branch.Purpose != "Another answer" {
		t.Fatalf("branch = %+v", branch)
	}
	long := strings.Repeat("長", 100)
	if got := ImportTitle([]ImportMessage{{Role: "assistant", Content: "reply"}, {Role: "user", Content: long}}); len([]rune(got)) != ImportTitleRunes {
		t.Fatalf("the title is the first operator message, cut: %q", got)
	}
}

func TestPlanImport_NamesTheFieldOfEveryRefusal(t *testing.T) {
	base := func() ImportInput {
		return ImportInput{
			Messages: []ImportMessage{{ExternalID: "a", Role: "user", Content: "q"}, {ExternalID: "b", Role: "assistant", Content: "a"}},
			Branches: []ImportBranch{{AnchorExternalID: "a", Messages: []ImportMessage{{Role: "user", Content: "x"}}}},
		}
	}
	cases := map[string]func(*ImportInput){
		"messages":                     func(in *ImportInput) { in.Messages = nil },
		"messages[1].role":             func(in *ImportInput) { in.Messages[1].Role = "system" },
		"messages[0].content":          func(in *ImportInput) { in.Messages[0].Content = "​" },
		"messages[1].externalId":       func(in *ImportInput) { in.Messages[1].ExternalID = "a" },
		"branches":                     func(in *ImportInput) { in.Branches = slices.Repeat(in.Branches, ImportMaxBranches+1) },
		"branches[0].anchorExternalId": func(in *ImportInput) { in.Branches[0].AnchorExternalID = "zz" },
		"branches[0].kind":             func(in *ImportInput) { in.Branches[0].Kind = "aside" },
		"branches[0].status":           func(in *ImportInput) { in.Branches[0].Status = "promoted" },
		"branches[0].messages":         func(in *ImportInput) { in.Branches[0].Messages = nil },
		"branches[0].messages[0].role": func(in *ImportInput) { in.Branches[0].Messages[0].Role = "tool" },
		"branches[0].purpose":          func(in *ImportInput) { in.Branches[0].Purpose = strings.Repeat("p", 201) },
		"source":                       func(in *ImportInput) { in.Source = strings.Repeat("s", ImportSourceMaxRunes+1) },
	}
	for field, mutate := range cases {
		in := base()
		mutate(&in)
		_, err := PlanImport(in, DefaultLimits(), nil, time.Now())
		e := AsError(err, DefaultLimits())
		if e == nil || e.Code != CodeInvalidInput || e.Extra["field"] != field {
			t.Fatalf("%s: err = %v", field, err)
		}
	}
	in := base()
	in.Messages[0].Content = strings.Repeat("x", 11)
	_, err := PlanImport(in, Limits{Text: TextLimits{MessageMaxRunes: 10}}, nil, time.Now())
	if e := AsError(err, DefaultLimits()); e == nil || e.Code != CodeTooLong || e.Extra["field"] != "messages[0].content" {
		t.Fatalf("too long = %v", err)
	}
}

func TestExtractableMessage_OnlyFinishedChat(t *testing.T) {
	for _, c := range []struct {
		role, kind, status string
		want               bool
	}{
		{RoleUser, MessageKindChat, MessageDone, true},
		{RoleAssistant, MessageKindChat, MessageDone, true},
		{RoleAssistant, MessageKindChat, MessageError, false},
		{RoleAssistant, MessageKindChat, MessagePending, false},
		{RoleSystem, MessageKindChat, MessageDone, false},
		{RoleSystem, MessageKindBranchCard, MessageDone, false},
		{RoleSystem, MessageKindBranchMarker, MessageDone, false},
	} {
		if got := ExtractableMessage(c.role, c.kind, c.status); got != c.want {
			t.Fatalf("%+v = %v", c, got)
		}
	}
}

// decomposeLine builds a line of messages (user, assistant alternating
// from the first), a minute apart, ids m0, m1, ….
func decomposeLine(texts ...string) []Message {
	start := time.Date(2026, 10, 30, 9, 0, 0, 0, time.UTC)
	out := make([]Message, 0, len(texts))
	for i, text := range texts {
		role := RoleUser
		if i%2 == 1 {
			role = RoleAssistant
		}
		out = append(out, Message{ID: fmt.Sprintf("m%d", i), Seq: int64(i + 1), Role: role, Kind: MessageKindChat, Status: MessageDone, Content: text, CreatedAt: start.Add(time.Duration(i) * time.Minute)})
	}
	return out
}

func TestDecompose_ProposesTagsCutsDetoursAndSeeds(t *testing.T) {
	messages := decomposeLine(
		"請解釋 PostgreSQL 的 MVCC 機制",
		"MVCC 讓每個交易看到快照，PostgreSQL 用 xmin 判斷。",
		"Docker 容器連不上宿主機，出現 connection refused 錯誤",
		"改連 host.docker.internal 即可。也可以用 host network。",
		"回到 MVCC：PostgreSQL 的 VACUUM 什麼時候跑？",
		"autovacuum 會在門檻時執行。\n- 要不要調整 scale_factor？\n- 下一步：看 pg_stat_user_tables\n你想看設定範例嗎？",
		"另外，索引膨脹怎麼處理？",
		"用 REINDEX CONCURRENTLY。",
	)
	in := DecomposeInput{LineID: "line", Title: "PostgreSQL MVCC", Messages: messages, Tags: []string{"mvcc"}, CutMessageIDs: map[string]bool{}}
	plan := BuildDecomposePlan(in)
	if !slices.Equal(plan.SuggestedTags, []string{"postgresql", "docker"}) {
		t.Fatalf("tags = %v", plan.SuggestedTags)
	}
	if len(plan.ChapterCuts) != 1 || plan.ChapterCuts[0].MessageID != "m6" || plan.ChapterCuts[0].Reason != DecomposeReasonTopicShift || plan.ChapterCuts[0].Seq != 7 {
		t.Fatalf("cuts = %+v", plan.ChapterCuts)
	}
	want := DetourRange{FromMessageID: "m2", ToMessageID: "m3", AnchorMessageID: "m1", MessageCount: 2, SuggestedConclusion: "改連 host.docker.internal 即可。"}
	if len(plan.DetourRanges) != 1 {
		t.Fatalf("detours = %+v", plan.DetourRanges)
	}
	got := plan.DetourRanges[0]
	if got.FromMessageID != want.FromMessageID || got.ToMessageID != want.ToMessageID || got.AnchorMessageID != want.AnchorMessageID ||
		got.MessageCount != 2 || got.SuggestedConclusion != want.SuggestedConclusion || !strings.HasPrefix(got.Purpose, "了解：Docker") {
		t.Fatalf("detour = %+v", got)
	}
	seeds := []string{}
	for _, seed := range plan.SeedCandidates {
		seeds = append(seeds, seed.Reason+":"+seed.Text)
	}
	if !slices.Equal(seeds, []string{"open_item:要不要調整 scale_factor？", "open_item:下一步：看 pg_stat_user_tables", "question:你想看設定範例嗎？"}) {
		t.Fatalf("seeds = %q", seeds)
	}
	if plan.RelatedLines == nil || plan.Truncated {
		t.Fatalf("related %v truncated %v", plan.RelatedLines, plan.Truncated)
	}
	// Deterministic: the same input gives the same plan, in any input order.
	shuffled := slices.Clone(messages)
	slices.Reverse(shuffled)
	in.Messages = shuffled
	again, _ := json.Marshal(BuildDecomposePlan(in))
	first, _ := json.Marshal(plan)
	if string(again) != string(first) {
		t.Fatalf("not deterministic:\n%s\n%s", first, again)
	}
	// A message that already holds a cut is not proposed again.
	in.CutMessageIDs = map[string]bool{"m6": true}
	if cuts := BuildDecomposePlan(in).ChapterCuts; len(cuts) != 0 {
		t.Fatalf("cut already = %+v", cuts)
	}
}

func TestDecompose_EnglishCuesTimeGapsAndBounds(t *testing.T) {
	messages := decomposeLine(
		"How do goroutines work in Go?", "Goroutines are cheap threads scheduled by the Go runtime.",
		"What is a channel?", "A channel passes values between goroutines.",
		"By the way, which editor do you use?", "Any editor works.",
		"Back to goroutines: how many can run?", "Millions of goroutines can run.",
	)
	messages[6].CreatedAt = messages[5].CreatedAt.Add(DecomposeTimeGap)
	plan := BuildDecomposePlan(DecomposeInput{Title: "Go goroutines", Messages: messages})
	reasons := map[string]string{}
	for _, cut := range plan.ChapterCuts {
		reasons[cut.MessageID] = cut.Reason
	}
	if reasons["m4"] != DecomposeReasonTopicShift || reasons["m6"] != DecomposeReasonTimeGap {
		t.Fatalf("cuts = %+v", plan.ChapterCuts)
	}
	if len(plan.DetourRanges) == 0 || plan.DetourRanges[0].FromMessageID != "m2" || !strings.HasPrefix(plan.DetourRanges[0].Purpose, "Look into: What is a channel") {
		t.Fatalf("a short what-is question is a detour: %+v", plan.DetourRanges)
	}
	if plan.ChapterCuts == nil || plan.SeedCandidates == nil || plan.SuggestedTags == nil {
		t.Fatal("lists are never nil")
	}
	// Bounded: only the oldest DecomposeMaxMessages are read.
	long := make([]string, DecomposeMaxMessages+10)
	for i := range long {
		long[i] = "another question?"
	}
	if plan := BuildDecomposePlan(DecomposeInput{Messages: decomposeLine(long...)}); !plan.Truncated || len(plan.ChapterCuts) > DecomposeMaxCuts || len(plan.SeedCandidates) > DecomposeMaxSeeds {
		t.Fatalf("bounded = truncated %v, %d cuts, %d seeds", plan.Truncated, len(plan.ChapterCuts), len(plan.SeedCandidates))
	}
	empty := BuildDecomposePlan(DecomposeInput{})
	if empty.DetourRanges == nil || empty.RelatedLines == nil || len(empty.ChapterCuts) != 0 {
		t.Fatalf("empty = %+v", empty)
	}
}

func TestDecompose_TextHelpers(t *testing.T) {
	if got := firstSentence("Use v1.2 here. Then more.", 200); got != "Use v1.2 here." {
		t.Fatalf("firstSentence = %q", got)
	}
	if got := firstSentence("第一句。第二句", 200); got != "第一句。" {
		t.Fatalf("firstSentence = %q", got)
	}
	if got := lastQuestion("Done. Want more?", 200); got != "Want more?" {
		t.Fatalf("lastQuestion = %q", got)
	}
	if got := lastQuestion("No question here.", 200); got != "" {
		t.Fatalf("lastQuestion = %q", got)
	}
	if got := listItems("intro\n- one\n* two\n• three\n12. four\n1) five\n123456. not"); !slices.Equal(got, []string{"one", "two", "three", "four", "five"}) {
		t.Fatalf("listItems = %q", got)
	}
	if !startsWithCue("  「另外」想問", shiftCues) || !startsWithCue("BTW what", shiftCues) || startsWithCue("I said by the way", shiftCues) {
		t.Fatal("startsWithCue")
	}
	terms := topicTerms("The PostgreSQL 機制, an MVCC_test go")
	for _, want := range []string{"postgresql", "機制", "mvcc_test"} {
		if !terms[want] {
			t.Fatalf("terms = %v", terms)
		}
	}
	if terms["the"] || terms["go"] {
		t.Fatalf("stopwords and short words are not terms: %v", terms)
	}
}
