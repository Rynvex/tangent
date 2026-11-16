package tangent_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

func TestB5_RenameBranchPublishesRenamedAndTheLine(t *testing.T) {
	e := newEnv(t)
	_, branch, _ := e.draftable()
	e.events.Reset()
	view, err := e.engine.RenameBranch(e.ctx, scopeA, branch.Line.ID, "  a clearer purpose ")
	if err != nil || view.Purpose != "a clearer purpose" {
		t.Fatalf("renamed %+v, %v", view, err)
	}
	e.wantTypes(tangent.EventBranchChanged, tangent.EventLineUpdated)
	events := e.events.Events()
	if change := events[0].Data.(tangent.BranchChange); change.Change != tangent.BranchRenamed || change.Branch.Purpose != "a clearer purpose" {
		t.Fatalf("branch.changed %+v", change)
	}
	if line := events[1].Data.(domain.LineView); line.ID != branch.Line.ID || line.Title != "a clearer purpose" {
		t.Fatalf("line.updated %+v", line)
	}
	e.rollsBack("rename", func(opt tangent.TxOption) error {
		_, err := e.engine.RenameBranch(e.ctx, scopeA, branch.Line.ID, "never", opt)
		return err
	})
	_, err = e.engine.RenameBranch(e.ctx, scopeB, branch.Line.ID, "theirs")
	wantCode(t, err, domain.CodeBranchNotFound)
	_, err = e.engine.RenameBranch(e.ctx, scopeA, branch.Line.ID, strings.Repeat("x", e.engine.Limits().Branch.PurposeMaxRunes+1))
	wantCode(t, err, domain.CodeInvalidInput)
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, branch.Line.ID); err != nil {
		t.Fatal(err)
	}
	// B13: an ended branch can still be renamed.
	if _, err := e.engine.RenameBranch(e.ctx, scopeA, branch.Line.ID, "after the end"); err != nil {
		t.Fatalf("an ended branch: %v", err)
	}
}

func TestB5_PreviewBranchIsThePackCreateWouldBuildAndWritesNothing(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "first question", "first answer")
	e.turn(main.ID, "a later question", "a later answer")
	in := tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Purpose: "dig in", Kind: domain.BranchKindInvestigate, Excerpt: "first", IncludeLater: true}
	branches := e.count(`SELECT count(*) FROM tangent_branch`)
	e.events.Reset()
	preview, err := e.engine.PreviewBranch(e.ctx, scopeA, main.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	if got := e.count(`SELECT count(*) FROM tangent_branch`); got != branches || len(e.events.Types()) != 0 {
		t.Fatalf("a preview wrote %d branches and published %v", got-branches, e.events.Types())
	}
	if preview.Text != preview.Pack.Rendered || preview.TokenEstimate != preview.Pack.TokenEstimate || preview.TokenEstimate <= 0 || !preview.Pack.LaterIncluded {
		t.Fatalf("preview %+v", preview)
	}
	created, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(created.Pack, preview.Pack) {
		t.Fatalf("the preview differs from the created pack:\n%+v\n%+v", preview.Pack, created.Pack)
	}
	unnamed, err := e.engine.PreviewBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Kind: domain.BranchKindInvestigate})
	if err != nil || unnamed.Pack.LaterIncluded || unnamed.TokenEstimate <= 0 {
		t.Fatalf("a preview without a purpose yet: %+v, %v", unnamed, err)
	}
}

func TestB5_PreviewBranchRefusesWhatCreateWouldRefuse(t *testing.T) {
	e := newEnvWith(t, []tangent.Feature{tangent.Notes()})
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	cases := map[string]struct {
		in   tangent.BranchInput
		code string
	}{
		"unknown anchor": {tangent.BranchInput{AnchorMessageID: uuid.NewString(), Kind: domain.BranchKindInvestigate}, domain.CodeAnchorNotFound},
		"bad kind":       {tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Kind: "wander"}, domain.CodeKindUnsupported},
		"aside is off":   {tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Kind: domain.BranchKindAside}, domain.CodeFeatureDisabled},
		"long purpose":   {tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Kind: domain.BranchKindInvestigate, Purpose: strings.Repeat("p", 201)}, domain.CodeInvalidInput},
	}
	for name, c := range cases {
		_, err := e.engine.PreviewBranch(e.ctx, scopeA, main.ID, c.in)
		if domain.CodeOf(err) != c.code {
			t.Errorf("%s: code %q (%v), want %q", name, domain.CodeOf(err), err, c.code)
		}
	}
	// A conclusion card is an anchor (B17: a follow-up on it).
	branch := e.branch(main.ID, anchor.Message.ID, "side")
	e.turn(branch.Line.ID, "bq", "ba")
	detail, _ := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	merged, err := e.engine.MergeBranch(e.ctx, scopeA, branch.Line.ID, tangent.MergeInput{
		Card: domain.BranchCard{Question: "q", Conclusion: "c"}, ParentTipMessageID: detail.ParentTipMessageID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.engine.PreviewBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{AnchorMessageID: merged.Card.ID, Kind: domain.BranchKindInvestigate}); err != nil {
		t.Fatalf("a card anchors a preview: %v", err)
	}
	_, err = e.engine.PreviewBranch(e.ctx, scopeA, branch.Line.ID, tangent.BranchInput{AnchorMessageID: merged.Card.ID, Kind: domain.BranchKindInvestigate})
	wantCode(t, err, domain.CodeAnchorNotFound)
	_, err = e.engine.PreviewBranch(e.ctx, scopeB, main.ID, tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Kind: domain.BranchKindInvestigate})
	wantCode(t, err, domain.CodeLineNotFound)
}

