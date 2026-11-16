package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// ImportLineInput writes a checked import (domain.PlanImport) as a new main
// line with its branches. Title, Provider and Model are final (checked by
// the caller); Folder and Tags are normalised here. BuildPack builds a
// branch's pack from the main line's messages up to its anchor (seq order,
// the anchor last; conclusion cards of earlier anchors included). Leaves,
// with the leaf feature on, writes each merged branch's card as its
// confirmed leaf.
type ImportLineInput struct {
	Tenant    string
	Title     string
	Provider  string
	Model     string
	Folder    string
	Tags      []string
	CreatedBy string
	Plan      domain.ImportPlan
	// Batch, when its ID is set, puts the line in that import batch (B25):
	// created for the tenant or reused, another tenant's is not found.
	Batch     domain.ImportBatchRef
	BuildPack func(upToAnchor []domain.Message, branch domain.ImportPlanBranch) domain.BranchPack
	Leaves    bool
}

// ImportedLine is what an import wrote: the main line, its branches (in the
// order given) with their lines, and how many imported messages the main
// line got (its conclusion cards not counted). Source is the import's
// source label (for a host that keeps it). Cuts are the chapter cuts and
// Leaves the leaves the import wrote (B19).
type ImportedLine struct {
	Line         domain.LineView
	Branches     []domain.BranchView
	BranchLines  []domain.LineView
	MessageCount int
	Source       string
	Cuts         []domain.ChapterCut
	Leaves       []domain.Leaf
}

