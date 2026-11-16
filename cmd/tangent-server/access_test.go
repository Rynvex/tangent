package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

const (
	writerToken = "0123456789abcdef0123456789abcdef"
	viewerToken = "fedcba9876543210fedcba9876543210"
)

// gateRequest runs one request through a gate and reports the status and
// the role the API saw.
func gateRequest(g *gate, host, remote, auth string) (int, role) {
	seen := roleNone
	h := g.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = roleOf(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/lines", nil)
	req.Host, req.RemoteAddr = host, remote
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code, seen
}

func TestGate_TokensGiveRoles(t *testing.T) {
	g := newGate(config{Token: writerToken, ViewerToken: viewerToken, RateLimit: 600, RateBurst: 60}, time.Now)
	cases := map[string]struct {
		status int
		role   role
	}{
		"":                            {http.StatusUnauthorized, roleNone},
		"Bearer wrong":                {http.StatusUnauthorized, roleNone},
		writerToken:                   {http.StatusUnauthorized, roleNone},
		"Bearer " + writerToken:       {http.StatusNoContent, roleWriter},
		"Bearer " + viewerToken:       {http.StatusNoContent, roleViewer},
		"Bearer " + writerToken + " ": {http.StatusUnauthorized, roleNone},
	}
	for auth, want := range cases {
		status, got := gateRequest(g, "example.com", "10.0.0.9:1", auth)
		if status != want.status || got != want.role {
			t.Errorf("%q: %d %v, want %d %v", auth, status, got, want.status, want.role)
		}
	}
}

func TestGate_FailedAuthenticationsAreThrottledPerAddress(t *testing.T) {
	now := time.Unix(0, 0)
	g := newGate(config{Token: writerToken, RateLimit: 6000, RateBurst: 1000}, func() time.Time { return now })
	codes := map[int]int{}
	for range 20 {
		status, _ := gateRequest(g, "example.com", "10.0.0.1:1", "Bearer guess")
		codes[status]++
	}
	if codes[http.StatusUnauthorized] != authFailureBurst || codes[http.StatusTooManyRequests] != 20-authFailureBurst {
		t.Fatalf("codes = %v", codes)
	}
	if status, _ := gateRequest(g, "example.com", "10.0.0.2:1", "Bearer guess"); status != http.StatusUnauthorized {
		t.Fatalf("another address has its own budget: %d", status)
	}
	if status, _ := gateRequest(g, "example.com", "10.0.0.1:1", "Bearer "+writerToken); status != http.StatusNoContent {
		t.Fatalf("the right token still works: %d", status)
	}
}

func TestGate_RatesArePerAddressAndPerToken(t *testing.T) {
	now := time.Unix(0, 0)
	g := newGate(config{Token: writerToken, ViewerToken: viewerToken, RateLimit: 60, RateBurst: 2}, func() time.Time { return now })
	gateRequest(g, "h", "10.0.0.1:1", "Bearer "+writerToken)
	gateRequest(g, "h", "10.0.0.2:1", "Bearer "+writerToken)
	if status, _ := gateRequest(g, "h", "10.0.0.3:1", "Bearer "+writerToken); status != http.StatusTooManyRequests {
		t.Fatalf("the writer token's bucket is spent: %d", status)
	}
	if status, _ := gateRequest(g, "h", "10.0.0.4:1", "Bearer "+viewerToken); status != http.StatusNoContent {
		t.Fatalf("the viewer token has its own bucket: %d", status)
	}
	gateRequest(g, "h", "10.0.0.5:1", "Bearer guess")
	gateRequest(g, "h", "10.0.0.5:1", "Bearer guess")
	if status, _ := gateRequest(g, "h", "10.0.0.5:1", "Bearer "+viewerToken); status != http.StatusTooManyRequests {
		t.Fatalf("an address's own rate comes first: %d", status)
	}
}

func TestGate_WithoutATokenOnlyLoopbackHostsAreServed(t *testing.T) {
	g := newGate(config{RateLimit: 600, RateBurst: 60}, time.Now)
	for host, want := range map[string]int{
		"localhost:8120": http.StatusNoContent, "127.0.0.1:8120": http.StatusNoContent, "[::1]:8120": http.StatusNoContent,
		"LOCALHOST": http.StatusNoContent, "evil.example:8120": http.StatusForbidden, "192.168.1.5": http.StatusForbidden,
	} {
		if status, who := gateRequest(g, host, "127.0.0.1:5", ""); status != want || (want == http.StatusNoContent && who != roleWriter) {
			t.Errorf("%s: %d %v", host, status, who)
		}
	}
}

func TestLimiter_RefillsAtTheRateAndSweepsIdleClients(t *testing.T) {
	now := time.Unix(0, 0)
	l := newLimiter(60, 2, func() time.Time { return now })
	for i := 0; i < 2; i++ {
		if ok, _ := l.allow("a"); !ok {
			t.Fatalf("burst request %d refused", i)
		}
	}
	ok, wait := l.allow("a")
	if ok || wait <= 0 || wait > time.Second {
		t.Fatalf("over the burst: ok=%v wait=%v", ok, wait)
	}
	if ok, _ := l.allow("b"); !ok {
		t.Fatal("another client has its own bucket")
	}
	now = now.Add(time.Second)
	if ok, _ := l.allow("a"); !ok {
		t.Fatal("one token a second at 60 a minute")
	}
	now = now.Add(bucketIdle)
	l.allow("c")
	if _, kept := l.buckets["b"]; kept {
		t.Fatal("idle buckets are swept")
	}

	rec := httptest.NewRecorder()
	tooMany(rec, 1500*time.Millisecond)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "2" || !strings.Contains(rec.Body.String(), codeRateLimited) {
		t.Fatalf("429 %d %v %s", rec.Code, rec.Header(), rec.Body)
	}
	if clientIP(&http.Request{RemoteAddr: "weird"}) != "weird" {
		t.Fatal("an address without a port is used as is")
	}
}

// stub is a runner that answers with its name.
type stub string

func (s stub) Run(context.Context, tangent.RunRequest) (tangent.RunResult, error) {
	return tangent.RunResult{Content: string(s)}, nil
}

func TestRoutedRunner_SendsEachRunToItsProvider(t *testing.T) {
	r := routedRunner{runners: map[string]tangent.Runner{"fake": stub("fake"), "openai": stub("openai")}, defaultProvider: "fake"}
	for provider, want := range map[string]string{"": "fake", "OpenAI": "openai", "fake": "fake"} {
		got, err := r.Run(context.Background(), tangent.RunRequest{Provider: provider})
		if err != nil || got.Content != want {
			t.Errorf("%q → %q %v", provider, got.Content, err)
		}
	}
	_, err := r.Run(context.Background(), tangent.RunRequest{Provider: "anthropic"})
	var public *tangent.RunnerError
	if !errors.As(err, &public) || !strings.Contains(public.Public, "anthropic") {
		t.Fatalf("an unconfigured provider fails with a public text: %v", err)
	}
}

func TestBuildRunner_RegistersEveryConfiguredProvider(t *testing.T) {
	r, err := buildRunner(config{Provider: "anthropic", Anthropic: providerConfig{APIKey: "k", Model: "m"}, OpenAI: providerConfig{BaseURL: "http://localhost:11434/v1"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.runners) != 2 || r.runners["anthropic"] == nil || r.runners["openai"] == nil || r.defaultProvider != "anthropic" {
		t.Fatalf("runners = %v", r.runners)
	}
	dev, err := buildRunner(config{Provider: "fake", Dev: true})
	if err != nil || len(dev.runners) != 1 {
		t.Fatalf("dev = %v %v", dev.runners, err)
	}
	reply, err := dev.Run(context.Background(), tangent.RunRequest{OnDelta: func(domain.Delta) {}})
	if err != nil || reply.Content == "" {
		t.Fatalf("the fake answers: %+v %v", reply, err)
	}
	if _, err := buildRunner(config{Provider: "openai", OpenAI: providerConfig{BaseURL: "::bad"}}); err == nil {
		t.Fatal("a bad base URL is refused")
	}
	if _, err := buildRunner(config{Provider: "fake", Anthropic: providerConfig{APIKey: "k", BaseURL: "ftp://x"}}); err == nil {
		t.Fatal("a bad anthropic base URL is refused")
	}
}
