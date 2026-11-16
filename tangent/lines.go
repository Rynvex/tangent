package tangent

import (
	"context"
	"encoding/json"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// LineInput is a new main line. ID may be chosen by the host (the host
// uses its session id); empty means a random id. Folder and Tags organise
// it in the list (B18; normalised, domain.NormalizeFolder and
// domain.NormalizeTags).
type LineInput struct {
	ID       string
	Title    string
	Provider string
	Model    string
	HostMeta json.RawMessage
	Folder   string
	Tags     []string
}

// LineQuery selects one page of main lines.
type LineQuery = store.ListLinesInput

// LinePage is one page of main lines, newest activity first.
type LinePage = store.LinePage

// LinePatch edits a line; nil fields stay as they are.
type LinePatch = store.LinePatch

// DeletedTree is what DeleteTree removed, with the host data of every line
// and message so the host can clean up what it keeps elsewhere.
type DeletedTree = store.DeletedTree

// CreateLine starts a new conversation (a main line).
// InTx hooks receive domain.LineView.
func (e *Engine) CreateLine(ctx context.Context, scope Scope, in LineInput, opts ...TxOption) (domain.LineView, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return domain.LineView{}, err
	}
	ctx = e.inboxFor(ctx, scope)
	if in, err = e.lineInput(in); err != nil {
		return domain.LineView{}, err
	}
	line, err := e.store.CreateLine(ctx, store.CreateLineInput{
		ID: in.ID, Tenant: scope.Tenant, Title: in.Title, Provider: in.Provider, Model: in.Model,
		CreatedBy: scope.Actor, HostMeta: in.HostMeta, Folder: in.Folder, Tags: in.Tags,
	}, hooksOf(opts)...)
	if err != nil {
		return domain.LineView{}, err
	}
	e.publish(ctx, lineEvent(EventLineCreated, line))
	return line, nil
}

// GetLine reads one line with its place in the tree.
func (e *Engine) GetLine(ctx context.Context, scope Scope, lineID string) (domain.LineView, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return domain.LineView{}, err
	}
	ctx = e.inboxFor(ctx, scope)
	return e.store.GetLine(ctx, scope.Tenant, lineID)
}

// ListLines returns one page of the tenant's main lines; q.Tenant is
// replaced by the scope's.
func (e *Engine) ListLines(ctx context.Context, scope Scope, q LineQuery) (LinePage, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return LinePage{}, err
	}
	ctx = e.inboxFor(ctx, scope)
	q.Tenant = scope.Tenant
	return e.store.ListLines(ctx, q)
}

// ListMessages returns a transcript page after a seq cursor, oldest first.
func (e *Engine) ListMessages(ctx context.Context, scope Scope, lineID string, afterSeq int64, limit int) ([]domain.Message, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return nil, err
	}
	return e.store.ListMessages(ctx, scope.Tenant, lineID, afterSeq, limit)
}

// UpdateLine edits the title, provider, model or host data of a line, the
// folder and tags of a main line (B18) and its pin (B25; not activity).
// InTx hooks receive domain.LineView.
func (e *Engine) UpdateLine(ctx context.Context, scope Scope, lineID string, patch LinePatch, opts ...TxOption) (domain.LineView, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return domain.LineView{}, err
	}
	ctx = e.inboxFor(ctx, scope)
	if err := e.linePatch(ctx, scope, lineID, patch); err != nil {
		return domain.LineView{}, err
	}
	line, err := e.store.UpdateLine(ctx, scope.Tenant, lineID, patch, hooksOf(opts)...)
	if err != nil {
		return domain.LineView{}, err
	}
	e.publish(ctx, lineEvent(EventLineUpdated, line))
	return line, nil
}

// MarkRead clears the line's unread counter; the lines above a branch are
// republished too (their unread totals changed).
// InTx hooks receive domain.LineView.
func (e *Engine) MarkRead(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (domain.LineView, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return domain.LineView{}, err
	}
	ctx = e.inboxFor(ctx, scope)
	line, err := e.store.MarkRead(ctx, scope.Tenant, lineID, hooksOf(opts)...)
	if err != nil {
		return domain.LineView{}, err
	}
	e.publish(ctx, append([]Event{lineEvent(EventLineUpdated, line)}, e.ancestorEvents(ctx, scope, line)...)...)
	return line, nil
}

