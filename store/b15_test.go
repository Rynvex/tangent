package store_test

import (
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestRelationKind_CreateDefaultsAndRefusals(t *testing.T) {
	f := newFixture(t)
	main, anchor, branch := f.treeWithBranch()
	other := f.branch(main.ID, anchor.ID)
	plain, err := f.relate(main.ID, store.RelationEnd{LineID: branch.ID}, store.RelationEnd{LineID: other.ID}, "plain")
	if err != nil || plain.Link.RelationKind != domain.RelationKindRelated {
		t.Fatalf("no kind is related: %+v %v", plain, err)
	}
	contradicts, err := f.store.CreateRelation(f.ctx, store.CreateRelationInput{
		Tenant: tenant, LineID: main.ID, From: store.RelationEnd{LineID: main.ID}, To: store.RelationEnd{LineID: branch.ID}, RelationKind: " contradicts ",
	})
	if err != nil || contradicts.Link.RelationKind != domain.RelationKindContradicts {
		t.Fatalf("contradicts = %+v %v", contradicts, err)
	}
	if _, err := f.store.CreateRelation(f.ctx, store.CreateRelationInput{
		Tenant: tenant, LineID: main.ID, From: store.RelationEnd{LineID: main.ID}, To: store.RelationEnd{LineID: other.ID}, RelationKind: "opposes",
	}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("an unknown kind: %v", err)
	}
	listed := f.relations(main.ID)
	if len(listed) != 2 || listed[0].RelationKind != domain.RelationKindContradicts || listed[1].RelationKind != domain.RelationKindRelated {
		t.Fatalf("the listing carries the kinds: %+v", listed)
	}
}

func TestRelationKind_UpdateKeepsWhatIsNotGiven(t *testing.T) {
	f := newFixture(t)
	main, _, branch := f.treeWithBranch()
	created, err := f.relate(main.ID, store.RelationEnd{LineID: main.ID}, store.RelationEnd{LineID: branch.ID}, "first")
	if err != nil {
		t.Fatal(err)
	}
	id := created.Link.ID
	kind := domain.RelationKindDependsOn
	changed, err := f.store.UpdateRelation(f.ctx, tenant, main.ID, id, store.RelationEdit{RelationKind: &kind})
	if err != nil || changed.Link.Label != "first" || changed.Link.RelationKind != domain.RelationKindDependsOn {
		t.Fatalf("kind only = %+v %v", changed, err)
	}
	relabelled, err := f.store.UpdateRelationLabel(f.ctx, tenant, main.ID, id, "second")
	if err != nil || relabelled.Link.Label != "second" || relabelled.Link.RelationKind != domain.RelationKindDependsOn {
		t.Fatalf("label only keeps the kind = %+v %v", relabelled, err)
	}
	for _, blank := range []string{"", "  "} {
		_, err := f.store.UpdateRelation(f.ctx, tenant, main.ID, id, store.RelationEdit{RelationKind: &blank})
		var refusal *domain.Error
		if !errors.As(err, &refusal) || refusal.Code != domain.CodeInvalidInput || refusal.Extra["field"] != "relationKind" {
			t.Fatalf("an empty kind on edit is refused (%q): %v", blank, err)
		}
	}
	if n := f.count(`SELECT count(*) FROM tangent_link WHERE relation_kind = 'depends_on' AND label = 'second' AND id = $1`, id); n != 1 {
		t.Fatalf("a refused empty kind wrote: %d", n)
	}
	empty, back := "", domain.RelationKindRelated
	both, err := f.store.UpdateRelation(f.ctx, tenant, branch.ID, id, store.RelationEdit{Label: &empty, RelationKind: &back})
	if err != nil || both.Link.Label != "" || both.Link.RelationKind != domain.RelationKindRelated {
		t.Fatalf("an empty label clears it, the kind goes back to related = %+v %v", both, err)
	}
	none, err := f.store.UpdateRelation(f.ctx, tenant, main.ID, id, store.RelationEdit{})
	if err != nil || none.Link.Label != "" || none.Link.RelationKind != domain.RelationKindRelated {
		t.Fatalf("neither field keeps both = %+v %v", none, err)
	}
	bad := "Supports"
	if _, err := f.store.UpdateRelation(f.ctx, tenant, main.ID, id, store.RelationEdit{RelationKind: &bad}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("an unknown kind: %v", err)
	}
	if _, err := f.store.UpdateRelation(f.ctx, otherTenant, main.ID, id, store.RelationEdit{RelationKind: &kind}); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
	if n := f.count(`SELECT count(*) FROM tangent_link WHERE relation_kind = 'related' AND id = $1`, id); n != 1 {
		t.Fatalf("a refused edit wrote: %d", n)
	}
}

func TestTagDrafts_PutBackAndListTheTree(t *testing.T) {
	f := newFixture(t)
	main, reply := f.mainLine()
	branch := f.branch(main.ID, reply.ID)
	branchReply := f.reply(branch.ID)
	later := f.reply(main.ID)
	otherMain, otherReply := f.mainLine()
	draft := func(messageID, kind string) store.TaggedMessage {
		t.Helper()
		out, err := f.store.SetMessageTag(f.ctx, tenant, messageID, store.TagInput{Kind: kind, Status: domain.TagStatusDraft}, "chang")
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	put := draft(branchReply.ID, domain.TagPro)
	if !put.Changed || *put.Message.Tag != (domain.MessageTag{Kind: domain.TagPro, Source: domain.TagSourceAI, Status: domain.TagStatusDraft, UpdatedAt: put.Message.Tag.UpdatedAt}) {
		t.Fatalf("a draft is the model's: %+v", put)
	}
	if again := draft(branchReply.ID, domain.TagPro); again.Changed {
		t.Fatalf("the same draft again changes nothing: %+v", again)
	}
	draft(later.ID, domain.TagIdea)
	draft(reply.ID, domain.TagQuestion)
	draft(otherReply.ID, domain.TagCon)
	if _, err := f.store.TagMessage(f.ctx, tenant, later.ID, domain.TagIdea, "chang"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.SetMessageTag(f.ctx, tenant, reply.ID, store.TagInput{Kind: domain.TagIdea, Status: "pending"}, "chang"); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("an unknown status: %v", err)
	}

	listed, err := f.store.ListTagDrafts(f.ctx, tenant, branch.ID)
	if err != nil || listed.RootLineID != main.ID || listed.Truncated || len(listed.Drafts) != 2 {
		t.Fatalf("drafts = %+v %v", listed, err)
	}
	first, second := listed.Drafts[0], listed.Drafts[1]
	if first.LineID != main.ID || first.MessageID != reply.ID || first.Role != domain.RoleAssistant || first.Content != "answer" || first.Tag.Kind != domain.TagQuestion ||
		second.LineID != branch.ID || second.MessageID != branchReply.ID || second.Tag.Status != domain.TagStatusDraft || second.Seq != branchReply.Seq {
		t.Fatalf("the main line first, then the branches; confirmed tags and other trees left out: %+v", listed.Drafts)
	}
	if other, err := f.store.ListTagDrafts(f.ctx, tenant, otherMain.ID); err != nil || len(other.Drafts) != 1 || other.Drafts[0].MessageID != otherReply.ID {
		t.Fatalf("the other tree = %+v %v", other, err)
	}
	if _, err := f.store.ListTagDrafts(f.ctx, otherTenant, main.ID); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
	if fresh, err := f.store.ListTagDrafts(f.ctx, tenant, f.branch(main.ID, later.ID).ID); err != nil || fresh.RootLineID != main.ID || len(fresh.Drafts) != 2 {
		t.Fatalf("any line of the tree: %+v %v", fresh, err)
	}
}

func TestTagDrafts_TheCapIsTruncated(t *testing.T) {
	f := newFixture(t)
	main, reply := f.mainLine()
	f.exec(`INSERT INTO tangent_message (line_id, tenant_id, role, content)
		SELECT $1, $2, 'assistant', 'n' || g FROM generate_series(1, $3::int) g`, main.ID, tenant, store.TagDraftsMax)
	f.exec(`INSERT INTO tangent_message_tag (message_id, tenant_id, kind, source, status)
		SELECT id, tenant_id, 'idea', 'ai', 'draft' FROM tangent_message WHERE line_id = $1`, main.ID)
	listed, err := f.store.ListTagDrafts(f.ctx, tenant, main.ID)
	if err != nil || !listed.Truncated || len(listed.Drafts) != store.TagDraftsMax || listed.Drafts[1].MessageID != reply.ID {
		t.Fatalf("drafts = %d truncated %v %v", len(listed.Drafts), listed.Truncated, err)
	}
}

func TestTagDrafts_ContentIsASnippet(t *testing.T) {
	f := newFixture(t)
	main, short := f.mainLine()
	long := f.message(main.ID, domain.RoleAssistant, strings.Repeat("借", domain.TagDraftContentRunes+50))
	exact := f.message(main.ID, domain.RoleAssistant, strings.Repeat("é", domain.TagDraftContentRunes))
	for _, m := range []domain.Message{short, long, exact} {
		if _, err := f.store.SetMessageTag(f.ctx, tenant, m.ID, store.TagInput{Kind: domain.TagIdea, Status: domain.TagStatusDraft}, "chang"); err != nil {
			t.Fatal(err)
		}
	}
	listed, err := f.store.ListTagDrafts(f.ctx, tenant, main.ID)
	if err != nil || len(listed.Drafts) != 3 {
		t.Fatalf("drafts = %+v %v", listed, err)
	}
	want := strings.Repeat("借", domain.TagDraftContentRunes-1) + "…"
	if got := listed.Drafts[1].Content; got != want || utf8.RuneCountInString(got) != domain.TagDraftContentRunes {
		t.Fatalf("a long message is cut to %d runes: %d %q", domain.TagDraftContentRunes, utf8.RuneCountInString(got), got)
	}
	if listed.Drafts[0].Content != "answer" || listed.Drafts[2].Content != exact.Content {
		t.Fatalf("a message within the snippet is whole: %+v", listed.Drafts)
	}
}

func TestTagDrafts_DiscardedBranchesAreLeftOut(t *testing.T) {
	f := newFixture(t)
	main, reply := f.mainLine()
	discarded, merged := f.branch(main.ID, reply.ID), f.branch(main.ID, reply.ID)
	inDiscarded, inMerged := f.reply(discarded.ID), f.reply(merged.ID)
	for _, m := range []domain.Message{reply, inDiscarded, inMerged} {
		if _, err := f.store.SetMessageTag(f.ctx, tenant, m.ID, store.TagInput{Kind: domain.TagPro, Status: domain.TagStatusDraft}, "chang"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.store.DiscardBranch(f.ctx, tenant, discarded.ID); err != nil {
		t.Fatal(err)
	}
	f.exec(`UPDATE tangent_branch SET status = 'merged', closed_at = now() WHERE line_id = $1`, merged.ID)
	listed, err := f.store.ListTagDrafts(f.ctx, tenant, discarded.ID)
	if err != nil || listed.RootLineID != main.ID || len(listed.Drafts) != 2 ||
		listed.Drafts[0].MessageID != reply.ID || listed.Drafts[1].MessageID != inMerged.ID {
		t.Fatalf("a discarded branch's drafts are left out, a merged one's stay: %+v %v", listed, err)
	}
}
