package tangent

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// The extension points (DESIGN §11). Every point runs the hooks of the
// features that are on in the call's modeSet, in WithFeatures order. Hooks
// inside a transaction roll it back with their error; hooks after the
// commit can only add events and jobs.

// promptContext is what a ContextProvider or HistorySelector sees: the
// line, the turn being begun (nil for a preview) and the prompt input it
// fills in.
type promptContext struct {
	scope Scope
	modes modeSet
	line  domain.LineView
	begun *beginInfo
	in    *domain.PromptInput
	// budget is the prompt's shared budget; historyBudget what the history
	// was granted from it (a HistorySelector stays within it).
	budget        *contextBudget
	historyBudget int
	// fisheye is what the fisheye selected (PreviewTurn reports it).
	fisheye *FisheyeReport
	// folds are the folds the history rewriters applied (PreviewTurn
	// reports them).
	folds []domain.AppliedFold
	// memories are what the memory feature recalled (PreviewTurn reports
	// them).
	memories []domain.RecalledMemory
}

// beginInfo is what BeginTurn chose under the line lock.
type beginInfo struct {
	pendingID     string
	userID        string
	rootLineID    string
	notesRevision int
	notesSent     int
}

// contextProvider adds to a turn prompt (a block, the summary, a rule).
type contextProvider func(ctx context.Context, e *Engine, mode Mode, pc *promptContext) error

// historySelector replaces the default choice of history (the newest
// HistoryScan messages before the turn): it fills pc.in (History or
// Selection) within pc.historyBudget.
type historySelector func(ctx context.Context, e *Engine, mode Mode, pc *promptContext) error

// historyRewriter rewrites the messages a prompt's history is chosen from
// (the default choice and the HistorySelector both see the result), for
// example folding a stretch into one summary entry. An internal point not
// in DESIGN §11: it runs before the HistorySelector.
type historyRewriter func(ctx context.Context, e *Engine, mode Mode, pc *promptContext, history []domain.Message) ([]domain.Message, error)

// replyParts is a finished reply before it is stored.
type replyParts struct {
	content     string
	suggestions []domain.BranchSuggestion
}

// replyFilter rewrites a successful reply before it is stored (parsing
// [BRANCH-SUGGEST] lines out of it). An internal point not in DESIGN §11:
// OnTurnCompleted runs after the store wrote the reply.
type replyFilter func(e *Engine, mode Mode, reply *replyParts)

// Kinds of txEvent and commitEvent.
const (
	commitTurnCompleted = "turn_completed"
	commitBranchCreated = "branch_created"
	commitBranchClosed  = "branch_closed"
	commitSummarySaved  = "summary_saved"
	// commitLeafWritten: the operator wrote a branch's leaf (PutLeaf).
	commitLeafWritten = "leaf_written"
	// commitNotesWritten: notes were written (ApplyNoteChanges).
	commitNotesWritten = "notes_written"
)

// txEvent is what an in-transaction hook sees: the point, the scope, the
// store's result of the write (store.CompletedTurn, store.CreatedBranch,
// store.MovedBranch, store.ExpandedSeed, store.MergedBranch,
// domain.BranchView for a discard, store.PromotedBranch), for a branch that
// closed its line, the core call's input when it has one (DiscardInput)
// and the outbox for what to publish once the write committed.
type txEvent struct {
	kind         string
	scope        Scope
	result       any
	branchLineID string
	request      any
	out          *txOutbox
}

// txOutbox collects, inside a write's transaction, what the in-transaction
// hooks want published after the commit. Every attempt of a retried
// transaction starts it empty; commit publishes it before AfterCommit runs.
type txOutbox struct {
	mu    sync.Mutex
	later []func(ctx context.Context) []Event
}

