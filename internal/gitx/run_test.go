package gitx

import (
	"context"
	"strings"
	"testing"
)

func TestParseVersion(t *testing.T) {
	tests := []struct {
		in           string
		want         string
		major, minor int
		wantErr      bool
	}{
		{in: "git version 2.39.5 (Apple Git-154)\n", want: "2.39.5", major: 2, minor: 39},
		{in: "git version 2.30.0\n", want: "2.30.0", major: 2, minor: 30},
		{in: "git version 2.45.1.windows.1\n", want: "2.45.1", major: 2, minor: 45},
		{in: "git version 3.0\n", want: "3.0", major: 3, minor: 0},
		{in: "not git\n", wantErr: true},
	}
	for _, tt := range tests {
		got, major, minor, err := parseVersion(tt.in)
		if tt.wantErr {
			if err == nil {
				t.Errorf("parseVersion(%q) = %q, want error", tt.in, got)
			}
			continue
		}
		if err != nil || got != tt.want || major != tt.major || minor != tt.minor {
			t.Errorf("parseVersion(%q) = %q %d.%d %v, want %q %d.%d", tt.in, got, major, minor, err, tt.want, tt.major, tt.minor)
		}
	}
}

func TestCheckVersionAcceptsInstalledGit(t *testing.T) {
	v, err := CheckVersion(context.Background(), Runner{})
	if err != nil {
		t.Fatalf("CheckVersion: %v", err)
	}
	if !strings.HasPrefix(v, "2.") && !strings.HasPrefix(v, "3.") {
		t.Fatalf("version %q looks wrong", v)
	}
}

func TestCheckVersionRejectsOldGit(t *testing.T) {
	if err := requireMinimum("2.29.3", 2, 29); err == nil {
		t.Fatal("2.29 accepted, want error")
	}
	if err := requireMinimum("1.9.0", 1, 9); err == nil {
		t.Fatal("1.9 accepted, want error")
	}
	if err := requireMinimum("2.30.0", 2, 30); err != nil {
		t.Fatalf("2.30 rejected: %v", err)
	}
}

func TestRunErrorIncludesArgsAndStderr(t *testing.T) {
	_, err := Runner{}.Run(context.Background(), t.TempDir(), "rev-parse", "--verify", "no-such-ref")
	if err == nil {
		t.Fatal("want error outside a repo")
	}
	msg := err.Error()
	if !strings.Contains(msg, "rev-parse --verify no-such-ref") || !strings.Contains(msg, "not a git repository") {
		t.Fatalf("error %q should name the args and include stderr", msg)
	}
}

func TestRunnerUsesCustomBinary(t *testing.T) {
	_, err := Runner{Git: "/nonexistent/git"}.Run(context.Background(), t.TempDir(), "version")
	if err == nil {
		t.Fatal("want error for missing binary")
	}
}
