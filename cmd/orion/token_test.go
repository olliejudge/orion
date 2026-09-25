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

// useTempTokenDir points tokenPath at a fresh temp dir, keeping every
// in-process test's token out of the user's real config dir. TestMain calls
// it; the returned func removes the dir.
func useTempTokenDir() func() {
	dir, err := os.MkdirTemp("", "orion-token-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	tokenPath = func() (string, error) { return filepath.Join(dir, "token"), nil }
	return func() { _ = os.RemoveAll(dir) }
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
