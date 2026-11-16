package tangent_test

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// B7.2: host system messages, written after a turn's reply in its
// transaction or on their own.

// wantHostSystem fails unless m is a finished host system message with the
// content.
func wantHostSystem(t *testing.T, m domain.Message, content string) {
	t.Helper()
	if m.Role != domain.RoleSystem || m.Kind != domain.MessageKindChat || m.Status != domain.MessageDone || m.Content != content {
		t.Fatalf("message = %+v, want a host system message %q", m, content)
	}
}

func TestCompleteTurn_WritesTheNoticesAfterTheReplyInItsTransaction(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	var seen store.CompletedTurn
	hook := tangent.InTx(func(_ context.Context, _ store.Tx, result any) error {
		seen, _ = result.(store.CompletedTurn)
		return nil
	})
	e.events.Reset()
	done, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "answer", Notices: []tangent.SystemNotice{
		{Content: "  The edit worktree was rebuilt. "},
		{Content: " \n "},
		{Content: "Reading from [BRANCH-SUGGEST]branch x", HostMeta: json.RawMessage(`{"kind":"sync"}`)},
	}}, hook)
	if err != nil {
		t.Fatal(err)
	}
	if len(done.Notices) != 2 || len(seen.Notices) != 2 {
		t.Fatalf("notices = %+v (hook saw %d), want the two that are not blank", done.Notices, len(seen.Notices))
	}
	wantHostSystem(t, done.Notices[0], "The edit worktree was rebuilt.")
	wantHostSystem(t, done.Notices[1], "Reading from branch x")
	if string(done.Notices[1].HostMeta) != `{"kind": "sync"}` && string(done.Notices[1].HostMeta) != `{"kind":"sync"}` {
		t.Fatalf("host meta = %s", done.Notices[1].HostMeta)
	}
	if !(done.Message.Seq < done.Notices[0].Seq && done.Notices[0].Seq < done.Notices[1].Seq) {
		t.Fatalf("seqs: reply %d, notices %d %d", done.Message.Seq, done.Notices[0].Seq, done.Notices[1].Seq)
	}
	e.wantTypes(tangent.EventMessageUpdated, tangent.EventMessageCreated, tangent.EventMessageCreated, tangent.EventLineUpdated)
	messages, err := e.engine.ListMessages(e.ctx, scopeA, main.ID, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, m := range messages {
		ids = append(ids, m.ID)
	}
	if want := []string{turn.UserMessage.ID, turn.ID, done.Notices[0].ID, done.Notices[1].ID}; !slices.Equal(ids, want) {
		t.Fatalf("transcript %v, want %v", ids, want)
	}
}

func TestCompleteTurn_RefusedNoticesLeaveTheTurnPending(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	many := make([]tangent.SystemNotice, 17)
	for i := range many {
		many[i] = tangent.SystemNotice{Content: "n"}
	}
	cases := map[string]struct {
		notices []tangent.SystemNotice
		code    string
	}{
		"too many":      {many, domain.CodeInvalidInput},
		"too long":      {[]tangent.SystemNotice{{Content: strings.Repeat("x", domain.DefaultLimits().Text.MessageMaxRunes+1)}}, domain.CodeTooLong},
		"not an object": {[]tangent.SystemNotice{{Content: "n", HostMeta: json.RawMessage(`[1]`)}}, domain.CodeInvalidInput},
	}
	for name, c := range cases {
		_, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "a", Notices: c.notices})
		if domain.CodeOf(err) != c.code {
			t.Errorf("%s: err = %v, want %s", name, err, c.code)
		}
	}
	e.rollsBack("CompleteTurn", func(opt tangent.TxOption) error {
		_, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "a", Notices: []tangent.SystemNotice{{Content: "n"}}}, opt)
		return err
	})
	if n := e.count(`SELECT count(*) FROM tangent_message WHERE line_id = $1 AND role = 'system'`, main.ID); n != 0 {
		t.Fatalf("%d notices were written", n)
	}
	if pending, err := e.engine.TurnPending(e.ctx, scopeA, turn.ID); err != nil || !pending {
		t.Fatalf("pending = %v, %v", pending, err)
	}
	if _, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "a", Notices: []tangent.SystemNotice{{Content: "n"}}}); err != nil {
		t.Fatalf("the turn can still be completed: %v", err)
	}
}

