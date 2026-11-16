package httpstream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

// errorBodyLimit bounds what is read of a failed response.
const errorBodyLimit = 4 << 10

var (
	// ErrEarlyEnd: the stream ended (or the connection broke) before the
	// provider said the reply was complete.
	ErrEarlyEnd = errors.New("httpstream: the stream ended before the reply was complete")
	// ErrStalled: the provider sent nothing for longer than the idle timeout.
	ErrStalled = errors.New("httpstream: the stream stalled")
	// ErrMalformed: a stream event could not be decoded.
	ErrMalformed = errors.New("httpstream: a stream event could not be decoded")
	// ErrReplyTooLarge: the reply is longer than the runner accepts.
	ErrReplyTooLarge = errors.New("httpstream: the reply is too large")
)

// ProviderError is a failure the provider reported: an HTTP status with its
// error body, or (Status 0) an error event inside the stream. Message is
// redacted and only logged, never shown.
type ProviderError struct {
	Status  int
	Type    string
	Message string
}

func (e *ProviderError) Error() string {
	text := "provider error"
	if e.Status != 0 {
		text = fmt.Sprintf("provider: HTTP %d", e.Status)
	}
	if e.Type != "" {
		text += " " + e.Type
	}
	if e.Message != "" {
		text += ": " + e.Message
	}
	return text
}

// Redactor replaces the API key wherever it appears in a text.
func Redactor(key string) func(string) string {
	return func(text string) string {
		if key == "" {
			return text
		}
		return strings.ReplaceAll(text, key, "[redacted]")
	}
}

// providerEnvelope is the error body shape OpenAI and Anthropic share.
type providerEnvelope struct {
	Error struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// ReadProviderError reads a failed response's body (bounded) into a
// ProviderError and closes it.
func ReadProviderError(resp *http.Response, redact func(string) string) *ProviderError {
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, errorBodyLimit))
	out := &ProviderError{Status: resp.StatusCode}
	var envelope providerEnvelope
	if json.Unmarshal(raw, &envelope) == nil && (envelope.Error.Type != "" || envelope.Error.Message != "") {
		out.Type, out.Message = envelope.Error.Type, envelope.Error.Message
	} else {
		out.Message = strings.TrimSpace(string(raw))
	}
	out.Type, out.Message = errorType(redact(out.Type)), redact(out.Message)
	return out
}

// errorTypePattern is what a provider error type may look like; anything
// else is dropped, since the type ends up in an operator text.
var errorTypePattern = regexp.MustCompile(`^[a-z_]{1,40}$`)

func errorType(t string) string {
	if errorTypePattern.MatchString(t) {
		return t
	}
	return ""
}

// StreamError is an error event inside a stream.
func StreamError(raw []byte, redact func(string) string) *ProviderError {
	var envelope providerEnvelope
	_ = json.Unmarshal(raw, &envelope)
	return &ProviderError{Type: errorType(redact(envelope.Error.Type)), Message: redact(envelope.Error.Message)}
}

// Public turns a run failure into a tangent.RunnerError whose Public text an
// operator may see; context errors are returned as they are (the engine
// reports them as cancelled or timed out), nil stays nil.
func Public(err error) error {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return &tangent.RunnerError{Public: publicText(err), Err: err}
}

func publicText(err error) string {
	var provider *ProviderError
	switch {
	case errors.As(err, &provider):
		return providerText(provider)
	case errors.Is(err, ErrEarlyEnd):
		return "the connection to the model provider ended before the reply was complete"
	case errors.Is(err, ErrStalled):
		return "the model provider stopped sending"
	case errors.Is(err, ErrMalformed):
		return "the model provider sent a reply that could not be read"
	case errors.Is(err, ErrReplyTooLarge):
		return "the reply is longer than this server accepts"
	}
	return "the model provider could not be reached"
}

func providerText(e *ProviderError) string {
	switch {
	case e.Status == 0 && e.Type != "":
		return "the model provider stopped the reply (" + e.Type + ")"
	case e.Status == 0:
		return "the model provider stopped the reply"
	case e.Status == http.StatusUnauthorized || e.Status == http.StatusForbidden:
		return fmt.Sprintf("the model provider refused the credentials (HTTP %d)", e.Status)
	case e.Status == http.StatusNotFound:
		return "the model provider does not know this model or endpoint (HTTP 404)"
	case e.Status == http.StatusTooManyRequests:
		return "the model provider is rate limiting requests (HTTP 429)"
	case e.Status >= http.StatusInternalServerError:
		return fmt.Sprintf("the model provider is unavailable (HTTP %d)", e.Status)
	}
	return fmt.Sprintf("the model provider refused the request (HTTP %d)", e.Status)
}

// ReadEvents reads SSE events from body until each reports done. A stream
// that ends first is ErrEarlyEnd; one silent for longer than idle (no byte
// at all: comment keepalives count) is closed and reported as ErrStalled; a
// cancelled ctx reports ctx's error. Events whose data is blank are skipped.
func ReadEvents(ctx context.Context, body io.ReadCloser, idle time.Duration, each func(SSEEvent) (bool, error)) error {
	var stalled atomic.Bool
	watchdog := time.AfterFunc(idle, func() {
		stalled.Store(true)
		_ = body.Close()
	})
	defer watchdog.Stop()
	reader := NewSSEReader(&activity{r: body, touch: func() { watchdog.Reset(idle) }}, 0)
	for {
		event, err := reader.Next()
		if err != nil {
			return readFailure(ctx, err, stalled.Load())
		}
		if strings.TrimSpace(event.Data) == "" {
			continue
		}
		done, err := each(event)
		if err != nil || done {
			return err
		}
	}
}

// activity calls touch on every read that brought bytes.
type activity struct {
	r     io.Reader
	touch func()
}

func (a *activity) Read(p []byte) (int, error) {
	n, err := a.r.Read(p)
	if n > 0 {
		a.touch()
	}
	return n, err
}

func readFailure(ctx context.Context, err error, stalled bool) error {
	switch {
	case ctx.Err() != nil:
		return ctx.Err()
	case stalled:
		return ErrStalled
	case errors.Is(err, ErrLineTooLong):
		return err
	}
	return fmt.Errorf("%w: %w", ErrEarlyEnd, err)
}
