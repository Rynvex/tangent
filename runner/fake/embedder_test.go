package fake_test

import (
	"context"
	"math"
	"testing"

	"github.com/Rynvex/tangent/runner/fake"
)

func cosine(a, b []float32) float64 {
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	return dot / math.Sqrt(na*nb)
}

func TestEmbedder_IsDeterministicAndSharedWordsAreNear(t *testing.T) {
	e := fake.NewEmbedder(0)
	if e.Dim() != fake.DefaultEmbeddingDim {
		t.Fatalf("dim = %d", e.Dim())
	}
	got, err := e.Embed(context.Background(), []string{"Use a ZFS mirror", "use zfs mirror!", "Bake sourdough bread", "", "用 ZFS 鏡像"})
	if err != nil || len(got) != 5 || len(got[0]) != fake.DefaultEmbeddingDim {
		t.Fatalf("embed = %d %v", len(got), err)
	}
	again, _ := e.Embed(context.Background(), []string{"Use a ZFS mirror"})
	if cosine(got[0], again[0]) < 0.9999 {
		t.Fatal("the same text gives the same vector")
	}
	if near, far := cosine(got[0], got[1]), cosine(got[0], got[2]); near < 0.8 || far > 0.3 {
		t.Fatalf("near %v far %v", near, far)
	}
	if cosine(got[3], got[3]) < 0.99 || cosine(got[0], got[4]) < 0.2 {
		t.Fatalf("empty text is not a zero vector; CJK shares the ZFS token: %v", cosine(got[0], got[4]))
	}
}
