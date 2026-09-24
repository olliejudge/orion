package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// person is a synthetic commit author. Every identity in the demo is invented.
type person struct {
	Name  string
	Email string
}

var human = person{Name: "Ada Vega", Email: "ada@nebula.invalid"}

func agentPerson(name string) person {
	return person{Name: name, Email: name + "@nebula.invalid"}
}

// isolatedEnv keeps the user's global/system git config (signing, hooks,
// templates, aliases) out of the demo so it behaves the same everywhere.
var isolatedEnv = []string{
	"GIT_CONFIG_GLOBAL=" + os.DevNull,
	"GIT_CONFIG_NOSYSTEM=1",
	"GIT_TERMINAL_PROMPT=0",
	"LC_ALL=C",
}

// git runs `git args...` in dir and returns stdout. The error carries the
// arguments and stderr. It deliberately does not take a context: a git
// process killed mid-write can leave index.lock behind.
func git(dir string, env []string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(append(os.Environ(), isolatedEnv...), env...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s (in %s): %w: %s", strings.Join(args, " "), dir, err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// identityEnv sets author and committer to p at time when.
func identityEnv(p person, when time.Time) []string {
	date := when.Format("2006-01-02T15:04:05-0700")
	return []string{
		"GIT_AUTHOR_NAME=" + p.Name, "GIT_AUTHOR_EMAIL=" + p.Email, "GIT_AUTHOR_DATE=" + date,
		"GIT_COMMITTER_NAME=" + p.Name, "GIT_COMMITTER_EMAIL=" + p.Email, "GIT_COMMITTER_DATE=" + date,
	}
}

// commitAll stages everything in the worktree at dir and commits it.
// It returns false (and no error) when there was nothing to commit.
func commitAll(dir string, p person, when time.Time, msg string) (bool, error) {
	if _, err := git(dir, nil, "add", "-A"); err != nil {
		return false, err
	}
	out, err := git(dir, nil, "status", "--porcelain", "-z")
	if err != nil {
		return false, err
	}
	if out == "" {
		return false, nil
	}
	if _, err := git(dir, identityEnv(p, when), "commit", "-q", "-m", msg); err != nil {
		return false, err
	}
	return true, nil
}
