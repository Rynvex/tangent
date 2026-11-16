package tangent_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// B19: an import keeps the source's dates, writes milestone chapter cuts and
// branches already brought back, their card right after the anchor.

func tp(t time.Time) *time.Time { return &t }

// datedImport is a conversation of three rounds; the third question comes
// 45 minutes after the second answer.
func datedImport(t0 time.Time) tangent.ImportInput {
	return tangent.ImportInput{
		Title: "MVCC notes",
		Messages: []domain.ImportMessage{
			{ExternalID: "m1", Role: "user", Content: "Explain MVCC in PostgreSQL please", CreatedAt: tp(t0)},
			{ExternalID: "m2", Role: "assistant", Content: "Every transaction sees a snapshot.", CreatedAt: tp(t0.Add(time.Minute))},
			{ExternalID: "m3", Role: "user", Content: "When does VACUUM run?", CreatedAt: tp(t0.Add(2 * time.Minute))},
			{ExternalID: "m4", Role: "assistant", Content: "When dead tuples pass a threshold."},
			{ExternalID: "m5", Role: "user", Content: "And what about index bloat?", CreatedAt: tp(t0.Add(47 * time.Minute))},
			{ExternalID: "m6", Role: "assistant", Content: "REINDEX CONCURRENTLY rebuilds it.", CreatedAt: tp(t0.Add(48 * time.Minute))},
		},
		Branches: []domain.ImportBranch{{
			AnchorExternalID: "m2", Purpose: "Table locks instead", CreatedAt: tp(t0.Add(3 * time.Minute)),
			Messages: []domain.ImportMessage{
				{Role: "user", Content: "What if we used table locks?"},
				{Role: "assistant", Content: "Readers and writers would block.", CreatedAt: tp(t0.Add(5 * time.Minute))},
			},
		}},
	}
}

