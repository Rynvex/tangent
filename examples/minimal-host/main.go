// Command minimal-host is a small service that embeds tangent: its own
// routes and API-key authentication, tangent's HTTP API mounted under /api,
// the SSE stream at /api/events and the fake runner. See README.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Defaults and timeouts of the example.
const (
	defaultDatabaseURL = "postgres://tangent:tangent@localhost:5444/tangent_example?sslmode=disable"
	defaultAddr        = "127.0.0.1:8122"
	minKeyLength       = 16
	readHeaderTimeout  = 10 * time.Second
	idleTimeout        = 2 * time.Minute
	shutdownTimeout    = 30 * time.Second
	maintainInterval   = time.Minute
	connectTimeout     = 10 * time.Second
)

// config is read from the environment only.
type config struct {
	DatabaseURL string
	Addr        string
	Keys        apiKeys
}

// loadConfig reads EXAMPLE_DATABASE_URL, EXAMPLE_ADDR and EXAMPLE_API_KEYS
// ("tenant:key,tenant:key"; required, keys at least 16 characters).
func loadConfig(getenv func(string) string) (config, error) {
	cfg := config{DatabaseURL: getenv("EXAMPLE_DATABASE_URL"), Addr: getenv("EXAMPLE_ADDR"), Keys: apiKeys{}}
	if cfg.DatabaseURL == "" {
		cfg.DatabaseURL = defaultDatabaseURL
	}
	if cfg.Addr == "" {
		cfg.Addr = defaultAddr
	}
	for _, pair := range strings.Split(getenv("EXAMPLE_API_KEYS"), ",") {
		if strings.TrimSpace(pair) == "" {
			continue
		}
		tenant, key, ok := strings.Cut(strings.TrimSpace(pair), ":")
		switch {
		case !ok || tenant == "":
			return config{}, errors.New("EXAMPLE_API_KEYS: write tenant:key pairs separated by commas")
		case len(key) < minKeyLength:
			return config{}, fmt.Errorf("EXAMPLE_API_KEYS: the key of %q is shorter than %d characters", tenant, minKeyLength)
		}
		cfg.Keys[keyHash(key)] = tenant
	}
	if len(cfg.Keys) == 0 {
		return config{}, errors.New("EXAMPLE_API_KEYS is required (tenant:key,…); see README.md")
	}
	return cfg, nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(ctx, os.Getenv, log); err != nil {
		fmt.Fprintln(os.Stderr, "minimal-host:", err)
		stop()
		os.Exit(1)
	}
}

// run is the whole service: configuration, database, host, serve.
func run(ctx context.Context, getenv func(string) string, log *slog.Logger) error {
	cfg, err := loadConfig(getenv)
	if err != nil {
		return err
	}
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("EXAMPLE_DATABASE_URL: %w", err)
	}
	defer pool.Close()
	pingCtx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		return fmt.Errorf("cannot reach the database (create it first, see README.md): %w", err)
	}
	h, err := newHost(ctx, pool, cfg.Keys, log)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return err
	}
	log.Info("minimal-host: listening", "url", "http://"+ln.Addr().String(), "tenants", len(cfg.Keys))
	return serve(ctx, h, ln, log)
}

// serve answers on ln and runs the maintenance loop until ctx ends, then
// drains requests and lets running turns write back.
func serve(ctx context.Context, h *host, ln net.Listener, log *slog.Logger) error {
	srv := &http.Server{Handler: h.handler, ReadHeaderTimeout: readHeaderTimeout, IdleTimeout: idleTimeout}
	srv.RegisterOnShutdown(h.hub.Close) // event streams never end on their own
	maintainCtx, stopMaintain := context.WithCancel(ctx)
	maintained := make(chan struct{})
	go func() {
		defer close(maintained)
		maintain(maintainCtx, h, log)
	}()
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	var serveErr error
	select {
	case serveErr = <-served:
	case <-ctx.Done():
	}
	stopMaintain()
	<-maintained
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()
	httpErr := srv.Shutdown(stopCtx)
	if errors.Is(serveErr, http.ErrServerClosed) {
		serveErr = nil
	}
	return errors.Join(serveErr, httpErr, h.close(stopCtx))
}

// maintain fails stale turns and jobs and purges expired asides (the
// library never runs timers of its own).
func maintain(ctx context.Context, h *host, log *slog.Logger) {
	ticker := time.NewTicker(maintainInterval)
	defer ticker.Stop()
	for {
		if _, err := h.engine.Maintain(ctx); err != nil && ctx.Err() == nil {
			log.Error("minimal-host: maintenance failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
