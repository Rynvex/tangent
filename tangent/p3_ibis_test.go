package tangent_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// ibisEnv is an engine with notes, chapters, asides, leaf and ibis in mode,
// tagging after every reply.
func ibisEnv(t *testing.T, mode tangent.Mode, opts ...tangent.Option) *env {
	t.Helper()
	limits := domain.DefaultLimits()
	limits.Ibis.Every = 1
	return newEnvWith(t, ibisFeatures(mode), append([]tangent.Option{tangent.WithLimits(limits)}, opts...)...)
}

func ibisFeatures(mode tangent.Mode) []tangent.Feature {
	return []tangent.Feature{tangent.Notes(), tangent.Chapters(), tangent.Aside(), tangent.Leaf(tangent.ModeManual), tangent.Ibis(mode)}
}

func TestIbis_TagsEveryThirdReplyByDefault(t *testing.T) {
	e := newEnvWith(t, ibisFeatures(tangent.ModeSuggest))
	main := e.mainLine()
	for i := range 2 {
		if done := e.turn(main.ID, fmt.Sprintf("q%d", i), "a"); len(jobsOf(tangent.JobKindIbisTag, done.Jobs...)) != 0 {
			t.Fatalf("reply %d: no tagging yet", i+1)
		}
	}
	job := tagJob(t, e.turn(main.ID, "q2", "a"))
	if strings.Count(job.Prompt.UserMessage, "> M") != 6 {
		t.Fatalf("the third reply tags the three exchanges:\n%s", job.Prompt.UserMessage)
	}
}

func TestIbis_TheFisheyeWeighsAConfirmedDecision(t *testing.T) {
	e := newEnvWith(t, []tangent.Feature{tangent.Leaf(tangent.ModeManual), tangent.Fisheye(), tangent.Ibis(tangent.ModeManual)})
	main := e.mainLine()
	for i := range 10 {
		e.turn(main.ID, fmt.Sprintf("q%d", i), fmt.Sprintf("a%d", i))
	}
	messages, _ := e.engine.ListMessages(e.ctx, scopeA, main.ID, 0, 50)
	if _, err := e.engine.TagMessage(e.ctx, scopeA, messages[2].ID, domain.TagDecision); err != nil {
		t.Fatal(err)
	}
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next")
	if err != nil {
		t.Fatal(err)
	}
	scores := map[string]int{}
	for _, item := range preview.Fisheye.Items {
		scores[item.ID] = item.Score
	}
	if scores[messages[2].ID] != scores[messages[3].ID]+domain.FisheyeDecisionBonus {
		t.Fatalf("the decision has a head start: %v", scores)
	}
}

// tagJob is the ibis_tag job a completed turn started.
func tagJob(t *testing.T, done tangent.CompletedTurn) tangent.Job {
	t.Helper()
	jobs := jobsOf(tangent.JobKindIbisTag, done.Jobs...)
	if len(jobs) != 1 {
		t.Fatalf("one ibis_tag job, got %+v", done.Jobs)
	}
	return jobs[0]
}

func TestIbis_TheOperatorTagsAndUntagsAMessage(t *testing.T) {
	e := ibisEnv(t, tangent.ModeManual)
	main := e.mainLine()
	done := e.turn(main.ID, "Why does it refuse?", "Because of the borrow.")
	if len(jobsOf(tangent.JobKindIbisTag, done.Jobs...)) != 0 {
		t.Fatal("manual: no tagging job")
	}
	e.rollsBack("tag", func(opt tangent.TxOption) error {
		_, err := e.engine.TagMessage(e.ctx, scopeA, done.Message.ID, domain.TagIdea, opt)
		return err
	})
	e.events.Reset()
	tagged, err := e.engine.TagMessage(e.ctx, scopeA, done.Message.ID, domain.TagIdea)
	if err != nil || tagged.Tag == nil || tagged.Tag.Kind != domain.TagIdea || tagged.Tag.Source != domain.TagSourceUser {
		t.Fatalf("tagged = %+v %v", tagged, err)
	}
	e.wantTypes(tangent.EventMessageUpdated)
	if ev := e.events.OfType(tangent.EventMessageUpdated)[0]; ev.RootLineID != main.ID || ev.Data.(domain.Message).Tag.Kind != domain.TagIdea {
		t.Fatalf("event = %+v", ev)
	}
	e.events.Reset()
	if _, err := e.engine.TagMessage(e.ctx, scopeA, done.Message.ID, domain.TagIdea); err != nil {
		t.Fatal(err)
	}
	e.wantTypes()
	messages, _ := e.engine.ListMessages(e.ctx, scopeA, main.ID, 0, 10)
	if messages[1].Tag == nil || messages[0].Tag != nil {
		t.Fatalf("the transcript carries the tag: %+v", messages)
	}
	untagged, err := e.engine.UntagMessage(e.ctx, scopeA, done.Message.ID)
	if err != nil || untagged.Tag != nil {
		t.Fatalf("untagged = %+v %v", untagged, err)
	}
	e.wantTypes(tangent.EventMessageUpdated)
	if _, err := e.engine.TagMessage(e.ctx, scopeB, done.Message.ID, domain.TagIdea); domain.CodeOf(err) != domain.CodeMessageNotFound {
		t.Fatalf("another tenant: %v", err)
	}
}

