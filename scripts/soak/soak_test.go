package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

const testToken = "soak-test-token"

// fullFeatures is every feature as scripts/soak.sh turns them on (the
// modes that change behaviour in auto run in auto; ibis stays in suggest so
// its drafts can be confirmed; memory with the fake Embedder).
func fullFeatures() []tangent.Feature {
	return []tangent.Feature{
		tangent.Notes(), tangent.Chapters(), tangent.Aside(), tangent.Summary(tangent.ModeAuto), tangent.CardDraft(),
		tangent.BranchSuggest(tangent.ModeAuto), tangent.Search(), tangent.Leaf(tangent.ModeAuto), tangent.Parking(), tangent.Spinoff(),
		tangent.Rebalance(tangent.ModeAuto), tangent.Goal(tangent.ModeAuto), tangent.Relations(tangent.ModeAuto), tangent.OpenLoops(),
		tangent.Fisheye(), tangent.Group(tangent.ModeAuto), tangent.Ibis(tangent.ModeSuggest), tangent.Fold(tangent.ModeAuto),
		tangent.Diverge(tangent.ModeManual), tangent.Memory(tangent.ModeSuggest, tangent.MemoryConfig{Embedder: fake.NewEmbedder(0)}),
	}
}

// testServer is the API (every feature, search and memory included) behind
// a bearer token, a fake runner and a stand-in for the reference server's
// stats.
func testServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	pool := tangenttest.OpenFeatures(t, tangent.FeatureSearch, tangent.FeatureMemory)
	hub := httpapi.NewHub()
	t.Cleanup(hub.Close)
	engine, err := tangent.New(pool, tangent.WithPublisher(hub), tangent.WithLogger(slog.New(slog.DiscardHandler)),
		tangent.WithFeatures(fullFeatures()...))
	if err != nil {
		t.Fatal(err)
	}
	runner := fake.New(fake.Config{ChunkDelay: time.Millisecond, SlowDelay: 20 * time.Millisecond, MaxWait: 50 * time.Millisecond})
	dispatcher := tangent.NewRunnerDispatcher(engine, runner)
	engine.SetJobDispatcher(dispatcher)
	t.Cleanup(func() { _ = dispatcher.Close() })
	api, err := httpapi.New(httpapi.Config{
		Engine: engine, Dispatcher: dispatcher, Hub: hub, Logger: slog.New(slog.DiscardHandler),
		Scope: func(r *http.Request) (tangent.Scope, error) {
			if r.Header.Get("Authorization") != "Bearer "+testToken {
				return tangent.Scope{}, http.ErrNoCookie
			}
			return tangent.Scope{Tenant: "soak", Actor: "driver"}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/api/", http.StripPrefix("/api", api))
	mux.HandleFunc("GET /debug/stats", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"goroutines": 1, "inFlight": dispatcher.InFlight(), "streams": hub.Clients()})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	var schema string
	if err := pool.QueryRow(tangenttest.Context(t), "SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	return server, tangenttest.URL() + "&search_path=" + schema + ",public"
}

func TestRun_AShortSoakPassesItsChecks(t *testing.T) {
	server, database := testServer(t)
	dir := t.TempDir()
	tokenFile := filepath.Join(dir, "token")
	if err := os.WriteFile(tokenFile, []byte(testToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := run(context.Background(), options{
		base: server.URL, tokenFile: tokenFile, databaseURL: database, report: filepath.Join(dir, "report.json"),
		duration: 3 * time.Second, sample: time.Second, settle: 20 * time.Second, workers: 3, seed: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !report.Passed || report.Outcomes["turn started"] == 0 || report.Events["message.delta"] == 0 || len(report.Samples) < 3 {
		t.Fatalf("report: passed=%v outcomes=%v events=%v checks=%v violations=%v failures=%v",
			report.Passed, report.Outcomes, report.Events, report.Checks, report.Violations, report.Failures)
	}
	if len(report.Features) < len(fullFeatures()) || !report.Features.on("memory") || len(report.Operations) < 10 {
		t.Fatalf("the short soak saw features %v and ran %d operations: %v", report.Features, len(report.Operations), report.Operations)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "report.json"))
	if err != nil || !strings.Contains(string(raw), `"passed": true`) {
		t.Fatalf("the report file: %v", err)
	}
	if _, err := run(context.Background(), options{tokenFile: filepath.Join(dir, "missing")}); err == nil {
		t.Fatal("a missing token file is an error")
	}
}

func TestReadEvents_ParsesTheStream(t *testing.T) {
	stream := ": connected\n\nevent: message.delta\ndata: {\"a\":\ndata: 1}\n\nevent: line.updated\ndata: {}\n\n"
	var got []string
	err := readEvents(strings.NewReader(stream), func(eventType string, data []byte) { got = append(got, eventType+"="+string(data)) })
	if len(got) != 2 || got[0] != "message.delta={\"a\":\n1}" || err == nil {
		t.Fatalf("events %q, err %v", got, err)
	}
	if truncate("abcdef", 3) != "abc…" || truncate("ab", 3) != "ab" || total(map[string]int{"a": 1, "b": 2}) != 3 {
		t.Fatal("helpers")
	}
}
