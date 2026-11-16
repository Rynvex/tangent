package store

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestRetryable_RaceLossesOnly(t *testing.T) {
	cases := map[error]bool{
		fmt.Errorf("lock: %w", errBranchMoved):              true,
		&pgconn.PgError{Code: sqlStateDeadlock}:             true,
		&pgconn.PgError{Code: sqlStateSerialization}:        true,
		fmt.Errorf("x: %w", &pgconn.PgError{Code: "40001"}): true,
		&pgconn.PgError{Code: "23505"}:                      false,
		errors.New("boom"):                                  false,
	}
	for err, want := range cases {
		if got := retryable(err); got != want {
			t.Errorf("retryable(%v) = %v", err, got)
		}
	}
}