func TestImport_KeepsTheSourcesDates(t *testing.T) {
	e := newEnvWith(t, b18Features())
	t0 := time.Date(2025, time.March, 1, 9, 0, 0, 0, time.UTC)
	fresh := e.mainLine()
	out, err := e.engine.ImportLine(e.ctx, scopeA, datedImport(t0))
	if err != nil {
		t.Fatal(err)
	}
	line, err := e.engine.GetLine(e.ctx, scopeA, out.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	last := t0.Add(48 * time.Minute)
	if !line.CreatedAt.Equal(t0) || !line.LastActivityAt.Equal(last) || !line.UpdatedAt.Equal(last) || !out.Line.CreatedAt.Equal(t0) {
		t.Fatalf("line dates = %v %v %v", line.CreatedAt, line.LastActivityAt, line.UpdatedAt)
	}
	want := []time.Time{t0, t0.Add(time.Minute), t0.Add(2 * time.Minute), t0.Add(2 * time.Minute), t0.Add(47 * time.Minute), last}
	main := e.transcript(line.ID)
	for i, m := range main {
		if !m.CreatedAt.Equal(want[i]) {
			t.Fatalf("message %d dated %v, want %v", i, m.CreatedAt, want[i])
		}
	}
	branch := out.Branches[0]
	if !branch.CreatedAt.Equal(t0.Add(3*time.Minute)) || branch.ClosedAt == nil || !branch.ClosedAt.Equal(t0.Add(5*time.Minute)) ||
		!branch.LastActivityAt.Equal(t0.Add(5*time.Minute)) {
		t.Fatalf("branch dates = %v %v %v", branch.CreatedAt, branch.ClosedAt, branch.LastActivityAt)
	}
	side := e.transcript(branch.LineID)
	if !side[0].CreatedAt.Equal(t0.Add(3*time.Minute)) || !side[1].CreatedAt.Equal(t0.Add(5*time.Minute)) {
		t.Fatalf("branch messages dated %v %v", side[0].CreatedAt, side[1].CreatedAt)
	}
	// The list sorts it by its real last activity: after today's line.
	page, err := e.engine.ListLines(e.ctx, scopeA, tangent.LineQuery{})
	if err != nil || len(page.Lines) != 2 || page.Lines[0].ID != fresh.ID || page.Lines[1].ID != line.ID {
		t.Fatalf("lines = %+v %v", page.Lines, err)
	}
	// The 45-minute pause is a time_gap chapter cut for decompose, and an
	// idle chapter for the chapters view.
	plan, err := e.engine.Decompose(e.ctx, scopeA, line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.ChapterCuts) != 1 || plan.ChapterCuts[0].MessageID != main[4].ID || plan.ChapterCuts[0].Reason != domain.DecomposeReasonTimeGap {
		t.Fatalf("decompose cuts = %+v", plan.ChapterCuts)
	}
	chapters, err := e.engine.ListChapters(e.ctx, scopeA, line.ID)
	if err != nil || len(chapters.Chapters) != 2 || chapters.Chapters[1].StartMessageID != main[4].ID {
		t.Fatalf("chapters = %+v %v", chapters.Chapters, err)
	}
}

func TestImport_WithoutDatesIsDatedAtTheImport(t *testing.T) {
	e := newEnvWith(t, b18Features())
	before := time.Now().Add(-time.Minute)
	out, err := e.engine.ImportLine(e.ctx, scopeA, importInput())
	if err != nil {
		t.Fatal(err)
	}
	if out.Line.CreatedAt.Before(before) || out.Line.LastActivityAt.Before(before) || out.Branches[0].CreatedAt.Before(before) {
		t.Fatalf("an undated import is dated now: %v %v", out.Line.CreatedAt, out.Branches[0].CreatedAt)
	}
	main := e.transcript(out.Line.ID)
	for i := 1; i < len(main); i++ {
		if main[i].CreatedAt.Before(main[i-1].CreatedAt) || main[i].CreatedAt.Before(before) {
			t.Fatalf("message %d dated %v", i, main[i].CreatedAt)
		}
	}
	if len(out.Cuts) != 0 || len(out.Leaves) != 0 {
		t.Fatalf("cuts %v leaves %v", out.Cuts, out.Leaves)
	}
}

// assembledImport is datedImport with three chapter cuts and branches: one
// merged on m2, then on m4 an open one and a merged one.
func assembledImport(t0 time.Time) tangent.ImportInput {
	in := datedImport(t0)
	in.Branches[0].Status = "merged"
	in.Branches[0].Card = &domain.BranchCard{Conclusion: "Table locks block readers.", OpenItems: []string{"measure lock waits"}}
	in.Branches = append(in.Branches,
		domain.ImportBranch{AnchorExternalID: "m4", Kind: "investigate", Status: "open", Messages: []domain.ImportMessage{{Role: "user", Content: "Autovacuum settings?"}}},
		domain.ImportBranch{AnchorExternalID: "m4", Purpose: "Freeze", Status: "merged", Card: &domain.BranchCard{Question: "Wraparound?", Conclusion: "VACUUM FREEZE prevents it."},
			Messages: []domain.ImportMessage{{Role: "user", Content: "What is wraparound?"}, {Role: "assistant", Content: "xid counters wrap."}}},
	)
	in.ChapterCuts = []domain.ImportChapterCut{{AnchorExternalID: "m1", Title: "§1 MVCC"}, {AnchorExternalID: "m3", Title: "§2 VACUUM"}, {AnchorExternalID: "m5", Title: "§3 Indexes"}}
	return in
}

func TestImport_AssemblesChaptersAndMergedBranches(t *testing.T) {
	e := newEnvWith(t, b18Features())
	t0 := time.Date(2025, time.March, 1, 9, 0, 0, 0, time.UTC)
	e.rollsBack("ImportLine", func(opt tangent.TxOption) error {
		_, err := e.engine.ImportLine(e.ctx, scopeA, assembledImport(t0), opt)
		return err
	})
	if n := e.count(`SELECT count(*) FROM tangent_line`) + e.count(`SELECT count(*) FROM tangent_chapter_cut`); n != 0 {
		t.Fatalf("a rolled-back import left %d rows", n)
	}
	e.events.Reset()
	out, err := e.engine.ImportLine(e.ctx, scopeA, assembledImport(t0))
	if err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventLineCreated,
		tangent.EventLineCreated, tangent.EventBranchChanged, tangent.EventLineCreated, tangent.EventBranchChanged,
		tangent.EventLineCreated, tangent.EventBranchChanged, tangent.EventLeafChanged, tangent.EventLeafChanged, tangent.EventChaptersChanged)
	main := e.transcript(out.Line.ID)
	if got := contents(main); !slices.Equal(got, []string{
		"Explain MVCC in PostgreSQL please", "Every transaction sees a snapshot.", domain.MessageKindBranchCard,
		"When does VACUUM run?", "When dead tuples pass a threshold.", domain.MessageKindBranchCard,
		"And what about index bloat?", "REINDEX CONCURRENTLY rebuilds it.",
	}) {
		t.Fatalf("main = %q", got)
	}
	if out.MessageCount != 6 || out.Line.BranchCounts.Merged != 2 || out.Line.BranchCounts.Open != 1 {
		t.Fatalf("count %d branch counts %+v", out.MessageCount, out.Line.BranchCounts)
	}
	locks, freeze := out.Branches[0], out.Branches[2]
	for _, c := range []struct {
		branch   domain.BranchView
		card     domain.Message
		question string
	}{{locks, main[2], "Table locks instead"}, {freeze, main[5], "Wraparound?"}} {
		card := c.card
		if card.Role != domain.RoleSystem || !card.Meta.Delivered || card.Meta.BranchLineID != c.branch.LineID || card.Meta.Card == nil ||
			card.Meta.Card.Question != c.question || card.Content != domain.RenderBranchCardMarkdown(*card.Meta.Card, c.branch.Purpose) {
			t.Fatalf("card = %+v", card)
		}
		if c.branch.Status != domain.BranchStatusMerged || c.branch.CardMessageID != card.ID || c.branch.ConclusionLine != domain.BranchConclusionLine(*card.Meta.Card) ||
			c.branch.Leaf == nil || c.branch.Leaf.Status != domain.LeafStatusConfirmed {
			t.Fatalf("merged branch = %+v leaf %+v", c.branch, c.branch.Leaf)
		}
	}
	// Each card is dated like its anchor, so dates never go down.
	if !main[2].CreatedAt.Equal(main[1].CreatedAt) || !main[5].CreatedAt.Equal(main[4].CreatedAt) || main[2].Seq <= main[1].Seq || main[3].Seq <= main[2].Seq {
		t.Fatalf("cards out of place: %+v", main)
	}
	if open := out.Branches[1]; open.Status != domain.BranchStatusOpen || open.AnchorMessageID != main[4].ID || open.CardMessageID != "" {
		t.Fatalf("open = %+v", open)
	}
	if len(out.Leaves) != 2 || out.Leaves[0].LineID != locks.LineID || out.Leaves[1].LineID != freeze.LineID {
		t.Fatalf("leaves = %+v", out.Leaves)
	}
	chapters, err := e.engine.ListChapters(e.ctx, scopeA, out.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	titles := []string{}
	for _, cut := range chapters.Milestones {
		titles = append(titles, cut.Title)
	}
	slices.Sort(titles)
	if !slices.Equal(titles, []string{"§1 MVCC", "§2 VACUUM", "§3 Indexes"}) || len(out.Cuts) != 3 {
		t.Fatalf("milestones = %q", titles)
	}
	starts := []string{}
	for _, chapter := range chapters.Chapters {
		starts = append(starts, chapter.StartMessageID)
	}
	if !slices.Equal(starts, []string{main[0].ID, main[3].ID, main[6].ID}) || chapters.Chapters[1].Title != "§2 VACUUM" {
		t.Fatalf("chapters = %+v", chapters.Chapters)
	}
	// The cards were part of the conversation: no notice carries them, the
	// history shows them in place and the line goes on.
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, out.Line.ID, "next")
	if err != nil {
		t.Fatal(err)
	}
	for _, section := range append(preview.Prompt.Sections, preview.Prompt.Trailing...) {
		if section.Key == domain.SectionBranchCards {
			t.Fatalf("a delivered card is noticed again: %q", section.Body)
		}
	}
	if history := preview.Prompt.History; len(history) != 8 || !strings.Contains(history[2].Content, "Table locks block readers.") {
		t.Fatalf("history = %+v", history)
	}
	if next := e.turn(out.Line.ID, "q", "a"); len(next.Message.Meta.DeliversCards) != 0 {
		t.Fatalf("the next turn carried %v", next.Message.Meta.DeliversCards)
	}
	// The open branch's pack ends at its anchor and, like a branch opened on
	// the line, quotes the conversation only (not the earlier card).
	detail, err := e.engine.GetBranch(e.ctx, scopeA, out.Branches[1].LineID)
	if err != nil || detail.Pack.AnchorMessageID != main[4].ID || len(detail.Pack.Recent) != 4 || detail.Pack.Recent[3].ID != main[4].ID {
		t.Fatalf("pack = %+v %v", detail.Pack, err)
	}
}

