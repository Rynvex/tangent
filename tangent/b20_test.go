package tangent_test

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// B20: attaching another conversation as a branch, the inverse of a detach.

// treeTables are the tables whose rows name their conversation by
// root_line_id (the branch rows aside).
var treeTables = []string{"tangent_note", "tangent_memo", "tangent_seed", "tangent_leaf", "tangent_chapter_cut", "tangent_suggestion", "tangent_group", "tangent_goal"}

// sourceTree is a conversation to attach: two exchanges, a branch on its
// first reply with a branch of its own, and a row in every tree table.
type sourceTree struct {
	line     domain.LineView
	messages []domain.Message
	child    tangent.CreatedBranch
	grand    tangent.CreatedBranch
}

func (e *env) sourceTree(title string) sourceTree {
	e.t.Helper()
	line, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Title: title, Provider: "anthropic", Model: "sonnet", Folder: "Research", Tags: []string{"postgres"}})
	if err != nil {
		e.t.Fatal(err)
	}
	u1, r1 := e.exchange(line.ID, "source q1", "source a1")
	u2, r2 := e.exchange(line.ID, "source q2", "source a2")
	out := sourceTree{line: line, messages: []domain.Message{u1, r1, u2, r2}}
	out.child = e.branch(line.ID, r1.ID, "child")
	_, cr := e.exchange(out.child.Line.ID, "child q", "child a")
	out.grand = e.branch(out.child.Line.ID, cr.ID, "grandchild")
	if _, err := e.engine.ApplyNoteChanges(e.ctx, scopeA, line.ID, []domain.NoteChange{{Op: "add", Section: "decided", Text: "use MVCC", SourceLineID: line.ID, SourceMessageID: r2.ID}}); err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.engine.AddMilestone(e.ctx, scopeA, line.ID, tangent.MilestoneInput{MessageID: u2.ID, Title: "second part"}); err != nil {
		e.t.Fatal(err)
	}
	e.exec(`INSERT INTO tangent_memo (tenant_id, root_line_id, line_id, source_label, text) VALUES ($1, $2, $2, 'main', 'a memo'), ($1, $2, NULL, 'gone', 'orphan memo')`, scopeA.Tenant, line.ID)
	e.exec(`INSERT INTO tangent_seed (tenant_id, root_line_id, anchor_message_id, text) VALUES ($1, $2, $3, 'later')`, scopeA.Tenant, line.ID, r2.ID)
	e.exec(`INSERT INTO tangent_goal (root_line_id, tenant_id, text, source) VALUES ($1, $2, 'source goal', 'manual')`, line.ID, scopeA.Tenant)
	e.exec(`INSERT INTO tangent_leaf (line_id, tenant_id, root_line_id, kind, line, body, status) VALUES ($1, $2, $3, 'conclusion', 'leaf', '', 'confirmed')`, out.child.Line.ID, scopeA.Tenant, line.ID)
	e.exec(`WITH g AS (INSERT INTO tangent_group (tenant_id, root_line_id, title) VALUES ($1, $2, 'grouped') RETURNING id)
		INSERT INTO tangent_group_member (group_id, line_id) SELECT id, $3::uuid FROM g UNION ALL SELECT id, $4::uuid FROM g`, scopeA.Tenant, line.ID, out.child.Line.ID, out.grand.Line.ID)
	e.exec(`INSERT INTO tangent_suggestion (tenant_id, root_line_id, line_id, feature, kind, target_key) VALUES ($1, $2, $2, 'goal', 'goal', 'root'), ($1, $2, $2, 'relations', 'relation', 'x')`, scopeA.Tenant, line.ID)
	return out
}

// rowsUnder counts the tree tables' rows still naming root.
func (e *env) rowsUnder(root string) map[string]int {
	e.t.Helper()
	out := map[string]int{}
	for _, table := range treeTables {
		if n := e.count("SELECT count(*)::int FROM "+table+" WHERE root_line_id = $1", root); n > 0 {
			out[table] = n
		}
	}
	return out
}

