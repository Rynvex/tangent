package domain

import (
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

// Import batches (B25): the imports of one client action ("import these
// files") share a batch id the client chose, so the batch can be listed and
// undone later rather than only within one browser session. A batch row
// belongs to one tenant; the lines name it (no foreign key: a line outlives
// its batch row).

// ImportBatchLabelMaxRunes caps a batch's label (for example a file name).
const ImportBatchLabelMaxRunes = 120

// Why DELETE /imports/{id} kept a line of the batch.
const (
	// ImportKeptAttached: the line was attached to another conversation
	// (it is a branch there now).
	ImportKeptAttached = "attached"
	// ImportKeptBusy: a line of its tree is answering.
	ImportKeptBusy = "busy"
	// ImportKeptChanged: the conversation was used after the import (and
	// force was not given).
	ImportKeptChanged = "changed"
)

// ErrImportBatchNotFound: no such batch for this tenant.
var ErrImportBatchNotFound = NewError(CodeImportBatchNotFound, "import batch not found", nil)

// ImportBatch is one batch as GET /imports lists it. LineCount counts the
// lines of the batch that still exist, StandaloneCount those of them that
// are still main lines (an attached one is not).
type ImportBatch struct {
	ID              string    `json:"id"`
	Label           string    `json:"label"`
	CreatedAt       time.Time `json:"createdAt"`
	LineCount       int       `json:"lineCount"`
	StandaloneCount int       `json:"standaloneCount"`
}

// KeptImportLine is a line of a batch that undoing the batch did not
// delete, and why (ImportKept*).
type KeptImportLine struct {
	LineID string `json:"lineId"`
	Reason string `json:"reason"`
}

// ImportBatchDeletion is what undoing a batch did: the main lines whose
// trees were deleted and the lines kept, both in import order.
type ImportBatchDeletion struct {
	Deleted []string         `json:"deleted"`
	Kept    []KeptImportLine `json:"kept"`
}

// ImportBatchRef is a checked batch of an import; a zero ID is none.
type ImportBatchRef struct {
	ID    uuid.UUID
	Label string
}

// PlanImportBatch checks an import's batch fields: id empty means no batch
// (and then no label); otherwise a UUID other than the nil one. The label is
// flattened to one line, trimmed and at most ImportBatchLabelMaxRunes. Every
// refusal is invalid_input naming batchId or batchLabel.
func PlanImportBatch(id, label string) (ImportBatchRef, error) {
	id = strings.TrimSpace(id)
	label = strings.TrimSpace(FlattenUntrusted(label))
	if id == "" {
		if label != "" {
			return ImportBatchRef{}, importError("batchLabel", "batchLabel needs a batchId")
		}
		return ImportBatchRef{}, nil
	}
	parsed, err := uuid.Parse(id)
	if err != nil || parsed == uuid.Nil {
		return ImportBatchRef{}, importError("batchId", "batchId is a UUID chosen by the client")
	}
	if utf8.RuneCountInString(label) > ImportBatchLabelMaxRunes {
		return ImportBatchRef{}, NewError(CodeInvalidInput, "batchLabel: the label is too long",
			map[string]any{"field": "batchLabel", "max": ImportBatchLabelMaxRunes})
	}
	return ImportBatchRef{ID: parsed, Label: label}, nil
}
