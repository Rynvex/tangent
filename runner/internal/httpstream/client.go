package httpstream

import (
	"net/http"
	"strings"
	"time"
)

// Defaults of the runners' HTTP client.
const (
	// DefaultHeaderTimeout bounds the wait for a response's headers (a
	// streamed reply sends them at once; the body may take minutes).
	DefaultHeaderTimeout = 2 * time.Minute
	// DefaultMaxReplyBytes bounds the text of one reply.
	DefaultMaxReplyBytes = 1 << 20
)

// NewClient is the default client of a runner: it does not follow
// redirects (an API that redirects is answered with the redirect, which
// fails the call) and bounds the wait for response headers.
func NewClient(headerTimeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = headerTimeout
	return &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// ReplyBuffer collects a reply's text up to a limit.
type ReplyBuffer struct {
	b     strings.Builder
	limit int
}

// NewReplyBuffer bounds a reply at limit bytes (DefaultMaxReplyBytes when
// not positive).
func NewReplyBuffer(limit int) *ReplyBuffer {
	if limit <= 0 {
		limit = DefaultMaxReplyBytes
	}
	return &ReplyBuffer{limit: limit}
}

// Add appends text; ErrReplyTooLarge once the reply passes the limit.
func (r *ReplyBuffer) Add(text string) error {
	if r.b.Len()+len(text) > r.limit {
		return ErrReplyTooLarge
	}
	r.b.WriteString(text)
	return nil
}

// String is the collected reply.
func (r *ReplyBuffer) String() string { return r.b.String() }