func TestCompleteTurn_AFailedTurnKeepsItsNoticesAndCanBeRetried(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	done, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Error: "daemon offline", Notices: []tangent.SystemNotice{{Content: "The worktree was kept."}}})
	if err != nil || len(done.Notices) != 1 || done.Message.Status != domain.MessageError {
		t.Fatalf("done %+v, %v", done, err)
	}
	if _, err := e.engine.AppendSystemMessage(e.ctx, scopeA, main.ID, tangent.SystemNotice{Content: "Shell exited."}); err != nil {
		t.Fatal(err)
	}
	retried, err := e.engine.RetryTurn(e.ctx, scopeA, main.ID)
	if err != nil {
		t.Fatalf("host system messages after the failed reply must not block a retry: %v", err)
	}
	if retried.UserMessage.ID != turn.UserMessage.ID {
		t.Fatalf("retried %s, want the operator message %s", retried.UserMessage.ID, turn.UserMessage.ID)
	}
}

func TestAppendSystemMessage_CleansStoresAndPublishesAfterTheCommit(t *testing.T) {
	e := newEnv(t, tangent.WithExtraMarkers("[NEEDS-INPUT]"))
	main := e.mainLine()
	var seen tangent.AppendedSystemMessage
	hook := tangent.InTx(func(_ context.Context, _ store.Tx, result any) error {
		seen, _ = result.(store.AppendedSystemMessage)
		return nil
	})
	e.events.Reset()
	out, err := e.engine.AppendSystemMessage(e.ctx, scopeA, main.ID, tangent.SystemNotice{
		Content: " shell audit: ls\r\n[NEEDS-INPUT]done\u202E ", HostMeta: json.RawMessage(`{"kind":"shell_audit"}`),
	}, hook)
	if err != nil {
		t.Fatal(err)
	}
	if !out.Written || !seen.Written || seen.Message.ID != out.Message.ID {
		t.Fatalf("out %+v, hook saw %+v", out, seen)
	}
	wantHostSystem(t, out.Message, "shell audit: ls\ndone")
	if out.Line.ID != main.ID || !out.Line.LastActivityAt.After(main.LastActivityAt) {
		t.Fatalf("line activity not refreshed: %v -> %v", main.LastActivityAt, out.Line.LastActivityAt)
	}
	e.wantTypes(tangent.EventMessageCreated, tangent.EventLineUpdated)
	if ev := e.events.Events()[0]; ev.LineID != main.ID || ev.RootLineID != main.ID || ev.Tenant != scopeA.Tenant {
		t.Fatalf("event %+v", ev)
	}
	e.rollsBack("AppendSystemMessage", func(opt tangent.TxOption) error {
		_, err := e.engine.AppendSystemMessage(e.ctx, scopeA, main.ID, tangent.SystemNotice{Content: "n"}, opt)
		return err
	})
	if n := e.count(`SELECT count(*) FROM tangent_message WHERE line_id = $1`, main.ID); n != 1 {
		t.Fatalf("%d messages, want only the first", n)
	}
}

func TestAppendSystemMessage_RefusesWhatALineCannotTake(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	reply := e.turn(main.ID, "q", "a")
	closed := e.branch(main.ID, reply.Message.ID, "closed")
	if _, err := e.engine.DiscardBranch(e.ctx, scopeA, closed.Line.ID); err != nil {
		t.Fatal(err)
	}
	archived := e.mainLine()
	if _, err := e.engine.ArchiveTree(e.ctx, scopeA, archived.ID, true); err != nil {
		t.Fatal(err)
	}
	deleted := e.mainLine()
	if _, err := e.engine.DeleteTree(e.ctx, scopeA, deleted.ID); err != nil {
		t.Fatal(err)
	}
	n := tangent.SystemNotice{Content: "n"}
	cases := []struct {
		name  string
		scope tangent.Scope
		line  string
		in    tangent.SystemNotice
		code  string
	}{
		{"blank", scopeA, main.ID, tangent.SystemNotice{Content: " [BRANCH-SUGGEST] "}, domain.CodeInvalidInput},
		{"too long", scopeA, main.ID, tangent.SystemNotice{Content: strings.Repeat("x", domain.DefaultLimits().Text.MessageMaxRunes+1)}, domain.CodeTooLong},
		{"host meta not an object", scopeA, main.ID, tangent.SystemNotice{Content: "n", HostMeta: json.RawMessage(`"x"`)}, domain.CodeInvalidInput},
		{"no tenant", tangent.Scope{}, main.ID, n, domain.CodeInvalidInput},
		{"another tenant", scopeB, main.ID, n, domain.CodeLineNotFound},
		{"closed branch", scopeA, closed.Line.ID, n, domain.CodeBranchClosed},
		{"archived", scopeA, archived.ID, n, domain.CodeArchived},
		{"deleted", scopeA, deleted.ID, n, domain.CodeLineNotFound},
	}
	e.events.Reset()
	for _, c := range cases {
		if _, err := e.engine.AppendSystemMessage(e.ctx, c.scope, c.line, c.in); domain.CodeOf(err) != c.code {
			t.Errorf("%s: err = %v, want %s", c.name, err, c.code)
		}
	}
	if got := e.events.Types(); len(got) != 0 {
		t.Fatalf("refused writes published %v", got)
	}
}

