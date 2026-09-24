package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/olliejudge/orion/internal/version"
)

func TestRunVersion(t *testing.T) {
	for _, arg := range []string{"--version", "-version"} {
		var stdout, stderr bytes.Buffer
		code := run([]string{arg}, &stdout, &stderr)
		if code != 0 {
			t.Fatalf("run(%q) exit code = %d, want 0 (stderr: %q)", arg, code, stderr.String())
		}
		want := "orion " + version.Version + "\n"
		if stdout.String() != want {
			t.Fatalf("run(%q) stdout = %q, want %q", arg, stdout.String(), want)
		}
	}
}

func TestRunUnknownFlag(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--nope"}, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "nope") {
		t.Fatalf("stderr %q does not mention the bad flag", stderr.String())
	}
}
