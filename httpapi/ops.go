package httpapi

import (
	"encoding/json"

	"github.com/Rynvex/tangent/tangent"
)

// Ops name the API's writes for Config.TxOptions and Config.HostMeta. They
// are stable: a host may switch on them. docs/API.md lists the route and
// the Engine method of each (its InTx result type is in docs/EMBEDDING.md
// §4.4).
const (
	OpLinesCreate        = "lines.create"
	OpLinesUpdate        = "lines.update"
	OpLinesDelete        = "lines.delete"
	OpLinesArchive       = "lines.archive"
	OpLinesUnarchive     = "lines.unarchive"
	OpLinesRead          = "lines.read"
	OpTurnsSend          = "turns.send"
	OpTurnsRetry         = "turns.retry"
	OpTurnsCancel        = "turns.cancel"
	OpSummaryCompact     = "summary.compact"
	OpBranchesCreate     = "branches.create"
	OpBranchesMove       = "branches.move"
	OpBranchesRename     = "branches.rename"
	OpBranchesDraft      = "branches.draft"
	OpBranchesMerge      = "branches.merge"
	OpBranchesDiscard    = "branches.discard"
	OpBranchesPromote    = "branches.promote"
	OpBranchesCombine    = "branches.combine"
	OpNotesCreate        = "notes.create"
	OpNotesUpdate        = "notes.update"
	OpNotesSupersede     = "notes.supersede"
	OpMilestonesAdd      = "milestones.add"
	OpMilestonesDelete   = "milestones.delete"
	OpSuggestionsAccept  = "suggestions.accept"
	OpSuggestionsDismiss = "suggestions.dismiss"
	OpLeafPut            = "leaf.put"
	OpLeafDelete         = "leaf.delete"
	OpLeafDraft          = "leaf.draft"
	OpSeedsCreate        = "seeds.create"
	OpSeedsExpand        = "seeds.expand"
	OpSeedsToNote        = "seeds.to_note"
	OpSeedsDrop          = "seeds.drop"
	OpSeedsBatch         = "seeds.batch"
	OpSpinoffCreate      = "spinoff.create"
	OpGoalPut            = "goal.put"
	OpGoalDelete         = "goal.delete"
	OpGoalPropose        = "goal.propose"
	OpRelationsCreate    = "relations.create"
	OpRelationsUpdate    = "relations.update"
	OpRelationsDelete    = "relations.delete"
	OpMessagesPin        = "messages.pin"
	OpMessagesUnpin      = "messages.unpin"
	OpGroupsCreate       = "groups.create"
	OpGroupsRename       = "groups.rename"
	OpGroupsDissolve     = "groups.dissolve"
	OpGroupsSummarize    = "groups.summarize"
	OpMessagesTag        = "messages.tag"
	OpMessagesUntag      = "messages.untag"
	OpFoldsCreate        = "folds.create"
	OpFoldsUpdate        = "folds.update"
	OpFoldsDelete        = "folds.delete"
	OpDivergeStart       = "diverge.start"
	OpDivergeModels      = "diverge.models"
	OpComparisonsCreate  = "comparisons.create"
	OpComparisonsDecide  = "comparisons.decide"
	OpMemoriesCreate     = "memories.create"
	OpMemoriesUpdate     = "memories.update"
	OpMemoriesSupersede  = "memories.supersede"
	OpMemosCreate        = "memos.create"
	OpMemosUpdate        = "memos.update"
	OpMemosDelete        = "memos.delete"
)

// The B17 ops: editing a merged branch's card, dismissing a whole inbox.
const (
	OpBranchesUpdateCard    = "branches.update_card"
	OpSuggestionsDismissAll = "suggestions.dismiss_all"
)

// The B18 ops: importing a conversation, renaming a folder, extracting a
// stretch of a line into a branch.
const (
	OpLinesImport       = "lines.import"
	OpLinesRenameFolder = "lines.rename_folder"
	OpBranchesExtract   = "branches.extract"
)

// The B20 op: attaching another conversation as a branch.
const OpLinesAttach = "lines.attach"

// The B23 ops: keeping an aside, continuing one as a branch, deleting an
// ended branch.
const (
	OpBranchesKeep     = "branches.keep"
	OpBranchesContinue = "branches.continue"
	OpBranchesDelete   = "branches.delete"
)

// The B24 ops: the glossary.
const (
	OpTermsCreate = "terms.create"
	OpTermsUpdate = "terms.update"
	OpTermsDelete = "terms.delete"
)

// OpImportsDelete is the B25 op: undoing an import batch (DELETE
// /imports/{bid}, Engine.DeleteImportBatch).
const OpImportsDelete = "imports.delete"

// tx is what the host adds to this call's write (Config.TxOptions); nil
// without the callback or on a read route.
func (c *call) tx() []tangent.TxOption {
	if c.a.txOptions == nil || c.op == "" {
		return nil
	}
	_, _ = c.rawBody() // after a read error the callback sees the bytes read so far
	return c.a.txOptions(c.r, c.op)
}

// hostMeta is the host_meta the host writes with this call's write
// (Config.HostMeta); nil without the callback. Its error refuses the write:
// a *domain.Error is answered with its code, anything else is a 500.
func (c *call) hostMeta() (json.RawMessage, error) {
	if c.a.hostMetaFor == nil || c.op == "" {
		return nil, nil
	}
	_, _ = c.rawBody() // after a read error the callback sees the bytes read so far
	return c.a.hostMetaFor(c.r, c.op)
}
