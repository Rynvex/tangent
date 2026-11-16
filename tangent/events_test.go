package tangent_test

import (
	"context"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

type panickyPublisher struct{ seen int }

func (p *panickyPublisher) Publish(context.Context, tangent.Event) {
	p.seen++
	panic("subscriber exploded")
}

func TestEvents_APanickingPublisherDoesNotBreakTheWrite(t *testing.T) {
	publisher := &panickyPublisher{}
	e := newEnv(t, tangent.WithPublisher(publisher))
	line := e.mainLine()
	if line.ID == "" || publisher.seen != 1 {
		t.Fatalf("line %q, publisher saw %d events", line.ID, publisher.seen)
	}
	if _, err := e.engine.GetLine(e.ctx, scopeA, line.ID); err != nil {
		t.Fatal(err)
	}
}
