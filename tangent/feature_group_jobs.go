package tangent

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// groupCandidatesMax bounds the branches one group_suggest job sees.
const groupCandidatesMax = 30

// groupSuggestMinCandidates: a suggestion needs at least this many branches.
const groupSuggestMinCandidates = 3

// SummarizeGroup starts a group_summary job for an active group (any mode:
// the operator asked); a summary started before it no longer writes.
// InTx hooks receive store.GroupSummaryClaim.
func (e *Engine) SummarizeGroup(ctx context.Context, scope Scope, groupID string, opts ...TxOption) (Job, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureGroup)
	if err != nil {
		return Job{}, err
	}
	source, err := e.store.GroupSummarySource(ctx, scope.Tenant, groupID)
	if err != nil {
		return Job{}, err
	}
	claim, err := e.store.StartGroupSummary(ctx, scope.Tenant, groupID, FeatureGroup, hooksOf(opts)...)
	if err != nil {
		return Job{}, err
	}
	e.publish(ctx, groupEvent(scope.Tenant, claim.Group))
	members := make([]domain.GroupMemberInput, 0, len(source.Members))
	for _, m := range source.Members {
		leaf := m.Leaf
		if leaf == "" {
			leaf = m.Conclusion
		}
		members = append(members, domain.GroupMemberInput{Purpose: m.Purpose, LeafKind: m.LeafKind, Leaf: leaf, Body: m.Body})
	}
	text := domain.BuildGroupSummaryPrompt(domain.GroupSummaryInput{Title: claim.Group.Title, Members: members, Settled: source.Settled, ExtraMarkers: e.markers})
	return e.featureJob(ctx, scope, claim.Job, FeatureGroup, text)
}

// featureJob is a feature's job on its line, with the feature's job model
// (or the line's own).
func (e *Engine) featureJob(ctx context.Context, scope Scope, record JobRecord, feature, text string) (Job, error) {
	line, err := e.store.GetLine(ctx, scope.Tenant, record.LineID)
	if err != nil {
		return Job{}, err
	}
	provider, model := e.configOf(feature).jobModel(line.Provider, line.Model)
	return Job{ID: record.ID, Kind: record.Kind, Feature: feature, Scope: scope, LineID: record.LineID, Prompt: jobPrompt(text), Provider: provider, Model: model}, nil
}

// finishGroupSummary writes the group's summary, or marks it failed.
func finishGroupSummary(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
	summary, parseErr := domain.ParseGroupSummary(raw, e.limits.Group)
	failure := ""
	switch {
	case runErr != nil:
		failure = domain.JobRunFailedText
	case parseErr != nil:
		failure = domain.JobUnusableText
	}
	result, err := e.store.FinishGroupSummary(ctx, job.ID, summary, failure)
	if err != nil {
		return err
	}
	if result.Written {
		e.publish(ctx, groupEvent(job.TenantID, result.Group))
	}
	if failure != "" {
		e.publishJobFailed(ctx, job, failure)
	}
	return nil
}

// staleGroupSummary marks the group of a timed-out summary failed.
func staleGroupSummary(ctx context.Context, e *Engine, job JobRecord) {
	group, err := e.store.FailGroupSummaryOfJob(ctx, job.ID)
	if err != nil {
		e.log.Warn("tangent: a timed-out group summary was not marked", "job", job.ID, "error", err)
	}
	if group != nil {
		e.publish(ctx, groupEvent(job.TenantID, *group))
	}
	e.publishJobFailed(ctx, job, job.Error)
}

// groupSuggestAfterClose asks for groups (Suggest, Auto) when a branch
// that is not an aside was merged or discarded.
func groupSuggestAfterClose(ctx context.Context, e *Engine, mode Mode, ev *commitEvent) ([]Event, []Job) {
	if ev.kind != commitBranchClosed || mode < ModeSuggest || ev.branch == nil || ev.branch.Kind == domain.BranchKindAside {
		return nil, nil
	}
	if ev.change != BranchMerged && ev.change != BranchDiscarded {
		return nil, nil
	}
	job, ok, err := e.startGroupSuggest(ctx, ev.scope, ev.branch.RootLineID)
	if err != nil {
		e.log.Warn("tangent: a group suggestion was not started", "root", ev.branch.RootLineID, "error", err)
	}
	if !ok {
		return nil, nil
	}
	return nil, []Job{job}
}

// groupJobBranch is a candidate a group_suggest job showed under its key.
type groupJobBranch struct {
	LineID  string `json:"lineId"`
	Purpose string `json:"purpose"`
	Ended   bool   `json:"ended"`
	Leaf    string `json:"leaf"`
}

// startGroupSuggest records a group_suggest job for a tree with enough
// candidates: ended branches with a leaf (or a card's conclusion) not in an
// active group, and open branches with an exchange.
func (e *Engine) startGroupSuggest(ctx context.Context, scope Scope, rootID string) (Job, bool, error) {
	tree, err := e.store.FisheyeTree(ctx, scope.Tenant, rootID)
	if err != nil {
		return Job{}, false, err
	}
	grouped, err := e.groupedLines(ctx, scope, rootID)
	if err != nil {
		return Job{}, false, err
	}
	keys, prompt := groupCandidates(tree.Branches, grouped)
	if len(keys) < groupSuggestMinCandidates {
		return Job{}, false, nil
	}
	if prompt.Relations, err = e.groupRelations(ctx, scope, rootID, keys); err != nil {
		return Job{}, false, err
	}
	prompt.ExtraMarkers = e.markers
	input, _ := json.Marshal(keys)
	record, err := e.startJob(ctx, scope, store.CreateJobInput{Kind: JobKindGroupSuggest, Feature: FeatureGroup, LineID: rootID, Input: input, Supersede: true}, nil)
	if err != nil {
		return Job{}, false, err
	}
	job, err := e.featureJob(ctx, scope, record, FeatureGroup, domain.BuildGroupSuggestPrompt(prompt))
	return job, err == nil, err
}

