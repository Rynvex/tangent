package httpapi_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
)

// b21Messages is n messages taking turns, each content long.
func b21Messages(n int, content string) []map[string]any {
	out := make([]map[string]any, 0, n)
	for i := range n {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		out = append(out, map[string]any{"role": role, "content": content})
	}
	return out
}

// B21: a 2,000-message import fits the default import body limit (16 MiB)
// with replies of 1,000 Chinese characters; one more message is refused by
// the engine, not the body limit.
func TestB21Routes_ImportTakesTheLongestConversation(t *testing.T) {
	h := newHarness(t)
	content := strings.Repeat("長", 1000)
	out := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/import", map[string]any{"title": "long", "messages": b21Messages(domain.ImportMaxMessages, content)}))
	if out["messageCount"] != float64(domain.ImportMaxMessages) {
		t.Fatalf("imported = %v", out["messageCount"])
	}
	r := h.do(http.MethodPost, "/lines/import", map[string]any{"messages": b21Messages(domain.ImportMaxMessages+1, "x")})
	h.wantError(r, http.StatusBadRequest, "invalid_input")
	if !strings.Contains(string(r.raw), "an import has 1 to 2000 messages") {
		t.Fatalf("refusal = %s", r.raw)
	}
}
