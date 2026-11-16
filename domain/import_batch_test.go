package domain

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestPlanImportBatch(t *testing.T) {
	id := uuid.New()
	got, err := PlanImportBatch(" "+id.String()+" ", " a\nb.json ")
	if err != nil || got.ID != id || got.Label != "a b.json" {
		t.Fatalf("got %+v %v", got, err)
	}
	if none, err := PlanImportBatch("", ""); err != nil || none.ID != uuid.Nil {
		t.Fatalf("no batch: %+v %v", none, err)
	}
	if at, err := PlanImportBatch(id.String(), strings.Repeat("字", ImportBatchLabelMaxRunes)); err != nil || at.Label == "" {
		t.Fatalf("a label at the limit: %v", err)
	}
	for name, c := range map[string][2]string{
		"label alone": {"", "x"}, "not a uuid": {"abc", ""}, "nil uuid": {uuid.Nil.String(), ""},
		"too long": {id.String(), strings.Repeat("字", ImportBatchLabelMaxRunes+1)},
	} {
		_, err := PlanImportBatch(c[0], c[1])
		want := "batchId"
		if name == "label alone" || name == "too long" {
			want = "batchLabel"
		}
		if e, ok := err.(*Error); !ok || e.Code != CodeInvalidInput || e.Extra["field"] != want {
			t.Errorf("%s: %v", name, err)
		}
	}
	if CodeOf(ErrImportBatchNotFound) != "import_batch_not_found" {
		t.Fatal("code")
	}
}
