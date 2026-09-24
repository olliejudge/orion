// Package model holds orion's pure state: the base tree, per-worktree
// overlays and the activity stream. It has no I/O. Store.Apply diffs a new
// State against the previous one and returns the wire Patch.
package model

import (
	"crypto/sha256"
	"encoding/hex"
)

// WorktreeID is the hex of the first 8 bytes of sha256(absolute path).
type WorktreeID string

// IDFor returns the stable id of the worktree at absPath.
func IDFor(absPath string) WorktreeID {
	sum := sha256.Sum256([]byte(absPath))
	return WorktreeID(hex.EncodeToString(sum[:8]))
}

// Kind is how an overlay entry differs from base.
type Kind string

const (
	Added    Kind = "added"
	Modified Kind = "modified"
	Deleted  Kind = "deleted"
	Renamed  Kind = "renamed"
)

// Stage is where a change lives: in the working tree or committed on the
// worktree's branch but not yet in base.
type Stage string

const (
	Uncommitted Stage = "uncommitted"
	Committed   Stage = "committed"
)

// ChangeEntry is one path in a worktree's overlay.
type ChangeEntry struct {
	Path  string `json:"path"`
	Kind  Kind   `json:"kind"`
	From  string `json:"from,omitempty"`
	Stage Stage  `json:"stage"`
	Size  int64  `json:"size"`
}

// File is one base-tree file.
type File struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// Worktree is one git worktree as sent to clients.
type Worktree struct {
	ID          WorktreeID `json:"id"`
	Path        string     `json:"path"`
	Label       string     `json:"label"` // branch, else short sha, else "main"
	Branch      string     `json:"branch,omitempty"`
	Head        string     `json:"head"`
	IsMain      bool       `json:"isMain"`
	Locked      bool       `json:"locked"`
	ColorIndex  int        `json:"colorIndex"` // assigned by Store; -1 = not yet active
	HeadSubject string     `json:"-"`          // filled by repo; used for commit activity
}

// RepoInfo names the repo and its base branch.
type RepoInfo struct {
	Name    string `json:"name"`
	Base    string `json:"base"`
	BaseSha string `json:"baseSha"`
}

// State is a full, immutable-by-convention view; repo builds a new one per recompute.
type State struct {
	Repo      RepoInfo
	Worktrees []Worktree                            // sorted: main first, then by Path
	Tree      map[string]int64                      // base tree path → size
	Overlays  map[WorktreeID]map[string]ChangeEntry // absent/empty map = no changes
}

// Activity is one row of the activity stream.
type Activity struct {
	TS       int64      `json:"ts"` // unix ms
	Worktree WorktreeID `json:"worktree"`
	Kind     string     `json:"kind"` // added|modified|deleted|renamed|commit|merge
	Path     string     `json:"path,omitempty"`
	From     string     `json:"from,omitempty"`
	Sha      string     `json:"sha,omitempty"`
	Subject  string     `json:"subject,omitempty"`
	Files    int        `json:"files,omitempty"`
}

// BasePatch updates the base tree.
type BasePatch struct {
	Sha    string   `json:"sha"`
	Upsert []File   `json:"upsert"`
	Remove []string `json:"remove"`
}

// OverlayPatch updates one worktree's overlay.
type OverlayPatch struct {
	Upsert []ChangeEntry `json:"upsert"`
	Remove []string      `json:"remove"`
}

// Snapshot is the full state sent to a newly connected client.
type Snapshot struct {
	Type      string                       `json:"type"` // "snapshot"
	Seq       uint64                       `json:"seq"`
	Repo      RepoInfo                     `json:"repo"`
	Worktrees []Worktree                   `json:"worktrees"`
	Tree      []File                       `json:"tree"`     // sorted by path
	Overlays  map[WorktreeID][]ChangeEntry `json:"overlays"` // sorted by path
	Activity  []Activity                   `json:"activity"` // oldest→newest, ≤200
}

// Patch is an incremental update; absent fields mean "unchanged".
type Patch struct {
	Type      string                      `json:"type"` // "patch"
	Seq       uint64                      `json:"seq"`
	Worktrees []Worktree                  `json:"worktrees,omitempty"`
	Base      *BasePatch                  `json:"base,omitempty"`
	Overlays  map[WorktreeID]OverlayPatch `json:"overlays,omitempty"`
	Activity  []Activity                  `json:"activity,omitempty"`
}
