package domain

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Importing a conversation written elsewhere (B18): a client parses an
// export (ChatGPT, Claude, Gemini, plain text, a Tangent backup) into a main
// line and first-level branches; the engine writes them in one transaction
// without calling a model. Everything here is pure: PlanImport checks and
// cleans the input. B19 keeps the source's dates (createdAt), writes
// milestone chapter cuts and branches already brought back with their card
// in the same transaction (import_assembly.go).

// Limits of an import.
const (
	// ImportMaxMessages caps the main line's messages.
	ImportMaxMessages = 2000
	// ImportMaxBranches caps the branches (all hang on the main line).
	ImportMaxBranches = 50
	// ImportMaxBranchMessages caps the messages of one branch.
	ImportMaxBranchMessages = 500
	// ImportTitleRunes caps a title or purpose taken from a message.
	ImportTitleRunes = 60
	// ImportSourceMaxRunes caps the source label.
	ImportSourceMaxRunes = 40
)

// Defaults of an imported branch: an earlier attempt that was left behind.
const (
	ImportDefaultBranchKind   = BranchKindAlternative
	ImportDefaultBranchStatus = BranchStatusDiscarded
)

// ImportMessage is one imported message. ExternalID is the source's id,
// used only to hang branches and chapter cuts on it. CreatedAt, when set,
// is when the source wrote it (B19).
type ImportMessage struct {
	ExternalID string     `json:"externalId"`
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	CreatedAt  *time.Time `json:"createdAt,omitempty"`
}

// ImportBranch is one imported branch, hanging on the main-line message
// named by AnchorExternalID. Kind is investigate or alternative (default
// alternative), Status open, discarded (the default) or merged; a merged
// branch carries the conclusion Card it left on the main line, and only a
// merged one does. CreatedAt, when set, is when the branch started.
type ImportBranch struct {
	AnchorExternalID string          `json:"anchorExternalId"`
	Purpose          string          `json:"purpose"`
	Kind             string          `json:"kind"`
	Status           string          `json:"status"`
	Card             *BranchCard     `json:"card,omitempty"`
	CreatedAt        *time.Time      `json:"createdAt,omitempty"`
	Messages         []ImportMessage `json:"messages"`
}

// ImportChapterCut is a milestone to set on the main-line message named by
// AnchorExternalID (B19).
type ImportChapterCut struct {
	AnchorExternalID string `json:"anchorExternalId"`
	Title            string `json:"title"`
}

// ImportInput is a whole imported conversation. An empty Title is taken
// from the first operator message. Source names where it came from (a
// label, at most ImportSourceMaxRunes; not stored). CreatedAt, when set,
// is when the conversation started; ChapterCuts are milestones on main-line
// messages. BatchID and BatchLabel, when set, put the line in an import
// batch (B25, PlanImportBatch).
type ImportInput struct {
	Title       string
	Provider    string
	Model       string
	Folder      string
	Tags        []string
	Source      string
	CreatedAt   *time.Time
	Messages    []ImportMessage
	Branches    []ImportBranch
	ChapterCuts []ImportChapterCut
	BatchID     string
	BatchLabel  string
}

// ImportPlan is a checked import: cleaned messages and branches whose
// anchor is an index into Messages. Dates is nil when the import carries
// no date at all (everything is written at the time of the import, as
// before B19); otherwise every message of the plan has its CreatedAt.
type ImportPlan struct {
	Title       string
	Source      string
	Dates       *ImportDates
	Messages    []ImportMessage
	Branches    []ImportPlanBranch
	ChapterCuts []ImportPlanCut
}

// ImportPlanBranch is a checked branch of an import. Card (with
// CardContent, its rendering) is set for a merged branch only. Dates is
// set when the import carries dates.
type ImportPlanBranch struct {
	AnchorIndex int
	Purpose     string
	Kind        string
	Status      string
	Card        *BranchCard
	CardContent string
	Dates       *ImportDates
	Messages    []ImportMessage
}

// PlanImport checks an import and cleans its text. Message content is
// cleaned like a host system message (CleanSystemText: line breaks
// normalised, control characters and protocol markers removed, code fences
// kept), must not be empty and is at most l.Text.MessageMaxRunes
// (too_long). Roles are user or assistant. Every other refusal is
// invalid_input naming the field.
//
// Dates (B19) are UTC between ImportEarliest and now + ImportFutureSlack
// (see planImportDates for how missing ones are filled); ChapterCuts and a
// merged branch's card are checked by planImportCuts and planImportCard.
func PlanImport(in ImportInput, l Limits, extraMarkers []string, now time.Time) (ImportPlan, error) {
	l = l.WithDefaults()
	source := strings.TrimSpace(FlattenUntrusted(in.Source))
	if utf8.RuneCountInString(source) > ImportSourceMaxRunes {
		return ImportPlan{}, importError("source", fmt.Sprintf("source is at most %d characters", ImportSourceMaxRunes))
	}
	if len(in.Messages) == 0 || len(in.Messages) > ImportMaxMessages {
		return ImportPlan{}, importError("messages", fmt.Sprintf("an import has 1 to %d messages", ImportMaxMessages))
	}
	if len(in.Branches) > ImportMaxBranches {
		return ImportPlan{}, importError("branches", fmt.Sprintf("an import has at most %d branches", ImportMaxBranches))
	}
	lineAt, err := checkImportTime("createdAt", in.CreatedAt, now)
	if err != nil {
		return ImportPlan{}, err
	}
	messages, err := cleanImportMessages("messages", in.Messages, l.Text, extraMarkers, now)
	if err != nil {
		return ImportPlan{}, err
	}
	anchors := map[string]int{}
	for i, message := range messages {
		if message.ExternalID == "" {
			continue
		}
		if _, dup := anchors[message.ExternalID]; dup {
			return ImportPlan{}, importError(fmt.Sprintf("messages[%d].externalId", i), "externalId is used twice")
		}
		anchors[message.ExternalID] = i
	}
	plan := ImportPlan{Title: strings.TrimSpace(in.Title), Source: source, Messages: messages, Branches: make([]ImportPlanBranch, 0, len(in.Branches))}
	if plan.Title == "" {
		plan.Title = ImportTitle(messages)
	}
	branchAt := make([]*time.Time, 0, len(in.Branches))
	for i, branch := range in.Branches {
		checked, at, err := planImportBranch(i, branch, anchors, l, extraMarkers, now)
		if err != nil {
			return ImportPlan{}, err
		}
		plan.Branches, branchAt = append(plan.Branches, checked), append(branchAt, at)
	}
	if plan.ChapterCuts, err = planImportCuts(in.ChapterCuts, anchors, l.Chapters); err != nil {
		return ImportPlan{}, err
	}
	return planImportDates(plan, lineAt, branchAt, now), nil
}

