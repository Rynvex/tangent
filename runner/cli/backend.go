package cli

import (
	"bytes"
	"encoding/json"

	"github.com/Rynvex/tangent/tangent"
)

// invocation is how one run calls the CLI: its arguments (never the
// prompt) and its stdin (the prompt).
type invocation struct {
	args  []string
	stdin string
}

// parser reads one CLI's stream: line gets every stdout line (an error
// stops the run and kills the process), finish gives the result.
type parser interface {
	line(raw []byte) error
	finish() (tangent.RunResult, *failure)
}

// backend is what differs between the CLIs.
type backend struct {
	// display names the CLI in public error texts.
	display string
	// env are the CLI's own configuration variables it may see.
	env     []string
	prepare func(dir runDir, model string, req tangent.RunRequest) (invocation, error)
	parser  func(*reply) parser
}

var backends = map[Backend]backend{Claude: claudeBackend, Codex: codexBackend, Agy: agyBackend}

// decodeLine reads a JSON stream line into v; false for a line that is not
// a JSON object (a CLI may print other lines, which are skipped).
func decodeLine(raw []byte, v any) bool {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' {
		return false
	}
	return json.Unmarshal(raw, v) == nil
}

// withModel appends the model flag when a model is set.
func withModel(args []string, flag, model string) []string {
	if model == "" {
		return args
	}
	return append(args, flag, model)
}
