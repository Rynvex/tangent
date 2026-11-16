package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// RecallSample is a fixed set of memories and the queries that should
// recall them. A memory with Supersedes replaces the earlier memory of that
// key (the old one stays, superseded, and must never be recalled).
type RecallSample struct {
	Name     string         `json:"name"`
	Memories []SampleMemory `json:"memories"`
	Queries  []RecallQuery  `json:"queries"`
}

// SampleMemory is one memory of a recall sample.
type SampleMemory struct {
	Key        string `json:"key"`
	Kind       string `json:"kind"`
	Text       string `json:"text"`
	Importance int    `json:"importance"`
	Supersedes string `json:"supersedes"`
}

// RecallQuery is a new conversation's first message and the keys of the
// memories it should recall.
type RecallQuery struct {
	Query  string   `json:"query"`
	Expect []string `json:"expect"`
}

// loadRecallSamples reads every *.json recall sample of dir, by name.
func loadRecallSamples(dir string) ([]RecallSample, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no recall samples in %s", dir)
	}
	slices.Sort(files)
	samples := make([]RecallSample, 0, len(files))
	for _, file := range files {
		sample, err := loadRecallSample(file)
		if err != nil {
			return nil, err
		}
		samples = append(samples, sample)
	}
	return samples, nil
}

func loadRecallSample(path string) (RecallSample, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return RecallSample{}, err
	}
	var s RecallSample
	if err := json.Unmarshal(raw, &s); err != nil {
		return RecallSample{}, fmt.Errorf("%s: %w", path, err)
	}
	if err := s.validate(); err != nil {
		return RecallSample{}, fmt.Errorf("%s: %w", path, err)
	}
	return s, nil
}

// validate checks the keys: unique, a replaced memory written earlier, and
// every expected memory known and not replaced.
func (s RecallSample) validate() error {
	if strings.TrimSpace(s.Name) == "" || len(s.Memories) == 0 || len(s.Queries) == 0 {
		return errors.New("a recall sample needs a name, memories and queries")
	}
	known, replaced := map[string]bool{}, map[string]bool{}
	for _, m := range s.Memories {
		if m.Key == "" || known[m.Key] {
			return fmt.Errorf("memory key %q is empty or repeated", m.Key)
		}
		if m.Supersedes != "" && !known[m.Supersedes] {
			return fmt.Errorf("memory %s supersedes %q, which is not written before it", m.Key, m.Supersedes)
		}
		known[m.Key], replaced[m.Supersedes] = true, true
	}
	for _, q := range s.Queries {
		if strings.TrimSpace(q.Query) == "" || len(q.Expect) == 0 {
			return errors.New("a query needs text and expected memories")
		}
		for _, key := range q.Expect {
			if !known[key] || replaced[key] {
				return fmt.Errorf("query %q expects %q, which is unknown or superseded", q.Query, key)
			}
		}
	}
	return nil
}
