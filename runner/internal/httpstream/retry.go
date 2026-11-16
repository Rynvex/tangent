package httpstream

import (
	"bytes"
	"context"
	"errors"
	"io"
	"math/rand/v2"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

// Defaults of a retry Policy.
const (
	DefaultMaxRetries    = 3
	DefaultBaseDelay     = time.Second
	DefaultMaxDelay      = 30 * time.Second
	DefaultMaxRetryAfter = 2 * time.Minute
)

// drainLimit bounds what is read from a retried response before closing it,
// so the connection can be reused.
const drainLimit = 64 << 10

// Policy is how Send retries 429 and 5xx answers and transport errors: exponential backoff from
// BaseDelay with jitter, capped at MaxDelay, or the server's Retry-After
// when it sends one (a Retry-After beyond MaxRetryAfter is not waited for).
// Nothing else is retried. Zero fields take the defaults; MaxRetries < 0
// turns retries off. Now, Sleep and Jitter are for tests.
type Policy struct {
	MaxRetries    int
	BaseDelay     time.Duration
	MaxDelay      time.Duration
	MaxRetryAfter time.Duration
	// ExtraRetryable adds statuses (Anthropic's 529 overloaded).
	ExtraRetryable []int
	// NoRetry, when set, sees the start of a retryable answer's body and
	// can refuse the retry (OpenAI's insufficient_quota 429).
	NoRetry func(status int, body []byte) bool
	Now     func() time.Time
	Sleep   func(ctx context.Context, d time.Duration) error
	Jitter  func() float64
}

func (p Policy) withDefaults() Policy {
	switch {
	case p.MaxRetries < 0:
		p.MaxRetries = 0
	case p.MaxRetries == 0:
		p.MaxRetries = DefaultMaxRetries
	}
	if p.BaseDelay <= 0 {
		p.BaseDelay = DefaultBaseDelay
	}
	if p.MaxDelay < p.BaseDelay {
		p.MaxDelay = max(DefaultMaxDelay, p.BaseDelay)
	}
	if p.MaxRetryAfter <= 0 {
		p.MaxRetryAfter = DefaultMaxRetryAfter
	}
	if p.Now == nil {
		p.Now = time.Now
	}
	if p.Sleep == nil {
		p.Sleep = sleepCtx
	}
	if p.Jitter == nil {
		p.Jitter = rand.Float64
	}
	return p
}

// backoff is the wait before retry attempt n (1-based): half the
// exponential delay plus a random share of the other half.
func (p Policy) backoff(attempt int) time.Duration {
	delay := p.BaseDelay << min(attempt-1, 20)
	if delay <= 0 || delay > p.MaxDelay {
		delay = p.MaxDelay
	}
	half := delay / 2
	return half + time.Duration(p.Jitter()*float64(delay-half))
}

// retryableStatuses are the answers worth retrying.
var retryableStatuses = map[int]bool{
	http.StatusTooManyRequests: true, http.StatusInternalServerError: true, http.StatusBadGateway: true,
	http.StatusServiceUnavailable: true, http.StatusGatewayTimeout: true,
}

// Retryable reports whether an HTTP status is worth retrying: 429, 500,
// 502, 503 and 504.
func Retryable(status int) bool { return retryableStatuses[status] }

// retryable applies the policy's extra statuses.
func (p Policy) retryable(status int) bool {
	return Retryable(status) || slices.Contains(p.ExtraRetryable, status)
}

// peekLimit bounds what Send reads of a retryable answer for NoRetry.
const peekLimit = 4 << 10

// Send performs a request built by build, retrying by the policy and
// telling onRetry (may be nil) before each wait: 429 / 5xx answers (unless
// NoRetry recognises the body, for example an exhausted quota), and
// transport errors where no response arrived. It returns the last response,
// whatever its status; the caller closes its body.
func Send(ctx context.Context, client *http.Client, build func(context.Context) (*http.Request, error), p Policy, onRetry func(tangent.Retry)) (*http.Response, error) {
	p = p.withDefaults()
	for attempt := 1; ; attempt++ {
		req, err := build(ctx)
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(req)
		last := attempt > p.MaxRetries
		var wait time.Duration
		switch {
		case err != nil && (last || ctx.Err() != nil):
			return nil, err
		case err != nil:
			wait = p.backoff(attempt)
		default:
			var retry bool
			if resp, retry = p.shouldRetry(resp, last); !retry {
				return resp, nil
			}
			if wait, retry = p.wait(resp, attempt); !retry {
				return resp, nil
			}
			discard(resp)
		}
		if onRetry != nil {
			onRetry(tangent.Retry{Attempt: attempt, MaxAttempts: p.MaxRetries + 1, NextRetryAt: p.Now().Add(wait)})
		}
		if err := p.Sleep(ctx, wait); err != nil {
			return nil, err
		}
	}
}

// shouldRetry decides on an answer; when NoRetry has to look at the body,
// the body is read (bounded) and put back.
func (p Policy) shouldRetry(resp *http.Response, last bool) (*http.Response, bool) {
	if last || !p.retryable(resp.StatusCode) {
		return resp, false
	}
	if p.NoRetry == nil {
		return resp, true
	}
	head, _ := io.ReadAll(io.LimitReader(resp.Body, peekLimit))
	resp.Body = struct {
		io.Reader
		io.Closer
	}{io.MultiReader(bytes.NewReader(head), resp.Body), resp.Body}
	return resp, !p.NoRetry(resp.StatusCode, head)
}

// retryAfterJitter is the share of a Retry-After added at random, so
// clients told the same time do not all come back at once.
const retryAfterJitter = 0.1

// wait is how long to wait before the next attempt: the server's
// Retry-After plus up to 10% jitter, capped at MaxRetryAfter (a server
// asking for longer is not waited for, false), else the backoff.
func (p Policy) wait(resp *http.Response, attempt int) (time.Duration, bool) {
	after, ok := retryAfter(resp.Header.Get("Retry-After"), p.Now(), p.MaxRetryAfter)
	if !ok {
		return p.backoff(attempt), true
	}
	if after > p.MaxRetryAfter {
		return 0, false
	}
	return min(after+time.Duration(p.Jitter()*retryAfterJitter*float64(after)), p.MaxRetryAfter), true
}

// retryAfter parses a Retry-After header: delay seconds or an HTTP date.
// Values beyond limit come back as limit+1s (never overflowing).
func retryAfter(value string, now time.Time, limit time.Duration) (time.Duration, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
	}
	beyond := limit + time.Second
	seconds, err := strconv.ParseInt(value, 10, 64)
	switch {
	case err == nil && seconds > int64(limit/time.Second):
		return beyond, true
	case err == nil:
		return time.Duration(max(seconds, 0)) * time.Second, true
	case errors.Is(err, strconv.ErrRange) && !strings.HasPrefix(value, "-"):
		return beyond, true
	case errors.Is(err, strconv.ErrRange):
		return 0, true
	}
	if at, err := http.ParseTime(value); err == nil {
		return min(max(at.Sub(now), 0), beyond), true
	}
	return 0, false
}

func discard(resp *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, drainLimit))
	_ = resp.Body.Close()
}

// sleepCtx waits d unless ctx ends first.
func sleepCtx(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
