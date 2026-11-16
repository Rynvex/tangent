package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestTransitionLineStatus(t *testing.T) {
	cases := []struct {
		from, to string
		wantErr  error
	}{
		{LineStatusIdle, LineStatusThinking, nil},
		{LineStatusError, LineStatusThinking, nil},
		{LineStatusThinking, LineStatusThinking, ErrTurnPending},
		{LineStatusThinking, LineStatusIdle, nil},
		{LineStatusIdle, LineStatusIdle, ErrStatusTransition},
		{LineStatusIdle, LineStatusError, nil},
		{LineStatusThinking, LineStatusError, nil},
		{"awaiting_input", LineStatusIdle, ErrStatusTransition},
		{"bogus", LineStatusIdle, ErrStatusTransition},
	}
	for _, tc := range cases {
		err := TransitionLineStatus(tc.from, tc.to)
		if tc.wantErr == nil && err != nil {
			t.Fatalf("%s -> %s: unexpected error %v", tc.from, tc.to, err)
		}
		if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
			t.Fatalf("%s -> %s: error = %v, want %v", tc.from, tc.to, err, tc.wantErr)
		}
	}
}

func TestResolveTurnOutcome(t *testing.T) {
	idle := ResolveTurnOutcome("T3 is blocked by C-3.\n", "")
	if idle.Status != LineStatusIdle || idle.Failed || idle.Content != "T3 is blocked by C-3." {
		t.Fatalf("idle outcome = %+v", idle)
	}

	failed := ResolveTurnOutcome("", "claude exited with error")
	if failed.Status != LineStatusError || !failed.Failed || failed.StatusDetail != "claude exited with error" || !strings.HasPrefix(failed.Content, "Turn failed:") {
		t.Fatalf("error outcome = %+v", failed)
	}

	empty := ResolveTurnOutcome("   ", "")
	if empty.Status != LineStatusError || !empty.Failed {
		t.Fatalf("empty outcome = %+v", empty)
	}

	long := ResolveTurnOutcome("", strings.Repeat("x", 600))
	if len([]rune(long.StatusDetail)) > lineStatusDetailLimit+1 {
		t.Fatalf("status detail not capped: %d runes", len([]rune(long.StatusDetail)))
	}
}

func TestHistoryBeforeTurn_OrdersBySeqAndDropsTheTurnItself(t *testing.T) {
	history := []Message{
		{ID: "pending", Seq: 5, Role: RoleAssistant, Status: MessagePending},
		{ID: "a", Seq: 2, Role: RoleAssistant, Content: "hello", Status: MessageDone},
		{ID: "q", Seq: 4, Role: RoleUser, Content: "current", Status: MessageDone},
		{ID: "u", Seq: 1, Role: RoleUser, Content: "hi", Status: MessageDone},
	}
	got := HistoryBeforeTurn(history, "pending", "q")
	if len(got) != 2 || got[0].ID != "u" || got[1].ID != "a" {
		t.Fatalf("history = %+v", got)
	}
	// Regression: the current message is dropped by id, never by guessing that
	// the last user message is it.
	withSystemLast := append(append([]Message{}, history...), Message{ID: "card", Seq: 6, Role: RoleSystem, Kind: MessageKindBranchCard, Status: MessageDone})
	if got := HistoryBeforeTurn(withSystemLast, "pending", "q"); len(got) != 3 || got[2].ID != "card" {
		t.Fatalf("history = %+v", got)
	}
	if got := HistoryBeforeTurn(history, "pending", ""); len(got) != 3 || got[2].ID != "q" {
		t.Fatalf("without a user message id nothing else is dropped: %+v", got)
	}
	if history[0].ID != "pending" {
		t.Fatal("the input slice must not be reordered")
	}
}

func TestSortBySeq_IgnoresCreatedAt(t *testing.T) {
	// "a" has the smaller seq but the later timestamp; seq wins.
	messages := []Message{{ID: "b", Seq: 9, CreatedAt: packEpoch}, {ID: "a", Seq: 3, CreatedAt: packEpoch.Add(time.Hour)}}
	got := SortBySeq(messages)
	if got[0].ID != "a" || got[1].ID != "b" || messages[0].ID != "b" {
		t.Fatalf("sorted = %+v, input = %+v", got, messages)
	}
}

func TestMessageJSON_KindIsTopLevelAndHostMetaIsKept(t *testing.T) {
	message := Message{ID: "m1", Seq: 7, LineID: "l1", Role: RoleAssistant, Kind: MessageKindChat, Status: MessageDone,
		Meta: MessageMeta{DeliversCards: []string{"c1"}, Usage: &Usage{InputTokens: 3, OutputTokens: 4, CostUSD: 0.5}}, HostMeta: json.RawMessage(`{"x":1}`)}
	raw, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"seq":7`, `"lineId":"l1"`, `"kind":"chat"`, `"role":"assistant"`, `"deliversCards":["c1"]`, `"hostMeta":{"x":1}`, `"costUsd":0.5`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("json lacks %s: %s", want, raw)
		}
	}
	if (Usage{InputTokens: 3, OutputTokens: 4}).TotalTokens() != 7 {
		t.Fatal("total tokens")
	}
}

func TestValidDeltaKind(t *testing.T) {
	for _, kind := range []string{DeltaText, DeltaReasoning, DeltaTool} {
		if !ValidDeltaKind(kind) {
			t.Fatalf("%s must be valid", kind)
		}
	}
	if ValidDeltaKind("image") {
		t.Fatal("unknown kind accepted")
	}
}
