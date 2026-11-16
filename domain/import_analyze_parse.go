package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
)

// importAnalyzeOutputMaxBytes bounds a model's analysis reply.
const importAnalyzeOutputMaxBytes = 256 << 10

// ErrImportAnalyzeOutput is a model reply ParseImportAnalyzeOutput cannot use.
var ErrImportAnalyzeOutput = errors.New("the analysis reply is not a usable plan")

// rawAnalyzePlan is a model's reply as decoded, before any check.
type rawAnalyzePlan struct {
	Mode    string           `json:"mode"`
	Summary string           `json:"summary"`
	Nodes   []rawAnalyzeNode `json:"nodes"`
}

type rawAnalyzeNode struct {
	UnitKeys           []string `json:"unitKeys"`
	Title              string   `json:"title"`
	Role               string   `json:"role"`
	AttachToKey        string   `json:"attachToKey"`
	AttachAfterUnitKey string   `json:"attachAfterUnitKey"`
	Conclusion         string   `json:"conclusion"`
	Reason             string   `json:"reason"`
}

// planNode is a node while a reply is repaired: its unit indices in order.
type planNode struct {
	units []int
	raw   rawAnalyzeNode
	role  string
}

// ParseImportAnalyzeOutput reads a model's analysis reply for in (normalized
// first; its refusal is returned as is). The reply is one JSON object,
// optionally in a ```json fence. The plan is checked strictly and repaired
// where it can be: units are named by their prompt id (U1…) or their key;
// unknown and repeated ones are dropped; a missing unit joins the node of the
// unit just before it (else just after); an unknown role is a chapter; a
// branch's attachToKey must name a chapter node (else the chapter it started
// in, else the latest before it, else the first) and attachAfterUnitKey a unit
// of it before the branch; the limits of an import move roles as the tree's
// defaults do; texts are flattened and cut. A reply that is not such an
// object, has no usable node or leaves out more than half the units is
// ErrImportAnalyzeOutput (the caller then uses AnalyzeImportDeterministic).
func ParseImportAnalyzeOutput(raw string, in ImportAnalyzeInput) (ImportAnalyzePlan, error) {
	clean, err := NormalizeImportAnalyzeInput(in)
	if err != nil {
		return ImportAnalyzePlan{}, err
	}
	decoded, err := decodeAnalyzeReply(raw)
	if err != nil {
		return ImportAnalyzePlan{}, err
	}
	units := analyzeExcerpts(clean.Units)
	nodes, err := resolveAnalyzeNodes(decoded.Nodes, units)
	if err != nil {
		return ImportAnalyzePlan{}, err
	}
	out := repairAnalyzeNodes(nodes, units)
	return ImportAnalyzePlan{Mode: analyzeMode(decoded.Mode, out), Source: ImportAnalyzeSourceModel, Summary: analyzeSummaryText(decoded.Summary, out), Nodes: out}, nil
}

// decodeAnalyzeReply is the reply's one JSON object (a ```json fence around it
// is removed), with nothing after it.
func decodeAnalyzeReply(raw string) (rawAnalyzePlan, error) {
	if len(raw) > importAnalyzeOutputMaxBytes {
		return rawAnalyzePlan{}, fmt.Errorf("%w: larger than %d bytes", ErrImportAnalyzeOutput, importAnalyzeOutputMaxBytes)
	}
	body := strings.TrimSpace(stripJSONFence(raw))
	if !strings.HasPrefix(body, "{") {
		return rawAnalyzePlan{}, fmt.Errorf("%w: not a JSON object", ErrImportAnalyzeOutput)
	}
	decoder := json.NewDecoder(bytes.NewReader([]byte(body)))
	var out rawAnalyzePlan
	if err := decoder.Decode(&out); err != nil {
		return rawAnalyzePlan{}, fmt.Errorf("%w: %v", ErrImportAnalyzeOutput, err)
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return rawAnalyzePlan{}, fmt.Errorf("%w: content after the object", ErrImportAnalyzeOutput)
	}
	return out, nil
}

