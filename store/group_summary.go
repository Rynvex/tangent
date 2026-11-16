package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// GroupSummaryClaim is a started summary: the group (drafting) and its job.
type GroupSummaryClaim struct {
	Group domain.Group
	Job   Job
}

// groupJobInput is what a group_summary job remembers.
type groupJobInput struct {
	GroupID string `json:"groupId"`
}

// StartGroupSummary records a group_summary job (of the feature) for an
// active group and makes it the group's current one (a job started before
// it no longer writes). Hooks receive the GroupSummaryClaim.
func (s *Store) StartGroupSummary(ctx context.Context, tenant, groupID, feature string, hooks ...TxHook) (GroupSummaryClaim, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (GroupSummaryClaim, error) {
		row, err := s.lockActiveGroup(ctx, q, tenant, groupID)
		if err != nil {
			return GroupSummaryClaim{}, err
		}
		input, _ := json.Marshal(groupJobInput{GroupID: row.ID.String()})
		job, err := s.createJob(ctx, q, CreateJobInput{Tenant: tenant, Kind: JobKindGroupSummary, Feature: feature, LineID: row.RootLineID.String(), Input: input})
		if err != nil {
			return GroupSummaryClaim{}, err
		}
		updated, err := q.SetGroupSummaryJob(ctx, db.SetGroupSummaryJobParams{ID: row.ID, JobID: uuid.NullUUID{UUID: job.ID, Valid: true}})
		if err != nil {
			return GroupSummaryClaim{}, fmt.Errorf("claim the summary: %w", err)
		}
		group, err := groupView(ctx, q, updated)
		return GroupSummaryClaim{Group: group, Job: jobFromRow(job)}, err
	})
}

// GroupMemberSource is a member as the summary job reads it.
type GroupMemberSource struct {
	LineID     string
	Purpose    string
	LeafKind   string
	Leaf       string
	Body       string
	Conclusion string
}

// GroupSummarySource is what a group's summary is written from.
type GroupSummarySource struct {
	Group   domain.Group
	Members []GroupMemberSource
	Settled []string
}

// GroupSummarySource reads a group's members (purpose, leaf, card
// conclusion) and the claims settled when it was made.
func (s *Store) GroupSummarySource(ctx context.Context, tenant, groupID string) (GroupSummarySource, error) {
	row, err := s.groupOfTenant(ctx, s.q, tenant, groupID, false)
	if err != nil {
		return GroupSummarySource{}, err
	}
	group, err := groupView(ctx, s.q, row)
	if err != nil {
		return GroupSummarySource{}, err
	}
	out := GroupSummarySource{Group: group, Members: []GroupMemberSource{}, Settled: []string{}}
	_ = json.Unmarshal(row.Settled, &out.Settled)
	for _, id := range group.MemberLineIDs {
		member, err := s.memberSource(ctx, id)
		if err != nil {
			return GroupSummarySource{}, err
		}
		out.Members = append(out.Members, member)
	}
	return out, nil
}

func (s *Store) memberSource(ctx context.Context, lineID string) (GroupMemberSource, error) {
	id, _ := parseID(lineID)
	row, _, err := branchRowFor(ctx, s.q, id)
	if err != nil {
		return GroupMemberSource{}, err
	}
	out := GroupMemberSource{LineID: lineID, Purpose: row.Purpose, Conclusion: row.ConclusionLine}
	leaf, err := s.q.GetLeaf(ctx, id)
	if err == nil {
		out.LeafKind, out.Leaf, out.Body = leaf.Kind, leaf.Line, leaf.Body
	} else if !noRows(err) {
		return GroupMemberSource{}, fmt.Errorf("get leaf: %w", err)
	}
	return out, nil
}

// GroupSummaryResult is a finished summary job: Written is false when the
// group started another summary since (or was dissolved).
type GroupSummaryResult struct {
	Group   domain.Group
	Job     Job
	Written bool
}

// FinishGroupSummary ends a group_summary job: done with the summary
// (ready), or failed with failure (the group's summary_status failed, its
// last summary kept), under the locks main line → group → job.
func (s *Store) FinishGroupSummary(ctx context.Context, jobID, summary, failure string, hooks ...TxHook) (GroupSummaryResult, error) {
	peek, err := s.GetJob(ctx, jobID)
	if err != nil {
		return GroupSummaryResult{}, err
	}
	var input groupJobInput
	_ = json.Unmarshal(peek.Input, &input)
	return runTx(ctx, s, hooks, func(q *db.Queries) (GroupSummaryResult, error) {
		group, err := s.groupOfTenant(ctx, q, peek.TenantID, input.GroupID, false)
		if err != nil {
			return GroupSummaryResult{}, err
		}
		root, err := lockRootOf(ctx, q, group.RootLineID)
		if err != nil {
			return GroupSummaryResult{}, err
		}
		if group, err = q.GetGroupForUpdate(ctx, group.ID); err != nil {
			return GroupSummaryResult{}, fmt.Errorf("lock group: %w", err)
		}
		if group.RootLineID != root.ID {
			return GroupSummaryResult{}, errBranchMoved
		}
		return s.finishGroupSummary(ctx, q, group, peek.ID, summary, failure)
	})
}

func (s *Store) finishGroupSummary(ctx context.Context, q *db.Queries, group db.TangentGroup, jobID, summary, failure string) (GroupSummaryResult, error) {
	job, err := lockJob(ctx, q, jobID)
	if err != nil {
		return GroupSummaryResult{}, err
	}
	status, jobStatus := domain.GroupSummaryReady, JobDone
	if failure != "" {
		status, summary, jobStatus = domain.GroupSummaryFailed, group.Summary, JobFailed
	}
	done, err := finishJob(ctx, q, job.ID, jobStatus, failure)
	if err != nil {
		return GroupSummaryResult{}, err
	}
	out := GroupSummaryResult{Job: jobFromRow(done)}
	updated, err := q.FinishGroupSummary(ctx, db.FinishGroupSummaryParams{
		ID: group.ID, JobID: uuid.NullUUID{UUID: job.ID, Valid: true}, Summary: summary, SummaryStatus: status,
	})
	switch {
	case noRows(err) || group.Status != domain.GroupActive:
		updated, out.Written = group, false
	case err != nil:
		return GroupSummaryResult{}, fmt.Errorf("write the summary: %w", err)
	default:
		out.Written = true
	}
	out.Group, err = groupView(ctx, q, updated)
	return out, err
}

// FailGroupSummaryOfJob marks the active group whose drafting summary this
// job was as failed (the job timed out); nil when no active group waits on
// it (a dissolved group is left as it was).
func (s *Store) FailGroupSummaryOfJob(ctx context.Context, jobID string) (*domain.Group, error) {
	id, ok := parseID(jobID)
	if !ok {
		return nil, nil
	}
	row, err := s.q.FailGroupSummaryOfJob(ctx, uuid.NullUUID{UUID: id, Valid: true})
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("fail the group summary: %w", err)
	}
	group, err := groupView(ctx, s.q, row)
	return &group, err
}