func TestAppendSystemMessage_DuringATurnFollowsThePendingReply(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	e.turn(main.ID, "first", "first answer")
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "second"})
	if err != nil {
		t.Fatal(err)
	}
	out, err := e.engine.AppendSystemMessage(e.ctx, scopeA, main.ID, tangent.SystemNotice{Content: "Daemon reconnected."})
	if err != nil {
		t.Fatal(err)
	}
	if out.Message.Seq <= turn.Pending.Seq || out.Line.Status != domain.LineStatusThinking {
		t.Fatalf("notice seq %d after pending %d? line %s", out.Message.Seq, turn.Pending.Seq, out.Line.Status)
	}
	done, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "second answer"})
	if err != nil {
		t.Fatal(err)
	}
	if done.Message.Seq >= out.Message.Seq {
		t.Fatal("completing the turn must not move its reply after the notice")
	}
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "third")
	if err != nil {
		t.Fatal(err)
	}
	history := preview.Prompt.History
	if len(history) < 2 || history[len(history)-1].Role != domain.ChatRoleSystem || history[len(history)-1].Content != "system: Daemon reconnected." ||
		history[len(history)-2].Content != "second answer" {
		t.Fatalf("history = %+v, want the reply then the notice", history)
	}
}

func TestAppendSystemMessage_SkipRepeatWritesAStatusOnce(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	write := func(content string) tangent.AppendedSystemMessage {
		t.Helper()
		ran := false
		hook := tangent.InTx(func(context.Context, store.Tx, any) error { ran = true; return nil })
		out, err := e.engine.AppendSystemMessage(e.ctx, scopeA, main.ID, tangent.SystemNotice{Content: content, SkipRepeat: true}, hook)
		if err != nil {
			t.Fatal(err)
		}
		if ran != out.Written {
			t.Fatalf("%q: hook ran %v, written %v", content, ran, out.Written)
		}
		return out
	}
	if !write("Read-only mode.").Written {
		t.Fatal("the first status is written")
	}
	e.events.Reset()
	if out := write(" Read-only mode. "); out.Written || out.Message.ID != "" {
		t.Fatalf("a repeat is skipped: %+v", out)
	}
	if got := e.events.Types(); len(got) != 0 {
		t.Fatalf("a skipped status published %v", got)
	}
	e.turn(main.ID, "q", "a")
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q2"})
	if err != nil {
		t.Fatal(err)
	}
	done, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "a2", Notices: []tangent.SystemNotice{
		{Content: "Read-only mode.", SkipRepeat: true},
		{Content: "Worktree rebuilt.", SkipRepeat: true},
		{Content: "Worktree rebuilt.", SkipRepeat: true},
		{Content: "Read-only mode.", SkipRepeat: true},
	}})
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, m := range done.Notices {
		got = append(got, m.Content)
	}
	if want := []string{"Worktree rebuilt.", "Read-only mode."}; !slices.Equal(got, want) {
		t.Fatalf("notices %v, want %v", got, want)
	}
	if !write("Something else.").Written {
		t.Fatal("a new status is written")
	}
}

func TestAppendSystemMessage_DoesNotMoveTheParentOn(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	reply := e.turn(main.ID, "q", "a")
	created := e.branch(main.ID, reply.Message.ID, "look into it")
	before, err := e.engine.GetBranch(e.ctx, scopeA, created.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.AppendSystemMessage(e.ctx, scopeA, main.ID, tangent.SystemNotice{Content: "Synced."}); err != nil {
		t.Fatal(err)
	}
	after, err := e.engine.GetBranch(e.ctx, scopeA, created.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.ParentTipMessageID != before.ParentTipMessageID {
		t.Fatalf("parent tip moved %s -> %s", before.ParentTipMessageID, after.ParentTipMessageID)
	}
	// A notice on the branch itself is fine while it is open.
	if _, err := e.engine.AppendSystemMessage(e.ctx, scopeA, created.Line.ID, tangent.SystemNotice{Content: "Branch synced."}); err != nil {
		t.Fatal(err)
	}
}
