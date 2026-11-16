package httpapi

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// apiDocPath is the HTTP API reference this test keeps complete.
const apiDocPath = "../docs/API.md"

// eventsRoute is mounted by New itself (only with a Hub), not by routes().
const eventsRoute = "GET /events"

var (
	// docHeading is a "### `…`" heading: a route ("GET /lines") or an event
	// ("line.created").
	docHeading = regexp.MustCompile("(?m)^### `([^`]+)`$")
	docRoute   = regexp.MustCompile(`^(GET|POST|PUT|PATCH|DELETE) /\S*$`)
	docEvent   = regexp.MustCompile(`^[a-z_]+(\.[a-z_]+)+$`)
	// docSample is a link to a contract sample.
	docSample = regexp.MustCompile(`\(\.\./httpapi/(testdata/contract/[\w.]+\.json)\)`)
)

func readAPIDoc(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(apiDocPath)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// docHeadings splits the doc's "### `…`" headings into routes and events.
func docHeadings(doc string) (routes, events []string) {
	for _, m := range docHeading.FindAllStringSubmatch(doc, -1) {
		switch {
		case docRoute.MatchString(m[1]):
			routes = append(routes, m[1])
		case docEvent.MatchString(m[1]):
			events = append(events, m[1])
		}
	}
	return routes, events
}

// TestAPIDoc_EveryRouteIsDocumented fails when a route httpapi can mount has
// no heading in docs/API.md, or the doc names a route that does not exist.
func TestAPIDoc_EveryRouteIsDocumented(t *testing.T) {
	documented, _ := docHeadings(readAPIDoc(t))
	mounted := []string{eventsRoute}
	for _, rt := range (&api{}).routes() {
		mounted = append(mounted, rt.pattern)
	}
	for _, pattern := range mounted {
		if !slices.Contains(documented, pattern) {
			t.Errorf("route %q is not documented: add a \"### `%s`\" section to docs/API.md", pattern, pattern)
		}
	}
	for _, pattern := range documented {
		if !slices.Contains(mounted, pattern) {
			t.Errorf("docs/API.md documents %q, which httpapi does not mount", pattern)
		}
	}
}

// TestAPIDoc_EveryEventIsDocumented does the same for the event types (every
// Event* string constant of package tangent, plus stream.lagged) and for
// the change values of branch.changed.
func TestAPIDoc_EveryEventIsDocumented(t *testing.T) {
	doc := readAPIDoc(t)
	_, documented := docHeadings(doc)
	events, changes := engineEventNames(t)
	events = append(events, EventStreamLagged)
	for _, name := range events {
		if !slices.Contains(documented, name) {
			t.Errorf("event %q is not documented: add a \"### `%s`\" section to docs/API.md", name, name)
		}
	}
	for _, name := range documented {
		if !slices.Contains(events, name) {
			t.Errorf("docs/API.md documents event %q, which nothing publishes", name)
		}
	}
	if len(changes) == 0 {
		t.Fatal("no branch.changed change values were found in package tangent")
	}
	section := docSection(doc, "branch.changed")
	for _, change := range changes {
		if !strings.Contains(section, "| `"+change+"` |") {
			t.Errorf("branch.changed change %q is not in the change table of docs/API.md", change)
		}
	}
}

// TestAPIDoc_EveryErrorCodeIsDocumented checks every code httpapi maps has
// a row with the same HTTP status.
func TestAPIDoc_EveryErrorCodeIsDocumented(t *testing.T) {
	doc := readAPIDoc(t)
	for code, status := range statusOf {
		row := "| `" + code + "` | " + strconv.Itoa(status) + " |"
		if !strings.Contains(doc, row) {
			t.Errorf("error code %q (%d) has no row %q in docs/API.md", code, status, row)
		}
	}
}

// TestAPIDoc_SamplesExistAndAreReferenced keeps the doc's sample links valid
// and every contract sample referenced.
func TestAPIDoc_SamplesExistAndAreReferenced(t *testing.T) {
	doc := readAPIDoc(t)
	linked := map[string]bool{}
	for _, m := range docSample.FindAllStringSubmatch(doc, -1) {
		linked[m[1]] = true
		if _, err := os.Stat(m[1]); err != nil {
			t.Errorf("docs/API.md links %s, which does not exist", m[1])
		}
	}
	samples, err := filepath.Glob("testdata/contract/*.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, sample := range samples {
		if !linked[filepath.ToSlash(sample)] {
			t.Errorf("contract sample %s is not linked from docs/API.md", sample)
		}
	}
}

// docSection is the text after the "### `name`" heading up to the next
// heading.
func docSection(doc, name string) string {
	start := strings.Index(doc, "### `"+name+"`\n")
	if start < 0 {
		return ""
	}
	rest := doc[start+len(name)+7:]
	if end := strings.Index(rest, "\n#"); end >= 0 {
		return rest[:end]
	}
	return rest
}

// engineEventNames reads package tangent's source: the values of its Event*
// string constants, and of the constants in the block documented as the
// changes of branch.changed.
func engineEventNames(t *testing.T) (events, changes []string) {
	t.Helper()
	files, err := filepath.Glob("../tangent/*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range file.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.CONST {
				continue
			}
			changeBlock := gen.Doc != nil && strings.Contains(gen.Doc.Text(), "branch.changed")
			for name, value := range stringConsts(gen) {
				switch {
				case strings.HasPrefix(name, "Event"):
					events = append(events, value)
				case changeBlock:
					changes = append(changes, value)
				}
			}
		}
	}
	return events, changes
}

// stringConsts maps the exported string-literal constants of a block.
func stringConsts(gen *ast.GenDecl) map[string]string {
	out := map[string]string{}
	for _, spec := range gen.Specs {
		vs, ok := spec.(*ast.ValueSpec)
		if !ok {
			continue
		}
		for i, ident := range vs.Names {
			if !ident.IsExported() || i >= len(vs.Values) {
				continue
			}
			lit, ok := vs.Values[i].(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				continue
			}
			if value, err := strconv.Unquote(lit.Value); err == nil {
				out[ident.Name] = value
			}
		}
	}
	return out
}