func TestIbis_SuggestTagsTheTurnsAsDraftsAndKeepsTheOperatorsTags(t *testing.T) {
	e := ibisEnv(t, tangent.ModeSuggest)
	main := e.mainLine()
	first := e.turn(main.ID, "Which disks?", "Two 8TB disks.")
	job := tagJob(t, first)
	text := job.Prompt.UserMessage
	for _, want := range []string{domain.IbisTagMarker, "> M1 (operator): Which disks?", "> M2 (agent): Two 8TB disks."} {
		if !strings.Contains(text, want) {
			t.Fatalf("prompt lacks %q:\n%s", want, text)
		}
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, job.ID, domain.IbisTagMarker+`{"tags":[{"message":"M1","kind":"question"},{"message":"M2","kind":"idea"}]}`, nil); err != nil {
		t.Fatal(err)
	}
	updated := e.events.OfType(tangent.EventMessageUpdated)
	if len(updated) != 2 {
		t.Fatalf("events = %v", e.events.Types())
	}
	for _, ev := range updated {
		tag := ev.Data.(domain.Message).Tag
		if tag == nil || tag.Source != domain.TagSourceAI || tag.Status != domain.TagStatusDraft {
			t.Fatalf("a model's tag waits as a draft: %+v", ev.Data)
		}
	}
	if _, err := e.engine.TagMessage(e.ctx, scopeA, first.Message.ID, domain.TagDecision); err != nil {
		t.Fatal(err)
	}
	second := e.turn(main.ID, "And the case?", "A quiet one.")
	next := tagJob(t, second)
	if strings.Contains(next.Prompt.UserMessage, "Which disks?") || !strings.Contains(next.Prompt.UserMessage, "> M1 (operator): And the case?") {
		t.Fatalf("only the new messages:\n%s", next.Prompt.UserMessage)
	}
	if err := e.engine.FinishJob(e.ctx, next.ID, domain.IbisTagMarker+`{"tags":[{"message":"M1","kind":"question"}]}`, nil); err != nil {
		t.Fatal(err)
	}
	messages, _ := e.engine.ListMessages(e.ctx, scopeA, main.ID, 0, 10)
	if messages[1].Tag.Kind != domain.TagDecision || messages[1].Tag.Source != domain.TagSourceUser || messages[2].Tag.Kind != domain.TagQuestion || messages[3].Tag != nil {
		t.Fatalf("tags = %+v", messages)
	}
}

func TestIbis_AutoConfirmsAndAFailedRunPublishesJobFailed(t *testing.T) {
	e := ibisEnv(t, tangent.ModeAuto)
	main := e.mainLine()
	done := e.turn(main.ID, "Ship it?", "Yes.")
	if err := e.engine.FinishJob(e.ctx, tagJob(t, done).ID, domain.IbisTagMarker+`{"tags":[{"message":"M2","kind":"decision"}]}`, nil); err != nil {
		t.Fatal(err)
	}
	messages, _ := e.engine.ListMessages(e.ctx, scopeA, main.ID, 0, 10)
	if tag := messages[1].Tag; tag == nil || tag.Status != domain.TagStatusConfirmed || tag.Kind != domain.TagDecision {
		t.Fatalf("auto confirms: %+v", messages[1])
	}
	again := e.turn(main.ID, "Really?", "Really.")
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, tagJob(t, again).ID, "no marker here", nil); err != nil {
		t.Fatal(err)
	}
	failed := e.events.OfType(tangent.EventJobFailed)
	if len(failed) != 1 || failed[0].Data.(tangent.JobFailed).Kind != tangent.JobKindIbisTag || failed[0].Data.(tangent.JobFailed).Error.Code != domain.JobErrorUnusable {
		t.Fatalf("events = %v", e.events.Types())
	}
	third := e.turn(main.ID, "Sure?", "Sure.")
	if !strings.Contains(tagJob(t, third).Prompt.UserMessage, "Really?") {
		t.Fatal("a failed job does not move the cursor")
	}
}

func TestIbis_AnAsideIsNotTaggedAndOffKeepsTheTags(t *testing.T) {
	policy := &switchPolicy{off: map[string]bool{}}
	e := ibisEnv(t, tangent.ModeSuggest, tangent.WithFeaturePolicy(policy))
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	aside, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Purpose: "quick", Kind: domain.BranchKindAside})
	if err != nil {
		t.Fatal(err)
	}
	if done := e.turn(aside.Line.ID, "one question", "one answer"); len(jobsOf(tangent.JobKindIbisTag, done.Jobs...)) != 0 {
		t.Fatalf("an aside is not tagged: %+v", done.Jobs)
	}
	if _, err := e.engine.TagMessage(e.ctx, scopeA, anchor.Message.ID, domain.TagIdea); err != nil {
		t.Fatal(err)
	}
	branch := e.branch(main.ID, anchor.Message.ID, "look")
	if views, _ := e.engine.ListBranches(e.ctx, scopeA, main.ID, false); len(views) != 1 || views[0].AnchorTag == nil || views[0].AnchorTag.Kind != domain.TagIdea || views[0].LineID != branch.Line.ID {
		t.Fatalf("the outline carries the anchor's tag: %+v", views)
	}
	policy.set(tangent.FeatureIbis, true)
	if _, err := e.engine.UntagMessage(e.ctx, scopeA, anchor.Message.ID); domain.CodeOf(err) != domain.CodeFeatureDisabled {
		t.Fatalf("off: %v", err)
	}
	if done := e.turn(main.ID, "q2", "a2"); len(jobsOf(tangent.JobKindIbisTag, done.Jobs...)) != 0 {
		t.Fatal("off: no tagging job")
	}
	if messages, _ := e.engine.ListMessages(e.ctx, scopeA, main.ID, 0, 10); messages[1].Tag == nil {
		t.Fatal("off: the stored tag is kept")
	}
}
