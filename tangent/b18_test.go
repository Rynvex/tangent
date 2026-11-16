package tangent_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// B18: folders and tags on main lines, importing a conversation, extracting
// any stretch of a line into a branch and the decompose plan.

// b18Features: the first batch with leaf, fold, chapters and spinoff on.
func b18Features() []tangent.Feature {
	return append(tangent.AllFeatures(), tangent.Leaf(tangent.ModeSuggest), tangent.Fold(tangent.ModeManual), tangent.Spinoff())
}

// exchange runs one turn and returns its operator message and its reply.
func (e *env) exchange(lineID, content, reply string) (domain.Message, domain.Message) {
	e.t.Helper()
	e.runner.Queue(tangenttest.Reply{Content: reply})
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, lineID, tangent.TurnInput{Content: content})
	if err != nil {
		e.t.Fatal(err)
	}
	done, err := e.engine.RunTurn(e.ctx, turn, e.runner)
	if err != nil {
		e.t.Fatal(err)
	}
	return turn.UserMessage, done.Message
}

// transcript is a line's messages in seq order.
func (e *env) transcript(lineID string) []domain.Message {
	e.t.Helper()
	messages, err := e.engine.ListMessages(e.ctx, scopeA, lineID, 0, 500)
	if err != nil {
		e.t.Fatal(err)
	}
	return messages
}

// contents are the messages' texts (a card or marker shows its kind).
func contents(messages []domain.Message) []string {
	out := make([]string, 0, len(messages))
	for _, m := range messages {
		if m.Kind != domain.MessageKindChat {
			out = append(out, m.Kind)
			continue
		}
		out = append(out, m.Content)
	}
	return out
}

// historyTexts is what a preview of the line's next turn shows as history.
func (e *env) historyTexts(lineID string) []string {
	e.t.Helper()
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, lineID, "next")
	if err != nil {
		e.t.Fatal(err)
	}
	out := []string{}
	for _, entry := range preview.Prompt.History {
		out = append(out, entry.Content)
	}
	return out
}

func strp(s string) *string { return &s }

func TestOrganize_FolderAndTagsAreNormalisedOnMainLinesOnly(t *testing.T) {
	e := newEnvWith(t, b18Features())
	line, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Title: "t", Folder: "  Research\n", Tags: []string{"#Go", "go", " Postgres ", ""}})
	if err != nil {
		t.Fatal(err)
	}
	if line.Folder != "Research" || !slices.Equal(line.Tags, []string{"go", "postgres"}) {
		t.Fatalf("created = %q %v", line.Folder, line.Tags)
	}
	plain := e.mainLine()
	if plain.Folder != "" || plain.Tags == nil || len(plain.Tags) != 0 {
		t.Fatalf("an unorganised line has \"\" and [] = %q %#v", plain.Folder, plain.Tags)
	}
	_, err = e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Folder: strings.Repeat("f", domain.FolderMaxRunes+1)})
	wantCode(t, err, domain.CodeInvalidInput)
	_, err = e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Tags: []string{strings.Repeat("t", domain.TagMaxRunes+1)}})
	wantCode(t, err, domain.CodeInvalidInput)

	tags := []string{"MVCC"}
	e.events.Reset()
	updated, err := e.engine.UpdateLine(e.ctx, scopeA, line.ID, tangent.LinePatch{Tags: &tags})
	if err != nil || updated.Folder != "Research" || !slices.Equal(updated.Tags, []string{"mvcc"}) || !updated.LastActivityAt.Equal(line.LastActivityAt) {
		t.Fatalf("tags replaced, folder and activity kept = %+v %v", updated, err)
	}
	e.wantTypes(tangent.EventLineUpdated)

	reply := e.turn(line.ID, "q", "a")
	branch := e.branch(line.ID, reply.Message.ID, "side")
	if branch.Line.Folder != "" || branch.Line.Tags == nil || len(branch.Line.Tags) != 0 {
		t.Fatalf("a branch is unfiled and untagged: %q %#v", branch.Line.Folder, branch.Line.Tags)
	}
	_, err = e.engine.UpdateLine(e.ctx, scopeA, branch.Line.ID, tangent.LinePatch{Folder: strp("x")})
	wantCode(t, err, domain.CodeInvalidInput)
	_, err = e.engine.UpdateLine(e.ctx, scopeA, branch.Line.ID, tangent.LinePatch{Tags: &tags})
	wantCode(t, err, domain.CodeInvalidInput)
	none := []string{}
	if same, err := e.engine.UpdateLine(e.ctx, scopeA, branch.Line.ID, tangent.LinePatch{Folder: strp(""), Tags: &none}); err != nil || same.Folder != "" || len(same.Tags) != 0 {
		t.Fatalf("\"\" and [] on a branch change nothing: %+v %v", same, err)
	}
}

