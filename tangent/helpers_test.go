package tangent_test

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

var (
	scopeA = tangent.Scope{Tenant: "tenant-a", Actor: "chang"}
	scopeB = tangent.Scope{Tenant: "tenant-b", Actor: "lee"}
)

// env is one migrated schema with an engine, an event recorder and a fake
// runner.
type env struct {
	t      *testing.T
	ctx    context.Context
	pool   *pgxpool.Pool
	engine *tangent.Engine
	events *tangenttest.Recorder
	runner *tangenttest.FakeRunner
}

// newEnv is an engine with every first-batch feature (AllFeatures).
func newEnv(t *testing.T, opts ...tangent.Option) *env {
	t.Helper()
	return newEnvWith(t, tangent.AllFeatures(), opts...)
}

// newEnvWith is an engine with exactly the given features.
func newEnvWith(t *testing.T, features []tangent.Feature, opts ...tangent.Option) *env {
	t.Helper()
	pool := tangenttest.Open(t)
	events := tangenttest.NewRecorder()
	base := []tangent.Option{
		tangent.WithPublisher(events), tangent.WithLogger(slog.New(slog.DiscardHandler)), tangent.WithFeatures(features...),
	}
	engine, err := tangent.New(pool, append(base, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	return &env{t: t, ctx: tangenttest.Context(t), pool: pool, engine: engine, events: events, runner: tangenttest.NewFakeRunner()}
}

// mainLine creates a main line.
func (e *env) mainLine() domain.LineView {
	e.t.Helper()
	line, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Title: "main", Provider: "anthropic", Model: "sonnet"})
	if err != nil {
		e.t.Fatal(err)
	}
	return line
}

// turn runs one turn with the fake runner answering reply and returns the
// completed turn.
func (e *env) turn(lineID, content, reply string) tangent.CompletedTurn {
	e.t.Helper()
	e.runner.Queue(tangenttest.Reply{Content: reply})
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, lineID, tangent.TurnInput{Content: content})
	if err != nil {
		e.t.Fatal(err)
	}
	done, err := e.engine.RunTurn(e.ctx, turn, e.runner)
	if err != nil {
		e.t.Fatal(err)
	}
	return done
}

// branch opens a branch on the anchor.
func (e *env) branch(parentID, anchorID, purpose string) tangent.CreatedBranch {
	e.t.Helper()
	created, err := e.engine.CreateBranch(e.ctx, scopeA, parentID, tangent.BranchInput{
		AnchorMessageID: anchorID, Purpose: purpose, Kind: domain.BranchKindInvestigate,
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return created
}

func (e *env) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(e.ctx, sql, args...); err != nil {
		e.t.Fatalf("exec %q: %v", sql, err)
	}
}

func (e *env) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(e.ctx, sql, args...).Scan(&n); err != nil {
		e.t.Fatalf("count %q: %v", sql, err)
	}
	return n
}

// wantTypes fails unless the recorded event types are exactly want.
func (e *env) wantTypes(want ...string) {
	e.t.Helper()
	if got := e.events.Types(); !slices.Equal(got, want) {
		e.t.Fatalf("events = %v, want %v", got, want)
	}
}

// wantCode fails unless err carries the domain code.
func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if got := domain.CodeOf(err); got != code {
		t.Fatalf("code = %q (err %v), want %q", got, err, code)
	}
}

var errHook = errors.New("hook says no")

// failHook rolls a write back.
func failHook(context.Context, store.Tx, any) error { return errHook }

// rollsBack runs a write with a failing hook and checks it reported the
// hook's error and published nothing.
func (e *env) rollsBack(name string, write func(opt tangent.TxOption) error) {
	e.t.Helper()
	e.events.Reset()
	if err := write(tangent.InTx(failHook)); !errors.Is(err, errHook) {
		e.t.Fatalf("%s: err = %v, want the hook's error", name, err)
	}
	if got := e.events.Types(); len(got) != 0 {
		e.t.Fatalf("%s: a rolled-back write published %v", name, got)
	}
}
