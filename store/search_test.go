package store_test

import (
	"slices"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangenttest"
)

func newSearchFixture(t *testing.T) *fixture {
	t.Helper()
	pool := tangenttest.OpenFeatures(t, "search")
	s, err := store.New(pool, domain.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{t: t, ctx: tangenttest.Context(t), pool: pool, store: s}
}

func (f *fixture) search(query string, archived bool) []store.SearchRow {
	f.t.Helper()
	rows, err := f.store.Search(f.ctx, store.SearchInput{Tenant: tenant, Query: query, Limit: 50, Archived: archived})
	if err != nil {
		f.t.Fatal(err)
	}
	return rows
}

func kindsOf(rows []store.SearchRow) []string {
	out := []string{}
	for _, row := range rows {
		out = append(out, row.Kind+":"+row.Text)
	}
	return out
}

func TestSearch_FindsTitlesPurposesAndFinishedChatMessages(t *testing.T) {
	f := newSearchFixture(t)
	main, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant, Title: "京都旅行 Kyoto trip"})
	if err != nil {
		t.Fatal(err)
	}
	anchor := f.exchange(main.ID, "秋天去京都好嗎？", "Kyoto in autumn is lovely.")
	input := f.branchInput(main.ID, anchor.ID)
	input.Purpose = "比較京都的旅館 ryokan"
	created, err := f.store.CreateBranch(f.ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	branchReply := f.exchange(created.Line.ID, "旅館值得嗎", "A ryokan in 京都 is worth one night.")
	f.card(main.ID) // a conclusion card is never a hit
	f.busy(main.ID) // nor is a pending reply

	rows := f.search("京都", false)
	if len(rows) != 4 {
		t.Fatalf("hits %v", kindsOf(rows))
	}
	byKind := map[string][]store.SearchRow{}
	for _, row := range rows {
		byKind[row.Kind] = append(byKind[row.Kind], row)
		if row.RootLineID != main.ID || row.RootTitle != "京都旅行 Kyoto trip" || row.Score <= 0 || row.Score > 1 || row.At.IsZero() {
			t.Fatalf("hit %+v", row)
		}
	}
	if len(byKind["title"]) != 1 || len(byKind["purpose"]) != 1 || len(byKind["message"]) != 2 {
		t.Fatalf("hits %v", kindsOf(rows))
	}
	purpose := byKind["purpose"][0]
	if purpose.LineID != created.Line.ID || purpose.Purpose != "比較京都的旅館 ryokan" || purpose.MessageID != "" {
		t.Fatalf("purpose hit %+v", purpose)
	}
	inBranch := slices.IndexFunc(byKind["message"], func(r store.SearchRow) bool { return r.MessageID == branchReply.ID })
	if inBranch < 0 {
		t.Fatalf("the branch reply is a hit: %v", kindsOf(rows))
	}
	hit := byKind["message"][inBranch]
	if hit.LineID != created.Line.ID || hit.Seq != branchReply.Seq || hit.Role != domain.RoleAssistant || hit.Purpose != "比較京都的旅館 ryokan" {
		t.Fatalf("message hit %+v", hit)
	}
	if english := f.search("RYOKAN", false); len(english) != 2 {
		t.Fatalf("case-insensitive English: %v", kindsOf(english))
	}
	if mixed := f.search("ryokan in 京都", false); len(mixed) != 1 || mixed[0].MessageID != branchReply.ID {
		t.Fatalf("mixed text: %v", kindsOf(mixed))
	}
}

func TestSearch_RanksBySimilarityThenRecency(t *testing.T) {
	f := newSearchFixture(t)
	main, _ := f.mainLine()
	f.exchange(main.ID, "the trip budget", "x")
	f.message(main.ID, domain.RoleUser, "budget")
	rows := f.search("budget", false)
	if len(rows) != 2 || rows[0].Text != "budget" || rows[0].Score <= rows[1].Score {
		t.Fatalf("an exact match ranks first: %+v", rows)
	}
	f.message(main.ID, domain.RoleUser, "budget")
	rows = f.search("budget", false)
	if len(rows) != 3 || rows[0].Score != rows[1].Score || rows[0].Seq < rows[1].Seq {
		t.Fatalf("equal scores: the newest first: %+v", rows)
	}
}

func TestSearch_IsolatesTenantsFiltersArchiveAndEscapesWildcards(t *testing.T) {
	f := newSearchFixture(t)
	main, _ := f.mainLine()
	f.message(main.ID, domain.RoleUser, "100% sure about a_b")
	f.message(main.ID, domain.RoleUser, "axb is not it")
	other, err := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: otherTenant, Title: "100% other"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.InsertMessage(f.ctx, otherTenant, other.ID, store.NewMessage{Role: domain.RoleUser, Content: "100% other tenant"}); err != nil {
		t.Fatal(err)
	}
	if rows := f.search("100%", false); len(rows) != 1 || rows[0].LineID != main.ID {
		t.Fatalf("tenant A sees only its own: %v", kindsOf(rows))
	}
	if rows := f.search("a_b", false); len(rows) != 1 {
		t.Fatalf("_ is not a wildcard: %v", kindsOf(rows))
	}
	if _, err := f.store.ArchiveTree(f.ctx, tenant, main.ID, true); err != nil {
		t.Fatal(err)
	}
	if rows := f.search("100%", false); len(rows) != 0 {
		t.Fatalf("archived trees are left out: %v", kindsOf(rows))
	}
	if rows := f.search("100%", true); len(rows) != 1 {
		t.Fatalf("archived=true searches the archive: %v", kindsOf(rows))
	}
}

func TestSearch_BoundsTheResultAndRefusesBadInput(t *testing.T) {
	f := newSearchFixture(t)
	main, _ := f.mainLine()
	for range 7 {
		f.message(main.ID, domain.RoleUser, "repeat me")
	}
	rows, err := f.store.Search(f.ctx, store.SearchInput{Tenant: tenant, Query: "repeat", Limit: 5})
	if err != nil || len(rows) != 5 {
		t.Fatalf("limit: %d rows, %v", len(rows), err)
	}
	if _, err := f.store.Search(f.ctx, store.SearchInput{Tenant: tenant, Query: " "}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("empty query: %v", err)
	}
	if _, err := f.store.Search(f.ctx, store.SearchInput{Query: "repeat"}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("no tenant: %v", err)
	}
}

func TestSearch_OlderMessagesAreSearchedWhenTheNewestHoldTooFew(t *testing.T) {
	f := newSearchFixture(t)
	defer store.SetSearchWindow(3)()
	main, _ := f.mainLine()
	f.message(main.ID, domain.RoleUser, "an old rare word: zephyr")
	f.message(main.ID, domain.RoleUser, "短 old")
	for range 6 {
		f.message(main.ID, domain.RoleUser, "common chatter 短")
	}
	if rows := f.search("zephyr", false); len(rows) != 1 {
		t.Fatalf("a rare word in an old message (trigram path): %v", kindsOf(rows))
	}
	if rows := f.search("短 o", false); len(rows) != 1 {
		t.Fatalf("an old match of a short query (walk): %v", kindsOf(rows))
	}
	if rows := f.search("chatter", false); len(rows) != 6 {
		t.Fatalf("recent and older matches together: %v", kindsOf(rows))
	}
}
