package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// Timeouts of the HTTP server. Event streams clear their own write
// deadline, so WriteTimeout only bounds ordinary responses.
const (
	readHeaderTimeout = 10 * time.Second
	readTimeout       = time.Minute
	writeTimeout      = 2 * time.Minute
	idleTimeout       = 2 * time.Minute
	healthTimeout     = 2 * time.Second
	apiPrefix         = "/api"
)

// app is the assembled server.
type app struct {
	cfg        config
	pool       *pgxpool.Pool
	engine     *tangent.Engine
	dispatcher *tangent.RunnerDispatcher
	hub        *httpapi.Hub
	handler    http.Handler
	log        *slog.Logger

	healthMu sync.Mutex
	healthAt time.Time
	healthOK bool
}

// newApp migrates the schema and wires engine, runner, dispatcher, API,
// health and static files over the pool.
func newApp(ctx context.Context, cfg config, pool *pgxpool.Pool, log *slog.Logger) (*app, error) {
	if err := store.Migrate(ctx, pool); err != nil {
		return nil, fmt.Errorf("migrate the database: %w", err)
	}
	if features := cfg.migratedFeatures(); len(features) > 0 {
		if err := store.MigrateFeatures(ctx, pool, features...); err != nil {
			return nil, fmt.Errorf("migrate the features %s (or leave them out of TANGENT_FEATURES): %w", strings.Join(features, ", "), err)
		}
	}
	runner, err := buildRunner(cfg)
	if err != nil {
		return nil, err
	}
	runner.log = log
	logStartupWarnings(log, cfg)
	logCLIStatus(log, cfg)
	a := &app{
		cfg: cfg, pool: pool, log: log,
		hub: httpapi.NewHub(httpapi.WithHubLogger(log), httpapi.WithMaxStreams(cfg.MaxStreams, cfg.MaxStreams)),
	}
	a.engine, err = tangent.New(pool, tangent.WithFeatures(cfg.Features...), tangent.WithPublisher(a.hub),
		tangent.WithLogger(log), tangent.WithPricing(cfg.Pricing), tangent.WithDefaultModel(cfg.Provider, cfg.defaultModel()),
		tangent.WithModelCheck(cfg.allowModel), tangent.WithModelCatalog(cfg.modelCatalog()...))
	if err != nil {
		return nil, err
	}
	a.dispatcher = tangent.NewRunnerDispatcher(a.engine, runner, tangent.WithTurnTimeout(cfg.TurnTimeout),
		tangent.WithMaxConcurrent(cfg.MaxConcurrent), tangent.WithMaxQueue(cfg.MaxQueue), tangent.WithMaxTenantTurns(cfg.MaxTenantTurns))
	a.engine.SetJobDispatcher(a.dispatcher)
	api, err := httpapi.New(httpapi.Config{
		Engine: a.engine, Dispatcher: a.dispatcher, Hub: a.hub, Logger: log,
		Scope: func(*http.Request) (tangent.Scope, error) {
			return tangent.Scope{Tenant: cfg.Tenant, Actor: cfg.Actor}, nil
		},
		HostMeta: effortMeta(a.engine, tangent.Scope{Tenant: cfg.Tenant, Actor: cfg.Actor}),
		CanWrite: func(r *http.Request) bool { return roleOf(r.Context()) == roleWriter },
	})
	if err != nil {
		return nil, err
	}
	if a.handler, err = a.routes(api); err != nil {
		return nil, err
	}
	return a, nil
}

// routes is /health, the API under /api (token, then rate limit) and the
// optional static demo.
func (a *app) routes(api http.Handler) (http.Handler, error) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", a.health)
	gate := newGate(a.cfg, time.Now)
	mux.Handle(apiPrefix+"/", gate.wrap(http.StripPrefix(apiPrefix, api)))
	if a.cfg.DebugStats {
		mux.Handle("GET /debug/stats", gate.wrap(http.HandlerFunc(a.stats)))
	}
	if a.cfg.StaticDir != "" {
		files, err := newSPA(a.cfg.StaticDir)
		if err != nil {
			return nil, fmt.Errorf("TANGENT_STATIC_DIR: %w", err)
		}
		mux.Handle("/", files)
	}
	return mux, nil
}

// healthCache is how long a health answer is reused, so /health (public)
// cannot be used to load the database.
const healthCache = time.Second

