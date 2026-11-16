package tangent

import (
	"cmp"
	"context"
	"encoding/json"
	"strings"

	"github.com/Rynvex/tangent/domain"
)

// Actions of accepting a group suggestion.
const (
	GroupActionGroup   = "group"
	GroupActionCombine = "combine"
)

// groupChoice is the body of accepting a group suggestion: the action
// (group: its ended members, the default when it has two; combine: its
// open members), the title or purpose and kind, and a choice per conflict
// id (conflicts without one are left as they are).
type groupChoice struct {
	Action  string            `json:"action"`
	Title   string            `json:"title"`
	Purpose string            `json:"purpose"`
	Kind    string            `json:"kind"`
	Choices map[string]string `json:"choices"`
}

// GroupAccepted is what accepting a group suggestion did: the group (and
// its summary job) or the combine, and the notes keepBoth wrote.
type GroupAccepted struct {
	Action   string            `json:"action"`
	Group    *domain.Group     `json:"group,omitempty"`
	Job      *JobStarted       `json:"job,omitempty"`
	Combined *CombinedBranches `json:"combined,omitempty"`
	Notes    *NotesWrite       `json:"notes,omitempty"`
}

// JobStarted names a started job (its result arrives by events).
type JobStarted struct {
	JobID string `json:"jobId"`
	Kind  string `json:"kind"`
}

var errGroupAction = domain.NewError(domain.CodeInvalidInput, "action must be group or combine", nil)

func acceptGroup(ctx context.Context, e *Engine, scope Scope, s domain.Suggestion, body json.RawMessage, mark TxOption, opts []TxOption) (any, error) {
	var payload GroupSuggestion
	var choice groupChoice
	if err := decodeChoice(s.Payload, &payload); err != nil {
		return nil, err
	}
	if err := decodeChoice(body, &choice); err != nil {
		return nil, err
	}
	ended, open := []string{}, []string{}
	for _, m := range payload.Members {
		if m.Ended {
			ended = append(ended, m.LineID)
		} else {
			open = append(open, m.LineID)
		}
	}
	action := strings.TrimSpace(choice.Action)
	if action == "" {
		action = GroupActionCombine
		if len(ended) >= 2 {
			action = GroupActionGroup
		}
	}
	all := append([]TxOption{mark}, opts...)
	switch action {
	case GroupActionGroup:
		return e.acceptAsGroup(ctx, scope, s, payload, choice, ended, all)
	case GroupActionCombine:
		return e.acceptAsCombine(ctx, scope, payload, choice, open, all)
	}
	return nil, errGroupAction
}

func (e *Engine) acceptAsGroup(ctx context.Context, scope Scope, s domain.Suggestion, p GroupSuggestion, c groupChoice, members []string, opts []TxOption) (any, error) {
	created, err := e.CreateGroup(ctx, scope, s.RootLineID, GroupInput{
		MemberLineIDs: members, Title: cmp.Or(strings.TrimSpace(c.Title), p.Title), Conflicts: chosen(p.Conflicts, c.Choices, members),
	}, opts...)
	if err != nil {
		return nil, err
	}
	out := GroupAccepted{Action: GroupActionGroup, Group: &created.Group, Notes: &created.Notes}
	if created.Job != nil {
		out.Job = &JobStarted{JobID: created.Job.ID, Kind: created.Job.Kind}
	}
	return out, nil
}

func (e *Engine) acceptAsCombine(ctx context.Context, scope Scope, p GroupSuggestion, c groupChoice, members []string, opts []TxOption) (any, error) {
	if len(members) < 2 {
		return nil, domain.InvalidGroup("combine needs two or more open branches")
	}
	detail, err := e.store.GetBranch(ctx, scope.Tenant, members[0])
	if err != nil {
		return nil, err
	}
	combined, err := e.CombineBranches(ctx, scope, detail.Branch.ParentLineID, CombineInput{
		LineIDs: members, Purpose: cmp.Or(strings.TrimSpace(c.Purpose), p.Title), Kind: c.Kind, Conflicts: chosen(p.Conflicts, c.Choices, members),
	}, opts...)
	if err != nil {
		return nil, err
	}
	return GroupAccepted{Action: GroupActionCombine, Combined: &combined, Notes: &combined.Notes}, nil
}

// chosen are the conflicts between members that got a choice.
func chosen(conflicts []domain.Conflict, choices map[string]string, members []string) []domain.Conflict {
	in := map[string]bool{}
	for _, id := range members {
		in[id] = true
	}
	out := []domain.Conflict{}
	for _, c := range conflicts {
		if choice, ok := choices[c.ID]; ok && in[c.Branch.LineID] && in[c.Other.LineID] {
			c.Choice = choice
			out = append(out, c)
		}
	}
	return out
}
