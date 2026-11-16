package tangent_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// B22: the import analysis asks a runner once and falls back to the
// deterministic analyzer whenever the model's plan is unusable.

func b22Input() domain.ImportAnalyzeInput {
	questions := []string{"CPU 散熱膏多久換一次?", "firebase是什麼?", "散熱膏可以改用 PTM7950 嗎?", "水冷排要裝在機殼上方嗎?", "散熱膏換完 CPU 還是很燙?", "Firebase 免費方案的限制?"}
	units := make([]domain.ImportAnalyzeUnit, 0, len(questions))
	for i, q := range questions {
		units = append(units, domain.ImportAnalyzeUnit{Key: fmt.Sprintf("u%d", i+1), Question: q, Answer: "好的。", MessageCount: 2})
	}
	return domain.ImportAnalyzeInput{Units: units}
}

const b22ModelPlan = "```json\n" + `{"mode":"tree","summary":"模型的計畫","nodes":[{"unitKeys":["U1","U3","U5"],"role":"chapter","title":"散熱"},` +
	`{"unitKeys":["U2","U6"],"role":"merged_branch","attachToKey":"U1","conclusion":"有上限。"},{"unitKeys":["U4"],"role":"standalone"}]}` + "\n```"

func TestB22_AnalyzeImportUsesAValidModelPlan(t *testing.T) {
	e := newEnv(t, tangent.WithDefaultModel("anthropic", "sonnet"))
	e.runner.Queue(tangenttest.Reply{Content: b22ModelPlan})
	plan, err := e.engine.AnalyzeImport(e.ctx, scopeA, b22Input(), e.runner)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Source != domain.ImportAnalyzeSourceModel || plan.Summary != "模型的計畫" || len(plan.Nodes) != 3 || plan.Nodes[2].Role != domain.ImportRoleStandalone {
		t.Fatalf("plan = %+v", plan)
	}
	sent := e.runner.Requests()
	if len(sent) != 1 || sent[0].Provider != "anthropic" || sent[0].Model != "sonnet" || sent[0].OnDelta != nil {
		t.Fatalf("requests = %+v", sent)
	}
}

func TestB22_AnalyzeImportFallsBackToTheHeuristic(t *testing.T) {
	e := newEnv(t)
	cancelled, cancel := context.WithCancel(e.ctx)
	cancel()
	slow := tangent.RunnerFunc(func(ctx context.Context, _ tangent.RunRequest) (tangent.RunResult, error) {
		<-ctx.Done()
		return tangent.RunResult{}, ctx.Err()
	})
	cases := map[string]struct {
		ctx    context.Context
		runner tangent.Runner
	}{
		"no runner": {e.ctx, nil},
		"the fake":  {e.ctx, fake.New(fake.Config{})},
		"a failure": {e.ctx, tangent.RunnerFunc(func(context.Context, tangent.RunRequest) (tangent.RunResult, error) {
			return tangent.RunResult{}, tangenttest.ErrFake
		})},
		"a panic":   {e.ctx, tangent.RunnerFunc(func(context.Context, tangent.RunRequest) (tangent.RunResult, error) { panic("boom") })},
		"cancelled": {cancelled, slow},
		"half a plan": {e.ctx, tangent.RunnerFunc(func(context.Context, tangent.RunRequest) (tangent.RunResult, error) {
			return tangent.RunResult{Content: `{"nodes":[{"unitKeys":["U1"]}]}`}, nil
		})},
		"prose and json": {e.ctx, tangent.RunnerFunc(func(context.Context, tangent.RunRequest) (tangent.RunResult, error) {
			return tangent.RunResult{Content: "Sure! {\"nodes\":[]}"}, nil
		})},
	}
	for name, tc := range cases {
		plan, err := e.engine.AnalyzeImport(tc.ctx, scopeA, b22Input(), tc.runner)
		if err != nil || plan.Source != domain.ImportAnalyzeSourceHeuristic || len(plan.Nodes) == 0 {
			t.Errorf("%s: plan = %+v, err = %v", name, plan, err)
		}
	}
}

