package model

// paletteSize is the number of worktree colours (Global Constraints palette).
const paletteSize = 10

// colorAssigner hands out palette indices: 0 is reserved for the main
// worktree; others get an index 1..9 when they first become active and keep
// it for the session. A new worktree gets the lowest never-used index; once
// none is left, the lowest index whose owners are all absent from the
// current worktree list; only when every index is held by a present
// worktree are indices reused round-robin.
type colorAssigner struct {
	byID map[WorktreeID]int
	used [paletteSize]bool // ever handed out
	rr   int               // round-robin cursor over 1..9 once the palette is exhausted
}

func newColorAssigner() *colorAssigner {
	return &colorAssigner{byID: map[WorktreeID]int{}}
}

// get returns id's colour, or -1 when it has none yet.
func (c *colorAssigner) get(id WorktreeID) int {
	if i, ok := c.byID[id]; ok {
		return i
	}
	return -1
}

func (c *colorAssigner) setMain(id WorktreeID) {
	c.byID[id] = 0
	c.used[0] = true
}

// assign gives id a colour if it has none. present holds the ids in the
// current worktree list.
func (c *colorAssigner) assign(id WorktreeID, present map[WorktreeID]bool) {
	if _, ok := c.byID[id]; ok {
		return
	}
	c.byID[id] = c.pick(present)
}

func (c *colorAssigner) pick(present map[WorktreeID]bool) int {
	for i := 1; i < paletteSize; i++ {
		if !c.used[i] {
			c.used[i] = true
			return i
		}
	}
	var held [paletteSize]bool
	for id, i := range c.byID {
		if present[id] {
			held[i] = true
		}
	}
	for i := 1; i < paletteSize; i++ {
		if !held[i] {
			return i
		}
	}
	i := 1 + c.rr
	c.rr = (c.rr + 1) % (paletteSize - 1)
	return i
}
