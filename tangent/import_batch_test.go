package tangent_test

import (
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// Import batches (B25): the imports of one client action share a batch id,
// so they can be listed and undone later.

// batchImport is a two-message conversation imported in batch id.
func batchImport(title, batchID, label string) tangent.ImportInput {
	return tangent.ImportInput{
		Title: title, BatchID: batchID, BatchLabel: label,
		Messages: []domain.ImportMessage{{Role: "user", Content: "question about " + title}, {Role: "assistant", Content: "answer about " + title}},
	}
}

func (e *env) importIn(scope tangent.Scope, in tangent.ImportInput) tangent.ImportedLine {
	e.t.Helper()
	out, err := e.engine.ImportLine(e.ctx, scope, in)
	if err != nil {
		e.t.Fatal(err)
	}
	return out
}

// batches lists the scope's batches (one page).
func (e *env) batches(scope tangent.Scope) []domain.ImportBatch {
	e.t.Helper()
	page, err := e.engine.ImportBatches(e.ctx, scope, tangent.ImportBatchQuery{})
	if err != nil {
		e.t.Fatal(err)
	}
	return page.Batches
}

func TestImportBatch_IsCreatedThenReused(t *testing.T) {
	e := newEnvWith(t, b18Features())
	id := uuid.NewString()
	first := e.importIn(scopeA, batchImport("one", id, "  chats.json\n"))
	if first.Line.ImportBatchID != id {
		t.Fatalf("the line names its batch: %q", first.Line.ImportBatchID)
	}
	second := e.importIn(scopeA, batchImport("two", id, "other label"))
	plain := e.importIn(scopeA, batchImport("three", "", ""))
	if second.Line.ImportBatchID != id || plain.Line.ImportBatchID != "" {
		t.Fatalf("batch ids %q %q", second.Line.ImportBatchID, plain.Line.ImportBatchID)
	}
	got := e.batches(scopeA)
	if len(got) != 1 || got[0].ID != id || got[0].Label != "chats.json" || got[0].LineCount != 2 || got[0].StandaloneCount != 2 || got[0].CreatedAt.IsZero() {
		t.Fatalf("one batch, its first label, two lines: %+v", got)
	}
	if e.count(`SELECT count(*) FROM tangent_import_batch`) != 1 {
		t.Fatal("the batch row is written once")
	}
}

func TestImportBatch_RefusesBadInputAndOtherTenantsBatches(t *testing.T) {
	e := newEnvWith(t, b18Features())
	id := uuid.NewString()
	e.importIn(scopeA, batchImport("one", id, ""))
	_, err := e.engine.ImportLine(e.ctx, scopeB, batchImport("theirs", id, ""))
	wantCode(t, err, domain.CodeImportBatchNotFound)
	if n := e.count(`SELECT count(*) FROM tangent_line WHERE tenant_id = $1`, scopeB.Tenant); n != 0 {
		t.Fatalf("a refused import writes nothing: %d lines", n)
	}
	if got := e.batches(scopeB); len(got) != 0 {
		t.Fatalf("tenant B sees no batch: %+v", got)
	}
	_, err = e.engine.DeleteImportBatch(e.ctx, scopeB, id, true)
	wantCode(t, err, domain.CodeImportBatchNotFound)
	_, err = e.engine.DeleteImportBatch(e.ctx, scopeA, "not-a-uuid", false)
	wantCode(t, err, domain.CodeImportBatchNotFound)
	for name, in := range map[string]tangent.ImportInput{
		"not a uuid":         batchImport("x", "batch-1", ""),
		"the nil uuid":       batchImport("x", uuid.Nil.String(), ""),
		"a label without id": batchImport("x", "", "file.json"),
		"a long label":       batchImport("x", uuid.NewString(), strings.Repeat("長", domain.ImportBatchLabelMaxRunes+1)),
	} {
		_, err := e.engine.ImportLine(e.ctx, scopeA, in)
		if domain.CodeOf(err) != domain.CodeInvalidInput {
			t.Errorf("%s: err = %v, want invalid_input", name, err)
		}
	}
}

func TestImportBatch_ConcurrentImportsOfANewBatchAllLand(t *testing.T) {
	e := newEnvWith(t, b18Features())
	id := uuid.NewString()
	const imports = 8
	var wg sync.WaitGroup
	errs := make(chan error, imports)
	for i := range imports {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := e.engine.ImportLine(e.ctx, scopeA, batchImport("parallel "+string(rune('a'+i)), id, "batch"))
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("a concurrent import of a new batch failed: %v", err)
		}
	}
	if got := e.batches(scopeA); len(got) != 1 || got[0].LineCount != imports {
		t.Fatalf("one batch with every line: %+v", got)
	}
}

