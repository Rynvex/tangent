package embedding_test

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// repoRoot is where the guide's snippet paths are relative to.
const repoRoot = "../.."

// guidePath is the guide that quotes this package.
const guidePath = "docs/EMBEDDING.md"

// minimalMaxLines is the guide's promise for the minimal embedding.
const minimalMaxLines = 20

// guideSnippet matches a quoted region in the guide:
//
//	<!-- snippet: examples/embedding/minimal.go#minimal -->
//	```go
//	...
//	```
var guideSnippet = regexp.MustCompile("(?s)<!-- snippet: ([^#\\s]+)#([\\w-]+) -->\\n```go\\n(.*?)\\n```")

// regionStart and regionEnd delimit a region in a Go file.
var regionStart = regexp.MustCompile(`^// snippet:([\w-]+)$`)

const regionEnd = "// endsnippet"

// TestGuideSnippets keeps docs/EMBEDDING.md and the compiled examples in
// step: every quoted block equals its region, and every region is quoted.
func TestGuideSnippets(t *testing.T) {
	guide, err := os.ReadFile(filepath.Join(repoRoot, guidePath))
	if err != nil {
		t.Fatal(err)
	}
	quoted := map[string]bool{}
	matches := guideSnippet.FindAllStringSubmatch(string(guide), -1)
	if len(matches) == 0 {
		t.Fatalf("%s quotes no snippet", guidePath)
	}
	for _, m := range matches {
		file, name, block := m[1], m[2], m[3]
		regions, err := readRegions(filepath.Join(repoRoot, file))
		if err != nil {
			t.Fatal(err)
		}
		region, ok := regions[name]
		if !ok {
			t.Errorf("%s quotes %s#%s, which does not exist", guidePath, file, name)
			continue
		}
		if block != region {
			t.Errorf("%s#%s differs from its quote in %s; copy the region again:\n%s", file, name, guidePath, region)
		}
		quoted[file+"#"+name] = true
	}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		regions, err := readRegions(f)
		if err != nil {
			t.Fatal(err)
		}
		for name := range regions {
			if key := "examples/embedding/" + f + "#" + name; !quoted[key] {
				t.Errorf("region %s is not quoted in %s", key, guidePath)
			}
		}
	}
}

func TestMinimalEmbeddingFitsTheGuide(t *testing.T) {
	regions, err := readRegions("minimal.go")
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(regions["minimal"], "\n") + 1; n > minimalMaxLines {
		t.Errorf("the minimal embedding is %d lines; the guide promises at most %d", n, minimalMaxLines)
	}
}

// readRegions returns every "// snippet:<name>" … "// endsnippet" region of
// a file, without trailing blank lines.
func readRegions(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	regions := map[string]string{}
	var name string
	var lines []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case name == "" && regionStart.MatchString(line):
			name, lines = regionStart.FindStringSubmatch(line)[1], nil
		case name != "" && line == regionEnd:
			regions[name] = strings.TrimRight(strings.Join(lines, "\n"), "\n")
			name = ""
		case name != "":
			lines = append(lines, line)
		}
	}
	if name != "" {
		return nil, fmt.Errorf("%s: region %q has no %q", path, name, regionEnd)
	}
	return regions, scanner.Err()
}
