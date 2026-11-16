package tangent_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// groupFeatures are the fisheye features plus group in the given mode.
func groupFeatures(mode tangent.Mode) []tangent.Feature {
	return append(fisheyeFeatures(), tangent.Group(mode))
}

func groupEnv(t *testing.T, mode tangent.Mode) (*env, *recordingDispatcher) {
	t.Helper()
	e := newEnvWith(t, groupFeatures(mode))
	sink := &recordingDispatcher{}
	e.engine.SetJobDispatcher(sink)
	return e, sink
}

// endedWithLeaf opens a branch with an exchange and discards it with a
// decision leaf.
func (e *env) endedWithLeaf(mainID, anchorID, purpose, leaf string) string {
	e.t.Helper()
	b := e.branch(mainID, anchorID, purpose)
	e.turn(b.Line.ID, "about "+purpose, "noted")
	if _, err := e.engine.DiscardBranchWith(e.ctx, scopeA, b.Line.ID, tangent.DiscardInput{Leaf: &domain.LeafInput{Kind: domain.LeafKindDecision, Line: leaf}}); err != nil {
		e.t.Fatal(err)
	}
	return b.Line.ID
}

func TestGroup_ASummaryStandsForItsMembersInTheFisheye(t *testing.T) {
	e, sink := groupEnv(t, tangent.ModeManual)
	main := e.mainLine()
	anchor := e.turn(main.ID, "which disks?", "let us see")
	a, b := e.endedWithLeaf(main.ID, anchor.Message.ID, "New disks", "8TB new"), e.endedWithLeaf(main.ID, anchor.Message.ID, "Used disks", "too risky")
	c := e.endedWithLeaf(main.ID, anchor.Message.ID, "Cases", "a 4-bay case")
	e.rollsBack("create group", func(opt tangent.TxOption) error {
		_, err := e.engine.CreateGroup(e.ctx, scopeA, main.ID, tangent.GroupInput{MemberLineIDs: []string{a, b}, Title: "Disks"}, opt)
		return err
	})
	e.events.Reset()
	sink.jobs = nil
	created, err := e.engine.CreateGroup(e.ctx, scopeA, main.ID, tangent.GroupInput{MemberLineIDs: []string{a, b}, Title: "Disks"})
	if err != nil || created.Group.Status != domain.GroupActive || created.Job == nil || created.Group.SummaryStatus != domain.GroupSummaryDrafting {
		t.Fatalf("created = %+v %v", created, err)
	}
	if len(sink.jobs) != 1 || sink.jobs[0].Kind != tangent.JobKindGroupSummary || !strings.Contains(sink.jobs[0].Prompt.UserMessage, "> 8TB new") {
		t.Fatalf("the summary job went to the dispatcher: %+v", sink.jobs)
	}
	if got := e.events.OfType(tangent.EventGroupChanged); len(got) != 2 || got[1].Data.(tangent.GroupChange).Group.SummaryStatus != domain.GroupSummaryDrafting {
		t.Fatalf("group.changed = %v", e.events.Types())
	}
	if err := e.engine.FinishJob(e.ctx, sink.jobs[0].ID, domain.GroupSummaryMarker+`{"summary":"New 8TB disks; used ones are too risky."}`, nil); err != nil {
		t.Fatal(err)
	}
	preview, _ := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next")
	items := itemsByID(preview)
	if items[created.Group.ID].Kind != domain.FisheyeItemGroup || items[created.Group.ID].Level != domain.FisheyeLeafOnly {
		t.Fatalf("the group is one item: %+v", preview.Fisheye.Items)
	}
	if _, ok := items[a]; ok || items[c].Level != domain.FisheyeLeafOnly {
		t.Fatalf("members give way to the group; others stay: %+v", preview.Fisheye.Items)
	}
	system, _ := preview.Prompt.Chat()
	if !strings.Contains(system, "> [group] Disks — New 8TB disks; used ones are too risky.") || strings.Contains(system, "8TB new") {
		t.Fatalf("system:\n%s", system)
	}
	e.renameAndDissolve(main.ID, created.Group.ID, a, b)
}

