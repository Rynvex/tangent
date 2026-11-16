package store_test

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangenttest"
)

// memoryFixture is a fixture whose schema has the memory feature migrated
// (it skips when the server has no vector extension).
func memoryFixture(t *testing.T) *fixture {
	t.Helper()
	pool := tangenttest.OpenFeatures(t, "memory")
	s, err := store.New(pool, domain.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{t: t, ctx: tangenttest.Context(t), pool: pool, store: s}
}

func (f *fixture) memory(text string, embedding []float32, mutate ...func(*store.MemoryWriteInput)) domain.Memory {
	f.t.Helper()
	in := store.MemoryWriteInput{Tenant: tenant, Memory: domain.MemoryInput{Kind: domain.MemoryFact, Text: text, Importance: 5}, Embedding: embedding, Actor: "chang"}
	for _, m := range mutate {
		m(&in)
	}
	m, err := f.store.CreateMemory(f.ctx, in)
	if err != nil {
		f.t.Fatal(err)
	}
	return m
}

func TestMemoryFeature_TheExtensionAndTheMigration(t *testing.T) {
	if ext, ok := store.FeatureExtension("memory"); !ok || ext != "vector" {
		t.Fatalf("memory needs vector: %q %v", ext, ok)
	}
	pool := tangenttest.OpenFeatures(t, "memory")
	ctx := tangenttest.Context(t)
	if err := store.CheckFeatures(ctx, pool, "memory"); err != nil {
		t.Fatal(err)
	}
	if err := store.MigrateFeaturesDown(ctx, pool, "memory"); err != nil {
		t.Fatal(err)
	}
	if err := store.CheckFeatures(ctx, pool, "memory"); err == nil {
		t.Fatal("a reverted feature is not migrated")
	}
}

func TestMemories_CreateGetListUpdate(t *testing.T) {
	f := memoryFixture(t)
	main, reply := f.mainLine()
	until := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	created := f.memory(" Use  ZFS mirror ", []float32{1, 0, 0}, func(in *store.MemoryWriteInput) {
		in.Memory.Kind, in.Memory.ValidUntil = domain.MemoryDecision, &until
		in.Source = domain.MemorySource{LineID: main.ID, MessageID: reply.ID, Label: "主線"}
	})
	if created.Text != "Use ZFS mirror" || created.Kind != domain.MemoryDecision || created.Status != domain.MemoryActive || created.Source.LineID != main.ID ||
		created.Source.Label != "主線" || created.ValidUntil == nil || !created.ValidUntil.Equal(until) || created.AIDrafted || created.CreatedBy != "chang" {
		t.Fatalf("created = %+v", created)
	}
	if got, err := f.store.GetMemory(f.ctx, tenant, created.ID); err != nil || got.ID != created.ID {
		t.Fatalf("get = %+v %v", got, err)
	}
	if _, err := f.store.GetMemory(f.ctx, otherTenant, created.ID); domain.CodeOf(err) != domain.CodeMemoryNotFound {
		t.Fatalf("another tenant: %v", err)
	}
	f.memory("A lesson", []float32{0, 1, 0}, func(in *store.MemoryWriteInput) { in.Memory.Kind = domain.MemoryLesson })
	all, err := f.store.ListMemories(f.ctx, store.MemoryQuery{Tenant: tenant})
	if err != nil || len(all) != 2 || all[0].Text != "A lesson" {
		t.Fatalf("list = %+v %v", all, err)
	}
	if decisions, _ := f.store.ListMemories(f.ctx, store.MemoryQuery{Tenant: tenant, Kind: domain.MemoryDecision}); len(decisions) != 1 {
		t.Fatalf("by kind = %+v", decisions)
	}
	importance, kind := 9, domain.MemoryFact
	updated, err := f.store.UpdateMemory(f.ctx, tenant, created.ID, store.MemoryPatch{Importance: &importance, Kind: &kind, ClearValidUntil: true})
	if err != nil || updated.Importance != 9 || updated.Kind != domain.MemoryFact || updated.ValidUntil != nil || updated.Text != created.Text {
		t.Fatalf("updated = %+v %v", updated, err)
	}
	bad := 11
	if _, err := f.store.UpdateMemory(f.ctx, tenant, created.ID, store.MemoryPatch{Importance: &bad}); domain.CodeOf(err) != domain.CodeInvalidMemory {
		t.Fatalf("bad importance: %v", err)
	}
	refused := errors.New("no")
	if _, err := f.store.CreateMemory(f.ctx, store.MemoryWriteInput{Tenant: tenant, Memory: domain.MemoryInput{Kind: domain.MemoryFact, Text: "x"}, Embedding: []float32{1, 0, 0}},
		func(context.Context, store.Tx, any) error { return refused }); !errors.Is(err, refused) {
		t.Fatalf("a hook rolls back: %v", err)
	}
	if n := f.count(`SELECT count(*) FROM tangent_memory`); n != 2 {
		t.Fatalf("%d memories", n)
	}
}

// memoryPages walks every page of a listing and returns the ids in order.
func (f *fixture) memoryPages(q store.MemoryQuery) []string {
	f.t.Helper()
	var ids []string
	for range 20 {
		page, err := f.store.ListMemoriesPage(f.ctx, q)
		if err != nil {
			f.t.Fatal(err)
		}
		if len(page.Memories) > q.Limit && q.Limit > 0 {
			f.t.Fatalf("a page of %d is over the limit %d", len(page.Memories), q.Limit)
		}
		for _, m := range page.Memories {
			ids = append(ids, m.ID)
		}
		if page.NextCursor == "" {
			return ids
		}
		q.Cursor = page.NextCursor
	}
	f.t.Fatal("the pages never end")
	return nil
}

func TestMemories_PagesAreNewestFirstAndTiesGoByID(t *testing.T) {
	f := memoryFixture(t)
	var ids []string
	for i := range 5 {
		kind := domain.MemoryFact
		if i%2 == 1 {
			kind = domain.MemoryDecision
		}
		ids = append(ids, f.memory(fmt.Sprintf("memory %d", i), []float32{1, 0, 0}, func(in *store.MemoryWriteInput) { in.Memory.Kind = kind }).ID)
	}
	theirs := f.memory("theirs", []float32{1, 0, 0}, func(in *store.MemoryWriteInput) { in.Tenant = otherTenant })
	// Three of ours and theirs share one creation time: the id breaks the tie.
	tied := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	f.exec(`UPDATE tangent_memory SET created_at = $1 WHERE id = ANY($2::uuid[])`, tied, []string{ids[1], ids[2], ids[3], theirs.ID})
	f.exec(`UPDATE tangent_memory SET created_at = $1 WHERE id = $2`, tied.Add(-time.Hour), ids[4])
	f.exec(`UPDATE tangent_memory SET created_at = $1 WHERE id = $2`, tied.Add(time.Hour), ids[0])
	middle := []string{ids[1], ids[2], ids[3]}
	slices.SortFunc(middle, func(a, b string) int { return strings.Compare(b, a) })
	want := append(append([]string{ids[0]}, middle...), ids[4])

	all, err := f.store.ListMemoriesPage(f.ctx, store.MemoryQuery{Tenant: tenant})
	if err != nil || !slices.Equal(memoryIDs(all.Memories), want) || all.NextCursor != "" {
		t.Fatalf("one page = %v %q %v, want %v", memoryIDs(all.Memories), all.NextCursor, err, want)
	}
	for _, limit := range []int{1, 2, 3, 4, 5} {
		if got := f.memoryPages(store.MemoryQuery{Tenant: tenant, Limit: limit}); !slices.Equal(got, want) {
			t.Fatalf("pages of %d = %v, want %v", limit, got, want)
		}
	}
	exact, _ := f.store.ListMemoriesPage(f.ctx, store.MemoryQuery{Tenant: tenant, Limit: 5})
	if len(exact.Memories) != 5 || exact.NextCursor != "" {
		t.Fatalf("a full last page has no next cursor: %d %q", len(exact.Memories), exact.NextCursor)
	}
	var decisions []string
	for _, id := range want {
		if id == ids[1] || id == ids[3] {
			decisions = append(decisions, id)
		}
	}
	if got := f.memoryPages(store.MemoryQuery{Tenant: tenant, Kind: domain.MemoryDecision, Limit: 1}); !slices.Equal(got, decisions) {
		t.Fatalf("decisions = %v, want %v", got, decisions)
	}
	if got := f.memoryPages(store.MemoryQuery{Tenant: otherTenant, Limit: 1}); !slices.Equal(got, []string{theirs.ID}) {
		t.Fatalf("theirs = %v", got)
	}
	first, _ := f.store.ListMemoriesPage(f.ctx, store.MemoryQuery{Tenant: tenant, Limit: 1})
	if cross, err := f.store.ListMemoriesPage(f.ctx, store.MemoryQuery{Tenant: otherTenant, Cursor: first.NextCursor}); err != nil || !slices.Equal(memoryIDs(cross.Memories), []string{theirs.ID}) {
		t.Fatalf("a cursor of ours lists only their own: %v %v", memoryIDs(cross.Memories), err)
	}
	for _, bad := range []string{"garbage", "bm9wZQ", base64.RawURLEncoding.EncodeToString([]byte("12_not-an-id"))} {
		if _, err := f.store.ListMemoriesPage(f.ctx, store.MemoryQuery{Tenant: tenant, Cursor: bad}); domain.CodeOf(err) != domain.CodeInvalidInput {
			t.Fatalf("cursor %q = %v", bad, err)
		}
	}
}

func TestMemories_ACursorKeepsItsPlaceWhileMemoriesChange(t *testing.T) {
	f := memoryFixture(t)
	a := f.memory("a", []float32{1, 0, 0})
	b := f.memory("b", []float32{0, 1, 0})
	c := f.memory("c", []float32{0, 0, 1})
	first, err := f.store.ListMemoriesPage(f.ctx, store.MemoryQuery{Tenant: tenant, Statuses: []string{domain.MemoryActive, domain.MemorySuperseded}, Limit: 1})
	if err != nil || !slices.Equal(memoryIDs(first.Memories), []string{c.ID}) || first.NextCursor == "" {
		t.Fatalf("first = %v %q %v", memoryIDs(first.Memories), first.NextCursor, err)
	}
	// A new memory goes on the first page; superseding one keeps its place.
	out, err := f.store.SupersedeMemories(f.ctx, tenant, []string{b.ID}, store.MemoryWriteInput{
		Memory: domain.MemoryInput{Kind: domain.MemoryFact, Text: "b2", Importance: 5}, Embedding: []float32{0, 1, 0},
	})
	if err != nil {
		t.Fatal(err)
	}
	rest := f.memoryPages(store.MemoryQuery{Tenant: tenant, Statuses: []string{domain.MemoryActive, domain.MemorySuperseded}, Limit: 1, Cursor: first.NextCursor})
	if !slices.Equal(rest, []string{b.ID, a.ID}) {
		t.Fatalf("rest = %v (new %s)", rest, out.New.ID)
	}
	active := f.memoryPages(store.MemoryQuery{Tenant: tenant, Limit: 1, Cursor: first.NextCursor})
	if !slices.Equal(active, []string{a.ID}) {
		t.Fatalf("active after the cursor = %v", active)
	}
}

func memoryIDs(memories []domain.Memory) []string {
	out := make([]string, 0, len(memories))
	for _, m := range memories {
		out = append(out, m.ID)
	}
	return out
}

func TestMemories_SupersedeKeepsTheChain(t *testing.T) {
	f := memoryFixture(t)
	a := f.memory("Use Btrfs", []float32{1, 0, 0})
	b := f.memory("Use btrfs raid1", []float32{1, 0.1, 0})
	out, err := f.store.SupersedeMemories(f.ctx, tenant, []string{b.ID, a.ID}, store.MemoryWriteInput{
		Memory: domain.MemoryInput{Kind: domain.MemoryDecision, Text: "Use ZFS mirror", Importance: 8}, Embedding: []float32{0, 1, 0}, Actor: "lee",
	})
	if err != nil || out.New.Status != domain.MemoryActive || len(out.Old) != 2 {
		t.Fatalf("out = %+v %v", out, err)
	}
	for _, old := range out.Old {
		if old.Status != domain.MemorySuperseded || old.SupersededBy != out.New.ID {
			t.Fatalf("old = %+v", old)
		}
	}
	if _, err := f.store.SupersedeMemories(f.ctx, tenant, []string{a.ID}, store.MemoryWriteInput{Memory: domain.MemoryInput{Kind: domain.MemoryFact, Text: "again"}, Embedding: []float32{1, 0, 0}}); domain.CodeOf(err) != domain.CodeMemorySuperseded {
		t.Fatalf("twice: %v", err)
	}
	importance := 3
	if _, err := f.store.UpdateMemory(f.ctx, tenant, a.ID, store.MemoryPatch{Importance: &importance}); domain.CodeOf(err) != domain.CodeMemorySuperseded {
		t.Fatalf("a superseded memory is history: %v", err)
	}
	history, _ := f.store.ListMemories(f.ctx, store.MemoryQuery{Tenant: tenant, Statuses: []string{domain.MemorySuperseded}})
	if len(history) != 2 {
		t.Fatalf("history = %+v", history)
	}
	if n := f.count(`SELECT count(*) FROM tangent_memory`); n != 3 {
		t.Fatalf("nothing is deleted: %d", n)
	}
}

func TestMemories_SimilarAreRankedByDistanceAndStayInTheTenant(t *testing.T) {
	f := memoryFixture(t)
	near := f.memory("near", []float32{1, 0.1, 0})
	far := f.memory("far", []float32{0, 0, 1})
	f.memory("other size", []float32{1, 0})
	f.memory("theirs", []float32{1, 0, 0}, func(in *store.MemoryWriteInput) { in.Tenant = otherTenant })
	got, err := f.store.SimilarMemories(f.ctx, tenant, []float32{1, 0, 0}, 10)
	if err != nil || len(got) != 2 || got[0].Memory.ID != near.ID || got[1].Memory.ID != far.ID || got[0].Similarity < 0.99 || got[1].Similarity > 0.01 {
		t.Fatalf("similar = %+v %v", got, err)
	}
	if _, err := f.store.SupersedeMemories(f.ctx, tenant, []string{near.ID}, store.MemoryWriteInput{Memory: domain.MemoryInput{Kind: domain.MemoryFact, Text: "nearer"}, Embedding: []float32{0, 1, 0}}); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.store.SimilarMemories(f.ctx, tenant, []float32{1, 0, 0}, 10); len(got) != 2 || got[0].Memory.Text == "near" {
		t.Fatalf("only active memories: %+v", got)
	}
}

func TestMemories_DuplicatePairsForConsolidation(t *testing.T) {
	f := memoryFixture(t)
	main, _ := f.mainLine()
	onMain := func(in *store.MemoryWriteInput) { in.Source.LineID = main.ID }
	a := f.memory("ZFS mirror", []float32{1, 0, 0}, onMain)
	b := f.memory("ZFS mirror please", []float32{1, 0.05, 0}, onMain)
	f.memory("unrelated", []float32{0, 1, 0}, onMain)
	f.memory("unlined one", []float32{0, 0, 1})
	f.memory("unlined two", []float32{0, 0.01, 1})
	pairs, err := f.store.DuplicateMemoryPairs(f.ctx, 0.92, 10)
	if err != nil || len(pairs) != 1 || pairs[0].Tenant != tenant || pairs[0].A.ID == pairs[0].B.ID || pairs[0].LineID != main.ID {
		t.Fatalf("pairs = %+v %v", pairs, err)
	}
	ids := map[string]bool{pairs[0].A.ID: true, pairs[0].B.ID: true}
	if !ids[a.ID] || !ids[b.ID] {
		t.Fatalf("the pair = %+v", pairs[0])
	}
	if _, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: store.JobKindMemoryConsolidate, Feature: "memory", LineID: main.ID, Input: []byte(`{"pair":"` + pairs[0].Key + `"}`)}); err != nil {
		t.Fatal(err)
	}
	if again, _ := f.store.DuplicateMemoryPairs(f.ctx, 0.92, 10); len(again) != 0 {
		t.Fatalf("a pair with a job is not picked again: %+v", again)
	}
}
