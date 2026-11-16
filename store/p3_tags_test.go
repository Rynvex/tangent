package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestTags_PutChangeAndRemove(t *testing.T) {
	f := newFixture(t)
	main, reply := f.mainLine()
	tagged, err := f.store.TagMessage(f.ctx, tenant, reply.ID, domain.TagIdea, "chang")
	if err != nil || !tagged.Changed || tagged.RootLineID != main.ID || tagged.Message.Tag == nil ||
		*tagged.Message.Tag != (domain.MessageTag{Kind: domain.TagIdea, Source: domain.TagSourceUser, Status: domain.TagStatusConfirmed, UpdatedAt: tagged.Message.Tag.UpdatedAt}) {
		t.Fatalf("tagged = %+v %v", tagged, err)
	}
	again, err := f.store.TagMessage(f.ctx, tenant, reply.ID, domain.TagIdea, "chang")
	if err != nil || again.Changed {
		t.Fatalf("the same tag again changes nothing: %+v %v", again, err)
	}
	changed, err := f.store.TagMessage(f.ctx, tenant, reply.ID, domain.TagCon, "lee")
	if err != nil || !changed.Changed || changed.Message.Tag.Kind != domain.TagCon {
		t.Fatalf("changed = %+v %v", changed, err)
	}
	listed, err := f.store.ListMessages(f.ctx, tenant, main.ID, 0, 10)
	if err != nil || listed[0].Tag != nil || listed[1].Tag == nil || listed[1].Tag.Kind != domain.TagCon {
		t.Fatalf("the transcript carries the tags: %+v %v", listed, err)
	}
	untagged, err := f.store.UntagMessage(f.ctx, tenant, reply.ID)
	if err != nil || !untagged.Changed || untagged.Message.Tag != nil {
		t.Fatalf("untagged = %+v %v", untagged, err)
	}
	if none, err := f.store.UntagMessage(f.ctx, tenant, reply.ID); err != nil || none.Changed {
		t.Fatalf("untagging an untagged message changes nothing: %+v %v", none, err)
	}
}

func TestTags_Refusals(t *testing.T) {
	f := newFixture(t)
	main, reply := f.mainLine()
	card := f.card(main.ID)
	pending := f.busy(main.ID)
	cases := []struct {
		name, tenant, message, kind, code string
	}{
		{"bad kind", tenant, reply.ID, "maybe", domain.CodeInvalidInput},
		{"another tenant", otherTenant, reply.ID, domain.TagIdea, domain.CodeMessageNotFound},
		{"bad id", tenant, "x", domain.TagIdea, domain.CodeMessageNotFound},
		{"a card", tenant, card.ID, domain.TagIdea, domain.CodeInvalidInput},
		{"a pending reply", tenant, pending.Pending.ID, domain.TagIdea, domain.CodeInvalidInput},
	}
	for _, c := range cases {
		if _, err := f.store.TagMessage(f.ctx, c.tenant, c.message, c.kind, "chang"); domain.CodeOf(err) != c.code {
			t.Fatalf("%s: %v", c.name, err)
		}
	}
	f.answer(pending.Pending.ID, "done")
	f.exec(`UPDATE tangent_line SET archived_at = now() WHERE id = $1`, main.ID)
	if _, err := f.store.TagMessage(f.ctx, tenant, reply.ID, domain.TagIdea, "chang"); domain.CodeOf(err) != domain.CodeArchived {
		t.Fatalf("archived: %v", err)
	}
	refused := errors.New("no")
	f.exec(`UPDATE tangent_line SET archived_at = NULL WHERE id = $1`, main.ID)
	if _, err := f.store.TagMessage(f.ctx, tenant, reply.ID, domain.TagIdea, "chang", func(context.Context, store.Tx, any) error { return refused }); !errors.Is(err, refused) {
		t.Fatalf("a hook rolls back: %v", err)
	}
	if n := f.count(`SELECT count(*) FROM tangent_message_tag`); n != 0 {
		t.Fatalf("%d tags after a rollback", n)
	}
}

func TestTags_TheAnchorTagShowsInTheOutline(t *testing.T) {
	f := newFixture(t)
	main, reply := f.mainLine()
	branch := f.branch(main.ID, reply.ID)
	if view := f.branchView(branch.ID); view.AnchorTag != nil {
		t.Fatalf("no tag yet: %+v", view.AnchorTag)
	}
	if _, err := f.store.TagMessage(f.ctx, tenant, reply.ID, domain.TagQuestion, "chang"); err != nil {
		t.Fatal(err)
	}
	views, err := f.store.ListBranches(f.ctx, tenant, main.ID, true)
	if err != nil || len(views) != 1 || views[0].AnchorTag == nil || views[0].AnchorTag.Kind != domain.TagQuestion || views[0].AnchorTag.Source != domain.TagSourceUser {
		t.Fatalf("outline = %+v %v", views, err)
	}
}

