package store_test

import (
	"errors"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestFisheye_PinnedMessagesAndTheTree(t *testing.T) {
	f := newFixture(t)
	main, _, branch := f.treeWithBranch()
	old := f.exchange(main.ID, "old", "pinned")
	f.exchange(main.ID, "new", "not pinned")
	if _, err := f.store.PinMessage(f.ctx, tenant, old.ID, true); err != nil {
		t.Fatal(err)
	}
	pinned, err := f.store.PinnedMessages(f.ctx, tenant, main.ID, 10)
	if err != nil || len(pinned) != 1 || pinned[0].ID != old.ID {
		t.Fatalf("pinned = %+v %v", pinned, err)
	}
	if _, err := f.store.PinnedMessages(f.ctx, otherTenant, main.ID, 10); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
	deep := f.branch(branch.ID, f.reply(branch.ID).ID)
	f.exec(`INSERT INTO tangent_leaf (line_id, tenant_id, root_line_id, kind, line, status) VALUES ($1, $2, $3, 'decision', 'chosen', 'confirmed')`, branch.ID, tenant, main.ID)
	tree, err := f.store.FisheyeTree(f.ctx, tenant, deep.ID)
	if err != nil || tree.RootLineID != main.ID || len(tree.Branches) != 2 {
		t.Fatalf("tree = %+v %v", tree, err)
	}
	first := tree.Branches[0]
	if first.LineID != branch.ID || first.ParentLineID != main.ID || first.LeafKind != domain.LeafKindDecision || first.LeafLine != "chosen" {
		t.Fatalf("first = %+v", first)
	}
	if tree.Branches[1].ParentLineID != branch.ID || tree.Branches[1].LeafKind != "" {
		t.Fatalf("second = %+v", tree.Branches[1])
	}
	if _, err := f.store.FisheyeTree(f.ctx, otherTenant, main.ID); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
	var _ store.FisheyeTreeBranch = first
}
