package cli

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// TestRealCLISmoke runs one short chat through a real, logged-in CLI. It
// uses the subscription's quota, so it only runs with TANGENT_CLI_SMOKE set
// to claude, codex or agy (optional: TANGENT_CLI_SMOKE_PATH,
// TANGENT_CLI_SMOKE_MODEL); otherwise it is skipped. It makes exactly one
// model call and never retries.
func TestRealCLISmoke(t *testing.T) {
	name := os.Getenv("TANGENT_CLI_SMOKE")
	if name == "" {
		t.Skip("set TANGENT_CLI_SMOKE=claude|codex|agy to run one real CLI call (uses the subscription's quota)")
	}
	r, err := New(Config{Backend: Backend(name), Path: os.Getenv("TANGENT_CLI_SMOKE_PATH"), Model: os.Getenv("TANGENT_CLI_SMOKE_MODEL"), Timeout: 3 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	d := &deltas{}
	result, err := r.Run(context.Background(), tangent.RunRequest{
		System:   "You are a terse assistant. Answer in one short line.",
		Messages: []domain.ChatMessage{{Role: domain.ChatRoleUser, Content: "Reply with the single word: pong"}},
		OnDelta:  d.add,
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if strings.TrimSpace(result.Content) == "" || d.text(domain.DeltaText) == "" {
		t.Fatalf("empty reply: %+v", result)
	}
	t.Logf("%s replied %q (model %q, usage %+v, %d deltas, reasoning %d bytes)",
		name, result.Content, result.Model, result.Usage, len(d.list), len(d.text(domain.DeltaReasoning)))
}
