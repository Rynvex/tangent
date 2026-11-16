package tangenttest

import (
	"context"
	"errors"
	"fmt"
	"net"
	"syscall"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

var _ net.Error = timeoutError{}

func TestUnreachable_OnlyRefusedOrTimedOutConnectionsSkip(t *testing.T) {
	cases := map[string]struct {
		err  error
		skip bool
	}{
		"refused":         {fmt.Errorf("dial: %w", &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}), true},
		"deadline":        {fmt.Errorf("connect: %w", context.DeadlineExceeded), true},
		"net timeout":     {fmt.Errorf("connect: %w", timeoutError{}), true},
		"bad password":    {&pgconn.PgError{Code: "28P01", Message: "password authentication failed"}, false},
		"missing db":      {&pgconn.PgError{Code: "3D000", Message: "database does not exist"}, false},
		"something wrong": {errors.New("boom"), false},
	}
	for name, tc := range cases {
		if got := unreachable(tc.err); got != tc.skip {
			t.Errorf("%s: unreachable = %v, want %v", name, got, tc.skip)
		}
	}
}

func TestContext_EndsWithTheTest(t *testing.T) {
	ctx := Context(t)
	deadline, ok := ctx.Deadline()
	if !ok || deadline.IsZero() {
		t.Fatal("the test context has no deadline")
	}
}

func TestSchemaURL_ResolvesNamesInTheTestSchema(t *testing.T) {
	pool := Open(t)
	url := SchemaURL(t, pool)
	conn, err := pgx.Connect(Context(t), url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(Context(t))
	var schema string
	if err := conn.QueryRow(Context(t), `SELECT current_schema()`).Scan(&schema); err != nil || schema != pool.Config().ConnConfig.RuntimeParams["search_path"] {
		t.Fatalf("schema %q (%v)", schema, err)
	}
	var tables int
	if err := conn.QueryRow(Context(t), `SELECT count(*) FROM tangent_line`).Scan(&tables); err != nil {
		t.Fatalf("the test schema's tables are visible: %v", err)
	}
}
