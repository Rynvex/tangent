package httpstream

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}
}

func TestReadProviderError_ParsesTheEnvelopeAndRedactsTheKey(t *testing.T) {
	redact := Redactor("sk-secret")
	err := ReadProviderError(response(401, `{"error":{"type":"authentication_error","message":"bad key sk-secret"}}`), redact)
	if err.Status != 401 || err.Type != "authentication_error" || strings.Contains(err.Error(), "sk-secret") {
		t.Fatalf("err = %+v (%v)", err, err)
	}
	plain := ReadProviderError(response(502, "<html>bad gateway sk-secret</html>"), redact)
	if plain.Type != "" || strings.Contains(plain.Message, "sk-secret") || !strings.Contains(plain.Message, "bad gateway") {
		t.Fatalf("plain = %+v", plain)
	}
	if got := Redactor("")("abc"); got != "abc" {
		t.Fatalf("an empty key redacts nothing: %q", got)
	}
}

func TestPublic_MapsFailuresToOperatorTexts(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{&ProviderError{Status: 401}, "refused the credentials (HTTP 401)"},
		{&ProviderError{Status: 404}, "does not know this model or endpoint (HTTP 404)"},
		{&ProviderError{Status: 429}, "is rate limiting requests (HTTP 429)"},
		{&ProviderError{Status: 529}, "is unavailable (HTTP 529)"},
		{&ProviderError{Status: 400}, "refused the request (HTTP 400)"},
		{&ProviderError{Type: "overloaded_error"}, "stopped the reply (overloaded_error)"},
		{&ProviderError{}, "stopped the reply"},
		{ErrEarlyEnd, "ended before the reply was complete"},
		{ErrStalled, "stopped sending"},
		{fmt.Errorf("x: %w", ErrMalformed), "could not be read"},
		{errors.New("dial tcp: refused"), "could not be reached"},
	}
	for _, c := range cases {
		var public *tangent.RunnerError
		if err := Public(c.err); !errors.As(err, &public) || !strings.Contains(public.Public, c.want) {
			t.Errorf("Public(%v) = %v, want %q", c.err, err, c.want)
		}
	}
	for _, err := range []error{context.Canceled, fmt.Errorf("x: %w", context.DeadlineExceeded), nil} {
		if got := Public(err); !errors.Is(got, err) && err != nil || (err == nil && got != nil) {
			t.Errorf("Public(%v) = %v, context errors stay as they are", err, got)
		}
	}
}

func TestReadEvents_StopsWhenDoneAndReportsAnEarlyEnd(t *testing.T) {
	ctx := context.Background()
	seen := 0
	err := ReadEvents(ctx, io.NopCloser(strings.NewReader("data: a\n\ndata: b\n\ndata: c\n\n")), time.Second, func(ev SSEEvent) (bool, error) {
		seen++
		return ev.Data == "b", nil
	})
	if err != nil || seen != 2 {
		t.Fatalf("err %v after %d events", err, seen)
	}
	err = ReadEvents(ctx, io.NopCloser(strings.NewReader("data: a\n\n")), time.Second, func(SSEEvent) (bool, error) { return false, nil })
	if !errors.Is(err, ErrEarlyEnd) {
		t.Fatalf("err = %v, want ErrEarlyEnd", err)
	}
	boom := errors.New("boom")
	err = ReadEvents(ctx, io.NopCloser(strings.NewReader("data: a\n\n")), time.Second, func(SSEEvent) (bool, error) { return false, boom })
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the callback's", err)
	}
}

// blockingBody blocks reads until it is closed.
type blockingBody struct{ closed chan struct{} }

func (b *blockingBody) Read([]byte) (int, error) {
	<-b.closed
	return 0, errors.New("read on closed body")
}

func (b *blockingBody) Close() error {
	select {
	case <-b.closed:
	default:
		close(b.closed)
	}
	return nil
}

func TestReadEvents_AStalledStreamIsClosedAndACancelledOneReportsTheContext(t *testing.T) {
	err := ReadEvents(context.Background(), &blockingBody{closed: make(chan struct{})}, 20*time.Millisecond, func(SSEEvent) (bool, error) { return false, nil })
	if !errors.Is(err, ErrStalled) {
		t.Fatalf("err = %v, want ErrStalled", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	body := &blockingBody{closed: make(chan struct{})}
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
		_ = body.Close()
	}()
	if err := ReadEvents(ctx, body, time.Minute, func(SSEEvent) (bool, error) { return false, nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if err := ReadEvents(context.Background(), io.NopCloser(&failingReader{}), time.Minute, func(SSEEvent) (bool, error) { return false, nil }); !errors.Is(err, ErrEarlyEnd) {
		t.Fatalf("a broken connection is an early end: %v", err)
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("connection reset") }
