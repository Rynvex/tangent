package tangent

import (
	"encoding/json"
	"testing"

	"github.com/Rynvex/tangent/domain"
)

func TestEventData_ReadsTheValueOrItsJSON(t *testing.T) {
	message := domain.Message{ID: "m-1", Role: domain.RoleAssistant}
	raw, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	var nilMessage *domain.Message
	cases := []struct {
		name string
		data any
		ok   bool
	}{
		{"the value", message, true},
		{"a pointer", &message, true},
		{"a nil pointer", nilMessage, false},
		{"nil", nil, false},
		{"raw JSON", json.RawMessage(raw), true},
		{"bytes", raw, true},
		{"a decoded map", decoded, true},
		{"bad JSON", json.RawMessage(`{`), false},
		{"unmarshalable", func() {}, false},
		{"another shape", []int{1}, false},
	}
	for _, c := range cases {
		got, ok := eventData[domain.Message](c.data)
		if ok != c.ok || (ok && got.ID != "m-1") {
			t.Errorf("%s: %+v %v", c.name, got, ok)
		}
	}
}
