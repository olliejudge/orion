// Package gitx is a thin, stateless wrapper over the git CLI. Every function
// execs the user's git and parses NUL-separated (-z) output where git offers it.
package gitx

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/olliejudge/orion/internal/procgroup"
)

// Runner execs git. The zero value runs "git" from PATH.
type Runner struct{ Git string }

func (r Runner) bin() string {
	if r.Git == "" {
		return "git"
	}
	return r.Git
}

// Run executes git with args in dir and returns stdout. The error names the
// command, the directory and git's stderr.
func (r Runner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmd := r.command(ctx, dir, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return stdout.Bytes(), fmt.Errorf("git %s (in %s): %w: %s",
			strings.Join(args, " "), dir, err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

// command builds the git command Run executes. It runs in its own process
// group, so a terminal Ctrl-C does not kill it before orion shuts down; ctx
// cancellation stops it instead.
func (r Runner) command(ctx context.Context, dir string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, r.bin(), args...)
	procgroup.Isolate(cmd)
	cmd.Dir = dir
	cmd.Env = append(cleanEnv(os.Environ()),
		// Never take optional locks (e.g. status refreshing the index): writes
		// under .git/ would wake our own watcher and loop forever.
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_TERMINAL_PROMPT=0",
		"LC_ALL=C",
	)
	return cmd
}

// repoEnv lists the variables that tie git to one repository (what
// `git rev-parse --local-env-vars` prints). Inherited from a hook or alias,
// they would point every `git -C <worktree>` call at the wrong repo.
var repoEnv = map[string]bool{
	"GIT_ALTERNATE_OBJECT_DIRECTORIES": true,
	"GIT_CONFIG":                       true,
	"GIT_CONFIG_PARAMETERS":            true,
	"GIT_CONFIG_COUNT":                 true,
	"GIT_OBJECT_DIRECTORY":             true,
	"GIT_DIR":                          true,
	"GIT_WORK_TREE":                    true,
	"GIT_IMPLICIT_WORK_TREE":           true,
	"GIT_GRAFT_FILE":                   true,
	"GIT_INDEX_FILE":                   true,
	"GIT_NO_REPLACE_OBJECTS":           true,
	"GIT_REPLACE_REF_BASE":             true,
	"GIT_PREFIX":                       true,
	"GIT_SHALLOW_FILE":                 true,
	"GIT_COMMON_DIR":                   true,
}

// cleanEnv returns env without the repo-locating variables in repoEnv.
func cleanEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if k, _, _ := strings.Cut(kv, "="); !repoEnv[k] {
			out = append(out, kv)
		}
	}
	return out
}

var versionRE = regexp.MustCompile(`^git version (\d+)\.(\d+)(\.\d+)?`)

func parseVersion(out string) (version string, major, minor int, err error) {
	m := versionRE.FindStringSubmatch(strings.TrimSpace(out))
	if m == nil {
		return "", 0, 0, fmt.Errorf("unrecognised git version output %q", strings.TrimSpace(out))
	}
	major, _ = strconv.Atoi(m[1])
	minor, _ = strconv.Atoi(m[2])
	return m[1] + "." + m[2] + m[3], major, minor, nil
}

func requireMinimum(version string, major, minor int) error {
	if major < 2 || (major == 2 && minor < 30) {
		return fmt.Errorf("git %s is too old: orion needs git 2.30 or newer", version)
	}
	return nil
}

// CheckVersion returns the installed git version ("2.39.5"), or an error if
// git is missing or older than 2.30.
func CheckVersion(ctx context.Context, r Runner) (string, error) {
	out, err := r.Run(ctx, "", "version")
	if err != nil {
		return "", fmt.Errorf("git not found or not runnable: %w", err)
	}
	v, major, minor, err := parseVersion(string(out))
	if err != nil {
		return "", err
	}
	if err := requireMinimum(v, major, minor); err != nil {
		return "", err
	}
	return v, nil
}
