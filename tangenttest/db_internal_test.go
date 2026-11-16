package tangenttest

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestUnavailableExtension(t *testing.T) {
	for code, want := range map[string]bool{"0A000": true, "58P01": true, "42501": false} {
		if got := unavailableExtension(fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: code})); got != want {
			t.Fatalf("%s: %v", code, got)
		}
	}
	if unavailableExtension(nil) || unavailableExtension(errors.New("x")) {
		t.Fatal("not a server error")
	}
}
