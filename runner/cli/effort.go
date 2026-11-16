package cli

import "strings"

// Reasoning efforts (tangent.RunRequest.ReasoningEffort) the CLIs take.
// Each backend maps the request's value onto its own levels; a value it
// does not know is dropped, so a bad setting never breaks a run.
var (
	// claudeEffortLevels are the levels of `claude --effort`.
	claudeEffortLevels = []string{"low", "medium", "high", "max"}
	// codexEffortLevels are the levels of Codex's model_reasoning_effort.
	codexEffortLevels = []string{"low", "medium", "high", "xhigh"}
)

// EffortLevels are the reasoning efforts a backend passes to its CLI, from
// least to most; nil for a backend without one (Agy).
func EffortLevels(b Backend) []string {
	switch b {
	case Claude:
		return append([]string(nil), claudeEffortLevels...)
	case Codex:
		return append([]string(nil), codexEffortLevels...)
	}
	return nil
}

// claudeEffort is the --effort value for a requested effort: one of
// ClaudeEffortLevels, xhigh as max, anything else "" (no flag).
func claudeEffort(effort string) string {
	effort = strings.ToLower(strings.TrimSpace(effort))
	if effort == "xhigh" {
		return "max"
	}
	return knownLevel(effort, claudeEffortLevels)
}

// codexEffort is the model_reasoning_effort value for a requested effort:
// one of codexEffortLevels, max as xhigh, anything else "" (not set).
func codexEffort(effort string) string {
	effort = strings.ToLower(strings.TrimSpace(effort))
	if effort == "max" {
		return "xhigh"
	}
	return knownLevel(effort, codexEffortLevels)
}

func knownLevel(effort string, levels []string) string {
	for _, level := range levels {
		if level == effort {
			return level
		}
	}
	return ""
}

// withEffort appends the effort flag when an effort is set.
func withEffort(args []string, flag, effort string) []string {
	if effort == "" {
		return args
	}
	return append(args, flag, effort)
}