func TestOrganize_ListLinesFiltersByFolderAndTag(t *testing.T) {
	e := newEnvWith(t, b18Features())
	create := func(title, folder string, tags ...string) domain.LineView {
		line, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Title: title, Folder: folder, Tags: tags})
		if err != nil {
			t.Fatal(err)
		}
		return line
	}
	a := create("a", "Work", "go")
	b := create("b", "Work", "sql")
	create("c", "", "go")
	create("d", "Home")
	if _, err := e.engine.CreateLine(e.ctx, scopeB, tangent.LineInput{Title: "other", Folder: "Work", Tags: []string{"go"}}); err != nil {
		t.Fatal(err)
	}
	titles := func(q tangent.LineQuery) []string {
		t.Helper()
		page, err := e.engine.ListLines(e.ctx, scopeA, q)
		if err != nil {
			t.Fatal(err)
		}
		out := []string{}
		for _, line := range page.Lines {
			out = append(out, line.Title)
		}
		return out
	}
	if got := titles(tangent.LineQuery{Folder: "Work"}); !slices.Equal(got, []string{"b", "a"}) {
		t.Fatalf("folder Work = %v", got)
	}
	if got := titles(tangent.LineQuery{Folder: domain.FolderUnfiled}); !slices.Equal(got, []string{"c"}) {
		t.Fatalf("unfiled = %v", got)
	}
	if got := titles(tangent.LineQuery{Tag: "#GO"}); !slices.Equal(got, []string{"c", "a"}) {
		t.Fatalf("tag go = %v", got)
	}
	if got := titles(tangent.LineQuery{Folder: "Work", Tag: "go"}); !slices.Equal(got, []string{"a"}) {
		t.Fatalf("both = %v", got)
	}
	if got := titles(tangent.LineQuery{}); len(got) != 4 {
		t.Fatalf("no filter = %v", got)
	}
	// Pagination works the same with a filter.
	first, err := e.engine.ListLines(e.ctx, scopeA, tangent.LineQuery{Folder: "Work", Limit: 1})
	if err != nil || len(first.Lines) != 1 || first.Lines[0].ID != b.ID || first.NextCursor == "" {
		t.Fatalf("first page = %+v %v", first, err)
	}
	second, err := e.engine.ListLines(e.ctx, scopeA, tangent.LineQuery{Folder: "Work", Limit: 1, Cursor: first.NextCursor})
	if err != nil || len(second.Lines) != 1 || second.Lines[0].ID != a.ID || second.NextCursor != "" {
		t.Fatalf("second page = %+v %v", second, err)
	}
	// Archived lines are filtered with the archived list.
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, a.ID, true); err != nil {
		t.Fatal(err)
	}
	if got := titles(tangent.LineQuery{Folder: "Work", Archived: true}); !slices.Equal(got, []string{"a"}) {
		t.Fatalf("archived Work = %v", got)
	}
	_, err = e.engine.ListLines(e.ctx, scopeA, tangent.LineQuery{Tag: strings.Repeat("x", domain.TagMaxRunes+1)})
	wantCode(t, err, domain.CodeInvalidInput)
}

func TestOrganize_RenameFolderMovesTheTenantsMainLines(t *testing.T) {
	e := newEnvWith(t, b18Features())
	var lines []domain.LineView
	for _, title := range []string{"a", "b"} {
		line, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Title: title, Folder: "Old"})
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, lines[1].ID, true); err != nil {
		t.Fatal(err)
	}
	other, err := e.engine.CreateLine(e.ctx, scopeB, tangent.LineInput{Title: "b", Folder: "Old"})
	if err != nil {
		t.Fatal(err)
	}
	e.rollsBack("RenameFolder", func(opt tangent.TxOption) error {
		_, err := e.engine.RenameFolder(e.ctx, scopeA, "Old", "New", opt)
		return err
	})
	e.events.Reset()
	renamed, err := e.engine.RenameFolder(e.ctx, scopeA, " Old ", "New")
	if err != nil || len(renamed.LineIDs) != 2 || renamed.From != "Old" || renamed.To != "New" {
		t.Fatalf("renamed = %+v %v", renamed, err)
	}
	e.wantTypes(tangent.EventLineUpdated, tangent.EventLineUpdated)
	for _, ev := range e.events.OfType(tangent.EventLineUpdated) {
		if view := ev.Data.(domain.LineView); view.Folder != "New" {
			t.Fatalf("line.updated = %+v", view)
		}
	}
	got, err := e.engine.GetLine(e.ctx, scopeA, lines[0].ID)
	if err != nil || got.Folder != "New" || !got.LastActivityAt.Equal(lines[0].LastActivityAt) {
		t.Fatalf("renamed line = %+v %v", got, err)
	}
	if kept, _ := e.engine.GetLine(e.ctx, scopeB, other.ID); kept.Folder != "Old" {
		t.Fatalf("another tenant's folder is untouched: %q", kept.Folder)
	}
	// "" unfiles; the same name or an empty folder changes nothing.
	unfiled, err := e.engine.RenameFolder(e.ctx, scopeA, "New", "")
	if err != nil || len(unfiled.LineIDs) != 2 {
		t.Fatalf("unfiled = %+v %v", unfiled, err)
	}
	e.events.Reset()
	if same, err := e.engine.RenameFolder(e.ctx, scopeA, "Gone", "Gone"); err != nil || len(same.LineIDs) != 0 {
		t.Fatalf("same name = %+v %v", same, err)
	}
	e.wantTypes()
	_, err = e.engine.RenameFolder(e.ctx, scopeA, " ", "x")
	wantCode(t, err, domain.CodeInvalidInput)
	_, err = e.engine.RenameFolder(e.ctx, scopeA, "x", strings.Repeat("y", domain.FolderMaxRunes+1))
	wantCode(t, err, domain.CodeInvalidInput)
}

