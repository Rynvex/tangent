package tangent

import "context"

// Embedder turns texts into vectors for the memory feature (DESIGN §11):
// the host's model. Embed returns one vector of Dim() numbers per text, in
// order. runner/openai.NewEmbedder speaks the OpenAI-compatible
// /embeddings API; runner/fake.NewEmbedder is deterministic for tests.
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
	Dim() int
}
