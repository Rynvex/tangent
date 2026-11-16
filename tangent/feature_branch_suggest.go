package tangent

import (
	"context"
	"errors"
	"strings"

	"github.com/Rynvex/tangent/domain"
)

// BranchSuggest lets the model propose side branches: the main line's prompt
// carries the [BRANCH-SUGGEST] rule (a branch's does not, unless its
// BranchPromptInfo opts in) and the reply's suggestion lines are parsed into
// meta.suggestions, which the operator can accept (CreateBranch with
// SuggestionMessageID). Suggest and Auto behave alike (a suggestion is never
// acted on by itself); Manual carries no rule and parses nothing, but stored
// suggestions can still be accepted. Off: no rule, no parsing, and accepting
// a suggestion returns feature_disabled.
func BranchSuggest(mode Mode, opts ...FeatureOption) Feature {
	return aiFeature(FeatureBranchSuggest, mode, opts, registerBranchSuggest)
}

func registerBranchSuggest(r *registry, _ *module) {
	r.addContextProvider(func(_ context.Context, _ *Engine, mode Mode, pc *promptContext) error {
		if mode >= ModeSuggest {
			pc.in.OmitBranchSuggestRules = false
		}
		return nil
	})
	r.addReplyFilter(func(e *Engine, mode Mode, reply *replyParts) {
		if mode >= ModeSuggest {
			reply.content, reply.suggestions = domain.ExtractBranchSuggestions(reply.content, e.limits.Branch)
		}
	})
}

// acceptSuggestion re-checks an accepted suggestion against the assistant
// message it came from and fills an empty excerpt from it.
func (e *Engine) acceptSuggestion(ctx context.Context, scope Scope, parentLineID string, in *BranchInput) error {
	message, err := e.store.GetMessage(ctx, scope.Tenant, parentLineID, strings.TrimSpace(in.SuggestionMessageID))
	if errors.Is(err, domain.ErrMessageNotFound) {
		return domain.ErrSuggestionNotFound
	}
	if err != nil {
		return err
	}
	suggestion, found := domain.FindBranchSuggestion(message.Meta, in.Purpose, in.Kind)
	if message.Role != domain.RoleAssistant || !found {
		return domain.ErrSuggestionNotFound
	}
	if strings.TrimSpace(in.Excerpt) == "" {
		in.Excerpt = suggestion.Excerpt
	}
	return nil
}