// renameAndDissolve renames and dissolves a group of a and b, and checks
// the members show their own leaves again and another tenant is refused.
func (e *env) renameAndDissolve(mainID, groupID, a, b string) {
	e.t.Helper()
	renamed, err := e.engine.RenameGroup(e.ctx, scopeA, groupID, "Storage")
	if err != nil || renamed.Title != "Storage" {
		e.t.Fatalf("renamed = %+v %v", renamed, err)
	}
	if _, err := e.engine.DissolveGroup(e.ctx, scopeA, groupID); err != nil {
		e.t.Fatal(err)
	}
	after, _ := e.engine.PreviewTurn(e.ctx, scopeA, mainID, "next")
	if itemsByID(after)[a].Level != domain.FisheyeLeafOnly {
		e.t.Fatal("a dissolved group gives its members back")
	}
	list, _ := e.engine.ListGroups(e.ctx, scopeA, mainID, []string{domain.GroupDissolved})
	if len(list.Groups) != 1 {
		e.t.Fatalf("list = %+v", list)
	}
	_, err = e.engine.CreateGroup(e.ctx, scopeB, mainID, tangent.GroupInput{MemberLineIDs: []string{a, b}, Title: "x"})
	wantCode(e.t, err, domain.CodeLineNotFound)
}

func TestGroup_AFailedSummaryIsAJobFailedEvent(t *testing.T) {
	e, sink := groupEnv(t, tangent.ModeManual)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	a, b := e.endedWithLeaf(main.ID, anchor.Message.ID, "A", "x"), e.endedWithLeaf(main.ID, anchor.Message.ID, "B", "y")
	created, _ := e.engine.CreateGroup(e.ctx, scopeA, main.ID, tangent.GroupInput{MemberLineIDs: []string{a, b}, Title: "AB"})
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, sink.jobs[0].ID, "not a summary", nil); err != nil {
		t.Fatal(err)
	}
	failed := e.events.OfType(tangent.EventJobFailed)
	if len(failed) != 1 {
		t.Fatalf("events = %v", e.events.Types())
	}
	data := failed[0].Data.(tangent.JobFailed)
	if data.Kind != tangent.JobKindGroupSummary || data.LineID != main.ID || data.RootLineID != main.ID || data.Error.Code != domain.JobErrorUnusable || data.JobID != sink.jobs[0].ID {
		t.Fatalf("job.failed = %+v", data)
	}
	if group, _ := e.engine.GetGroup(e.ctx, scopeA, created.Group.ID); group.SummaryStatus != domain.GroupSummaryFailed {
		t.Fatalf("group = %+v", group)
	}
	job, err := e.engine.SummarizeGroup(e.ctx, scopeA, created.Group.ID)
	if err != nil || job.Kind != tangent.JobKindGroupSummary {
		t.Fatalf("again: %+v %v", job, err)
	}
	e.exec(`UPDATE tangent_job SET created_at = now() - interval '1 hour' WHERE id = $1`, job.ID)
	e.events.Reset()
	if _, err := e.engine.FailStaleJobs(e.ctx); err != nil {
		t.Fatal(err)
	}
	if got := e.events.OfType(tangent.EventJobFailed); len(got) != 1 || got[0].Data.(tangent.JobFailed).Error.Code != domain.JobErrorTimedOut {
		t.Fatalf("a timed-out summary: %v", e.events.Types())
	}
	if group, _ := e.engine.GetGroup(e.ctx, scopeA, created.Group.ID); group.SummaryStatus != domain.GroupSummaryFailed {
		t.Fatalf("timed out: %+v", group)
	}
}