func TestOrganize_TenantOrganizationCountsEveryMainLine(t *testing.T) {
	e := newEnvWith(t, b18Features())
	empty, err := e.engine.TenantOrganization(e.ctx, scopeA)
	if err != nil || empty.Folders == nil || empty.Tags == nil || len(empty.Folders)+len(empty.Tags) != 0 {
		t.Fatalf("empty tenant = %+v %v", empty, err)
	}
	create := func(scope tangent.Scope, title, folder string, tags ...string) domain.LineView {
		t.Helper()
		line, err := e.engine.CreateLine(e.ctx, scope, tangent.LineInput{Title: title, Folder: folder, Tags: tags})
		if err != nil {
			t.Fatal(err)
		}
		return line
	}
	work := create(scopeA, "a", "Work", "go", "db")
	archived := create(scopeA, "b", "Work", "go", "gone")
	onlyArchived := create(scopeA, "c", "Old", "gone")
	create(scopeA, "d", "", "db", "go")
	create(scopeB, "elsewhere", "Work", "go")
	for _, id := range []string{archived.ID, onlyArchived.ID} {
		if _, err := e.engine.ArchiveTree(e.ctx, scopeA, id, true); err != nil {
			t.Fatal(err)
		}
	}
	// A branch never counts (it has no folder or tags of its own anyway).
	reply := e.turn(work.ID, "q", "a")
	e.branch(work.ID, reply.Message.ID, "side")
	got, err := e.engine.TenantOrganization(e.ctx, scopeA)
	if err != nil {
		t.Fatal(err)
	}
	// Folders by name, archived lines counted apart (a folder of archived
	// lines only still shows); tags of unarchived main lines only, most used
	// first, then by name.
	wantFolders := []domain.FolderSummary{{Folder: "Old", Active: 0, Archived: 1}, {Folder: "Work", Active: 1, Archived: 1}}
	wantTags := []domain.TagSummary{{Tag: "db", Count: 2}, {Tag: "go", Count: 2}}
	if !slices.Equal(got.Folders, wantFolders) || !slices.Equal(got.Tags, wantTags) {
		t.Fatalf("organization = %+v", got)
	}
	_, err = e.engine.TenantOrganization(e.ctx, tangent.Scope{})
	if err == nil {
		t.Fatal("an empty scope is refused")
	}
}

func TestOrganize_ASpinoffInheritsTheFolderAndTags(t *testing.T) {
	e := newEnvWith(t, b18Features())
	main, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Title: "t", Folder: "Work", Tags: []string{"go"}})
	if err != nil {
		t.Fatal(err)
	}
	reply := e.turn(main.ID, "q", "a")
	fresh, err := e.engine.Spinoff(e.ctx, scopeA, main.ID, tangent.SpinoffInput{Mode: domain.SpinoffFresh, AtMessageID: reply.Message.ID, Title: "fresh"})
	if err != nil || fresh.Line.Folder != "Work" || !slices.Equal(fresh.Line.Tags, []string{"go"}) {
		t.Fatalf("fresh = %+v %v", fresh.Line, err)
	}
	branch := e.branch(main.ID, reply.Message.ID, "detach me")
	detached, err := e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach})
	if err != nil || detached.Line.Folder != "Work" || !slices.Equal(detached.Line.Tags, []string{"go"}) {
		t.Fatalf("detached = %+v %v", detached.Line, err)
	}
}

// importInput is a small conversation with a discarded earlier attempt on
// the first reply and an open investigation on the second question.
func importInput() tangent.ImportInput {
	return tangent.ImportInput{
		Provider: "anthropic", Model: "sonnet", Folder: "DB", Tags: []string{"Postgres"}, Source: "chatgpt",
		Messages: []domain.ImportMessage{
			{ExternalID: "m1", Role: "user", Content: "Explain MVCC in PostgreSQL please"},
			{ExternalID: "m2", Role: "assistant", Content: "Every transaction sees a snapshot.\n[BRANCH-SUGGEST] {\"purpose\":\"x\"}"},
			{ExternalID: "m3", Role: "user", Content: "When does VACUUM run?"},
			{ExternalID: "m4", Role: "assistant", Content: "When dead tuples pass a threshold."},
		},
		Branches: []domain.ImportBranch{
			{AnchorExternalID: "m2", Purpose: "Table locks instead", Messages: []domain.ImportMessage{
				{Role: "user", Content: "What if we used table locks?"}, {Role: "assistant", Content: "Readers and writers would block."},
			}},
			{AnchorExternalID: "m3", Kind: "investigate", Status: "open", Messages: []domain.ImportMessage{{Role: "assistant", Content: "Another answer"}}},
		},
	}
}