func planImportBranch(i int, in ImportBranch, anchors map[string]int, l Limits, extraMarkers []string, now time.Time) (ImportPlanBranch, *time.Time, error) {
	field := fmt.Sprintf("branches[%d]", i)
	anchor, ok := anchors[strings.TrimSpace(in.AnchorExternalID)]
	if !ok {
		return ImportPlanBranch{}, nil, importError(field+".anchorExternalId", "anchorExternalId names no message of the import")
	}
	out := ImportPlanBranch{AnchorIndex: anchor, Kind: strings.TrimSpace(in.Kind), Status: strings.TrimSpace(in.Status)}
	if out.Kind == "" {
		out.Kind = ImportDefaultBranchKind
	}
	if out.Kind != BranchKindInvestigate && out.Kind != BranchKindAlternative {
		return ImportPlanBranch{}, nil, importError(field+".kind", "kind is investigate or alternative")
	}
	if out.Status == "" {
		out.Status = ImportDefaultBranchStatus
	}
	if out.Status != BranchStatusOpen && out.Status != BranchStatusDiscarded && out.Status != BranchStatusMerged {
		return ImportPlanBranch{}, nil, importError(field+".status", "status is open, discarded or merged")
	}
	at, err := checkImportTime(field+".createdAt", in.CreatedAt, now)
	if err != nil {
		return ImportPlanBranch{}, nil, err
	}
	if len(in.Messages) == 0 || len(in.Messages) > ImportMaxBranchMessages {
		return ImportPlanBranch{}, nil, importError(field+".messages", fmt.Sprintf("a branch has 1 to %d messages", ImportMaxBranchMessages))
	}
	if out.Messages, err = cleanImportMessages(field+".messages", in.Messages, l.Text, extraMarkers, now); err != nil {
		return ImportPlanBranch{}, nil, err
	}
	purpose := strings.TrimSpace(in.Purpose)
	if purpose == "" {
		purpose = ImportTitle(out.Messages)
	}
	if out.Purpose, ok = NormalizeBranchPurpose(purpose, l.Branch); !ok {
		return ImportPlanBranch{}, nil, refine(ErrInvalidPurpose, fmt.Sprintf("%s.purpose: %s", field, ErrInvalidPurpose.Message), map[string]any{"field": field + ".purpose"})
	}
	if out.Card, out.CardContent, err = planImportCard(field, in.Card, out.Status, out.Purpose); err != nil {
		return ImportPlanBranch{}, nil, err
	}
	return out, at, nil
}

// cleanImportMessages checks and cleans the messages of one list.
func cleanImportMessages(field string, in []ImportMessage, l TextLimits, extraMarkers []string, now time.Time) ([]ImportMessage, error) {
	out := make([]ImportMessage, 0, len(in))
	for i, message := range in {
		at := fmt.Sprintf("%s[%d]", field, i)
		role := strings.TrimSpace(message.Role)
		if role != RoleUser && role != RoleAssistant {
			return nil, importError(at+".role", "role is user or assistant")
		}
		content := CleanSystemText(message.Content, extraMarkers)
		if content == "" {
			return nil, importError(at+".content", "content is empty")
		}
		if err := CheckRunes(at+".content", content, l.MessageMaxRunes); err != nil {
			return nil, err
		}
		createdAt, err := checkImportTime(at+".createdAt", message.CreatedAt, now)
		if err != nil {
			return nil, err
		}
		out = append(out, ImportMessage{ExternalID: strings.TrimSpace(message.ExternalID), Role: role, Content: content, CreatedAt: createdAt})
	}
	return out, nil
}

// ImportTitle is the title of an imported conversation (or the purpose of
// an imported branch) that names none: the first operator message (the
// first message when there is none) on one line, cut to ImportTitleRunes.
func ImportTitle(messages []ImportMessage) string {
	for _, message := range messages {
		if message.Role == RoleUser {
			return CutRunes(FlattenUntrusted(message.Content), ImportTitleRunes)
		}
	}
	if len(messages) == 0 {
		return ""
	}
	return CutRunes(FlattenUntrusted(messages[0].Content), ImportTitleRunes)
}

func importError(field, message string) error {
	return NewError(CodeInvalidInput, field+": "+message, map[string]any{"field": field})
}
