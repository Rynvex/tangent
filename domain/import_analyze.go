package domain

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// B22: the import analysis. Before an import is assembled, its rounds (or
// whole conversations) are read as units and organized into a proposed tree:
// units on one topic are threaded into one node even when other topics came
// between them (A → B → A → C → A → B), and each node gets a role (a chapter
// of the main line, a branch hanging on a chapter, or a conversation of its
// own). A model may propose the plan (BuildImportAnalyzePrompt,
// ParseImportAnalyzeOutput); AnalyzeImportDeterministic always can, without
// one. Nothing is written: the client applies the plan to its assembly.

const (
	// ImportAnalyzeMaxUnits caps the units (rounds or sessions) analyzed in one call.
	ImportAnalyzeMaxUnits = 200
	// ImportAnalyzeQuestionRunes and ImportAnalyzeAnswerRunes cap each
	// unit's question and answer kept by NormalizeImportAnalyzeInput (B26):
	// enough for the model's prompt to show a long question's start and end
	// and an answer's first and last sentence and key terms.
	ImportAnalyzeQuestionRunes = 600
	ImportAnalyzeAnswerRunes   = 2000
	// ImportAnalyzeTextRunes is the excerpt of a question or an answer the
	// deterministic analyzer and the repair of a model's plan read (as the
	// web client's analyzeImportLocal does, and what the web client sends).
	ImportAnalyzeTextRunes = 300
	// ImportAnalyzeKeyRunes caps a unit's key.
	ImportAnalyzeKeyRunes = 200
	// ImportAnalyzeTitleRunes caps a unit's and the input's title.
	ImportAnalyzeTitleRunes = 200
	// ImportAnalyzeNodeTitleRunes caps a node's synthesized title.
	ImportAnalyzeNodeTitleRunes = 60
	// ImportAnalyzeConclusionRunes caps a node's drafted conclusion.
	ImportAnalyzeConclusionRunes = 300
	// ImportAnalyzeReasonRunes caps a node's reason.
	ImportAnalyzeReasonRunes = 200
	// ImportAnalyzeSummaryRunes caps the plan's summary.
	ImportAnalyzeSummaryRunes = 300
	// ImportAnalyzeMaxUnitMessages caps the message count one unit may claim.
	ImportAnalyzeMaxUnitMessages = 100000
)

// Roles of a node and modes of a plan.
const (
	ImportRoleChapter      = "chapter"
	ImportRoleMergedBranch = "merged_branch"
	ImportRoleOpenBranch   = "open_branch"
	ImportRoleStandalone   = "standalone"

	ImportModeTree     = "tree"
	ImportModeTimeline = "timeline"
	ImportModeBatch    = "batch"

	// ImportAnalyzeSourceModel and ImportAnalyzeSourceHeuristic say who made a plan.
	ImportAnalyzeSourceModel     = "model"
	ImportAnalyzeSourceHeuristic = "heuristic"
)

// ImportAnalyzeUnit is one Q&A round (or pre-cut segment) to be threaded and organized into a tree.
type ImportAnalyzeUnit struct {
	Key          string `json:"key"`
	Title        string `json:"title,omitempty"`
	Question     string `json:"question"`
	Answer       string `json:"answer"`
	MessageCount int    `json:"messageCount"`
	StartAt      string `json:"startAt,omitempty"`
}

// ImportAnalyzeInput is what one analysis reads.
type ImportAnalyzeInput struct {
	Title string              `json:"title,omitempty"`
	Units []ImportAnalyzeUnit `json:"units"`
}

