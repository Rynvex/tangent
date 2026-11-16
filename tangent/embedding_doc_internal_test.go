package tangent

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// embeddingGuide is the guide whose feature table this test keeps complete.
const embeddingGuide = "../docs/EMBEDDING.md"

// featureRow is a row of the guide's feature table: "| `name` | …".
var featureRow = regexp.MustCompile("(?m)^\\| `([a-z_]+)` \\|")

// TestEmbeddingGuide_EveryCatalogFeatureIsInTheFeatureTable fails when a
// built-in feature (or the suggestion inbox) has no row in the table of
// docs/EMBEDDING.md §2, or the table names one that does not exist.
func TestEmbeddingGuide_EveryCatalogFeatureIsInTheFeatureTable(t *testing.T) {
	raw, err := os.ReadFile(embeddingGuide)
	if err != nil {
		t.Fatal(err)
	}
	doc := string(raw)
	start := strings.Index(doc, "## 2. ")
	end := strings.Index(doc[start+1:], "\n## ")
	if start < 0 || end < 0 {
		t.Fatal("no §2 in the guide")
	}
	rows := map[string]bool{}
	for _, m := range featureRow.FindAllStringSubmatch(doc[start:start+1+end], -1) {
		rows[m[1]] = true
	}
	known := map[string]bool{FeatureSuggestionProbe: true}
	for _, entry := range catalog {
		known[entry.name] = true
		if !rows[entry.name] {
			t.Errorf("feature %q has no row \"| `%s` |\" in the feature table of %s §2", entry.name, entry.name, embeddingGuide)
		}
	}
	for name := range rows {
		if !known[name] {
			t.Errorf("the feature table of %s names %q, which is not a feature", embeddingGuide, name)
		}
	}
}
