package embedding

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/tangent"
)

// User is what the host's own authentication middleware puts in the request
// context. tangent never sees passwords, sessions or roles: only the Scope.
type User struct {
	ID          string
	WorkspaceID string
	ReadOnly    bool
}

type userKey struct{}

// WithUser is the host middleware's half: it stores the signed-in user.
func WithUser(ctx context.Context, u User) context.Context {
	return context.WithValue(ctx, userKey{}, u)
}

var errSignedOut = errors.New("not signed in")

// snippet:auth
// UserScope maps the host's signed-in user to a tangent.Scope: the workspace
// is the tenant (every read and write is checked against it), the user is
// the actor (written into created_by). Any non-domain error is a 401.
func UserScope(r *http.Request) (tangent.Scope, error) {
	u, ok := r.Context().Value(userKey{}).(User)
	if !ok || u.WorkspaceID == "" {
		return tangent.Scope{}, errSignedOut
	}
	return tangent.Scope{Tenant: u.WorkspaceID, Actor: u.ID}, nil
}

// UserCanWrite lets read-only members read everything (and preview) but not
// change anything: writes answer 403 forbidden and /capabilities says so.
func UserCanWrite(r *http.Request) bool {
	u, _ := r.Context().Value(userKey{}).(User)
	return !u.ReadOnly
}

// MountForUsers mounts the API behind the host's authentication. hub is
// nil when the host delivers events over its own channel (a Publisher).
func MountForUsers(mux *http.ServeMux, auth func(http.Handler) http.Handler, engine *tangent.Engine, d tangent.Dispatcher, hub *httpapi.Hub, log *slog.Logger) error {
	api, err := httpapi.New(httpapi.Config{
		Engine: engine, Dispatcher: d, Hub: hub, Logger: log,
		Scope: UserScope, CanWrite: UserCanWrite,
		StatusFor:    QuotaStatus, // the TurnGate's own codes
		MaxBodyBytes: 256 << 10,
	})
	if err != nil {
		return err
	}
	mux.Handle("/chat/api/", auth(http.StripPrefix("/chat/api", api)))
	return nil
}

// endsnippet
