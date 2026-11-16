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

// A sample is one fixed conversation: a main line of exchanges (some
// replies pinned), branches anchored on a parent's reply and ended the way
// they say, and the questions (asks) whose prompts the evaluation compares.

// mainLineName is the name a sample uses for its main line.
const mainLineName = "main"

// Branch endings.
const (
	endMerge   = "merge"
	endDiscard = "discard"
	endOpen    = "open"
)

// Exchange is an operator message and the reply to it.
type Exchange struct {
	User      string `json:"user"`
	Assistant string `json:"assistant"`
}

// SampleBranch is a branch of a sample: it opens on the reply of exchange At
// of its parent (main or an earlier branch) and ends with End (merge, with
// Card; discard; or open). Leaf, when set, is written once it ended.
type SampleBranch struct {
	Name      string      `json:"name"`
	Parent    string      `json:"parent"`
	At        int         `json:"at"`
	Purpose   string      `json:"purpose"`
	End       string      `json:"end"`
	Card      *SampleCard `json:"card"`
	Leaf      *SampleLeaf `json:"leaf"`
	Exchanges []Exchange  `json:"exchanges"`
}

// SampleCard is a merged branch's conclusion card.
type SampleCard struct {
	Question   string `json:"question"`
	Conclusion string `json:"conclusion"`
}

// SampleLeaf is a branch's leaf.
type SampleLeaf struct {
	Kind string `json:"kind"`
	Line string `json:"line"`
}

// Ask is a question the operator asks next on a line, with the facts a
// good answer relies on (for grading).
type Ask struct {
	Line     string   `json:"line"`
	Question string   `json:"question"`
	Expect   []string `json:"expect"`
}

// Sample is one fixed conversation.
type Sample struct {
	Name     string         `json:"name"`
	Title    string         `json:"title"`
	Main     []Exchange     `json:"main"`
	Pins     []int          `json:"pins"`
	Branches []SampleBranch `json:"branches"`
	Asks     []Ask          `json:"asks"`
}

// loadSamples reads every *.json sample of a directory, by file name.
func loadSamples(dir string) ([]Sample, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no samples in %s", dir)
	}
	slices.Sort(files)
	samples := make([]Sample, 0, len(files))
	for _, file := range files {
		sample, err := loadSample(file)
		if err != nil {
			return nil, err
		}
		samples = append(samples, sample)
	}
	return samples, nil
}

// loadSample reads and checks one sample.
func loadSample(path string) (Sample, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Sample{}, err
	}
	var sample Sample
	if err := json.Unmarshal(raw, &sample); err != nil {
		return Sample{}, fmt.Errorf("%s: %w", path, err)
	}
	if err := sample.check(); err != nil {
		return Sample{}, fmt.Errorf("%s: %w", path, err)
	}
	return sample, nil
}

// check refuses a sample the loader could not build.
func (s Sample) check() error {
	if strings.TrimSpace(s.Name) == "" || len(s.Main) == 0 || len(s.Asks) == 0 {
		return errors.New("a sample needs a name, main exchanges and asks")
	}
	for _, pin := range s.Pins {
		if pin < 0 || pin >= len(s.Main) {
			return fmt.Errorf("pin %d is not a main exchange", pin)
		}
	}
	lengths := map[string]int{mainLineName: len(s.Main)}
	for _, b := range s.Branches {
		if err := b.check(lengths); err != nil {
			return fmt.Errorf("branch %q: %w", b.Name, err)
		}
		lengths[b.Name] = len(b.Exchanges)
	}
	for _, ask := range s.Asks {
		if _, ok := lengths[ask.Line]; !ok || strings.TrimSpace(ask.Question) == "" {
			return fmt.Errorf("ask on %q: no such line or no question", ask.Line)
		}
	}
	return nil
}

func (b SampleBranch) check(lengths map[string]int) error {
	parent, ok := lengths[b.Parent]
	switch {
	case strings.TrimSpace(b.Name) == "" || b.Name == mainLineName:
		return errors.New("a branch needs its own name")
	case !ok:
		return fmt.Errorf("no earlier line %q", b.Parent)
	case b.At < 0 || b.At >= parent:
		return fmt.Errorf("exchange %d is not on %q", b.At, b.Parent)
	case b.End != endMerge && b.End != endDiscard && b.End != endOpen:
		return fmt.Errorf("end %q is not merge, discard or open", b.End)
	case b.End == endMerge && b.Card == nil:
		return errors.New("a merge needs a card")
	}
	return nil
}
