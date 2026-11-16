package domain

import (
	"strings"
	"unicode/utf8"
)

// Diverging across models (B14): the operator names 2–5 provider/model
// targets and each becomes a sibling branch on the anchor (kind
// alternative, origin diverge) answered by its own model. No job runs: the
// branches open at once, all or none.

// defaultDivergePurposeRunes is how much of the anchor message names a
// target's branch when neither the target nor the call gives a purpose.
const defaultDivergePurposeRunes = 40

// divergeModelSeparator joins a purpose and the model that answers it.
const divergeModelSeparator = " · "

// DivergeTarget is one model a cross-model diverge opens a branch for.
type DivergeTarget struct {
	Provider string
	Model    string
	// Purpose is the branch's own purpose; empty derives one (see
	// DivergeTargetPurpose).
	Purpose string
}

// DivergeTargetPurpose is the purpose of a target's branch: its own
// purpose when given (ok false when it is too long), else "{shared} ·
// {model}", else the anchor's first 40 characters on one line plus
// " · {model}". A derived purpose is cut to the purpose limit, keeping the
// model name when it fits.
func DivergeTargetPurpose(t DivergeTarget, shared, anchor string, l BranchLimits) (string, bool) {
	l = l.orDefault()
	if strings.TrimSpace(t.Purpose) != "" {
		return NormalizeBranchPurpose(branchLine(t.Purpose), l)
	}
	prefix := branchLine(shared)
	if prefix == "" {
		prefix = CutRunes(branchLine(anchor), defaultDivergePurposeRunes)
	}
	suffix := divergeModelSeparator + branchLine(t.Model)
	if prefix == "" {
		return NormalizeBranchPurpose(branchLine(t.Model), l)
	}
	room := l.PurposeMaxRunes - utf8.RuneCountInString(suffix)
	if room < 1 {
		return NormalizeBranchPurpose(CutRunes(prefix+suffix, l.PurposeMaxRunes), l)
	}
	return NormalizeBranchPurpose(CutRunes(prefix, room)+suffix, l)
}

// BuildDivergeTargetsNote is what a cross-model branch's pack adds: that it
// is one of several parallel answers to the message above, which model
// answers it, and the sibling branches with theirs. purposes holds every
// target's branch purpose in targets' order; own is this branch's index.
func BuildDivergeTargetsNote(own int, targets []DivergeTarget, purposes []string) string {
	var b strings.Builder
	b.WriteString("\n## Parallel answers\n\nThis branch is one of several parallel branches on the message above, each answered by a different model.\n")
	b.WriteString("> " + divergeTargetLabel(targets[own], purposes[own]) + "\n")
	others := []string{}
	for i, t := range targets {
		if i != own {
			others = append(others, "> "+divergeTargetLabel(t, purposes[i]))
		}
	}
	if len(others) > 0 {
		b.WriteString("\nThe sibling branches:\n" + strings.Join(others, "\n") + "\n")
	}
	return b.String()
}

func divergeTargetLabel(t DivergeTarget, purpose string) string {
	return branchLine(purpose) + " (" + branchLine(t.Provider) + "/" + branchLine(t.Model) + ")"
}
