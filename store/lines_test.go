package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestLines_CreateWithTheHostsIDAndReadBack(t *testing.T) {
	f := newFixture(t)
	id := uuid.NewString()
	created, err := f.store.CreateLine(f.ctx, store.CreateLineInput{
		ID: id, Tenant: tenant, Title: " plan ", Provider: "anthropic", Model: "sonnet", CreatedBy: "chang",
		HostMeta: json.RawMessage(`{"sessionId":"s1"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.ID != id || created.TenantID != tenant || created.Title != "plan" || created.Status != domain.LineStatusIdle ||
		!created.IsMainLine() || string(created.HostMeta) != `{"sessionId": "s1"}` || created.Summary.Decisions == nil {
		t.Fatalf("created = %+v", created)
	}
	if _, err := f.store.CreateLine(f.ctx, store.CreateLineInput{ID: id, Tenant: tenant}); !errors.Is(err, domain.ErrIDUnavailable) {
		t.Fatalf("duplicate id = %v", err)
	}
	// Another tenant gets the same answer, which says nothing about the owner.
	if _, err := f.store.CreateLine(f.ctx, store.CreateLineInput{ID: id, Tenant: otherTenant}); !errors.Is(err, domain.ErrIDUnavailable) || strings.Contains(err.Error(), "exist") {
		t.Fatalf("another tenant's id = %v", err)
	}
	if _, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: " "}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("empty tenant = %v", err)
	}
	if _, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant, HostMeta: json.RawMessage(`[1]`)}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("host meta that is not an object = %v", err)
	}
	plain, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant})
	if err != nil || string(plain.HostMeta) != `{}` {
		t.Fatalf("default host meta = %q err=%v", plain.HostMeta, err)
	}
}

func TestLines_TenantIsolation(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	if _, err := f.store.GetLine(f.ctx, otherTenant, line.ID); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("cross-tenant read = %v", err)
	}
	if _, err := f.store.GetLine(f.ctx, tenant, "not-a-uuid"); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("bad id = %v", err)
	}
	if _, err := f.store.ListMessages(f.ctx, otherTenant, line.ID, 0, 10); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("cross-tenant messages = %v", err)
	}
	title := "x"
	if _, err := f.store.UpdateLine(f.ctx, otherTenant, line.ID, store.LinePatch{Title: &title}); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("cross-tenant update = %v", err)
	}
	page, err := f.store.ListLines(f.ctx, store.ListLinesInput{Tenant: otherTenant})
	if err != nil || len(page.Lines) != 0 {
		t.Fatalf("other tenant's list = %+v err=%v", page, err)
	}
}

func TestLines_ListPagesMainLinesNewestActivityFirst(t *testing.T) {
	f := newFixture(t)
	var ids []string
	for range 5 {
		line, _ := f.mainLine()
		ids = append(ids, line.ID)
	}
	f.branch(ids[0], f.reply(ids[0]).ID) // a branch never shows in the list
	// The first line is the most recently active one now.
	f.exec(`UPDATE tangent_line SET last_activity_at = now() + interval '1 hour' WHERE id = $1`, ids[0])

	var seen []string
	cursor := ""
	for range 5 {
		page, err := f.store.ListLines(f.ctx, store.ListLinesInput{Tenant: tenant, Limit: 2, Cursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range page.Lines {
			if !line.IsMainLine() {
				t.Fatalf("a branch is listed: %+v", line)
			}
			seen = append(seen, line.ID)
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if len(seen) != 5 || seen[0] != ids[0] {
		t.Fatalf("listed = %v", seen)
	}
	unique := map[string]bool{}
	for _, id := range seen {
		unique[id] = true
	}
	if len(unique) != 5 {
		t.Fatalf("pages overlap: %v", seen)
	}
	if first := f.line(ids[0]); first.BranchCounts.Open != 1 {
		t.Fatalf("branch counts = %+v", first.BranchCounts)
	}
	if _, err := f.store.ListLines(f.ctx, store.ListLinesInput{Tenant: tenant, Cursor: "garbage"}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("bad cursor = %v", err)
	}
}

func TestLines_UpdateMarkReadAndArchiveFilter(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	title, model, empty := "renamed", "opus", "  "
	updated, err := f.store.UpdateLine(f.ctx, tenant, line.ID, store.LinePatch{Title: &title, Model: &model, HostMeta: json.RawMessage(`{"k":1}`)})
	if err != nil || updated.Title != "renamed" || updated.Model != "opus" || updated.Provider != "anthropic" || string(updated.HostMeta) != `{"k": 1}` {
		t.Fatalf("update = %+v err=%v", updated, err)
	}
	if kept, err := f.store.UpdateLine(f.ctx, tenant, line.ID, store.LinePatch{Title: &empty}); err != nil || kept.Title != "renamed" {
		t.Fatalf("an empty title keeps the old one: %+v err=%v", kept, err)
	}

	f.exec(`UPDATE tangent_line SET unread = 3 WHERE id = $1`, line.ID)
	read, err := f.store.MarkRead(f.ctx, tenant, line.ID)
	if err != nil || read.Unread != 0 {
		t.Fatalf("mark read = %+v err=%v", read, err)
	}

	if _, err := f.store.ArchiveTree(f.ctx, tenant, line.ID, true); err != nil {
		t.Fatal(err)
	}
	if active, _ := f.store.ListLines(f.ctx, store.ListLinesInput{Tenant: tenant}); len(active.Lines) != 0 {
		t.Fatal("an archived line must leave the active list")
	}
	if archived, _ := f.store.ListLines(f.ctx, store.ListLinesInput{Tenant: tenant, Archived: true}); len(archived.Lines) != 1 || archived.Lines[0].ArchivedAt == nil {
		t.Fatalf("archived list = %+v", archived)
	}
}

func TestLines_TxHookErrorRollsTheWriteBack(t *testing.T) {
	f := newFixture(t)
	boom := errors.New("host said no")
	id := uuid.NewString()
	if _, err := f.store.CreateLine(f.ctx, store.CreateLineInput{ID: id, Tenant: tenant}, failingHook(boom)); !errors.Is(err, boom) {
		t.Fatalf("create with a failing hook = %v", err)
	}
	if _, err := f.store.GetLine(f.ctx, tenant, id); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("the line survived a failed hook: %v", err)
	}
	line, _ := f.mainLine()
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "hi"}, failingHook(boom)); !errors.Is(err, boom) {
		t.Fatalf("begin turn with a failing hook = %v", err)
	}
	if got := f.line(line.ID); got.Status != domain.LineStatusIdle || len(f.texts(line.ID)) != 2 {
		t.Fatalf("the turn survived a failed hook: %+v %v", got, f.texts(line.ID))
	}
	// A hook sees the store's writes inside the transaction.
	var seen int
	hook := func(ctx context.Context, tx store.Tx, _ any) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM tangent_message WHERE line_id = $1`, line.ID).Scan(&seen)
	}
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: line.ID, Content: "hi"}, hook); err != nil {
		t.Fatal(err)
	}
	if seen != 4 {
		t.Fatalf("the hook saw %d messages, want the new turn's two as well", seen)
	}
}
