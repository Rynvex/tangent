package tangent

import (
	"context"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Jobs, suggestion kinds and the maintenance task of the memory feature.
const (
	// JobKindMemoryExtract proposes memories from what a write settled.
	JobKindMemoryExtract = store.JobKindMemoryExtract
	// JobKindMemoryConsolidate looks at two near-duplicate memories.
	JobKindMemoryConsolidate = store.JobKindMemoryConsolidate
	// SuggestionKindMemory is a proposed memory (payload MemoryProposal).
	SuggestionKindMemory = "memory"
	// SuggestionKindMemoryConsolidate proposes to merge two memories or
	// flags their conflict (payload MemoryConsolidation).
	SuggestionKindMemoryConsolidate = "memory_consolidate"
	// TaskConsolidateMemories is the maintenance task that looks for
	// near-duplicate memories.
	TaskConsolidateMemories = "memory.consolidate"
)

// MemoryConfig configures the memory feature. Embedder is required (New
// refuses without one). NoTurnRecall leaves the recalled memories out of
// every turn's prompt (search and the offers at a new conversation or
// branch still work).
type MemoryConfig struct {
	Embedder     Embedder
	NoTurnRecall bool
}

// memoryRuntime is what the memory hooks share.
type memoryRuntime struct {
	embedder   Embedder
	turnRecall bool
}

// Memory keeps what a tenant's conversations settled across conversations
// (DESIGN §12 B10): memories (fact, decision, preference, lesson) with
// their sources, never deleted, only superseded. Recall ranks them by
// relevance (the Embedder's cosine similarity) × recency × importance:
// every turn's prompt carries the best few that fit the budget (unless
// NoTurnRecall; visible in PreviewTurn only), and SearchMemories serves the
// offers at a new conversation or branch. Suggest and Auto extract
// memories with a cheap model after a merge, a confirmed leaf or a decided
// note (memory_extract: Suggest proposes them in the inbox, Auto writes
// them), and the maintenance loop looks for near-duplicate memories
// (memory_consolidate → the inbox: merge them, or a conflict to settle).
// Manual: the operator's memories and recall only. Needs notes, the vector
// extension and its migration (store.MigrateFeatures(ctx, pool, "memory")).
// Off: the calls return feature_disabled and prompts carry no memories;
// stored memories are kept.
func Memory(mode Mode, cfg MemoryConfig, opts ...FeatureOption) Feature {
	return &module{name: FeatureMemory, ai: true, configured: mode, requires: []string{FeatureNotes}, cfg: newFeatureConfig(opts), attach: registerMemory(cfg)}
}

func registerMemory(cfg MemoryConfig) func(r *registry, m *module) {
	return func(r *registry, _ *module) {
		if cfg.Embedder == nil || cfg.Embedder.Dim() <= 0 {
			r.fail("needs an Embedder (MemoryConfig.Embedder) with a positive Dim")
			return
		}
		r.values[FeatureMemory] = &memoryRuntime{embedder: cfg.Embedder, turnRecall: !cfg.NoTurnRecall}
		if !cfg.NoTurnRecall {
			r.addContextProvider(memoryContext)
		}
		r.addAfterCommit(memoryAfterCommit)
		r.addJobHandler(JobKindMemoryExtract, jobHandler{timeout: goalJobTimeout, finish: finishMemoryExtract, onStale: staleJobFailed})
		r.addJobHandler(JobKindMemoryConsolidate, jobHandler{timeout: goalJobTimeout, finish: finishMemoryConsolidate, onStale: staleJobFailed})
		r.addSuggestionKind(SuggestionKindMemory, suggestionKind{accept: acceptMemory})
		r.addSuggestionKind(SuggestionKindMemoryConsolidate, suggestionKind{permanentDismiss: true, accept: acceptConsolidation})
		r.addMaintainer(TaskConsolidateMemories, consolidateMemories)
	}
}

// memory is the feature's runtime (the caller checked the feature is on).
func (e *Engine) memory() *memoryRuntime {
	m, _ := e.features.values[FeatureMemory].(*memoryRuntime)
	return m
}

// embedOne embeds one text. A failing Embedder (or one that answers with
// the wrong shape) is domain.ErrEmbedderUnavailable; the cause is only
// logged. A cancelled context stays the context's error.
func (e *Engine) embedOne(ctx context.Context, text string) ([]float32, error) {
	vectors, err := e.memory().embedder.Embed(ctx, []string{text})
	if err == nil && (len(vectors) != 1 || len(vectors[0]) != e.memory().embedder.Dim()) {
		err = errEmbedderShape
	}
	if err == nil {
		return vectors[0], nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	e.log.Warn("tangent: the Embedder failed", "error", err)
	return nil, domain.ErrEmbedderUnavailable
}

// memoryContext recalls the memories relevant to this turn (the
// operator's message, or the line's purpose or title without one) into a
// trailing block within what the budget left. A failing Embedder only
// logs: a turn never fails for its memories.
func memoryContext(ctx context.Context, e *Engine, _ Mode, pc *promptContext) error {
	query := strings.TrimSpace(pc.in.UserMessage)
	if query == "" {
		query = lineAbout(pc.line)
	}
	recalled, err := e.recall(ctx, pc.scope, query, e.limits.Memory.TopK)
	if err != nil {
		e.log.Warn("tangent: memories were not recalled", "line", pc.line.ID, "error", err)
		return nil
	}
	pc.in.MemoryBlock, pc.memories = domain.BuildMemoryBlock(recalled, min(e.limits.Memory.TokenBudget, pc.budget.remaining()), e.markers)
	return nil
}

// lineAbout is a line's purpose (a branch) or its title.
func lineAbout(line domain.LineView) string {
	if line.ConversationBranch != nil {
		return line.ConversationBranch.Purpose
	}
	return line.Title
}

// recall ranks the tenant's memories for a query, at most k.
func (e *Engine) recall(ctx context.Context, scope Scope, query string, k int) ([]domain.RecalledMemory, error) {
	if strings.TrimSpace(query) == "" {
		return []domain.RecalledMemory{}, nil
	}
	vector, err := e.embedOne(ctx, query)
	if err != nil {
		return nil, err
	}
	cands, err := e.store.SimilarMemories(ctx, scope.Tenant, vector, e.limits.Memory.Candidates)
	if err != nil {
		return nil, err
	}
	return domain.RankMemories(cands, e.now(), k, e.limits.Memory), nil
}

// memoryAfterCommit starts an extraction (Suggest, Auto) after a merge, a
// discard with a leaf, a leaf the operator wrote, or decided notes.
func memoryAfterCommit(ctx context.Context, e *Engine, mode Mode, ev *commitEvent) ([]Event, []Job) {
	if mode < ModeSuggest {
		return nil, nil
	}
	src, ok := memorySourceOf(ev)
	if !ok {
		return nil, nil
	}
	job, err := e.startMemoryExtract(ctx, ev.scope, src)
	if err != nil {
		e.log.Warn("tangent: a memory extraction was not started", "line", src.lineID, "error", err)
		return nil, nil
	}
	return nil, []Job{job}
}

// extractSource is what an extraction reads and where its memories come
// from.
type extractSource struct {
	lineID string
	prompt domain.MemoryExtractSource
	source domain.MemorySource
}

// memorySourceOf is the source of a commit worth an extraction.
func memorySourceOf(ev *commitEvent) (extractSource, bool) {
	switch {
	case ev.kind == commitBranchClosed && ev.merged != nil:
		return cardSource(*ev.merged), true
	case ev.kind == commitBranchClosed && ev.change == BranchDiscarded && ev.branch != nil && ev.branch.Leaf != nil && ev.branch.Kind != domain.BranchKindAside:
		b := ev.branch
		return extractSource{lineID: b.LineID, prompt: domain.MemoryExtractSource{Kind: domain.MemorySourceLeaf, Context: b.Purpose, Text: "[" + b.Leaf.Kind + "] " + b.Leaf.Line},
			source: domain.MemorySource{LineID: b.LineID, LeafLineID: b.LineID, Label: b.Purpose}}, true
	case ev.kind == commitLeafWritten && ev.leaf != nil:
		l := ev.leaf
		return extractSource{lineID: l.LineID, prompt: domain.MemoryExtractSource{Kind: domain.MemorySourceLeaf, Text: "[" + l.Kind + "] " + l.Line + "\n" + l.Body},
			source: domain.MemorySource{LineID: l.LineID, LeafLineID: l.LineID}}, true
	case ev.kind == commitNotesWritten && ev.notes != nil:
		return notesSource(*ev.notes)
	}
	return extractSource{}, false
}

// cardSource is a merged branch's card (and the notes written with it).
func cardSource(m store.MergedBranch) extractSource {
	text := ""
	if card := m.Card.Meta.Card; card != nil {
		text = "Question: " + card.Question + "\nConclusion: " + card.Conclusion
		for _, item := range card.OpenItems {
			text += "\nOpen: " + item
		}
	}
	for _, note := range m.Notes.Created {
		text += "\n[" + note.Section + "] " + note.Text
	}
	return extractSource{
		lineID: m.ParentLineID, prompt: domain.MemoryExtractSource{Kind: domain.MemorySourceCard, Context: m.Branch.Purpose, Text: text},
		source: domain.MemorySource{LineID: m.ParentLineID, MessageID: m.Card.ID, LeafLineID: m.Branch.LineID, Label: m.Branch.Purpose},
	}
}

// notesSource is the decided notes a write created; none is no source.
func notesSource(w store.NotesWrite) (extractSource, bool) {
	texts := []string{}
	var first domain.Note
	for _, note := range w.Created {
		if note.Section == domain.NoteSectionDecided {
			if len(texts) == 0 {
				first = note
			}
			texts = append(texts, note.Text)
		}
	}
	if len(texts) == 0 {
		return extractSource{}, false
	}
	line := first.SourceLineID
	if line == "" {
		line = w.RootLineID
	}
	return extractSource{
		lineID: line, prompt: domain.MemoryExtractSource{Kind: domain.MemorySourceNote, Text: strings.Join(texts, "\n")},
		source: domain.MemorySource{LineID: line, MessageID: first.SourceMessageID, NoteID: first.ID, Label: first.SourceLabel},
	}, true
}