func TestGroup_CombineWithChoices(t *testing.T) {
	e, _ := groupEnv(t, tangent.ModeManual)
	main := e.mainLine()
	anchor := e.turn(main.ID, "which disks?", "let us see")
	a, b := e.branch(main.ID, anchor.Message.ID, "New disks"), e.branch(main.ID, anchor.Message.ID, "Used disks")
	e.turn(a.Line.ID, "new?", "8TB new is cheapest per TB")
	e.turn(b.Line.ID, "used?", "used enterprise disks are cheaper")
	conflicts := []domain.Conflict{
		{Branch: domain.ConflictSide{LineID: a.Line.ID, Claim: "8TB new is cheapest per TB"}, Other: domain.ConflictSide{LineID: b.Line.ID, Claim: "used ones are cheaper"}, Choice: domain.ChoiceAdoptBranch},
		{Branch: domain.ConflictSide{LineID: a.Line.ID, Claim: "buy now"}, Other: domain.ConflictSide{LineID: b.Line.ID, Claim: "wait for sales"}, Choice: domain.ChoiceKeepBoth},
	}
	in := tangent.CombineInput{LineIDs: []string{a.Line.ID, b.Line.ID}, Purpose: "Disks together", Conflicts: conflicts}
	e.rollsBack("combine", func(opt tangent.TxOption) error {
		_, err := e.engine.CombineBranches(e.ctx, scopeA, main.ID, in, opt)
		return err
	})
	e.events.Reset()
	out, err := e.engine.CombineBranches(e.ctx, scopeA, main.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	pack := out.Pack.Rendered
	for _, want := range []string{"## Combined branches", "### New disks", "8TB new is cheapest per TB", "Settled when combining", "Still to confirm", "buy now"} {
		if !strings.Contains(pack, want) {
			t.Errorf("pack misses %q", want)
		}
	}
	if out.Created.Branch.Origin != domain.BranchOriginMerge || len(out.Combined) != 2 || out.Combined[0].MergedIntoLineID != out.Created.Line.ID || len(out.Notes.Created) != 1 ||
		out.Notes.Created[0].Section != domain.NoteSectionToConfirm || !strings.Contains(out.Notes.Created[0].Text, "New disks: buy now") {
		t.Fatalf("out = %+v", out)
	}
	changes := []string{}
	for _, ev := range e.events.OfType(tangent.EventBranchChanged) {
		changes = append(changes, ev.Data.(tangent.BranchChange).Change)
	}
	if strings.Join(changes, ",") != "created,discarded,discarded" || len(e.events.OfType(tangent.EventNotesChanged)) != 1 {
		t.Fatalf("events = %v (%v)", e.events.Types(), changes)
	}
	e.turn(out.Created.Line.ID, "so?", "ok")
	if !strings.Contains(e.lastSystem(), "Settled when combining") {
		t.Fatal("the new branch's prompt carries the combined background")
	}
}

func TestGroup_KeepBothNeedsNotes(t *testing.T) {
	noNotes := newEnvWith(t, append([]tangent.Feature{tangent.Leaf(tangent.ModeManual)}, tangent.Group(tangent.ModeManual)))
	m := noNotes.mainLine()
	r := noNotes.turn(m.ID, "q", "a")
	x, y := noNotes.branch(m.ID, r.Message.ID, "x"), noNotes.branch(m.ID, r.Message.ID, "y")
	_, err := noNotes.engine.CombineBranches(noNotes.ctx, scopeA, m.ID, tangent.CombineInput{LineIDs: []string{x.Line.ID, y.Line.ID}, Purpose: "p", Conflicts: []domain.Conflict{
		{Branch: domain.ConflictSide{LineID: x.Line.ID, Claim: "a"}, Other: domain.ConflictSide{LineID: y.Line.ID, Claim: "b"}, Choice: domain.ChoiceKeepBoth},
	}})
	wantCode(t, err, domain.CodeFeatureDisabled)
}

func TestGroup_TheModelProposesGroupsAndAcceptingMakesThem(t *testing.T) {
	e, jobs := groupSuggestTree(t)
	keys := keysByPurpose(jobs[0].Prompt.UserMessage)
	newKey, usedKey := keys["New disks"], keys["Used disks"]
	reply := domain.GroupSuggestMarker + `{"groups":[` +
		`{"title":"Disks","members":["` + newKey + `","` + usedKey + `"],"conflicts":[{"branch":"` + newKey + `","other":"` + usedKey + `","branchClaim":"new is cheapest","otherClaim":"used is cheaper"}]},` +
		`{"title":"Cases","members":["` + keys["Case A"] + `","` + keys["Case B"] + `"]}]}`
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, jobs[0].ID, reply, nil); err != nil {
		t.Fatal(err)
	}
	raised := e.events.OfType(tangent.EventSuggestionChanged)
	if len(raised) != 2 {
		t.Fatalf("two proposals: %v", e.events.Types())
	}
	disks, cases := raised[0].Data.(tangent.SuggestionChange).Suggestion, raised[1].Data.(tangent.SuggestionChange).Suggestion
	var payload tangent.GroupSuggestion
	if disks.Kind != tangent.SuggestionKindGroup || json.Unmarshal(disks.Payload, &payload) != nil || len(payload.Conflicts) != 1 || payload.Conflicts[0].ID != "c1" || !payload.Members[0].Ended {
		t.Fatalf("disks = %+v %+v", disks, payload)
	}
	accepted, err := e.engine.AcceptSuggestion(e.ctx, scopeA, disks.ID, json.RawMessage(`{"choices":{"c1":"keepBoth"}}`))
	if err != nil {
		t.Fatal(err)
	}
	result := accepted.Result.(tangent.GroupAccepted)
	if result.Action != tangent.GroupActionGroup || result.Group == nil || len(result.Group.MemberLineIDs) != 2 || result.Notes == nil || len(result.Notes.Created) != 1 {
		t.Fatalf("result = %+v", result)
	}
	combined, err := e.engine.AcceptSuggestion(e.ctx, scopeA, cases.ID, json.RawMessage(`{"action":"combine","purpose":"Pick the case"}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := combined.Result.(tangent.GroupAccepted); got.Action != tangent.GroupActionCombine || got.Combined == nil || got.Combined.Created.Branch.Purpose != "Pick the case" {
		t.Fatalf("combined = %+v", got)
	}
}

// groupSuggestTree ends two branches with leaves, opens two with a reply,
// then ends a third; it returns the env and the group_suggest job that
// raised.
func groupSuggestTree(t *testing.T) (*env, []tangent.Job) {
	t.Helper()
	e, sink := groupEnv(t, tangent.ModeSuggest)
	main := e.mainLine()
	anchor := e.turn(main.ID, "which disks?", "let us see")
	e.endedWithLeaf(main.ID, anchor.Message.ID, "New disks", "8TB new")
	if len(jobsOf(tangent.JobKindGroupSuggest, sink.jobs...)) != 0 {
		t.Fatal("one candidate is not enough")
	}
	e.endedWithLeaf(main.ID, anchor.Message.ID, "Used disks", "too risky")
	open1, open2 := e.branch(main.ID, anchor.Message.ID, "Case A"), e.branch(main.ID, anchor.Message.ID, "Case B")
	e.turn(open1.Line.ID, "4 bays?", "yes")
	e.turn(open2.Line.ID, "6 bays?", "maybe")
	sink.jobs = nil
	e.endedWithLeaf(main.ID, anchor.Message.ID, "Cables", "SATA is fine")
	jobs := jobsOf(tangent.JobKindGroupSuggest, sink.jobs...)
	if len(jobs) != 1 {
		t.Fatalf("a suggestion job after a branch ended: %+v", sink.jobs)
	}
	return e, jobs
}

// keysByPurpose maps the purposes a group_suggest prompt lists to their
// keys ("> B1 (ended): New disks — 8TB new").
func keysByPurpose(prompt string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(prompt, "\n") {
		key, rest, ok := strings.Cut(strings.TrimPrefix(line, "> "), " (")
		if !ok || !strings.HasPrefix(line, "> B") {
			continue
		}
		_, purpose, _ := strings.Cut(rest, "): ")
		purpose, _, _ = strings.Cut(purpose, " — ")
		out[purpose] = key
	}
	return out
}

var errSomething = errors.New("the runner is down")

func TestJobFailed_TheGoalAndRelationJobsReportFailures(t *testing.T) {
	e, _ := p2Env(t, tangent.ModeSuggest)
	main := e.mainLine()
	e.turn(main.ID, "q", "a")
	job, _ := e.engine.ProposeGoal(e.ctx, scopeA, main.ID)
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, job.ID, "", errSomething); err != nil {
		t.Fatal(err)
	}
	failed := e.events.OfType(tangent.EventJobFailed)
	if len(failed) != 1 || failed[0].Data.(tangent.JobFailed).Error.Code != domain.JobErrorRunFailed || failed[0].Data.(tangent.JobFailed).Kind != tangent.JobKindGoalPropose {
		t.Fatalf("events = %v", e.events.Types())
	}
	stale, _ := e.engine.ProposeGoal(e.ctx, scopeA, main.ID)
	e.exec(`UPDATE tangent_job SET created_at = now() - interval '1 hour' WHERE id = $1`, stale.ID)
	e.events.Reset()
	e.engine.FailStaleJobs(e.ctx)
	if got := e.events.OfType(tangent.EventJobFailed); len(got) != 1 || got[0].Data.(tangent.JobFailed).Error.Code != domain.JobErrorTimedOut {
		t.Fatalf("stale: %v", e.events.Types())
	}
}

func TestRelations_UpdateTheLabel(t *testing.T) {
	e, _ := p2Env(t, tangent.ModeManual)
	main, other := e.mainLine(), e.mainLine()
	created, _ := e.engine.CreateRelation(e.ctx, scopeA, main.ID, tangent.RelationInput{To: tangent.RelationEnd{LineID: other.ID}, Label: "old"})
	e.rollsBack("update relation", func(opt tangent.TxOption) error {
		_, err := e.engine.UpdateRelation(e.ctx, scopeA, main.ID, created.Link.ID, "x", opt)
		return err
	})
	e.events.Reset()
	changed, err := e.engine.UpdateRelation(e.ctx, scopeA, other.ID, created.Link.ID, "new")
	if err != nil || changed.Link.Label != "new" {
		t.Fatalf("changed = %+v %v", changed, err)
	}
	e.wantTypes(tangent.EventLinkChanged, tangent.EventLinkChanged)
}

func TestGroup_NeedsLeafAndHasAMode(t *testing.T) {
	e, _ := groupEnv(t, tangent.ModeSuggest)
	if _, err := tangent.New(e.pool, tangent.WithFeatures(tangent.Group(tangent.ModeSuggest))); err == nil {
		t.Fatal("group needs leaf")
	}
	caps, _ := e.engine.Capabilities(e.ctx, scopeA)
	for _, c := range caps {
		if c.Name == tangent.FeatureGroup && c.Mode != "suggest" {
			t.Fatalf("group = %+v", c)
		}
	}
}

func TestGroup_CombineRehangsOpenChildrenOnTheNewBranch(t *testing.T) {
	e, _ := groupEnv(t, tangent.ModeManual)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	a, b := e.branch(main.ID, anchor.Message.ID, "A"), e.branch(main.ID, anchor.Message.ID, "B")
	onA := e.turn(a.Line.ID, "in a", "reply in a")
	e.turn(b.Line.ID, "in b", "reply in b")
	child := e.branch(a.Line.ID, onA.Message.ID, "Child of A")
	e.events.Reset()
	out, err := e.engine.CombineBranches(e.ctx, scopeA, main.ID, tangent.CombineInput{LineIDs: []string{a.Line.ID, b.Line.ID}, Purpose: "AB"})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Reparented) != 1 || out.Reparented[0] != child.Line.ID {
		t.Fatalf("reparented = %v", out.Reparented)
	}
	moved := false
	for _, ev := range e.events.OfType(tangent.EventBranchChanged) {
		change := ev.Data.(tangent.BranchChange)
		if change.Change == tangent.BranchMoved && change.Branch.LineID == child.Line.ID {
			moved = change.Branch.ParentLineID == out.Created.Line.ID && change.Branch.AnchorMessageID == onA.Message.ID
		}
	}
	if !moved {
		t.Fatalf("branch.changed{moved} for the child: %v", e.events.Types())
	}
	updated := map[string]bool{}
	for _, ev := range e.events.OfType(tangent.EventLineUpdated) {
		updated[ev.LineID] = true
	}
	if !updated[a.Line.ID] {
		t.Fatal("the combined branch that lost a child is updated")
	}
	if out.Created.Line.BranchCounts.Open != 1 {
		t.Fatalf("counts = %+v", out.Created.Line.BranchCounts)
	}
	e.turn(child.Line.ID, "still here?", "yes")
}