func TestAttach_HangsAWholeConversationUnderTheLine(t *testing.T) {
	e := newEnvWith(t, b18Features())
	target, m := e.fourExchanges()
	e.exec(`INSERT INTO tangent_goal (root_line_id, tenant_id, text, source) VALUES ($1, $2, 'target goal', 'manual')`, target.ID, scopeA.Tenant)
	e.exec(`INSERT INTO tangent_suggestion (tenant_id, root_line_id, line_id, feature, kind, target_key) VALUES ($1, $2, $2, 'goal', 'goal', 'root')`, scopeA.Tenant, target.ID)
	source := e.sourceTree("PG pool settings")
	before := e.transcript(source.line.ID)
	// The source started between the target's second and third exchange:
	// the anchor picked is the newest anchorable message not after it.
	t0 := time.Now().Add(-time.Hour)
	for i, message := range m {
		e.exec(`UPDATE tangent_message SET created_at = $2 WHERE id = $1`, message.ID, t0.Add(time.Duration(i)*time.Minute))
	}
	e.exec(`UPDATE tangent_line SET created_at = $2 WHERE id = $1`, source.line.ID, t0.Add(3*time.Minute+30*time.Second))
	e.exec(`UPDATE tangent_line SET notes_revision_sent = 9 WHERE id = ANY($1::uuid[])`, []string{source.line.ID, source.child.Line.ID})
	e.events.Reset()
	out, err := e.engine.AttachLine(e.ctx, scopeA, target.ID, tangent.AttachInput{SourceLineID: source.line.ID})
	if err != nil {
		t.Fatal(err)
	}
	b := out.Branch
	if b.LineID != source.line.ID || b.ParentLineID != target.ID || b.RootLineID != target.ID || b.AnchorMessageID != m[3].ID || b.Depth != 1 ||
		b.Status != domain.BranchStatusOpen || b.Origin != domain.BranchOriginMove || b.Purpose != "PG pool settings" || b.Kind != domain.BranchKindInvestigate {
		t.Fatalf("branch = %+v", b)
	}
	if out.CardMessage != nil || !slices.Equal(out.Reparented, []string{source.child.Line.ID, source.grand.Line.ID}) && !slices.Equal(out.Reparented, []string{source.grand.Line.ID, source.child.Line.ID}) {
		t.Fatalf("card %v reparented %v", out.CardMessage, out.Reparented)
	}
	line := out.BranchLine
	if line.ConversationBranch == nil || line.Folder != "" || len(line.Tags) != 0 || line.Title != "PG pool settings" {
		t.Fatalf("source as a branch line = %+v", line)
	}
	if after := e.transcript(source.line.ID); !slices.EqualFunc(before, after, func(a, b domain.Message) bool { return a.ID == b.ID && a.Seq == b.Seq }) {
		t.Fatalf("the source's messages changed: %v -> %v", before, after)
	}
	tree, err := e.engine.ListBranches(e.ctx, scopeA, target.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	depths := map[string]int{}
	for _, view := range tree {
		depths[view.LineID] = view.Depth
	}
	if depths[source.line.ID] != 1 || depths[source.child.Line.ID] != 2 || depths[source.grand.Line.ID] != 3 {
		t.Fatalf("depths = %v", depths)
	}
	if left := e.rowsUnder(source.line.ID); len(left) != 0 {
		t.Fatalf("rows left under the old main line: %v", left)
	}
	if n := e.count(`SELECT count(*)::int FROM tangent_branch WHERE root_line_id = $1`, source.line.ID); n != 0 {
		t.Fatalf("%d branch rows left under the old main line", n)
	}
	if n := e.count(`SELECT count(*)::int FROM tangent_goal WHERE root_line_id = $1 AND text = 'target goal'`, target.ID); n != 1 || !out.DroppedGoal {
		t.Fatalf("the target keeps its goal (%d), the source's goes (%v)", n, out.DroppedGoal)
	}
	if out.Moved.Notes != 1 || out.Moved.Memos != 2 || out.Moved.Seeds != 1 || out.Moved.Leaves != 1 || out.Moved.ChapterCuts != 1 || len(out.Groups) != 1 ||
		len(out.ExpiredSuggestions) != 1 || out.NotesRevision == 0 {
		t.Fatalf("moved = %+v groups %d expired %v revision %d", out.Moved, len(out.Groups), out.ExpiredSuggestions, out.NotesRevision)
	}
	// The lines last sent notes against the old main line's revision: their next turn sends the target's.
	if n := e.count(`SELECT count(*)::int FROM tangent_line WHERE id = ANY($1::uuid[]) AND notes_revision_sent <> 0`, []string{source.line.ID, source.child.Line.ID, source.grand.Line.ID}); n != 0 {
		t.Fatalf("%d lines keep the old notes revision sent", n)
	}
	notes, err := e.engine.ListNotes(e.ctx, scopeA, target.ID)
	if err != nil || len(notes.Notes) != 1 || notes.Notes[0].Text != "use MVCC" {
		t.Fatalf("notes = %+v %v", notes.Notes, err)
	}
	page, err := e.engine.ListLines(e.ctx, scopeA, tangent.LineQuery{})
	if err != nil || slices.ContainsFunc(page.Lines, func(l domain.LineView) bool { return l.ID == source.line.ID }) {
		t.Fatalf("the attached line is still listed: %v", err)
	}
	types := e.events.Types()
	for _, want := range []string{tangent.EventLineUpdated, tangent.EventBranchChanged, tangent.EventNotesChanged, tangent.EventSeedsChanged, tangent.EventChaptersChanged, tangent.EventSuggestionChanged} {
		if !slices.Contains(types, want) {
			t.Fatalf("events %v miss %s", types, want)
		}
	}
	// The branch takes turns like any other, its pack ending at the anchor.
	detail, err := e.engine.GetBranch(e.ctx, scopeA, source.line.ID)
	if err != nil || !strings.Contains(detail.Pack.Rendered, "> a2\n") || strings.Contains(detail.Pack.Rendered, "> q3") {
		t.Fatalf("pack = %q %v", detail.Pack.Rendered, err)
	}
	e.turn(source.line.ID, "source q3", "source a3")
}

func TestAttach_MergedLeavesItsCardDelivered(t *testing.T) {
	e := newEnvWith(t, b18Features())
	target, m := e.fourExchanges()
	source := e.sourceTree("")
	card := domain.BranchCard{Conclusion: "Pool size 20", Evidence: []domain.BranchCardEvidence{{MessageID: source.messages[3].ID, Note: "the answer"}}}
	out, err := e.engine.AttachLine(e.ctx, scopeA, target.ID, tangent.AttachInput{
		SourceLineID: source.line.ID, AnchorMessageID: m[1].ID, Status: "merged", Card: &card, Kind: domain.BranchKindAlternative,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Branch.Purpose != "source q1" || out.Branch.AnchorMessageID != m[1].ID || out.Branch.Kind != domain.BranchKindAlternative {
		t.Fatalf("an untitled source is named by its first question: %+v", out.Branch)
	}
	cm := out.CardMessage
	if cm == nil || cm.Kind != domain.MessageKindBranchCard || !cm.Meta.Delivered || cm.Meta.BranchLineID != source.line.ID || cm.Meta.Card.Question != "source q1" ||
		out.Branch.Status != domain.BranchStatusMerged || out.Branch.CardMessageID != cm.ID || out.Branch.ConclusionLine != "Pool size 20" || out.Leaf == nil {
		t.Fatalf("card %+v branch %+v leaf %+v", cm, out.Branch, out.Leaf)
	}
	if got := contents(e.transcript(target.ID)); got[len(got)-1] != domain.MessageKindBranchCard {
		t.Fatalf("the card is the target's newest message: %q", got)
	}
	types := e.events.Types()
	if !slices.Contains(types, tangent.EventMessageCreated) || !slices.Contains(types, tangent.EventLeafChanged) {
		t.Fatalf("events = %v", types)
	}
	next := e.turn(target.ID, "q5", "a5")
	if len(next.Message.Meta.DeliversCards) != 0 {
		t.Fatalf("a delivered card is not noticed again: %v", next.Message.Meta.DeliversCards)
	}
	// A card citing a target message before the anchor is refused.
	other, o := e.fourExchanges()
	source2 := e.sourceTree("second")
	bad := domain.BranchCard{Conclusion: "c", Evidence: []domain.BranchCardEvidence{{MessageID: o[0].ID, Note: "x"}}}
	_, err = e.engine.AttachLine(e.ctx, scopeA, other.ID, tangent.AttachInput{SourceLineID: source2.line.ID, Status: "merged", Card: &bad})
	wantCode(t, err, domain.CodeInvalidCard)
}

func TestAttach_Refusals(t *testing.T) {
	e := newEnvWith(t, b18Features())
	target, m := e.fourExchanges()
	source := e.sourceTree("source")
	refuse := func(name, code string, scope tangent.Scope, lineID string, in tangent.AttachInput) {
		t.Helper()
		_, err := e.engine.AttachLine(e.ctx, scope, lineID, in)
		if got := domain.CodeOf(err); got != code {
			t.Fatalf("%s: code = %q (%v), want %q", name, got, err, code)
		}
	}
	card := &domain.BranchCard{Conclusion: "c"}
	src := source.line.ID
	refuse("no source", domain.CodeInvalidInput, scopeA, target.ID, tangent.AttachInput{})
	refuse("itself", domain.CodeInvalidInput, scopeA, target.ID, tangent.AttachInput{SourceLineID: target.ID})
	refuse("a branch", domain.CodeInvalidInput, scopeA, target.ID, tangent.AttachInput{SourceLineID: source.child.Line.ID})
	refuse("into its own tree", domain.CodeInvalidInput, scopeA, source.child.Line.ID, tangent.AttachInput{SourceLineID: src})
	refuse("unknown source", domain.CodeLineNotFound, scopeA, target.ID, tangent.AttachInput{SourceLineID: "8d6bb0f6-5f43-4c52-9f39-3c0ee2d7f7b1"})
	refuse("other tenant", domain.CodeLineNotFound, scopeB, target.ID, tangent.AttachInput{SourceLineID: src})
	refuse("card on an open attach", domain.CodeInvalidInput, scopeA, target.ID, tangent.AttachInput{SourceLineID: src, Card: card})
	refuse("merged without a card", domain.CodeInvalidInput, scopeA, target.ID, tangent.AttachInput{SourceLineID: src, Status: "merged"})
	refuse("bad status", domain.CodeInvalidInput, scopeA, target.ID, tangent.AttachInput{SourceLineID: src, Status: "discarded"})
	refuse("empty conclusion", domain.CodeInvalidCard, scopeA, target.ID, tangent.AttachInput{SourceLineID: src, Status: "merged", Card: &domain.BranchCard{}})
	refuse("aside", domain.CodeKindUnsupported, scopeA, target.ID, tangent.AttachInput{SourceLineID: src, Kind: domain.BranchKindAside})
	refuse("anchor not on the line", domain.CodeAnchorNotFound, scopeA, target.ID, tangent.AttachInput{SourceLineID: src, AnchorMessageID: source.messages[0].ID})
	refuse("too long a purpose", domain.CodeInvalidInput, scopeA, target.ID, tangent.AttachInput{SourceLineID: src, Purpose: strings.Repeat("x", 201)})
	empty := e.mainLine()
	refuse("empty source", domain.CodeInvalidInput, scopeA, target.ID, tangent.AttachInput{SourceLineID: empty.ID})
	refuse("nothing to hang on", domain.CodeMoveNoAnchor, scopeA, empty.ID, tangent.AttachInput{SourceLineID: src})
	// Busy: a turn waiting on the target, or on a line of the source tree.
	if _, err := e.engine.BeginTurn(e.ctx, scopeA, target.ID, tangent.TurnInput{Content: "pending"}); err != nil {
		t.Fatal(err)
	}
	refuse("target answering", domain.CodeSourceBusy, scopeA, target.ID, tangent.AttachInput{SourceLineID: src})
	if _, err := e.engine.CancelTurn(e.ctx, scopeA, target.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.BeginTurn(e.ctx, scopeA, source.grand.Line.ID, tangent.TurnInput{Content: "pending"}); err != nil {
		t.Fatal(err)
	}
	refuse("source tree answering", domain.CodeBranchBusy, scopeA, target.ID, tangent.AttachInput{SourceLineID: src})
	// An ended target branch takes no branch.
	ended := e.branch(target.ID, m[1].ID, "ended")
	e.exchange(ended.Line.ID, "x", "y")
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, ended.Line.ID); err != nil {
		t.Fatal(err)
	}
	other := e.sourceTree("other")
	refuse("ended target", domain.CodeParentClosed, scopeA, ended.Line.ID, tangent.AttachInput{SourceLineID: other.line.ID})
	// The source's depth counts: under a depth-3 branch its grandchild
	// would be at 6 (soft limit 3 needs confirmDeeper), under depth 4 at 7.
	d1 := e.branch(target.ID, m[3].ID, "d1")
	_, r1 := e.exchange(d1.Line.ID, "x", "y")
	d2 := e.branch(d1.Line.ID, r1.ID, "d2")
	_, r2 := e.exchange(d2.Line.ID, "x", "y")
	d3 := e.branch(d2.Line.ID, r2.ID, "d3")
	_, r3 := e.exchange(d3.Line.ID, "x", "y")
	refuse("soft depth", domain.CodeDepthSoftLimit, scopeA, d1.Line.ID, tangent.AttachInput{SourceLineID: other.line.ID})
	d4, err := e.engine.CreateBranch(e.ctx, scopeA, d3.Line.ID, tangent.BranchInput{AnchorMessageID: r3.ID, Purpose: "d4", Kind: domain.BranchKindInvestigate, ConfirmDeeper: true})
	if err != nil {
		t.Fatal(err)
	}
	_, r4 := e.exchange(d4.Line.ID, "x", "y")
	refuse("hard depth", domain.CodeDepthHardLimit, scopeA, d4.Line.ID, tangent.AttachInput{SourceLineID: other.line.ID, AnchorMessageID: r4.ID, ConfirmDeeper: true})
	if _, err := e.engine.AttachLine(e.ctx, scopeA, d1.Line.ID, tangent.AttachInput{SourceLineID: other.line.ID, ConfirmDeeper: true}); err != nil {
		t.Fatalf("confirmed deeper: %v", err)
	}
	// Archived either side.
	third := e.sourceTree("third")
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, third.line.ID, true); err != nil {
		t.Fatal(err)
	}
	refuse("archived source", domain.CodeArchived, scopeA, target.ID, tangent.AttachInput{SourceLineID: third.line.ID})
	// A rolled-back attach leaves both conversations as they were.
	fourth := e.sourceTree("fourth")
	kept := e.rowsUnder(fourth.line.ID)
	e.rollsBack("attach", func(opt tangent.TxOption) error {
		_, err := e.engine.AttachLine(e.ctx, scopeA, target.ID, tangent.AttachInput{SourceLineID: fourth.line.ID}, opt)
		return err
	})
	if left := e.rowsUnder(fourth.line.ID); len(left) != len(treeTables) || len(left) != len(kept) {
		t.Fatalf("a rolled-back attach moved rows: %v, had %v", left, kept)
	}
}

func TestAttach_LimitsCountTheSourceTree(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Branch.MaxPerTree = 2
	limits.Branch.MaxOpenPerParent = 1
	e := newEnvWith(t, b18Features(), tangent.WithLimits(limits))
	target, m := e.fourExchanges()
	source := e.sourceTree("source")
	_, err := e.engine.AttachLine(e.ctx, scopeA, target.ID, tangent.AttachInput{SourceLineID: source.line.ID})
	if !errors.Is(err, domain.ErrBranchTreeLimit) {
		t.Fatalf("the source and its two branches exceed 2: err = %v", err)
	}
	small := e.mainLine()
	e.exchange(small.ID, "q", "a")
	e.branch(target.ID, m[1].ID, "open one")
	_, err = e.engine.AttachLine(e.ctx, scopeA, target.ID, tangent.AttachInput{SourceLineID: small.ID})
	wantCode(t, err, domain.CodeBranchLimit)
	// A merged attach is not an open branch of the parent.
	if _, err := e.engine.AttachLine(e.ctx, scopeA, target.ID, tangent.AttachInput{SourceLineID: small.ID, Status: "merged", Card: &domain.BranchCard{Conclusion: "done"}}); err != nil {
		t.Fatal(err)
	}
}
