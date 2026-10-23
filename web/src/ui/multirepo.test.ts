import { describe, expect, it } from "vitest";
import { makeState, wt } from "../layout/fixtures";
import type { RepoInfo, Worktree } from "../protocol";
import type { RepoState } from "../store";
import { baseLine, baseOf, legendGroups, legendModel, worktreeName } from "./models";

const NOW = 10_000_000;

function inRepo(w: Worktree, repo: string): Worktree {
  return { ...w, repo, id: `${repo}:${w.id}`, path: `/${repo}/${w.id}` };
}

function multi(repos: RepoInfo[], worktrees: Worktree[]): RepoState {
  return { ...makeState({}, {}, worktrees), repo: { name: "acme", base: "", baseSha: "" }, repos };
}

const API: RepoInfo = { key: "acme-api", name: "acme-api", base: "main", baseSha: "a" };
const WEB: RepoInfo = { key: "acme-web", name: "acme-web", base: "main", baseSha: "b" };

describe("multi-repo chrome", () => {
  it("names a worktree by repo only when several repos are served", () => {
    expect(worktreeName(wt("w1", 1, "feat/a"))).toBe("feat/a");
    expect(worktreeName(inRepo(wt("w1", 1, "feat/a"), "acme-web"))).toBe("acme-web ▸ feat/a");
  });

  it("compares each worktree with its own repo's base", () => {
    const s = multi([API, { ...WEB, base: "origin/develop" }], []);
    expect(baseOf(s, { repo: "acme-web" })).toBe("origin/develop");
    expect(baseOf(makeState({}), { repo: undefined })).toBe("origin/main");
  });

  it("names one base when the repos agree, and each repo's otherwise", () => {
    expect(baseLine(makeState({}))).toBe("origin/main");
    expect(baseLine(multi([API, WEB], []))).toBe("main");
    expect(baseLine(multi([API, { ...WEB, base: "develop" }], []))).toBe("acme-api: main, acme-web: develop");
  });

  it("groups the legend by repo, in repo order, each repo's main first", () => {
    const s = multi(
      [API, WEB],
      [inRepo(wt("w9", 3, "zeta"), "acme-web"), inRepo(wt("m", 0, "main"), "acme-web"), inRepo(wt("m", 0, "main"), "acme-api"), inRepo(wt("w1", 1, "feat/a"), "acme-api")],
    );
    const { idle } = legendModel(s, NOW);
    const groups = legendGroups(idle);
    expect(groups.map((g) => g.repo)).toEqual(["acme-api", "acme-web"]);
    expect(groups.map((g) => g.items.map((i) => i.label))).toEqual([
      ["main", "feat/a"],
      ["main", "zeta"],
    ]);
  });

  it("keeps one unnamed group for a single repo", () => {
    const { idle } = legendModel(makeState({}), NOW);
    expect(legendGroups(idle).map((g) => g.repo)).toEqual([""]);
  });
});
