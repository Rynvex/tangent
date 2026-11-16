package openai_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/runner/openai"
)

func TestEmbedder_PostsTheTextsAndReadsTheVectorsInOrder(t *testing.T) {
	var got struct {
		Model      string   `json:"model"`
		Input      []string `json:"input"`
		Dimensions int      `json:"dimensions"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/embeddings" || r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Errorf("request %s %s", r.URL.Path, r.Header.Get("Authorization"))
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"data":[{"index":1,"embedding":[0,1,0]},{"index":0,"embedding":[1,0,0]}]}`))
	}))
	defer srv.Close()
	e, err := openai.NewEmbedder(openai.EmbedderConfig{BaseURL: srv.URL + "/v1", APIKey: "sk-test", Model: "text-embedding-3-small", Dim: 3})
	if err != nil {
		t.Fatal(err)
	}
	vectors, err := e.Embed(context.Background(), []string{"a", "b"})
	if err != nil || len(vectors) != 2 || vectors[0][0] != 1 || vectors[1][1] != 1 || e.Dim() != 3 {
		t.Fatalf("vectors = %v %v", vectors, err)
	}
	if got.Model != "text-embedding-3-small" || strings.Join(got.Input, ",") != "a,b" || got.Dimensions != 3 {
		t.Fatalf("request = %+v", got)
	}
}

func TestEmbedder_Refusals(t *testing.T) {
	if _, err := openai.NewEmbedder(openai.EmbedderConfig{Model: "m"}); err == nil {
		t.Fatal("a dimension is required")
	}
	if _, err := openai.NewEmbedder(openai.EmbedderConfig{Dim: 3}); err == nil {
		t.Fatal("a model is required")
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("case") {
		default:
			http.Error(w, `{"error":{"message":"sk-secret is invalid"}}`, http.StatusUnauthorized)
		}
	}))
	defer bad.Close()
	e, _ := openai.NewEmbedder(openai.EmbedderConfig{BaseURL: bad.URL, APIKey: "sk-secret", Model: "m", Dim: 3})
	if _, err := e.Embed(context.Background(), []string{"a"}); err == nil || strings.Contains(err.Error(), "sk-secret") {
		t.Fatalf("an error without the key: %v", err)
	}
	short := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"index":0,"embedding":[1,0]}]}`))
	}))
	defer short.Close()
	e, _ = openai.NewEmbedder(openai.EmbedderConfig{BaseURL: short.URL, Model: "m", Dim: 3})
	if _, err := e.Embed(context.Background(), []string{"a"}); err == nil {
		t.Fatal("a vector of another size is refused")
	}
	if v, err := e.Embed(context.Background(), nil); err != nil || len(v) != 0 {
		t.Fatalf("nothing to embed: %v %v", v, err)
	}
}