// health reports whether the database answers (cached for a second).
func (a *app) health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if !a.healthy(r.Context()) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"status":"unavailable"}` + "\n"))
		return
	}
	_, _ = w.Write([]byte(`{"status":"ok"}` + "\n"))
}

func (a *app) healthy(ctx context.Context) bool {
	a.healthMu.Lock()
	defer a.healthMu.Unlock()
	if now := time.Now(); now.Sub(a.healthAt) < healthCache {
		return a.healthOK
	}
	pingCtx, cancel := context.WithTimeout(ctx, healthTimeout)
	defer cancel()
	err := a.pool.Ping(pingCtx)
	if err != nil {
		a.log.Warn("tangent-server: health check failed", "error", err)
	}
	a.healthOK, a.healthAt = err == nil, time.Now()
	return a.healthOK
}

// maintain runs Engine.Maintain every interval until ctx ends.
func (a *app) maintain(ctx context.Context) {
	ticker := time.NewTicker(a.cfg.MaintainInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.maintainOnce(ctx)
		}
	}
}

func (a *app) maintainOnce(ctx context.Context) {
	report, err := a.engine.Maintain(ctx)
	if err != nil && ctx.Err() == nil {
		a.log.Error("tangent-server: maintenance failed", "error", err)
	}
	done := report.StaleTurns + report.StaleJobs
	for _, n := range report.Tasks {
		done += n
	}
	if done > 0 {
		a.log.Info("tangent-server: maintenance", "staleTurns", report.StaleTurns, "staleJobs", report.StaleJobs, "tasks", report.Tasks)
	}
}

// serve runs the HTTP server on ln until ctx ends (or the server fails),
// then shuts down: event streams close, requests drain (one budget), then
// running turns and jobs write back (a budget of their own), and the
// maintenance loop has stopped before serve returns.
func (a *app) serve(ctx context.Context, ln net.Listener) error {
	srv := &http.Server{
		Handler: a.handler, ReadHeaderTimeout: readHeaderTimeout, ReadTimeout: readTimeout,
		WriteTimeout: writeTimeout, IdleTimeout: idleTimeout,
		ErrorLog: slog.NewLogLogger(a.log.Handler(), slog.LevelWarn),
	}
	srv.RegisterOnShutdown(a.hub.Close)
	a.maintainOnce(ctx) // what a previous process left behind (stale turns, jobs)
	maintainCtx, stopMaintain := context.WithCancel(ctx)
	maintained := make(chan struct{})
	go func() {
		defer close(maintained)
		a.maintain(maintainCtx)
	}()
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	var serveErr error
	select {
	case serveErr = <-served:
	case <-ctx.Done():
	}
	a.log.Info("tangent-server: shutting down")
	stopMaintain()
	httpErr := a.shutdownHTTP(ctx, srv, served, serveErr != nil)
	runCtx, cancelRuns := context.WithTimeout(context.WithoutCancel(ctx), a.cfg.ShutdownTimeout)
	defer cancelRuns()
	runErr := a.dispatcher.Shutdown(runCtx)
	<-maintained
	return errors.Join(serveErr, httpErr, runErr)
}

// shutdownHTTP stops the HTTP server within its own budget.
func (a *app) shutdownHTTP(ctx context.Context, srv *http.Server, served chan error, alreadyStopped bool) error {
	httpCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), a.cfg.ShutdownTimeout)
	defer cancel()
	err := srv.Shutdown(httpCtx)
	if !alreadyStopped {
		if serveErr := <-served; !errors.Is(serveErr, http.ErrServerClosed) {
			err = errors.Join(err, serveErr)
		}
	}
	return err
}

// run is the whole server: configuration, database, app, serve.
func run(ctx context.Context, getenv func(string) string, log *slog.Logger) error {
	cfg, err := loadConfig(getenv)
	if err != nil {
		return err
	}
	pool, err := connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	a, err := newApp(ctx, cfg, pool, log)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s (TANGENT_ADDR): %w", cfg.Addr, err)
	}
	log.Info("tangent-server: listening", "config", cfg.String(), "url", "http://"+ln.Addr().String())
	logStartupSummary(log, cfg, "http://"+ln.Addr().String())
	return a.serve(ctx, ln)
}

// connect opens the pool and checks the database answers.
func connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("TANGENT_DATABASE_URL is not a valid Postgres URL: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("cannot reach the database (TANGENT_DATABASE_URL, %s): %w", redactURL(url), err)
	}
	return pool, nil
}

// redactURL hides the password of a database URL.
func redactURL(url string) string {
	scheme, rest, ok := strings.Cut(url, "://")
	at := strings.LastIndex(rest, "@")
	if !ok || at < 0 {
		return url
	}
	user, _, _ := strings.Cut(rest[:at], ":")
	return scheme + "://" + user + ":***@" + rest[at+1:]
}
