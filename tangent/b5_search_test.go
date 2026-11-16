package tangent_test

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// newSearchEnv is newEnv with the search feature too (its migration run).
func newSearchEnv(t *testing.T, opts ...tangent.Option) *env {
	t.Helper()
	pool := tangenttest.OpenFeatures(t, tangent.FeatureSearch)
	events := tangenttest.NewRecorder()
	base := []tangent.Option{
		tangent.WithPublisher(events), tangent.WithLogger(slog.New(slog.DiscardHandler)),
		tangent.WithFeatures(append(tangent.AllFeatures(), tangent.Search())...),
	}
	engine, err := tangent.New(pool, append(base, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	return &env{t: t, ctx: tangenttest.Context(t), pool: pool, engine: engine, events: events, runner: tangenttest.NewFakeRunner()}
}

func (e *env) search(scope tangent.Scope, query string, archived bool) []domain.SearchHit {
	e.t.Helper()
	hits, err := e.engine.Search(e.ctx, scope, tangent.SearchInput{Query: query, Archived: archived})
	if err != nil {
		e.t.Fatal(err)
	}
	return hits
}

func TestB5_SearchFindsChineseEnglishAndMixedTextWithSnippets(t *testing.T) {
	e := newSearchEnv(t)
	main, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Title: "產品規劃 roadmap"})
	if err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("背景說明。", 60) + "我們決定先做分岔對話的搜尋功能" + strings.Repeat("其他細節。", 60)
	anchor := e.turn(main.ID, long, "Search ships first, then the roadmap review.")
	branch := e.branch(main.ID, anchor.Message.ID, "研究 search 的排序")
	e.turn(branch.Line.ID, "how should ranking work?", "Rank by similarity, then by recency.")

	hits := e.search(scopeA, "分岔對話", false)
	if len(hits) != 1 || hits[0].Kind != domain.SearchKindMessage || hits[0].Role != domain.RoleUser {
		t.Fatalf("Chinese: %+v", hits)
	}
	hit := hits[0]
	if hit.LineID != main.ID || hit.RootLineID != main.ID || hit.RootTitle != "產品規劃 roadmap" || hit.Purpose != "" || hit.Seq == 0 || hit.MessageID == "" {
		t.Fatalf("hit %+v", hit)
	}
	if !strings.HasPrefix(hit.Snippet, "…") || len([]rune(hit.Snippet)) > domain.SearchSnippetRunes+2 || len(hit.Highlights) != 1 {
		t.Fatalf("snippet %q %v", hit.Snippet, hit.Highlights)
	}
	english := e.search(scopeA, "ROADMAP", false)
	if len(english) != 2 || english[0].Kind != domain.SearchKindTitle {
		t.Fatalf("English, the title first: %+v", english)
	}
	mixed := e.search(scopeA, "研究 search", false)
	if len(mixed) != 1 || mixed[0].Kind != domain.SearchKindPurpose || mixed[0].LineID != branch.Line.ID || mixed[0].Purpose != "研究 search 的排序" {
		t.Fatalf("mixed: %+v", mixed)
	}
	if got := e.search(scopeB, "roadmap", false); len(got) != 0 {
		t.Fatalf("another tenant sees nothing: %+v", got)
	}
}

func TestB5_SearchFiltersTheArchiveAndChecksItsInput(t *testing.T) {
	e := newSearchEnv(t)
	main := e.mainLine()
	e.turn(main.ID, "archived knowledge", "ok")
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, main.ID, true); err != nil {
		t.Fatal(err)
	}
	if got := e.search(scopeA, "knowledge", false); len(got) != 0 {
		t.Fatalf("the active view leaves the archive out: %+v", got)
	}
	if got := e.search(scopeA, "knowledge", true); len(got) != 1 {
		t.Fatalf("archived=true: %+v", got)
	}
	_, err := e.engine.Search(e.ctx, scopeA, tangent.SearchInput{Query: "k"})
	wantCode(t, err, domain.CodeInvalidInput)
	_, err = e.engine.Search(e.ctx, scopeA, tangent.SearchInput{Query: strings.Repeat("k", 201)})
	wantCode(t, err, domain.CodeTooLong)
	_, err = e.engine.Search(e.ctx, tangent.Scope{}, tangent.SearchInput{Query: "knowledge"})
	wantCode(t, err, domain.CodeInvalidInput)
}

// searchOff turns search off for tenant B.
type searchOff struct{}

func (searchOff) Mode(_ context.Context, scope tangent.Scope, feature string) tangent.Mode {
	if scope.Tenant == scopeB.Tenant && feature == tangent.FeatureSearch {
		return tangent.ModeOff
	}
	return tangent.ModeAuto
}

func TestB5_SearchIsAFeature(t *testing.T) {
	e := newSearchEnv(t, tangent.WithFeaturePolicy(searchOff{}))
	_, err := e.engine.Search(e.ctx, scopeB, tangent.SearchInput{Query: "anything"})
	wantCode(t, err, domain.CodeFeatureDisabled)
	if !e.engine.FeatureConfigured(tangent.FeatureSearch) {
		t.Fatal("search is configured")
	}
	caps, err := e.engine.Capabilities(e.ctx, scopeA)
	if err != nil {
		t.Fatal(err)
	}
	if c := capability(caps, tangent.FeatureSearch); c.Name != tangent.FeatureSearch || !c.Enabled || c.Mode != "" {
		t.Fatalf("capabilities list search, on, without a mode: %+v", caps)
	}

	plain := newEnv(t)
	_, err = plain.engine.Search(plain.ctx, scopeA, tangent.SearchInput{Query: "anything"})
	wantCode(t, err, domain.CodeFeatureDisabled)
}

func TestB5_NewRefusesSearchWithoutItsMigration(t *testing.T) {
	pool := tangenttest.OpenFeatures(t) // core migrations only
	_, err := tangent.New(pool, tangent.WithFeatures(tangent.Search()))
	if err == nil || !strings.Contains(err.Error(), `store.MigrateFeatures(ctx, pool, "search")`) {
		t.Fatalf("err = %v", err)
	}
	if _, err := tangent.New(pool, tangent.WithFeatures(tangent.Notes())); err != nil {
		t.Fatalf("features without migrations need no check: %v", err)
	}
}
