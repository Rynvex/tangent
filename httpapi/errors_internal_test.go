package httpapi

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWriteError_AClientThatLeftGetsNothing(t *testing.T) {
	a := &api{log: slog.New(slog.DiscardHandler)}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := httptest.NewRecorder()
	a.writeError(rec, httptest.NewRequest(http.MethodGet, "/lines", nil).WithContext(ctx), fmt.Errorf("list: %w", context.Canceled))
	if rec.Body.Len() != 0 || rec.Header().Get("Content-Type") != "" {
		t.Fatalf("wrote %q", rec.Body)
	}
	rec = httptest.NewRecorder()
	a.writeError(rec, httptest.NewRequest(http.MethodGet, "/lines", nil), context.Canceled)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("a cancel that is not the client's is still an error: %d", rec.Code)
	}
}