func TestImport_WritesTheConversationInOneTransactionWithoutAModel(t *testing.T) {
	e := newEnvWith(t, b18Features())
	e.rollsBack("ImportLine", func(opt tangent.TxOption) error {
		_, err := e.engine.ImportLine(e.ctx, scopeA, importInput(), opt)
		return err
	})
	if n := e.count(`SELECT count(*) FROM tangent_line`); n != 0 {
		t.Fatalf("a rolled-back import left %d lines", n)
	}
	e.events.Reset()
	out, err := e.engine.ImportLine(e.ctx, scopeA, importInput())
	if err != nil {
		t.Fatal(err)
	}
	if n := len(e.runner.Requests()); n != 0 {
		t.Fatalf("an import called the runner %d times", n)
	}
	line := out.Line
	if line.Title != "Explain MVCC in PostgreSQL please" || line.Folder != "DB" || !slices.Equal(line.Tags, []string{"postgres"}) ||
		line.Provider != "anthropic" || line.Unread != 0 || line.Usage.InputTokens != 0 || out.MessageCount != 4 || out.Source != "chatgpt" {
		t.Fatalf("line = %+v count %d", line, out.MessageCount)
	}
	if line.BranchCounts.Open != 1 || line.BranchCounts.Discarded != 1 {
		t.Fatalf("branch counts = %+v", line.BranchCounts)
	}
	main := e.transcript(line.ID)
	if got := contents(main); !slices.Equal(got, []string{"Explain MVCC in PostgreSQL please", "Every transaction sees a snapshot.\n {\"purpose\":\"x\"}", "When does VACUUM run?", "When dead tuples pass a threshold."}) {
		t.Fatalf("main messages = %q", got)
	}
	for _, m := range main {
		if m.Status != domain.MessageDone || m.Kind != domain.MessageKindChat || m.Meta.Usage != nil || m.Meta.Model != "" {
			t.Fatalf("imported message = %+v", m)
		}
	}
	discarded, open := out.Branches[0], out.Branches[1]
	if discarded.Status != domain.BranchStatusDiscarded || discarded.Kind != domain.BranchKindAlternative || discarded.Origin != domain.BranchOriginImport ||
		discarded.AnchorMessageID != main[1].ID || discarded.Depth != 1 || discarded.ClosedAt == nil || discarded.MessageCount != 2 {
		t.Fatalf("discarded = %+v", discarded)
	}
	if open.Status != domain.BranchStatusOpen || open.Kind != domain.BranchKindInvestigate || open.AnchorMessageID != main[2].ID || open.Purpose != "Another answer" {
		t.Fatalf("open = %+v", open)
	}
	detail, err := e.engine.GetBranch(e.ctx, scopeA, open.LineID)
	if err != nil || len(detail.Pack.Recent) != 3 || detail.Pack.Recent[2].ID != main[2].ID || detail.Pack.AnchorMessageID != main[2].ID {
		t.Fatalf("the pack is built up to the anchor: %+v %v", detail.Pack, err)
	}
	e.wantTypes(tangent.EventLineCreated, tangent.EventLineCreated, tangent.EventBranchChanged, tangent.EventLineCreated, tangent.EventBranchChanged)
	if n := e.count(`SELECT count(*) FROM tangent_job`); n != 0 {
		t.Fatalf("an import started %d jobs", n)
	}
	// The imported conversation goes on like any other: the history shows
	// it, and there is nothing to retry.
	history := e.historyTexts(line.ID)
	if len(history) != 4 || history[0] != "Explain MVCC in PostgreSQL please" {
		t.Fatalf("history = %q", history)
	}
	_, err = e.engine.RetryTurn(e.ctx, scopeA, line.ID)
	wantCode(t, err, domain.CodeNothingToRetry)
	done := e.turn(line.ID, "And autovacuum?", "It runs by itself.")
	if done.Line.Usage.InputTokens == 0 && done.Message.Meta.Usage == nil {
		t.Fatalf("a turn after an import is metered as usual: %+v", done.Message.Meta)
	}
	if e.turn(open.LineID, "go on", "ok").Message.Status != domain.MessageDone {
		t.Fatal("an open imported branch takes turns")
	}
}

func TestImport_Refusals(t *testing.T) {
	e := newEnvWith(t, b18Features())
	refuse := func(name, code string, mutate func(in *tangent.ImportInput)) {
		t.Helper()
		in := importInput()
		mutate(&in)
		_, err := e.engine.ImportLine(e.ctx, scopeA, in)
		if got := domain.CodeOf(err); got != code {
			t.Fatalf("%s: code = %q (%v), want %q", name, got, err, code)
		}
	}
	refuse("no messages", domain.CodeInvalidInput, func(in *tangent.ImportInput) { in.Messages = nil })
	refuse("too many", domain.CodeInvalidInput, func(in *tangent.ImportInput) {
		in.Messages = make([]domain.ImportMessage, domain.ImportMaxMessages+1)
		for i := range in.Messages {
			in.Messages[i] = domain.ImportMessage{Role: "user", Content: "x"}
		}
		in.Branches = nil
	})
	refuse("system role", domain.CodeInvalidInput, func(in *tangent.ImportInput) { in.Messages[0].Role = "system" })
	refuse("empty content", domain.CodeInvalidInput, func(in *tangent.ImportInput) { in.Messages[1].Content = " ​ " })
	refuse("too long", domain.CodeTooLong, func(in *tangent.ImportInput) {
		in.Messages[0].Content = strings.Repeat("x", domain.DefaultLimits().Text.MessageMaxRunes+1)
	})
	refuse("duplicate id", domain.CodeInvalidInput, func(in *tangent.ImportInput) { in.Messages[2].ExternalID = "m1" })
	refuse("unknown anchor", domain.CodeInvalidInput, func(in *tangent.ImportInput) { in.Branches[0].AnchorExternalID = "nope" })
	refuse("aside", domain.CodeInvalidInput, func(in *tangent.ImportInput) { in.Branches[0].Kind = "aside" })
	refuse("merged", domain.CodeInvalidInput, func(in *tangent.ImportInput) { in.Branches[0].Status = "merged" })
	refuse("empty branch", domain.CodeInvalidInput, func(in *tangent.ImportInput) { in.Branches[0].Messages = nil })
	refuse("too many branches", domain.CodeInvalidInput, func(in *tangent.ImportInput) {
		in.Branches = slices.Repeat(in.Branches[:1], domain.ImportMaxBranches+1)
	})
	refuse("too many open", domain.CodeBranchLimit, func(in *tangent.ImportInput) {
		in.Branches = slices.Repeat(in.Branches[1:], domain.DefaultLimits().Branch.MaxOpenPerParent+1)
	})
	refuse("folder", domain.CodeInvalidInput, func(in *tangent.ImportInput) { in.Folder = domain.FolderUnfiled })
	refuse("title", domain.CodeTooLong, func(in *tangent.ImportInput) { in.Title = strings.Repeat("t", 201) })
	if n := e.count(`SELECT count(*) FROM tangent_line`); n != 0 {
		t.Fatalf("refused imports left %d lines", n)
	}
}

