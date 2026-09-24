package repo

import (
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testDebounce    = 20 * time.Millisecond
	testMinInterval = 50 * time.Millisecond
	// testSlack absorbs the scheduling delay between a fire starting inside the
	// Scheduler and the recorder taking its timestamp (larger under -race on a
	// loaded CI runner). It only loosens lower bounds on gaps between fires.
	testSlack = 10 * time.Millisecond
)

type fireRec struct {
	key string
	r   Reason
	at  time.Time
}

type recorder struct {
	mu    sync.Mutex
	fires []fireRec
}

func (rc *recorder) fire(key string, r Reason) {
	at := time.Now()
	rc.mu.Lock()
	rc.fires = append(rc.fires, fireRec{key, r, at})
	rc.mu.Unlock()
}

func (rc *recorder) snapshot() []fireRec {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return append([]fireRec(nil), rc.fires...)
}

// waitFor polls cond every 5ms until it is true or timeout passes.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("condition not met within %v", timeout)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// idle reports whether s has nothing pending and nothing running. Once it is
// true after the last Trigger, every fire has returned and no more will come.
func idle(s *Scheduler) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, k := range s.keys {
		if k.pending != 0 || k.running {
			return false
		}
	}
	return true
}

// settle waits until s is idle (however slow the machine is), then until no
// new fire has been recorded for d, which would expose a spurious extra fire.
func (rc *recorder) settle(t *testing.T, s *Scheduler, d time.Duration) []fireRec {
	t.Helper()
	waitFor(t, 5*time.Second, func() bool { return idle(s) })
	n, since := -1, time.Now()
	waitFor(t, 5*time.Second, func() bool {
		cur := len(rc.snapshot())
		if cur != n {
			n, since = cur, time.Now()
		}
		return time.Since(since) >= d
	})
	return rc.snapshot()
}

func TestSchedulerDebounceMergesReasons(t *testing.T) {
	rc := &recorder{}
	s := NewScheduler(testDebounce, testMinInterval, rc.fire)
	defer s.Close()
	start := time.Now()
	s.Trigger("a", ReasonFiles)
	time.Sleep(5 * time.Millisecond)
	s.Trigger("a", ReasonRef)
	last := time.Now()
	s.Trigger("a", ReasonFiles)
	after := time.Now()
	fires := rc.settle(t, s, 150*time.Millisecond)

	var union Reason
	for _, f := range fires {
		union |= f.r
	}
	if union != ReasonFiles|ReasonRef {
		t.Errorf("union of fired reasons = %b, want %b", union, ReasonFiles|ReasonRef)
	}
	if after.Sub(start) >= testDebounce {
		// The triggers overran the debounce, so an earlier one may have fired
		// alone. Only the weak bound holds: never more fires than triggers.
		if len(fires) == 0 || len(fires) > 3 {
			t.Fatalf("fires = %d, want 1..3 (triggers took %v)", len(fires), after.Sub(start))
		}
		t.Logf("triggers overran the debounce (%v); checked bounds only", after.Sub(start))
		return
	}
	// Every trigger arrived before the first could fire, so exactly one fire.
	if len(fires) != 1 {
		t.Fatalf("fires = %d, want 1: %+v", len(fires), fires)
	}
	if fires[0].at.Sub(last) < testDebounce {
		t.Errorf("fired %v after last trigger, want ≥ %v", fires[0].at.Sub(last), testDebounce)
	}
}

func TestSchedulerMinInterval(t *testing.T) {
	rc := &recorder{}
	s := NewScheduler(testDebounce, testMinInterval, rc.fire)
	defer s.Close()
	s.Trigger("a", ReasonFiles)
	waitFor(t, 2*time.Second, func() bool { return len(rc.snapshot()) == 1 })
	s.Trigger("a", ReasonRefs)
	fires := rc.settle(t, s, 150*time.Millisecond)
	if len(fires) != 2 {
		t.Fatalf("fires = %d, want 2", len(fires))
	}
	if gap := fires[1].at.Sub(fires[0].at); gap < testMinInterval-testSlack {
		t.Errorf("gap between fires = %v, want ≥ %v", gap, testMinInterval-testSlack)
	}
	if fires[1].r != ReasonRefs {
		t.Errorf("second reason = %b, want %b", fires[1].r, ReasonRefs)
	}
}

func TestSchedulerBurst(t *testing.T) {
	rc := &recorder{}
	s := NewScheduler(testDebounce, testMinInterval, rc.fire)
	defer s.Close()
	all := ReasonFiles | ReasonRef | ReasonRefs | ReasonWorktrees | ReasonRescan
	const n = 1000
	var last time.Time
	start := time.Now()
	for i := 0; i < n; i++ {
		if i == n-1 {
			last = time.Now() // just before the final trigger: its fire must start later
		}
		s.Trigger("wt", Reason(1)<<(i%5))
	}
	dur := time.Since(start)
	fires := rc.settle(t, s, 200*time.Millisecond)

	limit := int(math.Ceil(float64(dur)/float64(testMinInterval))) + 2
	if len(fires) == 0 || len(fires) > limit {
		t.Fatalf("fires = %d for a %v burst, want 1..%d", len(fires), dur, limit)
	}
	final := fires[len(fires)-1]
	if !final.at.After(last) {
		t.Errorf("final fire at %v is not after the last trigger at %v", final.at, last)
	}
	var union Reason
	for _, f := range fires {
		union |= f.r
	}
	if union != all {
		t.Errorf("union of fired reasons = %b, want %b", union, all)
	}
	if len(fires) == 1 && final.r != all {
		t.Errorf("single fire reason = %b, want %b", final.r, all)
	}
}