func TestImport_AssemblyFollowsTheFeatures(t *testing.T) {
	// Chapters off and no leaf: the cuts are still written (decompose reads
	// them), without chapters.changed, and no leaf.
	features := []tangent.Feature{tangent.Notes(), tangent.Aside()}
	e := newEnvWith(t, features)
	e.events.Reset()
	out, err := e.engine.ImportLine(e.ctx, scopeA, assembledImport(time.Date(2025, time.March, 1, 9, 0, 0, 0, time.UTC)))
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range e.events.Types() {
		if kind == tangent.EventChaptersChanged || kind == tangent.EventLeafChanged {
			t.Fatalf("events = %v", e.events.Types())
		}
	}
	if len(out.Cuts) != 3 || len(out.Leaves) != 0 || out.Branches[0].Leaf != nil || out.Branches[0].Status != domain.BranchStatusMerged {
		t.Fatalf("cuts %d leaves %d branch %+v", len(out.Cuts), len(out.Leaves), out.Branches[0])
	}
	plan, err := e.engine.Decompose(e.ctx, scopeA, out.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, cut := range plan.ChapterCuts {
		if cut.MessageID == out.Cuts[2].MessageID {
			t.Fatalf("decompose proposes a cut where a milestone is: %+v", plan.ChapterCuts)
		}
	}
}

func TestImport_AssemblyRefusals(t *testing.T) {
	e := newEnvWith(t, b18Features())
	t0 := time.Date(2025, time.March, 1, 9, 0, 0, 0, time.UTC)
	refuse := func(name, code string, mutate func(in *tangent.ImportInput)) {
		t.Helper()
		in := assembledImport(t0)
		mutate(&in)
		_, err := e.engine.ImportLine(e.ctx, scopeA, in)
		if got := domain.CodeOf(err); got != code {
			t.Fatalf("%s: code = %q (%v), want %q", name, got, err, code)
		}
	}
	refuse("a merged branch without a card", domain.CodeInvalidInput, func(in *tangent.ImportInput) { in.Branches[0].Card = nil })
	refuse("a card on an open branch", domain.CodeInvalidInput, func(in *tangent.ImportInput) { in.Branches[1].Card = in.Branches[0].Card })
	refuse("a card without a conclusion", domain.CodeInvalidCard, func(in *tangent.ImportInput) {
		in.Branches[2].Card = &domain.BranchCard{Question: "q"}
	})
	refuse("a cut on an unknown message", domain.CodeInvalidInput, func(in *tangent.ImportInput) { in.ChapterCuts[0].AnchorExternalID = "zz" })
	refuse("two cuts on one message", domain.CodeInvalidInput, func(in *tangent.ImportInput) { in.ChapterCuts[1].AnchorExternalID = "m1" })
	refuse("a date in the far future", domain.CodeInvalidInput, func(in *tangent.ImportInput) {
		in.Messages[3].CreatedAt = tp(time.Now().Add(48 * time.Hour))
	})
	refuse("a date before 1970", domain.CodeInvalidInput, func(in *tangent.ImportInput) {
		in.CreatedAt = tp(time.Date(1969, time.December, 31, 0, 0, 0, 0, time.UTC))
	})
	if n := e.count(`SELECT count(*) FROM tangent_line`); n != 0 {
		t.Fatalf("refused imports left %d lines", n)
	}
}

func TestImport_CardsKeepTheBranchOrderAndMayEndTheLine(t *testing.T) {
	e := newEnvWith(t, b18Features())
	long := strings.Repeat("結", domain.BranchCardFieldMaxRunes)
	items := make([]string, 0, domain.BranchCardMaxOpenItems)
	for range domain.BranchCardMaxOpenItems {
		items = append(items, strings.Repeat("項", 500))
	}
	in := importInput()
	in.Branches = []domain.ImportBranch{
		{AnchorExternalID: "m2", Purpose: "first", Status: "merged", Card: &domain.BranchCard{Conclusion: "one"}, Messages: []domain.ImportMessage{{Role: "user", Content: "a"}}},
		{AnchorExternalID: "m2", Purpose: "second", Status: "merged", Card: &domain.BranchCard{Conclusion: "two"}, Messages: []domain.ImportMessage{{Role: "user", Content: "b"}}},
		// The longest card the limits allow: its leaf is cut to the leaf limits.
		{AnchorExternalID: "m4", Purpose: "last", Status: "merged", Card: &domain.BranchCard{Conclusion: long, OpenItems: items}, Messages: []domain.ImportMessage{{Role: "user", Content: "c"}}},
	}
	out, err := e.engine.ImportLine(e.ctx, scopeA, in)
	if err != nil {
		t.Fatal(err)
	}
	main := e.transcript(out.Line.ID)
	if got := contents(main); !slices.Equal(got, []string{
		"Explain MVCC in PostgreSQL please", "Every transaction sees a snapshot.\n {\"purpose\":\"x\"}", domain.MessageKindBranchCard, domain.MessageKindBranchCard,
		"When does VACUUM run?", "When dead tuples pass a threshold.", domain.MessageKindBranchCard,
	}) {
		t.Fatalf("main = %q", got)
	}
	for i, at := range []int{2, 3, 6} {
		if main[at].Meta.BranchLineID != out.Branches[i].LineID || out.Branches[i].CardMessageID != main[at].ID {
			t.Fatalf("card %d at %d names %s", i, at, main[at].Meta.BranchLineID)
		}
	}
	if len(out.Leaves) != 3 || out.Leaves[2].Line == "" {
		t.Fatalf("leaves = %+v", out.Leaves)
	}
}
