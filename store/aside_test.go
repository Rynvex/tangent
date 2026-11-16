package store_test

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func (f *fixture) aside(rootID, anchorID string) domain.LineView {
	f.t.Helper()
	in := f.branchInput(rootID, anchorID)
	in.Kind = domain.BranchKindAside
	created, err := f.store.CreateBranch(f.ctx, in)
	if err != nil {
		f.t.Fatal(err)
	}
	return created.Line
}

func TestAside_AnswerCanGoIntoTheNotesAndExpiredAsidesArePurged(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	f := newFixture(t, store.WithClock(clock.Now))
	root, anchor := f.mainLine()
	aside := f.aside(root.ID, anchor.ID)
	turn, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: aside.ID, Content: "q", HostMeta: json.RawMessage(`{"file":"a.png"}`)})
	if err != nil {
		t.Fatal(err)
	}
	reply := f.answer(turn.Pending.ID, "Backoff means growing waits.")
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: root.ID, Changes: []domain.NoteChange{{
		Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "Backoff means growing waits.", SourceLineID: aside.ID, SourceMessageID: reply.Message.ID,
	}}}); err != nil {
		t.Fatalf("a note from an ended aside = %v", err)
	}
	retention := domain.DefaultLimits().Branch.AsideRetention
	clock.now = time.Now().Add(retention - time.Hour)
	purged, err := f.store.PurgeExpiredAsides(f.ctx, 0)
	if err != nil || len(purged) != 0 {
		t.Fatalf("purge before the retention = %+v err=%v", purged, err)
	}
	clock.now = time.Now().Add(retention + time.Hour)
	purged, err = f.store.PurgeExpiredAsides(f.ctx, 0)
	if err != nil || len(purged) != 1 || purged[0].LineID != aside.ID || purged[0].RootLineID != root.ID || purged[0].Tenant != tenant ||
		len(purged[0].LineIDs) != 1 || len(purged[0].Messages) != 1 {
		t.Fatalf("purge after the retention = %+v err=%v", purged, err)
	}
	if _, err := f.store.GetLine(f.ctx, tenant, aside.ID); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("the aside line is still there: %v", err)
	}
	if _, err := f.store.GetLine(f.ctx, tenant, root.ID); err != nil {
		t.Fatalf("main line lost: %v", err)
	}
	if notes, _ := f.store.ListNotes(f.ctx, tenant, root.ID); len(notes.Notes) != 1 {
		t.Fatal("the note taken from the aside must stay")
	}
}

func TestAside_AnOpenOrBusyAsideIsNeverPurged(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	f := newFixture(t, store.WithClock(clock.Now))
	root, anchor := f.mainLine()
	open := f.aside(root.ID, anchor.ID)
	retention := domain.DefaultLimits().Branch.AsideRetention
	clock.now = time.Now().Add(10 * retention)
	purged, err := f.store.PurgeExpiredAsides(f.ctx, 0)
	if err != nil || len(purged) != 0 {
		t.Fatalf("purge = %+v err=%v", purged, err)
	}
	if _, err := f.store.GetLine(f.ctx, tenant, open.ID); err != nil {
		t.Fatal(err)
	}
	// An ended aside whose line is somehow still answering is skipped.
	busy := f.aside(root.ID, anchor.ID)
	f.exec(`UPDATE tangent_branch SET status = 'discarded', closed_at = now() WHERE line_id = $1`, busy.ID)
	f.exec(`UPDATE tangent_line SET status = 'thinking' WHERE id = $1`, busy.ID)
	if purged, err := f.store.PurgeExpiredAsides(f.ctx, 0); err != nil || len(purged) != 0 {
		t.Fatalf("a busy aside was purged: %+v err=%v", purged, err)
	}
}
