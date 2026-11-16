package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

const testToken = writerToken

func testConfig(t *testing.T, mutate ...func(*config)) config {
	t.Helper()
	cfg, err := loadConfig(env{"TANGENT_TOKEN": testToken, "TANGENT_PROVIDER": "fake", "TANGENT_ADDR": "127.0.0.1:0"}.get)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ShutdownTimeout = 5 * time.Second
	for _, m := range mutate {
		m(&cfg)
	}
	return cfg
}

// running is an app served on a random port.
type running struct {
	t    *testing.T
	app  *app
	url  string
	stop context.CancelFunc
	done chan error
}

func start(t *testing.T, cfg config) *running {
	t.Helper()
	pool := tangenttest.OpenFeatures(t, tangent.FeatureSearch)
	log := slog.New(slog.DiscardHandler)
	a, err := newApp(tangenttest.Context(t), cfg, pool, log)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	r := &running{t: t, app: a, url: "http://" + ln.Addr().String(), stop: stop, done: make(chan error, 1)}
	go func() { r.done <- a.serve(ctx, ln) }()
	t.Cleanup(func() { r.shutdown() })
	return r
}

func (r *running) shutdown() error {
	r.stop()
	select {
	case err := <-r.done:
		r.done <- err
		return err
	case <-time.After(10 * time.Second):
		r.t.Fatal("the server did not shut down")
		return nil
	}
}

func (r *running) request(method, path, body string, token string) (int, string) {
	r.t.Helper()
	req, err := http.NewRequest(method, r.url+path, strings.NewReader(body))
	if err != nil {
		r.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(raw)
}

func TestServer_ServesTheAPIBehindTheTokenAndRunsTurns(t *testing.T) {
	r := start(t, testConfig(t))
	if status, body := r.request(http.MethodGet, "/health", "", ""); status != http.StatusOK || !strings.Contains(body, `"ok"`) {
		t.Fatalf("health %d %s", status, body)
	}
	if status, _ := r.request(http.MethodGet, "/api/lines", "", ""); status != http.StatusUnauthorized {
		t.Fatalf("no token: %d", status)
	}
	status, body := r.request(http.MethodPost, "/api/lines", `{"title":"t"}`, testToken)
	if status != http.StatusCreated {
		t.Fatalf("create %d %s", status, body)
	}
	var line struct{ ID string }
	_ = json.Unmarshal([]byte(body), &line)
	if status, body = r.request(http.MethodPost, "/api/lines/"+line.ID+"/messages", `{"content":"hello"}`, testToken); status != http.StatusAccepted {
		t.Fatalf("send %d %s", status, body)
	}
	r.app.dispatcher.Wait()
	_, body = r.request(http.MethodGet, "/api/lines/"+line.ID+"/messages", "", testToken)
	if !strings.Contains(body, "Fake reply to: hello") {
		t.Fatalf("the fake runner answered: %s", body)
	}
	if status, _ := r.request(http.MethodGet, "/", "", ""); status != http.StatusNotFound {
		t.Fatalf("no static dir, no UI: %d", status)
	}
	r.app.maintainOnce(context.Background())
	if err := r.shutdown(); err != nil {
		t.Fatalf("graceful shutdown: %v", err)
	}
}

func TestServer_ShutdownEndsEventStreams(t *testing.T) {
	r := start(t, testConfig(t))
	req, _ := http.NewRequest(http.MethodGet, r.url+"/api/events", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("events %d", resp.StatusCode)
	}
	ended := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		close(ended)
	}()
	if err := r.shutdown(); err != nil {
		t.Fatalf("shutdown with an open stream: %v", err)
	}
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream outlived the server")
	}
}

