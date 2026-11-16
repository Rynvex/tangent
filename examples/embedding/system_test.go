package embedding_test

import (
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/examples/embedding"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// systemContents lists a line's host system messages.
func systemContents(t *testing.T, engine *tangent.Engine, lineID string) []string {
	t.Helper()
	messages, err := engine.ListMessages(tangenttest.Context(t), scope, lineID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, m := range messages {
		if m.Role == domain.RoleSystem && m.Kind == domain.MessageKindChat {
			out = append(out, m.Content)
		}
	}
	return out
}

func TestFinishRemoteTurn_WritesTheStatusesAfterTheReplyOrOnTheirOwn(t *testing.T) {
	ctx := tangenttest.Context(t)
	engine := newEngine(t, tangenttest.Open(t))
	lineID := newLine(t, ctx, engine)
	turn, err := engine.BeginTurn(ctx, scope, lineID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if err := embedding.FinishRemoteTurn(ctx, engine, scope, lineID, turn.ID, "a", []string{"Read-only.", "Read-only.", "Worktree rebuilt."}); err != nil {
		t.Fatal(err)
	}
	if got := systemContents(t, engine, lineID); !slices.Equal(got, []string{"Read-only.", "Worktree rebuilt."}) {
		t.Fatalf("statuses %v", got)
	}
	cancelled, err := engine.BeginTurn(ctx, scope, lineID, tangent.TurnInput{Content: "q2"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := engine.CancelTurn(ctx, scope, lineID); err != nil {
		t.Fatal(err)
	}
	if err := embedding.FinishRemoteTurn(ctx, engine, scope, lineID, cancelled.ID, "late", []string{"Worktree rebuilt.", "Shell exited.", " "}); err != nil {
		t.Fatal(err)
	}
	if got := systemContents(t, engine, lineID); !slices.Equal(got, []string{"Read-only.", "Worktree rebuilt.", "Shell exited."}) {
		t.Fatalf("statuses after a cancel %v", got)
	}
}

func TestOperatorDeltas_KeepsToolInputFromReadOnlyMembers(t *testing.T) {
	tool := domain.Delta{Kind: domain.DeltaTool, Text: "rm -rf build"}
	text := domain.Delta{Kind: domain.DeltaText, Text: "Done."}
	for _, c := range []struct {
		readOnly bool
		d        domain.Delta
		want     bool
	}{{false, tool, true}, {true, tool, false}, {true, text, true}} {
		r := httptest.NewRequest("GET", "/events", nil)
		r = r.WithContext(embedding.WithUser(r.Context(), embedding.User{ID: "u", WorkspaceID: tenant, ReadOnly: c.readOnly}))
		if got, keep := embedding.OperatorDeltas(r, "line", c.d); keep != c.want || got != c.d {
			t.Errorf("read-only %v, %s: keep %v (delta %+v), want %v", c.readOnly, c.d.Kind, keep, got, c.want)
		}
	}
}
