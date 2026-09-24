<script lang="ts">
  import type { WorktreeId } from "../protocol";
  import type { RepoState } from "../store";
  import { legendModel, type LegendItem } from "./models";

  interface Props {
    repo: RepoState;
    now: number;
    isolated: WorktreeId | null;
    onIsolate: (id: WorktreeId | null) => void;
  }
  let { repo, now, isolated, onIsolate }: Props = $props();

  let showIdle = $state(false);
  const model = $derived(legendModel(repo, now));

  function toggle(id: WorktreeId): void {
    onIsolate(isolated === id ? null : id);
  }
</script>

{#snippet pill(w: LegendItem)}
  <li>
    <button
      class="pill"
      data-testid="worktree-pill"
      class:on={isolated === w.id}
      class:dim={isolated !== null && isolated !== w.id}
      aria-pressed={isolated === w.id}
      title={`${w.label}: ${w.path}`}
      onclick={() => toggle(w.id)}
    >
      <span class="dot" style:background={w.color}></span>
      <span class="label">{w.label}</span>
      {#if w.changed > 0}<span class="count" aria-label={`${w.changed} changed files`}>{w.changed}</span>{/if}
    </button>
  </li>
{/snippet}

<section class="legend glass" data-testid="legend" aria-label="Worktrees">
  <h1>{repo.repo.name}</h1>
  <p class="base">Compared with {repo.repo.base || "HEAD"}</p>
  <div class="night-reveal">
    <ul>
      {#each model.active as w (w.id)}{@render pill(w)}{/each}
    </ul>
    {#if model.idle.length > 0}
      <button class="more" aria-expanded={showIdle} onclick={() => (showIdle = !showIdle)}>
        {showIdle ? "Hide idle" : `+${model.idle.length} idle`}
      </button>
      {#if showIdle}
        <ul class="idle">
          {#each model.idle as w (w.id)}{@render pill(w)}{/each}
        </ul>
      {/if}
    {/if}
  </div>
</section>

<style>
  .legend {
    position: fixed;
    top: var(--gutter);
    left: var(--gutter);
    max-width: min(320px, calc(100vw - 2 * var(--gutter)));
    padding: 10px 12px 12px;
    z-index: 2;
  }
  h1 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .base {
    margin: 1px 0 8px;
    color: var(--text-faint);
    font-size: 11px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .idle {
    margin-top: 6px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 3px 9px 3px 7px;
    border-radius: 999px;
    border: 1px solid var(--pill-border);
    background: var(--pill-bg);
    font-size: 11.5px;
    cursor: pointer;
    transition:
      background 0.15s ease,
      opacity 0.15s ease;
  }
  .pill:hover {
    background: var(--pill-bg-hover);
  }
  .pill.on {
    background: var(--pill-bg-on);
    border-color: rgba(255, 255, 255, 0.22);
  }
  .pill.dim {
    opacity: 0.45;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .more {
    margin-top: 6px;
    padding: 2px 4px;
    border: 0;
    background: none;
    color: var(--text-dim);
    font-size: 11px;
    cursor: pointer;
  }
  .more:hover {
    color: var(--text);
  }
</style>
