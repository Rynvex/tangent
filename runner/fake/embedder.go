package fake

import (
	"context"
	"hash/fnv"
	"math"
	"strings"
	"unicode"
)

// DefaultEmbeddingDim is the size of the fake Embedder's vectors.
const DefaultEmbeddingDim = 256

// Embedder is a deterministic tangent.Embedder for tests, smoke and the
// reference server's fake mode: each word (Latin letters and digits, case
// folded) and each CJK character is hashed onto one dimension, so texts
// that share words are near. No network, no key.
type Embedder struct{ dim int }

// NewEmbedder returns a fake Embedder of dim dimensions (default 256).
func NewEmbedder(dim int) *Embedder {
	if dim <= 0 {
		dim = DefaultEmbeddingDim
	}
	return &Embedder{dim: dim}
}

// Dim is the size of the vectors.
func (e *Embedder) Dim() int { return e.dim }

// Embed returns one unit vector per text, in order.
func (e *Embedder) Embed(_ context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, 0, len(texts))
	for _, text := range texts {
		out = append(out, e.vector(text))
	}
	return out, nil
}

func (e *Embedder) vector(text string) []float32 {
	v := make([]float64, e.dim)
	for _, token := range tokens(text) {
		h := fnv.New32a()
		_, _ = h.Write([]byte(token))
		v[h.Sum32()%uint32(e.dim)]++
	}
	norm := 0.0
	for _, x := range v {
		norm += x * x
	}
	out := make([]float32, e.dim)
	if norm == 0 {
		out[e.dim-1] = 1 // never a zero vector: its cosine is undefined
		return out
	}
	for i, x := range v {
		out[i] = float32(x / math.Sqrt(norm))
	}
	return out
}

// tokens are the words and CJK characters of a text.
func tokens(text string) []string {
	out := []string{}
	var word strings.Builder
	flush := func() {
		if word.Len() > 0 {
			out = append(out, word.String())
			word.Reset()
		}
	}
	for _, r := range strings.ToLower(text) {
		switch {
		case unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r):
			flush()
			out = append(out, string(r))
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			word.WriteRune(r)
		default:
			flush()
		}
	}
	flush()
	return out
}
