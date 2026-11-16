package cli

import (
	"slices"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

func TestTranscript(t *testing.T) {
	one := []domain.ChatMessage{{Role: domain.ChatRoleUser, Content: "  hi  "}}
	if got := transcript(one); got != "hi\n" {
		t.Fatalf("one message: %q", got)
	}
	if got := transcript(nil); got != "" {
		t.Fatalf("none: %q", got)
	}
	req := tangent.RunRequest{Messages: one}
	if got := singleText(req); !strings.HasPrefix(got, fallbackSystem+"\n\nhi") {
		t.Fatalf("an empty system prompt gets the fallback: %q", got)
	}
}

func TestBuildEnv(t *testing.T) {
	environ := []string{"PATH=/bin", "HOME=/h", "TANGENT_TOKEN=t", "LC_CTYPE=C", "CODEX_HOME=/c", "X=1", "MY_API_KEY=k", "noequals"}
	got := buildEnv(environ, []string{"CODEX_HOME"}, []string{"X", "MY_API_KEY"})
	want := []string{"PATH=/bin", "HOME=/h", "LC_CTYPE=C", "CODEX_HOME=/c", "X=1"}
	if !slices.Equal(got, want) {
		t.Fatalf("env %q, want %q", got, want)
	}
}

func TestClassify(t *testing.T) {
	for text, want := range map[string]failureKind{
		"Claude AI usage limit reached|1700000000":        failUsageLimit,
		"5-hour limit reached ∙ resets 3pm":               failUsageLimit,
		"RESOURCE_EXHAUSTED: quota":                       failUsageLimit,
		"Invalid API key · Please run /login":             failNotLoggedIn,
		"Please set an Auth method in your settings":      failNotLoggedIn,
		"connection reset by peer":                        failOther,
		"429 Too Many Requests":                           failUsageLimit,
		"Error: You are not logged in. Run codex login":   failNotLoggedIn,
		"Your AI credits balance is too low to continue.": failUsageLimit,
		`AGY_ERROR: {"status":"UNAUTHENTICATED"}`:         failNotLoggedIn,
	} {
		if got := classify(text, failOther); got != want {
			t.Errorf("%q: %d, want %d", text, got, want)
		}
	}
	if classifyStatus(401, "") != failNotLoggedIn || classifyStatus(429, "") != failUsageLimit || classifyStatus(500, "boom") != failOther {
		t.Fatal("status classification")
	}
}

func TestExcerpt(t *testing.T) {
	got := excerpt("line one\nAuthorization: Bearer abc.def\n token sk-proj-1234567890abcdef and " + strings.Repeat("z", 300))
	if strings.Contains(got, "abc.def") || strings.Contains(got, "sk-proj") || strings.Contains(got, "\n") || len(got) > excerptLimit+len("…") {
		t.Fatalf("excerpt %q", got)
	}
}

func TestValidModel(t *testing.T) {
	for model, ok := range map[string]bool{
		"sonnet": true, "claude-sonnet-4-5": true, "gpt-5.1-codex": true, "gemini-3.8-flash-medium": true, "openai/gpt-oss:20b": true,
		"-m": false, "--model=x": false, "a b": false, "": false, "x;rm": false, strings.Repeat("a", 201): false,
	} {
		if validModel(model) != ok {
			t.Errorf("%q: want %v", model, ok)
		}
	}
}
