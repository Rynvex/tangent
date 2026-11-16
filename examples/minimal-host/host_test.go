package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/tangenttest"
)

const (
	keyA = "key-for-tenant-a-0123456789"
	keyB = "key-for-tenant-b-0123456789"
	// settle bounds how long the test waits for a turn or a draft.
	settle = 10 * time.Second
	poll   = 20 * time.Millisecond
)

// client talks to the host as one API key.
type client struct {
	t    *testing.T
	base string
	key  string
}

func (c client) do(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			c.t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		c.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.key != "" {
		req.Header.Set("Authorization", "Bearer "+c.key)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil && err != io.EOF {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	return resp.StatusCode, out
}

// must answers the body when the status is the wanted one.
func (c client) must(want int, method, path string, body any) map[string]any {
	c.t.Helper()
	status, out := c.do(method, path, body)
	if status != want {
		c.t.Fatalf("%s %s: %d %v", method, path, status, out)
	}
	return out
}

// turn sends a message and waits for the reply; it returns the reply.
func (c client) turn(lineID, content string) map[string]any {
	c.t.Helper()
	started := c.must(http.StatusAccepted, "POST", "/api/lines/"+lineID+"/messages", map[string]any{"content": content})
	turnID := started["turnId"].(string)
	deadline := time.Now().Add(settle)
	for time.Now().Before(deadline) {
		page := c.must(http.StatusOK, "GET", "/api/lines/"+lineID+"/messages?limit=500", nil)
		for _, m := range page["messages"].([]any) {
			msg := m.(map[string]any)
			if msg["id"] == turnID && msg["status"] != "pending" {
				if msg["status"] != "done" {
					c.t.Fatalf("turn failed: %v", msg)
				}
				return msg
			}
		}
		time.Sleep(poll)
	}
	c.t.Fatalf("turn %s did not finish", turnID)
	return nil
}

func newTestHost(t *testing.T) *httptest.Server {
	t.Helper()
	ctx := tangenttest.Context(t)
	keys := apiKeys{keyHash(keyA): "tenant-a", keyHash(keyB): "tenant-b"}
	h, err := newHost(ctx, tangenttest.Open(t), keys, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(h.handler)
	t.Cleanup(func() {
		server.Close()
		if err := h.close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return server
}

// TestHost_MainLineTurnBranchMerge is the example's acceptance: a main line,
// a turn, a branch with a turn of its own, a drafted card merged back, and
// the next main-line turn carrying it.
func TestHost_MainLineTurnBranchMerge(t *testing.T) {
	server := newTestHost(t)
	a := client{t: t, base: server.URL, key: keyA}

	line := a.must(http.StatusCreated, "POST", "/api/lines", map[string]any{"title": "Kyoto trip"})
	mainID := line["id"].(string)
	if line["tenantId"] != "tenant-a" || line["provider"] != "fake" {
		t.Fatalf("line: %v", line)
	}
	reply := a.turn(mainID, "When should I visit Kyoto?")

	created := a.must(http.StatusCreated, "POST", "/api/lines/"+mainID+"/branches",
		map[string]any{"anchorMessageId": reply["id"], "purpose": "Ryokan or hotel", "kind": "investigate"})
	branchID := created["line"].(map[string]any)["id"].(string)
	a.turn(branchID, "Is a ryokan worth it?")

	a.must(http.StatusAccepted, "POST", "/api/lines/"+branchID+"/branch/draft", nil)
	var detail map[string]any
	deadline := time.Now().Add(settle)
	for {
		detail = a.must(http.StatusOK, "GET", "/api/lines/"+branchID+"/branch", nil)
		if status := detail["draft"].(map[string]any)["status"]; status == "ready" {
			break
		} else if status == "failed" || time.Now().After(deadline) {
			t.Fatalf("draft: %v", detail["draft"])
		}
		time.Sleep(poll)
	}
	merged := a.must(http.StatusOK, "POST", "/api/lines/"+branchID+"/branch/merge", map[string]any{
		"card":               detail["draft"].(map[string]any)["card"],
		"parentTipMessageId": detail["parentTipMessageId"],
	})
	if merged["branch"].(map[string]any)["status"] != "merged" || merged["message"].(map[string]any)["kind"] != "branch_card" {
		t.Fatalf("merge: %v", merged)
	}

	a.turn(mainID, "So, what did we decide?")
	page := a.must(http.StatusOK, "GET", "/api/lines/"+mainID+"/messages?limit=500", nil)
	delivered := false
	for _, m := range page["messages"].([]any) {
		msg := m.(map[string]any)
		if msg["kind"] == "branch_card" && msg["meta"].(map[string]any)["delivered"] == true {
			delivered = true
		}
	}
	if !delivered {
		t.Fatalf("the card was not delivered to the next turn: %v", page)
	}
}

func TestHost_KeysSeparateTenants(t *testing.T) {
	server := newTestHost(t)
	a := client{t: t, base: server.URL, key: keyA}
	b := client{t: t, base: server.URL, key: keyB}
	anonymous := client{t: t, base: server.URL}
	wrong := client{t: t, base: server.URL, key: "not-a-known-key-at-all"}

	line := a.must(http.StatusCreated, "POST", "/api/lines", map[string]any{"title": "Mine"})
	if status, body := b.do("GET", "/api/lines/"+line["id"].(string), nil); status != http.StatusNotFound || body["code"] != "line_not_found" {
		t.Fatalf("other tenant: %d %v", status, body)
	}
	if lines := b.must(http.StatusOK, "GET", "/api/lines", nil)["lines"].([]any); len(lines) != 0 {
		t.Fatalf("tenant b sees %v", lines)
	}
	for _, c := range []client{anonymous, wrong} {
		if status, body := c.do("GET", "/api/lines", nil); status != http.StatusUnauthorized || body["code"] != "unauthorized" {
			t.Fatalf("key %q: %d %v", c.key, status, body)
		}
	}
	who := a.must(http.StatusOK, "GET", "/whoami", nil)
	if who["tenant"] != "tenant-a" || !strings.HasPrefix(who["actor"].(string), "key:") || strings.Contains(who["actor"].(string), keyA) {
		t.Fatalf("whoami: %v", who)
	}
	if status, _ := anonymous.do("GET", "/whoami", nil); status != http.StatusUnauthorized {
		t.Fatalf("anonymous whoami: %d", status)
	}
	if health := anonymous.must(http.StatusOK, "GET", "/health", nil); health["status"] != "ok" {
		t.Fatalf("health: %v", health)
	}
}

func TestHost_EventsStreamPerTenant(t *testing.T) {
	server := newTestHost(t)
	a := client{t: t, base: server.URL, key: keyA}
	ctx, cancel := context.WithCancel(tangenttest.Context(t))
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+keyA)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("events: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	a.must(http.StatusCreated, "POST", "/api/lines", map[string]any{"title": "Watched"})
	seen := make(chan bool, 1)
	go func() {
		buf := make([]byte, 4096)
		var got strings.Builder
		for {
			n, err := resp.Body.Read(buf)
			got.Write(buf[:n])
			if strings.Contains(got.String(), "event: line.created") {
				seen <- true
				return
			}
			if err != nil {
				seen <- false
				return
			}
		}
	}()
	select {
	case ok := <-seen:
		if !ok {
			t.Fatal("the stream ended without line.created")
		}
	case <-time.After(settle):
		t.Fatal("no line.created event")
	}
}

func TestLoadConfig(t *testing.T) {
	env := func(values map[string]string) func(string) string {
		return func(k string) string { return values[k] }
	}
	cfg, err := loadConfig(env(map[string]string{"EXAMPLE_API_KEYS": "acme:" + keyA + ", beta:" + keyB}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != defaultAddr || cfg.DatabaseURL != defaultDatabaseURL || cfg.Keys[keyHash(keyA)] != "acme" || cfg.Keys[keyHash(keyB)] != "beta" {
		t.Fatalf("config: %+v", cfg)
	}
	for _, keys := range []string{"", "acme", ":" + keyA, "acme:short"} {
		if _, err := loadConfig(env(map[string]string{"EXAMPLE_API_KEYS": keys})); err == nil {
			t.Errorf("EXAMPLE_API_KEYS=%q was accepted", keys)
		}
	}
}

func TestRun_ServesUntilCancelled(t *testing.T) {
	pool := tangenttest.Open(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(tangenttest.Context(t))
	env := map[string]string{"EXAMPLE_DATABASE_URL": tangenttest.SchemaURL(t, pool), "EXAMPLE_ADDR": addr, "EXAMPLE_API_KEYS": "acme:" + keyA}
	done := make(chan error, 1)
	go func() { done <- run(ctx, func(k string) string { return env[k] }, slog.New(slog.DiscardHandler)) }()
	c := client{t: t, base: "http://" + addr, key: keyA}
	deadline := time.Now().Add(settle)
	for {
		resp, err := http.Get(c.base + "/health")
		if err == nil {
			resp.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the host did not start")
		}
		time.Sleep(poll)
	}
	c.must(http.StatusCreated, "POST", "/api/lines", map[string]any{"title": "Served"})
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(settle):
		t.Fatal("run did not stop")
	}
}
