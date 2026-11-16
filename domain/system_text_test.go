package domain

import (
	"strings"
	"testing"
)

func TestCleanSystemText_RemovesMarkersControlsAndOuterSpace(t *testing.T) {
	got := CleanSystemText("  rebuilt [BRANCH-SUGGEST]x[/BRANCH-SUGGEST]\r\nnext\u0007line [NEEDS-INPUT]\t ", []string{"[NEEDS-INPUT]"})
	if want := "rebuilt x\nnext line"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	// A marker split by a bidirectional control is joined by removing the
	// control, so it must be stripped after that.
	if got := CleanSystemText("a[BRANCH-\u202ASUGGEST]b", nil); got != "ab" {
		t.Fatalf("split marker: %q", got)
	}
	if got := CleanSystemText(" \u2028 [SESSION-SUMMARY] ", nil); got != "" {
		t.Fatalf("only markers and space: %q", got)
	}
	if got := CleanSystemText("keep ```fences``` and **markdown**", nil); got != "keep ```fences``` and **markdown**" {
		t.Fatalf("display text changed: %q", got)
	}
}

func TestHistory_AHostSystemMessageIsASystemEntry(t *testing.T) {
	notice := Message{ID: "n", Seq: 3, Role: RoleSystem, Kind: MessageKindChat, Status: MessageDone, Content: "The worktree was rebuilt."}
	earlier, entries := buildHistory([]Message{
		{ID: "u", Seq: 1, Role: RoleUser, Kind: MessageKindChat, Status: MessageDone, Content: "hi"},
		{ID: "a", Seq: 2, Role: RoleAssistant, Kind: MessageKindChat, Status: MessageDone, Content: "hello"},
		notice,
	}, HistoryLimits{TokenBudget: 1000, MessageTokenCap: 500})
	if earlier != "" || len(entries) != 3 {
		t.Fatalf("earlier %q, entries %+v", earlier, entries)
	}
	if last := entries[2]; last.Role != ChatRoleSystem || last.Content != "system: The worktree was rebuilt." {
		t.Fatalf("notice entry = %+v", last)
	}
	if line := condensedHistoryLine(notice); !strings.Contains(line, "system: The worktree was rebuilt.") {
		t.Fatalf("condensed = %q", line)
	}
}
