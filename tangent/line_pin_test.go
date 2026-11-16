package tangent_test

import (
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// Pinned conversations (B25): kept on the server, so they follow the
// operator to another device. Pinning is not activity.

func (e *env) pin(lineID string, pinned bool) domain.LineView {
	e.t.Helper()
	line, err := e.engine.UpdateLine(e.ctx, scopeA, lineID, tangent.LinePatch{Pinned: &pinned})
	if err != nil {
		e.t.Fatal(err)
	}
	return line
}

func lineIDs(lines []domain.LineView) []string {
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		out = append(out, line.ID)
	}
	return out
}

func TestLinePin_PinsAndUnpinsWithoutActivity(t *testing.T) {
	e := newEnv(t)
	line := e.mainLine()
	e.exec(`UPDATE tangent_line SET last_activity_at = '2025-01-01T00:00:00Z' WHERE id = $1`, line.ID)
	e.events.Reset()
	pinned := e.pin(line.ID, true)
	if pinned.PinnedAt == nil || !pinned.LastActivityAt.Equal(time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("pinned, activity unchanged: %v %v", pinned.PinnedAt, pinned.LastActivityAt)
	}
	e.wantTypes(tangent.EventLineUpdated)
	again := e.pin(line.ID, true)
	if again.PinnedAt == nil || !again.PinnedAt.Equal(*pinned.PinnedAt) {
		t.Fatalf("pinning again keeps the first time: %v vs %v", again.PinnedAt, pinned.PinnedAt)
	}
	if unpinned := e.pin(line.ID, false); unpinned.PinnedAt != nil || !unpinned.LastActivityAt.Equal(pinned.LastActivityAt) {
		t.Fatalf("unpinned: %+v", unpinned.Line)
	}
}

func TestLinePin_BranchesCannotBePinned(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	turn := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, turn.Message.ID, "side")
	yes, no := true, false
	_, err := e.engine.UpdateLine(e.ctx, scopeA, branch.Line.ID, tangent.LinePatch{Pinned: &yes})
	wantCode(t, err, domain.CodeInvalidInput)
	if refusal := domain.AsError(err, domain.DefaultLimits()); refusal.Extra["field"] != "pinned" {
		t.Fatalf("the refusal names the field: %v", refusal.Extra)
	}
	if line, err := e.engine.UpdateLine(e.ctx, scopeA, branch.Line.ID, tangent.LinePatch{Pinned: &no}); err != nil || line.PinnedAt != nil {
		t.Fatalf("unpinning a branch is a no-op: %v", err)
	}
}

func TestLinePin_ListPinnedFiltersWithoutChangingTheList(t *testing.T) {
	e := newEnv(t)
	a, _, c := e.mainLine(), e.mainLine(), e.mainLine()
	before, err := e.engine.ListLines(e.ctx, scopeA, tangent.LineQuery{})
	if err != nil {
		t.Fatal(err)
	}
	e.pin(a.ID, true)
	e.pin(c.ID, true)
	e.exec(`UPDATE tangent_line SET pinned_at = now() - interval '1 hour' WHERE id = $1`, c.ID)
	after, err := e.engine.ListLines(e.ctx, scopeA, tangent.LineQuery{})
	if err != nil || !slices.Equal(lineIDs(after.Lines), lineIDs(before.Lines)) {
		t.Fatalf("pins do not reorder the list (D3): %v vs %v (%v)", lineIDs(after.Lines), lineIDs(before.Lines), err)
	}
	pinned, err := e.engine.ListLines(e.ctx, scopeA, tangent.LineQuery{Pinned: true})
	if err != nil || !slices.Equal(lineIDs(pinned.Lines), []string{a.ID, c.ID}) || pinned.NextCursor != "" {
		t.Fatalf("pinned, newest pin first: %v %v", lineIDs(pinned.Lines), err)
	}
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, a.ID, true); err != nil {
		t.Fatal(err)
	}
	active, _ := e.engine.ListLines(e.ctx, scopeA, tangent.LineQuery{Pinned: true})
	archived, _ := e.engine.ListLines(e.ctx, scopeA, tangent.LineQuery{Pinned: true, Archived: true})
	if !slices.Equal(lineIDs(active.Lines), []string{c.ID}) || !slices.Equal(lineIDs(archived.Lines), []string{a.ID}) {
		t.Fatalf("archived follows the archived flag: %v %v", lineIDs(active.Lines), lineIDs(archived.Lines))
	}
	if other, _ := e.engine.ListLines(e.ctx, scopeB, tangent.LineQuery{Pinned: true}); len(other.Lines) != 0 {
		t.Fatalf("another tenant sees no pin: %v", lineIDs(other.Lines))
	}
	_, err = e.engine.ListLines(e.ctx, scopeA, tangent.LineQuery{Pinned: true, Cursor: after.NextCursor + "x"})
	wantCode(t, err, domain.CodeInvalidInput)
}

func TestLinePin_AttachClearsItAndSpinoffDoesNotInheritPinOrBatch(t *testing.T) {
	e := newEnvWith(t, b18Features())
	batch := uuid.NewString()
	source := e.importIn(scopeA, batchImport("source", batch, ""))
	e.pin(source.Line.ID, true)
	target := e.mainLine()
	e.exchange(target.ID, "hello", "hi")
	e.pin(target.ID, true)
	attached, err := e.engine.AttachLine(e.ctx, scopeA, target.ID, tangent.AttachInput{SourceLineID: source.Line.ID})
	if err != nil {
		t.Fatal(err)
	}
	if attached.BranchLine.PinnedAt != nil || attached.TargetLine.PinnedAt == nil {
		t.Fatalf("the attached line loses its pin, the target keeps its own: %v %v", attached.BranchLine.PinnedAt, attached.TargetLine.PinnedAt)
	}
	spun, err := e.engine.Spinoff(e.ctx, scopeA, source.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach})
	if err != nil {
		t.Fatal(err)
	}
	if spun.Line.PinnedAt != nil || spun.Line.ImportBatchID != "" {
		t.Fatalf("a spun-off main line is neither pinned nor in a batch: %+v", spun.Line.Line)
	}
	if got := e.batches(scopeA); len(got) != 1 || got[0].LineCount != 0 {
		t.Fatalf("it left its batch: %+v", got)
	}
	fresh, err := e.engine.Spinoff(e.ctx, scopeA, branchOf(t, e, target.ID), tangent.SpinoffInput{Mode: domain.SpinoffDetach})
	if err != nil || fresh.Line.PinnedAt != nil {
		t.Fatalf("a branch of a pinned line spins off unpinned: %+v %v", fresh.Line.Line, err)
	}
}

// branchOf opens a branch on the main line's first reply and returns its
// line id.
func branchOf(t *testing.T, e *env, mainID string) string {
	t.Helper()
	messages, err := e.engine.ListMessages(e.ctx, scopeA, mainID, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	return e.branch(mainID, messages[1].ID, "a branch of a pinned line").Line.ID
}
