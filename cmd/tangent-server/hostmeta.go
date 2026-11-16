package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/tangent"
)

// The reference server keeps one thing in host_meta: the reasoning effort.
// A line's {"reasoningEffort": "<level>"} is the conversation's choice (sent
// as a reasoningEffort field of POST /lines or PATCH /lines/{id}); an
// operator message's is the effort its turn runs with (the reasoningEffort
// field of POST /lines/{id}/messages, else the line's, else its main
// line's). routedRunner reads the message's from RunRequest.HostMeta.
const metaReasoningEffort = "reasoningEffort"

// knownEfforts are the levels a client may ask for; whether a model takes
// one is decided when it runs (effortLevels).
var knownEfforts = []string{"low", "medium", "high", "xhigh", "max"}

// effortFromMeta is the reasoning effort in a host_meta object ("" when
// there is none or it cannot be read).
func effortFromMeta(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var meta map[string]any
	if json.Unmarshal(raw, &meta) != nil {
		return ""
	}
	effort, _ := meta[metaReasoningEffort].(string)
	return strings.ToLower(strings.TrimSpace(effort))
}

// effortBody is the field the server reads from a write's body.
type effortBody struct {
	ReasoningEffort *string `json:"reasoningEffort"`
}

// requestedEffort reads the body's reasoningEffort: nil when it is absent,
// "" to clear it, a level otherwise; an unknown level is invalid_input.
func requestedEffort(r *http.Request) (*string, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, fmt.Errorf("read the request body: %w", err)
	}
	var body effortBody
	if len(strings.TrimSpace(string(raw))) == 0 || json.Unmarshal(raw, &body) != nil || body.ReasoningEffort == nil {
		// httpapi has already refused a body that is not JSON.
		return nil, nil
	}
	effort := strings.ToLower(strings.TrimSpace(*body.ReasoningEffort))
	if effort != "" && !slices.Contains(knownEfforts, effort) {
		return nil, domain.NewError(domain.CodeInvalidInput, "reasoningEffort must be one of "+strings.Join(knownEfforts, ", ")+" (or empty)", nil)
	}
	return &effort, nil
}

// metaWithEffort is meta (a host_meta object) with its reasoning effort set to
// effort, or removed when effort is "".
func metaWithEffort(meta json.RawMessage, effort string) (json.RawMessage, error) {
	var fields map[string]any
	if len(meta) > 0 && json.Unmarshal(meta, &fields) != nil || fields == nil {
		fields = map[string]any{}
	}
	if effort == "" {
		delete(fields, metaReasoningEffort)
	} else {
		fields[metaReasoningEffort] = effort
	}
	out, err := json.Marshal(fields)
	if err != nil {
		return nil, fmt.Errorf("encode host_meta: %w", err)
	}
	return out, nil
}

// lineReader is what the host_meta hook reads lines with.
type lineReader interface {
	GetLine(ctx context.Context, scope tangent.Scope, lineID string) (domain.LineView, error)
}

// effortMeta is httpapi.Config.HostMeta for the reference server.
func effortMeta(lines lineReader, scope tangent.Scope) func(r *http.Request, op string) (json.RawMessage, error) {
	return func(r *http.Request, op string) (json.RawMessage, error) {
		switch op {
		case httpapi.OpLinesCreate, httpapi.OpLinesUpdate, httpapi.OpTurnsSend:
		default:
			return nil, nil
		}
		effort, err := requestedEffort(r)
		if err != nil {
			return nil, err
		}
		switch op {
		case httpapi.OpLinesCreate:
			if effort == nil || *effort == "" {
				return nil, nil
			}
			return metaWithEffort(nil, *effort)
		case httpapi.OpLinesUpdate:
			if effort == nil {
				return nil, nil // the line's host_meta stays as it is
			}
			line, err := lines.GetLine(r.Context(), scope, r.PathValue("id"))
			if err != nil {
				return nil, err
			}
			return metaWithEffort(line.HostMeta, *effort)
		}
		return turnEffortMeta(r, lines, scope, effort)
	}
}

// turnEffortMeta is an operator message's host_meta: the body's effort,
// else the line's, else (on a branch) its main line's; nil without one.
func turnEffortMeta(r *http.Request, lines lineReader, scope tangent.Scope, effort *string) (json.RawMessage, error) {
	if effort != nil {
		if *effort == "" {
			return nil, nil
		}
		return metaWithEffort(nil, *effort)
	}
	line, err := lines.GetLine(r.Context(), scope, r.PathValue("id"))
	if errors.Is(err, domain.ErrLineNotFound) {
		return nil, nil // BeginTurn answers it
	}
	if err != nil {
		return nil, err
	}
	found := effortFromMeta(line.HostMeta)
	if found == "" && line.ConversationBranch != nil && line.ConversationBranch.RootLineID != line.ID {
		root, err := lines.GetLine(r.Context(), scope, line.ConversationBranch.RootLineID)
		if err != nil {
			return nil, err
		}
		found = effortFromMeta(root.HostMeta)
	}
	if found == "" {
		return nil, nil
	}
	return metaWithEffort(nil, found)
}
