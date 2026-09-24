package repo

import (
	"sync"
	"time"
)

// Reason is a bit set describing why a key needs recomputing.
type Reason uint8

const (
	ReasonFiles     Reason = 1 << iota // working-tree files changed
	ReasonRef                          // this worktree's HEAD/index changed
	ReasonRefs                         // refs/** or packed-refs changed
	ReasonWorktrees                    // the worktree set changed
	ReasonRescan                       // watcher overflow: recompute everything
)

// Scheduler coalesces triggers per key. A key fires `debounce` after its last
// trigger, but no later than maxWait after its first pending trigger (so
// sustained churn still produces progress), and never sooner than
// `minInterval` after its previous fire started. Fires for one key never
// overlap; triggers that arrive during a fire are OR-ed and fire afterwards.
type Scheduler struct {
	debounce, minInterval, maxWait time.Duration
	fire                           func(key string, r Reason)

	mu     sync.Mutex
	keys   map[string]*keyState
	closed bool
	wg     sync.WaitGroup
}

type keyState struct {
	pending     Reason
	first, last time.Time // first and latest trigger since pending became non-zero
	lastFire    time.Time
	running     bool
	gen         uint64 // bumps on every arm; stale timer callbacks compare and bail
	timer       *time.Timer
}

// NewScheduler returns a Scheduler that calls fire on its own goroutine.
func NewScheduler(debounce, minInterval time.Duration, fire func(key string, r Reason)) *Scheduler {
	maxWait := 2 * debounce
	if maxWait < minInterval {
		maxWait = minInterval
	}
	return &Scheduler{
		debounce: debounce, minInterval: minInterval, maxWait: maxWait,
		fire: fire, keys: map[string]*keyState{},
	}
}

// Trigger records reason r for key. It never blocks on a running fire.
func (s *Scheduler) Trigger(key string, r Reason) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	k := s.keys[key]
	if k == nil {
		k = &keyState{}
		s.keys[key] = k
	}
	now := time.Now()
	if k.pending == 0 {
		k.first = now
	}
	k.pending |= r
	k.last = now
	if !k.running {
		s.arm(key, k, now)
	}
}

// arm (re)starts k's timer. s.mu must be held.
func (s *Scheduler) arm(key string, k *keyState, now time.Time) {
	due := k.last.Add(s.debounce)
	if limit := k.first.Add(s.maxWait); limit.Before(due) {
		due = limit
	}
	if earliest := k.lastFire.Add(s.minInterval); earliest.After(due) {
		due = earliest
	}
	if k.timer != nil {
		k.timer.Stop()
	}
	k.gen++
	gen := k.gen
	k.timer = time.AfterFunc(max(due.Sub(now), 0), func() { s.run(key, k, gen) })
}

func (s *Scheduler) run(key string, k *keyState, gen uint64) {
	s.mu.Lock()
	if s.closed || gen != k.gen || k.running || k.pending == 0 {
		s.mu.Unlock()
		return
	}
	r := k.pending
	k.pending = 0
	k.running = true
	k.lastFire = time.Now()
	k.timer = nil
	s.wg.Add(1)
	s.mu.Unlock()

	defer s.wg.Done()
	s.fire(key, r)

	s.mu.Lock()
	defer s.mu.Unlock()
	k.running = false
	if k.pending != 0 && !s.closed {
		s.arm(key, k, time.Now())
	}
}

// Close cancels pending fires and waits for in-flight fires to return.
// Trigger after Close is a no-op.
func (s *Scheduler) Close() {
	s.mu.Lock()
	s.closed = true
	for _, k := range s.keys {
		if k.timer != nil {
			k.timer.Stop()
		}
	}
	s.mu.Unlock()
	s.wg.Wait()
}
