package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite the server's contract samples in httpapi/testdata/contract")

// serverSamples are the gate's answers the frontend must handle, written
// next to httpapi's samples (route.error.unauthorized and route.error.rate_limited).
func TestContract_ServerSamples(t *testing.T) {
	now := time.Unix(0, 0)
	g := newGate(config{Token: writerToken, RateLimit: 60, RateBurst: 1}, func() time.Time { return now })
	ok := g.wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	send := func(auth string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/lines", nil)
		req.RemoteAddr = "10.0.0.1:1"
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		rec := httptest.NewRecorder()
		ok.ServeHTTP(rec, req)
		return rec
	}
	writeServerSample(t, "route.error.unauthorized", send(""))
	limited := send("Bearer " + writerToken)
	if limited.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d", limited.Code)
	}
	writeServerSample(t, "route.error.rate_limited", limited)
}

func writeServerSample(t *testing.T, name string, rec *httptest.ResponseRecorder) {
	t.Helper()
	var body any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("%s: %s", name, rec.Body)
	}
	sample := map[string]any{"method": http.MethodGet, "path": "/api/lines", "status": rec.Code, "response": body}
	headers := map[string]string{}
	for _, h := range []string{"Retry-After", "WWW-Authenticate"} {
		if v := rec.Header().Get(h); v != "" {
			headers[h] = v
		}
	}
	if len(headers) > 0 {
		sample["headers"] = headers
	}
	got, err := json.MarshalIndent(sample, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	file := filepath.Join("..", "..", "httpapi", "testdata", "contract", name+".json")
	if *update {
		if err := os.WriteFile(file, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(got, want) {
		t.Errorf("sample %s changed or missing (go test ./cmd/tangent-server -update): %v\n%s", name, err, got)
	}
}