// stripJSONFence is the inside of the first ``` fence when text has one
// and is not already a bare object (its language tag dropped), else text: a
// fence inside a bare object's strings is left alone.
func stripJSONFence(text string) string {
	start := strings.Index(text, "```")
	if start < 0 || strings.HasPrefix(strings.TrimSpace(text), "{") {
		return text
	}
	rest := text[start+3:]
	if nl := strings.IndexByte(rest, '\n'); nl >= 0 && !strings.Contains(rest[:nl], "{") {
		rest = rest[nl+1:]
	}
	if end := strings.Index(rest, "```"); end >= 0 {
		rest = rest[:end]
	}
	return rest
}

// unitIndex resolves a unit named in a reply: its prompt id (U1…) first (the
// prompt shows only those, so a key that looks like one cannot take its
// place), else its key.
func unitIndex(id string, units []ImportAnalyzeUnit) (int, bool) {
	id = strings.TrimSpace(id)
	if len(id) > 1 && (id[0] == 'U' || id[0] == 'u') {
		if n, err := strconv.Atoi(id[1:]); err == nil && n >= 1 && n <= len(units) {
			return n - 1, true
		}
	}
	for i, unit := range units {
		if unit.Key == id {
			return i, true
		}
	}
	return -1, false
}

// resolveAnalyzeNodes turns the reply's nodes into unit indices: unknown
// and repeated units dropped, empty nodes left out, missing units placed by
// their neighbours, nodes in order of their first unit.
func resolveAnalyzeNodes(raw []rawAnalyzeNode, units []ImportAnalyzeUnit) ([]planNode, error) {
	owner := make([]int, len(units))
	for i := range owner {
		owner[i] = -1
	}
	nodes := []planNode{}
	for _, node := range raw {
		picked := []int{}
		for _, id := range node.UnitKeys {
			if i, ok := unitIndex(id, units); ok && owner[i] < 0 {
				owner[i] = len(nodes)
				picked = append(picked, i)
			}
		}
		if len(picked) > 0 {
			nodes = append(nodes, planNode{units: picked, raw: node})
		}
	}
	missing := 0
	for _, o := range owner {
		if o < 0 {
			missing++
		}
	}
	if len(nodes) == 0 || missing*2 > len(units) {
		return nil, fmt.Errorf("%w: %d of %d units are not in a node", ErrImportAnalyzeOutput, missing, len(units))
	}
	for i := range owner {
		if owner[i] < 0 {
			owner[i] = neighbourOwner(owner, i)
			nodes[owner[i]].units = append(nodes[owner[i]].units, i)
		}
	}
	for i := range nodes {
		slices.Sort(nodes[i].units)
	}
	slices.SortStableFunc(nodes, func(a, b planNode) int { return a.units[0] - b.units[0] })
	return nodes, nil
}

// neighbourOwner is the node of the nearest placed unit before i, else after.
func neighbourOwner(owner []int, i int) int {
	for j := i - 1; j >= 0; j-- {
		if owner[j] >= 0 {
			return owner[j]
		}
	}
	for j := i + 1; j < len(owner); j++ {
		if owner[j] >= 0 {
			return owner[j]
		}
	}
	return 0
}

func knownAnalyzeRole(role string) string {
	switch role = strings.TrimSpace(role); role {
	case ImportRoleChapter, ImportRoleMergedBranch, ImportRoleOpenBranch, ImportRoleStandalone:
		return role
	}
	return ImportRoleChapter
}

func analyzeMessages(units []ImportAnalyzeUnit, indices []int) int {
	total := 0
	for _, i := range indices {
		total += units[i].MessageCount
	}
	return total
}

// analyzeMode is the reply's mode when valid; any branch needs the tree.
func analyzeMode(mode string, nodes []ImportAnalyzeNode) string {
	for _, node := range nodes {
		if isImportBranchRole(node.Role) {
			return ImportModeTree
		}
	}
	switch mode = strings.TrimSpace(mode); mode {
	case ImportModeTree, ImportModeTimeline, ImportModeBatch:
		return mode
	}
	return ImportModeTree
}

func analyzeSummaryText(summary string, nodes []ImportAnalyzeNode) string {
	if flat := CutRunes(FlattenUntrusted(summary), ImportAnalyzeSummaryRunes); flat != "" {
		return flat
	}
	return analyzeSummary(nodes)
}