// ImportLine writes an import in one transaction: the main line, its
// messages (finished chat messages, in order; a merged branch's conclusion
// card right after its anchor, before the next one), then each branch like
// CreateBranch would open it on its anchor (the limits checked against what
// the transaction wrote so far; origin import) with its messages, discarded
// or merged at once when asked, then the chapter cuts. A plan with dates
// writes every message, line and branch with them (B19); without, they are
// the time of the import. Nothing else of the tenant is locked: the lines
// are new (an import batch row is, B25, until the commit).
func (s *Store) ImportLine(ctx context.Context, in ImportLineInput, hooks ...TxHook) (ImportedLine, error) {
	tenant := strings.TrimSpace(in.Tenant)
	if tenant == "" {
		return ImportedLine{}, invalidInput("tenant is required")
	}
	org, err := domain.NormalizeOrganization(&in.Folder, &in.Tags)
	if err != nil {
		return ImportedLine{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (ImportedLine, error) {
		if err := upsertImportBatch(ctx, q, tenant, in); err != nil {
			return ImportedLine{}, err
		}
		main, err := insertImportedLine(ctx, q, tenant, in, org)
		if err != nil {
			return ImportedLine{}, err
		}
		branchIDs := make([]uuid.UUID, 0, len(in.Plan.Branches))
		for range in.Plan.Branches {
			branchIDs = append(branchIDs, uuid.New())
		}
		written, err := insertImportedMain(ctx, q, main, in.Plan, branchIDs)
		if err != nil {
			return ImportedLine{}, err
		}
		out := ImportedLine{
			MessageCount: len(in.Plan.Messages), Source: in.Plan.Source, Branches: []domain.BranchView{}, BranchLines: []domain.LineView{},
			Cuts: []domain.ChapterCut{}, Leaves: []domain.Leaf{},
		}
		if out, err = s.importBranches(ctx, q, main, written, branchIDs, in, out); err != nil {
			return ImportedLine{}, err
		}
		if out.Cuts, err = s.importCuts(ctx, q, main, written, in); err != nil {
			return ImportedLine{}, err
		}
		if err := dateImportedLine(ctx, q, main.ID, in.Plan.Dates); err != nil {
			return ImportedLine{}, err
		}
		if err := markImportedLine(ctx, q, main.ID, in.Batch); err != nil {
			return ImportedLine{}, err
		}
		if out.Line, err = s.lineViewOf(ctx, q, main.ID); err != nil {
			return ImportedLine{}, err
		}
		return out, nil
	})
}

// insertImportedLine inserts the imported main line.
func insertImportedLine(ctx context.Context, q *db.Queries, tenant string, in ImportLineInput, org domain.LineOrganization) (db.TangentLine, error) {
	main, err := q.InsertLine(ctx, db.InsertLineParams{
		ID: uuid.New(), TenantID: tenant, Title: in.Title, Provider: in.Provider, Model: in.Model,
		HostMeta: []byte("{}"), CreatedBy: strings.TrimSpace(in.CreatedBy), Folder: org.Folder, Tags: org.Tags,
	})
	if err != nil {
		return db.TangentLine{}, fmt.Errorf("insert the imported line: %w", err)
	}
	return main, nil
}

// importBranches opens the plan's branches on the imported main line in
// plan order and returns out with their branches, lines and leaves.
func (s *Store) importBranches(ctx context.Context, q *db.Queries, main db.TangentLine, written imported, branchIDs []uuid.UUID, in ImportLineInput, out ImportedLine) (ImportedLine, error) {
	parent := lockedParent{line: main, rootID: main.ID}
	for k, branch := range in.Plan.Branches {
		created, leaf, err := s.importBranch(ctx, q, parent, written, importedBranch{plan: branch, id: branchIDs[k], card: written.cards[k]}, in)
		if err != nil {
			return ImportedLine{}, err
		}
		out.Branches, out.BranchLines = append(out.Branches, created.Branch), append(out.BranchLines, created.Line)
		if leaf != nil {
			out.Leaves = append(out.Leaves, *leaf)
		}
	}
	return out, nil
}

// importedBranch is one branch of the plan with the id chosen for its line
// and, when merged, the card written for it on the main line.
type importedBranch struct {
	plan domain.ImportPlanBranch
	id   uuid.UUID
	card db.TangentMessage
}

// importBranch opens one imported branch on its anchor, writes its
// messages, closes it as asked and dates it; it returns the leaf a merged
// branch's card wrote (nil without one).
func (s *Store) importBranch(ctx context.Context, q *db.Queries, parent lockedParent, written imported, branch importedBranch, in ImportLineInput) (CreatedBranch, *domain.Leaf, error) {
	depth, err := s.checkBranchLimits(ctx, q, parent, false)
	if err != nil {
		return CreatedBranch{}, nil, err
	}
	anchor := written.at[branch.plan.AnchorIndex]
	var pack domain.BranchPack
	if in.BuildPack != nil {
		pack = in.BuildPack(messagesFromRows(written.rows[:anchor+1]), branch.plan)
	}
	created, err := s.insertBranchAs(ctx, q, parent, written.rows[anchor], depth, CreateBranchInput{
		Tenant: parent.line.TenantID, ParentLineID: parent.line.ID.String(), Purpose: branch.plan.Purpose, Kind: branch.plan.Kind,
		Origin: domain.BranchOriginImport, CreatedBy: in.CreatedBy, Pack: pack,
	}, branch.id)
	if err != nil {
		return CreatedBranch{}, nil, err
	}
	if _, err := insertImported(ctx, q, created, branch.plan.Messages); err != nil {
		return CreatedBranch{}, nil, err
	}
	leaf, err := s.closeImported(ctx, q, created.ID, branch, in)
	if err != nil {
		return CreatedBranch{}, nil, err
	}
	if err := dateImportedBranch(ctx, q, created.ID, branch.plan.Dates); err != nil {
		return CreatedBranch{}, nil, err
	}
	view, err := s.createdBranch(ctx, q, created)
	return view, leaf, err
}

// imported is the main line's messages as an import wrote them: rows in
// seq order (conclusion cards included), at[i] the row of the plan's
// message i and cards the card written for each merged branch (by its
// index in the plan).
type imported struct {
	rows  []db.TangentMessage
	at    []int
	cards map[int]db.TangentMessage
}

// insertImportedMain writes the main line's messages in order, each merged
// branch's conclusion card right after its anchor (in the order the
// branches are given), naming the branch line by its chosen id.
func insertImportedMain(ctx context.Context, q *db.Queries, main db.TangentLine, plan domain.ImportPlan, branchIDs []uuid.UUID) (imported, error) {
	out := imported{rows: make([]db.TangentMessage, 0, len(plan.Messages)), at: make([]int, 0, len(plan.Messages)), cards: map[int]db.TangentMessage{}}
	meta, err := json.Marshal(domain.MessageMeta{})
	if err != nil {
		return imported{}, fmt.Errorf("marshal message meta: %w", err)
	}
	// merged lists the merged branches of each anchor, in the order given.
	merged := map[int][]int{}
	for k, branch := range plan.Branches {
		if branch.Card != nil {
			merged[branch.AnchorIndex] = append(merged[branch.AnchorIndex], k)
		}
	}
	for i, message := range plan.Messages {
		row, err := insertImportedMessage(ctx, q, main, message, meta)
		if err != nil {
			return imported{}, err
		}
		out.at, out.rows = append(out.at, len(out.rows)), append(out.rows, row)
		for _, k := range merged[i] {
			card, err := insertImportedCard(ctx, q, main, row, plan.Branches[k], branchIDs[k])
			if err != nil {
				return imported{}, err
			}
			out.rows, out.cards[k] = append(out.rows, card), card
		}
	}
	return out, nil
}

// insertImported writes imported messages on a line in order, as finished
// chat messages with no usage, model or other meta.
func insertImported(ctx context.Context, q *db.Queries, line db.TangentLine, messages []domain.ImportMessage) ([]db.TangentMessage, error) {
	out := make([]db.TangentMessage, 0, len(messages))
	meta, err := json.Marshal(domain.MessageMeta{})
	if err != nil {
		return nil, fmt.Errorf("marshal message meta: %w", err)
	}
	for _, message := range messages {
		row, err := insertImportedMessage(ctx, q, line, message, meta)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, nil
}

// insertImportedMessage writes one imported message, at its date when it
// has one.
func insertImportedMessage(ctx context.Context, q *db.Queries, line db.TangentLine, message domain.ImportMessage, meta []byte) (db.TangentMessage, error) {
	var (
		row db.TangentMessage
		err error
	)
	if message.CreatedAt != nil {
		row, err = q.InsertMessageAt(ctx, db.InsertMessageAtParams{
			LineID: line.ID, TenantID: line.TenantID, Role: message.Role, Kind: domain.MessageKindChat, Content: message.Content,
			Status: domain.MessageDone, Meta: meta, HostMeta: []byte("{}"), CreatedAt: *message.CreatedAt,
		})
	} else {
		row, err = q.InsertMessage(ctx, db.InsertMessageParams{
			LineID: line.ID, TenantID: line.TenantID, Role: message.Role, Kind: domain.MessageKindChat, Content: message.Content,
			Status: domain.MessageDone, Meta: meta, HostMeta: []byte("{}"),
		})
	}
	if err != nil {
		return db.TangentMessage{}, fmt.Errorf("insert an imported message: %w", err)
	}
	return row, nil
}