func TestImportBatch_ListPagesNewestFirst(t *testing.T) {
	e := newEnvWith(t, b18Features())
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	for i, id := range ids {
		e.importIn(scopeA, batchImport("b", id, ""))
		e.exec(`UPDATE tangent_import_batch SET created_at = $2 WHERE id = $1`, id, time.Date(2026, 1, 1+i, 0, 0, 0, 0, time.UTC))
	}
	page, err := e.engine.ImportBatches(e.ctx, scopeA, tangent.ImportBatchQuery{Limit: 2})
	if err != nil || len(page.Batches) != 2 || page.Batches[0].ID != ids[2] || page.Batches[1].ID != ids[1] || page.NextCursor == "" {
		t.Fatalf("first page: %+v %v", page, err)
	}
	rest, err := e.engine.ImportBatches(e.ctx, scopeA, tangent.ImportBatchQuery{Limit: 2, Cursor: page.NextCursor})
	if err != nil || len(rest.Batches) != 1 || rest.Batches[0].ID != ids[0] || rest.NextCursor != "" {
		t.Fatalf("last page: %+v %v", rest, err)
	}
	_, err = e.engine.ImportBatches(e.ctx, scopeA, tangent.ImportBatchQuery{Cursor: "nope"})
	wantCode(t, err, domain.CodeInvalidInput)
}

func TestImportBatch_AttachedLinesCountButAreNotStandalone(t *testing.T) {
	e := newEnvWith(t, b18Features())
	id := uuid.NewString()
	source := e.importIn(scopeA, batchImport("source", id, ""))
	e.importIn(scopeA, batchImport("other", id, ""))
	target := e.mainLine()
	e.exchange(target.ID, "hello", "hi")
	attached, err := e.engine.AttachLine(e.ctx, scopeA, target.ID, tangent.AttachInput{SourceLineID: source.Line.ID})
	if err != nil {
		t.Fatal(err)
	}
	if attached.BranchLine.ImportBatchID != id {
		t.Fatalf("an attached line keeps its batch: %+v", attached.BranchLine.Line)
	}
	if got := e.batches(scopeA); len(got) != 1 || got[0].LineCount != 2 || got[0].StandaloneCount != 1 {
		t.Fatalf("attached: counted, not standalone: %+v", got)
	}
}