// fourExchanges is a main line of four exchanges: q1 a1 q2 a2 q3 a3 q4 a4.
func (e *env) fourExchanges() (domain.LineView, []domain.Message) {
	e.t.Helper()
	main := e.mainLine()
	var messages []domain.Message
	for _, n := range []string{"1", "2", "3", "4"} {
		user, reply := e.exchange(main.ID, "q"+n, "a"+n)
		messages = append(messages, user, reply)
	}
	return main, messages
}

func TestExtract_AMiddleRangeLeavesItsMarkerInPlace(t *testing.T) {
	e := newEnvWith(t, b18Features())
	main, m := e.fourExchanges()
	in := tangent.ExtractInput{FromMessageID: m[2].ID, ToMessageID: m[3].ID, Purpose: "the second question"}
	e.rollsBack("ExtractToBranch", func(opt tangent.TxOption) error {
		_, err := e.engine.ExtractToBranch(e.ctx, scopeA, main.ID, in, opt)
		return err
	})
	e.events.Reset()
	out, err := e.engine.ExtractToBranch(e.ctx, scopeA, main.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(out.MovedMessageIDs, []string{m[2].ID, m[3].ID}) || out.Branch.AnchorMessageID != m[1].ID || out.Branch.Origin != domain.BranchOriginMove ||
		out.Branch.Kind != domain.BranchKindInvestigate || out.Branch.Status != domain.BranchStatusOpen || out.Branch.Depth != 1 {
		t.Fatalf("extracted = %+v", out)
	}
	marker := out.Marker
	if marker.Kind != domain.MessageKindBranchMarker || marker.Seq != m[3].Seq || marker.Meta.BranchLineID != out.Line.ID || marker.LineID != main.ID ||
		!marker.CreatedAt.Equal(m[3].CreatedAt) {
		t.Fatalf("the marker takes the range's last seq: %+v (range ends at %d)", marker, m[3].Seq)
	}
	if got := contents(e.transcript(main.ID)); !slices.Equal(got, []string{"q1", "a1", domain.MessageKindBranchMarker, "q3", "a3", "q4", "a4"}) {
		t.Fatalf("source = %q", got)
	}
	branchMessages := e.transcript(out.Line.ID)
	if got := contents(branchMessages); !slices.Equal(got, []string{"q2", "a2"}) || branchMessages[1].Seq <= m[7].Seq || branchMessages[0].Seq != m[2].Seq {
		t.Fatalf("branch = %q (seqs %d, %d)", got, branchMessages[0].Seq, branchMessages[1].Seq)
	}
	history := e.historyTexts(main.ID)
	if len(history) != 7 || history[1] != "a1" || !strings.HasPrefix(history[2], "system: 2 message(s) moved to a branch") || history[3] != "q3" {
		t.Fatalf("the prompt reads in order: %q", history)
	}
	if got := e.historyTexts(out.Line.ID); !slices.Equal(got, []string{"q2", "a2"}) {
		t.Fatalf("branch history = %q", got)
	}
	detail, err := e.engine.GetBranch(e.ctx, scopeA, out.Line.ID)
	if err != nil || detail.Pack.AnchorMessageID != m[1].ID || len(detail.Pack.Recent) != 2 {
		t.Fatalf("the pack ends at the anchor: %+v %v", detail.Pack, err)
	}
	e.wantTypes(tangent.EventLineCreated, tangent.EventMessageCreated, tangent.EventLineUpdated, tangent.EventBranchChanged)
	if n := e.count(`SELECT count(*) FROM tangent_job`); n != 0 {
		t.Fatalf("an extract started %d jobs", n)
	}
	// The branch takes turns; the source goes on after its last message.
	e.turn(out.Line.ID, "more", "sure")
	if next := e.turn(main.ID, "q5", "a5"); next.Message.Seq <= marker.Seq {
		t.Fatalf("the next reply comes after the marker: %d", next.Message.Seq)
	}
}

func TestExtract_WithACardBringsTheBranchBackAlreadyDelivered(t *testing.T) {
	e := newEnvWith(t, b18Features())
	main, m := e.fourExchanges()
	card := domain.BranchCard{Question: "Why q2?", Conclusion: "Because of a2", Evidence: []domain.BranchCardEvidence{{MessageID: m[3].ID, Note: "the answer"}}}
	e.events.Reset()
	out, err := e.engine.ExtractToBranch(e.ctx, scopeA, main.ID, tangent.ExtractInput{
		FromMessageID: m[2].ID, ToMessageID: m[5].ID, Purpose: "two rounds", Kind: domain.BranchKindAlternative, Card: &card,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Branch.Status != domain.BranchStatusMerged || out.Branch.ConclusionLine != "Because of a2" || out.Branch.CardMessageID != out.Marker.ID ||
		out.Branch.Kind != domain.BranchKindAlternative || out.Branch.ClosedAt == nil || out.Leaf == nil || out.Leaf.Kind != domain.LeafKindConclusion {
		t.Fatalf("merged at once = %+v leaf %+v", out.Branch, out.Leaf)
	}
	marker := out.Marker
	if marker.Kind != domain.MessageKindBranchCard || !marker.Meta.Delivered || marker.Meta.Card == nil || marker.Seq != m[5].Seq ||
		marker.Content != domain.RenderBranchCardMarkdown(*marker.Meta.Card, "two rounds") {
		t.Fatalf("card = %+v", marker)
	}
	if got := contents(e.transcript(main.ID)); !slices.Equal(got, []string{"q1", "a1", domain.MessageKindBranchCard, "q4", "a4"}) {
		t.Fatalf("source = %q", got)
	}
	e.wantTypes(tangent.EventLineCreated, tangent.EventMessageCreated, tangent.EventLineUpdated, tangent.EventBranchChanged, tangent.EventLeafChanged)
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next")
	if err != nil {
		t.Fatal(err)
	}
	for _, section := range append(preview.Prompt.Sections, preview.Prompt.Trailing...) {
		if section.Key == domain.SectionBranchCards {
			t.Fatalf("a delivered card is not noticed again: %q", section.Body)
		}
	}
	history := preview.Prompt.History
	if len(history) != 5 || !strings.Contains(history[2].Content, "Because of a2") || history[3].Content != "q4" {
		t.Fatalf("the card stands in the range's place: %+v", history)
	}
	next := e.turn(main.ID, "q5", "a5")
	if len(next.Message.Meta.DeliversCards) != 0 {
		t.Fatalf("the next turn carried no card: %v", next.Message.Meta.DeliversCards)
	}
	// A card citing a message outside the range is refused like a merge's.
	main2, m2 := e.fourExchanges()
	bad := domain.BranchCard{Question: "q", Conclusion: "c", Evidence: []domain.BranchCardEvidence{{MessageID: m2[0].ID, Note: "x"}}}
	_, err = e.engine.ExtractToBranch(e.ctx, scopeA, main2.ID, tangent.ExtractInput{FromMessageID: m2[2].ID, ToMessageID: m2[3].ID, Purpose: "p", Card: &bad})
	wantCode(t, err, domain.CodeInvalidCard)
}

func TestExtract_TakesBranchesFoldsAndChaptersAlong(t *testing.T) {
	e := newEnvWith(t, b18Features())
	main, m := e.fourExchanges()
	child := e.branch(main.ID, m[3].ID, "on a2")
	grandchild := e.branch(child.Line.ID, e.turn(child.Line.ID, "q", "a").Message.ID, "below")
	inside, err := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[2].ID, ToMessageID: m[3].ID, Summary: "inside"})
	if err != nil {
		t.Fatal(err)
	}
	across, err := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[4].ID, ToMessageID: m[7].ID, Summary: "after"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.AddMilestone(e.ctx, scopeA, main.ID, tangent.MilestoneInput{MessageID: m[2].ID, Title: "Second"}); err != nil {
		t.Fatal(err)
	}
	e.exec(`UPDATE tangent_line SET summary = '{"topic":"t"}', summary_upto_seq = $2 WHERE id = $1`, main.ID, m[3].Seq)
	out, err := e.engine.ExtractToBranch(e.ctx, scopeA, main.ID, tangent.ExtractInput{FromMessageID: m[2].ID, ToMessageID: m[5].ID, Purpose: "two rounds"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(out.Reparented, []string{child.Line.ID}) || !out.SummaryReset || out.MovedCuts != 1 {
		t.Fatalf("extracted = %+v", out)
	}
	moved, err := e.engine.GetBranch(e.ctx, scopeA, child.Line.ID)
	if err != nil || moved.Branch.ParentLineID != out.Line.ID || moved.Branch.Depth != 2 {
		t.Fatalf("the child hangs on the new branch, one deeper: %+v %v", moved.Branch, err)
	}
	if below, err := e.engine.GetBranch(e.ctx, scopeA, grandchild.Line.ID); err != nil || below.Branch.Depth != 3 {
		t.Fatalf("its subtree goes one deeper too: %+v %v", below.Branch, err)
	}
	folds := map[string]domain.Fold{}
	for _, fold := range out.Folds {
		folds[fold.ID] = fold
	}
	if f := folds[inside.Fold.ID]; f.LineID != out.Line.ID || f.Status != domain.FoldActive {
		t.Fatalf("the fold inside moved along: %+v", f)
	}
	if f := folds[across.Fold.ID]; f.Status != domain.FoldRemoved {
		t.Fatalf("the fold across the end is removed: %+v", f)
	}
	if preview, _ := e.engine.PreviewTurn(e.ctx, scopeA, out.Line.ID, "x"); len(preview.Folds) != 1 {
		t.Fatalf("the moved fold applies on the branch: %+v", preview.Folds)
	}
	if line, _ := e.engine.GetLine(e.ctx, scopeA, main.ID); line.SummaryUptoSeq != 0 {
		t.Fatalf("the summary was reset: %d", line.SummaryUptoSeq)
	}
	chapters, err := e.engine.ListChapters(e.ctx, scopeA, main.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(chapters.Milestones) != 1 || chapters.Milestones[0].MessageID != out.Marker.ID {
		t.Fatalf("the milestone moved onto the marker: %+v", chapters.Milestones)
	}
	found := false
	for _, chapter := range chapters.Chapters {
		found = found || (chapter.StartMessageID == out.Marker.ID && chapter.Title == "Second")
	}
	if !found {
		t.Fatalf("the chapter starts at the marker: %+v", chapters.Chapters)
	}
}

func TestExtract_AMovedFoldEndingTheRangeCarriesItsNewSeq(t *testing.T) {
	e := newEnvWith(t, b18Features())
	main, m := e.fourExchanges()
	ending, err := e.engine.CreateFold(e.ctx, scopeA, main.ID, tangent.FoldInput{FromMessageID: m[4].ID, ToMessageID: m[5].ID, Summary: "ends the range"})
	if err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	out, err := e.engine.ExtractToBranch(e.ctx, scopeA, main.ID, tangent.ExtractInput{FromMessageID: m[2].ID, ToMessageID: m[5].ID, Purpose: "two rounds"})
	if err != nil {
		t.Fatal(err)
	}
	moved := e.transcript(out.Line.ID)
	last := moved[len(moved)-1]
	if last.ID != m[5].ID || last.Seq == m[5].Seq {
		t.Fatalf("the range's last message took a new seq: %+v", last)
	}
	stored, err := e.engine.ListFolds(e.ctx, scopeA, out.Line.ID)
	if err != nil || len(stored.Folds) != 1 || stored.Folds[0].ID != ending.Fold.ID || stored.Folds[0].ToSeq != last.Seq {
		t.Fatalf("stored folds = %+v %v", stored.Folds, err)
	}
	events := e.events.OfType(tangent.EventFoldChanged)
	if len(out.Folds) != 1 || out.Folds[0].ToSeq != last.Seq || len(events) != 1 {
		t.Fatalf("result folds %+v, %d fold events", out.Folds, len(events))
	}
	if change := events[0].Data.(tangent.FoldChange); change.Fold.ToSeq != last.Seq || change.Fold.LineID != out.Line.ID {
		t.Fatalf("fold.changed = %+v", change.Fold)
	}
}

func TestExtract_AnchorsOnACardAndWorksOnABranch(t *testing.T) {
	e := newEnvWith(t, b18Features())
	main, branch := e.branchWithTurn("side")
	merged := e.mergeWithCard(branch.Line.ID, domain.BranchCard{Question: "q", Conclusion: "c"})
	user, reply := e.exchange(main.ID, "after the card", "fine")
	out, err := e.engine.ExtractToBranch(e.ctx, scopeA, main.ID, tangent.ExtractInput{FromMessageID: user.ID, ToMessageID: reply.ID, Purpose: "follow-up"})
	if err != nil || out.Branch.AnchorMessageID != merged.Card.ID {
		t.Fatalf("the card anchors the branch: %+v %v", out.Branch, err)
	}
	sub, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{AnchorMessageID: merged.Card.ID, Purpose: "deeper", Kind: domain.BranchKindInvestigate})
	if err != nil {
		t.Fatal(err)
	}
	u1, r1 := e.exchange(sub.Line.ID, "one", "1")
	e.exchange(sub.Line.ID, "two", "2")
	nested, err := e.engine.ExtractToBranch(e.ctx, scopeA, sub.Line.ID, tangent.ExtractInput{FromMessageID: u1.ID, ToMessageID: r1.ID, Purpose: "p"})
	if err == nil {
		t.Fatalf("the first message of a branch has nothing before it: %+v", nested)
	}
	wantCode(t, err, domain.CodeMoveNoAnchor)
	u2, r2 := e.exchange(sub.Line.ID, "three", "3")
	e.exchange(sub.Line.ID, "four", "4")
	nested, err = e.engine.ExtractToBranch(e.ctx, scopeA, sub.Line.ID, tangent.ExtractInput{FromMessageID: u2.ID, ToMessageID: r2.ID, Purpose: "p"})
	if err != nil || nested.Branch.Depth != 2 || nested.Branch.ParentLineID != sub.Line.ID {
		t.Fatalf("on a branch = %+v %v", nested.Branch, err)
	}
}

func TestExtract_Refusals(t *testing.T) {
	e := newEnvWith(t, b18Features())
	main, m := e.fourExchanges()
	refuse := func(name, code string, scope tangent.Scope, lineID string, in tangent.ExtractInput) {
		t.Helper()
		if in.Purpose == "" {
			in.Purpose = "p"
		}
		_, err := e.engine.ExtractToBranch(e.ctx, scope, lineID, in)
		if got := domain.CodeOf(err); got != code {
			t.Fatalf("%s: code = %q (%v), want %q", name, got, err, code)
		}
	}
	refuse("wrong order", domain.CodeInvalidInput, scopeA, main.ID, tangent.ExtractInput{FromMessageID: m[3].ID, ToMessageID: m[2].ID})
	refuse("not on the line", domain.CodeMessageNotFound, scopeA, main.ID, tangent.ExtractInput{FromMessageID: "nope", ToMessageID: m[3].ID})
	refuse("first message", domain.CodeMoveNoAnchor, scopeA, main.ID, tangent.ExtractInput{FromMessageID: m[0].ID, ToMessageID: m[1].ID})
	refuse("starts with a reply", domain.CodeMoveMustStartWithUser, scopeA, main.ID, tangent.ExtractInput{FromMessageID: m[3].ID, ToMessageID: m[4].ID})
	refuse("aside", domain.CodeKindUnsupported, scopeA, main.ID, tangent.ExtractInput{FromMessageID: m[2].ID, ToMessageID: m[3].ID, Kind: domain.BranchKindAside})
	refuse("no purpose", domain.CodeInvalidInput, scopeA, main.ID, tangent.ExtractInput{FromMessageID: m[2].ID, ToMessageID: m[3].ID, Purpose: " "})
	refuse("other tenant", domain.CodeLineNotFound, scopeB, main.ID, tangent.ExtractInput{FromMessageID: m[2].ID, ToMessageID: m[3].ID})
	// A marker in the range is protected.
	if _, err := e.engine.ExtractToBranch(e.ctx, scopeA, main.ID, tangent.ExtractInput{FromMessageID: m[4].ID, ToMessageID: m[5].ID, Purpose: "third"}); err != nil {
		t.Fatal(err)
	}
	refuse("marker inside", domain.CodeMoveProtected, scopeA, main.ID, tangent.ExtractInput{FromMessageID: m[2].ID, ToMessageID: m[7].ID})
	// A branch opened in the range and already brought back would leave its
	// card behind after the range.
	merged := e.branch(main.ID, m[7].ID, "brought back")
	e.turn(merged.Line.ID, "q", "a")
	e.mergeWithCard(merged.Line.ID, domain.BranchCard{Question: "q", Conclusion: "c"})
	refuse("card of a branch in the range", domain.CodeMoveProtected, scopeA, main.ID, tangent.ExtractInput{FromMessageID: m[6].ID, ToMessageID: m[7].ID})
	// A failed reply is not a finished message.
	user, failed := e.failedTurn(main.ID)
	refuse("failed reply", domain.CodeMoveProtected, scopeA, main.ID, tangent.ExtractInput{FromMessageID: user.ID, ToMessageID: failed.ID})
	// A pending turn keeps the line busy.
	if _, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "pending"}); err != nil {
		t.Fatal(err)
	}
	refuse("busy", domain.CodeSourceBusy, scopeA, main.ID, tangent.ExtractInput{FromMessageID: m[6].ID, ToMessageID: m[7].ID})

	other, o := e.fourExchanges()
	limits := domain.DefaultLimits().Branch.MoveMaxMessages
	for i := 0; i < limits/2; i++ {
		e.exchange(other.ID, "more", "more")
	}
	all := e.transcript(other.ID)
	refuse("too many", domain.CodeInvalidCount, scopeA, other.ID, tangent.ExtractInput{FromMessageID: o[2].ID, ToMessageID: all[len(all)-1].ID})
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, other.ID, true); err != nil {
		t.Fatal(err)
	}
	refuse("archived", domain.CodeArchived, scopeA, other.ID, tangent.ExtractInput{FromMessageID: o[2].ID, ToMessageID: o[3].ID})

	// A branch that ended takes no extract.
	third, t3 := e.fourExchanges()
	ended := e.branch(third.ID, t3[1].ID, "ended")
	e.exchange(ended.Line.ID, "x", "y")
	eu, er := e.exchange(ended.Line.ID, "z", "w")
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, ended.Line.ID); err != nil {
		t.Fatal(err)
	}
	refuse("ended", domain.CodeParentClosed, scopeA, ended.Line.ID, tangent.ExtractInput{FromMessageID: eu.ID, ToMessageID: er.ID})
}

