package tangent_test

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// A host section marked Trailing (data that changes every turn, such as
// a host plan or blackboard) lands behind the summary, outside the
// cacheable prefix; an unmarked one stays in the prefix as before. Both
// count towards the host's budget share, show in the preview and come back
// the same from LoadTurn.
func TestPrompt_AHostSectionCanTrailOutsideTheCachedPrefix(t *testing.T) {
	calls := 0
	host := contributorFunc(func(context.Context, tangent.Scope, domain.LineView) ([]domain.PromptSection, error) {
		calls++
		return []domain.PromptSection{
			{Key: "tools", Title: "Host tools", Body: "STABLE-HOST"},
			{Key: "plan", Title: "Host plan", Body: fmt.Sprintf("VOLATILE-HOST step %d", calls), Trailing: true},
		}, nil
	})
	e := newEnv(t, tangent.WithPromptContributor(host))
	main := e.mainLine()
	e.turn(main.ID, "q", "a")
	e.summarized(main.ID)

	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next")
	if err != nil {
		t.Fatal(err)
	}
	stable, volatile, _ := preview.Prompt.ChatBlocks()
	if !strings.Contains(stable, "STABLE-HOST") || strings.Contains(stable, "VOLATILE-HOST") || !strings.Contains(volatile, "VOLATILE-HOST") {
		t.Fatalf("stable:\n%s\nvolatile:\n%s", stable, volatile)
	}
	system, _ := preview.Prompt.Chat()
	if strings.Index(system, "remember the summary") > strings.Index(system, "VOLATILE-HOST") {
		t.Fatalf("the trailing host section comes after the summary:\n%s", system)
	}
	keys := []string{}
	for _, b := range preview.Blocks {
		keys = append(keys, b.Key)
	}
	if !slicesIndexBefore(keys, "tools", tangent.PreviewSummary) || !slicesIndexBefore(keys, tangent.PreviewSummary, "plan") {
		t.Fatalf("preview blocks: %v", keys)
	}
	hostShare := 0
	for _, share := range preview.Budget.Shares {
		if share.Owner == tangent.BudgetHost {
			hostShare = share.Tokens
		}
	}
	want := domain.EstimateInputTokens(domain.PromptInput{HostSections: []domain.PromptSection{
		{Key: "tools", Title: "Host tools", Body: "STABLE-HOST"}, {Key: "plan", Title: "Host plan", Body: fmt.Sprintf("VOLATILE-HOST step %d", calls), Trailing: true},
	}})
	if hostShare != want || want == 0 {
		t.Fatalf("host share %d, want %d: %+v", hostShare, want, preview.Budget.Shares)
	}

	begun, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "again"})
	if err != nil {
		t.Fatal(err)
	}
	calls-- // the host's data did not move between the two builds
	loaded, err := e.engine.LoadTurn(e.ctx, scopeA, begun.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded.Prompt, begun.Prompt) || len(begun.Prompt.Trailing) == 0 {
		t.Fatalf("LoadTurn rebuilds it the same way:\n got %+v\nwant %+v", loaded.Prompt.Trailing, begun.Prompt.Trailing)
	}
}

// slicesIndexBefore reports whether a occurs before b in keys.
func slicesIndexBefore(keys []string, a, b string) bool {
	ia, ib := -1, -1
	for i, k := range keys {
		if k == a && ia < 0 {
			ia = i
		}
		if k == b && ib < 0 {
			ib = i
		}
	}
	return ia >= 0 && ib >= 0 && ia < ib
}