func TestSchedulerSustainedChurn(t *testing.T) {
	rc := &recorder{}
	s := NewScheduler(testDebounce, testMinInterval, rc.fire)
	defer s.Close()
	churn := 300 * time.Millisecond
	var last time.Time
	start := time.Now()
	for {
		last = time.Now() // just before each trigger: the final one's fire must start later
		s.Trigger("wt", ReasonFiles)
		if time.Since(start) >= churn {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	dur := time.Since(start)
	fires := rc.settle(t, s, 200*time.Millisecond)
	limit := int(math.Ceil(float64(dur)/float64(testMinInterval))) + 2
	if len(fires) < 2 || len(fires) > limit {
		t.Fatalf("fires = %d during %v of churn, want 2..%d (progress during churn, but rate-limited)", len(fires), dur, limit)
	}
	if !fires[0].at.Before(last) {
		t.Errorf("no fire during sustained churn; first fire at +%v", fires[0].at.Sub(start))
	}
	if !fires[len(fires)-1].at.After(last) {
		t.Errorf("no trailing fire after churn ended")
	}
	for i := 1; i < len(fires); i++ {
		if gap := fires[i].at.Sub(fires[i-1].at); gap < testMinInterval-testSlack {
			t.Errorf("fires %d and %d only %v apart, want ≥ %v", i-1, i, gap, testMinInterval-testSlack)
		}
	}
}

func TestSchedulerNeverConcurrentPerKey(t *testing.T) {
	var running, maxRunning, calls atomic.Int32
	var mu sync.Mutex
	var reasons []Reason
	s := NewScheduler(testDebounce, testMinInterval, func(key string, r Reason) {
		n := running.Add(1)
		for {
			m := maxRunning.Load()
			if n <= m || maxRunning.CompareAndSwap(m, n) {
				break
			}
		}
		mu.Lock()
		reasons = append(reasons, r)
		mu.Unlock()
		calls.Add(1)
		time.Sleep(100 * time.Millisecond)
		running.Add(-1)
	})
	defer s.Close()
	s.Trigger("a", ReasonFiles)
	waitFor(t, 2*time.Second, func() bool { return calls.Load() == 1 })
	s.Trigger("a", ReasonRef) // arrives while the first fire is still running
	waitFor(t, 5*time.Second, func() bool { return calls.Load() == 2 && running.Load() == 0 })
	if maxRunning.Load() != 1 {
		t.Fatalf("max concurrent fires for one key = %d, want 1", maxRunning.Load())
	}
	mu.Lock()
	defer mu.Unlock()
	if reasons[1] != ReasonRef {
		t.Errorf("second fire reason = %b, want %b", reasons[1], ReasonRef)
	}
}

func TestSchedulerKeysIndependent(t *testing.T) {
	release := make(chan struct{})
	aStarted := make(chan struct{})
	bFired := make(chan struct{})
	s := NewScheduler(testDebounce, testMinInterval, func(key string, r Reason) {
		switch key {
		case "a":
			close(aStarted)
			<-release
		case "b":
			close(bFired)
		}
	})
	defer s.Close()
	defer close(release)
	s.Trigger("a", ReasonFiles)
	select {
	case <-aStarted: // "a" is now blocked inside fire
	case <-time.After(5 * time.Second):
		t.Fatal(`key "a" never fired`)
	}
	s.Trigger("b", ReasonFiles)
	select {
	case <-bFired:
	case <-time.After(5 * time.Second):
		t.Fatal(`key "b" did not fire while key "a" was busy`)
	}
}

func TestSchedulerClose(t *testing.T) {
	var calls atomic.Int32
	var finished atomic.Bool
	started := make(chan struct{})
	release := make(chan struct{})
	s := NewScheduler(testDebounce, testMinInterval, func(key string, r Reason) {
		if calls.Add(1) == 1 {
			close(started)
			<-release
			finished.Store(true)
		}
	})
	s.Trigger("a", ReasonFiles)
	<-started
	s.Trigger("a", ReasonFiles) // pending when Close is called: must never fire

	closed := make(chan struct{})
	go func() {
		s.Close()
		close(closed)
	}()
	waitFor(t, 5*time.Second, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.closed
	})
	select {
	case <-closed:
		t.Fatal("Close returned while a fire was still in flight")
	default:
	}
	close(release)
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not return after the in-flight fire finished")
	}
	if !finished.Load() {
		t.Errorf("Close returned before the in-flight fire finished")
	}

	s.Trigger("b", ReasonFiles)
	time.Sleep(150 * time.Millisecond) // give any (incorrect) timer time to fire
	if n := calls.Load(); n != 1 {
		t.Fatalf("calls = %d after Close, want 1", n)
	}
}
