package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// The B18 routes (all core): importing a conversation, renaming a folder,
// extracting any stretch of a line into a branch and the decompose plan.
// B18.1 adds the tenant's folders and tags (GET /lines/organization), B20
// attaching another conversation as a branch (attach.go), B22 the import
// analysis (import_analyze.go).
// /lines/import, /lines/import-analyze, /lines/folders/rename and
// /lines/organization have no {id}
// (a literal segment wins over {id} in ServeMux), and a line id is always a
// UUID, so they never meet the /lines/{id} patterns.

func (a *api) b18Routes() []route {
	return []route{
		{pattern: "POST /lines/import", write: true, op: OpLinesImport, bigBody: true, serve: a.importLine},
		{pattern: "POST /lines/folders/rename", write: true, op: OpLinesRenameFolder, serve: a.renameFolder},
		{pattern: "POST /lines/{id}/branches/extract", write: true, op: OpBranchesExtract, serve: a.extractToBranch},
		{pattern: "GET /lines/{id}/decompose", serve: a.decompose},
		{pattern: "GET /lines/organization", serve: a.lineOrganization},
		{pattern: "POST /lines/{id}/attach", write: true, op: OpLinesAttach, serve: a.attachLine},
		// B22: a read (nothing is written), so no Op (import_analyze.go).
		{pattern: "POST /lines/import-analyze", bigBody: true, serve: a.analyzeImport},
	}
}

// importBody is POST /lines/import. createdAt, the messages' and the
// branches' (with card and chapterCuts, B19) are read by importInput.
type importBody struct {
	Title       string                    `json:"title"`
	Provider    string                    `json:"provider"`
	Model       string                    `json:"model"`
	Folder      string                    `json:"folder"`
	Tags        []string                  `json:"tags"`
	Source      string                    `json:"source"`
	CreatedAt   json.RawMessage           `json:"createdAt"`
	Messages    []importMessageBody       `json:"messages"`
	Branches    []importBranchBody        `json:"branches"`
	ChapterCuts []domain.ImportChapterCut `json:"chapterCuts"`
	HostMeta    json.RawMessage           `json:"hostMeta"`
	// BatchID and BatchLabel (B25) put the line in an import batch.
	BatchID    string `json:"batchId"`
	BatchLabel string `json:"batchLabel"`
}

// importedLine is the answer of an import: the new main line, its branches
// in the order given and how many messages the main line got.
type importedLine struct {
	Line         domain.LineView     `json:"line"`
	Branches     []domain.BranchView `json:"branches"`
	MessageCount int                 `json:"messageCount"`
}

func (a *api) importLine(c *call) (int, any, error) {
	var in importBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	if hasHostMeta(in.HostMeta) {
		return 0, nil, errHostMeta
	}
	input, err := in.importInput()
	if err != nil {
		return 0, nil, err
	}
	imported, err := a.engine.ImportLine(c.ctx, c.scope, input, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, importedLine{Line: imported.Line, Branches: list(imported.Branches), MessageCount: imported.MessageCount}, nil
}

// renameFolderBody is POST /lines/folders/rename: to "" unfiles the lines.
type renameFolderBody struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// renamedFolder is the answer of a folder rename.
type renamedFolder struct {
	Updated int `json:"updated"`
}

func (a *api) renameFolder(c *call) (int, any, error) {
	var in renameFolderBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	renamed, err := a.engine.RenameFolder(c.ctx, c.scope, in.From, in.To, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, renamedFolder{Updated: len(renamed.LineIDs)}, nil
}

// extractBody is POST /lines/{id}/branches/extract. card, when present
// (and not null), is decoded as strictly as a merge's.
type extractBody struct {
	FromMessageID string          `json:"fromMessageId"`
	ToMessageID   string          `json:"toMessageId"`
	Purpose       string          `json:"purpose"`
	Kind          string          `json:"kind"`
	Provider      string          `json:"provider"`
	Model         string          `json:"model"`
	ConfirmDeeper bool            `json:"confirmDeeper"`
	Card          json.RawMessage `json:"card"`
	HostMeta      json.RawMessage `json:"hostMeta"`
}

// extractedBranch is the answer of an extract: movedBranch's fields; marker
// is the branch_marker, or with a card the branch_card.
type extractedBranch struct {
	Line            domain.LineView   `json:"line"`
	Branch          domain.BranchView `json:"branch"`
	Marker          domain.Message    `json:"marker"`
	SourceLineID    string            `json:"sourceLineId"`
	RootLineID      string            `json:"rootLineId"`
	MovedMessageIDs []string          `json:"movedMessageIds"`
	Reparented      []string          `json:"reparented"`
	SummaryReset    bool              `json:"summaryReset"`
}

func (a *api) extractToBranch(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in extractBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	if hasHostMeta(in.HostMeta) {
		return 0, nil, errHostMeta
	}
	input := tangent.ExtractInput{
		FromMessageID: in.FromMessageID, ToMessageID: in.ToMessageID, Purpose: in.Purpose, Kind: in.Kind,
		Provider: in.Provider, Model: in.Model, ConfirmDeeper: in.ConfirmDeeper,
	}
	if present(in.Card) {
		card, err := domain.DecodeBranchCardJSON(in.Card)
		if err != nil {
			return 0, nil, domain.CardError([]domain.BranchCardProblem{{Field: "card", Message: err.Error()}})
		}
		input.Card = &card
	}
	extracted, err := a.engine.ExtractToBranch(c.ctx, c.scope, id, input, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, extractedBranch{
		Line: extracted.Line, Branch: extracted.Branch, Marker: extracted.Marker, SourceLineID: extracted.SourceLineID,
		RootLineID: extracted.RootLineID, MovedMessageIDs: list(extracted.MovedMessageIDs), Reparented: list(extracted.Reparented),
		SummaryReset: extracted.SummaryReset,
	}, nil
}

func (a *api) decompose(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	plan, err := a.engine.Decompose(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, plan, nil
}

func (a *api) lineOrganization(c *call) (int, any, error) {
	organization, err := a.engine.TenantOrganization(c.ctx, c.scope)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, domain.TenantOrganization{Folders: list(organization.Folders), Tags: list(organization.Tags)}, nil
}
