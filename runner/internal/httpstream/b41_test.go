package httpstream

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// slowComments writes only comment keepalives, every interval, then data.
type slowComments struct {
	chunks   []string
	interval time.Duration
}

func (s *slowComments) Read(p []byte) (int, error) {
	if len(s.chunks) == 0 {
		return 0, io.EOF
	}
	time.Sleep(s.interval)
	n := copy(p, s.chunks[0])
	s.chunks = s.chunks[1:]
	return n, nil
}

func TestReadEvents_CommentKeepalivesKeepAStreamAlive(t *testing.T) {
	body := &slowComments{interval: 20 * time.Millisecond, chunks: []string{": ping\n\n", ": ping\n\n", ": ping\n\n", ": ping\n\n", "data: done\n\n"}}
	got := ""
	err := ReadEvents(context.Background(), io.NopCloser(body), 50*time.Millisecond, func(ev SSEEvent) (bool, error) {
		got = ev.Data
		return true, nil
	})
	if err != nil || got != "done" {
		t.Fatalf("err %v data %q: 80ms of keepalives must not stall a 50ms idle timeout", err, got)
	}
}

func TestReadEvents_SkipsBlankDataEvents(t *testing.T) {
	seen := []string{}
	err := ReadEvents(context.Background(), io.NopCloser(strings.NewReader("data:\n\ndata:   \n\ndata: x\n\n")), time.Second, func(ev SSEEvent) (bool, error) {
		seen = append(seen, ev.Data)
		return true, nil
	})
	if err != nil || len(seen) != 1 || seen[0] != "x" {
		t.Fatalf("seen %v err %v", seen, err)
	}
}

func TestProviderErrorTypes_AreLimitedToPlainNames(t *testing.T) {
	odd := StreamError([]byte(`{"error":{"type":"<script>alert(1)</script>","message":"m"}}`), Redactor(""))
	long := StreamError([]byte(`{"error":{"type":"`+strings.Repeat("a", 41)+`"}}`), Redactor(""))
	fine := StreamError([]byte(`{"error":{"type":"overloaded_error"}}`), Redactor(""))
	if odd.Type != "" || long.Type != "" || fine.Type != "overloaded_error" {
		t.Fatalf("%q %q %q", odd.Type, long.Type, fine.Type)
	}
}

func TestNewClient_DoesNotFollowRedirects(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer target.Close()
	srv := httptest.NewServer(http.RedirectHandler(target.URL, http.StatusTemporaryRedirect))
	defer srv.Close()
	resp, err := NewClient(time.Second).Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

func TestReplyBuffer_StopsAtTheLimit(t *testing.T) {
	r := NewReplyBuffer(5)
	if err := r.Add("abc"); err != nil {
		t.Fatal(err)
	}
	if err := r.Add("def"); !errors.Is(err, ErrReplyTooLarge) || r.String() != "abc" {
		t.Fatalf("err %v text %q", err, r.String())
	}
	if NewReplyBuffer(0).limit != DefaultMaxReplyBytes {
		t.Fatal("default limit")
	}
	if !strings.Contains(publicText(ErrReplyTooLarge), "longer") {
		t.Fatal("public text")
	}
}