// groupedLines are the branches already in an active group of the tree.
func (e *Engine) groupedLines(ctx context.Context, scope Scope, rootID string) (map[string]bool, error) {
	list, err := e.store.ListGroups(ctx, scope.Tenant, rootID, nil)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, g := range list.Groups {
		for _, id := range g.MemberLineIDs {
			out[id] = true
		}
	}
	return out, nil
}

// groupCandidates keys the candidates, newest first: ended branches (not
// promoted) with a leaf or a card's conclusion, open ones with a reply; no
// asides, nothing already in an active group.
func groupCandidates(branches []store.FisheyeTreeBranch, grouped map[string]bool) (map[string]groupJobBranch, domain.GroupSuggestInput) {
	keys := map[string]groupJobBranch{}
	prompt := domain.GroupSuggestInput{}
	for _, b := range slices.Backward(branches) {
		leaf, ended := treeLeaf(b), b.Status != domain.BranchStatusOpen
		usable := (ended && leaf != "" && b.Status != domain.BranchStatusPromoted) || (!ended && b.HasReply)
		if !usable || b.Kind == domain.BranchKindAside || grouped[b.LineID] || len(keys) == groupCandidatesMax {
			continue
		}
		key := fmt.Sprintf("B%d", len(keys)+1)
		keys[key] = groupJobBranch{LineID: b.LineID, Purpose: b.Purpose, Ended: ended, Leaf: leaf}
		prompt.Candidates = append(prompt.Candidates, domain.GroupCandidate{Key: key, Purpose: b.Purpose, Ended: ended, Leaf: leaf})
	}
	return keys, prompt
}

// groupRelations are the relations between candidates, by key.
func (e *Engine) groupRelations(ctx context.Context, scope Scope, rootID string, keys map[string]groupJobBranch) ([]domain.GroupRelation, error) {
	links, err := e.store.ListLinks(ctx, scope.Tenant, rootID, []string{domain.LinkKindRelation})
	if err != nil {
		return nil, err
	}
	byLine := map[string]string{}
	for key, b := range keys {
		byLine[b.LineID] = key
	}
	out := []domain.GroupRelation{}
	for _, link := range links {
		from, to := byLine[link.FromLineID], byLine[link.ToLineID]
		if from != "" && to != "" {
			out = append(out, domain.GroupRelation{From: from, To: to, Label: link.Label})
		}
	}
	return out, nil
}

// GroupSuggestion is the payload of a group suggestion: its title, members
// (ended or open) and the conflicts between their claims (ids c1, c2…).
type GroupSuggestion struct {
	Title     string                `json:"title"`
	Members   []GroupSuggestionLine `json:"members"`
	Conflicts []domain.Conflict     `json:"conflicts"`
}

// GroupSuggestionLine is a proposed member.
type GroupSuggestionLine struct {
	LineID  string `json:"lineId"`
	Purpose string `json:"purpose"`
	Ended   bool   `json:"ended"`
	Leaf    string `json:"leaf"`
}

// finishGroupSuggest raises each proposed group in the inbox.
func finishGroupSuggest(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error {
	keys := map[string]groupJobBranch{}
	_ = json.Unmarshal(job.Input, &keys)
	known := map[string]bool{}
	for key := range keys {
		known[key] = true
	}
	proposals, parseErr := domain.ParseGroupSuggestions(raw, known, e.limits.Group)
	if ok, err := e.finishFeatureJob(ctx, job, runErr, parseErr); !ok {
		return err
	}
	scope := Scope{Tenant: job.TenantID}
	if e.modesFor(ctx, scope).of(FeatureGroup) < ModeSuggest {
		return nil
	}
	for _, p := range proposals {
		payload, target := groupSuggestion(p, keys)
		raw, _ := json.Marshal(payload)
		e.publish(ctx, e.proposeSuggestion(ctx, scope, suggestionProposal{lineID: job.LineID, kind: SuggestionKindGroup, targetKey: target, payload: raw})...)
	}
	return nil
}

// groupSuggestion turns a proposal's keys into lines; the target names the
// members whatever their order.
func groupSuggestion(p domain.GroupProposal, keys map[string]groupJobBranch) (GroupSuggestion, string) {
	out := GroupSuggestion{Title: p.Title, Members: []GroupSuggestionLine{}, Conflicts: []domain.Conflict{}}
	ids := []string{}
	for _, key := range p.Members {
		b := keys[key]
		out.Members = append(out.Members, GroupSuggestionLine(b))
		ids = append(ids, b.LineID)
	}
	for i, c := range p.Conflicts {
		out.Conflicts = append(out.Conflicts, domain.Conflict{
			ID: fmt.Sprintf("c%d", i+1), Branch: domain.ConflictSide{LineID: keys[c.Branch].LineID, Claim: c.BranchClaim},
			Other: domain.ConflictSide{LineID: keys[c.Other].LineID, Claim: c.OtherClaim},
		})
	}
	slices.Sort(ids)
	return out, "group:" + strings.Join(ids, ",")
}
