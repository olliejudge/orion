<script lang="ts">
  import { worktreeColor } from "../colors";
  import type { RepoState } from "../store";
  import { relativeTime, splitPath } from "./format";
  import { activityRows, rowFade, type ActivityRow } from "./models";

  interface Props {
    repo: RepoState;
    now: number;
    onHover: (path: string | null) => void;
    onSelect: (path: string) => void;
  }
  let { repo, now, onHover, onSelect }: Props = $props();

  const rows = $derived(activityRows(repo.activity));
  const VERB: Record<string, string> = { added: "new", modified: "edited", deleted: "deleted", renamed: "moved" };

  function color(row: ActivityRow): string {
    return worktreeColor(repo.worktrees.get(row.worktree)?.colorIndex ?? -1);
  }
  function who(row: ActivityRow): string {
    return repo.worktrees.get(row.worktree)?.label ?? "removed worktree";
  }
  function files(n: number | undefined): string {
    return n === undefined ? "" : ` ${n} ${n === 1 ? "file" : "files"}`;
  }
</script>

<section class="activity glass" data-testid="activity" aria-label="Activity">
  <h2>Activity</h2>
  {#if rows.length === 0}
    <p class="empty">Edits, commits and merges from every worktree appear here as they happen.</p>
  {/if}
  <ol>
    {#each rows as row (row.key)}
      <li class="row" class:emphasis={row.emphasis} style:--fade={rowFade(row.ts, now)} style:--wt={color(row)}>
        {#if row.path !== undefined}
          {@const p = splitPath(row.path)}
          <button
            class="hit"
            title={`${who(row)}: ${row.from ? `${row.from} → ` : ""}${row.path}`}
            onmouseenter={() => onHover(row.path ?? null)}
            onmouseleave={() => onHover(null)}
            onfocus={() => onHover(row.path ?? null)}
            onblur={() => onHover(null)}
            onclick={() => onSelect(row.path!)}
          >
            <span class="dot"></span>
            <span class="path"><span class="dir">{p.dir}</span><span class="name">{p.name}</span></span>
            <span class="kind">{VERB[row.kind] ?? row.kind}{row.count > 1 ? ` ×${row.count}` : ""}</span>
            <time datetime={new Date(row.ts).toISOString()}>{relativeTime(row.ts, now)}</time>
          </button>
        {:else}
          <div class="hit" title={who(row)}>
            <span class="dot"></span>
            <span class="path">
              <span class="name">{row.kind === "commit" ? `Committed${files(row.files)}` : `Merged${files(row.files)} into ${repo.repo.base || "base"}`}</span>
              {#if row.subject}<span class="subject">{row.subject}</span>{/if}
            </span>
            <time datetime={new Date(row.ts).toISOString()}>{relativeTime(row.ts, now)}</time>
          </div>
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  .activity {
    position: fixed;
    top: var(--gutter);
    right: var(--gutter);
    bottom: 64px;
    width: 288px;
    display: flex;
    flex-direction: column;
    padding: 10px 6px 6px;
    z-index: 2;
  }
  h2 {
    margin: 0 6px 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim);
  }
  .empty {
    margin: 4px 6px;
    color: var(--text-faint);
    font-size: 11.5px;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .hit {
    box-sizing: border-box;
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 4px 6px;
    border: 0;
    border-radius: var(--radius-row);
    background: none;
    text-align: left;
    white-space: nowrap;
  }
  button.hit {
    cursor: pointer;
  }
  button.hit:hover {
    background: var(--pill-bg-hover);
  }
  .emphasis .hit {
    background: color-mix(in srgb, var(--wt) 14%, transparent);
    margin: 2px 0;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--wt);
    flex: none;
    align-self: center;
  }
  .path {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    column-gap: 0;
    overflow: hidden;
  }
  .dir {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-faint);
    flex: 0 1 auto;
  }
  .name {
    flex: none;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .emphasis .name {
    font-weight: 600;
  }
  .subject {
    flex-basis: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-dim);
    font-size: 11.5px;
  }
  .kind,
  time {
    flex: none;
    color: var(--text-faint);
    font-size: 11px;
  }
  time {
    min-width: 24px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  /* Night: no panel, stream sits bottom-right and fades with age. */
  :global(:root[data-theme="night"]) .activity {
    top: auto;
    bottom: 56px;
    max-height: 40vh;
  }
  :global(:root[data-theme="night"]) h2 {
    display: none;
  }
  :global(:root[data-theme="night"]) .row {
    opacity: var(--fade);
    /* No panel behind the text in Night: keep it legible over bubbles. */
    text-shadow:
      0 0 2px #000,
      0 0 8px #000;
  }
  :global(:root[data-theme="night"]) .emphasis .hit {
    background: none;
  }

  @media (max-width: 720px) {
    .activity {
      top: auto;
      left: var(--gutter);
      width: auto;
      max-height: 32vh;
    }
  }
</style>
