package cli

import (
	"slices"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

// preparedArgs builds a backend's arguments for a request without running
// anything.
func preparedArgs(t *testing.T, b Backend, model string, req tangent.RunRequest) []string {
	t.Helper()
	dir := runDir{root: t.TempDir(), work: t.TempDir()}
	inv, err := backends[b].prepare(dir, model, req)
	if err != nil {
		t.Fatal(err)
	}
	return inv.args
}

// flagValue is the argument after flag, or "" when flag is absent.
func flagValue(args []string, flag string) string {
	i := slices.Index(args, flag)
	if i < 0 || i+1 >= len(args) {
		return ""
	}
	return args[i+1]
}

func TestClaudeArgs_Effort(t *testing.T) {
	for _, c := range []struct{ effort, want string }{
		{"", ""}, {"low", "low"}, {"medium", "medium"}, {" High ", "high"}, {"max", "max"}, {"xhigh", "max"},
		{"minimal", ""}, {"--dangerous", ""}, {"ultra", ""},
	} {
		args := preparedArgs(t, Claude, "sonnet", tangent.RunRequest{ReasoningEffort: c.effort})
		if got := flagValue(args, "--effort"); got != c.want {
			t.Errorf("effort %q: --effort %q, want %q (args %q)", c.effort, got, c.want, args)
		}
		if c.want == "" && slices.Contains(args, "--effort") {
			t.Errorf("effort %q: no --effort flag expected: %q", c.effort, args)
		}
		if flagValue(args, "--model") != "sonnet" {
			t.Errorf("the model flag is kept: %q", args)
		}
	}
}

func TestCodexArgs_Effort(t *testing.T) {
	for _, c := range []struct{ effort, want string }{
		{"", ""}, {"low", `model_reasoning_effort="low"`}, {"high", `model_reasoning_effort="high"`},
		{"xhigh", `model_reasoning_effort="xhigh"`}, {"max", `model_reasoning_effort="xhigh"`}, {"bogus\"", ""},
	} {
		args := preparedArgs(t, Codex, "gpt-6.1-sol", tangent.RunRequest{ReasoningEffort: c.effort})
		var got string
		for i, arg := range args {
			if arg == "-c" && i+1 < len(args) && strings.HasPrefix(args[i+1], "model_reasoning_effort=") {
				got = args[i+1]
			}
		}
		if got != c.want {
			t.Errorf("effort %q: %q, want %q (args %q)", c.effort, got, c.want, args)
		}
		if args[len(args)-1] != "-" || flagValue(args, "-m") != "gpt-6.1-sol" {
			t.Errorf("the prompt still comes from stdin and the model is kept: %q", args)
		}
	}
}

func TestAgyArgs_IgnoreEffort(t *testing.T) {
	plain := preparedArgs(t, Agy, "gemini-4-carbon", tangent.RunRequest{})
	withEffort := preparedArgs(t, Agy, "gemini-4-carbon", tangent.RunRequest{ReasoningEffort: "high"})
	if !slices.Equal(plain, withEffort) {
		t.Fatalf("agy has no effort setting: %q vs %q", plain, withEffort)
	}
}

func TestEffortLevels(t *testing.T) {
	if got := EffortLevels(Claude); !slices.Equal(got, []string{"low", "medium", "high", "max"}) {
		t.Fatalf("claude %q", got)
	}
	if got := EffortLevels(Codex); !slices.Equal(got, []string{"low", "medium", "high", "xhigh"}) {
		t.Fatalf("codex %q", got)
	}
	if EffortLevels(Agy) != nil {
		t.Fatal("agy has none")
	}
	EffortLevels(Claude)[0] = "changed"
	if EffortLevels(Claude)[0] != "low" {
		t.Fatal("a copy is returned")
	}
}
