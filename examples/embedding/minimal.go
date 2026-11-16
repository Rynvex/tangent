// Package embedding holds the code samples of docs/EMBEDDING.md. Every
// sample is real, compiled code: the regions between "// snippet:<name>"
// and "// endsnippet" are quoted in the guide verbatim, and
// TestGuideSnippets fails when the two drift apart.
package embedding

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// snippet:minimal
func Mount(ctx context.Context, mux *http.ServeMux, pool *pgxpool.Pool) (*tangent.RunnerDispatcher, error) {
	if err := store.Migrate(ctx, pool); err != nil {
		return nil, err
	}
	engine, err := tangent.New(pool, tangent.WithFeatures(tangent.AllFeatures()...))
	if err != nil {
		return nil, err
	}
	dispatcher := tangent.NewRunnerDispatcher(engine, fake.New(fake.Config{}))
	api, err := httpapi.New(httpapi.Config{
		Engine: engine, Dispatcher: dispatcher,
		Scope: func(*http.Request) (tangent.Scope, error) { return tangent.Scope{Tenant: "demo"}, nil },
	})
	if err != nil {
		return nil, err
	}
	mux.Handle("/api/", http.StripPrefix("/api", api))
	return dispatcher, nil
}

// endsnippet

// shutdownBudget bounds how long Serve waits for requests and runs to end.
const shutdownBudget = 30 * time.Second

// snippet:minimal-serve
func Serve(ctx context.Context, databaseURL, addr string) error {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	mux := http.NewServeMux()
	dispatcher, err := Mount(ctx, mux, pool)
	if err != nil {
		return err
	}
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- srv.ListenAndServe() }()
	select {
	case err := <-served: // the listener failed (for example the port is taken)
		return errors.Join(err, dispatcher.Close())
	case <-ctx.Done():
	}
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownBudget)
	defer cancel()
	// Requests drain first, then running turns and jobs write their outcome back.
	return errors.Join(srv.Shutdown(stopCtx), dispatcher.Shutdown(stopCtx))
}

// endsnippet
