package tangent_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

func TestSpinoff_ThePreviewIsTheCapsuleASpinoffWouldStore(t *testing.T) {
	e := newEnvWith(t, p1bFeatures())
	main, branch := e.branchWithTurn("Spring")
	at := e.turn(branch.Line.ID, "cherry blossoms?", "early April")
	if _, err := e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: "add", Section: "fact", Text: "x"}, {Op: "add", Section: "fact", Text: "y"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.PutLeaf(e.ctx, scopeA, branch.Line.ID, domain.LeafInput{Kind: "to_continue", Line: "half way"}); err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	fresh, err := e.engine.PreviewSpinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffFresh, AtMessageID: at.Message.ID, CopyNotes: true})
	if err != nil || fresh.NotesToCopy != 2 || fresh.Capsule.TokenEstimate == 0 || !strings.Contains(fresh.Capsule.Rendered, "half way") {
		t.Fatalf("fresh preview = %+v %v", fresh, err)
	}
	detach, err := e.engine.PreviewSpinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach})
	if err != nil || detach.NotesToCopy != 0 || detach.Mode != domain.SpinoffDetach {
		t.Fatalf("detach preview = %+v %v", detach, err)
	}
	if len(e.events.Events()) != 0 {
		t.Fatalf("a preview writes nothing: %v", e.events.Types())
	}
	spun, err := e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffFresh, AtMessageID: at.Message.ID})
	if err != nil || spun.Line.Capsule.Rendered != fresh.Capsule.Rendered {
		t.Fatalf("the same capsule:\n%s\n---\n%s", fresh.Capsule.Rendered, spun.Line.Capsule.Rendered)
	}
	out, err := e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach})
	if err != nil || out.Line.Capsule.Rendered != detach.Capsule.Rendered {
		t.Fatalf("the same detach capsule:\n%s\n---\n%s", detach.Capsule.Rendered, out.Line.Capsule.Rendered)
	}
	for _, c := range []struct {
		in   tangent.SpinoffInput
		line string
		code string
	}{
		{tangent.SpinoffInput{Mode: "copy"}, main.ID, domain.CodeInvalidInput},
		{tangent.SpinoffInput{Mode: domain.SpinoffDetach}, main.ID, domain.CodeBranchNotFound},
		{tangent.SpinoffInput{Mode: domain.SpinoffFresh, AtMessageID: main.ID}, main.ID, domain.CodeAnchorNotFound},
	} {
		_, err := e.engine.PreviewSpinoff(e.ctx, scopeA, c.line, c.in)
		wantCode(t, err, c.code)
	}
	off := newEnvWith(t, p1Features())
	_, err = off.engine.PreviewSpinoff(off.ctx, scopeA, off.mainLine().ID, tangent.SpinoffInput{Mode: domain.SpinoffFresh})
	wantCode(t, err, domain.CodeFeatureDisabled)
}

func TestSpinoff_ADetachPreviewOfAnEndedBranchIsRefused(t *testing.T) {
	e := newEnvWith(t, p1bFeatures())
	_, branch := e.branchWithTurn("x")
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, branch.Line.ID); err != nil {
		t.Fatal(err)
	}
	_, err := e.engine.PreviewSpinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach})
	wantCode(t, err, domain.CodeBranchClosed)
}

func TestRebalance_ThePayloadNamesTheParent(t *testing.T) {
	e := newEnvWith(t, p1bFeatures())
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	top := e.branch(main.ID, anchor.Message.ID, "top")
	s, _ := e.rebalanced(top.Line.ID, 6)
	if p := payloadOf(t, s); !p.ParentIsMain || p.ParentTitle != "main" {
		t.Fatalf("top = %+v", p)
	}
	inner := e.turn(top.Line.ID, "inner", "x")
	deep := e.branch(top.Line.ID, inner.Message.ID, "deep")
	s, _ = e.rebalanced(deep.Line.ID, 6)
	if p := payloadOf(t, s); p.ParentIsMain || p.ParentTitle != "top" {
		t.Fatalf("deep = %+v", p)
	}
}

func TestSummary_ADueSummaryIsPublished(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.History.SummaryTriggerTokens = 5
	for _, mode := range []tangent.Mode{tangent.ModeManual, tangent.ModeSuggest, tangent.ModeAuto} {
		features := append(without(tangent.FeatureSummary), tangent.Summary(mode))
		e := newEnvWith(t, features, tangent.WithLimits(limits))
		main := e.mainLine()
		e.events.Reset()
		e.turn(main.ID, "a fairly long question about many things", "an equally long answer")
		due := e.events.OfType(tangent.EventSummaryDue)
		if (len(due) == 1) != (mode == tangent.ModeSuggest) {
			t.Fatalf("%v: %v", mode, e.events.Types())
		}
		if mode == tangent.ModeSuggest {
			data := due[0].Data.(tangent.SummaryDueChange)
			if data.LineID != main.ID || data.RootLineID != main.ID || due[0].LineID != main.ID {
				t.Fatalf("data = %+v", data)
			}
		}
	}
}

// recorder is a publisher that keeps event types.
type recorder struct{ types []string }

func (r *recorder) Publish(_ context.Context, ev tangent.Event) { r.types = append(r.types, ev.Type) }

type panicking struct{}

func (panicking) Publish(context.Context, tangent.Event) { panic("boom") }

func TestPublishers_FanOutPastAPanic(t *testing.T) {
	a, b := &recorder{}, &recorder{}
	fan := tangent.Publishers(a, nil, panicking{}, b)
	func() {
		defer func() {
			if r := recover(); fmt.Sprint(r) != "boom" {
				t.Fatalf("the panic is passed on after everyone got the event: %v", r)
			}
		}()
		fan.Publish(context.Background(), tangent.Event{Type: "x"})
	}()
	if len(a.types) != 1 || len(b.types) != 1 {
		t.Fatalf("a %v b %v", a.types, b.types)
	}
	e := newEnvWith(t, nil, tangent.WithPublisher(tangent.Publishers(panicking{}, a)))
	e.mainLine()
	if len(a.types) != 2 {
		t.Fatalf("the engine survives the panic and the others still publish: %v", a.types)
	}
	raw, _ := json.Marshal(domain.SpunOffRef{LineID: "l", Title: "t"})
	if !strings.Contains(string(raw), `"available":false`) {
		t.Fatalf("available is always in the JSON: %s", raw)
	}
}
