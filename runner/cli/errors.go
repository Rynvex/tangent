package cli

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/Rynvex/tangent/tangent"
)

// Errors a run fails with, inside a *tangent.RunnerError (errors.Is finds
// them). The RunnerError's Public text never carries the CLI's output; its
// Err carries a short, redacted excerpt for the log.
var (
	// ErrNotInstalled: the executable was not found.
	ErrNotInstalled = errors.New("cli: the CLI is not installed")
	// ErrNotLoggedIn: the CLI has no valid login on this machine.
	ErrNotLoggedIn = errors.New("cli: the CLI is not logged in")
	// ErrUsageLimit: the subscription's usage limit is reached. It is
	// never retried.
	ErrUsageLimit = errors.New("cli: the usage limit is reached")
	// ErrToolUse: the CLI reported a tool, which this runner never allows;
	// the process was killed.
	ErrToolUse = errors.New("cli: the CLI tried to use a tool")
	// ErrReplyTooLarge: the reply passed Config.MaxReplyBytes.
	ErrReplyTooLarge = errors.New("cli: the reply is too large")
	// ErrFailed: any other failure (a non-zero exit, an error the CLI
	// reported, a stream without a reply).
	ErrFailed = errors.New("cli: the CLI run failed")
)

type failureKind int

const (
	failOther failureKind = iota
	failNotInstalled
	failNotLoggedIn
	failUsageLimit
	failToolUse
	failTooLarge
	failOutput
	failIncomplete
)

// failure is why a run failed; detail is raw and is redacted before it is
// logged. A parser returns one (as an error) to stop the run.
type failure struct {
	kind   failureKind
	detail string
}

func (f *failure) Error() string { return fmt.Sprintf("cli failure %d: %s", f.kind, f.detail) }

// fail turns a failure into the RunnerError the engine stores.
func (r *Runner) fail(f failure) error {
	name := r.backend.display
	public, sentinel := "", ErrFailed
	switch f.kind {
	case failNotInstalled:
		public, sentinel = fmt.Sprintf("the %s CLI is not installed on this server", name), ErrNotInstalled
	case failNotLoggedIn:
		public, sentinel = fmt.Sprintf("the %s CLI is not logged in on this server", name), ErrNotLoggedIn
	case failUsageLimit:
		public, sentinel = fmt.Sprintf("the %s subscription's usage limit is reached; try again later", name), ErrUsageLimit
	case failToolUse:
		public, sentinel = fmt.Sprintf("the %s CLI tried to use a tool, which this server does not allow", name), ErrToolUse
	case failTooLarge:
		public, sentinel = "the reply is longer than this server accepts", ErrReplyTooLarge
	case failOutput:
		public = fmt.Sprintf("the output of the %s CLI could not be read", name)
	case failIncomplete:
		public = fmt.Sprintf("the %s CLI ended without a reply", name)
	default:
		public = fmt.Sprintf("the %s CLI failed", name)
	}
	return &tangent.RunnerError{Public: public, Err: fmt.Errorf("%w: %s", sentinel, excerpt(f.detail))}
}

// exitFailure classifies a non-zero exit the stream did not explain, from
// the tail of stderr.
func exitFailure(code int, stderr string) *failure {
	detail := fmt.Sprintf("exit status %d: %s", code, lastLines(stderr, stderrLines))
	return &failure{kind: classify(stderr, failOther), detail: detail}
}

// Text patterns of the failures the CLIs report in prose (lower case).
var (
	usageLimitPatterns = []string{
		"usage limit", "rate limit", "rate_limit", "limit reached", "hit your limit", "quota", "resource_exhausted",
		"too many requests", "billing", "out of credits", "credit balance", "credits balance",
	}
	loginPatterns = []string{
		"not logged in", "/login", "please log in", "please login", "codex login", "authentication", "unauthorized",
		"invalid api key", "auth method", "oauth", "credentials", "not authenticated", "unauthenticated", "sign in",
	}
)

// classify reads a failure's kind from its text; fallback when none fits.
func classify(text string, fallback failureKind) failureKind {
	lower := strings.ToLower(text)
	for _, p := range loginPatterns {
		if strings.Contains(lower, p) {
			return failNotLoggedIn
		}
	}
	for _, p := range usageLimitPatterns {
		if strings.Contains(lower, p) {
			return failUsageLimit
		}
	}
	return fallback
}

// classifyStatus reads a failure's kind from an HTTP status the CLI
// reported, then from its text.
func classifyStatus(status int, text string) failureKind {
	switch status {
	case 401, 403:
		return failNotLoggedIn
	case 429:
		return failUsageLimit
	}
	return classify(text, failOther)
}

// excerptLimit bounds the CLI output kept in a logged error.
const excerptLimit = 200

// secretLike matches text that looks like a credential: key prefixes,
// bearer values and long unbroken tokens.
var secretLike = regexp.MustCompile(`(?i)(sk-[a-z0-9_-]{8,}|bearer\s+\S+|[a-z0-9_\-+/=.]{32,})`)

// excerpt is a short, single-line, redacted piece of text for the log.
func excerpt(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	text = secretLike.ReplaceAllString(text, "[redacted]")
	if len(text) > excerptLimit {
		text = strings.ToValidUTF8(text[:excerptLimit], "") + "…"
	}
	return text
}

// stderrLines is how many of stderr's last lines a logged error keeps.
const stderrLines = 3

// lastLines are the last n non-empty lines of text, joined by " | ".
func lastLines(text string, n int) string {
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines[max(len(lines)-n, 0):], " | ")
}
