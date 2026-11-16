package main

import (
	"cmp"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/runner/openai"
	"github.com/Rynvex/tangent/tangent"
)

// Embedders of the memory feature (TANGENT_EMBEDDER).
const (
	embedderFake   = "fake"
	embedderOpenAI = "openai"
	// defaultEmbeddingModel and defaultEmbeddingDim are OpenAI's small
	// model at its full size.
	defaultEmbeddingModel = "text-embedding-3-small"
	defaultEmbeddingDim   = 1536
)

// readEmbedder builds the memory feature's Embedder: TANGENT_EMBEDDER fake
// (deterministic, no network; the default with the fake provider) or openai
// (the OpenAI-compatible /embeddings of TANGENT_OPENAI_BASE_URL with
// OPENAI_API_KEY, TANGENT_EMBEDDING_MODEL and TANGENT_EMBEDDING_DIM). It
// records what it built in cfg.Embedder for the startup log.
func readEmbedder(cfg *config, get func(string) string) (tangent.Embedder, error) {
	dim := 0
	if text := get("TANGENT_EMBEDDING_DIM"); text != "" {
		n, err := strconv.Atoi(text)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("TANGENT_EMBEDDING_DIM must be a positive whole number, got %q", text)
		}
		dim = n
	}
	kind := strings.ToLower(get("TANGENT_EMBEDDER"))
	if kind == "" && cfg.Provider == providerFake {
		kind = embedderFake
	}
	switch kind {
	case embedderFake:
		cfg.Embedder = embedderFake
		return fake.NewEmbedder(dim), nil
	case embedderOpenAI:
		if cfg.OpenAI.APIKey == "" {
			return nil, errors.New("TANGENT_EMBEDDER=openai needs OPENAI_API_KEY (or TANGENT_OPENAI_API_KEY)")
		}
		model := cmp.Or(get("TANGENT_EMBEDDING_MODEL"), defaultEmbeddingModel)
		dim = cmp.Or(dim, defaultEmbeddingDim)
		cfg.Embedder = fmt.Sprintf("openai %s/%d", model, dim)
		return openai.NewEmbedder(openai.EmbedderConfig{BaseURL: cfg.OpenAI.BaseURL, APIKey: cfg.OpenAI.APIKey, Model: model, Dim: dim})
	case "":
		return nil, errors.New("the memory feature needs TANGENT_EMBEDDER: fake or openai")
	}
	return nil, fmt.Errorf("TANGENT_EMBEDDER must be fake or openai, got %q", kind)
}