func TestB22_AnalyzeImportRefusesBadInputWithoutAskingTheRunner(t *testing.T) {
	e := newEnv(t)
	if _, err := e.engine.AnalyzeImport(e.ctx, scopeA, domain.ImportAnalyzeInput{}, e.runner); !isCode(err, domain.CodeInvalidInput) {
		t.Fatalf("no units: %v", err)
	}
	if _, err := e.engine.AnalyzeImport(e.ctx, tangent.Scope{}, b22Input(), e.runner); !isCode(err, domain.CodeInvalidInput) {
		t.Fatalf("no tenant: %v", err)
	}
	if len(e.runner.Requests()) != 0 {
		t.Fatalf("the runner was asked %d times", len(e.runner.Requests()))
	}
}

func isCode(err error, code string) bool {
	var e *domain.Error
	return errors.As(err, &e) && e.Code == code
}

func TestB22_RunOnceKeepsTheDispatchersBounds(t *testing.T) {
	e := newEnv(t)
	release := make(chan struct{})
	started := make(chan struct{}, 4)
	blocking := tangent.RunnerFunc(func(ctx context.Context, _ tangent.RunRequest) (tangent.RunResult, error) {
		started <- struct{}{}
		select {
		case <-release:
			return tangent.RunResult{Content: "done"}, nil
		case <-ctx.Done():
			return tangent.RunResult{}, ctx.Err()
		}
	})
	d := tangent.NewRunnerDispatcher(e.engine, blocking, tangent.WithMaxQueue(1), tangent.WithMaxConcurrent(1))
	first := make(chan error, 1)
	go func() {
		_, err := d.RunOnce(e.ctx, tangent.RunRequest{})
		first <- err
	}()
	<-started
	if d.InFlight() != 1 {
		t.Fatalf("in flight = %d", d.InFlight())
	}
	if _, err := d.RunOnce(e.ctx, tangent.RunRequest{}); !errors.Is(err, tangent.ErrDispatcherBusy) {
		t.Fatalf("a second run past the queue: %v", err)
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatalf("the first run: %v", err)
	}
	if got, err := d.RunOnce(e.ctx, tangent.RunRequest{}); err != nil || got.Content != "done" {
		t.Fatalf("a run after the first = %+v, %v", got, err)
	}
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := d.RunOnce(e.ctx, tangent.RunRequest{}); !errors.Is(err, tangent.ErrDispatcherClosed) {
		t.Fatalf("after Close: %v", err)
	}
}

func TestB22_RunOnceHasItsOwnCap(t *testing.T) {
	e := newEnv(t)
	release := make(chan struct{})
	started := make(chan struct{}, 2)
	d := tangent.NewRunnerDispatcher(e.engine, tangent.RunnerFunc(func(context.Context, tangent.RunRequest) (tangent.RunResult, error) {
		started <- struct{}{}
		<-release
		return tangent.RunResult{}, nil
	}), tangent.WithMaxOnce(1))
	t.Cleanup(func() { _ = d.Close() })
	go func() { _, _ = d.RunOnce(e.ctx, tangent.RunRequest{}) }()
	<-started
	if _, err := d.RunOnce(e.ctx, tangent.RunRequest{}); !errors.Is(err, tangent.ErrDispatcherBusy) {
		t.Fatalf("a second RunOnce past WithMaxOnce(1): %v", err)
	}
	close(release)
}

func TestB22_CloseCancelsARunOnce(t *testing.T) {
	e := newEnv(t)
	started := make(chan struct{})
	d := tangent.NewRunnerDispatcher(e.engine, tangent.RunnerFunc(func(ctx context.Context, _ tangent.RunRequest) (tangent.RunResult, error) {
		close(started)
		<-ctx.Done()
		return tangent.RunResult{}, ctx.Err()
	}))
	done := make(chan error, 1)
	go func() {
		_, err := d.RunOnce(e.ctx, tangent.RunRequest{})
		done <- err
	}()
	<-started
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not stop the run")
	}
}
