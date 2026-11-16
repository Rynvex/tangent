package tangent_test

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// memoFeatures is every first-batch feature plus memos (and spinoff, for detach).
func memoFeatures() []tangent.Feature {
	return append(tangent.AllFeatures(), tangent.Memo(), tangent.Spinoff())
}

func TestB13_MemosAreWrittenOnANodeListedAndEdited(t *testing.T) {
	e := newEnvWith(t, memoFeatures())
	main := e.mainLine()
	turn := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, turn.Message.ID, "Compare the plans")
	e.events.Reset()

	onBranch, err := e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{NodeLineID: branch.Line.ID, Text: "  line one\r\nline two  "})
	if err != nil {
		t.Fatal(err)
	}
	if onBranch.Text != "line one\nline two" || onBranch.LineID != branch.Line.ID || onBranch.RootLineID != main.ID || onBranch.CreatedBy != "chang" {
		t.Fatalf("memo = %+v", onBranch)
	}
	if !strings.Contains(onBranch.SourceLabel, "Compare the plans") {
		t.Fatalf("the label names the node: %q", onBranch.SourceLabel)
	}
	e.wantTypes(tangent.EventMemoChanged)
	if change := e.events.Events()[0].Data.(tangent.MemoChange); change.Change != tangent.MemoCreated || change.MemoID != onBranch.ID || change.RootLineID != main.ID {
		t.Fatalf("event = %+v", change)
	}
	// From a branch's path, without a node: the memo sits on that branch.
	onPath, err := e.engine.CreateMemo(e.ctx, scopeA, branch.Line.ID, tangent.MemoInput{Text: "second"})
	if err != nil || onPath.LineID != branch.Line.ID || onPath.RootLineID != main.ID {
		t.Fatalf("on the path's line: %+v %v", onPath, err)
	}
	onMain, err := e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{Text: "on the main line"})
	if err != nil || onMain.LineID != main.ID {
		t.Fatalf("on the main line: %+v %v", onMain, err)
	}

	all, err := e.engine.ListMemos(e.ctx, scopeA, branch.Line.ID, "")
	if err != nil || all.RootLineID != main.ID || len(all.Memos) != 3 || all.Memos[0].ID != onBranch.ID {
		t.Fatalf("the tree's memos, oldest first: %+v %v", all, err)
	}
	node, err := e.engine.ListMemos(e.ctx, scopeA, main.ID, branch.Line.ID)
	if err != nil || len(node.Memos) != 2 {
		t.Fatalf("one node's: %+v %v", node, err)
	}

	edited, err := e.engine.UpdateMemo(e.ctx, scopeA, onBranch.ID, "edited")
	if err != nil || edited.Text != "edited" || edited.SourceLabel != onBranch.SourceLabel || !edited.UpdatedAt.After(onBranch.UpdatedAt) {
		t.Fatalf("edited: %+v %v", edited, err)
	}
	_, err = e.engine.UpdateMemo(e.ctx, scopeA, onBranch.ID, " ")
	wantCode(t, err, domain.CodeInvalidInput)
	_, err = e.engine.UpdateMemo(e.ctx, scopeA, onBranch.ID, strings.Repeat("字", e.engine.Limits().Memo.TextMaxRunes+1))
	wantCode(t, err, domain.CodeTooLong)

	deleted, err := e.engine.DeleteMemo(e.ctx, scopeA, onBranch.ID)
	if err != nil || deleted.ID != onBranch.ID || deleted.Text != "edited" {
		t.Fatalf("deleted: %+v %v", deleted, err)
	}
	_, err = e.engine.DeleteMemo(e.ctx, scopeA, onBranch.ID)
	wantCode(t, err, domain.CodeMemoNotFound)
	_, err = e.engine.UpdateMemo(e.ctx, scopeA, "not-a-uuid", "x")
	wantCode(t, err, domain.CodeMemoNotFound)
}

// A renamed node keeps the label its memos were written under (a snapshot).
func TestB13_RenamingANodeLeavesItsMemoLabels(t *testing.T) {
	e := newEnvWith(t, memoFeatures())
	main := e.mainLine()
	turn := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, turn.Message.ID, "Old name")
	memo, err := e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{NodeLineID: branch.Line.ID, Text: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.RenameBranch(e.ctx, scopeA, branch.Line.ID, "New name"); err != nil {
		t.Fatal(err)
	}
	list, _ := e.engine.ListMemos(e.ctx, scopeA, main.ID, "")
	if list.Memos[0].SourceLabel != memo.SourceLabel || strings.Contains(list.Memos[0].SourceLabel, "New name") {
		t.Fatalf("label = %q", list.Memos[0].SourceLabel)
	}
}

// DESIGN §12.10 (B13): a memo is in no prompt and no preview, even with
// the notes page on and the memo written on the line that turns.
func TestB13_MemosNeverReachThePrompt(t *testing.T) {
	e := newEnvWith(t, memoFeatures())
	main := e.mainLine()
	e.turn(main.ID, "first question", "first answer")
	const secret = "MEMO-ONLY-ZEBRA-7731"
	if _, err := e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{Text: "remember " + secret}); err != nil {
		t.Fatal(err)
	}
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next question")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(preview)
	if strings.Contains(string(raw), secret) {
		t.Fatal("the turn preview carries a memo")
	}
	e.turn(main.ID, "next question", "next answer")
	for _, req := range e.runner.Requests() {
		text := req.System
		for _, m := range req.Messages {
			text += "\n" + m.Content
		}
		if strings.Contains(text, secret) {
			t.Fatal("a prompt sent to the runner carries a memo")
		}
	}
}