// ancestorEvents re-reads the lines above a branch (their unread totals
// include it), nearest first, at most HardMaxDepth of them.
func (e *Engine) ancestorEvents(ctx context.Context, scope Scope, line domain.LineView) []Event {
	events := []Event{}
	for range e.limits.Branch.HardMaxDepth {
		if line.ConversationBranch == nil {
			break
		}
		parent, err := e.store.GetLine(ctx, scope.Tenant, line.ConversationBranch.ParentLineID)
		if err != nil {
			e.log.Warn("tangent: reload of an ancestor failed", "line", line.ID, "error", err)
			break
		}
		events = append(events, lineEvent(EventLineUpdated, parent))
		line = parent
	}
	return events
}

// ArchiveTree archives (or unarchives) a whole conversation; the main line
// comes first in the result.
// InTx hooks receive []domain.LineView.
func (e *Engine) ArchiveTree(ctx context.Context, scope Scope, lineID string, archived bool, opts ...TxOption) ([]domain.LineView, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return nil, err
	}
	ctx = e.inboxFor(ctx, scope)
	lines, err := e.store.ArchiveTree(ctx, scope.Tenant, lineID, archived, hooksOf(opts)...)
	if err != nil {
		return nil, err
	}
	events := make([]Event, 0, len(lines))
	for _, line := range lines {
		events = append(events, lineEvent(EventLineUpdated, line))
	}
	e.publish(ctx, events...)
	return lines, nil
}

// DeleteTree removes a whole conversation (main line only). Hooks run
// before the rows go, so they can still read them. The runs of jobs that
// went with it are stopped (no turn can be pending: a tree that is
// answering is not deleted).
// InTx hooks receive store.DeletedTree (before the rows go).
func (e *Engine) DeleteTree(ctx context.Context, scope Scope, lineID string, opts ...TxOption) (DeletedTree, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return DeletedTree{}, err
	}
	deleted, err := e.store.DeleteTree(ctx, scope.Tenant, lineID, hooksOf(opts)...)
	if err != nil {
		return DeletedTree{}, err
	}
	e.treeDeleted(ctx, scope, deleted)
	return deleted, nil
}

// treeDeleted follows a committed tree delete: the runs of the jobs that
// went with it stop and line.deleted is published.
func (e *Engine) treeDeleted(ctx context.Context, scope Scope, deleted DeletedTree) {
	e.forgetLines(scope.Tenant, deleted.LineIDs, deleted.PendingJobIDs)
	e.publish(ctx, Event{
		Type: EventLineDeleted, Tenant: scope.Tenant, RootLineID: deleted.RootLineID, LineID: deleted.RootLineID,
		Data: LinesDeleted{RootLineID: deleted.RootLineID, LineIDs: deleted.LineIDs},
	})
}

// TenantOrganization returns the tenant's folders (active and archived main
// lines counted apart) and the tags of its unarchived main lines with their
// counts (B18.1), over every main line rather than one page of ListLines.
// Read-only.
func (e *Engine) TenantOrganization(ctx context.Context, scope Scope) (domain.TenantOrganization, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return domain.TenantOrganization{}, err
	}
	return e.store.TenantOrganization(ctx, scope.Tenant)
}

// RenamedFolder is what a folder rename changed.
type RenamedFolder = store.RenamedFolder

// RenameFolder moves every main line of the tenant in folder from (archived
// ones too) to folder to; an empty to unfiles them (B18). It does not count
// as activity. Each moved line gets a line.updated event.
// InTx hooks receive store.RenamedFolder.
func (e *Engine) RenameFolder(ctx context.Context, scope Scope, from, to string, opts ...TxOption) (RenamedFolder, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return RenamedFolder{}, err
	}
	ctx = e.inboxFor(ctx, scope)
	renamed, err := e.store.RenameFolder(ctx, scope.Tenant, from, to, hooksOf(opts)...)
	if err != nil {
		return RenamedFolder{}, err
	}
	e.publish(ctx, e.lineViewEvents(ctx, scope, EventLineUpdated, renamed.LineIDs)...)
	return renamed, nil
}

// lineViewEvents re-reads many lines after a commit (one query) and returns
// their line events; a failed read is logged and publishes nothing.
func (e *Engine) lineViewEvents(ctx context.Context, scope Scope, kind string, lineIDs []string) []Event {
	if len(lineIDs) == 0 {
		return nil
	}
	views, err := e.store.LineViews(ctx, scope.Tenant, lineIDs)
	if err != nil {
		e.log.Warn("tangent: reload of changed lines failed", "lines", len(lineIDs), "error", err)
		return nil
	}
	events := make([]Event, 0, len(views))
	for _, view := range views {
		events = append(events, lineEvent(kind, view))
	}
	return events
}
