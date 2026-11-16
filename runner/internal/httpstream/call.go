package httpstream

import (
	"bytes"
	"context"
	"net/http"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

// DefaultIdleTimeout is how long a stream may stay silent.
const DefaultIdleTimeout = 2 * time.Minute

// Call is one streamed POST: the JSON body is sent (retried by Policy on
// 429 / 5xx), a non-2xx answer becomes a ProviderError, and the events of a
// 2xx answer go to each.
type Call struct {
	Client  *http.Client
	URL     string
	Header  http.Header
	Body    []byte
	Policy  Policy
	Idle    time.Duration
	Redact  func(string) string
	OnRetry func(tangent.Retry)
}

// Stream runs the call. Errors are raw (see Public for the operator text).
func (c Call) Stream(ctx context.Context, each func(SSEEvent) (bool, error)) error {
	resp, err := Send(ctx, c.Client, c.request, c.Policy, c.OnRetry)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return ReadProviderError(resp, c.Redact)
	}
	defer resp.Body.Close()
	idle := c.Idle
	if idle <= 0 {
		idle = DefaultIdleTimeout
	}
	return ReadEvents(ctx, resp.Body, idle, each)
}

func (c Call) request(ctx context.Context) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(c.Body))
	if err != nil {
		return nil, err
	}
	for name, values := range c.Header {
		req.Header[name] = append([]string{}, values...)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	return req, nil
}
