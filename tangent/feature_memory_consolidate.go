package tangent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// memoryConsolidateInput is what a memory_consolidate job remembers (store
// reads Pair to pick a pair once).
type memoryConsolidateInput struct {
	Pair      string   `json:"pair"`
	MemoryIDs []string `json:"memoryIds"`
}

// consolidateMemories is the maintenance task: a memory_consolidate job
// for each near-duplicate pair (at most ConsolidatePairs per sweep) of a
// tenant with the feature in Suggest or Auto; the jobs go to the job
// dispatcher.
func consolidateMemories(ctx context.Context, e *Engine) (int, error) {
	l := e.limits.Memory
	pairs, err := e.store.DuplicateMemoryPairs(ctx, float64(l.DuplicatePct)/100, l.ConsolidatePairs)
	if err != nil {
		return 0, err
	}
	return e.consolidatePairs(ctx, pairs)
}

// consolidatePairs starts a memory_consolidate job for each pair and hands
// the jobs to the dispatcher.
func (e *Engine) consolidatePairs(ctx context.Context, pairs []store.MemoryPair) (int, error) {
	jobs := []Job{}
	for _, pair := range pairs {
		scope := Scope{Tenant: pair.Tenant}
		if e.modesFor(ctx, scope).of(FeatureMemory) < ModeSuggest {
			continue
		}
		input, _ := json.Marshal(memoryConsolidateInput{Pair: pair.Key, MemoryIDs: []string{pair.A.ID, pair.B.ID}})
		record, err := e.startJob(ctx, scope, store.CreateJobInput{Kind: JobKindMemoryConsolidate, Feature: FeatureMemory, LineID: pair.LineID, Input: input}, nil)
		if domain.CodeOf(err) == domain.CodeLineNotFound {
			// The conversation the suggestion would go to was deleted after
			// the sweep found the pair; a later sweep tries the pair again
			// (on its other source line, if that one is still there).
			e.log.Info("tangent: a memory pair's conversation is gone", "pair", pair.Key, "line", pair.LineID)
			continue
		}
		if err != nil {
			return len(jobs), err
		}
		job, err := e.featureJob(ctx, scope, record, FeatureMemory, domain.BuildMemoryConsolidatePrompt(pair.A, pair.B, e.markers))
		if err != nil {
			return len(jobs), err
		}
		jobs = append(jobs, job)
	}
	e.dispatchOrphanJobs(ctx, jobs)
	return len(jobs), nil
}

// MemoryConsolidation is the payload of a consolidation suggestion: the two
// memories (with their texts when proposed), merge or conflict, and the
// statement that supersedes both.
type MemoryConsolidation struct {
	Action     string   `json:"action"`
	MemoryIDs  []string `json:"memoryIds"`
	Texts      []string `json:"texts"`
	Kind       string   `json:"kind"`
	Text       string   `json:"text"`
	Importance int      `json:"importance"`
	Reason     string   `json:"reason"`
	JobID      string   `json:"jobId"`
}

// finishMemoryConsolidate raises a merge or a conflict in the inbox (Auto
// merges by itself; a conflict always waits for the operator).
func finishMemoryConsolidate(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
	verdict, parseErr := domain.ParseMemoryConsolidate(raw, e.limits)
	if ok, err := e.finishFeatureJob(ctx, job, runErr, parseErr); !ok || verdict.Action == "keep" {
		return err
	}
	var in memoryConsolidateInput
	_ = json.Unmarshal(job.Input, &in)
	scope := Scope{Tenant: job.TenantID}
	c := MemoryConsolidation{Action: verdict.Action, MemoryIDs: in.MemoryIDs, Texts: []string{}, Kind: verdict.Kind, Text: verdict.Text, Importance: verdict.Importance, Reason: verdict.Reason, JobID: job.ID}
	for _, id := range in.MemoryIDs {
		if m, err := e.store.GetMemory(ctx, job.TenantID, id); err == nil {
			c.Texts = append(c.Texts, m.Text)
		}
	}
	mode := e.modesFor(ctx, scope).of(FeatureMemory)
	if mode == ModeAuto && c.Action == "merge" {
		_, err := e.applyConsolidation(ctx, scope, c, nil)
		return err
	}
	if mode < ModeSuggest {
		return nil
	}
	payload, _ := json.Marshal(c)
	e.publish(ctx, e.proposeSuggestion(ctx, scope, suggestionProposal{lineID: job.LineID, kind: SuggestionKindMemoryConsolidate, targetKey: "memory_pair:" + strings.Join(in.MemoryIDs, ":"), payload: payload})...)
	return nil
}

// applyConsolidation supersedes both memories by the statement (the newer
// one's source).
func (e *Engine) applyConsolidation(ctx context.Context, scope Scope, c MemoryConsolidation, opts []TxOption) (MemoryAccepted, error) {
	source := domain.MemorySource{}
	if len(c.MemoryIDs) > 0 {
		if m, err := e.store.GetMemory(ctx, scope.Tenant, c.MemoryIDs[len(c.MemoryIDs)-1]); err == nil {
			source = m.Source
		}
	}
	in := store.MemoryWriteInput{Memory: domain.MemoryInput{Kind: c.Kind, Text: c.Text, Importance: c.Importance}, Source: source, SourceJobID: c.JobID, Actor: scope.Actor}
	out, err := e.supersede(ctx, scope, c.MemoryIDs, in, opts)
	return MemoryAccepted{Memory: out.New, Superseded: out.Old}, err
}

func acceptConsolidation(ctx context.Context, e *Engine, scope Scope, s domain.Suggestion, body json.RawMessage, mark TxOption, opts []TxOption) (any, error) {
	var c MemoryConsolidation
	var choice memoryChoice
	if err := decodeChoice(s.Payload, &c); err != nil {
		return nil, err
	}
	if err := decodeChoice(body, &choice); err != nil {
		return nil, err
	}
	var own bool
	c.Kind, c.Text, c.Importance, own = choice.over(c.Kind, c.Text, c.Importance)
	if own {
		c.JobID = ""
	}
	return e.applyConsolidation(ctx, scope, c, append([]TxOption{mark}, opts...))
}
