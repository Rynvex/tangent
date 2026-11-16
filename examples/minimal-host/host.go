package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// apiPrefix is where the host mounts tangent's API.
const apiPrefix = "/api"

// apiKeys maps the SHA-256 of an API key to its tenant. Keys are compared
// by their hash, so a lookup never compares the secret itself.
type apiKeys map[string]string

// errNoKey is answered as 401 unauthorized by httpapi (any error that is not
// a domain error is).
var errNoKey = errors.New("missing or unknown API key")

// keyHash is the lookup form of a key.
func keyHash(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// scope is the host's authentication, plugged into httpapi.Config.Scope:
// "Authorization: Bearer <key>" names the tenant. The actor is a short,
// non-secret fingerprint of the key.
func (k apiKeys) scope(r *http.Request) (tangent.Scope, error) {
	key, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || key == "" {
		return tangent.Scope{}, errNoKey
	}
	hash := keyHash(key)
	tenant, ok := k[hash]
	if !ok {
		return tangent.Scope{}, errNoKey
	}
	return tangent.Scope{Tenant: tenant, Actor: "key:" + hash[:8]}, nil
}

// host is the example service: its own routes, its own authentication, and
// tangent's API mounted under /api.
type host struct {
	engine     *tangent.Engine
	dispatcher *tangent.RunnerDispatcher
	hub        *httpapi.Hub
	keys       apiKeys
	pool       *pgxpool.Pool
	handler    http.Handler
}

// newHost migrates the schema and wires engine, runner, dispatcher and API.
func newHost(ctx context.Context, pool *pgxpool.Pool, keys apiKeys, log *slog.Logger) (*host, error) {
	if err := store.Migrate(ctx, pool); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	h := &host{keys: keys, pool: pool, hub: httpapi.NewHub(httpapi.WithHubLogger(log))}
	engine, err := tangent.New(pool,
		tangent.WithFeatures(tangent.AllFeatures()...),
		tangent.WithPublisher(h.hub),
		tangent.WithLogger(log),
		tangent.WithDefaultModel("fake", fake.DefaultModel),
	)
	if err != nil {
		return nil, err
	}
	h.engine = engine
	// The fake runner echoes the operator and writes valid cards and summaries;
	// a real host passes runner/openai or runner/anthropic here.
	h.dispatcher = tangent.NewRunnerDispatcher(engine, fake.New(fake.Config{}))
	engine.SetJobDispatcher(h.dispatcher)
	api, err := httpapi.New(httpapi.Config{
		Engine: engine, Dispatcher: h.dispatcher, Hub: h.hub, Logger: log, Scope: keys.scope,
	})
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", h.health)
	mux.HandleFunc("GET /whoami", h.whoami)
	mux.Handle(apiPrefix+"/", http.StripPrefix(apiPrefix, api))
	h.handler = mux
	return h, nil
}

// health is public: it only says whether the database answers.
func (h *host) health(w http.ResponseWriter, r *http.Request) {
	if err := h.pool.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// whoami is one of the host's own routes, behind the same key check.
func (h *host) whoami(w http.ResponseWriter, r *http.Request) {
	scope, err := h.keys.scope(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error(), "code": "unauthorized"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"tenant": scope.Tenant, "actor": scope.Actor})
}

// close ends the event streams and waits for running turns and jobs to
// write their outcome back (they are cancelled when ctx ends first).
func (h *host) close(ctx context.Context) error {
	h.hub.Close()
	return h.dispatcher.Shutdown(ctx)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