func TestB5_ADeliveredCardIsPublishedAsUpdated(t *testing.T) {
	e := newEnv(t)
	main, branch, _ := e.draftable()
	detail, _ := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	merged, err := e.engine.MergeBranch(e.ctx, scopeA, branch.Line.ID, tangent.MergeInput{
		Card: domain.BranchCard{Question: "q", Conclusion: "c"}, ParentTipMessageID: detail.ParentTipMessageID,
	})
	if err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	done := e.turn(main.ID, "next", "noted")
	var cardUpdates []domain.Message
	for _, ev := range e.events.OfType(tangent.EventMessageUpdated) {
		if message := ev.Data.(domain.Message); message.ID == merged.Card.ID {
			cardUpdates = append(cardUpdates, message)
			if ev.RootLineID != main.ID || ev.LineID != main.ID {
				t.Fatalf("event routing %+v", ev)
			}
		}
	}
	if len(cardUpdates) != 1 || !cardUpdates[0].Meta.Delivered || cardUpdates[0].Kind != domain.MessageKindBranchCard {
		t.Fatalf("card updates %+v", cardUpdates)
	}
	if got := done.Message.Meta.DeliversCards; len(got) != 1 || got[0] != merged.Card.ID {
		t.Fatalf("the reply names the card it delivered: %v", got)
	}
	e.events.Reset()
	e.turn(main.ID, "again", "fine")
	for _, ev := range e.events.OfType(tangent.EventMessageUpdated) {
		if ev.Data.(domain.Message).ID == merged.Card.ID {
			t.Fatal("a card is published once, when it is delivered")
		}
	}
}

func TestB5_TheModelCatalogIsWhatTheHostGave(t *testing.T) {
	groups := []tangent.ModelGroup{{Provider: " anthropic ", Models: []string{"claude-haiku-4-5", " ", "claude-haiku-4-5", "claude-sonnet-4-5"}}, {Provider: "", Models: []string{"x"}}, {Provider: "fake"}}
	e := newEnv(t, tangent.WithModelCatalog(groups...))
	got := e.engine.ModelCatalog()
	want := []tangent.ModelGroup{{Provider: "anthropic", Models: []string{"claude-haiku-4-5", "claude-sonnet-4-5"}}, {Provider: "fake", Models: []string{}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("catalog %+v", got)
	}
	got[0].Models[0] = "changed"
	if e.engine.ModelCatalog()[0].Models[0] != "claude-haiku-4-5" {
		t.Fatal("the catalog is a copy")
	}
	if plain := newEnv(t).engine.ModelCatalog(); plain == nil || len(plain) != 0 {
		t.Fatalf("no catalog: %#v", plain)
	}
	raw, _ := json.Marshal(want[1])
	if string(raw) != `{"provider":"fake","models":[]}` {
		t.Fatalf("json %s", raw)
	}
}

// cancelOnPublish cancels the caller's context at the first event, which
// BeginTurn publishes right after its commit.
type cancelOnPublish struct{ cancel context.CancelFunc }

func (c cancelOnPublish) Publish(context.Context, tangent.Event) { c.cancel() }

// A caller that goes away after BeginTurn committed (the soak's stuck turn)
// leaves no pending turn behind: the turn is failed at once.
func TestB5_ACallerGoneAfterTheCommitLeavesNoPendingTurn(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e2, err := tangent.New(e.pool, tangent.WithPublisher(cancelOnPublish{cancel}), tangent.WithFeatures(tangent.AllFeatures()...))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e2.BeginTurn(ctx, scopeA, main.ID, tangent.TurnInput{Content: "and then I left"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	line, err := e.engine.GetLine(e.ctx, scopeA, main.ID)
	if err != nil || line.Status != domain.LineStatusError {
		t.Fatalf("the line is left %q (%v), want error", line.Status, err)
	}
	if pending := e.count(`SELECT count(*) FROM tangent_message WHERE status = 'pending'`); pending != 0 {
		t.Fatalf("%d pending replies", pending)
	}
}
