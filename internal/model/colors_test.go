package model

import (
	"fmt"
	"maps"
	"slices"
	"testing"
)

func agent(n int) Worktree {
	p := fmt.Sprintf("/wt/agent-%02d", n)
	return Worktree{ID: IDFor(p), Path: p, Label: p, Branch: p, Head: "h1"}
}

func colourOf(s *Store, id WorktreeID) int {
	for _, w := range s.Snapshot().Worktrees {
		if w.ID == id {
			return w.ColorIndex
		}
	}
	return -2
}

func TestColoursInOrderOfFirstActivity(t *testing.T) {
	a, b, c := agent(1), agent(2), agent(3)
	all := []Worktree{mainWT, a, b, c}
	s := NewStore(st("b1", nil, all, nil), t0)
	if colourOf(s, mainID) != 0 || colourOf(s, a.ID) != -1 {
		t.Fatalf("initial colours: main %d, a %d", colourOf(s, mainID), colourOf(s, a.ID))
	}

	// b becomes active before a, so b gets 1.
	s.Apply(st("b1", nil, all, overlays{b.ID: entries(unc("x", Added, 1))}), at(1))
	s.Apply(st("b1", nil, all, overlays{b.ID: entries(unc("x", Added, 1)), a.ID: entries(unc("y", Added, 1))}), at(2))
	if colourOf(s, b.ID) != 1 || colourOf(s, a.ID) != 2 {
		t.Fatalf("b=%d a=%d, want 1 and 2", colourOf(s, b.ID), colourOf(s, a.ID))
	}

	// b goes idle and then is removed. Never-used indices are handed out before freed ones, so c gets 3.
	s.Apply(st("b1", nil, []Worktree{mainWT, a, c}, overlays{a.ID: entries(unc("y", Added, 1))}), at(3))
	s.Apply(st("b1", nil, []Worktree{mainWT, a, c}, overlays{a.ID: entries(unc("y", Added, 1)), c.ID: entries(unc("z", Added, 1))}), at(4))
	if colourOf(s, c.ID) != 3 {
		t.Fatalf("c = %d, want 3 (never-used indices come first)", colourOf(s, c.ID))
	}

	// b comes back: same colour as before.
	s.Apply(st("b1", nil, all, nil), at(5))
	if colourOf(s, b.ID) != 1 {
		t.Fatalf("returning b = %d, want 1", colourOf(s, b.ID))
	}
	if colourOf(s, a.ID) != 2 {
		t.Fatalf("idle a lost its colour: %d", colourOf(s, a.ID))
	}
}

func TestColoursRoundRobinWhenExhausted(t *testing.T) {
	wts := []Worktree{mainWT}
	for i := 1; i <= 11; i++ {
		wts = append(wts, agent(i))
	}
	s := NewStore(st("b1", nil, wts, nil), t0)
	ov := overlays{}
	for i := 1; i <= 11; i++ {
		ov[agent(i).ID] = entries(unc("f", Added, 1))
		next := overlays{}
		for k, v := range ov {
			next[k] = v
		}
		s.Apply(st("b1", nil, wts, next), at(float64(i)))
	}
	for i := 1; i <= 9; i++ {
		if got := colourOf(s, agent(i).ID); got != i {
			t.Fatalf("agent %d colour = %d, want %d", i, got, i)
		}
	}
	if got := colourOf(s, agent(10).ID); got != 1 {
		t.Fatalf("agent 10 colour = %d, want 1 (round-robin)", got)
	}
	if got := colourOf(s, agent(11).ID); got != 2 {
		t.Fatalf("agent 11 colour = %d, want 2 (round-robin)", got)
	}
	if colourOf(s, mainID) != 0 {
		t.Fatal("main lost colour 0")
	}
}

func TestStartupOverlayAssignsColour(t *testing.T) {
	a, idle := agent(1), agent(2)
	s := NewStore(st("b1", nil, []Worktree{mainWT, idle, a}, overlays{a.ID: entries(com("c", Added, 1))}), t0)
	if colourOf(s, a.ID) != 1 {
		t.Fatalf("agent with committed work at startup = %d, want 1", colourOf(s, a.ID))
	}
	if colourOf(s, idle.ID) != -1 {
		t.Fatalf("idle agent = %d, want -1", colourOf(s, idle.ID))
	}
}

func TestColoursReusedAfterRemoval(t *testing.T) {
	wts := []Worktree{mainWT}
	for i := 1; i <= 9; i++ {
		wts = append(wts, agent(i))
	}
	s := NewStore(st("b1", nil, wts, nil), t0)
	ov := overlays{}
	for i := 1; i <= 9; i++ {
		ov[agent(i).ID] = entries(unc("f", Added, 1))
		s.Apply(st("b1", nil, wts, maps.Clone(ov)), at(float64(i)))
	}

	// Agent 5 is removed and agent 3 goes idle but stays present. Only an
	// index whose owners are all absent may be reused, so agent 10 gets 5.
	delete(ov, agent(5).ID)
	delete(ov, agent(3).ID)
	present := slices.DeleteFunc(slices.Clone(wts), func(w Worktree) bool { return w.ID == agent(5).ID })
	present = append(present, agent(10))
	ov[agent(10).ID] = entries(unc("f", Added, 1))
	s.Apply(st("b1", nil, present, maps.Clone(ov)), at(10))
	if got := colourOf(s, agent(10).ID); got != 5 {
		t.Fatalf("agent 10 colour = %d, want 5 (freed by the removed agent 5)", got)
	}
	if got := colourOf(s, agent(3).ID); got != 3 {
		t.Fatalf("idle agent 3 colour = %d, want 3", got)
	}

	// With every index now held by a present worktree, agent 11 falls back to round-robin.
	present = append(present, agent(11))
	ov[agent(11).ID] = entries(unc("f", Added, 1))
	s.Apply(st("b1", nil, present, maps.Clone(ov)), at(11))
	if got := colourOf(s, agent(11).ID); got != 1 {
		t.Fatalf("agent 11 colour = %d, want 1 (round-robin)", got)
	}
}
