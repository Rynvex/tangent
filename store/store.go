// Package store is tangent's Postgres layer: the embedded migrations, the
// sqlc queries and every transaction the engine runs. It keeps the
// invariants of docs/DESIGN.md §5 (lock order root → parent → child, sets in
// id order) and returns domain errors. It never publishes events: every
// write returns what changed so the caller can publish after commit.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Option configures a Store.
type Option func(*Store)

// WithClock replaces the clock the store decides with: draft starts and
// timeouts, the stale-turn, stale-job and aside-purge cutoffs. Timestamps
// Postgres assigns itself (created_at, closed_at, last_activity_at) still
// come from the database clock, and those cutoffs are compared with them, so
// a replacement clock must stay close to the database's (tests move it
// forward by whole timeouts).
func WithClock(now func() time.Time) Option {
	return func(s *Store) {
		if now != nil {
			s.now = now
		}
	}
}

// WithNoteSourceLabels sets the templates of the source label every note is
// written with (default: domain.DefaultNoteSourceLabels, Traditional
// Chinese).
func WithNoteSourceLabels(labels domain.NoteSourceLabels) Option {
	return func(s *Store) { s.labels = labels }
}

// Store runs tangent's transactions over a host's pool.
type Store struct {
	pool   *pgxpool.Pool
	q      *db.Queries
	limits domain.Limits
	now    func() time.Time
	labels domain.NoteSourceLabels
}

// New builds a store over the pool. Limits that cannot work are refused;
// fields left at zero take their defaults.
func New(pool *pgxpool.Pool, limits domain.Limits, opts ...Option) (*Store, error) {
	if pool == nil {
		return nil, errors.New("store: pool is required")
	}
	if err := limits.Validate(); err != nil {
		return nil, fmt.Errorf("store: %w", err)
	}
	s := &Store{pool: pool, q: db.New(pool), limits: limits.WithDefaults(), now: time.Now, labels: domain.DefaultNoteSourceLabels()}
	for _, opt := range opts {
		opt(s)
	}
	return s, nil
}

// Limits returns the limits the store applies, defaults filled in.
func (s *Store) Limits() domain.Limits { return s.limits }

// invalidInput is a refusal of malformed input.
func invalidInput(message string) error {
	return domain.NewError(domain.CodeInvalidInput, message, nil)
}

// parseID parses an id a caller sent; ok is false for anything that cannot
// name a row.
func parseID(id string) (uuid.UUID, bool) {
	parsed, err := uuid.Parse(strings.TrimSpace(id))
	return parsed, err == nil
}

func nullID(id string) uuid.NullUUID {
	parsed, ok := parseID(id)
	return uuid.NullUUID{UUID: parsed, Valid: ok}
}

func idString(id uuid.NullUUID) string {
	if !id.Valid {
		return ""
	}
	return id.UUID.String()
}

func idStrings(ids []uuid.UUID) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, id.String())
	}
	return out
}

// noRows reports whether err says a query found nothing.
func noRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

// lookup maps "no rows" to notFound and wraps any other failure.
func lookup(err error, notFound error, what string) error {
	if err == nil {
		return nil
	}
	if noRows(err) {
		return notFound
	}
	return fmt.Errorf("%s: %w", what, err)
}

// jsonObject validates host data: empty means {}, anything else must be a
// JSON object.
func jsonObject(raw json.RawMessage, field string) ([]byte, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return []byte("{}"), nil
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil || probe == nil {
		return nil, invalidInput(field + " must be a JSON object")
	}
	return raw, nil
}

func clampLimit(limit, def, most int) int32 {
	switch {
	case limit <= 0:
		return int32(def)
	case limit > most:
		return int32(most)
	}
	return int32(limit)
}
