package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// StubSpec describes a test-only feature that hooks into every extension
// point (compiled into tests only).
type StubSpec struct {
	Name            string
	Mode            Mode
	Requires        []string
	Section         *domain.PromptSection
	History         func(lineID string) []domain.Message
	OnTurnCompleted func(ctx context.Context, tx store.Tx) error
	OnBranchCreated func(ctx context.Context, tx store.Tx) error
	OnBranchClosed  func(ctx context.Context, tx store.Tx) error
	AfterCommit     func(kind string) []Event
	Jobs            func(kind string) []Job
	JobKind         string
	FinishJob       func(job JobRecord, raw string) error
	Maintain        func() (int, error)
}

// StubFeature builds the feature StubSpec describes.
func StubFeature(spec StubSpec) Feature {
	mode := spec.Mode
	if mode == ModeOff {
		mode = ModeAuto
	}
	return &module{name: spec.Name, configured: mode, requires: spec.Requires, attach: func(r *registry, _ *module) { attachStub(r, spec) }}
}

func attachStub(r *registry, spec StubSpec) {
	if spec.Section != nil {
		r.addContextProvider(func(_ context.Context, _ *Engine, _ Mode, pc *promptContext) error {
			pc.in.HostSections = append(pc.in.HostSections, *spec.Section)
			return nil
		})
	}
	if spec.History != nil {
		r.setHistorySelector(func(_ context.Context, _ *Engine, _ Mode, pc *promptContext) error {
			pc.in.History = spec.History(pc.line.ID)
			return nil
		})
	}
	txStub := func(fn func(context.Context, store.Tx) error) txHandler {
		return func(ctx context.Context, _ *Engine, _ Mode, tx store.Tx, _ txEvent) error { return fn(ctx, tx) }
	}
	if spec.OnTurnCompleted != nil {
		r.addOnTurnCompleted(txStub(spec.OnTurnCompleted))
	}
	if spec.OnBranchCreated != nil {
		r.addOnBranchCreated(txStub(spec.OnBranchCreated))
	}
	if spec.OnBranchClosed != nil {
		r.addOnBranchClosed(txStub(spec.OnBranchClosed))
	}
	if spec.AfterCommit != nil || spec.Jobs != nil {
		r.addAfterCommit(func(_ context.Context, _ *Engine, _ Mode, ev *commitEvent) ([]Event, []Job) {
			var events []Event
			var jobs []Job
			if spec.AfterCommit != nil {
				events = spec.AfterCommit(ev.kind)
			}
			if spec.Jobs != nil {
				jobs = spec.Jobs(ev.kind)
			}
			return events, jobs
		})
	}
	if spec.JobKind != "" {
		r.addJobHandler(spec.JobKind, jobHandler{finish: func(_ context.Context, _ *Engine, job JobRecord, raw string, _ error) error {
			return spec.FinishJob(job, raw)
		}})
	}
	if spec.Maintain != nil {
		r.addMaintainer(spec.Name+".task", func(context.Context, *Engine) (int, error) { return spec.Maintain() })
	}
}

// OpenStreams counts the turn streams the engine keeps (tests).
func (e *Engine) OpenStreams() int {
	e.streams.mu.Lock()
	defer e.streams.mu.Unlock()
	return len(e.streams.turns)
}

// ConsolidatePairs starts the consolidation jobs of the given pairs, as the
// maintenance sweep does once it found them (B11: a pair's line can go in
// between).
func (e *Engine) ConsolidatePairs(ctx context.Context, pairs []store.MemoryPair) (int, error) {
	return e.consolidatePairs(ctx, pairs)
}
