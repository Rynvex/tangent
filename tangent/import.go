package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// ImportInput is a conversation written elsewhere: its main line, the
// messages in order and first-level branches hanging on them (B18).
type ImportInput = domain.ImportInput

// ImportedLine is what an import wrote.
type ImportedLine = store.ImportedLine

// ImportLine writes an imported conversation as a new main line with its
// branches, in one transaction and without calling a model: the input is
// checked and cleaned first (domain.PlanImport; the title, provider and
// model like CreateLine's, the title taken from the first operator message
// when empty), each branch's pack is built from the imported messages up to
// its anchor like a new branch's, and the branches are open, discarded or
// merged as asked (origin import). Imported messages carry no usage or
// model. B19: the source's dates are kept (every line and message is
// otherwise dated at the import), chapter cuts are written as milestones,
// and a merged branch leaves its card on the main line right after its
// anchor, already delivered (with the leaf feature on, the card is also
// its confirmed leaf). No job is started and no feature hook runs: an
// import is history, not activity. B25: with BatchID the line joins that
// import batch of the tenant (created by the first import naming it; another
// tenant's is import_batch_not_found).
// Events after the commit: line.created for the main line, then for each
// branch line.created and branch.changed{created}, then leaf.changed for
// each leaf written and, with the chapters feature on and a cut written,
// chapters.changed.
// InTx hooks receive store.ImportedLine.
func (e *Engine) ImportLine(ctx context.Context, scope Scope, in ImportInput, opts ...TxOption) (ImportedLine, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return ImportedLine{}, err
	}
	modes := e.modesFor(ctx, scope)
	ctx = e.inbox(ctx, modes)
	plan, err := domain.PlanImport(in, e.limits, e.markers, e.now())
	if err != nil {
		return ImportedLine{}, err
	}
	batch, err := domain.PlanImportBatch(in.BatchID, in.BatchLabel)
	if err != nil {
		return ImportedLine{}, err
	}
	line, err := e.lineInput(LineInput{Title: plan.Title, Provider: in.Provider, Model: in.Model})
	if err != nil {
		return ImportedLine{}, err
	}
	out, err := e.store.ImportLine(ctx, store.ImportLineInput{
		Tenant: scope.Tenant, Title: line.Title, Provider: line.Provider, Model: line.Model, Folder: in.Folder, Tags: in.Tags,
		CreatedBy: scope.Actor, Plan: plan, Batch: batch, BuildPack: e.importPack, Leaves: modes.of(FeatureLeaf) != ModeOff,
	}, hooksOf(opts)...)
	if err != nil {
		return ImportedLine{}, err
	}
	e.publish(ctx, importEvents(scope, modes, out)...)
	return out, nil
}

// importEvents are the events of a committed import (ImportLine).
func importEvents(scope Scope, modes modeSet, out ImportedLine) []Event {
	events := []Event{lineEvent(EventLineCreated, out.Line)}
	for i, branch := range out.Branches {
		events = append(events, lineEvent(EventLineCreated, out.BranchLines[i]), branchEvent(scope.Tenant, BranchCreated, branch))
	}
	for i := range out.Leaves {
		events = append(events, leafEvent(scope, out.Leaves[i].LineID, out.Line.ID, &out.Leaves[i]))
	}
	if len(out.Cuts) > 0 && modes.of(FeatureChapters) != ModeOff {
		events = append(events, chaptersChanged(scope, out.Line.ID, out.Line.ID))
	}
	return events
}

// importPack is an imported branch's pack, built like a new branch's from
// the main line's messages up to its anchor (no summary: an import has
// none).
func (e *Engine) importPack(upToAnchor []domain.Message, branch domain.ImportPlanBranch) domain.BranchPack {
	anchor := upToAnchor[len(upToAnchor)-1]
	return domain.BuildBranchPack(domain.BranchPackInput{
		Purpose: branch.Purpose, Messages: upToAnchor, AnchorMessageID: anchor.ID, ExtraMarkers: e.markers, Limits: e.limits.Pack,
	})
}
