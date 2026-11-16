package tangent_test

import (
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

func TestEditRelation_TheKindAloneAndItsEvent(t *testing.T) {
	e, _ := p2Env(t, tangent.ModeManual)
	main := e.mainLine()
	other := e.mainLine()
	created, err := e.engine.CreateRelation(e.ctx, scopeA, main.ID, tangent.RelationInput{To: tangent.RelationEnd{LineID: other.ID}, Label: "rival plan", RelationKind: domain.RelationKindContradicts})
	if err != nil || created.Link.RelationKind != domain.RelationKindContradicts {
		t.Fatalf("created = %+v %v", created, err)
	}
	kind := domain.RelationKindDependsOn
	e.rollsBack("edit relation", func(opt tangent.TxOption) error {
		_, err := e.engine.EditRelation(e.ctx, scopeA, main.ID, created.Link.ID, tangent.RelationEdit{RelationKind: &kind}, opt)
		return err
	})
	e.events.Reset()
	edited, err := e.engine.EditRelation(e.ctx, scopeA, other.ID, created.Link.ID, tangent.RelationEdit{RelationKind: &kind})
	if err != nil || edited.Link.Label != "rival plan" || edited.Link.RelationKind != domain.RelationKindDependsOn {
		t.Fatalf("edited = %+v %v", edited, err)
	}
	e.wantTypes(tangent.EventLinkChanged, tangent.EventLinkChanged)
	if ev := e.events.OfType(tangent.EventLinkChanged)[0].Data.(tangent.LinkChange); ev.Link.RelationKind != domain.RelationKindDependsOn {
		t.Fatalf("the event carries the kind: %+v", ev)
	}
	relabelled, err := e.engine.UpdateRelation(e.ctx, scopeA, main.ID, created.Link.ID, "needs it")
	if err != nil || relabelled.Link.Label != "needs it" || relabelled.Link.RelationKind != domain.RelationKindDependsOn {
		t.Fatalf("UpdateRelation keeps the kind: %+v %v", relabelled, err)
	}
}

func TestSetMessageTag_DraftAndTheTreesDrafts(t *testing.T) {
	e := ibisEnv(t, tangent.ModeManual)
	main := e.mainLine()
	done := e.turn(main.ID, "Why does it refuse?", "Because of the borrow.")
	branch := e.branch(main.ID, done.Message.ID, "the borrow")
	inBranch := e.turn(branch.Line.ID, "which borrow?", "The mutable one.")
	if _, err := e.engine.TagMessage(e.ctx, scopeA, done.Message.ID, domain.TagIdea); err != nil {
		t.Fatal(err)
	}
	e.rollsBack("draft tag", func(opt tangent.TxOption) error {
		_, err := e.engine.SetMessageTag(e.ctx, scopeA, done.Message.ID, tangent.TagInput{Kind: domain.TagIdea, Status: domain.TagStatusDraft}, opt)
		return err
	})
	e.events.Reset()
	back, err := e.engine.SetMessageTag(e.ctx, scopeA, done.Message.ID, tangent.TagInput{Kind: domain.TagIdea, Status: domain.TagStatusDraft})
	if err != nil || back.Tag == nil || back.Tag.Source != domain.TagSourceAI || back.Tag.Status != domain.TagStatusDraft {
		t.Fatalf("back to a draft = %+v %v", back, err)
	}
	e.wantTypes(tangent.EventMessageUpdated)
	if _, err := e.engine.SetMessageTag(e.ctx, scopeA, inBranch.Message.ID, tangent.TagInput{Kind: domain.TagPro, Status: domain.TagStatusDraft}); err != nil {
		t.Fatal(err)
	}
	drafts, err := e.engine.ListTagDrafts(e.ctx, scopeA, branch.Line.ID)
	if err != nil || drafts.RootLineID != main.ID || len(drafts.Drafts) != 2 || drafts.Drafts[0].MessageID != done.Message.ID || drafts.Drafts[1].LineID != branch.Line.ID {
		t.Fatalf("drafts = %+v %v", drafts, err)
	}
	confirmed, err := e.engine.SetMessageTag(e.ctx, scopeA, done.Message.ID, tangent.TagInput{Kind: domain.TagIdea, Status: domain.TagStatusConfirmed})
	if err != nil || confirmed.Tag.Source != domain.TagSourceUser || confirmed.Tag.Status != domain.TagStatusConfirmed {
		t.Fatalf("confirmed = %+v %v", confirmed, err)
	}
	if drafts, _ := e.engine.ListTagDrafts(e.ctx, scopeA, main.ID); len(drafts.Drafts) != 1 {
		t.Fatalf("a confirmed tag leaves the list: %+v", drafts)
	}
	_, err = e.engine.SetMessageTag(e.ctx, scopeA, done.Message.ID, tangent.TagInput{Kind: domain.TagIdea, Status: "maybe"})
	wantCode(t, err, domain.CodeInvalidInput)
}

func TestTagDrafts_NeedTheIbisFeature(t *testing.T) {
	e := newEnvWith(t, nil)
	main := e.mainLine()
	_, err := e.engine.ListTagDrafts(e.ctx, scopeA, main.ID)
	wantCode(t, err, domain.CodeFeatureDisabled)
}