// ImportAnalyzeNode is one synthesized topic node in the proposed tree.
type ImportAnalyzeNode struct {
	// Key is the primary unit key (the earliest unit in UnitKeys).
	Key string `json:"key"`
	// UnitKeys lists all input unit keys threaded into this topic node (in chronological order, e.g. ["u1", "u3", "u5"] for A->B->A->C->A).
	UnitKeys []string `json:"unitKeys"`
	// Title is the synthesized topic title (<= 60 runes).
	Title string `json:"title"`
	// Role is "chapter", "merged_branch", "open_branch", or "standalone".
	Role string `json:"role"`
	// AttachToKey is the key of the "chapter" node this branch hangs under (only when Role is merged_branch or open_branch).
	AttachToKey string `json:"attachToKey,omitempty"`
	// AttachAfterUnitKey is the specific unit key inside AttachToKey right before this branch forked (optional; defaults to the latest unit of AttachToKey before this branch).
	AttachAfterUnitKey string `json:"attachAfterUnitKey,omitempty"`
	// Conclusion is the drafted branch card conclusion (when Role is merged_branch).
	Conclusion string `json:"conclusion,omitempty"`
	// Reason explains briefly why these units were threaded or assigned this role (e.g. "跨段縫合 #1、#3、#5 的同主題問答").
	Reason string `json:"reason,omitempty"`
}

// ImportAnalyzePlan is the proposed tree.
type ImportAnalyzePlan struct {
	// Mode is the recommended assembly mode ("tree", "timeline", or "batch").
	Mode string `json:"mode"`
	// Source is "model" when the AI runner produced the plan, or "heuristic" when the deterministic analyzer produced it.
	Source string `json:"source"`
	// Summary is a human-readable 1-line summary of the analysis.
	Summary string `json:"summary"`
	// Nodes are the proposed tree nodes in order; every input unit Key appears in exactly one node's UnitKeys.
	Nodes []ImportAnalyzeNode `json:"nodes"`
}

func analyzeError(field, message string) error {
	return NewError(CodeInvalidInput, field+": "+message, map[string]any{"field": field})
}

// NormalizeImportAnalyzeInput checks an analysis input and returns it
// cleaned: 1 to ImportAnalyzeMaxUnits units with unique, non-empty keys
// (trimmed, at most ImportAnalyzeKeyRunes), texts cleaned and cut
// (questions to ImportAnalyzeQuestionRunes, answers to
// ImportAnalyzeAnswerRunes, titles flattened to ImportAnalyzeTitleRunes), message counts 0 to ImportAnalyzeMaxUnitMessages
// and start times RFC 3339 when given. A refusal is invalid_input naming the
// field.
func NormalizeImportAnalyzeInput(in ImportAnalyzeInput) (ImportAnalyzeInput, error) {
	if len(in.Units) == 0 || len(in.Units) > ImportAnalyzeMaxUnits {
		return ImportAnalyzeInput{}, analyzeError("units", fmt.Sprintf("an analysis has 1 to %d units", ImportAnalyzeMaxUnits))
	}
	out := ImportAnalyzeInput{Title: CutRunes(FlattenUntrusted(in.Title), ImportAnalyzeTitleRunes), Units: make([]ImportAnalyzeUnit, 0, len(in.Units))}
	seen := map[string]bool{}
	for i, unit := range in.Units {
		field := fmt.Sprintf("units[%d]", i)
		key := strings.TrimSpace(unit.Key)
		switch {
		case key == "":
			return ImportAnalyzeInput{}, analyzeError(field+".key", "a unit needs a key")
		case utf8.RuneCountInString(key) > ImportAnalyzeKeyRunes:
			return ImportAnalyzeInput{}, analyzeError(field+".key", fmt.Sprintf("a key has at most %d characters", ImportAnalyzeKeyRunes))
		case seen[key]:
			return ImportAnalyzeInput{}, analyzeError(field+".key", "the key "+key+" is used twice")
		case unit.MessageCount < 0 || unit.MessageCount > ImportAnalyzeMaxUnitMessages:
			return ImportAnalyzeInput{}, analyzeError(field+".messageCount", fmt.Sprintf("messageCount is 0 to %d", ImportAnalyzeMaxUnitMessages))
		}
		startAt := strings.TrimSpace(unit.StartAt)
		if startAt != "" {
			if _, err := time.Parse(time.RFC3339Nano, startAt); err != nil {
				return ImportAnalyzeInput{}, analyzeError(field+".startAt", "startAt is an RFC 3339 time")
			}
		}
		seen[key] = true
		out.Units = append(out.Units, ImportAnalyzeUnit{
			Key: key, Title: CutRunes(FlattenUntrusted(unit.Title), ImportAnalyzeTitleRunes),
			Question: CutRunes(cleanAnalyzeText(unit.Question), ImportAnalyzeQuestionRunes), Answer: CutRunes(cleanAnalyzeText(unit.Answer), ImportAnalyzeAnswerRunes),
			MessageCount: unit.MessageCount, StartAt: startAt,
		})
	}
	return out, nil
}

