// Mirrors the Go `internal/model` wire types exactly (spec §5).
// Field names and optionality must match the JSON tags in internal/model/types.go.

export type WorktreeId = string;
export type Kind = "added" | "modified" | "deleted" | "renamed";
export type Stage = "uncommitted" | "committed";

export interface ChangeEntry {
  path: string;
  kind: Kind;
  from?: string;
  stage: Stage;
  size: number;
}

export interface FileEntry {
  path: string;
  size: number;
}

export interface Worktree {
  id: WorktreeId;
  path: string;
  label: string;
  branch?: string;
  head: string;
  isMain: boolean;
  locked: boolean;
  colorIndex: number;
}

export interface RepoInfo {
  name: string;
  base: string;
  baseSha: string;
}

export interface Activity {
  ts: number;
  worktree: WorktreeId;
  kind: Kind | "commit" | "merge";
  path?: string;
  from?: string;
  sha?: string;
  subject?: string;
  files?: number;
}

export interface Snapshot {
  type: "snapshot";
  seq: number;
  repo: RepoInfo;
  worktrees: Worktree[];
  tree: FileEntry[];
  overlays: Record<WorktreeId, ChangeEntry[]>;
  activity: Activity[];
}

export interface Patch {
  type: "patch";
  seq: number;
  worktrees?: Worktree[];
  base?: { sha: string; upsert: FileEntry[]; remove: string[] };
  overlays?: Record<WorktreeId, { upsert: ChangeEntry[]; remove: string[] }>;
  activity?: Activity[];
}

export type ServerMessage = Snapshot | Patch;

/** The only client → server message (spec §5). */
export interface ResyncRequest {
  type: "resync";
}