func TestB13_MemoRefusals(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Memo.MaxPerTree = 2
	e := newEnvWith(t, memoFeatures(), tangent.WithLimits(limits))
	main := e.mainLine()
	other := e.mainLine()
	first, err := e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{Text: "1"})
	if err != nil {
		t.Fatal(err)
	}
	// A node of another conversation, a line of another tenant.
	_, err = e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{NodeLineID: other.ID, Text: "x"})
	wantCode(t, err, domain.CodeLineNotFound)
	_, err = e.engine.ListMemos(e.ctx, scopeA, main.ID, other.ID)
	wantCode(t, err, domain.CodeLineNotFound)
	_, err = e.engine.CreateMemo(e.ctx, scopeB, main.ID, tangent.MemoInput{Text: "x"})
	wantCode(t, err, domain.CodeLineNotFound)
	_, err = e.engine.ListMemos(e.ctx, scopeB, main.ID, "")
	wantCode(t, err, domain.CodeLineNotFound)
	_, err = e.engine.UpdateMemo(e.ctx, scopeB, first.ID, "theirs")
	wantCode(t, err, domain.CodeMemoNotFound)
	_, err = e.engine.DeleteMemo(e.ctx, scopeB, first.ID)
	wantCode(t, err, domain.CodeMemoNotFound)
	_, err = e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{Text: ""})
	wantCode(t, err, domain.CodeInvalidInput)

	if _, err := e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{Text: "2"}); err != nil {
		t.Fatal(err)
	}
	_, err = e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{Text: "3"})
	wantCode(t, err, domain.CodeMemoLimit)
	if extra := domain.AsError(err, limits).Extra; extra["limit"] != 2 {
		t.Fatalf("extra = %v", extra)
	}

	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, main.ID, true); err != nil {
		t.Fatal(err)
	}
	_, err = e.engine.UpdateMemo(e.ctx, scopeA, first.ID, "archived")
	wantCode(t, err, domain.CodeArchived)
	_, err = e.engine.DeleteMemo(e.ctx, scopeA, first.ID)
	wantCode(t, err, domain.CodeArchived)
	if list, err := e.engine.ListMemos(e.ctx, scopeA, main.ID, ""); err != nil || len(list.Memos) != 2 {
		t.Fatalf("an archived conversation's memos are still read: %v %v", list, err)
	}
}

func TestB13_ConcurrentWritersStopAtTheCap(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Memo.MaxPerTree = 3
	e := newEnvWith(t, memoFeatures(), tangent.WithLimits(limits))
	main := e.mainLine()
	var wg sync.WaitGroup
	for i := range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{Text: strings.Repeat("x", i+1)})
		}()
	}
	wg.Wait()
	if n := e.count(`SELECT count(*) FROM tangent_memo WHERE root_line_id = $1`, main.ID); n != 3 {
		t.Fatalf("memos = %d, want the cap", n)
	}
}

func TestB13_MemosGoWithTheirConversationAndFollowADetachedNode(t *testing.T) {
	e := newEnvWith(t, memoFeatures())
	main := e.mainLine()
	turn := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, turn.Message.ID, "Leave on its own")
	if _, err := e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{NodeLineID: branch.Line.ID, Text: "on the branch"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{Text: "on the main line"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.Spinoff(e.ctx, scopeA, branch.Line.ID, tangent.SpinoffInput{Mode: domain.SpinoffDetach}); err != nil {
		t.Fatal(err)
	}
	if n := e.count(`SELECT count(*) FROM tangent_memo WHERE root_line_id = $1`, main.ID); n != 1 {
		t.Fatalf("the old conversation keeps %d memos, want its own one", n)
	}
	moved, err := e.engine.ListMemos(e.ctx, scopeA, branch.Line.ID, "")
	if err != nil || len(moved.Memos) != 1 || moved.Memos[0].RootLineID != branch.Line.ID {
		t.Fatalf("the detached node's memo follows it: %+v %v", moved, err)
	}
	if _, err := e.engine.DeleteTree(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	if n := e.count(`SELECT count(*) FROM tangent_memo WHERE root_line_id = $1`, main.ID); n != 0 {
		t.Fatalf("deleting the conversation leaves %d memos", n)
	}
}

func TestB13_MemoOffKeepsTheMemos(t *testing.T) {
	e := newEnvWith(t, memoFeatures())
	main := e.mainLine()
	if _, err := e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{Text: "kept"}); err != nil {
		t.Fatal(err)
	}
	off := newEnvWith(t, tangent.AllFeatures())
	_, err := off.engine.ListMemos(off.ctx, scopeA, main.ID, "")
	wantCode(t, err, domain.CodeFeatureDisabled)
	_, err = off.engine.CreateMemo(off.ctx, scopeA, main.ID, tangent.MemoInput{Text: "x"})
	wantCode(t, err, domain.CodeFeatureDisabled)
	if n := e.count(`SELECT count(*) FROM tangent_memo`); n != 1 {
		t.Fatalf("memos = %d", n)
	}
}

func TestB13_AFailingHookRollsTheMemoBack(t *testing.T) {
	e := newEnvWith(t, memoFeatures())
	main := e.mainLine()
	e.rollsBack("CreateMemo", func(opt tangent.TxOption) error {
		_, err := e.engine.CreateMemo(e.ctx, scopeA, main.ID, tangent.MemoInput{Text: "x"}, opt)
		return err
	})
	if n := e.count(`SELECT count(*) FROM tangent_memo`); n != 0 {
		t.Fatalf("memos = %d", n)
	}
}
