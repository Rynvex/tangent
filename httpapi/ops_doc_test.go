package httpapi

import (
	"regexp"
	"testing"
)

// docOpRow is a row of the op table in docs/API.md:
// "| `lines.create` | `POST /lines` | `CreateLine` |".
var docOpRow = regexp.MustCompile("(?m)^\\| `([a-z]+\\.[a-z_]+)` \\| `((?:GET|POST|PUT|PATCH|DELETE) /\\S*)` \\| `[A-Z][A-Za-z]+` \\|$")

// TestAPIDoc_EveryWriteHasADocumentedOp: every write route names one op,
// read routes none, and docs/API.md lists exactly these op / route pairs.
func TestAPIDoc_EveryWriteHasADocumentedOp(t *testing.T) {
	documented := map[string]string{}
	for _, m := range docOpRow.FindAllStringSubmatch(readAPIDoc(t), -1) {
		if _, dup := documented[m[2]]; dup {
			t.Errorf("docs/API.md lists %s twice in the op table", m[2])
		}
		documented[m[2]] = m[1]
	}
	ops := map[string]string{}
	for _, rt := range (&api{}).routes() {
		switch {
		case !rt.write && rt.op != "":
			t.Errorf("read route %s names op %s", rt.pattern, rt.op)
		case rt.write && rt.op == "":
			t.Errorf("write route %s has no op", rt.pattern)
		case rt.write && documented[rt.pattern] != rt.op:
			t.Errorf("write route %s is op %q; docs/API.md says %q", rt.pattern, rt.op, documented[rt.pattern])
		}
		if other, dup := ops[rt.op]; rt.op != "" && dup {
			t.Errorf("op %s names both %s and %s", rt.op, other, rt.pattern)
		}
		if rt.op != "" {
			ops[rt.op] = rt.pattern
		}
	}
	if len(documented) != len(ops) {
		t.Errorf("docs/API.md lists %d ops, httpapi has %d", len(documented), len(ops))
	}
}
