<script lang="ts">
  import type { WorktreeId } from "../protocol";
  import type { RepoState } from "../store";
  import { legendModel, type Footprint, type LegendItem } from "./models";

  interface Props {
    repo: RepoState;
    now: number;
    isolated: WorktreeId | null;
    onIsolate: (id: WorktreeId | null) => void;
    /** Reports the panel's size whenever it changes (the map keeps clear of it). */
    onFootprint?: (size: Footprint) => void;
  }
  let { repo, now, isolated, onIsolate, onFootprint }: Props = $props();

  let panel: HTMLElement;
  $effect(() => {
    const report = onFootprint;
    if (!report || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => report({ width: panel.offsetWidth, height: panel.offsetHeight }));
    ro.observe(panel);
    return () => ro.disconnect();
  });

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

<section class="legend glass" data-testid="legend" aria-label="Worktrees" bind:this={panel}>
  <h1>{repo.repo.name}</h1>
  <p class="base">Compared with {repo.repo.base || "HEAD"}</p>
  <div class="night-reveal scroll" data-testid="legend-list">
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
  /* Bounded both ways: long branch names ellipsize, and a long idle list
     scrolls inside the panel instead of running off-screen over the map. */
  .legend {
    position: fixed;
    top: var(--gutter);
    left: var(--gutter);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    max-width: min(var(--legend-max-w), calc(100vw - 2 * var(--gutter)));
    max-height: calc(100vh - var(--gutter) - 64px);
    padding: 10px 12px 12px;
    z-index: 2;
  }
  /* Narrow: stop above the activity sheet (Activity.svelte: bottom 64px, ≤ 32vh). */
  @media (max-width: 720px) {
    .legend {
      max-height: calc(68vh - 64px - 2 * var(--gutter));
    }
  }
  .scroll {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    /* Room for the focus ring, which overflow would otherwise clip. */
    margin: 0 -4px;
    padding: 0 4px 2px;
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
  li {
    min-width: 0;
    max-width: 100%;
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
    box-sizing: border-box;
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
    flex: none;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  /* Night: an active isolation stays visible at rest, so the dimmed map explains itself. */
  :global(:root[data-theme="night"]) .night-reveal:has(.pill.on) {
    opacity: 1;
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
