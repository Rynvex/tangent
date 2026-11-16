package anthropic_test

import (
	"context"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

func TestRun_TheCacheBreakpointFollowsTheStableSystemBlock(t *testing.T) {
	s := newServer(t, stream(happy...))
	r := newRunner(t, s)
	req := tangent.RunRequest{
		System:       "rules\n\nsummary",
		SystemBlocks: []tangent.SystemBlock{{Text: "rules", Stable: true}, {Text: " "}, {Text: "summary"}},
		Messages:     []domain.ChatMessage{{Role: "user", Content: "q"}},
	}
	if _, err := r.Run(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	system := (<-s.bodies)["system"].([]any)
	if len(system) != 2 {
		t.Fatalf("blank blocks are left out: %v", system)
	}
	stable, volatile := system[0].(map[string]any), system[1].(map[string]any)
	if stable["text"] != "rules" || stable["cache_control"] == nil || volatile["text"] != "summary" || volatile["cache_control"] != nil {
		t.Fatalf("system = %v", system)
	}
	volatileOnly := tangent.RunRequest{SystemBlocks: []tangent.SystemBlock{{Text: "summary"}}, Messages: req.Messages}
	if _, err := r.Run(context.Background(), volatileOnly); err != nil {
		t.Fatal(err)
	}
	if block := (<-s.bodies)["system"].([]any)[0].(map[string]any); block["cache_control"] != nil {
		t.Fatalf("no stable block, no system breakpoint: %v", block)
	}
}

func TestRun_AMessageDeltaWithoutUsageKeepsTheOutputCount(t *testing.T) {
	events := append([]event{}, happy[:len(happy)-2]...)
	events = append(events,
		event{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}`},
		event{"message_delta", `{"type":"message_delta","delta":{}}`},
		event{"ping", ``},
		event{"message_stop", `{"type":"message_stop"}`},
	)
	s := newServer(t, stream(events...))
	got, err := newRunner(t, s).Run(context.Background(), request)
	if err != nil || got.Usage.OutputTokens != 9 || got.StopReason != "end_turn" {
		t.Fatalf("got %+v err %v", got, err)
	}
}
