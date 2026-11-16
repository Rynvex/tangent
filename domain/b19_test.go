package domain

import (
	"strings"
	"testing"
	"time"
)

// B19: an import keeps the source's dates, sets milestone chapter cuts and
// may bring branches back with their card.

var b19Now = time.Date(2026, time.November, 2, 12, 0, 0, 0, time.UTC)

func at(t time.Time) *time.Time { return &t }

func b19Input() ImportInput {
	return ImportInput{
		Messages: []ImportMessage{
			{ExternalID: "a", Role: "user", Content: "q1"}, {ExternalID: "b", Role: "assistant", Content: "a1"},
			{ExternalID: "c", Role: "user", Content: "q2"}, {ExternalID: "d", Role: "assistant", Content: "a2"},
		},
		Branches: []ImportBranch{{AnchorExternalID: "b", Messages: []ImportMessage{{Role: "user", Content: "x"}}}},
	}
}

func b19Plan(t *testing.T, in ImportInput) ImportPlan {
	t.Helper()
	plan, err := PlanImport(in, DefaultLimits(), nil, b19Now)
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func TestPlanImport_WithoutDatesNothingIsDated(t *testing.T) {
	plan := b19Plan(t, b19Input())
	if plan.Dates != nil || plan.Branches[0].Dates != nil || len(plan.ChapterCuts) != 0 || plan.Branches[0].Card != nil {
		t.Fatalf("plan = %+v", plan)
	}
	for _, message := range append(plan.Messages, plan.Branches[0].Messages...) {
		if message.CreatedAt != nil {
			t.Fatalf("an undated import got a date: %+v", message)
		}
	}
}

func TestPlanImport_DatesAreUTCAndNeverGoDown(t *testing.T) {
	t0 := time.Date(2025, time.March, 1, 9, 0, 0, 0, time.UTC)
	taipei := time.FixedZone("UTC+8", 8*3600)
	in := b19Input()
	in.Messages[0].CreatedAt = at(t0.In(taipei))
	in.Messages[2].CreatedAt = at(t0.Add(2 * time.Hour))
	in.Messages[3].CreatedAt = at(t0.Add(time.Hour)) // before the message above it
	plan := b19Plan(t, in)
	want := []time.Time{t0, t0, t0.Add(2 * time.Hour), t0.Add(2 * time.Hour)}
	for i, message := range plan.Messages {
		if message.CreatedAt == nil || !message.CreatedAt.Equal(want[i]) || message.CreatedAt.Location() != time.UTC {
			t.Fatalf("messages[%d].createdAt = %v, want %v (UTC)", i, message.CreatedAt, want[i])
		}
	}
	if plan.Dates == nil || !plan.Dates.CreatedAt.Equal(t0) || !plan.Dates.LastActivityAt.Equal(t0.Add(2*time.Hour)) {
		t.Fatalf("line dates = %+v", plan.Dates)
	}
	// A branch with no date of its own in a dated import is dated now.
	branch := plan.Branches[0]
	if branch.Dates == nil || !branch.Dates.CreatedAt.Equal(b19Now) || !branch.Messages[0].CreatedAt.Equal(b19Now) {
		t.Fatalf("undated branch = %+v", branch.Dates)
	}
}

func TestPlanImport_TheLineStartsAtItsEarliestDate(t *testing.T) {
	t0 := time.Date(2024, time.June, 5, 8, 0, 0, 0, time.UTC)
	// createdAt before the first message: the line starts there and the
	// undated first messages take it.
	in := b19Input()
	in.CreatedAt = at(t0)
	in.Messages[2].CreatedAt = at(t0.Add(time.Hour))
	in.Branches[0].CreatedAt = at(t0.Add(30 * time.Minute))
	plan := b19Plan(t, in)
	if !plan.Dates.CreatedAt.Equal(t0) || !plan.Messages[0].CreatedAt.Equal(t0) || !plan.Messages[1].CreatedAt.Equal(t0) || !plan.Messages[3].CreatedAt.Equal(t0.Add(time.Hour)) {
		t.Fatalf("plan = %+v %+v", plan.Dates, plan.Messages)
	}
	if b := plan.Branches[0]; !b.Dates.CreatedAt.Equal(t0.Add(30*time.Minute)) || !b.Messages[0].CreatedAt.Equal(t0.Add(30*time.Minute)) {
		t.Fatalf("branch = %+v", b.Dates)
	}
	// createdAt after the first message: the line never starts after it.
	in = b19Input()
	in.CreatedAt = at(t0.Add(time.Hour))
	in.Messages[0].CreatedAt = at(t0)
	if plan := b19Plan(t, in); !plan.Dates.CreatedAt.Equal(t0) {
		t.Fatalf("line start = %v", plan.Dates.CreatedAt)
	}
	// A branch's first dated message is its start.
	in = b19Input()
	in.Branches[0].Messages = []ImportMessage{{Role: "user", Content: "x"}, {Role: "assistant", Content: "y", CreatedAt: at(t0)}}
	plan = b19Plan(t, in)
	if b := plan.Branches[0]; !b.Dates.CreatedAt.Equal(t0) || !b.Messages[0].CreatedAt.Equal(t0) || plan.Dates == nil || !plan.Dates.CreatedAt.Equal(b19Now) {
		t.Fatalf("branch %+v main %+v", b.Dates, plan.Dates)
	}
}

func TestPlanImport_RefusesDatesOutOfRange(t *testing.T) {
	cases := map[string]func(*ImportInput, time.Time){
		"createdAt":                         func(in *ImportInput, t time.Time) { in.CreatedAt = &t },
		"messages[2].createdAt":             func(in *ImportInput, t time.Time) { in.Messages[2].CreatedAt = &t },
		"branches[0].createdAt":             func(in *ImportInput, t time.Time) { in.Branches[0].CreatedAt = &t },
		"branches[0].messages[0].createdAt": func(in *ImportInput, t time.Time) { in.Branches[0].Messages[0].CreatedAt = &t },
	}
	bad := []time.Time{{}, ImportEarliest.Add(-time.Second), b19Now.Add(ImportFutureSlack + time.Second), time.Date(99999, 1, 1, 0, 0, 0, 0, time.UTC)}
	for field, set := range cases {
		for _, when := range bad {
			in := b19Input()
			set(&in, when)
			_, err := PlanImport(in, DefaultLimits(), nil, b19Now)
			if e := AsError(err, DefaultLimits()); e == nil || e.Code != CodeInvalidInput || e.Extra["field"] != field {
				t.Fatalf("%s = %v: err = %v", field, when, err)
			}
		}
		for _, when := range []time.Time{ImportEarliest, b19Now.Add(ImportFutureSlack)} {
			in := b19Input()
			set(&in, when)
			if _, err := PlanImport(in, DefaultLimits(), nil, b19Now); err != nil {
				t.Fatalf("%s = %v is in range: %v", field, when, err)
			}
		}
	}
}

func TestPlanImport_ChapterCuts(t *testing.T) {
	in := b19Input()
	in.ChapterCuts = []ImportChapterCut{{AnchorExternalID: " c ", Title: "  §2\nIndexes  "}, {AnchorExternalID: "a", Title: "§1"}}
	plan := b19Plan(t, in)
	if len(plan.ChapterCuts) != 2 || plan.ChapterCuts[0] != (ImportPlanCut{AnchorIndex: 2, Title: "§2 Indexes"}) || plan.ChapterCuts[1] != (ImportPlanCut{AnchorIndex: 0, Title: "§1"}) {
		t.Fatalf("cuts = %+v", plan.ChapterCuts)
	}
	tooMany := make([]ImportChapterCut, ImportMaxChapterCuts+1)
	cases := map[string][]ImportChapterCut{
		"chapterCuts":                     tooMany,
		"chapterCuts[0].anchorExternalId": {{AnchorExternalID: "zz", Title: "t"}},
		"chapterCuts[1].anchorExternalId": {{AnchorExternalID: "a", Title: "t"}, {AnchorExternalID: "a", Title: "u"}},
		"chapterCuts[0].title":            {{AnchorExternalID: "a", Title: " \n "}},
	}
	cases["chapterCuts[1].title"] = []ImportChapterCut{{AnchorExternalID: "a", Title: "t"}, {AnchorExternalID: "b", Title: strings.Repeat("長", ImportTitleRunes+1)}}
	for field, cuts := range cases {
		in := b19Input()
		in.ChapterCuts = cuts
		_, err := PlanImport(in, DefaultLimits(), nil, b19Now)
		if e := AsError(err, DefaultLimits()); e == nil || e.Code != CodeInvalidInput || e.Extra["field"] != field {
			t.Fatalf("%s: err = %v", field, err)
		}
	}
	// The milestone limits bound them too.
	in = b19Input()
	in.ChapterCuts = []ImportChapterCut{{AnchorExternalID: "a", Title: "abcd"}}
	_, err := PlanImport(in, Limits{Chapters: ChapterLimits{MilestoneTitleMaxRunes: 3}}, nil, b19Now)
	if e := AsError(err, DefaultLimits()); e == nil || e.Extra["field"] != "chapterCuts[0].title" {
		t.Fatalf("milestone title limit: %v", err)
	}
	in.ChapterCuts = []ImportChapterCut{{AnchorExternalID: "a", Title: "a"}, {AnchorExternalID: "b", Title: "b"}}
	_, err = PlanImport(in, Limits{Chapters: ChapterLimits{MilestoneMaxPerTree: 1}}, nil, b19Now)
	if e := AsError(err, DefaultLimits()); e == nil || e.Extra["field"] != "chapterCuts" {
		t.Fatalf("milestone count limit: %v", err)
	}
}

func TestPlanImport_MergedBranchCarriesItsCard(t *testing.T) {
	in := b19Input()
	in.Branches[0].Status, in.Branches[0].Purpose = "merged", "Why the index"
	in.Branches[0].Card = &BranchCard{Conclusion: "Use a partial index.", OpenItems: []string{"measure it"}}
	plan := b19Plan(t, in)
	branch := plan.Branches[0]
	if branch.Status != BranchStatusMerged || branch.Card == nil || branch.Card.Question != "Why the index" || branch.Card.Conclusion != "Use a partial index." {
		t.Fatalf("branch = %+v card %+v", branch, branch.Card)
	}
	if !strings.Contains(branch.CardContent, "Use a partial index.") || branch.Card.Evidence == nil {
		t.Fatalf("card content %q, card %+v", branch.CardContent, branch.Card)
	}
	if in.Branches[0].Card.Question != "" {
		t.Fatal("the input card was changed")
	}

	invalidInput := map[string]func(*ImportBranch){
		"branches[0].card": func(b *ImportBranch) { b.Status, b.Card = "merged", nil },
	}
	for _, status := range []string{"", "open", "discarded"} {
		invalidInput["branches[0].card"+status] = func(b *ImportBranch) { b.Status, b.Card = status, &BranchCard{Question: "q", Conclusion: "c"} }
	}
	for name, mutate := range invalidInput {
		in := b19Input()
		mutate(&in.Branches[0])
		_, err := PlanImport(in, DefaultLimits(), nil, b19Now)
		if e := AsError(err, DefaultLimits()); e == nil || e.Code != CodeInvalidInput || e.Extra["field"] != "branches[0].card" {
			t.Fatalf("%s: err = %v", name, err)
		}
	}
	invalidCard := map[string]BranchCard{
		"branches[0].card.conclusion":            {Question: "q"},
		"branches[0].card.evidence[0].messageId": {Question: "q", Conclusion: "c", Evidence: []BranchCardEvidence{{MessageID: "0b9c3e0e-1c47-4c8e-9a51-6f0d2b1f7a10"}}},
	}
	for field, card := range invalidCard {
		in := b19Input()
		in.Branches[0].Status, in.Branches[0].Card = "merged", &card
		_, err := PlanImport(in, DefaultLimits(), nil, b19Now)
		e := AsError(err, DefaultLimits())
		if e == nil || e.Code != CodeInvalidCard {
			t.Fatalf("%s: err = %v", field, err)
		}
		problems, _ := e.Extra["problems"].([]BranchCardProblem)
		if len(problems) == 0 || problems[0].Field != field {
			t.Fatalf("%s: problems = %+v", field, problems)
		}
	}
}
