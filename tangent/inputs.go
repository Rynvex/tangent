package tangent

import (
	"cmp"
	"context"
	"strings"

	"github.com/Rynvex/tangent/domain"
)

// modelPair is a provider and model hint.
type modelPair struct {
	provider string
	model    string
}

// WithDefaultModel fills the provider and model of a new main line that
// names neither (the model alone when the line names this provider).
func WithDefaultModel(provider, model string) Option {
	return func(c *config) {
		c.defaults = modelPair{provider: strings.TrimSpace(provider), model: strings.TrimSpace(model)}
	}
}

// WithModelCheck restricts the provider/model pairs callers may choose for
// a line or a branch; a refused pair is model_not_allowed. Without it every
// pair is allowed (the runner decides).
func WithModelCheck(allow func(provider, model string) bool) Option {
	return func(c *config) { c.allowModel = allow }
}

// checkText applies a rune cap to one field.
func checkText(field, text string, max int) error {
	return domain.CheckRunes(field, text, max)
}

// checkModelNames caps a provider and model hint.
func (e *Engine) checkModelNames(provider, model string) error {
	if err := checkText("provider", provider, e.limits.Text.ModelMaxRunes); err != nil {
		return err
	}
	return checkText("model", model, e.limits.Text.ModelMaxRunes)
}

// checkModel asks the host's model check about a pair.
func (e *Engine) checkModel(provider, model string) error {
	if e.allowModel == nil || e.allowModel(provider, model) {
		return nil
	}
	return domain.ModelNotAllowed(provider, model)
}

// lineInput caps a new line's text, fills the default model and checks it.
func (e *Engine) lineInput(in LineInput) (LineInput, error) {
	in.Provider, in.Model = strings.TrimSpace(in.Provider), strings.TrimSpace(in.Model)
	if err := checkText("title", in.Title, e.limits.Text.TitleMaxRunes); err != nil {
		return in, err
	}
	if err := e.checkModelNames(in.Provider, in.Model); err != nil {
		return in, err
	}
	if in.Provider == "" && in.Model == "" {
		in.Provider, in.Model = e.defaults.provider, e.defaults.model
	} else if in.Model == "" && in.Provider == e.defaults.provider {
		in.Model = e.defaults.model
	}
	return in, e.checkModel(in.Provider, in.Model)
}

// linePatch caps an edit and checks the pair the line would end up with.
func (e *Engine) linePatch(ctx context.Context, scope Scope, lineID string, patch LinePatch) error {
	if patch.Title != nil {
		if err := checkText("title", *patch.Title, e.limits.Text.TitleMaxRunes); err != nil {
			return err
		}
	}
	if err := e.checkModelNames(deref(patch.Provider), deref(patch.Model)); err != nil {
		return err
	}
	if e.allowModel == nil || (patch.Provider == nil && patch.Model == nil) {
		return nil
	}
	line, err := e.store.GetLine(ctx, scope.Tenant, lineID)
	if err != nil {
		return err
	}
	return e.checkModel(cmp.Or(strings.TrimSpace(deref(patch.Provider)), line.Provider), cmp.Or(strings.TrimSpace(deref(patch.Model)), line.Model))
}

// branchModel caps a new branch's provider/model override and checks the
// pair it will run with (the parent's, where it names none).
func (e *Engine) branchModel(ctx context.Context, scope Scope, parentLineID, provider, model string) error {
	if err := e.checkModelNames(provider, model); err != nil {
		return err
	}
	if e.allowModel == nil || (strings.TrimSpace(provider) == "" && strings.TrimSpace(model) == "") {
		return nil
	}
	parent, err := e.store.GetLine(ctx, scope.Tenant, parentLineID)
	if err != nil {
		return err
	}
	return e.checkModel(cmp.Or(strings.TrimSpace(provider), parent.Provider), cmp.Or(strings.TrimSpace(model), parent.Model))
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