// cleanAnalyzeText is untrusted text with its line breaks kept (a first
// sentence ends at one), markers removed and fences defused.
func cleanAnalyzeText(text string) string { return CleanCardText(text) }

// analyzeExcerpts are normalized units as the deterministic analyzer and the
// repair of a model's plan read them: question and answer cut to
// ImportAnalyzeTextRunes. Cutting a normalized text again gives what cutting
// the raw text to ImportAnalyzeTextRunes gave before B26 kept more, so their
// output is unchanged and still equals the web client's analyzeImportLocal.
func analyzeExcerpts(units []ImportAnalyzeUnit) []ImportAnalyzeUnit {
	out := make([]ImportAnalyzeUnit, len(units))
	for i, unit := range units {
		unit.Question = CutRunes(unit.Question, ImportAnalyzeTextRunes)
		unit.Answer = CutRunes(unit.Answer, ImportAnalyzeTextRunes)
		out[i] = unit
	}
	return out
}

// AnalyzeImportDeterministic threads the units by their topic words and
// assigns roles, without a model (Source "heuristic"); in is checked first
// (NormalizeImportAnalyzeInput).
//
// Threading, unit by unit: a unit stays with the previous unit's node when
// that node has no reply yet, when the question opens like a follow-up
// (那, 如果, 為什麼, what about…) or names no topic word. Otherwise it joins
// the node (the previous one included) whose questions share the most topic
// words with its question, counting only words in one node's questions (the
// previous node on a tie, else the most recent); when none shares any, the
// B21 rule keeps it with the previous node if it shares a word with that
// node or the previous unit's answer, else it starts a node.
//
// Roles, node by node in order of their first unit: the first is a chapter;
// a node whose first unit falls strictly inside a chapter's span (between
// its first and last unit) is a detour and becomes a merged branch of the
// innermost such chapter, hung after that chapter's last unit before it; any
// other node of two or more units (or four or more messages) is a chapter;
// what is left is a conversation of its own. A role the import has no room
// for moves as the client's tree defaults do (withinTreeLimits).
func AnalyzeImportDeterministic(in ImportAnalyzeInput) (ImportAnalyzePlan, error) {
	clean, err := NormalizeImportAnalyzeInput(in)
	if err != nil {
		return ImportAnalyzePlan{}, err
	}
	units := analyzeExcerpts(clean.Units)
	clusters := threadAnalyzeUnits(clean.Title, units)
	nodes := assignAnalyzeRoles(units, clusters)
	return ImportAnalyzePlan{Mode: ImportModeTree, Source: ImportAnalyzeSourceHeuristic, Summary: analyzeSummary(nodes), Nodes: nodes}, nil
}

// analyzeSummary is the plan's one line: how many topics, chapters, branches
// and conversations of their own.
func analyzeSummary(nodes []ImportAnalyzeNode) string {
	chapters, branches, standalone := 0, 0, 0
	for _, node := range nodes {
		switch node.Role {
		case ImportRoleChapter:
			chapters++
		case ImportRoleMergedBranch, ImportRoleOpenBranch:
			branches++
		default:
			standalone++
		}
	}
	return fmt.Sprintf("跨段縫合為 %d 個主題：%d 個主幹章節、%d 條支線、%d 篇獨立對話", len(nodes), chapters, branches, standalone)
}
