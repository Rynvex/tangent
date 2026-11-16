package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// deltaFilter is Config.DeltaFilter bound to one reader's request.
type deltaFilter func(lineID string, d domain.Delta) (domain.Delta, bool)

// readerFilter binds Config.DeltaFilter to the request; nil without one.
func (a *api) readerFilter(r *http.Request) deltaFilter {
	if a.deltaFilter == nil {
		return nil
	}
	return func(lineID string, d domain.Delta) (domain.Delta, bool) { return a.deltaFilter(r, lineID, d) }
}

// apply asks the filter about one delta; the delta keeps its turn id and
// seq whatever the filter returns, so cursors stay valid.
func (f deltaFilter) apply(lineID string, d domain.Delta) (domain.Delta, bool) {
	out, keep := f(lineID, d)
	out.TurnID, out.Seq = d.TurnID, d.Seq
	return out, keep
}

// all filters a line's buffered deltas (all of them without a filter).
func (f deltaFilter) all(lineID string, deltas []domain.Delta) []domain.Delta {
	if f == nil {
		return deltas
	}
	out := make([]domain.Delta, 0, len(deltas))
	for _, d := range deltas {
		if kept, ok := f.apply(lineID, d); ok {
			out = append(out, kept)
		}
	}
	return out
}

// event filters a message.delta event for one reader and encodes it; nil
// when the reader does not get it. Data that is not a delta (an event a
// host built itself, in a shape that does not decode) is never sent to a
// filtered reader: the filter could not see it.
func (f deltaFilter) event(ev tangent.Event) ([]byte, error) {
	d, ok := deltaOf(ev.Data)
	if !ok {
		return nil, errNotADelta
	}
	kept, ok := f.apply(ev.LineID, d)
	if !ok {
		return nil, nil
	}
	ev.Data = kept
	return sseMessage(ev)
}

// errNotADelta: a message.delta event whose data is not a delta.
var errNotADelta = errors.New("a message.delta event does not carry a delta")

// deltaOf reads a message.delta event's data: the delta, a pointer to it,
// or its JSON (an event relayed from another process).
func deltaOf(data any) (domain.Delta, bool) {
	var out domain.Delta
	switch v := data.(type) {
	case domain.Delta:
		return v, true
	case *domain.Delta:
		if v == nil {
			return out, false
		}
		return *v, true
	case nil:
		return out, false
	case json.RawMessage:
		return out, json.Unmarshal(v, &out) == nil
	case []byte:
		return out, json.Unmarshal(v, &out) == nil
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return out, false
	}
	return out, json.Unmarshal(raw, &out) == nil
}
