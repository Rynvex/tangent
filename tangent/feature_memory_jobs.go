package tangent

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// memoryExtractInput is what a memory_extract job remembers: the source of
// its memories and the memory each key of its prompt stands for.
type memoryExtractInput struct {
	Source  domain.MemorySource `json:"source"`
	Related map[string]string   `json:"related"`
}

// startMemoryExtract records a memory_extract job for a source, showing
// the model the existing memories most similar to it.
func (e *Engine) startMemoryExtract(ctx context.Context, scope Scope, src extractSource) (Job, error) {
	if strings.TrimSpace(src.prompt.Text) == "" {
		return Job{}, fmt.Errorf("nothing to extract")
	}
	vector, err := e.embedOne(ctx, src.prompt.Text)
	if err != nil {
		return Job{}, err
	}
	similar, err := e.store.SimilarMemories(ctx, scope.Tenant, vector, e.limits.Memory.RelatedMax)
	if err != nil {
		return Job{}, err
	}
	in := memoryExtractInput{Source: src.source, Related: map[string]string{}}
	related := make([]domain.RelatedMemory, 0, len(similar))
	for i, c := range similar {
		key := fmt.Sprintf("K%d", i+1)
		in.Related[key] = c.Memory.ID
		related = append(related, domain.RelatedMemory{Key: key, Memory: c.Memory})
	}
	input, _ := json.Marshal(in)
	record, err := e.startJob(ctx, scope, store.CreateJobInput{Kind: JobKindMemoryExtract, Feature: FeatureMemory, LineID: src.lineID, Input: input}, nil)
	if err != nil {
		return Job{}, err
	}
	text := domain.BuildMemoryExtractPrompt(src.prompt, related, e.markers)
	return e.featureJob(ctx, scope, record, FeatureMemory, text)
}

// MemoryProposal is the payload of a memory suggestion: an addition, or an
// update that supersedes TargetMemoryID; Source is where it came from.
type MemoryProposal struct {
	Action         string              `json:"action"`
	Kind           string              `json:"kind"`
	Text           string              `json:"text"`
	Importance     int                 `json:"importance"`
	TargetMemoryID string              `json:"targetMemoryId,omitempty"`
	Source         domain.MemorySource `json:"source"`
	JobID          string              `json:"jobId"`
}

// finishMemoryExtract proposes the memories (Suggest) or writes them (Auto).
func finishMemoryExtract(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
	var in memoryExtractInput
	_ = json.Unmarshal(job.Input, &in)
	known := map[string]bool{}
	for key := range in.Related {
		known[key] = true
	}
	proposals, parseErr := domain.ParseMemoryExtract(raw, known, e.limits)
	if ok, err := e.finishFeatureJob(ctx, job, runErr, parseErr); !ok {
		return err
	}
	scope := Scope{Tenant: job.TenantID}
	mode := e.modesFor(ctx, scope).of(FeatureMemory)
	for i, p := range proposals {
		proposal := MemoryProposal{Action: p.Action, Kind: p.Kind, Text: p.Text, Importance: p.Importance, TargetMemoryID: in.Related[p.Target], Source: in.Source, JobID: job.ID}
		switch mode {
		case ModeAuto:
			if _, err := e.applyMemoryProposal(ctx, scope, proposal, nil); err != nil {
				e.log.Warn("tangent: an extracted memory was not written", "job", job.ID, "error", err)
			}
		case ModeSuggest:
			payload, _ := json.Marshal(proposal)
			e.publish(ctx, e.proposeSuggestion(ctx, scope, suggestionProposal{
				lineID: job.LineID, kind: SuggestionKindMemory, targetKey: fmt.Sprintf("memory:%s:%d", job.ID, i), payload: payload,
			})...)
		}
	}
	return nil
}

// MemoryAccepted is what accepting a memory or consolidation suggestion
// wrote: the new memory and the ones it superseded.
type MemoryAccepted struct {
	Memory     domain.Memory   `json:"memory"`
	Superseded []domain.Memory `json:"superseded"`
}

// applyMemoryProposal writes an addition or supersedes an update's target.
func (e *Engine) applyMemoryProposal(ctx context.Context, scope Scope, p MemoryProposal, opts []TxOption) (MemoryAccepted, error) {
	in := store.MemoryWriteInput{
		Memory: domain.MemoryInput{Kind: p.Kind, Text: p.Text, Importance: p.Importance}, Source: p.Source, SourceJobID: p.JobID, Actor: scope.Actor,
	}
	if p.Action == "update" && p.TargetMemoryID != "" {
		out, err := e.supersede(ctx, scope, []string{p.TargetMemoryID}, in, opts)
		return MemoryAccepted{Memory: out.New, Superseded: out.Old}, err
	}
	memory, err := domain.NormalizeMemory(in.Memory, e.limits.Memory)
	if err != nil {
		return MemoryAccepted{}, err
	}
	in.Memory = memory
	created, err := e.writeMemory(ctx, scope, in, opts)
	return MemoryAccepted{Memory: created, Superseded: []domain.Memory{}}, err
}

// memoryChoice is the body of accepting a memory: the operator's text,
// kind or importance (a changed text is no longer the model's).
type memoryChoice struct {
	Kind       string `json:"kind"`
	Text       string `json:"text"`
	Importance int    `json:"importance"`
}

func (c memoryChoice) over(kind, text string, importance int) (string, string, int, bool) {
	own := strings.TrimSpace(c.Text) != "" && strings.TrimSpace(c.Text) != text
	return cmp.Or(strings.TrimSpace(c.Kind), kind), cmp.Or(strings.TrimSpace(c.Text), text), cmp.Or(c.Importance, importance), own
}

func acceptMemory(ctx context.Context, e *Engine, scope Scope, s domain.Suggestion, body json.RawMessage, mark TxOption, opts []TxOption) (any, error) {
	var p MemoryProposal
	var choice memoryChoice
	if err := decodeChoice(s.Payload, &p); err != nil {
		return nil, err
	}
	if err := decodeChoice(body, &choice); err != nil {
		return nil, err
	}
	var own bool
	p.Kind, p.Text, p.Importance, own = choice.over(p.Kind, p.Text, p.Importance)
	if own {
		p.JobID = ""
	}
	return e.applyMemoryProposal(ctx, scope, p, append([]TxOption{mark}, opts...))
}