func TestImportBatch_DeleteRemovesTheUntouchedTrees(t *testing.T) {
	e := newEnvWith(t, b18Features())
	id := uuid.NewString()
	dated := datedImport(time.Date(2024, time.May, 1, 9, 0, 0, 0, time.UTC))
	dated.BatchID = id
	first := e.importIn(scopeA, dated)
	second := e.importIn(scopeA, batchImport("plain", id, ""))
	keep := e.importIn(scopeA, batchImport("unbatched", "", ""))
	folder := "imports"
	e.pin(second.Line.ID, true)
	if _, err := e.engine.UpdateLine(e.ctx, scopeA, first.Line.ID, tangent.LinePatch{Folder: &folder}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.MarkRead(e.ctx, scopeA, first.Line.ID); err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	out, err := e.engine.DeleteImportBatch(e.ctx, scopeA, id, false)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(out.Deleted, []string{first.Line.ID, second.Line.ID}) || len(out.Kept) != 0 {
		t.Fatalf("both trees go, in import order (a dated import, a pin, a folder or a read is not 'changed'): %+v", out)
	}
	e.wantTypes(tangent.EventLineDeleted, tangent.EventLineDeleted)
	if n := e.count(`SELECT count(*) FROM tangent_line WHERE id = ANY($1::uuid[])`, []string{first.Line.ID, first.BranchLines[0].ID, second.Line.ID}); n != 0 {
		t.Fatalf("%d lines left", n)
	}
	if _, err := e.engine.GetLine(e.ctx, scopeA, keep.Line.ID); err != nil {
		t.Fatalf("a line of no batch stays: %v", err)
	}
	if got := e.batches(scopeA); len(got) != 0 {
		t.Fatalf("the batch row goes with its last tree: %+v", got)
	}
	_, err = e.engine.DeleteImportBatch(e.ctx, scopeA, id, false)
	wantCode(t, err, domain.CodeImportBatchNotFound)
}

func TestImportBatch_DeleteKeepsAttachedBusyAndChangedTrees(t *testing.T) {
	e := newEnvWith(t, b18Features())
	id := uuid.NewString()
	lines := map[string]tangent.ImportedLine{}
	for _, name := range []string{"attached", "busy", "talked", "branched", "termed", "untouched"} {
		lines[name] = e.importIn(scopeA, batchImport(name, id, ""))
	}
	future := datedImport(time.Now().UTC().Add(time.Hour))
	future.BatchID = id
	future.Branches[0].Status = domain.BranchStatusOpen
	lines["future"] = e.importIn(scopeA, future)
	target := e.mainLine()
	e.exchange(target.ID, "hello", "hi")
	if _, err := e.engine.AttachLine(e.ctx, scopeA, target.ID, tangent.AttachInput{SourceLineID: lines["attached"].Line.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.BeginTurn(e.ctx, scopeA, lines["busy"].Line.ID, tangent.TurnInput{Content: "still answering"}); err != nil {
		t.Fatal(err)
	}
	e.exchange(lines["talked"].Line.ID, "one more question", "one more answer")
	answers, err := e.engine.ListMessages(e.ctx, scopeA, lines["branched"].Line.ID, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	e.branch(lines["branched"].Line.ID, answers[1].ID, "a side question")
	e.saveTerm(lines["termed"].Line.ID, "MVCC", "versions of rows")
	e.exchange(lines["future"].BranchLines[0].ID, "a question in the imported branch", "its answer")

	out, err := e.engine.DeleteImportBatch(e.ctx, scopeA, id, false)
	if err != nil {
		t.Fatal(err)
	}
	wantKept := []domain.KeptImportLine{
		{LineID: lines["attached"].Line.ID, Reason: domain.ImportKeptAttached},
		{LineID: lines["busy"].Line.ID, Reason: domain.ImportKeptBusy},
		{LineID: lines["talked"].Line.ID, Reason: domain.ImportKeptChanged},
		{LineID: lines["branched"].Line.ID, Reason: domain.ImportKeptChanged},
		{LineID: lines["termed"].Line.ID, Reason: domain.ImportKeptChanged},
		{LineID: lines["future"].Line.ID, Reason: domain.ImportKeptChanged},
	}
	if !slices.Equal(out.Deleted, []string{lines["untouched"].Line.ID}) || !slices.Equal(out.Kept, wantKept) {
		t.Fatalf("deleted %v kept %+v", out.Deleted, out.Kept)
	}
	if got := e.batches(scopeA); len(got) != 1 || got[0].LineCount != 6 || got[0].StandaloneCount != 5 {
		t.Fatalf("the batch stays while something is kept: %+v", got)
	}

	e.events.Reset()
	forced, err := e.engine.DeleteImportBatch(e.ctx, scopeA, id, true)
	if err != nil {
		t.Fatal(err)
	}
	wantForced := []string{lines["talked"].Line.ID, lines["branched"].Line.ID, lines["termed"].Line.ID, lines["future"].Line.ID}
	if !slices.Equal(forced.Deleted, wantForced) || !slices.Equal(forced.Kept, wantKept[:2]) {
		t.Fatalf("force deletes the changed ones only: deleted %v kept %+v", forced.Deleted, forced.Kept)
	}
	if got := e.events.Types(); len(got) != 4 || slices.ContainsFunc(got, func(s string) bool { return s != tangent.EventLineDeleted }) {
		t.Fatalf("one line.deleted per tree: %v", got)
	}
}

func TestImportBatch_DeleteRunsTheHooksOfEachTree(t *testing.T) {
	e := newEnvWith(t, b18Features())
	id := uuid.NewString()
	line := e.importIn(scopeA, batchImport("one", id, ""))
	e.rollsBack("delete import batch", func(opt tangent.TxOption) error {
		_, err := e.engine.DeleteImportBatch(e.ctx, scopeA, id, false, opt)
		return err
	})
	if _, err := e.engine.GetLine(e.ctx, scopeA, line.Line.ID); err != nil {
		t.Fatalf("a failed hook keeps the tree: %v", err)
	}
	if got := e.batches(scopeA); len(got) != 1 {
		t.Fatalf("and the batch: %+v", got)
	}
}

func TestImportBatch_DeleteTreeLeavesTheBatchRow(t *testing.T) {
	e := newEnvWith(t, b18Features())
	id := uuid.NewString()
	line := e.importIn(scopeA, batchImport("one", id, ""))
	if _, err := e.engine.DeleteTree(e.ctx, scopeA, line.Line.ID); err != nil {
		t.Fatal(err)
	}
	if got := e.batches(scopeA); len(got) != 1 || got[0].LineCount != 0 {
		t.Fatalf("the batch row stays with no lines: %+v", got)
	}
	out, err := e.engine.DeleteImportBatch(e.ctx, scopeA, id, false)
	if err != nil || len(out.Deleted) != 0 || len(out.Kept) != 0 || len(e.batches(scopeA)) != 0 {
		t.Fatalf("an empty batch is removed: %+v %v", out, err)
	}
}