// after queues events built once the write committed (they may re-read
// what it changed).
func (o *txOutbox) after(fn func(ctx context.Context) []Event) {
	if o == nil {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.later = append(o.later, fn)
}

func (o *txOutbox) reset() {
	if o == nil {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.later = nil
}

// take empties the outbox and returns what it held.
func (o *txOutbox) take() []func(ctx context.Context) []Event {
	if o == nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	later := o.later
	o.later = nil
	return later
}

// txCall is one write's context for its in-transaction hooks.
type txCall struct {
	modes   modeSet
	scope   Scope
	kind    string
	request any
	out     *txOutbox
}

// newTxCall starts the hook context of one write.
func newTxCall(modes modeSet, scope Scope, kind string, request any) txCall {
	return txCall{modes: modes, scope: scope, kind: kind, request: request, out: &txOutbox{}}
}

// txHandler runs inside a write's transaction (OnTurnCompleted,
// OnBranchCreated, OnBranchClosed).
type txHandler func(ctx context.Context, e *Engine, mode Mode, tx store.Tx, ev txEvent) error

// commitEvent is what an AfterCommit hook sees. Only the fields of its kind
// are set. A hook may fill turn.SummaryDue and turn.Jobs.
type commitEvent struct {
	kind     string
	scope    Scope
	modes    modeSet
	turn     *CompletedTurn
	change   string
	branch   *domain.BranchView
	merged   *store.MergedBranch
	promoted *store.PromotedBranch
	summary  *store.SavedSummary
	leaf     *domain.Leaf
	notes    *store.NotesWrite
	request  any
	out      *txOutbox
	// reply is what a completed turn's reply asked for (its [TOPIC] and
	// [CHAPTER] lines); nil for a failed turn.
	reply *turnReply
	// replies caches the completed turn's line's reply count for the hooks
	// that read it (lineReplies).
	replies *int
}

// lineReplies is the number of finished replies of the completed turn's
// line, read once per commit however many hooks ask.
func (ev *commitEvent) lineReplies(ctx context.Context, e *Engine) (int, error) {
	if ev.replies != nil {
		return *ev.replies, nil
	}
	n, err := e.store.ReplyCount(ctx, ev.turn.Line.ID)
	if err != nil {
		return 0, err
	}
	ev.replies = &n
	return n, nil
}

// afterCommit runs after a commit; it returns events to publish and jobs
// for the caller to run.
type afterCommit func(ctx context.Context, e *Engine, mode Mode, ev *commitEvent) ([]Event, []Job)

// jobHandler finishes the jobs of one kind (JobHandler); onStale, when set,
// is told about a job of the kind that FailStaleJobs failed.
type jobHandler struct {
	feature string
	timeout time.Duration
	finish  func(ctx context.Context, e *Engine, job JobRecord, raw string, runErr error) error
	onStale func(ctx context.Context, e *Engine, job JobRecord)
}

// maintainer is a periodic task of a feature (Maintain), reported under its
// task name.
type maintainer struct {
	task string
	fn   func(ctx context.Context, e *Engine) (int, error)
}

// hook is one registered function with the feature that owns it.
type hook[T any] struct {
	feature string
	fn      T
}

// registry holds the enabled features and their extension points.
type registry struct {
	features []Feature
	modes    map[string]Mode
	requires map[string][]string
	configs  map[string]featureConfig
	provides map[string]string
	current  string
	err      error

	contextProviders []hook[contextProvider]
	historySelector  *hook[historySelector]
	historyRewriters []hook[historyRewriter]
	packSummary      []string
	replyFilters     []hook[replyFilter]
	onTurnCompleted  []hook[txHandler]
	onBranchCreated  []hook[txHandler]
	onBranchClosed   []hook[txHandler]
	afterCommit      []hook[afterCommit]
	jobHandlers      map[string]jobHandler
	maintainers      []hook[maintainer]
	suggestionKinds  map[string]suggestionKind
	// values hold what a feature was configured with beyond featureConfig
	// (memory's Embedder), by feature.
	values map[string]any
}

func newRegistry() *registry {
	return &registry{
		modes: map[string]Mode{}, requires: map[string][]string{}, configs: map[string]featureConfig{},
		provides: map[string]string{}, jobHandlers: map[string]jobHandler{}, suggestionKinds: map[string]suggestionKind{},
		values: map[string]any{},
	}
}

// fail records the first registration error; New reports it.
func (r *registry) fail(format string, args ...any) {
	if r.err == nil {
		r.err = fmt.Errorf("tangent: feature %q: "+format, append([]any{r.current}, args...)...)
	}
}

// provide announces an optional capability other features may use
// (cooperates); it is not a dependency.
func (r *registry) provide(capability string) { r.provides[capability] = r.current }

func (r *registry) addContextProvider(fn contextProvider) {
	r.contextProviders = append(r.contextProviders, hook[contextProvider]{r.current, fn})
}

// setHistorySelector registers the one HistorySelector; a second is refused.
func (r *registry) setHistorySelector(fn historySelector) {
	if r.historySelector != nil {
		r.fail("only one feature may select the history (%q already does)", r.historySelector.feature)
		return
	}
	r.historySelector = &hook[historySelector]{r.current, fn}
}

func (r *registry) addHistoryRewriter(fn historyRewriter) {
	r.historyRewriters = append(r.historyRewriters, hook[historyRewriter]{r.current, fn})
}

// addPackSummary lets the rolling summary into branch packs.
func (r *registry) addPackSummary() { r.packSummary = append(r.packSummary, r.current) }

func (r *registry) addReplyFilter(fn replyFilter) {
	r.replyFilters = append(r.replyFilters, hook[replyFilter]{r.current, fn})
}

func (r *registry) addOnTurnCompleted(fn txHandler) {
	r.onTurnCompleted = append(r.onTurnCompleted, hook[txHandler]{r.current, fn})
}

func (r *registry) addOnBranchCreated(fn txHandler) {
	r.onBranchCreated = append(r.onBranchCreated, hook[txHandler]{r.current, fn})
}

func (r *registry) addOnBranchClosed(fn txHandler) {
	r.onBranchClosed = append(r.onBranchClosed, hook[txHandler]{r.current, fn})
}

func (r *registry) addAfterCommit(fn afterCommit) {
	r.afterCommit = append(r.afterCommit, hook[afterCommit]{r.current, fn})
}

// addJobHandler registers the handler of a job kind; one per kind.
func (r *registry) addJobHandler(kind string, handler jobHandler) {
	if existing, ok := r.jobHandlers[kind]; ok {
		r.fail("job kind %q is already handled by %q", kind, existing.feature)
		return
	}
	handler.feature = r.current
	r.jobHandlers[kind] = handler
}

func (r *registry) addMaintainer(task string, fn func(context.Context, *Engine) (int, error)) {
	r.maintainers = append(r.maintainers, hook[maintainer]{r.current, maintainer{task: task, fn: fn}})
}

// provideContext runs the ContextProviders that are on, each measured as
// its feature's share of the budget.
func (e *Engine) provideContext(ctx context.Context, pc *promptContext) error {
	for _, h := range e.features.contextProviders {
		mode := pc.modes.of(h.feature)
		if mode == ModeOff {
			continue
		}
		if err := pc.budget.measured(h.feature, pc.in, func() error { return h.fn(ctx, e, mode, pc) }); err != nil {
			return fmt.Errorf("feature %s: %w", h.feature, err)
		}
	}
	return nil
}

// selectHistory runs the HistorySelector when one is on; selected is false
// when the default choice applies.
func (e *Engine) selectHistory(ctx context.Context, pc *promptContext) (bool, error) {
	h := e.features.historySelector
	if h == nil || pc.modes.of(h.feature) == ModeOff {
		return false, nil
	}
	if err := h.fn(ctx, e, pc.modes.of(h.feature), pc); err != nil {
		return false, fmt.Errorf("feature %s: %w", h.feature, err)
	}
	return true, nil
}

// rewriteHistory runs the history rewriters that are on over the messages
// a prompt's history is chosen from.
func (e *Engine) rewriteHistory(ctx context.Context, pc *promptContext, history []domain.Message) ([]domain.Message, error) {
	for _, h := range e.features.historyRewriters {
		mode := pc.modes.of(h.feature)
		if mode == ModeOff {
			continue
		}
		rewritten, err := h.fn(ctx, e, mode, pc, history)
		if err != nil {
			return nil, fmt.Errorf("feature %s: %w", h.feature, err)
		}
		history = rewritten
	}
	return history, nil
}

// packUsesSummary reports whether a feature lets the parent's rolling
// summary into a branch pack.
func (e *Engine) packUsesSummary(modes modeSet) bool {
	for _, feature := range e.features.packSummary {
		if modes.of(feature) != ModeOff {
			return true
		}
	}
	return false
}

// filterReply runs the ReplyFilters that are on.
func (e *Engine) filterReply(modes modeSet, reply *replyParts) {
	for _, h := range e.features.replyFilters {
		if mode := modes.of(h.feature); mode != ModeOff {
			h.fn(e, mode, reply)
		}
	}
}

// runTx runs the in-transaction hooks of one point that are on.
func (e *Engine) runTxHooks(ctx context.Context, modes modeSet, hooks []hook[txHandler], tx store.Tx, ev txEvent) error {
	for _, h := range hooks {
		if mode := modes.of(h.feature); mode != ModeOff {
			if err := h.fn(ctx, e, mode, tx, ev); err != nil {
				return fmt.Errorf("feature %s: %w", h.feature, err)
			}
		}
	}
	return nil
}

// txHooks wraps the in-transaction hooks of one point as a store TxHook that
// runs before the host's own (so the host sees the features' writes).
func (e *Engine) txHooks(c txCall, hooks []hook[txHandler], opts []TxOption) []TxHook {
	first, host := splitHooks(opts)
	if len(hooks) == 0 {
		return append(first, host...)
	}
	feature := func(ctx context.Context, tx store.Tx, result any) error {
		c.out.reset()
		ev := txEvent{kind: c.kind, scope: c.scope, result: result, branchLineID: closedLineOf(result), request: c.request, out: c.out}
		return e.runTxHooks(ctx, c.modes, hooks, tx, ev)
	}
	return append(append(first, feature), host...)
}

// closedLineOf is the branch a write closed, when its result names one.
func closedLineOf(result any) string {
	switch r := result.(type) {
	case store.MergedBranch:
		return r.Branch.LineID
	case domain.BranchView:
		return r.LineID
	case store.PromotedBranch:
		return r.PromotedID
	case store.CompletedTurn:
		return r.EndedAsideLineID
	case store.SpunOff:
		return r.Branch.LineID
	}
	return ""
}

// turnTxHooks are CompleteTurn's: OnTurnCompleted, then OnBranchClosed when
// the turn ended an answered aside.
func (e *Engine) turnTxHooks(c txCall, opts []TxOption) []TxHook {
	first, host := splitHooks(opts)
	if len(e.features.onTurnCompleted) == 0 && len(e.features.onBranchClosed) == 0 {
		return append(first, host...)
	}
	feature := func(ctx context.Context, tx store.Tx, result any) error {
		c.out.reset()
		modes := c.modes
		ev := txEvent{kind: commitTurnCompleted, scope: c.scope, result: result, out: c.out}
		if err := e.runTxHooks(ctx, modes, e.features.onTurnCompleted, tx, ev); err != nil {
			return err
		}
		if aside := closedLineOf(result); aside != "" {
			ev.kind, ev.branchLineID = commitBranchClosed, aside
			return e.runTxHooks(ctx, modes, e.features.onBranchClosed, tx, ev)
		}
		return nil
	}
	return append(append(first, feature), host...)
}

// commit runs the AfterCommit hooks that are on, publishes their events and
// returns their jobs.
func (e *Engine) commit(ctx context.Context, ev *commitEvent) []Job {
	for _, build := range ev.out.take() {
		e.publish(ctx, build(ctx)...)
	}
	var jobs []Job
	for _, h := range e.features.afterCommit {
		mode := ev.modes.of(h.feature)
		if mode == ModeOff {
			continue
		}
		events, more := h.fn(ctx, e, mode, ev)
		e.publish(ctx, events...)
		jobs = append(jobs, more...)
	}
	return jobs
}