// failedTurn runs a turn whose runner fails and returns its messages.
func (e *env) failedTurn(lineID string) (domain.Message, domain.Message) {
	e.t.Helper()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, lineID, tangent.TurnInput{Content: "fails"})
	if err != nil {
		e.t.Fatal(err)
	}
	done, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Error: "boom"})
	if err != nil {
		e.t.Fatal(err)
	}
	return turn.UserMessage, done.Message
}

func TestDecompose_ProposesFromTheConversationAndItsRelatedLines(t *testing.T) {
	e := newEnvWith(t, b18Features())
	in := tangent.ImportInput{
		Title: "PostgreSQL MVCC", Tags: []string{"postgres"},
		Messages: []domain.ImportMessage{
			{Role: "user", Content: "Explain PostgreSQL MVCC snapshots"},
			{Role: "assistant", Content: "PostgreSQL MVCC keeps row versions with xmin and xmax."},
			{Role: "user", Content: "My Docker container shows connection refused error"},
			{Role: "assistant", Content: "Use host.docker.internal instead. It reaches the host."},
			{Role: "user", Content: "Back to MVCC: when does PostgreSQL vacuum run?"},
			{Role: "assistant", Content: "Autovacuum runs past a threshold.\n- Should we tune autovacuum_vacuum_scale_factor?\nDo you want an example?"},
			{Role: "user", Content: "By the way, how do I reindex?"},
			{Role: "assistant", Content: "REINDEX CONCURRENTLY."},
		},
	}
	out, err := e.engine.ImportLine(e.ctx, scopeA, in)
	if err != nil {
		t.Fatal(err)
	}
	related, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Title: "tuning", Tags: []string{"postgres", "x"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.CreateLine(e.ctx, scopeB, tangent.LineInput{Title: "elsewhere", Tags: []string{"postgres"}}); err != nil {
		t.Fatal(err)
	}
	messages := e.transcript(out.Line.ID)
	plan, err := e.engine.Decompose(e.ctx, scopeA, out.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.RelatedLines) != 1 || plan.RelatedLines[0].LineID != related.ID || !slices.Equal(plan.RelatedLines[0].SharedTags, []string{"postgres"}) {
		t.Fatalf("related (this tenant only) = %+v", plan.RelatedLines)
	}
	if len(plan.DetourRanges) != 1 || plan.DetourRanges[0].FromMessageID != messages[2].ID || plan.DetourRanges[0].ToMessageID != messages[3].ID ||
		plan.DetourRanges[0].AnchorMessageID != messages[1].ID || plan.DetourRanges[0].SuggestedConclusion != "Use host.docker.internal instead." {
		t.Fatalf("detours = %+v", plan.DetourRanges)
	}
	if len(plan.ChapterCuts) != 1 || plan.ChapterCuts[0].MessageID != messages[6].ID || plan.ChapterCuts[0].Reason != domain.DecomposeReasonTopicShift {
		t.Fatalf("cuts = %+v", plan.ChapterCuts)
	}
	if len(plan.SeedCandidates) != 2 || slices.Contains(plan.SuggestedTags, "postgres") || !slices.Contains(plan.SuggestedTags, "mvcc") {
		t.Fatalf("seeds %+v tags %v", plan.SeedCandidates, plan.SuggestedTags)
	}
	// The detour it proposes can be extracted as it is.
	detour := plan.DetourRanges[0]
	if _, err := e.engine.ExtractToBranch(e.ctx, scopeA, out.Line.ID, tangent.ExtractInput{
		FromMessageID: detour.FromMessageID, ToMessageID: detour.ToMessageID, Purpose: detour.Purpose,
		Card: &domain.BranchCard{Question: "Docker?", Conclusion: detour.SuggestedConclusion},
	}); err != nil {
		t.Fatal(err)
	}
	_, err = e.engine.Decompose(e.ctx, scopeB, out.Line.ID)
	wantCode(t, err, domain.CodeLineNotFound)
}
