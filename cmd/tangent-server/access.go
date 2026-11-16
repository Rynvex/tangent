package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Server-level error codes (the API's own are in httpapi).
const (
	codeUnauthorized = "unauthorized"
	codeForbidden    = "forbidden"
	codeRateLimited  = "rate_limited"
)

// Failed authentications an address may make: a small burst, then one
// every six seconds.
const (
	authFailuresPerMinute = 10
	authFailureBurst      = 5
)

func writeServerError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message, "code": code})
}

func tooMany(w http.ResponseWriter, wait time.Duration) {
	w.Header().Set("Retry-After", strconv.Itoa(max(1, int(math.Ceil(wait.Seconds())))))
	writeServerError(w, http.StatusTooManyRequests, codeRateLimited, "too many requests; slow down")
}

// role is what a request may do.
type role int

const (
	roleNone role = iota
	roleViewer
	roleWriter
)

type roleKey struct{}

// roleOf is the role the gate gave the request.
func roleOf(ctx context.Context) role {
	r, _ := ctx.Value(roleKey{}).(role)
	return r
}

// gate guards the API: the Host header (without a token, loopback names
// only, against DNS rebinding), a per-address rate, a stricter per-address
// budget of failed authentications, the bearer token (compared as fixed
// length hashes) and a rate per token.
type gate struct {
	writer, viewer [sha256.Size]byte
	open           bool // no token: dev on loopback
	hasViewer      bool
	addresses      *limiter
	failures       *limiter
	tokens         *limiter
}

func newGate(cfg config, now func() time.Time) *gate {
	g := &gate{
		open:      cfg.Token == "",
		addresses: newLimiter(cfg.RateLimit, cfg.RateBurst, now),
		failures:  newLimiter(authFailuresPerMinute, authFailureBurst, now),
		tokens:    newLimiter(cfg.RateLimit, cfg.RateBurst, now),
	}
	g.writer = sha256.Sum256([]byte(cfg.Token))
	if cfg.ViewerToken != "" {
		g.viewer, g.hasViewer = sha256.Sum256([]byte(cfg.ViewerToken)), true
	}
	return g
}

func (g *gate) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		address := clientIP(r)
		if g.open && !loopbackHost(r.Host) {
			writeServerError(w, http.StatusForbidden, codeForbidden, "this server only answers on localhost")
			return
		}
		if ok, wait := g.addresses.allow(address); !ok {
			tooMany(w, wait)
			return
		}
		who, key := g.identify(r)
		if who == roleNone {
			g.refuse(w, address)
			return
		}
		if ok, wait := g.tokens.allow(key); !ok {
			tooMany(w, wait)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), roleKey{}, who)))
	})
}

// refuse answers a failed authentication, or 429 once the address used up
// its failures.
func (g *gate) refuse(w http.ResponseWriter, address string) {
	if ok, wait := g.failures.allow(address); !ok {
		tooMany(w, wait)
		return
	}
	w.Header().Set("WWW-Authenticate", `Bearer realm="tangent"`)
	writeServerError(w, http.StatusUnauthorized, codeUnauthorized, "authentication required")
}

// identify reads the bearer token: the role and the key of its rate bucket.
func (g *gate) identify(r *http.Request) (role, string) {
	if g.open {
		return roleWriter, "open"
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || token == "" {
		return roleNone, ""
	}
	sum := sha256.Sum256([]byte(token))
	switch {
	case subtle.ConstantTimeCompare(sum[:], g.writer[:]) == 1:
		return roleWriter, "writer"
	case g.hasViewer && subtle.ConstantTimeCompare(sum[:], g.viewer[:]) == 1:
		return roleViewer, "viewer"
	}
	return roleNone, ""
}

// loopbackHost reports whether a Host header names this machine.
func loopbackHost(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// limiter is a token bucket per key: perMinute requests a minute on
// average, burst at once. Idle buckets are swept now and then.
type limiter struct {
	mu        sync.Mutex
	rate      float64 // tokens per second
	burst     float64
	buckets   map[string]*bucket
	now       func() time.Time
	lastSweep time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

// bucketIdle is how long an unused bucket is kept.
const bucketIdle = 10 * time.Minute

func newLimiter(perMinute, burst int, now func() time.Time) *limiter {
	return &limiter{rate: float64(perMinute) / 60, burst: float64(burst), buckets: map[string]*bucket{}, now: now, lastSweep: now()}
}

// allow takes one token for key; when there is none it says how long
// until there is.
func (l *limiter) allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.sweep(now)
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens = math.Min(l.burst, b.tokens+now.Sub(b.last).Seconds()*l.rate)
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	return false, time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
}

func (l *limiter) sweep(now time.Time) {
	if now.Sub(l.lastSweep) < bucketIdle {
		return
	}
	l.lastSweep = now
	for key, b := range l.buckets {
		if now.Sub(b.last) >= bucketIdle {
			delete(l.buckets, key)
		}
	}
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return strings.TrimSpace(r.RemoteAddr)
	}
	return host
}
