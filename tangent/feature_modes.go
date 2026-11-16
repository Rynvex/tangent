package tangent

import (
	"context"
	"fmt"
	"strings"

	"github.com/Rynvex/tangent/domain"
)

// modeSet is every configured feature's effective mode for one scope,
// resolved once per call (before any transaction) so the host's policy is
// never asked while a row lock is held. A feature that is absent is off.
type modeSet map[string]Mode

func (m modeSet) of(name string) Mode { return m[name] }

// validMode reports whether m is one of the four modes.
func validMode(m Mode) bool { return m >= ModeOff && m <= ModeAuto }

// clampMode maps anything a policy returns onto the four modes; out-of-range
// values below fail closed (off), above mean "no narrowing" (auto).
func clampMode(m Mode) Mode {
	if m <= ModeOff {
		return ModeOff
	}
	return min(m, ModeAuto)
}

// modesFor resolves the effective modes for the scope: the lower of the
// configured mode and the policy's (so a policy only narrows), and off for
// a feature any of whose requirements is off.
func (e *Engine) modesFor(ctx context.Context, scope Scope) modeSet {
	modes := modeSet{}
	for name, configured := range e.features.modes {
		if mode := min(configured, clampMode(e.policy.Mode(ctx, scope, name))); mode != ModeOff {
			modes[name] = mode
		}
	}
	for changed := true; changed; {
		changed = false
		for name := range modes {
			for _, need := range e.features.requires[name] {
				if modes.of(need) == ModeOff {
					delete(modes, name)
					changed = true
				}
			}
		}
	}
	if e.features.inboxOn(modes) {
		modes[FeatureSuggestions] = ModeAuto
	}
	return modes
}

// requireFeature refuses with feature_disabled unless the feature is on.
func requireFeature(modes modeSet, name string) error {
	if modes.of(name) == ModeOff {
		return domain.FeatureDisabled(name)
	}
	return nil
}

// requireInput refuses an input of a core call whose owning feature is off;
// an input no feature owns is core and always allowed.
func requireInput(modes modeSet, input string) error {
	for _, entry := range catalog {
		for _, owned := range entry.inputs {
			if owned == input {
				return requireFeature(modes, entry.name)
			}
		}
	}
	return nil
}

// needScoped checks the scope and that the feature is on for it, and
// returns the scope's modes.
func (e *Engine) needScoped(ctx context.Context, scope Scope, feature string) (Scope, modeSet, error) {
	scope, err := checkScope(scope)
	if err != nil {
		return scope, nil, err
	}
	modes := e.modesFor(ctx, scope)
	return scope, modes, requireFeature(modes, feature)
}

// cooperates reports whether the feature that provides an optional
// capability (for example chapters' topic cuts, which summaries record) is
// on. Features cooperate this way without a hard Requires.
func (e *Engine) cooperates(modes modeSet, capability string) bool {
	feature, ok := e.features.provides[capability]
	return ok && modes.of(feature) != ModeOff
}

// buildRegistry checks names, modes and dependencies and lets each feature
// register its extension points. A feature configured ModeOff is as if it
// was not enabled.
func buildRegistry(features []Feature) (*registry, error) {
	r := newRegistry()
	seen := map[string]bool{}
	for _, f := range features {
		if err := checkFeature(f, seen); err != nil {
			return nil, err
		}
		if f.mode() != ModeOff {
			r.modes[f.Name()] = f.mode()
			r.requires[f.Name()] = f.Requires()
			r.features = append(r.features, f)
		}
	}
	for _, f := range r.features {
		for _, need := range f.Requires() {
			if _, ok := r.modes[need]; !ok {
				return nil, fmt.Errorf("tangent: feature %q requires feature %q", f.Name(), need)
			}
		}
	}
	for _, f := range r.features {
		r.current = f.Name()
		f.register(r)
	}
	if len(r.suggestionKinds) > 0 {
		r.current = FeatureSuggestions
		registerInbox(r)
	}
	r.current = ""
	return r, r.err
}

// checkFeature refuses a nil feature, a missing or repeated name and a mode
// outside the four.
func checkFeature(f Feature, seen map[string]bool) error {
	if f == nil {
		return fmt.Errorf("tangent: a nil feature was enabled")
	}
	name := strings.TrimSpace(f.Name())
	switch {
	case name == "":
		return fmt.Errorf("tangent: a feature has no name")
	case seen[name]:
		return fmt.Errorf("tangent: feature %q is enabled twice", name)
	case !validMode(f.mode()):
		return fmt.Errorf("tangent: feature %q has an invalid mode %d", name, f.mode())
	}
	seen[name] = true
	return nil
}
