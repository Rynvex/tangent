package domain

import (
	"fmt"
	"testing"
	"time"
)

// B21: the limits of an import are relaxed for long and combined exports.

// b21Messages is n messages taking turns, the first a question, each with
// an externalId prefix-i.
func b21Messages(prefix string, n int) []ImportMessage {
	out := make([]ImportMessage, n)
	for i := range out {
		role := RoleUser
		if i%2 == 1 {
			role = RoleAssistant
		}
		out[i] = ImportMessage{ExternalID: fmt.Sprintf("%s-%d", prefix, i), Role: role, Content: fmt.Sprintf("%s message %d", prefix, i)}
	}
	return out
}

func TestImportLimits_B21Values(t *testing.T) {
	if ImportMaxMessages != 2000 || ImportMaxBranches != 50 || ImportMaxBranchMessages != 500 || ImportMaxChapterCuts != 50 || DecomposeMaxMessages != 2000 {
		t.Fatalf("limits = %d %d %d %d %d", ImportMaxMessages, ImportMaxBranches, ImportMaxBranchMessages, ImportMaxChapterCuts, DecomposeMaxMessages)
	}
}

func TestPlanImport_AcceptsEveryLimitExactly(t *testing.T) {
	in := ImportInput{Messages: b21Messages("m", ImportMaxMessages)}
	for i := range ImportMaxBranches {
		branch := ImportBranch{AnchorExternalID: fmt.Sprintf("m-%d", i*2+1), Messages: []ImportMessage{{Role: RoleUser, Content: "q"}}}
		if i == 0 {
			branch.Messages = b21Messages("b", ImportMaxBranchMessages)
		}
		in.Branches = append(in.Branches, branch)
	}
	for i := range ImportMaxChapterCuts {
		in.ChapterCuts = append(in.ChapterCuts, ImportChapterCut{AnchorExternalID: fmt.Sprintf("m-%d", i*2), Title: fmt.Sprintf("§%d", i+1)})
	}
	plan, err := PlanImport(in, DefaultLimits(), nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Messages) != ImportMaxMessages || len(plan.Branches) != ImportMaxBranches || len(plan.Branches[0].Messages) != ImportMaxBranchMessages || len(plan.ChapterCuts) != ImportMaxChapterCuts {
		t.Fatalf("plan = %d messages, %d branches, %d cuts", len(plan.Messages), len(plan.Branches), len(plan.ChapterCuts))
	}
}

func TestPlanImport_RefusesOneOverEveryLimit(t *testing.T) {
	base := func() ImportInput {
		return ImportInput{
			Messages: b21Messages("m", 4),
			Branches: []ImportBranch{{AnchorExternalID: "m-1", Messages: []ImportMessage{{Role: RoleUser, Content: "q"}}}},
		}
	}
	cases := []struct {
		field, message string
		mutate         func(*ImportInput)
	}{
		{"messages", "messages: an import has 1 to 2000 messages", func(in *ImportInput) { in.Messages = b21Messages("m", ImportMaxMessages+1) }},
		{"branches", "branches: an import has at most 50 branches", func(in *ImportInput) {
			for len(in.Branches) <= ImportMaxBranches {
				in.Branches = append(in.Branches, in.Branches[0])
			}
		}},
		{"branches[0].messages", "branches[0].messages: a branch has 1 to 500 messages", func(in *ImportInput) {
			in.Branches[0].Messages = b21Messages("b", ImportMaxBranchMessages+1)
		}},
		{"chapterCuts", "chapterCuts: an import has at most 50 chapter cuts", func(in *ImportInput) {
			in.ChapterCuts = make([]ImportChapterCut, ImportMaxChapterCuts+1)
		}},
	}
	for _, c := range cases {
		in := base()
		c.mutate(&in)
		_, err := PlanImport(in, DefaultLimits(), nil, time.Now())
		e := AsError(err, DefaultLimits())
		if e == nil || e.Code != CodeInvalidInput || e.Extra["field"] != c.field || e.Message != c.message {
			t.Fatalf("%s: err = %v", c.field, err)
		}
	}
}

func TestPlanImport_MilestoneLimitStillCapsTheCuts(t *testing.T) {
	in := ImportInput{Messages: b21Messages("m", 20)}
	for i := range 10 {
		in.ChapterCuts = append(in.ChapterCuts, ImportChapterCut{AnchorExternalID: fmt.Sprintf("m-%d", i*2), Title: "t"})
	}
	l := DefaultLimits()
	l.Chapters.MilestoneMaxPerTree = 9
	_, err := PlanImport(in, l, nil, time.Now())
	if e := AsError(err, l); e == nil || e.Extra["field"] != "chapterCuts" || e.Message != "chapterCuts: an import has at most 9 chapter cuts" {
		t.Fatalf("err = %v", err)
	}
}