func TestServer_ServesTheDemoWithAnSPAFallback(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>demo</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "app.js"), []byte("console.log(1)"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(dir, "leak.txt")); err != nil {
		t.Fatal(err)
	}
	r := start(t, testConfig(t, func(c *config) { c.StaticDir = dir }))
	for path, want := range map[string]string{"/": "demo", "/assets/app.js": "console.log", "/lines/abc": "demo", "/leak.txt": "demo", "/assets": "demo"} {
		if status, body := r.request(http.MethodGet, path, "", ""); status != http.StatusOK || !strings.Contains(body, want) {
			t.Errorf("%s: %d %q", path, status, body)
		}
	}
	if status, _ := r.request(http.MethodGet, "/api/lines", "", ""); status != http.StatusUnauthorized {
		t.Fatalf("the API stays behind the token: %d", status)
	}
	checkStaticHardening(t, r, dir)
}

// checkStaticHardening: methods, dot segments, security headers.
func checkStaticHardening(t *testing.T, r *running, dir string) {
	t.Helper()
	if status, _ := r.request(http.MethodPost, "/assets/app.js", "", ""); status != http.StatusMethodNotAllowed {
		t.Errorf("POST to a file: %d", status)
	}
	raw, err := net.Dial("tcp", strings.TrimPrefix(r.url, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	_, _ = io.WriteString(raw, "GET /assets/../../etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
	reply, _ := io.ReadAll(raw)
	// The mux redirects to the cleaned path before the handler sees it; the
	// handler refuses dot segments itself too (hasDotSegment).
	if strings.Contains(string(reply), "root:") {
		t.Errorf("a file outside the root leaked: %q", reply)
	}
	if !hasDotSegment("/a/../b") || !hasDotSegment("./x") || hasDotSegment("/a/..b/c") {
		t.Error("hasDotSegment")
	}
	rec := httptest.NewRecorder()
	files, err := newSPA(dir)
	if err != nil {
		t.Fatal(err)
	}
	files.ServeHTTP(rec, &http.Request{Method: http.MethodGet, URL: &url.URL{Path: "/assets/../index.html"}, Header: http.Header{}})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("a dot segment that reaches the handler: %d", rec.Code)
	}
	if _, err := newSPA(filepath.Join(dir, "missing")); err == nil {
		t.Error("a missing static dir is refused")
	}
	resp, err := http.Get(r.url + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	for _, name := range []string{"Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options"} {
		if resp.Header.Get(name) == "" {
			t.Errorf("missing %s", name)
		}
	}
	if !strings.Contains(resp.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Error("frame-ancestors")
	}
}

func TestRun_ExplainsWhatIsMissing(t *testing.T) {
	log := slog.New(slog.DiscardHandler)
	if err := run(context.Background(), env{}.get, log); err == nil || !strings.Contains(err.Error(), "TANGENT_TOKEN") {
		t.Fatalf("err = %v", err)
	}
	bad := env{"TANGENT_DEV": "1", "TANGENT_DATABASE_URL": "postgres://u:secret@127.0.0.1:1/x?connect_timeout=1"}
	err := run(context.Background(), bad.get, log)
	if err == nil || !strings.Contains(err.Error(), "cannot reach the database") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("err = %v", err)
	}
	if err := run(context.Background(), env{"TANGENT_DEV": "1", "TANGENT_DATABASE_URL": "::"}.get, log); err == nil {
		t.Fatal("a bad URL is refused")
	}
	if redactURL("no-scheme") != "no-scheme" || redactURL("postgres://h/db") != "postgres://h/db" {
		t.Fatal("URLs without a password stay as they are")
	}
	if logLevel("debug") != slog.LevelDebug || logLevel("nonsense") != slog.LevelInfo {
		t.Fatal("log levels")
	}
}

func TestRun_ServesUntilTheContextEnds(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	// A schema of its own, so the server's migration touches nothing else.
	pool := tangenttest.OpenFeatures(t, tangent.FeatureSearch)
	var schema string
	if err := pool.QueryRow(tangenttest.Context(t), "SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	vars := env{"TANGENT_DEV": "1", "TANGENT_ADDR": addr, "TANGENT_DATABASE_URL": tangenttest.URL() + "&search_path=" + schema + ",public"}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx, vars.get, slog.New(slog.DiscardHandler)) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		resp, err := http.Get("http://" + addr + "/health")
		if err == nil {
			resp.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server did not come up: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("run = %v", err)
	}
}

func TestServer_TheViewerTokenOnlyReads(t *testing.T) {
	r := start(t, testConfig(t, func(c *config) { c.ViewerToken = viewerToken }))
	if status, body := r.request(http.MethodPost, "/api/lines", `{"title":"t"}`, viewerToken); status != http.StatusForbidden || !strings.Contains(body, "forbidden") {
		t.Fatalf("viewer write: %d %s", status, body)
	}
	if status, body := r.request(http.MethodGet, "/api/capabilities", "", viewerToken); status != http.StatusOK || !strings.Contains(body, `"canWrite":false`) {
		t.Fatalf("viewer capabilities: %d %s", status, body)
	}
	if _, body := r.request(http.MethodGet, "/api/capabilities", "", testToken); !strings.Contains(body, `"canWrite":true`) {
		t.Fatalf("writer capabilities: %s", body)
	}
}

func TestServer_NewLinesTakeTheDefaultModelAndTheAllowlist(t *testing.T) {
	r := start(t, testConfig(t, func(c *config) {
		c.Provider, c.OpenAI = providerOpenAI, providerConfig{BaseURL: "http://127.0.0.1:1/v1", Model: "gpt-x"}
		c.AllowedModels = map[modelRef]bool{{providerOpenAI, "gpt-x"}: true}
	}))
	status, body := r.request(http.MethodPost, "/api/lines", `{"title":"t"}`, testToken)
	if status != http.StatusCreated || !strings.Contains(body, `"provider":"openai"`) || !strings.Contains(body, `"model":"gpt-x"`) {
		t.Fatalf("create: %d %s", status, body)
	}
	if status, body = r.request(http.MethodPost, "/api/lines", `{"provider":"openai","model":"gpt-expensive"}`, testToken); status != http.StatusUnprocessableEntity {
		t.Fatalf("a model outside the list: %d %s", status, body)
	}
}

func TestServer_HealthIsCached(t *testing.T) {
	r := start(t, testConfig(t))
	r.request(http.MethodGet, "/health", "", "")
	at := r.app.healthAt
	r.request(http.MethodGet, "/health", "", "")
	if !r.app.healthAt.Equal(at) {
		t.Fatal("a second check within a second reuses the answer")
	}
	r.app.pool.Close()
	r.app.healthAt = time.Time{}
	if status, body := r.request(http.MethodGet, "/health", "", ""); status != http.StatusServiceUnavailable || !strings.Contains(body, "unavailable") {
		t.Fatalf("a closed pool: %d %s", status, body)
	}
}

func TestServe_MaintainsAtStartupAndShutsDownAfterAServeFailure(t *testing.T) {
	pool := tangenttest.OpenFeatures(t, tangent.FeatureSearch)
	ctx := tangenttest.Context(t)
	a, err := newApp(ctx, testConfig(t), pool, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	scope := tangent.Scope{Tenant: a.cfg.Tenant}
	line, err := a.engine.CreateLine(ctx, scope, tangent.LineInput{})
	if err != nil {
		t.Fatal(err)
	}
	turn, err := a.engine.BeginTurn(ctx, scope, line.ID, tangent.TurnInput{Content: "stuck"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tangent_message SET created_at = now() - interval '1 hour' WHERE id = $1`, turn.ID); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_ = ln.Close() // Serve fails at once
	if err := a.serve(context.Background(), ln); err == nil {
		t.Fatal("a failed Serve is reported")
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM tangent_message WHERE id = $1`, turn.ID).Scan(&status); err != nil || status != "error" {
		t.Fatalf("the startup maintenance failed the stale turn: %q %v", status, err)
	}
	if err := a.dispatcher.DispatchTurn(ctx, turn); !errors.Is(err, tangent.ErrDispatcherClosed) {
		t.Fatalf("the dispatcher is shut down too: %v", err)
	}
}
