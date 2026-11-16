package httpstream

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

// fakeClock records sleeps instead of waiting.
type fakeClock struct {
	now    time.Time
	sleeps []time.Duration
}

func (c *fakeClock) policy(retries int) Policy {
	return Policy{
		MaxRetries: retries, BaseDelay: time.Second, MaxDelay: 8 * time.Second, MaxRetryAfter: time.Minute,
		Now:    func() time.Time { return c.now },
		Jitter: func() float64 { return 1 },
		Sleep: func(ctx context.Context, d time.Duration) error {
			c.sleeps = append(c.sleeps, d)
			c.now = c.now.Add(d)
			return ctx.Err()
		},
	}
}

// statuses answers each request with the next status (the last repeats).
func statuses(t *testing.T, header http.Header, codes ...int) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := int(calls.Add(1)) - 1
		code := codes[min(n, len(codes)-1)]
		for k, v := range header {
			w.Header()[k] = v
		}
		w.WriteHeader(code)
		_, _ = w.Write([]byte(`{"error":{"type":"x","message":"m"}}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func get(url string) func(context.Context) (*http.Request, error) {
	return func(ctx context.Context) (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	}
}

func TestSend_RetriesRateLimitsAndServerErrorsWithBackoff(t *testing.T) {
	srv, calls := statuses(t, nil, 503, 500, 429, 200)
	clock := &fakeClock{now: time.Unix(1000, 0)}
	var retries []tangent.Retry
	resp, err := Send(context.Background(), srv.Client(), get(srv.URL), clock.policy(3), func(r tangent.Retry) { retries = append(retries, r) })
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || calls.Load() != 4 {
		t.Fatalf("status %d after %d calls", resp.StatusCode, calls.Load())
	}
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}
	if len(clock.sleeps) != 3 || clock.sleeps[0] != want[0] || clock.sleeps[1] != want[1] || clock.sleeps[2] != want[2] {
		t.Fatalf("sleeps = %v, want %v", clock.sleeps, want)
	}
	if len(retries) != 3 || retries[0].Attempt != 1 || retries[2].Attempt != 3 || retries[0].MaxAttempts != 4 {
		t.Fatalf("retries = %+v", retries)
	}
	if !retries[0].NextRetryAt.Equal(time.Unix(1001, 0)) {
		t.Fatalf("next retry at %v", retries[0].NextRetryAt)
	}
}

func TestSend_HonoursRetryAfterAndGivesUpWhenItIsTooLong(t *testing.T) {
	srv, calls := statuses(t, http.Header{"Retry-After": {"7"}}, 429, 200)
	clock := &fakeClock{now: time.Unix(1000, 0)}
	resp, err := Send(context.Background(), srv.Client(), get(srv.URL), clock.policy(2), nil)
	if err != nil || resp.StatusCode != 200 || len(clock.sleeps) != 1 || clock.sleeps[0] != 7700*time.Millisecond {
		t.Fatalf("resp %v err %v sleeps %v", resp, err, clock.sleeps)
	}
	_ = resp.Body.Close()

	date := time.Unix(1000, 0).Add(20 * time.Second).UTC().Format(http.TimeFormat)
	srv, _ = statuses(t, http.Header{"Retry-After": {date}}, 503, 200)
	clock = &fakeClock{now: time.Unix(1000, 0)}
	resp, err = Send(context.Background(), srv.Client(), get(srv.URL), clock.policy(2), nil)
	if err != nil || resp.StatusCode != 200 || clock.sleeps[0] != 22*time.Second {
		t.Fatalf("an HTTP date is honoured: %v %v", clock.sleeps, err)
	}
	_ = resp.Body.Close()

	srv, calls = statuses(t, http.Header{"Retry-After": {strconv.Itoa(3600)}}, 429)
	clock = &fakeClock{now: time.Unix(1000, 0)}
	resp, err = Send(context.Background(), srv.Client(), get(srv.URL), clock.policy(2), nil)
	if err != nil || resp.StatusCode != 429 || calls.Load() != 1 || len(clock.sleeps) != 0 {
		t.Fatalf("a wait beyond MaxRetryAfter is not taken: %v calls %d", err, calls.Load())
	}
	_ = resp.Body.Close()
}

func TestSend_DoesNotRetryOtherFailuresAndStopsAfterTheLastAttempt(t *testing.T) {
	srv, calls := statuses(t, nil, 400)
	clock := &fakeClock{}
	resp, err := Send(context.Background(), srv.Client(), get(srv.URL), clock.policy(3), nil)
	if err != nil || resp.StatusCode != 400 || calls.Load() != 1 {
		t.Fatalf("400 is final: %v %d", err, calls.Load())
	}
	_ = resp.Body.Close()
	srv, calls = statuses(t, nil, 502)
	resp, err = Send(context.Background(), srv.Client(), get(srv.URL), clock.policy(2), nil)
	if err != nil || resp.StatusCode != 502 || calls.Load() != 3 {
		t.Fatalf("gives up after 3 attempts: %v %d", err, calls.Load())
	}
	_ = resp.Body.Close()
}

func TestSend_ACancelledWaitEndsWithTheContext(t *testing.T) {
	srv, _ := statuses(t, nil, 503)
	ctx, cancel := context.WithCancel(context.Background())
	p := (&fakeClock{}).policy(3)
	p.Sleep = func(ctx context.Context, d time.Duration) error {
		cancel()
		return sleepCtx(ctx, d)
	}
	_, err := Send(ctx, srv.Client(), get(srv.URL), p, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if _, err := Send(context.Background(), srv.Client(), func(context.Context) (*http.Request, error) { return nil, errors.New("bad") }, p, nil); err == nil {
		t.Fatal("a request that cannot be built fails")
	}
}

func TestPolicy_DefaultsAndJitterStayWithinTheCap(t *testing.T) {
	p := Policy{}.withDefaults()
	if p.MaxRetries != DefaultMaxRetries || p.BaseDelay <= 0 || p.MaxDelay < p.BaseDelay || p.Sleep == nil || p.Now == nil || p.Jitter == nil {
		t.Fatalf("defaults = %+v", p)
	}
	none := Policy{MaxRetries: -1}.withDefaults()
	if none.MaxRetries != 0 {
		t.Fatalf("a negative count disables retries: %d", none.MaxRetries)
	}
	p.Jitter = func() float64 { return 0 }
	for attempt := 1; attempt < 12; attempt++ {
		if d := p.backoff(attempt); d < p.BaseDelay/2 || d > p.MaxDelay {
			t.Fatalf("attempt %d: %v", attempt, d)
		}
	}
	if err := sleepCtx(context.Background(), time.Millisecond); err != nil {
		t.Fatal(err)
	}
}

func TestSend_OnlyTheUsualStatusesAreRetriedAndNoRetryCanRefuse(t *testing.T) {
	srv, calls := statuses(t, nil, 501)
	clock := &fakeClock{}
	resp, err := Send(context.Background(), srv.Client(), get(srv.URL), clock.policy(3), nil)
	if err != nil || resp.StatusCode != 501 || calls.Load() != 1 {
		t.Fatalf("501 is final: %v %d", err, calls.Load())
	}
	_ = resp.Body.Close()
	srv, calls = statuses(t, nil, 529, 200)
	p := clock.policy(3)
	p.ExtraRetryable = []int{529}
	if resp, err = Send(context.Background(), srv.Client(), get(srv.URL), p, nil); err != nil || resp.StatusCode != 200 || calls.Load() != 2 {
		t.Fatalf("an extra status is retried: %v %d", err, calls.Load())
	}
	_ = resp.Body.Close()
	srv, calls = statuses(t, nil, 429)
	p = clock.policy(3)
	p.NoRetry = func(status int, body []byte) bool { return status == 429 && bytes.Contains(body, []byte(`"type":"x"`)) }
	resp, err = Send(context.Background(), srv.Client(), get(srv.URL), p, nil)
	if err != nil || resp.StatusCode != 429 || calls.Load() != 1 {
		t.Fatalf("NoRetry refuses: %v %d", err, calls.Load())
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if !strings.Contains(string(body), `"message":"m"`) {
		t.Fatalf("the peeked body is still readable: %q", body)
	}
}

func TestSend_RetriesTransportErrorsUntilTheLastAttempt(t *testing.T) {
	srv, _ := statuses(t, nil, 200)
	addr := srv.URL
	srv.Close()
	clock := &fakeClock{}
	retries := 0
	_, err := Send(context.Background(), &http.Client{}, get(addr), clock.policy(2), func(tangent.Retry) { retries++ })
	if err == nil || retries != 2 || len(clock.sleeps) != 2 {
		t.Fatalf("err %v retries %d", err, retries)
	}
}

func TestRetryAfter_NeverOverflowsAndClamps(t *testing.T) {
	now := time.Unix(1000, 0)
	cases := map[string]time.Duration{
		"99999999999999999999": time.Minute + time.Second, "9223372036": time.Minute + time.Second,
		"-5": 0, "-99999999999999999999": 0, "30": 30 * time.Second,
	}
	for value, want := range cases {
		got, ok := retryAfter(value, now, time.Minute)
		if !ok || got != want {
			t.Errorf("%s: %v %v, want %v", value, got, ok, want)
		}
	}
	far := now.Add(1000 * time.Hour).UTC().Format(http.TimeFormat)
	if got, _ := retryAfter(far, now, time.Minute); got != time.Minute+time.Second {
		t.Errorf("a far date: %v", got)
	}
	if _, ok := retryAfter("soon", now, time.Minute); ok {
		t.Error("garbage is ignored")
	}
	p := (&fakeClock{}).policy(1)
	p.Jitter = func() float64 { return 0 }
	resp := &http.Response{Header: http.Header{"Retry-After": {"60"}}}
	if wait, ok := p.wait(resp, 1); !ok || wait != time.Minute {
		t.Errorf("a wait at the limit: %v %v", wait, ok)
	}
	p.Jitter = func() float64 { return 1 }
	if wait, _ := p.wait(resp, 1); wait != time.Minute {
		t.Errorf("jitter never goes past MaxRetryAfter: %v", wait)
	}
}

func TestBackoff_JitterKeepsHalfTheDelay(t *testing.T) {
	p := Policy{BaseDelay: time.Second, MaxDelay: 8 * time.Second}.withDefaults()
	p.Jitter = func() float64 { return 0 }
	if got := p.backoff(3); got != 2*time.Second {
		t.Fatalf("lower bound = %v, want half of 4s", got)
	}
	p.Jitter = func() float64 { return 0.999999 }
	if got := p.backoff(30); got > p.MaxDelay || got < p.MaxDelay/2 {
		t.Fatalf("capped = %v", got)
	}
}
