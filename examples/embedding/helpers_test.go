package embedding_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

const (
	tenant = "acme"
	actor  = "alice"
	// settle bounds how long a test waits for a dispatched turn or job.
	settle = 10 * time.Second
	poll   = 20 * time.Millisecond
)

var scope = tangent.Scope{Tenant: tenant, Actor: actor}

func quietLog() *slog.Logger { return slog.New(slog.DiscardHandler) }

// newEngine is an engine over pool with the given options and a quiet log.
func newEngine(t *testing.T, pool *pgxpool.Pool, opts ...tangent.Option) *tangent.Engine {
	t.Helper()
	engine, err := tangent.New(pool, append([]tangent.Option{tangent.WithLogger(quietLog())}, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

// newLine creates a main line.
func newLine(t *testing.T, ctx context.Context, engine *tangent.Engine) string {
	t.Helper()
	line, err := engine.CreateLine(ctx, scope, tangent.LineInput{Title: "Trip"})
	if err != nil {
		t.Fatal(err)
	}
	return line.ID
}

// waitMessage waits until the message is no longer pending and returns it.
func waitMessage(t *testing.T, ctx context.Context, engine *tangent.Engine, lineID, messageID string) domain.Message {
	t.Helper()
	deadline := time.Now().Add(settle)
	for time.Now().Before(deadline) {
		messages, err := engine.ListMessages(ctx, scope, lineID, 0, 500)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range messages {
			if m.ID == messageID && m.Status != domain.MessagePending {
				return m
			}
		}
		time.Sleep(poll)
	}
	t.Fatalf("message %s is still pending after %s", messageID, settle)
	return domain.Message{}
}

// call sends a JSON request and decodes the JSON answer.
func call(t *testing.T, client *http.Client, method, url string, body any, header http.Header) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range header {
		req.Header[k] = v
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("%s %s: not JSON: %s", method, url, raw)
		}
	}
	return resp.StatusCode, out
}
