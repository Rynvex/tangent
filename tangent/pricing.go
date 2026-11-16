package tangent

import (
	"strings"

	"github.com/Rynvex/tangent/domain"
)

// Price is what a model costs, in USD per million tokens. A cache rate left
// at zero charges those tokens at the Input rate.
type Price struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead,omitempty"`
	CacheWrite float64 `json:"cacheWrite,omitempty"`
}

// tokensPerPriceUnit is the token count a Price rate is quoted for.
const tokensPerPriceUnit = 1_000_000

// Cost is the price of a usage: uncached input, cache reads and writes, and
// output, each at its rate.
func (p Price) Cost(u domain.Usage) float64 {
	cacheRead, cacheWrite := p.CacheRead, p.CacheWrite
	if cacheRead == 0 {
		cacheRead = p.Input
	}
	if cacheWrite == 0 {
		cacheWrite = p.Input
	}
	uncached := max(u.InputTokens-u.CacheReadTokens-u.CacheWriteTokens, 0)
	total := float64(uncached)*p.Input + float64(u.CacheReadTokens)*cacheRead +
		float64(u.CacheWriteTokens)*cacheWrite + float64(u.OutputTokens)*p.Output
	return total / tokensPerPriceUnit
}

// WithPricing names the price of each model (keyed by model name). With a
// price, PreviewTurn estimates the prompt's cost and RunTurn prices usage
// that the runner reported without a cost.
func WithPricing(prices map[string]Price) Option {
	return func(c *config) {
		c.pricing = make(map[string]Price, len(prices))
		for model, price := range prices {
			if model = strings.TrimSpace(model); model != "" {
				c.pricing[model] = price
			}
		}
	}
}

// priceOf is the configured price of a model.
func (e *Engine) priceOf(model string) (Price, bool) {
	price, ok := e.pricing[strings.TrimSpace(model)]
	return price, ok
}

// priced fills in the cost of a usage the runner left unpriced.
func (e *Engine) priced(model string, u domain.Usage) domain.Usage {
	if u.CostUSD != 0 {
		return u
	}
	if price, ok := e.priceOf(model); ok {
		u.CostUSD = price.Cost(u)
	}
	return u
}

// estimateCost is the input-side cost of a prompt of tokens for the model;
// nil when the model has no price.
func (e *Engine) estimateCost(model string, tokens int) *float64 {
	price, ok := e.priceOf(model)
	if !ok {
		return nil
	}
	cost := price.Cost(domain.Usage{InputTokens: int64(tokens)})
	return &cost
}