func TestTags_AModelTagsOnlyUntaggedMessagesAfterItsLastJob(t *testing.T) {
	f := newFixture(t)
	main, first := f.mainLine()
	if _, err := f.store.TagMessage(f.ctx, tenant, first.ID, domain.TagDecision, "chang"); err != nil {
		t.Fatal(err)
	}
	candidates, err := f.store.IbisCandidates(f.ctx, main.ID, first.Seq, 12)
	if err != nil || len(candidates.Messages) != 1 || candidates.Messages[0].Role != domain.RoleUser || candidates.UptoSeq != first.Seq {
		t.Fatalf("candidates = %+v %v", candidates, err)
	}
	job := f.ibisJob(main.ID, candidates.UptoSeq)
	question := candidates.Messages[0]
	if _, err := f.store.TagMessage(f.ctx, tenant, question.ID, domain.TagIdea, "chang"); err != nil {
		t.Fatal(err)
	}
	done, err := f.store.FinishIbisTags(f.ctx, job.ID, []store.AITag{{MessageID: question.ID, Kind: domain.TagQuestion}, {MessageID: first.ID, Kind: domain.TagCon}}, domain.TagStatusDraft, "")
	if err != nil || done.Job.Status != store.JobDone || len(done.Messages) != 0 || done.RootLineID != main.ID {
		t.Fatalf("the operator's tags stay: %+v %v", done, err)
	}
	tags := f.tagsOf(main.ID)
	if tags[question.ID] != domain.TagIdea || tags[first.ID] != domain.TagDecision {
		t.Fatalf("tags = %v", tags)
	}
	later := f.reply(main.ID)
	next, err := f.store.IbisCandidates(f.ctx, main.ID, later.Seq, 12)
	if err != nil || len(next.Messages) != 2 || next.Messages[1].ID != later.ID || next.UptoSeq != later.Seq {
		t.Fatalf("only messages after the last job: %+v %v", next, err)
	}
	second := f.ibisJob(main.ID, next.UptoSeq)
	written, err := f.store.FinishIbisTags(f.ctx, second.ID, []store.AITag{{MessageID: later.ID, Kind: domain.TagIdea}, {MessageID: "x", Kind: domain.TagIdea}}, domain.TagStatusDraft, "")
	if err != nil || len(written.Messages) != 1 || written.Messages[0].Tag.Source != domain.TagSourceAI || written.Messages[0].Tag.Status != domain.TagStatusDraft {
		t.Fatalf("written = %+v %v", written, err)
	}
	if _, err := f.store.FinishIbisTags(f.ctx, second.ID, nil, domain.TagStatusDraft, ""); domain.CodeOf(err) != domain.CodeJobNotPending {
		t.Fatalf("once: %v", err)
	}
}

func TestTags_AFailedJobTagsNothing(t *testing.T) {
	f := newFixture(t)
	main, reply := f.mainLine()
	job := f.ibisJob(main.ID, reply.Seq)
	done, err := f.store.FinishIbisTags(f.ctx, job.ID, []store.AITag{{MessageID: reply.ID, Kind: domain.TagIdea}}, domain.TagStatusConfirmed, domain.JobUnusableText)
	if err != nil || done.Job.Status != store.JobFailed || len(done.Messages) != 0 || len(f.tagsOf(main.ID)) != 0 {
		t.Fatalf("done = %+v %v", done, err)
	}
	if again, err := f.store.IbisCandidates(f.ctx, main.ID, reply.Seq, 12); err != nil || len(again.Messages) != 2 {
		t.Fatalf("a failed job does not move the cursor: %+v %v", again, err)
	}
}

func TestTags_FollowTheirMessageAndGoWithIt(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	question := f.message(main.ID, domain.RoleUser, "move me")
	f.message(main.ID, domain.RoleAssistant, "moved")
	if _, err := f.store.TagMessage(f.ctx, tenant, question.ID, domain.TagQuestion, "chang"); err != nil {
		t.Fatal(err)
	}
	moved := f.move(main.ID, 2)
	if tags := f.tagsOf(moved.Line.ID); tags[question.ID] != domain.TagQuestion {
		t.Fatalf("the tag moved with its message: %v", tags)
	}
	f.exec(`DELETE FROM tangent_message WHERE id = $1`, question.ID)
	if n := f.count(`SELECT count(*) FROM tangent_message_tag`); n != 0 {
		t.Fatalf("%d tags outlive their message", n)
	}
}

// ibisJob records an ibis_tag job of the line that read up to seq.
func (f *fixture) ibisJob(lineID string, uptoSeq int64) store.Job {
	f.t.Helper()
	input, _ := json.Marshal(map[string]int64{"uptoSeq": uptoSeq})
	job, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: store.JobKindIbisTag, Feature: "ibis", LineID: lineID, Input: input, Supersede: true})
	if err != nil {
		f.t.Fatal(err)
	}
	return job
}

// tagsOf maps the tagged messages of a line to their kinds.
func (f *fixture) tagsOf(lineID string) map[string]string {
	f.t.Helper()
	messages, err := f.store.ListMessages(f.ctx, tenant, lineID, 0, 500)
	if err != nil {
		f.t.Fatal(err)
	}
	out := map[string]string{}
	for _, m := range messages {
		if m.Tag != nil {
			out[m.ID] = m.Tag.Kind
		}
	}
	return out
}
