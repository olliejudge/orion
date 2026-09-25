package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// runMainEnv makes the test binary act as orion itself (see TestMain), so a
// test can run the real CLI as a child process and send it real signals.
const runMainEnv = "ORION_TEST_RUN_MAIN"

// TestMain runs orion itself under runMainEnv; otherwise it points tokenPath
// at a temp dir, keeping every in-process test's token out of the user's
// real config dir. (Child processes get a temp HOME instead.)
func TestMain(m *testing.M) {
	if os.Getenv(runMainEnv) == "1" {
		main() // os.Args[1:] are orion's arguments
	}
	dir, err := os.MkdirTemp("", "orion-token-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	tokenPath = func() (string, error) { return filepath.Join(dir, "token"), nil }
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func TestURLIsStableAcrossRuns(t *testing.T) {
	r, _ := testRepo(t)
	first := startRun(t, r.Path(), "--no-open", "--port", "0")
	first.stop(t, 10*time.Second)
	second := startRun(t, r.Path(), "--no-open", "--port", "0")
	tok := func(u string) string { _, v, _ := strings.Cut(u, "?t="); return v }
	if tok(first.url) != tok(second.url) {
		t.Fatalf("token changed between runs: %s then %s", first.url, second.url)
	}
}

func TestUnavailableTokenFileFallsBackToOneOffURL(t *testing.T) {
	orig := tokenPath
	tokenPath = func() (string, error) { return "", errors.New("no config dir") }
	t.Cleanup(func() { tokenPath = orig })
	r, _ := testRepo(t)
	rn := startRun(t, r.Path(), "--no-open", "--port", "0")
	if !strings.Contains(rn.errOut.String(), "one-off URL") {
		t.Fatalf("stderr = %q, want a one-off URL warning", rn.errOut.String())
	}
}
