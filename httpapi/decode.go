package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
)

// invalid is a 400 invalid_input refusal.
func invalid(message string) error { return domain.NewError(domain.CodeInvalidInput, message, nil) }

// errHostMeta refuses host data from a client: host_meta belongs to the host.
var errHostMeta = invalid("hostMeta is written by the host, not by clients")

// pathID reads a path id; anything that is not a UUID cannot exist, so it is
// answered with notFound without asking the engine.
func (c *call) pathID(name string, notFound error) (string, error) {
	return c.idValue(c.r.PathValue(name), notFound)
}

// idValue checks an id from the path or the query the same way.
func (c *call) idValue(raw string, notFound error) (string, error) {
	id := strings.TrimSpace(raw)
	if _, err := uuid.Parse(id); err != nil || len(id) != len(uuid.Nil.String()) {
		return "", notFound
	}
	return strings.ToLower(id), nil
}

// lineID is the {id} of a /lines/{id} route.
func (c *call) lineID() (string, error) { return c.pathID("id", domain.ErrLineNotFound) }

// body reads the request body as one JSON object into dst. Unknown fields
// are ignored; an empty body is {} unless required.
// The body is put back, so the host's callbacks (TxOptions, HostMeta) can
// read the same bytes, fields the API ignores included.
func (c *call) body(dst any, required bool) error {
	raw, err := c.rawBody()
	if err != nil {
		if isMaxBytes(err) {
			return apiError(CodePayloadTooLarge, "the request body is too large")
		}
		return invalid("the request body could not be read")
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		if required {
			return invalid("a JSON body is required")
		}
		return nil
	}
	if raw[0] != '{' {
		return invalid("the body must be a JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(dst); err != nil {
		return invalid("the body is not valid JSON for this request")
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return invalid("unexpected content after the JSON body")
	}
	return nil
}

// rawBody reads the request body once and keeps it; r.Body is left as a
// fresh reader over all of it.
func (c *call) rawBody() ([]byte, error) {
	if !c.bodyRead {
		c.raw, c.bodyErr = io.ReadAll(c.r.Body)
		c.bodyRead = true
	}
	c.rewindBody()
	return c.raw, c.bodyErr
}

// rewindBody puts the whole body back on r.Body, so the next reader (a host
// callback) reads it from the start.
func (c *call) rewindBody() {
	c.r.Body = io.NopCloser(bytes.NewReader(c.raw))
}

// errMediaType refuses a body that is not JSON (a cross-site form post
// cannot send application/json without a CORS preflight).
var errMediaType = apiError(CodeUnsupportedMediaType, "send the body as application/json")

// checkMediaType refuses a write whose Content-Type is set to anything but
// application/json, or whose body is not empty without one.
func checkMediaType(r *http.Request) error {
	switch r.Method {
	case http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete:
	default:
		return nil
	}
	header := r.Header.Get("Content-Type")
	if header == "" {
		if r.ContentLength == 0 {
			return nil
		}
		return errMediaType
	}
	mediaType, _, err := mime.ParseMediaType(header)
	if err != nil || mediaType != "application/json" {
		return errMediaType
	}
	return nil
}

// hasHostMeta reports a hostMeta field a client sent.
func hasHostMeta(raw json.RawMessage) bool { return present(raw) }

// present reports an optional JSON field that was sent and is not null.
func present(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null"))
}

// queryInt reads an optional integer query parameter within [lo, hi].
func (c *call) queryInt(name string, lo, hi int64) (int64, error) {
	text := strings.TrimSpace(c.r.URL.Query().Get(name))
	if text == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(text, 10, 64)
	if err != nil || n < lo || n > hi {
		return 0, invalid(name + " must be a whole number between " + strconv.FormatInt(lo, 10) + " and " + strconv.FormatInt(hi, 10))
	}
	return n, nil
}

// queryBool reads an optional boolean query parameter (true/false/1/0).
func (c *call) queryBool(name string) (bool, error) {
	text := strings.TrimSpace(c.r.URL.Query().Get(name))
	if text == "" {
		return false, nil
	}
	value, err := strconv.ParseBool(text)
	if err != nil {
		return false, invalid(name + " must be true or false")
	}
	return value, nil
}
