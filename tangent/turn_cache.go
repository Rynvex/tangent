package tangent

import (
	"container/list"
	"sync"
)

// turnRef is where a pending turn lives and who started it, remembered so
// deltas and completion need no read.
type turnRef struct {
	turnID     string
	tenant     string
	actor      string
	lineID     string
	rootLineID string
	// asks is what this process's prompt of the turn asked the model for.
	asks turnAsks
}

// turnAsks is what a turn's prompt asked of the model beyond the answer:
// a [TOPIC] line, a [CHAPTER] line, the operator message the turn answers
// (where a chapter cut lands) and the title (main line) or purpose
// (branch) the prompt saw, so a rename made meanwhile is kept. Only kept in memory: a turn
// completed by a process that did not build its prompt (or after a
// restart) has none, and its marker lines are only removed.
type turnAsks struct {
	topic         bool
	chapterCut    bool
	userMessageID string
	seen          string
}

// scope is the scope of the turn: its tenant and the actor who began it.
func (r turnRef) scope() Scope { return Scope{Tenant: r.tenant, Actor: r.actor} }

// turnCacheMax bounds the remembered turns; the least recently used goes
// first, so turns a host never completes in this process age out.
const turnCacheMax = 4096

// turnCache is an LRU of the turns this process began or streamed, indexed
// by line too. An entry is dropped when the turn ends here, when a write
// learns it is no longer pending, and when its line is deleted.
type turnCache struct {
	mu     sync.Mutex
	order  *list.List
	refs   map[string]*list.Element
	byLine map[string]map[string]bool
}

func newTurnCache() *turnCache {
	return &turnCache{order: list.New(), refs: map[string]*list.Element{}, byLine: map[string]map[string]bool{}}
}

func (c *turnCache) put(ref turnRef) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if element, ok := c.refs[ref.turnID]; ok {
		c.unindex(element.Value.(turnRef))
		element.Value = ref
		c.index(ref)
		c.order.MoveToFront(element)
		return
	}
	c.refs[ref.turnID] = c.order.PushFront(ref)
	c.index(ref)
	for c.order.Len() > turnCacheMax {
		c.remove(c.order.Back())
	}
}

func (c *turnCache) get(turnID string) (turnRef, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	element, ok := c.refs[turnID]
	if !ok {
		return turnRef{}, false
	}
	c.order.MoveToFront(element)
	return element.Value.(turnRef), true
}

// setAsks records what the turn's prompt asked for on a remembered turn.
func (c *turnCache) setAsks(turnID string, asks turnAsks) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if element, ok := c.refs[turnID]; ok {
		ref := element.Value.(turnRef)
		ref.asks = asks
		element.Value = ref
	}
}

func (c *turnCache) drop(turnID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if element, ok := c.refs[turnID]; ok {
		c.remove(element)
	}
}

// dropLines forgets every turn of the lines (they were deleted).
func (c *turnCache) dropLines(lineIDs []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, lineID := range lineIDs {
		for turnID := range c.byLine[lineID] {
			c.remove(c.refs[turnID])
		}
	}
}

func (c *turnCache) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.order.Len()
}

// remove drops one entry; called under mu.
func (c *turnCache) remove(element *list.Element) {
	ref := element.Value.(turnRef)
	c.order.Remove(element)
	delete(c.refs, ref.turnID)
	c.unindex(ref)
}

func (c *turnCache) index(ref turnRef) {
	if c.byLine[ref.lineID] == nil {
		c.byLine[ref.lineID] = map[string]bool{}
	}
	c.byLine[ref.lineID][ref.turnID] = true
}

func (c *turnCache) unindex(ref turnRef) {
	delete(c.byLine[ref.lineID], ref.turnID)
	if len(c.byLine[ref.lineID]) == 0 {
		delete(c.byLine, ref.lineID)
	}
}
